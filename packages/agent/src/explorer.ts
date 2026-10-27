/**
 * Explorer (§3.1) — turns a Flow Map into a plain-English test plan a human
 * approves before any code is written.
 *
 * The crawl is deterministic (crawler.ts). This file is the judgement half:
 * given what exists, what is worth testing, at what priority, and why.
 */

import { testPlanSchema } from '@qaai/shared';
import { BOUNDARY_DESCRIPTORS } from '@qaai/shared';
import type {
  BoundaryClass,
  BoundaryRisk,
  FlowMap,
  PrincipalKind,
  Priority,
  TestPlan,
  TestType,
} from '@qaai/shared';
import type { AuthProfileChoice } from './coverage.js';
import type { CallContext, LlmService } from './llm.js';
/*
 * ── THE SIX SCENARIO MODULES, IMPORTED SO THEY ARE CALLED ──────────────────
 *
 * Every one of these was flagged `package-exports` by `check:wiring` when it
 * landed: built, tested, and reachable from nothing but its own test file. The
 * barrel line in index.ts makes them PUBLIC; these imports and the adapters at
 * the bottom of this file make them REACHED. Only the second one removes the
 * defect — a module on a barrel and called by nobody is the same dead code with
 * a nicer address.
 *
 * `multiActorPlanItem` is imported as a VALUE because this file calls it rather
 * than re-rendering the scenario: the module already decided how a two-actor
 * scenario becomes a plan item, including the reasoning for its own null
 * `authProfileId`, and a second rendering would be a second thing to keep in
 * step.
 */
import { WALK_SHAPE_DESCRIPTORS } from './walks.js';
import type { WalkSelection } from './walks.js';
import type { FaultScenarioSet, RaceScenario, RaceScenarioSet } from './fault-scenarios.js';
import type {
  AuthLifecycleCleanup,
  AuthLifecycleEnumeration,
  AuthLifecycleStep,
} from './auth-lifecycle.js';
import { multiActorPlanItem } from './multi-actor.js';
import type { MultiActorEnumeration } from './multi-actor.js';
import type { AuthzPlan } from './authz-probe.js';
import type { TargetedPlanItem } from './generator.js';
/*
 * LIFTED, NOT RE-IMPLEMENTED. `similarity`, `extractBehavior` and
 * `normalizeRoute` are suite-health.ts's, and that file owns the facet weights,
 * the Jaccard and the route normalisation. A second notion of "the same test" is
 * how one of them starts disagreeing with the other, and the one that would
 * disagree is this one: newer and less tested. See the header of the
 * suppression section below.
 */
import { extractBehavior, normalizeRoute, similarity } from './suite-health.js';
import type { SuiteHealthTestInput, TestBehavior } from './suite-health.js';

const SYSTEM = `You are the Explorer agent inside QAAI, an AI QA engineer.

You are given a Flow Map: a graph of the pages, states, forms, and journeys a
crawler discovered in a web application. Your job is to propose a test plan that
a staff QA engineer would recognise as sensible, and that a product manager
could read without knowing any code.

How to think about it:

- Test what a user is trying to accomplish, not what a page contains. "Check out
  with two items in the cart" is a test. "Check the cart page renders" is not.
- Assert meaning, never pixels. A good assertion is "the order total equals
  subtotal plus shipping plus tax" — something that can be wrong while the page
  still looks perfectly fine. A bad one is "the heading says Cart".
- Arithmetic, state transitions, and permission boundaries are where real bugs
  live. Prefer them over presence checks.
- Cover the unhappy paths the crawler found: out-of-stock items, empty states,
  validation failures, pages behind an auth wall.
- A page marked BEHIND AUTH cannot be tested by a signed-out visitor. If an auth
  profile is offered below, name it on the item so the test runs as that role;
  the runner injects the session, so the test must NOT contain a login form.
  Where a page lists REQUIRES ROLES, pick the profile that matches it. If no
  profile fits, set authProfileId to null and say in the rationale that the item
  only proves the wall holds — never claim to cover the page itself.
- Priority means: CRITICAL_PATH is revenue or access — if it breaks, the
  business stops. IMPORTANT is a real feature users touch daily. NICE_TO_HAVE is
  everything else. Be honest; a plan where everything is critical is useless.
- Steps are imperative and concrete ("Add the Burr Grinder to the cart"), so the
  Generator can turn each one into a single action.

Choose the test type per item:
  E2E            multi-step user journeys through the UI
  SMOKE          one or two steps proving a critical path is alive
  API            when the check is about a response, not a screen
  ACCESSIBILITY  a page whose markup is worth an axe scan
  SECURITY_SMOKE auth walls and ids in URLs

Also report what you deliberately skipped and why. A plan that silently omits a
whole feature is worse than one that says "skipped payments — no test card".`;

/**
 * The roles on offer, rendered for the prompt.
 *
 * Names and ids only. A model choosing which role a test assumes has no need of
 * a credential, and a prompt is the last place to put one — `llm.ts` masks
 * secrets on the way out, and the way to keep that true is not to hand it any.
 */
function summariseAuthProfiles(profiles: AuthProfileChoice[]): string {
  if (profiles.length === 0) {
    return `AUTH PROFILES
  (none configured on this environment — every item's authProfileId must be null,
   and anything behind an auth wall can only be tested as a signed-out visitor)`;
  }
  return `AUTH PROFILES
${profiles
  .map((profile) => `  ${profile.id} — "${profile.name}"${profile.kind ? ` (${profile.kind})` : ''}`)
  .join('\n')}`;
}

function summariseFlowMap(flowMap: FlowMap): string {
  const nodes = flowMap.nodes
    .map((node) => {
      const forms = node.forms
        .map(
          (form) =>
            `      form "${form.name}": ${form.fields
              .map((f) => `${f.name}(${f.semantic}${f.required ? ', required' : ''})`)
              .join(', ')}`,
        )
        .join('\n');
      const actions = node.affordances
        .slice(0, 8)
        .map((a) => a.label)
        .join(', ');

      /*
       * `requiresRoles` is the application's own statement about who may see
       * this state — the best evidence there is for which profile an item
       * should name, and leaving it out of the prompt was half of why the
       * Explorer had nothing to go on and was told to answer null.
       *
       * Guarded because this FlowMap is typed on the way in but deserialised
       * from a Json column on the way here, and a crawl written before the
       * field existed has no array to filter.
       */
      const roles = Array.isArray(node.requiresRoles) ? node.requiresRoles.filter(Boolean) : [];

      return [
        `  ${node.route} — "${node.title}" [state: ${node.stateKey}]${
          node.behindAuth ? ' (BEHIND AUTH)' : ''
        }${roles.length > 0 ? ` (REQUIRES ROLES: ${roles.join(', ')})` : ''}`,
        actions ? `      buttons: ${actions}` : null,
        forms || null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const journeys = flowMap.journeys
    .map((j) => `  ${j.id}: ${j.name} — ${j.description} [${j.priority}]`)
    .join('\n');

  const features = flowMap.features
    .map((f) => `  ${f.name} (${f.nodeIds.length} states)`)
    .join('\n');

  return `Base URL: ${flowMap.baseUrl}
Crawled: ${flowMap.nodes.length} states, ${flowMap.edges.length} transitions
${flowMap.truncatedReason ? `NOTE: the crawl was truncated — ${flowMap.truncatedReason}\n` : ''}
FEATURES
${features || '  (none inferred)'}

STATES
${nodes || '  (none)'}

JOURNEYS
${journeys || '  (none derived)'}`;
}

export interface ExploreResult {
  plan: TestPlan;
}

export async function proposePlan(
  llm: LlmService,
  ctx: CallContext,
  flowMap: FlowMap,
  opts: {
    maxItems?: number;
    authProfiles?: AuthProfileChoice[];
    /**
     * WHAT THE SUITE ALREADY HAS, so the ranked plan stops being coverage-blind.
     *
     * THE DEFECT: this function passed `summariseFlowMap(flowMap)` and nothing
     * else. The model could not know a journey already had three tests, so it
     * proposed a fourth; a human approved it; the Generator spent a strong-tier
     * call on it; and admission's DUPLICATE gate refused it at the last possible
     * moment, after every cost had been paid. Omitting this is still allowed and
     * is still HONEST — {@link summariseExistingSuite} renders "(none …)" with
     * the reason — but a caller that has the suite and does not pass it is
     * paying for duplicates it could have avoided here.
     */
    existingTests?: readonly { name: string; type: TestType; feature: string | null }[];
    /**
     * THE MEASURED GAPS. The other half of the same defect: the plan
     * re-proposed work that existed and failed to propose work coverage
     * analysis had already PROVED was missing. A gap is the strongest signal
     * there is about what to test, because it is a measurement rather than a
     * guess, and it was absent from this prompt entirely.
     */
    gaps?: readonly {
      id: string;
      kind: string;
      route: string | null;
      feature: string | null;
      requiresAuth?: boolean;
      authProfileName?: string | null;
    }[];
    /**
     * The deterministic plan {@link proposeScenarioPlan} already produced.
     *
     * Passed so the model ENRICHES rather than duplicates: the scenario modules
     * have already proposed the races, walks, lifecycle journeys and cross-tenant
     * sweeps, and a model that cannot see them proposes them again in worse
     * English. This is the shape every model path in this round takes — the
     * deterministic half runs first and the model only adds what it did not
     * cover.
     */
    scenarioPlan?: ScenarioPlan | null;
  } = {},
): Promise<ExploreResult> {
  const maxItems = opts.maxItems ?? 12;
  const authProfiles = opts.authProfiles ?? [];
  const profileIds = new Set(authProfiles.map((profile) => profile.id));

  const prompt = `${summariseFlowMap(flowMap)}

${summariseAuthProfiles(authProfiles)}

${summariseExistingSuite(opts.existingTests ?? [])}

${summariseGapReport(opts.gaps ?? [])}
${opts.scenarioPlan ? `
${summariseScenarioPlan(opts.scenarioPlan)}
` : ''}
Propose at most ${maxItems} test items for this application.

Every item needs:
  title       one line a PM would understand
  rationale   one or two sentences on why this is worth testing
  feature     which feature group above it belongs to
  priority    CRITICAL_PATH | IMPORTANT | NICE_TO_HAVE
  testType    E2E | SMOKE | API | ACCESSIBILITY | SECURITY_SMOKE
  steps       ordered imperative steps
  assertions  what must be true at the end, in terms of meaning
  journeyId   the journey id this came from, or null
  authProfileId  the id of the auth profile this test must run as, copied
                 EXACTLY from the AUTH PROFILES list above, or null for a test
                 that runs as a signed-out visitor. Required for anything
                 BEHIND AUTH; invented ids are discarded.

Set "id" on each item to a short kebab-case slug derived from the title.
Give at least one item per feature group where a meaningful test exists.`;

  const plan = await llm.structured(ctx, {
    tier: 'cheap',
    effort: 'medium',
    system: SYSTEM,
    prompt,
    schema: testPlanSchema,
    schemaName: 'TestPlan',
    maxTokens: 16000,
    // The system prompt is identical across every project, so caching it pays
    // for itself the second time anyone runs the Explorer.
    cacheSystem: true,
  });

  /*
   * EVERY PROFILE ID THE MODEL RETURNED IS CHECKED AGAINST THE LIST WE GAVE IT.
   *
   * `PlanItem.authProfileId` has no foreign key (it is a loose column on the
   * PlanItem table), so a plausible-looking id the model invented would be
   * stored without complaint, travel to the Generator, and produce a test bound
   * to a profile that does not exist. Where that lands depends on the runner:
   * at best a hard failure a long way from here, at worst a test that quietly
   * runs anonymously and passes — which is the exact defect this whole change
   * exists to remove, re-introduced by the one producer that cannot be checked
   * by a database constraint.
   *
   * So an unrecognised id becomes null, and the plan says so in `skipped`
   * rather than dropping it silently: a plan whose items lost their roles with
   * no explanation reads as the Explorer's judgement.
   */
  const invented: string[] = [];
  const items = plan.items.map((item) => {
    if (item.authProfileId === null || profileIds.has(item.authProfileId)) return item;
    invented.push(`${item.title} → ${item.authProfileId}`);
    return { ...item, authProfileId: null };
  });

  return {
    plan: {
      ...plan,
      items,
      skipped: [
        ...plan.skipped,
        ...(invented.length > 0
          ? [
              {
                what: 'Auth profile bindings on ' + invented.length + ' item(s)',
                why:
                  'The Explorer named auth profile id(s) that do not exist on this environment (' +
                  invented.slice(0, 5).join('; ') +
                  '), so those items were left unbound and will run as a signed-out visitor. If any of them is behind an auth wall, bind a real profile before generating it.',
              },
            ]
          : []),
      ],
      flowMapVersion: flowMap.version,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DETERMINISTIC SCENARIO PRODUCER
//
// Everything above this line is the MODEL's half of the Explorer. Everything
// below it is the half that works with no model at all, and it is where the six
// scenario modules this round landed actually become plan items.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
//
// `walks.ts`, `fault-scenarios.ts`, `auth-lifecycle.ts`, `multi-actor.ts`,
// `authz-probe.ts` and `gap-closure.ts` each produce a correct, tested, ranked
// set of scenarios, and until this file called them NOTHING turned any of them
// into a `PlanItem`. They were reachable from their own test files and from the
// package barrel, and from no producer — which is this codebase's signature
// defect in its purest form: a function tested, typechecked, documented as
// serving an endpoint, and called only by its own test.
//
// It also closes the ranking half. The register's complaint was that the top of
// the plan is "whatever the enumerator happened to list first"; a walk, a race
// and a cross-tenant sweep were incomparable because nothing had ever put them
// in one list. {@link SCENARIO_KIND_RISK} is that comparison, argued per kind.
//
// ── ONE PREMISE OF THE BRIEF WAS ALREADY FALSE, AND IS NOT "FIXED" HERE ─────
//
// "`PlanItem.authProfileId` is written `null` by EVERY producer." It is not.
// `planItemForGap` in coverage.ts carries `gap.authProfile?.id` and has done
// since the authorization axis landed, and EVERY remaining `authProfileId: null`
// in the repository is deliberate, documented and correct:
//
//   · multi-actor.ts:1401   a scenario with two actors has no single identity;
//                           the actors are in `principals`, and naming one here
//                           would re-assert the single-session assumption the
//                           module exists to escape.
//   · auth-lifecycle.ts:1350 the account does not exist yet — the journey's own
//                           signup step is what creates it.
//   · explorer.ts:204       the invented-id guard above, which is a correction
//                           rather than a producer.
//   · analyze-source.ts     four sites, each one load-bearing: the guarded-
//                           endpoint item, the sign-in item, the public-route
//                           a11y scan and the anonymous-refusal sweep ALL assert
//                           something about a request made with NO session.
//                           Binding a profile to any of them makes the runner
//                           inject a session and the test fails against an
//                           application whose auth works perfectly.
//
// So the producer widening below EMITS the role where it knows one (the authz,
// multi-actor and lifecycle adapters all do) and is deliberately silent where
// a null is the correct answer. Changing those four would have been a
// regression dressed as a fix.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The nine scenario kinds a producer can now emit.
 *
 * A closed union with the compiler-enforced presence record the keystone's
 * vocabularies use, so a tenth kind cannot join without being given a risk
 * weight, a rationale and a test-type mapping.
 */
export const SCENARIO_KINDS = [
  'BOUNDARY',
  'FUZZ',
  'WALK',
  'FAULT_INJECTION',
  'RACE',
  'AUTH_LIFECYCLE',
  'MULTI_ACTOR',
  'AUTHZ_PROBE',
  'TENANCY',
] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

const SCENARIO_KIND_PRESENT: Record<ScenarioKind, true> = {
  BOUNDARY: true,
  FUZZ: true,
  WALK: true,
  FAULT_INJECTION: true,
  RACE: true,
  AUTH_LIFECYCLE: true,
  MULTI_ACTOR: true,
  AUTHZ_PROBE: true,
  TENANCY: true,
};
/** Derived from the presence record rather than hand-listed, so the two cannot drift. */
export const SCENARIO_KIND_LIST = Object.keys(SCENARIO_KIND_PRESENT) as ReadonlyArray<ScenarioKind>;

/**
 * HOW MUCH EACH KIND IS WORTH, AND WHY — the ranking the register asked for.
 *
 * `points` is a coarse tier, deliberately: fine-grained weights invite
 * arguing about a 3 versus a 4 and hide the only decision that matters, which
 * is the ORDER. Each kind's `why` is the argument for its tier, and a reviewer
 * who disagrees has one number and one sentence to dispute rather than a
 * scoring function to reverse-engineer.
 *
 * The producer's own rank (a `Walk.rank`, a scenario's priority) is added on
 * top as a SMALL bump — see {@link rankProposal} — so it can order kin against
 * each other and can never promote a kind past the tier above it.
 */
export const SCENARIO_KIND_RISK: Record<ScenarioKind, { points: number; why: string }> = {
  TENANCY: {
    points: 100,
    why: 'Sweeping every enumerated endpoint with one tenant’s session against another tenant’s ids is the bug class that ends a company, and it is the one no single-session suite can express at all.',
  },
  AUTHZ_PROBE: {
    points: 95,
    why: 'An IDOR asked AS A REAL USER can fail. The anonymous version every suite already has cannot: every application denies an anonymous request, so the check passes without testing anything.',
  },
  RACE: {
    points: 90,
    why: 'Two submits in flight is where money bugs live — double charges, double-spent credit, two orders from one cart. A submit button proposed as one click can never find them.',
  },
  AUTH_LIFECYCLE: {
    points: 80,
    why: 'Signup, logout, session expiry, password reset and lockout are the highest-risk flows an application has, and the crawl skip-list plus one shared account meant none of them had ever been driven.',
  },
  MULTI_ACTOR: {
    points: 70,
    why: 'Invite-and-accept and submit-and-approve are whole features whose defects are invisible to a single session, because one session cannot be both sides of the handoff.',
  },
  FAULT_INJECTION: {
    points: 60,
    why: 'What the page does when its own API fails is untested in almost every suite, and the common defect — a spinner that never resolves, a double-charge on retry — is invisible on the happy path.',
  },
  BOUNDARY: {
    points: 45,
    why: 'The negative half of testing. One feature used to become ONE negative case derived from the first required field; a form’s declared constraints make twenty more free and each one is a real rule the application claims to enforce.',
  },
  WALK: {
    points: 30,
    why: 'Re-entry, loops and browser BACK break state machines that a single first-discovery path walks cleanly. Lower than the rest because it re-visits surfaces the suite already reaches, so it deepens coverage rather than adding any.',
  },
  FUZZ: {
    points: 20,
    why: 'Structured fuzzing finds crashes a boundary case misses, but it asserts the weakest thing of anything here — usually only that the application did not 500 — so it earns the bottom tier.',
  },
};

/**
 * AN IDENTITY A SCENARIO NEEDS — AND A SHAPE WITH NO FIELD A SECRET COULD
 * OCCUPY.
 *
 * Deliberately NOT `@qaai/shared`'s `Principal`, and not auth-lifecycle's
 * `LifecyclePrincipal` either. Those are two genuinely different types — the
 * second carries a `lifecycle`, a `tenant` and a `createdByScenario`, and
 * `DisposableTarget` adds the unforgeable disposability proof — and both are
 * STRUCTURALLY assignable to this one, so every adapter passes its own type
 * uncast and the compiler checks the compatibility instead of a cast asserting
 * it.
 *
 * Four fields, and the omissions are the point: there is no `password`, no
 * `totpSecret`, no `otp`, no `cookie`, no `storageState` and no `token`, so
 * there is no shape of a proposal that can carry a credential into a title, an
 * approval screen or a model prompt. `name` is an identifier the run generated,
 * `authProfileId` is a row id, and neither is secret-bearing.
 */
export interface ScenarioPrincipal {
  /** The scenario's own name for the actor. Never a credential. */
  readonly name: string;
  readonly kind: PrincipalKind;
  /** The application role, when the producer knows one. */
  readonly role: string | null;
  /** The `AuthProfile` row whose session the runner injects, when one exists. */
  readonly authProfileId: string | null;
}

/**
 * One proposal, before it becomes a plan item.
 *
 * The uniform intake every adapter below produces. It is deliberately NOT a
 * `PlanItem`: a proposal carries the provenance (`kind`, `sourceId`, `why`) and
 * the principals that the `PlanItem` wire shape has nowhere to put, and
 * discarding them before the dedup and the ranking would be discarding exactly
 * the facts those two steps run on.
 */
export interface ScenarioProposal {
  readonly kind: ScenarioKind;
  /**
   * The producing module's own content-derived id.
   *
   * Content-derived and therefore STABLE: re-running the same crawl re-proposes
   * the same id, which is what lets {@link refuseAlreadyProposed} recognise its
   * own earlier output instead of minting a second copy of it. A positional id
   * would make every proposal new every round and inflate the numerator for
   * ever, which is the defect this whole step exists to stop.
   */
  readonly sourceId: string;
  readonly item: TargetedPlanItem;
  /**
   * Every identity this scenario needs, in the order it first acts.
   *
   * More than one here is the whole point of the round: it is what `RunContext.
   * sessions` carries and what `storageState` alone could not express. Empty
   * means the scenario runs as the default principal.
   */
  readonly principals: readonly ScenarioPrincipal[];
  /** The producer's own ranking signal, already normalised to 0..9. */
  readonly producerRank: number;
  /** One sentence for the reviewer, from the producing module. */
  readonly why: string;
  /**
   * The `CoverageGap.id` this proposal was minted to close, or null.
   *
   * ON THE PROPOSAL AND NOT ON THE ITEM, because `PlanItem` in
   * packages/shared/src/flow-map.ts has no such field — `planItemSchema` in
   * schemas.ts DOES carry `gapId`, so the interface and its own validator
   * disagree, which is pre-existing drift this file does not own and does not
   * paper over. The worker's generate processor already copies `item.gapId` from
   * the ROW onto the test, so the durable path is the column; this field is what
   * carries the fact from a producer to whoever writes that column.
   *
   * NULL stays NULL: a scenario enumerated from a crawl has no gap behind it,
   * and a back-filled id would invent a provenance that never existed.
   */
  readonly gapId: string | null;
  /**
   * Set when the producing module REFUSED this scenario — a destructive step
   * against a principal it could not prove disposable, an unsafe verb with no
   * declared rejection, a probe that would mutate another tenant's data.
   *
   * A refused proposal is carried rather than dropped, and {@link
   * proposeScenarioPlan} keeps it OUT of `items` and IN `refused`. Dropping it
   * would record a check that was not performed the same way as a surface that
   * does not exist, which is one of the lies this product cannot afford.
   */
  readonly refusal: string | null;
}

/** 0..9, so a producer's own ordering can never jump a risk tier. */
function normaliseProducerRank(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(9, Math.trunc(raw));
}

const PRIORITY_RANK: Record<Priority, number> = {
  CRITICAL_PATH: 9,
  IMPORTANT: 5,
  NICE_TO_HAVE: 1,
};

/**
 * The total score. Tier first, producer signal second, and the second cannot
 * overtake the first because it is bounded at 9 and the tiers are 15 apart at
 * their closest (WALK 30 / FUZZ 20).
 */
export function rankProposal(proposal: ScenarioProposal): number {
  return SCENARIO_KIND_RISK[proposal.kind].points * 10 + normaliseProducerRank(proposal.producerRank);
}

// ─── THE ADAPTERS ────────────────────────────────────────────────────────────
//
// One per producing module. Each one is the only place that module's shape is
// read, so a change to it is a compile error in exactly one function rather
// than a silently-wrong plan item.
//
// Every adapter obeys three rules, and the rules are why they are this boring:
//
//   1. NO CREDENTIAL, EVER. A principal carries a NAME and an auth-profile id.
//      No password, no TOTP secret, no OTP, no session cookie, no storageState
//      and no bypass token reaches a title, a step, an assertion or a
//      `rationale` — all four of which are rendered on an approval screen and
//      two of which are interpolated into a model prompt.
//   2. A REFUSAL IS CARRIED, NOT DROPPED. Where the module recorded a refusal,
//      the proposal is emitted with `refusal` set and never runs.
//   3. DETERMINISTIC. No clock and no randomness: ids come from the module's own
//      content-derived ids, and the output order is the module's own.

/**
 * A boundary class's declared risk, as a `Priority`, falling back honestly.
 *
 * THE DEFECT THIS CLOSES. `BOUNDARY_DESCRIPTORS` gives every one of the 27
 * classes a `risk`, decided once, next to the constraint that defines the class
 * and the sentence explaining why it is worth a test. `boundaryProposals` read
 * none of it and stamped `IMPORTANT` on all 27, so EMPTY and WHITESPACE_ONLY —
 * declared HIGH, and the two that actually catch a naive `!value` check — ranked
 * level with the weakest class in the set. A risk decided in one file and
 * discarded in the next is worse than no risk field: the plan screen shows a
 * priority that looks considered and is not.
 *
 * The fallback is the honest half. `klass` arrives as a plain `string` because
 * {@link ScenarioPlanInput} takes the expansion structurally rather than
 * depending on the shared union, so an unrecognised class is reachable — and
 * when it happens this returns the ADAPTER's declared default rather than
 * guessing a tier for a class nobody described. It does not silently pick the
 * middle.
 */
const BOUNDARY_RISK_PRIORITY: Record<BoundaryRisk, Priority> = {
  CRITICAL: 'CRITICAL_PATH',
  HIGH: 'CRITICAL_PATH',
  MEDIUM: 'IMPORTANT',
  LOW: 'NICE_TO_HAVE',
};

function boundaryPriority(klass: string, fallback: Priority): Priority {
  const descriptor = BOUNDARY_DESCRIPTORS[klass as BoundaryClass] as
    | (typeof BOUNDARY_DESCRIPTORS)[BoundaryClass]
    | undefined;
  if (descriptor === undefined) return fallback;
  return BOUNDARY_RISK_PRIORITY[descriptor.risk];
}

/**
 * WALK → proposal. The shapes a single first-discovery spanning path cannot
 * express: a route in two states, a loop, a re-entry, a browser BACK.
 */
export function walkProposals(selection: WalkSelection): ScenarioProposal[] {
  return selection.walks.map((walk) => {
    const steps = walk.steps.map((step) => step.label);
    const assertions = [
      ...walk.expectedStates
        .slice(0, 8)
        .map((state) => `At ${state.route} the state is ${state.cellKey ?? state.route}`),
      ...(walk.revisits.length > 0
        ? [
            `Re-entering ${walk.revisits
              .slice(0, 3)
              .map((r) => r.route)
              .join(', ')} leaves the application in the same state as the first visit — no duplicated row, no stale form, no doubled total`,
          ]
        : []),
    ];
    return {
      kind: 'WALK' as const,
      sourceId: walk.id,
      // `targetNodeId` is the node this walk is ABOUT, and the walk's TRAVERSE
      // steps name the edges. Both go onto the item, which is what makes
      // `relevantContext` pin the right pages instead of guessing from wording.
      item: {
        id: `walk:${walk.id}`,
        title: `${WALK_SHAPE_DESCRIPTORS[walk.shape].label}: ${walk.id}`,
        rationale: walk.why,
        feature: `Navigation — ${walk.shape}`,
        priority: 'IMPORTANT' as Priority,
        testType: 'E2E' as TestType,
        steps: steps.length > 0 ? steps : ['Open the target route'],
        assertions:
          assertions.length > 0
            ? assertions
            : ['The walk completes without an error state on any step'],
        journeyId: null,
        authProfileId: null,
        targets: {
          nodeIds: [walk.targetNodeId],
          edgeIds: walk.steps
            .filter((step) => step.kind === 'TRAVERSE' && step.target !== null)
            .map((step) => step.target as string),
        },
      },
      principals: [],
      producerRank: walk.rank,
      why: walk.why,
      gapId: null,
      refusal: null,
    };
  });
}

/**
 * FAULT_INJECTION → proposal. What the page does when its own API fails.
 *
 * `exercise` non-null means the enumerator already decided this request may not
 * be injected against, so it becomes a refusal rather than a scenario.
 */
export function faultProposals(set: FaultScenarioSet): ScenarioProposal[] {
  return set.scenarios.map((scenario) => ({
    kind: 'FAULT_INJECTION' as const,
    sourceId: scenario.id,
    item: {
      id: `fault:${scenario.id}`,
      title: `${scenario.route} survives ${scenario.state} from ${scenario.match.method} ${scenario.match.pathGlob}`,
      rationale: scenario.why,
      feature: `Resilience — ${scenario.state}`,
      priority: 'IMPORTANT' as Priority,
      testType: 'E2E' as TestType,
      steps: [
        `Open ${scenario.route}`,
        `Intercept ${scenario.match.method} ${scenario.match.pathGlob} and ${scenario.interception.verb.toLowerCase()} it to produce ${scenario.state}`,
        'Perform the action that triggers that request',
      ],
      assertions: scenario.assertions.map((a) => a.claim),
      journeyId: null,
      authProfileId: null,
      targets: {},
    },
    principals: [],
    producerRank: scenario.assertionStrength === 'STRONG' ? 5 : 1,
    why: scenario.why,
    gapId: null,
    refusal:
      scenario.exercise !== null
        ? `The enumerator marked this request un-exercisable, so the fault was not injected: ${JSON.stringify(scenario.exercise)}`
        : null,
  }));
}

/**
 * RACE → proposal. Two requests in flight, which is where the money bugs are.
 *
 * `set.refused` and `set.scenarios` are two separate lists in the module ON
 * PURPOSE — so a caller cannot iterate one array and run a refused scenario —
 * and that separation is preserved here by the `refusal` field rather than
 * flattened away.
 */
export function raceProposals(set: RaceScenarioSet): ScenarioProposal[] {
  const asProposal = (scenario: RaceScenario, refused: boolean): ScenarioProposal => ({
    kind: 'RACE' as const,
    sourceId: scenario.id,
    item: {
      id: `race:${scenario.id}`,
      title: `${scenario.kind} on ${scenario.match.method} ${scenario.match.pathGlob} holds ${scenario.invariant}`,
      rationale: scenario.why,
      feature: `Concurrency — ${scenario.kind}`,
      priority: 'CRITICAL_PATH' as Priority,
      testType: 'E2E' as TestType,
      steps: scenario.interleaving.steps.map(
        (step) =>
          `[${step.actor ?? 'harness'}] ${step.action}${step.detail ? ` — ${step.detail}` : ''}`,
      ),
      assertions: [
        ...scenario.assertions.map((a) => a.claim),
        ...(scenario.idempotencyKeyHeader === null
          ? [
              'This endpoint declares no idempotency key header, so no client — including the application’s own — can safely retry it. That is itself the finding.',
            ]
          : []),
      ],
      journeyId: null,
      authProfileId: null,
      targets: {},
    },
    // NAMES only. `RaceScenario.principals` is `string[]` for exactly this
    // reason, and this adapter does not invent a `Principal` object it would
    // have to guess a kind and a lifecycle for.
    principals: [],
    producerRank: 9,
    why: scenario.why,
    gapId: null,
    refusal: refused
      ? (scenario.refusal?.detail ??
        'The producing module refused this race and recorded no detail, which is itself worth a look.')
      : null,
  });
  return [
    ...set.scenarios.map((s) => asProposal(s, false)),
    ...set.refused.map((s) => asProposal(s, true)),
  ];
}

/**
 * AUTH_LIFECYCLE → proposal. The fourteen flows nothing had ever driven.
 *
 * `results` is a union of a journey and a recorded reason there is none, so this
 * adapter emits a proposal ONLY for the journey arm: an UNMEASURED flow is not a
 * scenario with a refusal, it is a flow that produced nothing, and
 * {@link proposeScenarioPlan} reports those as a count with its reason instead.
 */
export function lifecycleProposals(
  enumeration: AuthLifecycleEnumeration,
): { proposals: ScenarioProposal[]; unmeasured: number } {
  const proposals: ScenarioProposal[] = [];
  for (const result of enumeration.results) {
    /*
     * 'GENERATED' is the JOURNEY arm of the union. The other arms carry a
     * `detail` and a `remedy` instead and are counted in `unmeasured` below,
     * never emitted as a scenario with a refusal: a flow that could not be
     * planned at all is not the same fact as one that was planned and refused.
     */
    if (result.outcome !== 'GENERATED') continue;
    const journey = result.journey;
    proposals.push({
      kind: 'AUTH_LIFECYCLE',
      sourceId: journey.id,
      item: {
        id: `auth-lifecycle:${journey.id}`,
        title: journey.title,
        rationale: journey.rationale,
        feature: `Authentication — ${journey.flow}`,
        priority: journey.priority,
        testType: journey.testType,
        steps: [
          ...journey.steps.map(
            (step: AuthLifecycleStep) =>
              `[${step.as}/${step.session}] ${step.action}${
                step.outOfBand !== null
                  ? ` (needs the ${step.outOfBand.toLowerCase()} delivered to the run’s mail sink)`
                  : ''
              }`,
          ),
          /*
           * THE CLEANUP STEPS ARE PART OF THE PLAN, not an afterthought. A
           * journey that creates an account and declares no cleanup fills the
           * customer's database, and `satisfiedByFlow` is why these are steps
           * rather than a note: an obligation the flow itself discharges needs
           * no step, and one it does not needs an explicit one a human approves.
           */
          ...journey.cleanup
            .filter((c: AuthLifecycleCleanup) => !c.satisfiedByFlow)
            .map(
              (c: AuthLifecycleCleanup) =>
                `Clean up (${c.obligation}, owned by ${c.ownedBy}): ${c.action}`,
            ),
        ],
        assertions: [
          ...journey.assertions,
          ...(journey.inconclusiveIf !== null
            ? [
                `Record the result as INCONCLUSIVE rather than passing if: ${journey.inconclusiveIf}`,
              ]
            : []),
        ],
        journeyId: null,
        /*
         * NULL, and correct — see the header of this section. The account does
         * not exist until the journey's own signup step creates it, so there is
         * no profile to point at. The identity is in `principals`, where a
         * DISPOSABLE principal is exactly what it is.
         */
        authProfileId: null,
        targets: {},
      },
      principals: journey.principals,
      producerRank: PRIORITY_RANK[journey.priority],
      why: journey.rationale,
      gapId: null,
      refusal: null,
    });
  }
  return { proposals, unmeasured: enumeration.unmeasured };
}

/**
 * MULTI_ACTOR → proposal. Two sessions in one scenario.
 *
 * `multiActorPlanItem` already builds the `PlanItem`, so this adapter does NOT
 * rebuild it: a second rendering of the same scenario is a second thing to keep
 * in step, and that module's version carries the reasoning for its own
 * `authProfileId: null`.
 */
export function multiActorProposals(enumeration: MultiActorEnumeration): ScenarioProposal[] {
  return enumeration.scenarios.map((scenario) => {
    const built = multiActorPlanItem(scenario);
    const destructive = scenario.destructive;
    return {
      kind: 'MULTI_ACTOR' as const,
      sourceId: scenario.id,
      item: built.item,
      principals: built.principals,
      producerRank: PRIORITY_RANK[scenario.priority],
      why: scenario.evidence,
      gapId: null,
      refusal:
        destructive !== null && !destructive.permitted
          ? `The ${destructive.kind} step was refused: ${
              destructive.refusal?.detail ??
              'the scenario could not prove its target was disposable'
            }`
          : null,
    };
  });
}

/**
 * AUTHZ_PROBE and TENANCY → proposals.
 *
 * Two kinds from one plan, and the split is not cosmetic. An AUTHZ_PROBE is one
 * holder reading one other principal's object — a classic IDOR, scoped to the
 * ids the crawl actually observed. TENANCY is the SWEEP: every enumerated
 * endpoint, one tenant's session against another tenant's ids, which is the
 * check the register calls the bug class that ends a company. They rank one
 * tier apart and they fail for different reasons, so reporting them as one kind
 * would hide which of the two was never run.
 *
 * READ-ONLY BY CONSTRUCTION: `PlannedAuthzProbe.method` is `SafeProbeMethod`, so
 * there is no shape of this adapter that can emit a probe on an unsafe verb.
 * The module's own refusals are carried through as `refused` rather than
 * dropped.
 */
export function authzProposals(plan: AuthzPlan): {
  proposals: ScenarioProposal[];
  refusals: AuthzPlan['refusals'];
} {
  const control = plan.control;
  const controlNote =
    control === null
      ? 'NO CONTROL PROBE WAS PLANNED, so a denial here is indistinguishable from an endpoint that is simply broken: every verdict this test produces is INCONCLUSIVE until a holder-owned id exists to prove the endpoint serves anybody at all.'
      : `Control: ${control.method} ${control.path} as "${control.holder}" must SUCCEED first, so a denial below is a denial and not a dead endpoint.`;

  const proposals: ScenarioProposal[] = plan.probes.map((probe) => ({
    kind: 'AUTHZ_PROBE' as const,
    sourceId: `authz:${probe.method}:${probe.path}:${probe.holder}:${probe.owner}`,
    item: {
      id: `authz:${probe.method}:${probe.path}:${probe.holder}:${probe.owner}`,
      title: `"${probe.holder}" must not read "${probe.owner}"’s ${probe.endpointLabel}`,
      rationale: `An IDOR asked as a REAL signed-in principal. The anonymous version of this check passes against every application, because every application denies an anonymous request — which is why it has never found anything. ${controlNote}`,
      feature: 'Authorization — object ownership',
      priority: 'CRITICAL_PATH' as Priority,
      testType: 'SECURITY_SMOKE' as TestType,
      steps: [
        `As the "${probe.holder}" principal (the runner injects its session; do NOT write a login form)`,
        `Send ${probe.method} ${probe.path} — a SAFE verb, so nothing is written whatever the answer`,
      ],
      assertions: [
        `The response denies the request, or serves it scoped to "${probe.holder}"’s own data and none of "${probe.owner}"’s`,
        'A 200 carrying the other principal’s record is a LEAK and must fail this test',
        'If the control probe did not succeed, record the result as INCONCLUSIVE rather than as a pass',
      ],
      journeyId: null,
      /*
       * NULL, and NOT because the role is unknown — because it is not an auth
       * profile ID.
       *
       * `PlannedAuthzProbe.holder` is a principal NAME ("holder", "subject"),
       * which is deliberate in `authz-probe.ts`: the module is written so that
       * nothing in a plan can carry a credential, and a name cannot. An
       * `AuthProfile.id` is a different kind of fact and this module is not
       * given one, so writing the name into `authProfileId` would produce a
       * binding the runner cannot resolve and the FK does not have — which
       * fails as a plausible-looking id, exactly the failure `proposePlan`'s
       * invented-id guard above exists to stop.
       *
       * The identities are in `principals`, where a NAME is the right shape.
       * Resolving a name to a profile is the runner's `resolvePrincipals` job,
       * and it reports a failure as a NOT_RUN rather than running anonymously.
       *
       * An earlier draft of this comment claimed the role WAS emitted here,
       * directly above the line setting it to null. That is the
       * doc-contradicts-code defect this codebase names explicitly, and it is
       * recorded here rather than quietly deleted.
       */
      authProfileId: null,
      targets: {},
    },
    principals: [],
    producerRank: 9,
    why: `Observed id basis: ${probe.id.basis}.`,
    gapId: null,
    refusal: null,
  }));

  return { proposals, refusals: plan.refusals };
}

/**
 * The TENANCY sweep, as one proposal per (holder, subject) tenant pair.
 *
 * ONE ITEM PER PAIR AND NOT ONE PER ENDPOINT, deliberately: the sweep's value is
 * that it covers EVERY enumerated endpoint, and nine hundred plan items for one
 * question would bury the plan and make the approval screen unusable. The
 * endpoint list lives in the spec the runner's tenancy plugin executes; the plan
 * item is the human-approvable statement of the check.
 */
export function tenancyProposals(
  pairs: readonly { holder: string; subject: string; endpointCount: number }[],
): ScenarioProposal[] {
  return pairs.map((pair) => ({
    kind: 'TENANCY' as const,
    sourceId: `tenancy:${pair.holder}:${pair.subject}`,
    item: {
      id: `tenancy:${pair.holder}:${pair.subject}`,
      title: `No endpoint serves tenant "${pair.subject}"’s data to tenant "${pair.holder}"`,
      rationale: `Sweeps all ${pair.endpointCount} enumerated endpoint(s) with "${pair.holder}"’s session against "${pair.subject}"’s ids. This is the check a single-session suite cannot express at all, and the one whose failure is unrecoverable.`,
      feature: 'Authorization — tenant isolation',
      priority: 'CRITICAL_PATH' as Priority,
      testType: 'SECURITY_SMOKE' as TestType,
      steps: [
        `As the "${pair.holder}" principal (session injected by the runner)`,
        `For every enumerated endpoint, substitute an id belonging to "${pair.subject}"`,
        'Use SAFE verbs only — GET, HEAD, OPTIONS. A probe that would mutate the other tenant’s data is refused and recorded as refused, never attempted.',
      ],
      assertions: [
        `Every endpoint either denies the request or serves only "${pair.holder}"’s own rows`,
        'Any response containing the other tenant’s data fails this test and is reported as a cross-tenant leak',
        'Endpoints whose control probe did not confirm the endpoint is live are reported INCONCLUSIVE, not as passes',
      ],
      journeyId: null,
      authProfileId: null,
      targets: {},
    },
    principals: [],
    producerRank: 9,
    gapId: null,
    why: `Tenant pair (${pair.holder} → ${pair.subject}) over ${pair.endpointCount} endpoint(s).`,
    refusal: null,
  }));
}

/**
 * BOUNDARY and FUZZ → proposals, from the negative expansion coverage.ts
 * already produces.
 *
 * Takes the expansion's own cases rather than re-deriving them, so the
 * unread-constraint rule stays in `@qaai/shared`'s `boundaries.ts` where the
 * keystone put it. A case whose expectation is not a rejection becomes a FUZZ
 * proposal rather than a BOUNDARY one: it still runs and still asserts, but what
 * it asserts is "the application handled this without a 500", which is the
 * weakest claim anything here makes and is ranked accordingly.
 */
export function boundaryProposals(
  cases: readonly {
    id: string;
    field: string;
    klass: string;
    expectation: string;
    expected: string;
    formName: string;
  }[],
): ScenarioProposal[] {
  return cases.map((c) => {
    const assertsRejection = c.expectation === 'rejected';
    return {
      kind: (assertsRejection ? 'BOUNDARY' : 'FUZZ') as ScenarioKind,
      sourceId: c.id,
      item: {
        id: `boundary:${c.id}`,
        title: `"${c.formName}" — ${c.klass} on ${c.field}`,
        rationale: c.expected,
        feature: `Validation — ${c.formName}`,
        // The class's own declared risk, not a flat literal. IMPORTANT stays as
        // the fallback for a class this file does not recognise — see
        // `boundaryPriority`.
        priority: boundaryPriority(c.klass, 'IMPORTANT'),
        testType: 'E2E' as TestType,
        steps: [
          `Open the page carrying the "${c.formName}" form`,
          `Fill every other required field with a valid value`,
          `Set ${c.field} to the ${c.klass} value and submit`,
        ],
        assertions: [c.expected],
        journeyId: null,
        authProfileId: null,
        targets: {},
      },
      principals: [],
      producerRank: assertsRejection ? 4 : 1,
      why: c.expected,
      gapId: null,
      refusal: null,
    };
  });
}

// ─── REFUSING WORK THE SUITE ALREADY HAS ─────────────────────────────────────
//
// THE DEFECT: five producers mint `PlanItem`s and none of them consults the
// others or the existing PROPOSED/APPROVED rows. Approving a plan twice minted
// duplicates that raise the coverage NUMERATOR and cover nothing, which is the
// most direct way the number can lie.
//
// `similarity` and `extractBehavior` in suite-health.ts are LIFTED here rather
// than re-implemented. That file already owns the facet weights, the Jaccard,
// the route normalisation and the decision that two tests which walk the same
// pages and assert different things are two tests. A second notion of "the same
// test" is how one of them starts disagreeing with the other, and the one that
// disagrees would be this one — the newer, less-tested copy.
//
// ── TWO KINDS OF EVIDENCE, AND ONLY ONE OF THEM REFUSES ────────────────────
//
// PROSE vs PROSE is strong. An existing PROPOSED/APPROVED plan item and a new
// proposal are the same kind of artefact, written in the same vocabulary, so a
// high `similarity` means what it says. That refuses.
//
// PROSE vs CODE is weak, and pretending otherwise would be the worse lie. A real
// test's behaviour is extracted as locators and matchers; a proposal is English.
// The only facet that can genuinely match is `routes`, and "the suite has a test
// over this route" does NOT mean the suite has THIS test: a RACE scenario on
// /checkout is not made redundant by an E2E walk of /checkout, and refusing it
// would silently delete the only check that could ever find a double charge. So
// route-level evidence DOWNRANKS and is DISCLOSED, and it refuses in exactly one
// case — a WALK, whose entire value is reaching a route that was already
// reached.

/** Pairs at or above this, PROSE vs PROSE, are the same proposal. */
export const PROPOSAL_DUPLICATE_THRESHOLD = 0.85;

/** How a proposal came to be excluded or demoted. */
export const SUPPRESSION_REASONS = [
  /** An existing PROPOSED/APPROVED plan item has the same id. Exact. */
  'ALREADY_PROPOSED_SAME_ID',
  /** Prose-vs-prose similarity against an existing item of the same type. */
  'ALREADY_PROPOSED_NEAR_DUPLICATE',
  /** Two producers in THIS round proposed the same thing. */
  'DUPLICATE_ACROSS_PRODUCERS',
  /** A WALK whose routes the suite already covers with the same test type. */
  'SUITE_ALREADY_COVERS_ROUTES',
  /** The producing module refused it. Never run, always reported. */
  'REFUSED_BY_PRODUCER',
  /** The `maxItems` budget bit. */
  'BUDGET',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

const SUPPRESSION_REASON_PRESENT: Record<SuppressionReason, true> = {
  ALREADY_PROPOSED_SAME_ID: true,
  ALREADY_PROPOSED_NEAR_DUPLICATE: true,
  DUPLICATE_ACROSS_PRODUCERS: true,
  SUITE_ALREADY_COVERS_ROUTES: true,
  REFUSED_BY_PRODUCER: true,
  BUDGET: true,
};
export const SUPPRESSION_REASON_LIST = Object.keys(
  SUPPRESSION_REASON_PRESENT,
) as ReadonlyArray<SuppressionReason>;

export interface Suppression {
  readonly sourceId: string;
  readonly kind: ScenarioKind;
  readonly reason: SuppressionReason;
  /** Names what suppressed it, so a human can go and look at that thing. */
  readonly detail: string;
}

/**
 * An existing PROPOSED or APPROVED plan item, as this scan needs it.
 *
 * A narrow structural interface, not a Prisma row: the caller passes rows and
 * the compiler checks the shape, and this module stays testable with object
 * literals and no database. That is the rule the whole round runs on — 629
 * lines of crawler.ts had almost no tests for exactly the opposite reason.
 */
export interface PriorPlanItem {
  readonly id: string;
  readonly title: string;
  readonly testType: TestType;
  readonly steps: readonly string[];
  readonly assertions: readonly string[];
}

/**
 * A `PlanItem`'s prose as a `TestBehavior`, so `similarity` can compare two of
 * them with the facet weights it already owns.
 *
 * `routes` are the route-shaped tokens in the prose, normalised by
 * suite-health's OWN `normalizeRoute` so `/orders/42` and `/orders/:id` are one
 * route here exactly as they are there. `actions` are the imperative verbs, and
 * `assertions` are the assertion lines lower-cased and squeezed — enough for a
 * Jaccard, and deliberately not a parse: a plan item is English and treating it
 * as a program would be the pretence this comment exists to avoid.
 *
 * `incomplete: false` is honest here in a way it would not be for code: we HAVE
 * read all of a plan item, because a plan item is all prose and there is no
 * more of it to read.
 */
export function behaviorOfPlanItem(item: PriorPlanItem): TestBehavior {
  const prose = `${item.title} ${item.steps.join(' ')} ${item.assertions.join(' ')}`;
  /*
   * `nav:` PREFIXED, because that is the token vocabulary `extractBehavior`
   * emits (`routes.add(\`nav:${route}\`)`) and `similarity` compares facets by
   * exact token.
   *
   * Without the prefix the `routes` facet NEVER matches a real test — `/cart`
   * against `nav:/cart` is a Jaccard of zero — and the suite comparison reads
   * every proposal as novel while looking like it worked. It was invisible in
   * the prose-vs-prose direction, where both sides come from this function and
   * are wrong together, which is exactly how this kind of bug survives.
   */
  const routes = [
    ...new Set(
      (prose.match(/\/[A-Za-z0-9._\-:/{}]*/g) ?? [])
        .map((raw) => normalizeRoute(raw))
        .filter((route) => route.length > 1)
        .map((route) => `nav:${route}`),
    ),
  ].sort();
  const words = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3);
  return {
    testId: item.id,
    name: item.title,
    filePath: '',
    feature: null,
    priority: 'IMPORTANT',
    type: item.testType,
    routes,
    actions: [...new Set(item.steps.flatMap((step) => words(step)))].sort(),
    assertions: [...new Set(item.assertions.flatMap((line) => words(line)))].sort(),
    data: [],
    navigationSites: [],
    actionSites: [],
    assertionSites: [],
    dialect: null,
    incomplete: false,
    incompleteReason: null,
  };
}

/** The same projection for a fresh proposal, which is a plan item in all but name. */
function behaviorOfProposal(proposal: ScenarioProposal): TestBehavior {
  return behaviorOfPlanItem({
    id: proposal.item.id,
    title: proposal.item.title,
    testType: proposal.item.testType,
    steps: proposal.item.steps,
    assertions: proposal.item.assertions,
  });
}

/**
 * The whole suppression pass: producer refusals, exact ids, prose-vs-prose
 * near-duplicates, cross-producer duplicates, and route coverage for WALKs.
 *
 * ORDER MATTERS AND IS THE CHEAPEST-FIRST ORDER. An exact id match costs a set
 * lookup; a similarity scan costs a Jaccard per pair. Running the cheap tests
 * first means the expensive one only ever sees proposals nothing else has
 * already answered.
 *
 * DETERMINISTIC: proposals are processed in the order given (which
 * {@link proposeScenarioPlan} has already sorted totally), so which member of a
 * duplicate pair survives is a property of the ranking and not of iteration
 * luck.
 */
export function suppressKnownWork(input: {
  readonly proposals: readonly ScenarioProposal[];
  /** Existing PROPOSED/APPROVED rows. Prose-vs-prose: strong evidence, refuses. */
  readonly priorItems?: readonly PriorPlanItem[];
  /** Real tests. Prose-vs-code: weak evidence, refuses WALKs only. */
  readonly existingTests?: readonly SuiteHealthTestInput[];
}): { kept: ScenarioProposal[]; suppressed: Suppression[] } {
  const kept: ScenarioProposal[] = [];
  const suppressed: Suppression[] = [];

  const priorIds = new Set((input.priorItems ?? []).map((item) => item.id));
  const priorBehaviors = (input.priorItems ?? []).map((item) => behaviorOfPlanItem(item));

  /*
   * Routes the suite already reaches, PER TEST TYPE. Per type because an API
   * test over /orders and an E2E walk of /orders are two different tests of it,
   * which is the same rule `duplicateCandidates` in the worker's generate
   * processor applies and the same rule for the same reason.
   */
  const suiteRoutesByType = new Map<TestType, Set<string>>();
  for (const test of input.existingTests ?? []) {
    const behavior = extractBehavior(test);
    // A test we could not read completely is NOT evidence that anything is
    // covered: a subset of a test's behaviour can only make two tests look MORE
    // alike. `findDuplicates` refuses a partial reading for the same reason.
    if (behavior.incomplete) continue;
    const set = suiteRoutesByType.get(test.type) ?? new Set<string>();
    for (const route of behavior.routes) set.add(route);
    suiteRoutesByType.set(test.type, set);
  }

  const keptBehaviors: TestBehavior[] = [];

  for (const proposal of input.proposals) {
    if (proposal.refusal !== null) {
      suppressed.push({
        sourceId: proposal.sourceId,
        kind: proposal.kind,
        reason: 'REFUSED_BY_PRODUCER',
        detail: proposal.refusal,
      });
      continue;
    }

    if (priorIds.has(proposal.item.id)) {
      suppressed.push({
        sourceId: proposal.sourceId,
        kind: proposal.kind,
        reason: 'ALREADY_PROPOSED_SAME_ID',
        detail: `A PROPOSED or APPROVED plan item already has the id "${proposal.item.id}". Re-minting it would be the same work counted twice.`,
      });
      continue;
    }

    const behavior = behaviorOfProposal(proposal);

    const priorHit = priorBehaviors.find(
      (prior) =>
        prior.type === behavior.type &&
        similarity(prior, behavior).score >= PROPOSAL_DUPLICATE_THRESHOLD,
    );
    if (priorHit) {
      suppressed.push({
        sourceId: proposal.sourceId,
        kind: proposal.kind,
        reason: 'ALREADY_PROPOSED_NEAR_DUPLICATE',
        detail: `Plan item "${priorHit.testId}" (${priorHit.name}) already proposes this, at or above ${PROPOSAL_DUPLICATE_THRESHOLD} similarity on the same test type.`,
      });
      continue;
    }

    const siblingHit = keptBehaviors.find(
      (sibling) =>
        sibling.type === behavior.type &&
        similarity(sibling, behavior).score >= PROPOSAL_DUPLICATE_THRESHOLD,
    );
    if (siblingHit) {
      suppressed.push({
        sourceId: proposal.sourceId,
        kind: proposal.kind,
        reason: 'DUPLICATE_ACROSS_PRODUCERS',
        detail: `Another producer in this same round already proposed "${siblingHit.name}". The higher-ranked one was kept.`,
      });
      continue;
    }

    /*
     * THE ONE PLACE PROSE-vs-CODE REFUSES, and it refuses WALKs only.
     *
     * A walk's whole claim is that it reaches a route in a state or an order
     * something else did not. When every route it names is already reached by a
     * test of the same type, the marginal claim is the ORDER alone, which is the
     * weakest thing in this module and not worth a plan item a human has to read.
     * Every other kind asks a question no amount of route coverage answers, so
     * route evidence may not refuse them — see this section's header.
     */
    if (proposal.kind === 'WALK' && behavior.routes.length > 0) {
      const covered = suiteRoutesByType.get(behavior.type);
      if (covered && behavior.routes.every((route) => covered.has(route))) {
        suppressed.push({
          sourceId: proposal.sourceId,
          kind: proposal.kind,
          reason: 'SUITE_ALREADY_COVERS_ROUTES',
          detail: `Every route this walk visits (${behavior.routes.slice(0, 4).join(', ')}) is already reached by an existing ${behavior.type} test, so the only new claim would be the ORDER of the visits.`,
        });
        continue;
      }
    }

    kept.push(proposal);
    keptBehaviors.push(behavior);
  }

  return { kept, suppressed };
}

// ─── THE PIPELINE ────────────────────────────────────────────────────────────

/** Everything the deterministic producer takes. Each field is optional: a caller
 * that has run only two of the six modules gets a plan from those two, with the
 * other four reported as "not enumerated" rather than as "nothing to test". */
export interface ScenarioPlanInput {
  /**
   * The run seed. Present so the signature is honest about reproducibility and
   * so a caller cannot build this input without having one — every module below
   * already mixed it into its own ids, so nothing here re-derives a value from
   * it. Echoed on the result for the same reason `WalkSelection` echoes it: a
   * plan nobody can reproduce is a plan nobody can debug.
   */
  readonly seed: string;
  readonly walks?: WalkSelection | null;
  readonly faults?: FaultScenarioSet | null;
  readonly races?: RaceScenarioSet | null;
  readonly lifecycle?: AuthLifecycleEnumeration | null;
  readonly multiActor?: MultiActorEnumeration | null;
  readonly authz?: AuthzPlan | null;
  readonly tenantPairs?: readonly { holder: string; subject: string; endpointCount: number }[];
  readonly boundaryCases?: readonly {
    id: string;
    field: string;
    klass: string;
    expectation: string;
    expected: string;
    formName: string;
  }[];
  /** Existing PROPOSED/APPROVED plan items. Prose-vs-prose, refuses. */
  readonly priorItems?: readonly PriorPlanItem[];
  /** The suite. Prose-vs-code, weak, refuses WALKs only. */
  readonly existingTests?: readonly SuiteHealthTestInput[];
  /** Hard ceiling on items returned. Always disclosed as a count AND a reason. */
  readonly maxItems?: number;
}

export interface ScenarioPlan {
  /** Ranked, highest-risk first. Deterministic for one input. */
  readonly items: readonly ScenarioProposal[];
  /** Every proposal that did not make `items`, each with a reason. */
  readonly suppressed: readonly Suppression[];
  /** How many proposals every adapter produced, before any suppression. */
  readonly considered: number;
  /** Suppressed by `maxItems`. Zero when the budget did not bite. */
  readonly omittedByCap: number;
  /**
   * Non-null EXACTLY when `omittedByCap > 0`, so a reader never sees a
   * shortfall with no reason beside it or a reason with no shortfall.
   */
  readonly capReason: string | null;
  /** Per-kind counts of what survived. A kind with 0 is in `notEnumerated`. */
  readonly byKind: Readonly<Record<ScenarioKind, number>>;
  /**
   * Kinds no input was supplied for.
   *
   * THE DISTINCTION THAT MATTERS: a kind here is one QAAI DID NOT LOOK FOR.
   * A kind with `byKind[k] === 0` and NOT here is one it looked for and found
   * nothing. Rendering those two the same way is "a pass that means we did not
   * check", and it is the reason this field exists rather than a zero.
   */
  readonly notEnumerated: readonly ScenarioKind[];
  /** Auth-lifecycle flows the enumerator could not plan. Never a silent zero. */
  readonly lifecycleUnmeasured: number;
  /** Cross-tenant probes the authz module refused, carried verbatim. */
  readonly authzRefusals: AuthzPlan['refusals'];
  readonly seed: string;
}

const DEFAULT_MAX_SCENARIO_ITEMS = 60;

/**
 * Turn six modules' worth of enumerated scenarios into one ranked, deduplicated
 * plan.
 *
 * MODEL-FREE AND DETERMINISTIC. There is no `LlmService` parameter and there
 * cannot be one: this is the path that has to work with no API key, and every
 * ordering decision in it is a total sort over values the modules derived from
 * content. No `Math.random`, no `Date.now`, no ambient clock. The same input
 * produces a byte-identical plan.
 *
 * A model may ENRICH this afterwards — {@link proposePlan} above is that path,
 * and it now receives this plan's own output as context so it stops re-proposing
 * work that already exists.
 */
export function proposeScenarioPlan(input: ScenarioPlanInput): ScenarioPlan {
  const all: ScenarioProposal[] = [];
  const notEnumerated: ScenarioKind[] = [];

  if (input.walks) all.push(...walkProposals(input.walks));
  else notEnumerated.push('WALK');

  if (input.faults) all.push(...faultProposals(input.faults));
  else notEnumerated.push('FAULT_INJECTION');

  if (input.races) all.push(...raceProposals(input.races));
  else notEnumerated.push('RACE');

  let lifecycleUnmeasured = 0;
  if (input.lifecycle) {
    const result = lifecycleProposals(input.lifecycle);
    all.push(...result.proposals);
    lifecycleUnmeasured = result.unmeasured;
  } else notEnumerated.push('AUTH_LIFECYCLE');

  if (input.multiActor) all.push(...multiActorProposals(input.multiActor));
  else notEnumerated.push('MULTI_ACTOR');

  let authzRefusals: AuthzPlan['refusals'] = [];
  if (input.authz) {
    const result = authzProposals(input.authz);
    all.push(...result.proposals);
    authzRefusals = result.refusals;
  } else notEnumerated.push('AUTHZ_PROBE');

  if (input.tenantPairs && input.tenantPairs.length > 0) {
    all.push(...tenancyProposals(input.tenantPairs));
  } else notEnumerated.push('TENANCY');

  if (input.boundaryCases && input.boundaryCases.length > 0) {
    all.push(...boundaryProposals(input.boundaryCases));
  } else {
    notEnumerated.push('BOUNDARY', 'FUZZ');
  }

  const considered = all.length;

  /*
   * THE TOTAL SORT. Rank descending, then the declared kind order, then the
   * source id — three keys, the last of which is unique, so the order is TOTAL
   * and the output is byte-identical across runs. A two-key sort would leave
   * ties to `Array.prototype.sort`'s stability over whatever order the adapters
   * happened to run in, which is reproducible by accident rather than by
   * construction.
   */
  const kindOrder = new Map(SCENARIO_KINDS.map((kind, index) => [kind, index]));
  const ranked = [...all].sort((a, b) => {
    const byRank = rankProposal(b) - rankProposal(a);
    if (byRank !== 0) return byRank;
    const byKind = (kindOrder.get(a.kind) ?? 0) - (kindOrder.get(b.kind) ?? 0);
    if (byKind !== 0) return byKind;
    return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
  });

  const { kept, suppressed } = suppressKnownWork({
    proposals: ranked,
    ...(input.priorItems ? { priorItems: input.priorItems } : {}),
    ...(input.existingTests ? { existingTests: input.existingTests } : {}),
  });

  const cap = input.maxItems ?? DEFAULT_MAX_SCENARIO_ITEMS;
  const items = kept.slice(0, cap);
  const omittedByCap = kept.length - items.length;
  for (const dropped of kept.slice(cap)) {
    suppressed.push({
      sourceId: dropped.sourceId,
      kind: dropped.kind,
      reason: 'BUDGET',
      detail: `Ranked below the ${cap}-item plan budget. It was not refused and nothing is wrong with it — raise the budget or approve this plan and re-run to reach it.`,
    });
  }

  const byKind = SCENARIO_KINDS.reduce(
    (acc, kind) => ({ ...acc, [kind]: items.filter((item) => item.kind === kind).length }),
    {} as Record<ScenarioKind, number>,
  );

  return {
    items,
    suppressed,
    considered,
    omittedByCap,
    capReason:
      omittedByCap > 0
        ? `The plan is capped at ${cap} items, so at least ${omittedByCap} more scenario(s) were enumerated and not proposed. Every one of them is listed in \`suppressed\` with reason BUDGET.`
        : null,
    byKind,
    notEnumerated,
    lifecycleUnmeasured,
    authzRefusals,
    seed: input.seed,
  };
}

/**
 * The plan, rendered for the MODEL's prompt — which is the other half of giving
 * the Explorer the suite and the gap report.
 *
 * Titles, features and priorities only. No step, no assertion, no principal
 * name and no identifier that could carry a credential: this string is
 * interpolated into a prompt, and `llm.ts` masking secrets on the way out stays
 * true by not handing it any.
 */
export function summariseScenarioPlan(plan: ScenarioPlan): string {
  if (plan.items.length === 0) {
    return `SCENARIOS ALREADY PROPOSED DETERMINISTICALLY
  (none${
    plan.notEnumerated.length === SCENARIO_KIND_LIST.length
      ? ' — no scenario module was run for this project'
      : ''
  })`;
  }
  const lines = plan.items
    .slice(0, 40)
    .map((item) => `  [${item.kind}] ${item.item.title} (${item.item.priority})`)
    .join('\n');
  return `SCENARIOS ALREADY PROPOSED DETERMINISTICALLY
Do NOT propose any of these again — they are already in this plan. Propose only
what they do not cover.
${lines}${
    plan.items.length > 40 ? `\n  … and ${plan.items.length - 40} more` : ''
  }${
    plan.notEnumerated.length > 0
      ? `\nNOT ENUMERATED AT ALL (nothing looked for these, so they are uncovered rather than clean): ${plan.notEnumerated.join(', ')}`
      : ''
  }`;
}

/**
 * WHAT THE SUITE ALREADY HAS, rendered for the model's prompt.
 *
 * THE DEFECT (explorer.ts:47 as it was): `summariseFlowMap` passed the flow map
 * and NOTHING ELSE, so the ranked plan was coverage-blind. The model could not
 * know a journey already had three tests, so it proposed a fourth, a human
 * approved it, the Generator spent a strong-tier call on it, and the DUPLICATE
 * gate refused it at the very last moment — after every cost had been paid. The
 * cheapest place to stop that is before the prompt.
 *
 * Names, types and features only. No source, no locator, no assertion text: the
 * model needs to know WHAT is covered, not how, and a prompt is the last place
 * to put the customer's code.
 */
export function summariseExistingSuite(
  tests: readonly { name: string; type: TestType; feature: string | null }[],
  opts: { max?: number } = {},
): string {
  const max = opts.max ?? 60;
  if (tests.length === 0) {
    return `TESTS THAT ALREADY EXIST
  (none — this project has no suite yet, so nothing below is a duplicate)`;
  }
  const shown = tests.slice(0, max);
  const omitted = tests.length - shown.length;
  return `TESTS THAT ALREADY EXIST
Do NOT propose a test that duplicates one of these. If a feature below is
already covered and you still think a gap remains, say in the rationale what the
existing test does NOT prove.
${shown.map((t) => `  [${t.type}] ${t.name}${t.feature ? ` — ${t.feature}` : ''}`).join('\n')}${
    omitted > 0
      ? `\n  … and ${omitted} more not shown here, so treat this list as incomplete rather than exhaustive`
      : ''
  }`;
}

/**
 * THE GAP REPORT, rendered for the model's prompt.
 *
 * The other half of the same defect: the ranked plan re-proposed work that
 * already existed AND failed to propose the work coverage analysis had already
 * proved was missing. A gap is the strongest possible signal of what to test —
 * it is a measured absence, not a guess — and it was absent from this prompt
 * entirely.
 *
 * `requiresAuth` with no profile is called out in its own words, because that is
 * the case where an item must propose a test of the WALL and say the page behind
 * it stays uncovered, rather than proposing a test of the page that would run as
 * nobody and pass.
 */
export function summariseGapReport(
  gaps: readonly {
    id: string;
    kind: string;
    route: string | null;
    feature: string | null;
    requiresAuth?: boolean;
    authProfileName?: string | null;
  }[],
  opts: { max?: number } = {},
): string {
  const max = opts.max ?? 40;
  if (gaps.length === 0) {
    return `MEASURED COVERAGE GAPS
  (none recorded — either coverage analysis has not run for this project, or it
   found nothing. Those are different facts and this list cannot tell you which,
   so do not read an empty list as a covered application.)`;
  }
  const shown = gaps.slice(0, max);
  const omitted = gaps.length - shown.length;
  return `MEASURED COVERAGE GAPS
These are MEASURED absences, not guesses — the strongest signal you have about
what to test. Prefer them over anything you infer from the states above, and set
each item's gapId to the gap id it closes.
${shown
  .map(
    (gap) =>
      `  ${gap.id} [${gap.kind}] ${gap.route ?? '(no route)'}${
        gap.feature ? ` — ${gap.feature}` : ''
      }${
        gap.requiresAuth === true && !gap.authProfileName
          ? ' — BEHIND AUTH AND NO PROFILE FITS: propose a test of the WALL and say in the assertions that the page behind it stays uncovered. Do NOT propose a test of the page itself; it would run as nobody and pass.'
          : gap.authProfileName
            ? ` — run as "${gap.authProfileName}"`
            : ''
      }`,
  )
  .join('\n')}${omitted > 0 ? `\n  … and ${omitted} more` : ''}`;
}
