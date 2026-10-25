/**
 * Coverage gap analysis — "which test did you never write?"
 *
 * Every other part of this product reports on tests that exist: which failed,
 * which flaked, which a diff can reach. This one reports on the tests that do
 * not exist, which is the only question a QA lead actually loses sleep over. We
 * already hold both halves of the answer and have never put them side by side:
 * the Flow Map is what the application can do, and the Test rows are what is
 * actually asserted. A gap is a thing in the first that is missing from the
 * second.
 *
 * NOTHING IN THIS FILE CALLS A MODEL. A gap is a claim about the customer's test
 * suite, and a claim we cannot show the working for is worse than no claim at
 * all — it is a confident stranger telling a team their checkout is untested.
 * So every gap carries `evidence`: the literal sentences that justify it ("the
 * crawl reached /refunds from 3 places; no test mentions it"). The model is
 * invited exactly once, at the end, to WRITE the missing test — never to decide
 * that one is missing.
 *
 * Three rules follow from that, and they are the whole design:
 *
 * 1. UNKNOWN IS NOT A GAP. A test that navigates to a URL built at runtime
 *    (`page.goto(url)`) is invisible to static extraction. It might be the one
 *    test covering /refunds. Counting its absence as a gap would be asserting
 *    coverage knowledge we do not have, so those tests go in `unknowns`, are
 *    reported as their own bucket, and cap the confidence of every route gap in
 *    the project.
 *
 * 2. CRYING WOLF IS THE FAILURE MODE. A false "you never test checkout" is not
 *    a minor inaccuracy; it is the thing that makes a team close the tab. So
 *    matching is deliberately ASYMMETRIC: strict where the evidence is strong
 *    (a route literal either appears or it does not) and generous everywhere the
 *    evidence is weak (if any test anywhere mentions a button's label, we do not
 *    claim nobody clicks it).
 *
 * 3. A DETECTOR THAT THROWS MUST NOT TAKE THE REPORT DOWN. The flow map is a
 *    Json column written by an older crawler than the types here describe. Every
 *    reader below is defensive, and anything unreadable is reported in
 *    `unreadable` rather than silently dropped — a gap that vanishes because one
 *    node had a null in it is exactly the silence this feature exists to end.
 *
 * On the input contract: route extraction from Test.code is NOT re-derived here.
 * apps/api/src/lib/impact.ts already does it — string-level, cap-guarded, with
 * template and toHaveURL handling that took real bugs to get right — and this
 * package cannot import from an app. So the caller extracts and passes
 * `routes`, and `apps/api/src/routes/coverage.ts` is the one place that wiring
 * lives. `canonicalRoute` below is then applied to BOTH sides as the comparison
 * key; it is idempotent on impact's `normalizeRoute` output by construction.
 */

import { createHash } from 'node:crypto';
import {
  EXCLUSION_KINDS,
  EXCLUSION_KIND_LABELS,
  FORM_FIELD_SEMANTICS,
  UNEXERCISABLE_REASON_LABELS,
  controlsFromFlowMap,
  exclusionsByRule,
} from '@qaai/shared';
import type {
  ExclusionKind,
  FormFieldSemantic,
  PlanItem,
  Priority,
  Selector,
  SurfaceExercisability,
  SurfaceExercise,
  TestType,
  UnexercisableReason,
} from '@qaai/shared';
import { expandBoundaries, type BoundaryCase, type BoundaryExpansion, type BoundaryField } from './boundaries.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const GAP_KINDS = [
  /** A route in the crawl that no test navigates to. */
  'UNVISITED_ROUTE',
  /** A route the crawler hit an auth wall on, that no *authenticated* test reaches. */
  'UNREACHED_AUTH_ROUTE',
  /** A journey the crawl walked end to end that no single test walks. */
  'UNWALKED_JOURNEY',
  /** A form nobody fills in or submits. */
  'UNSUBMITTED_FORM',
  /** A button or input the crawler found that no test mentions. */
  'UNUSED_AFFORDANCE',
  /** A feature that has tests, all of which only assert the happy path. */
  'NO_NEGATIVE_CASE',
  /**
   * A surface the crawl REFUSED to drive, so nothing downstream has ever
   * mentioned it: logout, delete account, cancel subscription, destroy
   * workspace.
   *
   * This is the only gap kind whose remedy is not "write a test". The test is
   * writable the moment the environment can afford the side effect, and until
   * then the finding is ours and not the customer's — which is why it carries a
   * reason and a remedy rather than a proposal.
   */
  'UNEXERCISABLE_SURFACE',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/**
 * How much of this claim rests on something we can point at.
 *
 * HIGH    every test's declared coverage was fully readable and none of it
 *         touches this; the only way we are wrong is if the crawl is wrong.
 * MEDIUM  readable, but something nearby weakens it — a test lands one click
 *         away, or the suite contains tests we could not read.
 * LOW     the detector is a heuristic over human-written English (the
 *         negative-case scan) and deserves a human's eye before it is believed.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Caps. Each one protects the process; each one is reported when it bites. */
const MAX_CODE_CHARS = 400_000;
const MAX_NODES = 2000;
const MAX_GAPS = 300;
const MAX_AFFORDANCE_GAPS = 40;
const MAX_EVIDENCE_TESTS = 5;
/** Refusals read off a flow map. Deduped by route first, so this is routes. */
const MAX_EXCLUSIONS = 500;
/** Unexercisable surfaces reported as gaps. The rest are counted in a caveat. */
const MAX_UNEXERCISABLE_GAPS = 60;
/** Test-referenced targets the enumeration never found. See `reverseReconcile`. */
const MAX_REVERSE_TARGETS = 200;
/** Verbatim spellings kept per reverse-reconciled target, for the audit row. */
const MAX_SPELLINGS_PER_TARGET = 5;

// ─── The surface nothing is allowed to touch ─────────────────────────────────

/*
 * THE CLASS THAT VANISHED.
 *
 * The crawler refuses /logout, /delete-*, /destroy and __reset — correctly, and
 * it has to: following a logout makes every observation after it anonymous, and
 * following a delete destroys a record it cannot put back. The refusal is right.
 * Recording nothing about it was not.
 *
 * `FlowMap.excluded` now carries every refused URL and the rule that refused it
 * (packages/shared/src/flow-map.ts), and this is where those rows become a
 * named class with a reason and a REMEDY instead of an absence. The reason it
 * matters more than its size suggests: a session-ending or destructive flow is
 * the highest-risk surface in an application — it is where a customer's data
 * actually goes away — and it was the one surface guaranteed to be missing from
 * the denominator. Absent raises the percentage. Uncovered lowers it. The
 * hardest surfaces were the ones being dropped.
 *
 * TWO CLASSES, AND THE SPLIT IS THE WHOLE VALUE OF THE TABLE BELOW.
 *
 *   UNEXERCISABLE  it exists, it is testable in principle, and this environment
 *                  cannot afford the side effect. The remedy is OURS: give the
 *                  harness a disposable session or a disposable record. These
 *                  become gaps, because somebody can act on them.
 *   REFUSED        a policy rule excluded it. We did not look, and nothing is
 *                  claimed in either direction. These become a counted caveat
 *                  naming the rule, because the customer's own remedy is to
 *                  change the rule and ours is to say that we did not ask.
 *
 * And a third answer that is NOT a surface at all: an off-origin URL is
 * somebody else's application and an unsupported scheme is not a page. Those
 * map to NULL. Counting a third-party identity provider's login form as this
 * app's route produces a coverage gap a customer cannot possibly close, which
 * is worse than a wrong number — flow-map.ts argues the same point for
 * `ExternalBoundary`. They are still COUNTED, in a caveat, because a silent
 * drop and a reasoned exclusion must not look the same from outside.
 */

export interface ExclusionClassification {
  state: SurfaceExercisability;
  /**
   * Why, for the UNEXERCISABLE class. NULL for REFUSED, and the null is the
   * point: a refusal has a RULE, not a reason — claiming "it ends the session"
   * about a path an `excludeGlobs` pattern matched would be our guess at the
   * customer's intent printed as their motive.
   */
  reason: UnexercisableReason | null;
  /** What it would take to exercise it. A sentence somebody can act on. */
  remedy: string;
}

/**
 * Every exclusion kind, classified. A `Record` and not a lookup function, so
 * the compiler refuses to let a new `ExclusionKind` ship unclassified — the
 * half of the guard that eight GateRule kinds shipped without. The run-time
 * half is the parity test in coverage.test.ts against `EXCLUSION_KINDS`.
 */
export const EXCLUSION_AS_EXERCISE: Record<ExclusionKind, ExclusionClassification | null> = {
  SESSION_ENDING: {
    state: 'UNEXERCISABLE',
    reason: 'SESSION_ENDING',
    remedy:
      'Bind a second auth profile the harness is allowed to log out, so the session this flow ends is one we can afford to lose.',
  },
  DESTRUCTIVE: {
    state: 'UNEXERCISABLE',
    reason: 'DESTRUCTIVE',
    remedy:
      'Provision a disposable record per run — a throwaway account, workspace or subscription — so the flow can be driven to completion and then thrown away.',
  },
  UNSAFE_METHOD: {
    state: 'REFUSED',
    reason: null,
    remedy:
      'The crawl policy allows safe methods only. Allow the method for this path, or declare the operation from an OpenAPI document instead, where a verb needs no request to be enumerated.',
  },
  POLICY_EXCLUDE: {
    state: 'REFUSED',
    reason: null,
    remedy: 'Remove the path from the environment’s `excludeGlobs` to have it enumerated.',
  },
  POLICY_NOT_INCLUDED: {
    state: 'REFUSED',
    reason: null,
    remedy:
      'The environment sets `includeGlobs` and this path matched none of them. Widen the include list to have it enumerated.',
  },
  // Not this application's surface. See the header above.
  OFF_ORIGIN: null,
  UNSUPPORTED_SCHEME: null,
};

/**
 * One refused URL as a `SurfaceExercise`, plus the remedy, or null when the URL
 * is not this application's surface at all.
 *
 * Returns the shared `SurfaceExercise` shape rather than a second one, so a
 * caller writing a `CoverageItem` passes it straight through and the inventory
 * and the gap report cannot come to describe one refusal two ways.
 */
export function exclusionAsExercise(
  kind: ExclusionKind,
  rule: string,
): (SurfaceExercise & { remedy: string }) | null {
  const classified = EXCLUSION_AS_EXERCISE[kind];
  if (!classified) return null;

  const label = EXCLUSION_KIND_LABELS[kind];
  return {
    state: classified.state,
    reason: classified.reason,
    // Required for REFUSED and carried for both: "excluded by policy" with no
    // rule named is indistinguishable from a bug in the crawler, and the
    // customer's only possible response to it is to distrust the number.
    rule,
    detail:
      classified.state === 'UNEXERCISABLE'
        ? `the crawl refused it because it ${label} (${UNEXERCISABLE_REASON_LABELS[classified.reason!]}); rule: ${rule}`
        : `the crawl refused it because it ${label}; rule: ${rule}`,
    remedy: classified.remedy,
  };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CoverageTestInput {
  id: string;
  name: string;
  filePath: string;
  feature: string | null;
  priority: Priority;
  testType: TestType;
  tags: string[];
  /**
   * Routes this test navigates to, asserts on, or configures — ALREADY
   * EXTRACTED by the caller with impact.ts's `routeLiteralsFromCode` and
   * `routesFromSpec`. Passing `[]` means "declares none", which is a real and
   * important state; it is not the same as "covers nothing", which is why
   * `code` comes along too.
   */
  routes: string[];
  /**
   * Source. Read here ONLY for things a route list cannot express: whether the
   * test signs in, whether it asserts a failure, whether it navigates to a URL
   * we cannot see, and whether it mentions a given button.
   */
  code: string | null;
  /** Set by the caller when its extractor hit a cap and read `routes` partially. */
  coverageTruncated?: boolean;
  /**
   * `Test.authProfileId` — the role this test executes as, when it has one.
   *
   * THIS FIELD IS WHAT MAKES THE AUTH LOOP CONVERGE. `signsIn()` below reads
   * the source for a sign-in step, a stored session or an auth header, and a
   * test bound to an auth profile has NONE of those: the runner injects the
   * profile's storageState before the first navigation, so the fact that the
   * test is authenticated is in this column and nowhere in the code. Judging it
   * by the code alone meant an UNREACHED_AUTH_ROUTE gap was re-reported after
   * exactly the test that closed it had been written and had passed.
   *
   * Absent (the shape before this field existed) is read as anonymous, which is
   * what every caller that does not pass it has always meant.
   */
  authProfileId?: string | null;
  /**
   * `Test.authProfileRequired` — the test's own statement that it is
   * meaningless signed out.
   *
   * Read here for the one case the binding cannot express: the profile was
   * deleted, the foreign key nulled `authProfileId`, and this stayed true. Such
   * a test is NOT authenticated however much like a signed-in test it looks, so
   * the gap it was written to close re-opens — with the broken binding named in
   * the evidence, because "your admin test is running anonymously" is the
   * finding, not an internal detail.
   */
  authProfileRequired?: boolean;
}

/**
 * An auth profile this project could actually sign in with, as the caller sees
 * it. Only the fields a deterministic chooser is entitled to look at: the id it
 * will bind, the name a human will recognise, and the kind, which says HOW the
 * sign-in happens and is reported rather than reasoned about.
 *
 * Secrets are absent on purpose. Choosing a role does not require knowing a
 * password, and this struct travels into gap evidence that is shown to people.
 */
export interface AuthProfileChoice {
  id: string;
  name: string;
  kind?: string;
}

/**
 * The profile a gap's test must run as, with the reason it was chosen.
 *
 * `why` is not decoration. Nothing here calls a model, so the choice is a
 * deterministic rule over names and declared roles, and a deterministic rule
 * over somebody else's naming WILL sometimes be wrong. Carrying the reason
 * means a team can read "chosen because /admin/users requires the role
 * \"admin\" and a profile is named \"admin\"" and correct it, instead of
 * finding a test signed in as the wrong person and having to guess why.
 */
export interface GapAuthProfile {
  id: string;
  name: string;
  why: string;
}

export interface CoverageInput {
  /** The serialised FlowMap row. Read defensively; any shape is survivable. */
  flowMapGraph: unknown;
  tests: CoverageTestInput[];
  /** Ranked gaps to return. The full count is always reported in `totals`. */
  limit?: number;
  /**
   * Auth profiles configured on the environment this crawl came from.
   *
   * Passing them is what lets a gap behind an auth wall propose a test that
   * SIGNS IN rather than one that asserts anonymous denial. Omitting them is
   * not an error — it is the honest input for a project that has configured no
   * profile yet, and it produces auth gaps that say so and stay open, which is
   * the correct report. What it must never produce is a test that runs
   * anonymously while claiming to cover the page behind the wall.
   */
  authProfiles?: AuthProfileChoice[];
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/**
 * One field of a form, as a gap carries it.
 *
 * THE DEFECT THIS WIDENING FIXES: this was `{ label; required; semantic }`, and
 * that projection is where the negative half of testing died. The crawler reads
 * `maxlength`, `min`, `max`, `step` and `pattern` off the DOM and puts them on
 * `FormField` (packages/shared/src/flow-map.ts); `readForms` below then copied
 * three of the eleven members across and dropped the rest on the floor —
 * including `name`, which is the key `expandBoundaries` writes its values
 * under. With the constraints gone, "submit one character over the limit" was
 * unreachable BY CONSTRUCTION: the limit is a number the page already carries
 * and nothing downstream could see it, so the only negative test anybody could
 * write from a gap was "leave the first required field empty".
 *
 * Every constraint keeps the three-state shape it has on `FormField`, and the
 * reason is the same one given there: absent means this crawl predates the
 * capture, null means the crawl looked and the page declares nothing, a value
 * means the page declares it. Collapsing absent onto null here would re-import
 * the lie at the boundary — see `nothingDeclared` in boundaries.ts for what
 * that wording does to a consumer.
 */
export interface FormFieldSummary {
  /** Label, falling back to the `name` attribute. What a human reads. */
  label: string;
  required: boolean;
  semantic: string;
  /**
   * The `name` attribute. Not cosmetic: `expandBoundaries` keys its `values`
   * record on it, so a field summary without a name cannot be perturbed at all.
   */
  name: string;
  /** HTML input type, or 'select'/'textarea'. Decides which classes even apply. */
  inputType: string;
  /** Present for select/radio — the universe `not-in-options` steps outside of. */
  options?: string[];
  maxLength?: number | null;
  minLength?: number | null;
  min?: string | null;
  max?: string | null;
  step?: string | null;
  pattern?: string | null;
  inputMode?: string | null;
  autocomplete?: string | null;
  accept?: string | null;
  multiple?: boolean;
  /** The page's own words for the failure. The strongest negative assertion there is. */
  validationMessage?: string | null;
}

export interface FormSummary {
  name: string;
  submitLabel: string | null;
  fields: FormFieldSummary[];
}

/**
 * Everything `planItemForGap` needs to write a proposal, carried on the gap
 * itself. A gap travels from GET /coverage to POST /coverage/:id/propose through
 * a client, so it has to be self-contained — re-deriving it from the report on
 * the way back in is how a proposal ends up describing a different gap than the
 * one the human ticked.
 */
export type GapSubject =
  | {
      kind: 'route';
      route: string;
      title: string;
      behindAuth: boolean;
      forms: FormSummary[];
      /** Actions the crawler used to ARRIVE here — the steps a test must repeat. */
      entryActions: string[];
    }
  | {
      kind: 'journey';
      journeyId: string;
      name: string;
      description: string;
      priority: Priority;
      /** Ordered actions from the crawl: `click "Add to cart"`. */
      steps: string[];
      routes: string[];
    }
  | { kind: 'form'; route: string; form: FormSummary; behindAuth: boolean }
  | {
      kind: 'affordance';
      route: string;
      label: string;
      expression: string;
      controlKind: 'link' | 'button' | 'input';
    }
  | { kind: 'negative'; feature: string; routes: string[]; forms: FormSummary[]; testIds: string[] }
  | {
      kind: 'unexercisable';
      /** Canonical route, or null when the refused URL had no readable path. */
      route: string | null;
      /** The URL as the crawl discovered it. The only handle for a route-less refusal. */
      url: string;
      /** Why the crawl would not drive it, from `UNEXERCISABLE_REASONS`. */
      reason: UnexercisableReason;
      /** The policy rule that refused it — a line a human can look up. */
      rule: string;
      /** What it would take to make this testable. See `EXCLUSION_AS_EXERCISE`. */
      remedy: string;
    };

export interface CoverageGap {
  /** Deterministic for a given (kind, subject). Stable across recomputation. */
  id: string;
  kind: GapKind;
  /** One line a human reads first. */
  title: string;
  route: string | null;
  feature: string | null;
  /**
   * The claim's support, in plain English. A gap with an empty evidence array is
   * a bug — nothing below is allowed to emit one.
   */
  evidence: string[];
  confidence: Confidence;
  /** 0–1. Flow-map inbound edges, as the proxy for how much traffic passes here. */
  reachability: number;
  /** 0–1. What breaking this would cost: state changes, privilege, journeys. */
  blastRadius: number;
  /** 0–100. The rank. */
  score: number;
  /** Why the score is what it is, so the ranking can be argued with. */
  scoreWhy: string[];
  /** Tests in the neighbourhood that do not close the gap. */
  relatedTestIds: string[];
  subject: GapSubject;
  /**
   * True when a test that closes this gap has to be signed in. Stored rather
   * than re-derived for the reason given above `GapSubject`: a gap travels out
   * through GET /coverage and comes back in through POST /propose, and a
   * property recomputed on the way back in is a property that can disagree with
   * itself.
   */
  requiresAuth: boolean;
  /**
   * The profile the test will be bound to, or null.
   *
   * Null with `requiresAuth: false` is the ordinary case — nothing to sign in
   * as, nothing needed. Null with `requiresAuth: true` is the state that must
   * stay loud: a test IS needed behind the wall and there is no profile to name,
   * so the proposal below does not pretend otherwise and this gap stays open
   * until somebody configures one.
   */
  authProfile: GapAuthProfile | null;
}

/**
 * A test whose coverage we could not read. Not a gap and not coverage — the
 * third state, reported so nobody reads "12 gaps" as "12 things you don't test".
 */
export interface CoverageUnknown {
  testId: string;
  name: string;
  filePath: string;
  reason: string;
  /** The literal that defeated extraction, when there is one worth showing. */
  sample: string | null;
}

export interface CoverageReport {
  /** False when there is no readable flow map: then we know nothing about the app. */
  crawled: boolean;
  flowMapVersion: number | null;
  baseUrl: string | null;
  gaps: CoverageGap[];
  unknowns: CoverageUnknown[];
  /** Parts of the flow map that could not be read. Never silently dropped. */
  unreadable: string[];
  /** Things a reader must know before trusting the numbers. */
  caveats: string[];
  totals: {
    tests: number;
    testsWithReadableRoutes: number;
    routes: number;
    routesVisited: number;
    journeys: number;
    journeysWalked: number;
    forms: number;
    formsExercised: number;
    affordances: number;
    affordancesUsed: number;
    gaps: number;
    gapsReturned: number;
    /**
     * Surfaces the crawl refused because driving them is unsafe here, and
     * surfaces a policy rule refused.
     *
     * NULL, not 0, when the flow map did not record refusals at all — see
     * `CrawlModel.excluded`. Every crawl written before the exclusion ledger
     * existed is in that state, and a 0 would tell those installs they have no
     * destructive surface.
     */
    unexercisableSurfaces: number | null;
    refusedSurfaces: number | null;
  };
  /**
   * Tests that reference surface the enumeration never found.
   *
   * See {@link reverseReconcile}. Coverage has only ever run crawl→tests, so a
   * test pointing at a route the crawl never reached was simply unmatched and
   * silent — and that reference is the hardest evidence of crawl undercount
   * this product can obtain, because a human wrote it down.
   */
  reverse: ReverseReconciliation;
  /** Changes whenever the answer could change. POST /propose checks it. */
  fingerprint: string;
}

// ─── Reverse reconciliation: what the TESTS know that we do not ──────────────

/**
 * One target a test names and the enumeration does not hold.
 *
 * `spellings` is verbatim and plural on purpose: two tests may write
 * `/orders/123` and `/orders/:id` for one target, and the canonical form is
 * ours while the spellings are theirs. A customer disputing a row needs to see
 * the string they typed, not our normalisation of it.
 */
export interface UnenumeratedTestTarget {
  /** The canonical route the tests reference. */
  route: string;
  /** Up to `MAX_SPELLINGS_PER_TARGET` verbatim spellings; `spellingCount` is exact. */
  spellings: string[];
  spellingCount: number;
  testIds: string[];
  testNames: string[];
  evidence: string;
}

/**
 * THE DIRECTION COVERAGE HAS NEVER RUN IN.
 *
 * Everything else in this file asks "does a test go here?" over surfaces the
 * crawl found. That question cannot see its own blind spot: a test that
 * navigates to `/admin/billing/invoices` when the crawl never reached it is not
 * a gap and not coverage — it is unmatched, and until now it was silent.
 *
 * It is also the best evidence of undercount that exists. Every other signal
 * about our enumeration being incomplete is a guess about what we did not see.
 * This one is a human being writing down a URL of the application, in a file
 * they maintain, which our denominator does not contain. If a test goes there,
 * it exists.
 *
 * WHAT THIS IS NOT ALLOWED TO DO
 *
 *   · It must not mint surfaces. A test's route is evidence that a surface
 *     exists; it is not a reading of the surface, carries no file, no method
 *     and no fields, and `SURFACE_SOURCES` has no member for "a test mentioned
 *     it". Inventing one would put a guess in the denominator beside eight
 *     declarers that read something.
 *   · It must not report a count when nothing enumerated. `enumerated: null` is
 *     "no enumeration ran" and yields `measured: false` with NULL counts, never
 *     zero — a zero here reads as "your tests agree with our enumeration
 *     perfectly", which is the most flattering possible lie.
 *   · It must not treat an opaque test as agreement. A test whose navigation is
 *     built at run time contributes no targets, so it can neither confirm nor
 *     contradict; it is counted separately and named in a caveat.
 */
export interface ReverseReconciliation {
  /** False when `enumerated` was null. Then every count below is null. */
  measured: boolean;
  unenumerated: UnenumeratedTestTarget[];
  /** Distinct readable targets compared. Null when nothing was measured. */
  targetsCompared: number | null;
  /** Tests whose route list we could not read. Not evidence either way. */
  testsWithNoReadableRoutes: number;
  /**
   * The floor on how far the enumerated surface understates the application.
   *
   * A FLOOR and never an estimate: it counts only targets a test named out
   * loud, so the real shortfall is at least this and may be far larger. Null
   * when nothing was measured.
   */
  declaredSetUnderstatedByAtLeast: number | null;
  /** True when `unenumerated` was capped. The count above stays exact. */
  truncated: boolean;
  caveats: string[];
}

export function reverseReconcile(input: {
  /**
   * Canonical route identities the enumeration holds, or NULL when no
   * enumeration ran. Null and `[]` are different answers — see the header.
   */
  enumerated: readonly string[] | null;
  tests: readonly CoverageTestInput[];
}): ReverseReconciliation {
  const { enumerated, tests } = input;

  if (enumerated === null) {
    return {
      measured: false,
      unenumerated: [],
      targetsCompared: null,
      testsWithNoReadableRoutes: tests.length,
      declaredSetUnderstatedByAtLeast: null,
      truncated: false,
      caveats: [
        'Nothing has enumerated this application’s surface, so the tests could not be compared against it. This is not a finding that the suite and the enumeration agree — it is the absence of an enumeration to disagree with.',
      ],
    };
  }

  const surface = enumerated.map((identity) => canonicalRoute(identity));

  /** Canonical target → the tests that named it and how they spelled it. */
  const targets = new Map<
    string,
    { spellings: Set<string>; testIds: Set<string>; testNames: Set<string> }
  >();
  let testsWithNoReadableRoutes = 0;

  for (const test of tests) {
    const routes = test.routes.filter((raw) => typeof raw === 'string' && raw.length > 0);
    if (routes.length === 0) {
      testsWithNoReadableRoutes += 1;
      continue;
    }
    for (const raw of routes) {
      const canonical = canonicalRoute(raw);
      const entry = targets.get(canonical) ?? {
        spellings: new Set<string>(),
        testIds: new Set<string>(),
        testNames: new Set<string>(),
      };
      entry.spellings.add(raw);
      entry.testIds.add(test.id);
      entry.testNames.add(test.name);
      targets.set(canonical, entry);
    }
  }

  const missing: UnenumeratedTestTarget[] = [];
  for (const [route, entry] of targets) {
    /*
     * `routeVisits(testRoute, surfaceRoute)` — the same matcher and the same
     * argument order the ROUTE matcher in surface-coverage.ts uses, so a target
     * absorbed by `/orders/:param` there is absorbed here too. Two spellings of
     * "does this test go here" would make a target missing on one screen and
     * present on the other.
     */
    if (surface.some((identity) => routeVisits(route, identity))) continue;
    const spellings = [...entry.spellings];
    missing.push({
      route,
      spellings: spellings.slice(0, MAX_SPELLINGS_PER_TARGET),
      spellingCount: spellings.length,
      testIds: [...entry.testIds],
      testNames: [...entry.testNames],
      evidence: `${entry.testIds.size} test${entry.testIds.size === 1 ? '' : 's'} navigate to ${route} (${spellings.slice(0, 2).join(', ')}) and no declarer put it in the enumerated surface — so a human has written down a URL of this application that our denominator does not contain.`,
    });
  }

  // Most-referenced first: a target five tests agree on is stronger evidence of
  // undercount than one a single test mentions, and a reader works down.
  missing.sort(
    (left, right) =>
      right.testIds.length - left.testIds.length || left.route.localeCompare(right.route),
  );

  const caveats: string[] = [];
  const truncated = missing.length > MAX_REVERSE_TARGETS;
  if (truncated) {
    caveats.push(
      `${missing.length} test-referenced targets are absent from the enumerated surface; the ${MAX_REVERSE_TARGETS} most-referenced are listed. The count is exact — at least ${missing.length - MAX_REVERSE_TARGETS} more exist beyond the list.`,
    );
  }
  if (missing.length > 0) {
    caveats.push(
      `The enumerated surface understates this application by AT LEAST ${missing.length} route${missing.length === 1 ? '' : 's'}: that many are referenced by a test and declared by no source we read. Any recall or coverage percentage over this surface is therefore an upper bound.`,
    );
  }
  if (testsWithNoReadableRoutes > 0) {
    caveats.push(
      `${testsWithNoReadableRoutes} test${testsWithNoReadableRoutes === 1 ? '' : 's'} declare no route this analysis can read, so they neither confirm nor contradict the enumeration. They are not counted as agreement.`,
    );
  }
  if (enumerated.length === 0) {
    caveats.push(
      'The enumeration ran and found no routes, so every route any test references is reported here. That is a statement about our extractor, not about the suite.',
    );
  }
  if (tests.length === 0) {
    // Zero tests cannot contradict an enumeration, and the floor below is 0 for
    // that reason alone. Saying so is the difference between "your suite agrees
    // with us" and "there was no suite".
    caveats.push(
      'No tests were supplied, so the reverse direction found nothing by construction. That is not agreement between the suite and the enumeration — there was no suite to compare.',
    );
  }

  return {
    measured: true,
    unenumerated: missing.slice(0, MAX_REVERSE_TARGETS),
    targetsCompared: targets.size,
    testsWithNoReadableRoutes,
    declaredSetUnderstatedByAtLeast: missing.length,
    truncated,
    caveats,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * The comparison key, applied to BOTH sides.
 *
 * Every framework spells "anything here" differently — `[id]`, `{id}`, `:id`,
 * `$id`, `[...slug]` — and the crawler and the test author will not have picked
 * the same one. Collapsing them onto `:param` and `*` is the only way
 * `/orders/123` in a spec and `/orders/:id` in the flow map are recognised as
 * the same page. On routes that already came through impact.ts's
 * `normalizeRoute` this is a no-op, which is the point: one key, computed the
 * same way, whichever side produced the string.
 */
export function canonicalRoute(raw: string): string {
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!;
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const s = segment.trim().toLowerCase();
      if (!s) return '';
      if (/^\[\[?\.\.\..+\]\]?$/.test(s) || s === '*' || s === '**') return '*';
      if (/^\[.+\]$/.test(s) || /^\{.+\}$/.test(s) || /^[:$].+/.test(s)) return ':param';
      return s;
    })
    .filter(Boolean);

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Does this test route land on this crawled route?
 *
 * Strict on length, unlike impact.ts's `routesOverlap`, and the difference is
 * deliberate rather than an oversight. Impact asks "could this change have
 * broken that test?", where over-matching costs a minute of CI, so it treats
 * /checkout as touching /checkout/success. Coverage asks "does any test go
 * here?", where over-matching costs a route that is silently declared covered
 * because a test visited its parent. A test that navigates to /checkout has NOT
 * been to /checkout/success, and saying otherwise is the one lie this module
 * must not tell. The near-miss is not thrown away — it comes back as adjacency,
 * which downgrades the gap's confidence instead of erasing it.
 */
export function routeVisits(testRoute: string, crawledRoute: string): boolean {
  const a = testRoute.split('/').filter(Boolean);
  const b = crawledRoute.split('/').filter(Boolean);

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    // `*` swallows the remainder on either side: /docs/* and /docs/a/b are one place.
    if (left === '*' || right === '*') return true;
    if (left === undefined || right === undefined) return false;
    if (left === right) continue;
    if (left === ':param' || right === ':param') continue;
    return false;
  }
  return true;
}

// ─── The crawl, read defensively ─────────────────────────────────────────────

interface CrawlNode {
  id: string;
  route: string;
  title: string;
  behindAuth: boolean;
  /**
   * Roles the crawler recorded as required to see this state (FlowNode
   * `requiresRoles`). The best evidence there is for WHICH role a test behind
   * this wall must assume — it is the application's own word on the matter,
   * not an inference from a URL.
   */
  requiresRoles: string[];
  forms: FormSummary[];
  /** Kept in the shape `locatorsFromFlowMap` wants, so it can be reused verbatim. */
  affordances: Array<{ label: string; selector: Selector; kind: 'link' | 'button' | 'input' }>;
  inbound: number;
  outbound: number;
  /** Actions the crawler used to arrive here. */
  entryActions: string[];
}

interface CrawlEdge {
  id: string;
  from: string;
  to: string;
  action: string;
}

interface CrawlJourney {
  id: string;
  name: string;
  description: string;
  priority: Priority;
  edgeIds: string[];
}

/**
 * One URL a rule refused, as this module reads it back off the stored map.
 *
 * A narrowing of `ExcludedPath` and not a second shape: `discoveredFrom` is the
 * only member it drops, because the gap report names the surface rather than the
 * page that linked to it. Everything that decides the CLASS — kind and rule —
 * is carried verbatim.
 */
export interface CrawlExclusion {
  url: string;
  /** Canonical route, when one could be derived. Null when the URL had none. */
  route: string | null;
  kind: ExclusionKind;
  rule: string;
}

interface CrawlModel {
  ok: boolean;
  version: number | null;
  baseUrl: string | null;
  truncatedReason: string | null;
  nodes: CrawlNode[];
  edges: CrawlEdge[];
  journeys: CrawlJourney[];
  features: Array<{ name: string; nodeIds: string[] }>;
  /**
   * Every refusal the crawl recorded, or NULL when it recorded none because it
   * could not.
   *
   * THE NULL IS NOT AN EMPTY LIST. `FlowMap.excluded` is optional and every
   * crawl written before the exclusion ledger existed has no such key. Absent
   * means "this crawl did not account for refusals"; `[]` means "it did, and
   * refused nothing". Reading the first as the second would report a clean bill
   * of health about destructive flows to every install with a map older than
   * this slice — which is the exact shape of lie this field exists to end.
   */
  excluded: CrawlExclusion[] | null;
  /** Refusals folded away because another refusal already named the route. */
  exclusionsDeduped: number;
  /** Refusals dropped by MAX_EXCLUSIONS. A floor on what was not read. */
  exclusionsDiscarded: number;
  unreadable: string[];
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asPriority(value: unknown): Priority {
  return value === 'CRITICAL_PATH' || value === 'IMPORTANT' || value === 'NICE_TO_HAVE'
    ? value
    : 'IMPORTANT';
}

function readSelector(value: unknown): Selector | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as { strategy?: unknown; value?: unknown; name?: unknown; nth?: unknown; confidence?: unknown };
  if (typeof s.strategy !== 'string' || typeof s.value !== 'string') return null;
  return {
    strategy: s.strategy as Selector['strategy'],
    value: s.value,
    ...(typeof s.name === 'string' ? { name: s.name } : {}),
    ...(typeof s.nth === 'number' ? { nth: s.nth } : {}),
    confidence: typeof s.confidence === 'number' ? s.confidence : 0.5,
  };
}

/*
 * ─── Reading a constraint out of stored Json, in three states ────────────────
 *
 * Each of these returns `undefined` for "the stored field is not there, or is
 * of a type we cannot use", `null` for "it is explicitly null", and the value
 * otherwise. The caller spreads the result conditionally, so an `undefined`
 * never lands on the summary at all — which is what keeps "this crawl predates
 * the capture" distinguishable from "the page declares nothing".
 *
 * Getting that wrong in the lenient direction (defaulting to null) is the
 * mistake worth guarding: it makes every old FlowMap claim the application
 * declares no limits anywhere, and `boundaries.ts` then prints that claim in
 * the justification of every case it emits.
 */
function optNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  // Non-finite is not a constraint. `maxLength: NaN` reaching `exactLength`
  // produces a string of NaN length, i.e. nothing usable.
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function optBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readForms(value: unknown, unreadable: string[], where: string): FormSummary[] {
  if (!Array.isArray(value)) return [];
  const out: FormSummary[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      unreadable.push(`a form on ${where} was not an object and was skipped`);
      continue;
    }
    const f = raw as { name?: unknown; fields?: unknown; submit?: unknown };
    const submit = readSelector(f.submit);
    const fields: FormSummary['fields'] = [];
    if (Array.isArray(f.fields)) {
      for (const rawField of f.fields) {
        if (!rawField || typeof rawField !== 'object') continue;
        const x = rawField as Record<string, unknown>;
        const label = str(x.label) || str(x.name);
        if (!label) continue;
        /*
         * The label is the fallback for the NAME, not the other way round.
         *
         * `expandBoundaries` writes one entry per field into a `values` record
         * keyed on `name`, so an empty name would make two fields collide on
         * the '' key and every case for the second one would silently perturb
         * the first. A crawl that captured a label and no name is a real
         * (old-shape) input, so the label stands in: it is at least unique
         * among the fields of one form, which is all the key has to be.
         */
        const name = str(x.name) || label;
        const maxLength = optNumber(x.maxLength);
        const minLength = optNumber(x.minLength);
        const min = optString(x.min);
        const max = optString(x.max);
        const step = optString(x.step);
        const pattern = optString(x.pattern);
        const inputMode = optString(x.inputMode);
        const autocomplete = optString(x.autocomplete);
        const accept = optString(x.accept);
        const multiple = optBool(x.multiple);
        const validationMessage = optString(x.validationMessage);
        const options = Array.isArray(x.options)
          ? x.options.filter((o): o is string => typeof o === 'string')
          : undefined;
        fields.push({
          label,
          required: x.required === true,
          semantic: str(x.semantic, 'unknown'),
          name,
          // 'text' rather than '' so `isTextual` reads an uncaptured control as
          // free text: a field whose type nobody recorded is far more often an
          // <input> than a <select>, and treating it as text offers the length
          // and injection classes rather than silently withholding them.
          inputType: str(x.inputType, 'text') || 'text',
          ...(options && options.length > 0 ? { options } : {}),
          ...(maxLength !== undefined ? { maxLength } : {}),
          ...(minLength !== undefined ? { minLength } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(step !== undefined ? { step } : {}),
          ...(pattern !== undefined ? { pattern } : {}),
          ...(inputMode !== undefined ? { inputMode } : {}),
          ...(autocomplete !== undefined ? { autocomplete } : {}),
          ...(accept !== undefined ? { accept } : {}),
          ...(multiple !== undefined ? { multiple } : {}),
          ...(validationMessage !== undefined ? { validationMessage } : {}),
        });
      }
    }
    out.push({
      name: str(f.name, 'form'),
      submitLabel: submit ? (submit.name ?? submit.value) : null,
      fields,
    });
  }
  return out;
}

/**
 * Turn the Json column into something this module can reason about, surviving
 * anything. A crawl written by a version of the Explorer that predates a field
 * must degrade to "we know less", never to a 500 — the whole feature is a
 * report, and a report that refuses to render because one node is odd has
 * failed at its only job.
 */
export function readCrawl(graph: unknown): CrawlModel {
  const unreadable: string[] = [];
  const empty: CrawlModel = {
    ok: false,
    version: null,
    baseUrl: null,
    truncatedReason: null,
    nodes: [],
    edges: [],
    journeys: [],
    features: [],
    // Null and not []: an unreadable graph told us nothing about refusals
    // either, and `[]` here would be the one place this function invents a
    // finding instead of degrading to "we know less".
    excluded: null,
    exclusionsDeduped: 0,
    exclusionsDiscarded: 0,
    unreadable,
  };

  if (!graph || typeof graph !== 'object') return empty;
  const g = graph as Record<string, unknown>;
  if (!Array.isArray(g.nodes)) {
    unreadable.push('the flow map has no `nodes` array, so nothing about the app could be read');
    return empty;
  }

  const nodes: CrawlNode[] = [];
  const byId = new Map<string, CrawlNode>();
  let skippedNodes = 0;

  for (const raw of g.nodes.slice(0, MAX_NODES)) {
    if (!raw || typeof raw !== 'object') {
      skippedNodes += 1;
      continue;
    }
    const n = raw as Record<string, unknown>;
    const id = str(n.id);
    if (!id) {
      skippedNodes += 1;
      continue;
    }

    let route: string | null = null;
    if (typeof n.route === 'string' && n.route.startsWith('/')) route = canonicalRoute(n.route);
    else if (typeof n.url === 'string') {
      try {
        route = canonicalRoute(new URL(n.url).pathname);
      } catch {
        route = null;
      }
    }
    if (!route) {
      skippedNodes += 1;
      continue;
    }

    const affordances: CrawlNode['affordances'] = [];
    if (Array.isArray(n.affordances)) {
      for (const rawA of n.affordances) {
        if (!rawA || typeof rawA !== 'object') continue;
        const a = rawA as { label?: unknown; selector?: unknown; kind?: unknown };
        const selector = readSelector(a.selector);
        const label = str(a.label);
        if (!selector || !label) continue;
        const kind = a.kind === 'button' || a.kind === 'input' ? a.kind : 'link';
        affordances.push({ label, selector, kind });
      }
    }

    const node: CrawlNode = {
      id,
      route,
      title: str(n.title, route),
      behindAuth: n.behindAuth === true,
      requiresRoles: Array.isArray(n.requiresRoles)
        ? n.requiresRoles.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
        : [],
      forms: readForms(n.forms, unreadable, route),
      affordances,
      inbound: 0,
      outbound: 0,
      entryActions: [],
    };
    nodes.push(node);
    // First sighting wins: several states can share a route (cart-empty vs
    // cart-full) and the gap is about the route, not the state.
    if (!byId.has(id)) byId.set(id, node);
  }

  if (skippedNodes > 0) {
    unreadable.push(
      `${skippedNodes} crawled state(s) had no id or no readable route and could not be checked for coverage`,
    );
  }
  if (Array.isArray(g.nodes) && g.nodes.length > MAX_NODES) {
    unreadable.push(
      `the crawl holds ${g.nodes.length} states; only the first ${MAX_NODES} were analysed`,
    );
  }

  const edges: CrawlEdge[] = [];
  if (Array.isArray(g.edges)) {
    for (const raw of g.edges) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const id = str(e.id);
      const from = str(e.from);
      const to = str(e.to);
      if (!id || !from || !to) continue;
      const edge: CrawlEdge = { id, from, to, action: str(e.action, 'navigate') };
      edges.push(edge);

      const target = byId.get(to);
      const source = byId.get(from);
      // Self-loops are not traffic; a page linking to itself says nothing about
      // how many ways in there are, and counting it inflates every nav bar.
      if (target && from !== to) {
        target.inbound += 1;
        if (target.entryActions.length < 8) target.entryActions.push(edge.action);
      }
      if (source && from !== to) source.outbound += 1;
    }
  }

  const journeys: CrawlJourney[] = [];
  if (Array.isArray(g.journeys)) {
    for (const raw of g.journeys) {
      if (!raw || typeof raw !== 'object') continue;
      const j = raw as Record<string, unknown>;
      const id = str(j.id);
      if (!id || !Array.isArray(j.edgeIds)) continue;
      journeys.push({
        id,
        name: str(j.name, id),
        description: str(j.description),
        priority: asPriority(j.priority),
        edgeIds: j.edgeIds.filter((x): x is string => typeof x === 'string'),
      });
    }
  }

  const features: Array<{ name: string; nodeIds: string[] }> = [];
  if (Array.isArray(g.features)) {
    for (const raw of g.features) {
      if (!raw || typeof raw !== 'object') continue;
      const f = raw as { name?: unknown; nodeIds?: unknown };
      if (typeof f.name !== 'string' || !Array.isArray(f.nodeIds)) continue;
      features.push({
        name: f.name,
        nodeIds: f.nodeIds.filter((x): x is string => typeof x === 'string'),
      });
    }
  }

  /*
   * The refusal ledger.
   *
   * Deduped by ROUTE, because `/logout` linked from fifty pages is one refused
   * surface and fifty rows would be fifty findings for one fact — the same
   * argument frontier.ts makes where it writes the ledger. The count of what
   * was folded away is kept, so the dedupe is a disclosed step rather than a
   * silent one, and the cap's cost is a separate number because a cap and a
   * dedupe are not the same event.
   *
   * An entry with no readable route is NOT dropped: it is keyed on its URL
   * instead, so a refusal we could not normalise is still one refusal.
   */
  let excluded: CrawlExclusion[] | null = null;
  let exclusionsDeduped = 0;
  let exclusionsDiscarded = 0;
  if (Array.isArray(g.excluded)) {
    const byRoute = new Map<string, CrawlExclusion>();
    let read = 0;
    for (const raw of g.excluded) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const kind = str(e.kind);
      if (!EXCLUSION_KINDS.includes(kind as ExclusionKind)) {
        // An unrecognised kind is drift between a stored map and this build,
        // not a refusal we may classify. Named, never guessed at.
        unreadable.push(
          `an excluded URL records the refusal kind "${kind || '(none)'}", which this build does not know, so it could not be classified`,
        );
        continue;
      }
      let route: string | null = null;
      if (typeof e.route === 'string' && e.route.startsWith('/')) route = canonicalRoute(e.route);
      else if (typeof e.url === 'string') {
        try {
          route = canonicalRoute(new URL(e.url).pathname);
        } catch {
          route = null;
        }
      }
      const url = str(e.url, route ?? '');
      const key = `${kind}\u0000${route ?? url}`;
      if (byRoute.has(key)) {
        exclusionsDeduped += 1;
        continue;
      }
      if (read >= MAX_EXCLUSIONS) {
        exclusionsDiscarded += 1;
        continue;
      }
      read += 1;
      byRoute.set(key, {
        url,
        route,
        kind: kind as ExclusionKind,
        // Never defaulted to ''. A refusal whose rule the map did not record is
        // a refusal nobody can look up, and saying so is the honest value.
        rule: str(e.rule, 'the crawl recorded no rule for this refusal'),
      });
    }
    excluded = [...byRoute.values()];
  }

  return {
    ok: nodes.length > 0,
    version: typeof g.version === 'number' ? g.version : null,
    baseUrl: typeof g.baseUrl === 'string' ? g.baseUrl : null,
    truncatedReason: typeof g.truncatedReason === 'string' ? g.truncatedReason : null,
    nodes,
    edges,
    journeys,
    features,
    excluded,
    exclusionsDeduped,
    exclusionsDiscarded,
    unreadable,
  };
}

// ─── What a test says about itself ───────────────────────────────────────────

/**
 * Navigation calls whose destination is not a literal.
 *
 * `page.goto(url)`, `cy.visit(path)`, and `` page.goto(`${base}/orders`) `` all
 * go somewhere real that no amount of string scanning will reveal. This is the
 * single most important detector in the file: without it, a project whose
 * helpers do the navigating would be told every one of its routes is untested.
 */
const NAV_CALL = /\b(?:goto|visit|navigate|navigateTo)\s*\(\s*([^)]{0,120})/g;

/**
 * Sign-in evidence. A route behind auth is only *reached* by a test that gets in.
 *
 * Every pattern here is an ACTION or an injected session, never a bare word.
 * The distinction is the whole point: `await expect(page).toHaveURL(/login/)`
 * is a test asserting it got BOUNCED, and reading the word "login" in it as
 * proof of authentication would close the exact gap that assertion proves
 * exists — the admin page tested only from outside the door.
 */
const AUTH_SIGNAL: RegExp[] = [
  /\b(storagestate|addcookies|addinitscript|setextrahttpheaders|authprofile)\b|auth\.setup/,
  /\b(authorization|bearer\s|accesstoken|access_token|gettoken|apikey|api_key|sessiontoken)\b/,
  /\b(signin|sign_in|login|log_in|logon|loginas|signinas|authenticate|authenticateas)\s*\(/,
  /\bpassword\b[\s\S]{0,120}\.(?:fill|type|sendkeys)\s*\(/,
  /\.(?:fill|type|sendkeys)\s*\([\s\S]{0,60}\bpassword\b/,
];

/**
 * Failure-path evidence, split by how much it proves.
 *
 * STRONG markers are things you only write when you are testing a failure: an
 * error status asserted on a response, an alert role, the words "invalid" or
 * "rejected". WEAK markers (`.not.`, `toBeDisabled`, "empty") show up in happy
 * paths too — a checkout test asserting the error banner is *not* visible is a
 * happy path. So one strong marker counts and it takes two weak ones, which is
 * the least dishonest line to draw over a keyword scan of somebody else's prose.
 *
 * The status-code markers are deliberately anchored to an assertion or a
 * `status` word rather than matching bare numbers. `waitForTimeout(500)` is not
 * a test of a 500, and reading it as one would silently suppress a real gap —
 * the one direction this detector must not fail in.
 */
const NEGATIVE_STRONG: RegExp[] = [
  /\b(invalid|incorrect|wrong|malformed|rejects?|rejected|declines?|declined|denied|forbidden|unauthori[sz]ed|unauthenticated|expired|duplicate|conflict|insufficient|unhappy)\b/,
  /\b(should\s+not|shouldn'?t|must\s+not|cannot|can'?t|fails?|failure|negative\s+case|sad\s+path)\b/,
  /\b(out[-\s]of[-\s]stock|required\s+field|validation\s+error|error\s+message|error\s+state)\b/,
  /(?:status|statuscode|statustext)\W{0,14}(?:400|401|403|404|405|409|410|422|429|500|502|503)\b/,
  /\b(?:tobe|toequal|tohavestatus)\s*\(\s*(?:400|401|403|404|405|409|410|422|429|500|502|503)\s*\)/,
  /getbyrole\(\s*['"`]alert['"`]/,
  /\btoberejected\b|\brejects\./,
];
const NEGATIVE_WEAK =
  /\.not\.|tobedisabled|tohaveattribute\(\s*['"`]aria-invalid|\bempty\b|\bmissing\b|\bboundary\b|edge\s+case|\btimeout\b/g;

interface TestFacts {
  input: CoverageTestInput;
  /** Canonical routes this test declares. */
  routes: string[];
  /** Lowercased code, capped. The haystack for every mention check. */
  haystack: string;
  /**
   * Does this test reach the application AS SOMEBODY? True when it is bound to
   * an auth profile (the runner will inject that session) or when its source
   * carries a sign-in of its own. Deliberately NOT true for a test that merely
   * declares it needs a role: see `authBindingBroken`.
   */
  authenticated: boolean;
  /**
   * The test said it needs a role and has no profile bound — almost always a
   * profile deleted out from under it. It runs anonymously, so it is not
   * coverage of anything behind the wall, and the gap must say which test this
   * happened to rather than reporting "nothing reaches /admin" at a team that
   * wrote exactly that test.
   */
  authBindingBroken: boolean;
  negative: boolean;
  /** Non-null when this test's real coverage cannot be read. */
  unknown: CoverageUnknown | null;
}

function firstDynamicNavArgument(code: string): string | null {
  for (const match of code.matchAll(NAV_CALL)) {
    const arg = match[1]!.trim();
    if (!arg) continue;
    // A literal, or a template whose text starts before the first `${`.
    if (arg.startsWith("'") || arg.startsWith('"')) continue;
    if (arg.startsWith('`') && !arg.startsWith('`${')) continue;
    // A bare `(` is a nested call we cannot see through; everything else here is
    // an identifier, a member expression, or an interpolation-first template.
    return `${match[0].trim().slice(0, 80)}…`;
  }
  return null;
}

function indexTest(test: CoverageTestInput): TestFacts {
  const rawCode = test.code ?? '';
  const oversized = rawCode.length > MAX_CODE_CHARS;
  const code = oversized ? rawCode.slice(0, MAX_CODE_CHARS) : rawCode;
  const haystack = `${code}\n${test.name}\n${test.tags.join(' ')}`.toLowerCase();

  const routes = [...new Set(test.routes.map(canonicalRoute))];

  let unknown: CoverageUnknown | null = null;
  const dynamic = firstDynamicNavArgument(code);
  if (test.coverageTruncated) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason:
        'Part of what this test declares was past an internal extraction limit and never read, so what it covers is only partly known.',
      sample: null,
    };
  } else if (oversized) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason: `This test is ${rawCode.length} characters; only the first ${MAX_CODE_CHARS} were scanned, so it may navigate somewhere we did not see.`,
      sample: null,
    };
  } else if (dynamic) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason:
        'This test navigates to a URL built at runtime, so static extraction cannot say which pages it visits.',
      sample: dynamic,
    };
  } else if (routes.length === 0) {
    unknown = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      reason: code
        ? 'No route literal appears anywhere in this test — its navigation probably lives in an imported helper or page object.'
        : 'This test row has no code and declares no route, so nothing about its coverage is visible.',
      sample: null,
    };
  }

  /*
   * The binding first, the heuristic second.
   *
   * A test bound to an auth profile has no sign-in anywhere in its source — the
   * runner injects the profile's storageState before the first navigation — so
   * `signsIn` is false for exactly the tests that are most certainly
   * authenticated. Reading the column first is what stops this module
   * re-reporting an UNREACHED_AUTH_ROUTE gap that has already been closed by
   * the test it asked for, which was a loop with no exit: the gap generated a
   * test, the test could not be recognised as authenticated, the gap came back.
   */
  const bound = typeof test.authProfileId === 'string' && test.authProfileId !== '';
  const authBindingBroken = test.authProfileRequired === true && !bound;

  return {
    input: test,
    routes,
    haystack,
    authenticated: bound || signsIn(haystack),
    authBindingBroken,
    negative: assertsAFailure(haystack),
    unknown,
  };
}

/** Exported so the heuristics can be argued with in tests rather than only inline. */
export function signsIn(lowercasedHaystack: string): boolean {
  return AUTH_SIGNAL.some((re) => re.test(lowercasedHaystack));
}

/** `Admin Users`, `admin-users`, `ADMIN_USERS` → `admin users`. */
function roleWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * Which auth profile should a test for this page sign in as?
 *
 * NO MODEL. This file is not allowed one (see the header), and this decision in
 * particular must not need one: it is the difference between a generated test
 * that reaches the page and one that does not, and it has to work on the
 * first-run path of a project whose deployment has no API key.
 *
 * So it is four rules, strongest evidence first, and whichever fires is
 * reported in `why` so a human can disagree with it:
 *
 *   1. THE APPLICATION'S OWN WORD. The crawler recorded `requiresRoles` on the
 *      node. A profile whose name shares a word with a required role is the
 *      best answer available anywhere, because it is not an inference.
 *   2. THE ROUTE'S OWN WORD. `/admin/users` and a profile named "Admin" is a
 *      weaker version of the same argument — still a match on a word the
 *      customer chose twice, independently.
 *   3. ONLY ONE DOOR. One profile configured and a page behind a wall: there is
 *      nothing to choose between, and refusing to choose would leave the gap
 *      open for no reason a customer could act on.
 *   4. OTHERWISE, REFUSE. Several profiles, none of which matches anything,
 *      means guessing which colleague's account to run as. A wrong role does
 *      not fail loudly — it signs in successfully as the wrong person and
 *      asserts whatever that person can see — so the honest output is null plus
 *      the candidate list in the evidence, and the gap stays open until a human
 *      names one. Picking "the first" here would be the defect this whole
 *      change exists to remove, wearing a different hat.
 *
 * Ties inside a rule are broken by name, so the same crawl and the same
 * profiles always produce the same binding: a gap id is stable across
 * recomputation and the profile behind it has to be too.
 */
export function chooseAuthProfile(
  profiles: AuthProfileChoice[],
  subject: { route: string | null; title?: string; requiresRoles?: string[] },
): GapAuthProfile | null {
  if (profiles.length === 0) return null;
  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // 1. A declared role the application itself reported.
  const declared = (subject.requiresRoles ?? []).flatMap(roleWords);
  if (declared.length > 0) {
    for (const profile of sorted) {
      const words = roleWords(profile.name);
      const hit = declared.find((role) => words.includes(role));
      if (hit) {
        return {
          id: profile.id,
          name: profile.name,
          why: `${subject.route ?? 'this state'} declares it requires the role "${hit}", and the auth profile "${profile.name}" is named for it.`,
        };
      }
    }
  }

  // 2. A word the route and a profile name share.
  const routeWords = roleWords(subject.route ?? '');
  if (routeWords.length > 0) {
    for (const profile of sorted) {
      const words = roleWords(profile.name);
      const hit = routeWords.find((word) => words.includes(word));
      if (hit) {
        return {
          id: profile.id,
          name: profile.name,
          why: `The route ${subject.route} and the auth profile "${profile.name}" share the word "${hit}", so that profile is the one this page is for.`,
        };
      }
    }
  }

  // 3. One profile, nothing to choose between.
  const only = sorted[0];
  if (sorted.length === 1 && only) {
    return {
      id: only.id,
      name: only.name,
      why: `"${only.name}" is the only auth profile configured on this environment, so it is the only session a test can reach this page with.`,
    };
  }

  // 4. Refuse. The caller turns this into evidence naming the candidates.
  return null;
}

/**
 * One sentence for the evidence list of every gap behind an auth wall, saying
 * either which role the test will assume or why none could be named.
 *
 * This is the whole reason the "no profile" case is not silent. A gap that just
 * says "no authenticated test reaches /admin/users" invites a team to write
 * another test that cannot reach it either; a gap that says "there is no auth
 * profile on this environment, so no test can sign in" names the actual next
 * action.
 */
function authProfileEvidence(
  chosen: GapAuthProfile | null,
  available: AuthProfileChoice[],
  route: string | null,
): string {
  if (chosen) {
    return `A test for this will run as the auth profile "${chosen.name}". ${chosen.why}`;
  }
  if (available.length === 0) {
    return `This environment has NO auth profile configured, so nothing we generate can sign in: a test for ${route ?? 'this state'} could only assert that a signed-out visitor is refused, which is coverage of the wall and not of the page. Configure an auth profile on the environment and this gap becomes closable.`;
  }
  return `${available.length} auth profiles are configured (${available
    .map((profile) => `"${profile.name}"`)
    .join(
      ', ',
    )}) and nothing in ${route ?? 'this state'} or in the crawl says which role it belongs to. Picking one here would sign the test in as the wrong person and assert whatever that person can see, which fails silently — so name the profile on the plan item and this gap becomes closable.`;
}

export function assertsAFailure(lowercasedHaystack: string): boolean {
  if (NEGATIVE_STRONG.some((re) => re.test(lowercasedHaystack))) return true;
  const weak = [...lowercasedHaystack.matchAll(new RegExp(NEGATIVE_WEAK.source, 'g'))].length;
  return weak >= 2;
}

/** A mention is generous on purpose: see rule 2 in the file header. */
function mentions(facts: TestFacts, needle: string): boolean {
  const trimmed = needle.trim().toLowerCase();
  // Two characters matches everything; a claim built on it is not a claim.
  if (trimmed.length < 3) return false;
  return facts.haystack.includes(trimmed);
}

// ─── Blast radius ────────────────────────────────────────────────────────────

/**
 * Route words that say "money, access, or destruction". This is a heuristic and
 * is labelled as one in `scoreWhy` wherever it fires — the point of showing the
 * score's components is that a team whose money page is called /tarief can see
 * why we ranked it low and tell us so.
 */
const HIGH_VALUE =
  /\b(checkout|payment|pay|billing|invoice|subscribe|subscription|order|orders|cart|basket|purchase|refund|refunds|transfer|withdraw|deposit|payout|login|signin|signup|register|password|reset|account|admin|member|permission|role|users|delete|destroy|export|apikey|api-keys|token|security|2fa|mfa)\b/;
const LOW_VALUE =
  /\b(about|contact|help|faq|docs|doc|blog|news|press|careers|legal|privacy|terms|cookie|cookies|sitemap|changelog|styleguide|robots)\b/;

interface Score {
  reachability: number;
  blastRadius: number;
  score: number;
  why: string[];
}

const KIND_WEIGHT: Record<GapKind, number> = {
  UNVISITED_ROUTE: 1,
  UNREACHED_AUTH_ROUTE: 1,
  UNWALKED_JOURNEY: 0.95,
  UNSUBMITTED_FORM: 0.9,
  NO_NEGATIVE_CASE: 0.7,
  UNUSED_AFFORDANCE: 0.5,
  /*
   * Weighted ABOVE an unvisited route, which looks aggressive and is not.
   *
   * This is the only class whose members are selected FOR being destructive:
   * the crawl refused them because driving them ends a session or removes a
   * record. `HIGH_VALUE` already ranks `delete`, `destroy` and `account` at the
   * top of the blast-radius scale, so the weight is agreeing with the rest of
   * the table rather than overruling it.
   */
  UNEXERCISABLE_SURFACE: 1,
};

function scoreGap(
  kind: GapKind,
  node: CrawlNode | null,
  ctx: { maxInbound: number; maxOutbound: number; journeyPriority: Priority | null; text: string },
): Score {
  const why: string[] = [];

  // Reachability: how many distinct ways in the crawl found. That is the only
  // traffic proxy available without analytics, and it is a good one — a page you
  // can get to from the nav, the footer and a CTA is a page people are on.
  const inbound = node?.inbound ?? 0;
  const reachability = ctx.maxInbound > 0 ? Math.min(1, inbound / ctx.maxInbound) : 0;
  if (inbound > 0) {
    why.push(`the crawl reached it from ${inbound} place${inbound === 1 ? '' : 's'}`);
  } else if (node) {
    why.push('the crawl found no inbound link to it, so it is probably a deep or entry-only page');
  }

  const parts: number[] = [];

  if (ctx.journeyPriority) {
    const weight =
      ctx.journeyPriority === 'CRITICAL_PATH' ? 1 : ctx.journeyPriority === 'IMPORTANT' ? 0.6 : 0.25;
    parts.push(weight);
    why.push(`it sits on a ${ctx.journeyPriority} journey the Explorer already named`);
  }

  if (node?.forms.length) {
    parts.push(1);
    why.push(
      `it carries ${node.forms.length} form${node.forms.length === 1 ? '' : 's'}, so it changes state rather than just rendering`,
    );
  } else if (node) {
    parts.push(0.2);
  }

  if (node?.behindAuth) {
    parts.push(1);
    why.push('it is behind an auth wall, so what breaks there is privileged');
  }

  const outbound = node?.outbound ?? 0;
  if (ctx.maxOutbound > 0) {
    const hub = Math.min(1, outbound / ctx.maxOutbound);
    parts.push(hub);
    if (hub > 0.6) why.push(`it links onward to ${outbound} places, so it is a hub`);
  }

  const text = ctx.text.toLowerCase();
  if (HIGH_VALUE.test(text)) {
    parts.push(1);
    why.push('its name contains a revenue, access, or destructive word (a heuristic)');
  } else if (LOW_VALUE.test(text)) {
    parts.push(0);
    why.push('its name reads like informational content (a heuristic)');
  } else {
    parts.push(0.35);
  }

  const blastRadius = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 0.35;
  const score = Math.round(100 * KIND_WEIGHT[kind] * (0.45 * reachability + 0.55 * blastRadius));

  return { reachability: round2(reachability), blastRadius: round2(blastRadius), score, why };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Gap identity ────────────────────────────────────────────────────────────

/**
 * Stable across recomputation for the same subject, so a client can hold a gap
 * id across the round trip to POST /propose. Deliberately NOT derived from the
 * evidence or the score: those move as tests are added, and a human ticking
 * "write this test" means the subject, not the sentence we happened to print.
 */
function gapId(kind: GapKind, ...parts: string[]): string {
  // NUL-separated: it cannot occur in a route, a form name, or a locator, so
  // gapId('X', 'a b') and gapId('X', 'a', 'b') can never collide onto one id.
  const digest = createHash('sha256').update([kind, ...parts].join('\u0000')).digest('hex');
  return `gap_${digest.slice(0, 16)}`;
}

// ─── The negative half, expanded ─────────────────────────────────────────────

/**
 * How many boundary cases one NO_NEGATIVE_CASE gap becomes.
 *
 * THE DEFECT: the register's entry reads "one whole feature becomes ONE
 * negative item, built from the FIRST required field". The obvious overcorrection
 * is just as bad in the other direction — a twelve-field form expands to forty
 * ranked cases, and forty plan items from one gap is a review queue nobody
 * clears, so the whole gap gets dismissed and the coverage goes away again.
 *
 * Twelve, because of three bounds that happen to agree:
 *
 *   1. `planItemSchema` allows at most 20 assertions, and each case's assertion
 *      is what makes it a test rather than a row of data. Twelve cases plus the
 *      fixed assertions (the one-invalid-field rule, the stored-state check,
 *      and the cap disclosure) sits under that ceiling with headroom, so the
 *      `.slice(0, 20)` at the end of `planItemForGap` can never be the thing
 *      that silently eats a case.
 *   2. A reviewer approves or rejects the item as a whole, which means they have
 *      to read it as a whole. Twelve rows is a table; forty is a wall.
 *   3. The cases are RANKED (see `RANKING` in boundaries.ts), so the twelve kept
 *      are the twelve most likely to find a real bug, and the fact that any
 *      were cut is reported rather than implied — a capped list presented as a
 *      complete one is the dishonesty this product sells against.
 *
 * It is a judgement, not a measurement, and it is a constant so a caller that
 * disagrees has one number to argue with.
 */
export const MAX_BOUNDARY_CASES_PER_GAP = 12;

/**
 * Forms expanded per gap, and fields expanded per form. Bounds on work, not
 * judgements about value — and like every other cap in this file, each one is
 * reported in `dropped` when it bites.
 *
 * A feature group can span many crawled states, each carrying forms, and a form
 * read off a real admin page can have sixty fields. The expansion builds one
 * case per class per field and a complete `values` record for each, so the
 * product of those two numbers is the work; capping both keeps a coverage
 * report bounded on a crawl nobody has seen.
 */
const MAX_BOUNDARY_FORMS_PER_GAP = 3;
const MAX_BOUNDARY_FIELDS_PER_FORM = 25;

/*
 * The vocabulary is narrowed against the shared constant rather than a copy of
 * it. `FormSummary.semantic` is a plain `string` because it comes out of a Json
 * column that an older crawler wrote, and `expandBoundaries` switches on the
 * union — a stray value would fall through its cases silently, which is how a
 * card field gets tested as free text.
 */
const SEMANTIC_NAMES: ReadonlySet<string> = new Set<string>(FORM_FIELD_SEMANTICS);

function asSemantic(raw: string): FormFieldSemantic {
  return SEMANTIC_NAMES.has(raw) ? (raw as FormFieldSemantic) : 'unknown';
}

/** A gap's field summary, in the shape the expansion reads. No locator is invented. */
function asBoundaryField(field: FormFieldSummary): BoundaryField {
  const { label, required, semantic, name, inputType, ...constraints } = field;
  return {
    name,
    label,
    inputType,
    required,
    semantic: asSemantic(semantic),
    // Spread LAST and unmodified: every constraint keeps its three states, so a
    // key absent here stays absent, which is what `nothingDeclared` in
    // boundaries.ts reads to decide whether "the page declares none" is a
    // sentence it is entitled to write.
    ...constraints,
  };
}

export interface NegativeExpansion {
  /** Ranked, capped at `MAX_BOUNDARY_CASES_PER_GAP`, positive controls first. */
  cases: BoundaryCase[];
  /** Every cap, every class that did not apply, every combination refused. */
  dropped: BoundaryExpansion['dropped'];
  /** Anything that makes the valid submission these cases perturb untrustworthy. */
  caveats: string[];
  /** Before the gap-level cap. The honest denominator. */
  totalCases: number;
  /** Distinct fields reached, and distinct equivalence classes represented. */
  fields: number;
  classes: number;
}

/**
 * Expand the forms on a gap into ranked boundary cases.
 *
 * Deterministic and model-free, which is not a nicety here: this is the
 * no-key first-run path. The seed is the GAP ID — already a stable hash of the
 * subject — so the same crawl gives the same values for ever, a gap that
 * travels out through GET /coverage and back in through POST /propose expands
 * to exactly the same table on both sides, and `planItemForGap` can re-derive
 * it from the subject alone without having to carry a dozen fat case records
 * through a client round trip.
 */
export function expandNegativeCases(seed: string, forms: FormSummary[]): NegativeExpansion {
  const all: BoundaryCase[] = [];
  const dropped: BoundaryExpansion['dropped'] = [];
  const caveats: string[] = [];

  /*
   * The same form on several pages is ONE form.
   *
   * A feature group is a set of crawled states, and a dynamic route is crawled
   * once per real URL — five product pages carry five copies of one "Add to
   * cart" form. Expanding each copy would fill the twelve-case table with the
   * same case five times over, which reads as thoroughness and covers one
   * field. Keyed on name plus field names, the same key the cockpit's form list
   * already de-duplicates on.
   */
  const seenForms = new Set<string>();
  const unique: FormSummary[] = [];
  for (const form of forms) {
    const key = `${form.name}|${form.fields.map((f) => f.name).join(',')}`;
    if (seenForms.has(key)) continue;
    seenForms.add(key);
    unique.push(form);
  }
  if (unique.length < forms.length) {
    dropped.push({
      what: `${forms.length - unique.length} duplicate copies of these forms`,
      why: 'The crawl met the same form on more than one page of this feature. They are one form, so they are expanded once — the copies would have produced identical cases.',
      count: forms.length - unique.length,
    });
  }

  const expanded = unique.slice(0, MAX_BOUNDARY_FORMS_PER_GAP);
  if (unique.length > expanded.length) {
    dropped.push({
      what: `${unique.length - expanded.length} further form(s) on this feature`,
      why: `Only the first ${MAX_BOUNDARY_FORMS_PER_GAP} distinct forms are expanded, to bound the work on a feature that spans many pages. They are listed in the gap's subject and each deserves its own item.`,
      count: unique.length - expanded.length,
    });
  }

  let fieldCount = 0;
  expanded.forEach((form, index) => {
    const fields = form.fields.slice(0, MAX_BOUNDARY_FIELDS_PER_FORM);
    if (form.fields.length > fields.length) {
      dropped.push({
        what: `${form.fields.length - fields.length} field(s) of "${form.name}"`,
        why: `Past the first ${MAX_BOUNDARY_FIELDS_PER_FORM} on one form. Not expanded, so nothing below says anything about them — raise the cap or split the form.`,
        count: form.fields.length - fields.length,
      });
    }
    fieldCount += fields.length;

    /*
     * `scope` narrows the value space below the seed, so two forms on one
     * feature cannot generate the same email and race on it — the exact defect
     * the synthetic factory's own `scope` note describes.
     */
    const scope = `${seed}/form-${index}`;
    const expansion = expandBoundaries(
      { id: scope, name: form.name, fields: fields.map(asBoundaryField) },
      { seed, scope },
    );
    all.push(...expansion.cases);
    dropped.push(...expansion.dropped);
    caveats.push(...expansion.caveats);
  });

  /*
   * THE POSITIVE CONTROL IS EXEMPT FROM THE CAP.
   *
   * `happy-path` is ranked 25 — near the bottom, because the suite almost
   * certainly covers it already — so a plain top-12 slice would cut it every
   * time. That would be the wrong twelve: without a positive control, every
   * negative case below is equally consistent with a form that refuses ALL
   * input, and a form that refuses everything has shipped more than once. So
   * the controls are kept first and the ranked negatives fill what is left.
   */
  const positive = all.filter((c) => c.field === null);
  const negative = all
    .filter((c) => c.field !== null)
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));

  const room = Math.max(0, MAX_BOUNDARY_CASES_PER_GAP - positive.length);

  /*
   * BREADTH BEFORE DEPTH: the slots buy equivalence CLASSES first, and a second
   * case for an already-covered class only once every class has one.
   *
   * Measured on a six-field checkout form with a plain top-12-by-rank slice:
   * four of the eleven negative slots went to `injection-like` (one per text
   * field) and `unbounded-length` took two more, so the table carried no
   * off-by-one case at all — no `over-max`, no `under-min`, no
   * `step-misaligned` — on a form that declares min="1" max="10" step="1". That
   * table is not a partition of the input space; it is one idea tested on four
   * fields, which is the same shape of mistake as the single-case item it
   * replaces, just further along.
   *
   * This is NOT a second weight on top of the ranking, and the distinction
   * matters because `rank()` in boundaries.ts deliberately refuses to multiply
   * judgements together. The rank still decides which classes make the cut and
   * which field represents a class. All this decides is that the first eleven
   * slots go to eleven different questions rather than to the same question
   * eleven times.
   */
  const byClass = new Map<string, BoundaryCase[]>();
  for (const c of negative) {
    // `negative` is already rank-desc, so insertion order is class-rank order
    // and each list is rank-ordered within its class. Both fall out for free.
    const list = byClass.get(c.equivalenceClass);
    if (list) list.push(c);
    else byClass.set(c.equivalenceClass, [c]);
  }

  const keptNegative: BoundaryCase[] = [];
  for (let round = 0; keptNegative.length < room; round += 1) {
    let tookAny = false;
    for (const list of byClass.values()) {
      const pick = list[round];
      if (!pick) continue;
      keptNegative.push(pick);
      tookAny = true;
      if (keptNegative.length >= room) break;
    }
    if (!tookAny) break;
  }

  /*
   * The two halves of the cap are reported separately, because they mean
   * different things to the person reading them. A class with NO case in the
   * table is a question nobody asked; a second case for a class that is in the
   * table is the same question on another field, which is worth far less. A
   * single "22 cases were cut" line would let the first hide inside the second.
   */
  const keptIds = new Set(keptNegative.map((c) => c.id));
  const keptClasses = new Set(keptNegative.map((c) => c.equivalenceClass));
  const cutInUncoveredClasses = negative.filter((c) => !keptClasses.has(c.equivalenceClass));
  const cutInCoveredClasses = negative.filter(
    (c) => keptClasses.has(c.equivalenceClass) && !keptIds.has(c.id),
  );

  if (cutInCoveredClasses.length > 0) {
    dropped.unshift({
      what: `${cutInCoveredClasses.length} further case(s) in classes this table already covers`,
      why: `The same equivalence class on another field — ${[...new Set(cutInCoveredClasses.map((c) => `"${c.fieldLabel ?? c.field}" (${c.equivalenceClass})`))].slice(0, 6).join(', ')}. One representative per class is what makes a partition; the rest are worth running and are not worth a reviewer's attention here.`,
      count: cutInCoveredClasses.length,
    });
  }
  if (cutInUncoveredClasses.length > 0) {
    // Unshifted LAST so it prints FIRST: a reader skims the first line of a
    // list, and a class with no case at all is the omission that matters.
    const classes = [...new Set(cutInUncoveredClasses.map((c) => c.equivalenceClass))];
    dropped.unshift({
      what: `${classes.length} equivalence class(es) with NO case in this table: ${classes.join(', ')}`,
      why: `The table holds ${MAX_BOUNDARY_CASES_PER_GAP} cases and this form admits more classes than that. These are the lowest-ranked by boundaries.ts's RANKING, which is a judgement and not a measurement — if one of them is the bug you are afraid of, write it by hand.`,
      count: cutInUncoveredClasses.length,
    });
  }

  const cases = [...positive, ...keptNegative];
  return {
    cases,
    dropped,
    caveats,
    totalCases: all.length,
    fields: fieldCount,
    classes: new Set(cases.map((c) => c.equivalenceClass)).size,
  };
}

/**
 * One sentence naming what the expansion did NOT enumerate.
 *
 * Exists because a silent cap reads as "we covered everything", which is the
 * failure this whole module is a counterweight to. Bounded in length because it
 * lands in an `evidence` line and in a plan-item assertion, both of which are
 * read on a screen — so the biggest omissions come first (`dropped` is already
 * ordered cap-first) and the tail is counted rather than listed.
 */
function describeDropped(dropped: BoundaryExpansion['dropped'], maxEntries = 4): string {
  if (dropped.length === 0) return 'Every equivalence class these fields admit is represented.';
  const named = dropped.slice(0, maxEntries).map((d) => `${d.what} (${d.why})`);
  const rest = dropped.length - named.length;
  /*
   * The GROUPS are counted, not their members summed.
   *
   * `dropped` holds three kinds of thing — cases cut by the cap, two-field
   * combinations refused by design, and classes that did not apply to a field —
   * and adding their counts together produces one alarming number that means
   * nothing. On a six-field form the sum was 605, of which 528 were two-field
   * combinations nobody would ever generate. A number that cannot be acted on
   * is noise, and noise in a disclosure is how a disclosure gets skipped.
   */
  return `${dropped.length} group(s) of case(s), combination(s) and class(es) were deliberately not enumerated: ${named.join('; ')}${
    rest > 0 ? `; and ${rest} further group(s), each with its own reason, on the gap's expansion` : ''
  }.`;
}

/**
 * A value as a human should read it in a step.
 *
 * The raw value is sometimes a 10,000-character string, sometimes three spaces,
 * sometimes the empty string — all three of which print as nothing useful, and
 * the 10,000-character one would eat the 400-character clamp on the step and
 * take the rest of the sentence with it.
 */
function printableValue(value: string): string {
  if (value === '') return 'the empty string';
  if (value.trim() === '') return `${value.length} space(s) and nothing else`;
  if (value.length > 48) {
    return `a ${value.length}-character value beginning ${JSON.stringify(value.slice(0, 16))}`;
  }
  return JSON.stringify(value);
}

// ─── The analysis ────────────────────────────────────────────────────────────

export function analyzeCoverage(input: CoverageInput): CoverageReport {
  const crawl = readCrawl(input.flowMapGraph);
  const facts = input.tests.map(indexTest);
  const unknowns = facts.map((f) => f.unknown).filter((u): u is CoverageUnknown => u !== null);
  const caveats: string[] = [];

  const emptyTotals = {
    tests: input.tests.length,
    testsWithReadableRoutes: facts.filter((f) => f.routes.length > 0).length,
    routes: 0,
    routesVisited: 0,
    journeys: 0,
    journeysWalked: 0,
    forms: 0,
    formsExercised: 0,
    affordances: 0,
    affordancesUsed: 0,
    gaps: 0,
    gapsReturned: 0,
    // An unreadable map accounted for no refusals either. Null, not 0 — the
    // whole point of this pair of fields.
    unexercisableSurfaces: null,
    refusedSurfaces: null,
  };

  if (!crawl.ok) {
    // No map means no claim. "You have no tests for anything" would be true of a
    // project we have simply never looked at, and printing it would be a lie
    // dressed as a finding.
    return {
      crawled: false,
      flowMapVersion: crawl.version,
      baseUrl: crawl.baseUrl,
      gaps: [],
      unknowns,
      unreadable: crawl.unreadable,
      caveats: [
        'This project has no readable crawl, so there is nothing to compare the tests against. Run the Explorer and ask again — coverage gaps are the difference between what the crawler saw and what the suite asserts, and half of that is missing.',
      ],
      totals: emptyTotals,
      /*
       * `enumerated: null` and not `[]`.
       *
       * There is no enumeration here, so every target every test names is
       * un-enumerated — and reporting that as "your suite references 40
       * surfaces we never found" would be a finding about the customer made
       * entirely out of our own missing crawl. `reverseReconcile` answers
       * UNAVAILABLE for exactly this input.
       */
      reverse: reverseReconcile({ enumerated: null, tests: input.tests }),
      fingerprint: fingerprintOf(crawl.version, input.tests, []),
    };
  }

  if (crawl.truncatedReason) {
    caveats.push(
      `The crawl stopped early (${crawl.truncatedReason}), so this is coverage of what was SEEN, not of what exists. Routes the crawler never reached cannot appear as gaps.`,
    );
  }
  if (unknowns.length > 0) {
    caveats.push(
      `${unknowns.length} of ${input.tests.length} test(s) declare no route we can read statically — see \`unknowns\`. Any one of them could be covering a route listed below, so route gaps in this project are capped at MEDIUM confidence.`,
    );
  }
  if (input.tests.length === 0) {
    caveats.push('This project has no enabled tests, so every route the crawl found is a gap.');
  }

  const routeGapConfidence: Confidence = unknowns.length > 0 ? 'MEDIUM' : 'HIGH';

  /*
   * The roles available to a generated test. Not passing any is a legitimate
   * input and the common one on a first run, so this is `[]` rather than a
   * precondition — every auth gap then explains that it cannot be closed yet,
   * which is a true statement a customer can act on. What must not happen is a
   * generated test that signs in as nobody and reports the page as covered.
   */
  const authProfiles = input.authProfiles ?? [];

  // ── The route index ────────────────────────────────────────────────────────
  // Several crawled states can share a route. Coverage is a property of the
  // route, so they are folded together and the richest sighting wins.
  const byRoute = new Map<string, CrawlNode>();
  for (const node of crawl.nodes) {
    const existing = byRoute.get(node.route);
    if (!existing) {
      byRoute.set(node.route, { ...node });
      continue;
    }
    existing.inbound += node.inbound;
    existing.outbound += node.outbound;
    existing.behindAuth = existing.behindAuth || node.behindAuth;
    existing.requiresRoles = [...new Set([...existing.requiresRoles, ...node.requiresRoles])];
    existing.forms = [...existing.forms, ...node.forms];
    existing.affordances = [...existing.affordances, ...node.affordances];
    existing.entryActions = [...existing.entryActions, ...node.entryActions].slice(0, 8);
  }

  const routes = [...byRoute.values()];
  const maxInbound = Math.max(1, ...routes.map((n) => n.inbound));
  const maxOutbound = Math.max(1, ...routes.map((n) => n.outbound));

  const nodeById = new Map(crawl.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(crawl.edges.map((e) => [e.id, e]));

  /** Which routes the crawl links onward to — used for the adjacency downgrade. */
  const neighbours = new Map<string, Set<string>>();
  for (const edge of crawl.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || from.route === to.route) continue;
    if (!neighbours.has(from.route)) neighbours.set(from.route, new Set());
    neighbours.get(from.route)!.add(to.route);
  }

  /** Journeys, resolved to routes once so several detectors can share the work. */
  const journeyRoutes = new Map<string, string[]>();
  const journeySteps = new Map<string, string[]>();
  const routeJourneyPriority = new Map<string, Priority>();
  const PRIORITY_RANK: Record<Priority, number> = { NICE_TO_HAVE: 0, IMPORTANT: 1, CRITICAL_PATH: 2 };

  for (const journey of crawl.journeys) {
    const ordered: string[] = [];
    const steps: string[] = [];
    let broken = 0;
    for (const edgeId of journey.edgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) {
        broken += 1;
        continue;
      }
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (from && ordered[ordered.length - 1] !== from.route) ordered.push(from.route);
      steps.push(edge.action);
      if (to && ordered[ordered.length - 1] !== to.route) ordered.push(to.route);
    }
    if (broken > 0) {
      crawl.unreadable.push(
        `journey "${journey.name}" references ${broken} edge id(s) that are not in the graph; it was scored on the steps that do resolve`,
      );
    }
    journeyRoutes.set(journey.id, ordered);
    journeySteps.set(journey.id, steps);
    for (const route of ordered) {
      const current = routeJourneyPriority.get(route);
      if (!current || PRIORITY_RANK[journey.priority] > PRIORITY_RANK[current]) {
        routeJourneyPriority.set(route, journey.priority);
      }
    }
  }

  /** Which tests visit a given crawled route. */
  const visitorsOf = (route: string): TestFacts[] =>
    facts.filter((f) => f.routes.some((r) => routeVisits(r, route)));

  const gaps: CoverageGap[] = [];
  const visitedRoutes = new Set<string>();
  for (const node of routes) if (visitorsOf(node.route).length > 0) visitedRoutes.add(node.route);

  // ── 1 & 2. Routes nobody visits ────────────────────────────────────────────
  for (const node of routes) {
    if (visitedRoutes.has(node.route)) continue;

    // A test that reaches somewhere one click away is real information: it may
    // well walk on and never write the URL down. It does not close the gap, but
    // it is why this comes back MEDIUM instead of HIGH.
    const adjacentFrom = [...neighbours.entries()]
      .filter(([from, to]) => to.has(node.route) && visitedRoutes.has(from))
      .map(([from]) => from);
    const adjacentTests = adjacentFrom.flatMap((route) => visitorsOf(route));
    const relatedTestIds = [...new Set(adjacentTests.map((f) => f.input.id))].slice(
      0,
      MAX_EVIDENCE_TESTS,
    );

    const kind: GapKind = node.behindAuth ? 'UNREACHED_AUTH_ROUTE' : 'UNVISITED_ROUTE';
    const evidence: string[] = [];

    if (node.inbound > 0) {
      evidence.push(
        `The crawl reached ${node.route} from ${node.inbound} place${node.inbound === 1 ? '' : 's'} (${node.entryActions.slice(0, 3).join('; ') || 'navigation'}).`,
      );
    } else {
      evidence.push(`The crawl recorded ${node.route} ("${node.title}") as a state of the app.`);
    }
    evidence.push(
      input.tests.length === 0
        ? 'This project has no enabled tests at all.'
        : `No route literal in any of the ${input.tests.length} enabled tests resolves to it.`,
    );
    if (node.behindAuth) {
      evidence.push('The crawler hit an auth wall here, so this is a signed-in surface.');
    }
    if (adjacentFrom.length > 0) {
      evidence.push(
        `${relatedTestIds.length} test(s) do reach ${adjacentFrom.slice(0, 3).join(', ')}, which link(s) here — they may click through without writing the URL down.`,
      );
    }

    const scored = scoreGap(kind, node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(node.route) ?? null,
      text: `${node.route} ${node.title}`,
    });

    // Behind a wall: name the role the test will need, and say either how it
    // was chosen or that it could not be. Both sentences belong in the
    // evidence, because both change what the reader should do next.
    const chosen = node.behindAuth ? chooseAuthProfile(authProfiles, node) : null;
    if (node.behindAuth) evidence.push(authProfileEvidence(chosen, authProfiles, node.route));

    gaps.push({
      id: gapId(kind, node.route),
      kind,
      title: node.behindAuth
        ? `No authenticated test reaches ${node.route}`
        : `Nothing tests ${node.route}`,
      route: node.route,
      feature: featureOf(crawl, node) ?? null,
      evidence,
      confidence: adjacentFrom.length > 0 ? 'MEDIUM' : routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds,
      requiresAuth: node.behindAuth,
      authProfile: chosen,
      subject: {
        kind: 'route',
        route: node.route,
        title: node.title,
        behindAuth: node.behindAuth,
        forms: node.forms,
        entryActions: node.entryActions,
      },
    });
  }

  // ── 2b. Auth routes reached only by signed-out tests ───────────────────────
  // A test that navigates to /admin without ever signing in is almost certainly
  // asserting the redirect, not the page. That is a fine test to have and a
  // terrible one to mistake for coverage of what is behind the wall.
  for (const node of routes) {
    if (!node.behindAuth || !visitedRoutes.has(node.route)) continue;
    const visitors = visitorsOf(node.route);
    // `authenticated` is true for a test BOUND TO AN AUTH PROFILE as well as
    // one that signs in in its own source, and that is the line that closes the
    // loop: the test this gap asks for carries no sign-in text at all, because
    // the runner injects the session. Judging it by its code alone re-opened
    // the gap the moment it was closed.
    if (visitors.some((f) => f.authenticated)) continue;

    const scored = scoreGap('UNREACHED_AUTH_ROUTE', node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(node.route) ?? null,
      text: `${node.route} ${node.title}`,
    });

    /*
     * The one case where a visitor DID ask for a role: `authProfileRequired` is
     * set and the binding is gone, which the foreign key does on purpose when
     * the profile is deleted. The gap is real — that test is running anonymously
     * — but "nothing reaches /admin" is the wrong sentence to show a team that
     * wrote exactly the test being asked for. So it is named, with the fix.
     */
    const broken = visitors.filter((f) => f.authBindingBroken);
    const chosen = chooseAuthProfile(authProfiles, node);

    gaps.push({
      id: gapId('UNREACHED_AUTH_ROUTE', node.route, 'signed-out-only'),
      kind: 'UNREACHED_AUTH_ROUTE',
      title:
        broken.length > 0
          ? `${node.route} has a test that needs a role and has no auth profile bound`
          : `${node.route} is only ever tested signed out`,
      route: node.route,
      feature: featureOf(crawl, node) ?? null,
      evidence: [
        `The crawler hit an auth wall reaching ${node.route}, so the real page is behind a sign-in.`,
        `${visitors.length} test(s) navigate there — ${visitors
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => `"${f.input.name}"`)
          .join(', ')} — and none of them contains a sign-in step, a stored session, or an auth header.`,
        ...(broken.length > 0
          ? [
              `${broken
                .slice(0, MAX_EVIDENCE_TESTS)
                .map((f) => `"${f.input.name}"`)
                .join(
                  ', ',
                )} declare they need a signed-in session but have no auth profile bound — almost certainly a profile that was deleted. They are running anonymously and passing whatever a signed-out visitor can see, so re-bind them rather than writing another test.`,
            ]
          : []),
        'That is coverage of the redirect, not of what the page does once you are in.',
        authProfileEvidence(chosen, authProfiles, node.route),
      ],
      confidence: 'MEDIUM',
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: visitors.slice(0, MAX_EVIDENCE_TESTS).map((f) => f.input.id),
      requiresAuth: true,
      authProfile: chosen,
      subject: {
        kind: 'route',
        route: node.route,
        title: node.title,
        behindAuth: true,
        forms: node.forms,
        entryActions: node.entryActions,
      },
    });
  }

  // ── 3. Journeys nobody walks ───────────────────────────────────────────────
  let journeysWalked = 0;
  for (const journey of crawl.journeys) {
    const ordered = journeyRoutes.get(journey.id) ?? [];
    if (ordered.length === 0) continue;

    const walkers = facts.filter((f) =>
      ordered.every((route) => f.routes.some((r) => routeVisits(r, route))),
    );
    if (walkers.length > 0) {
      journeysWalked += 1;
      continue;
    }

    const perStep = ordered.map((route) => ({ route, tests: visitorsOf(route) }));
    const coveredSteps = perStep.filter((s) => s.tests.length > 0);
    const partialTestIds = [
      ...new Set(coveredSteps.flatMap((s) => s.tests.map((t) => t.input.id))),
    ].slice(0, MAX_EVIDENCE_TESTS);

    const anchor = ordered
      .map((route) => byRoute.get(route))
      .filter((n): n is CrawlNode => Boolean(n))
      .sort((a, b) => b.inbound - a.inbound)[0] ?? null;

    /*
     * A journey is walked as ONE session, so if any step of it is behind the
     * wall the whole walk needs a role — a test that signs in halfway through
     * is a different test from the journey the crawler recorded. The roles come
     * from every node on the path, because the strictest step is the one that
     * decides who can walk it.
     */
    const journeyNodes = ordered
      .map((route) => byRoute.get(route))
      .filter((n): n is CrawlNode => Boolean(n));
    const journeyBehindAuth = journeyNodes.some((n) => n.behindAuth);
    const journeyRoles = [...new Set(journeyNodes.flatMap((n) => n.requiresRoles))];

    const scored = scoreGap('UNWALKED_JOURNEY', anchor, {
      maxInbound,
      maxOutbound,
      journeyPriority: journey.priority,
      text: `${journey.name} ${journey.description} ${ordered.join(' ')}`,
    });

    gaps.push({
      id: gapId('UNWALKED_JOURNEY', journey.id),
      kind: 'UNWALKED_JOURNEY',
      title: `No single test walks "${journey.name}"`,
      route: ordered[0] ?? null,
      feature: anchor ? (featureOf(crawl, anchor) ?? null) : null,
      evidence: [
        `The crawl walked this end to end: ${ordered.join(' → ')}.`,
        coveredSteps.length === 0
          ? 'No test visits any step of it.'
          : `${coveredSteps.length} of ${ordered.length} steps are visited (${coveredSteps
              .map((s) => s.route)
              .slice(0, 4)
              .join(', ')}), but by ${partialTestIds.length} different test(s) — nobody walks the whole path, so the hand-offs between steps are unasserted.`,
        `The Explorer rated this journey ${journey.priority}.`,
        ...(journeyBehindAuth
          ? [
              authProfileEvidence(
                chooseAuthProfile(authProfiles, {
                  route: ordered[0] ?? null,
                  requiresRoles: journeyRoles,
                }),
                authProfiles,
                ordered[0] ?? null,
              ),
            ]
          : []),
      ],
      confidence: routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: partialTestIds,
      // A journey whose route set includes a page behind a wall cannot be
      // walked anonymously, so it needs a role like any other auth subject.
      // The anchor node carries the declared roles for the chooser.
      requiresAuth: journeyBehindAuth,
      authProfile: journeyBehindAuth
        ? chooseAuthProfile(authProfiles, {
            route: ordered[0] ?? null,
            requiresRoles: journeyRoles,
          })
        : null,
      subject: {
        kind: 'journey',
        journeyId: journey.id,
        name: journey.name,
        description: journey.description,
        priority: journey.priority,
        steps: journeySteps.get(journey.id) ?? [],
        routes: ordered,
      },
    });
  }

  // ── 4. Forms nobody submits ────────────────────────────────────────────────
  // Generous by design (rule 2): ANY test mentioning the submit label, or a
  // field name alongside a fill call, closes this. A form is the highest-value
  // thing to be wrong about, so we would rather miss a real gap than invent one.
  let totalForms = 0;
  let formsExercised = 0;
  for (const node of routes) {
    for (const form of node.forms) {
      totalForms += 1;
      const submitMentioned =
        form.submitLabel !== null && facts.some((f) => mentions(f, form.submitLabel!));
      const fieldMentioned = facts.some(
        (f) =>
          /\.(fill|type|selectOption|setInputFiles|check|press)\s*\(/.test(f.input.code ?? '') &&
          form.fields.some((field) => mentions(f, field.label)),
      );
      if (submitMentioned || fieldMentioned) {
        formsExercised += 1;
        continue;
      }

      const scored = scoreGap('UNSUBMITTED_FORM', node, {
        maxInbound,
        maxOutbound,
        journeyPriority: routeJourneyPriority.get(node.route) ?? null,
        text: `${node.route} ${node.title} ${form.name} ${form.fields.map((x) => x.label).join(' ')}`,
      });

      const fieldList = form.fields.map((x) => x.label).slice(0, 6);
      gaps.push({
        id: gapId('UNSUBMITTED_FORM', node.route, form.name),
        kind: 'UNSUBMITTED_FORM',
        title: `Nobody submits the "${form.name}" form on ${node.route}`,
        route: node.route,
        feature: featureOf(crawl, node) ?? null,
        evidence: [
          `The crawl found a form "${form.name}" on ${node.route} with ${form.fields.length} field(s)${fieldList.length ? `: ${fieldList.join(', ')}` : ''}.`,
          form.submitLabel
            ? `No test mentions its submit control ("${form.submitLabel}") or fills any of its fields.`
            : 'No test fills any of its fields, and the crawl captured no submit control to look for.',
          'A form is where the application accepts input, so this is untested write path, not untested rendering.',
        ],
        confidence: routeGapConfidence,
        reachability: scored.reachability,
        blastRadius: scored.blastRadius,
        score: scored.score,
        scoreWhy: scored.why,
        relatedTestIds: visitorsOf(node.route)
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => f.input.id),
        requiresAuth: node.behindAuth,
        authProfile: node.behindAuth ? chooseAuthProfile(authProfiles, node) : null,
        subject: { kind: 'form', route: node.route, form, behindAuth: node.behindAuth },
      });
    }
  }

  // ── 5. Affordances nobody uses ─────────────────────────────────────────────
  /*
   * ONE CONTROL IS ONE CONTROL ON ONE PAGE — AND THIS IS WHERE IT WAS NOT.
   *
   * This read `locatorsFromFlowMap`, which de-duplicates the whole application
   * by LOCATOR EXPRESSION. The comment that justified it was about a shared
   * "Log out" link, and for that case it is right. For the common case it was a
   * measurement error with a direction: `getByRole('button', { name: 'Save' })`
   * on /profile, /billing, /team, /notifications and /api-keys was ONE control,
   * and because the `used` check below is a substring scan over test source
   * with no route in it, ANY test mentioning "Save" marked all five exercised.
   * Five handlers, five payloads, five validations, one tick — a suite covering
   * a fifth of the application reporting every control in it used.
   *
   * So the universe is now `controlsFromFlowMap`, keyed per (page, locator),
   * and the usage check is route-aware: a test counts only if it mentions the
   * control AND goes to the page the control is on. `adjacency` is deliberately
   * NOT accepted here — a test one click away from /billing has not pressed
   * /billing's Save button, and `routeVisits`'s own header makes the same
   * argument for routes.
   *
   * The shared-nav case the old comment cared about is still handled, two ways:
   * `sharedWithRouteCount` carries the fact on every row so the evidence
   * sentence can say "the same control appears on 19 other pages", and the
   * MAX_AFFORDANCE_GAPS cap plus its caveat keeps the report readable. What is
   * gone is the identity having guessed on the customer's behalf.
   */
  const allControls = controlsFromFlowMap({
    nodes: routes.map((n) => ({ route: n.route, affordances: n.affordances })),
  });
  let affordancesUsed = 0;
  const affordanceGaps: CoverageGap[] = [];

  for (const locator of allControls) {
    const used = facts.some(
      (f) =>
        (mentions(f, locator.label) || mentions(f, locator.expression)) &&
        f.routes.some((route) => routeVisits(route, locator.route)),
    );
    if (used) {
      affordancesUsed += 1;
      continue;
    }
    // Links are left to the route gaps above: "nobody clicks this link" and
    // "nobody tests where it goes" are the same finding, and reporting both
    // doubles the noise for no new information.
    if (locator.kind === 'link') continue;

    const node = byRoute.get(locator.route) ?? null;
    const scored = scoreGap('UNUSED_AFFORDANCE', node, {
      maxInbound,
      maxOutbound,
      journeyPriority: routeJourneyPriority.get(locator.route) ?? null,
      text: `${locator.route} ${locator.label}`,
    });

    affordanceGaps.push({
      // Route first and expression second, which is what `controlIdentity`
      // keys on. It already was, which is why the five Saves produced five gap
      // IDS from one gap — the id was per page and the universe was not.
      id: gapId('UNUSED_AFFORDANCE', locator.route, locator.expression),
      kind: 'UNUSED_AFFORDANCE',
      title: `Nobody clicks "${locator.label}" on ${locator.route}`,
      route: locator.route,
      feature: node ? (featureOf(crawl, node) ?? null) : null,
      evidence: [
        `The crawl found a ${locator.kind} labelled "${locator.label}" on ${locator.route} (${locator.expression}, locator confidence ${locator.confidence.toFixed(2)}).`,
        `No test both reaches ${locator.route} and mentions that label or locator, across the ${input.tests.length} enabled tests.`,
        // The fact, not a verdict. QAAI cannot tell a shared header from five
        // independent buttons by looking at a selector, so it says how many
        // pages carry the same one and lets a human decide.
        ...(locator.sharedWithRouteCount > 0
          ? [
              `The same locator appears on ${locator.sharedWithRouteCount} other page${locator.sharedWithRouteCount === 1 ? '' : 's'}. If it is one shared control, one test closes all of them; if each page has its own handler, each needs its own.`,
            ]
          : []),
      ],
      confidence: routeGapConfidence,
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: visitorsOf(locator.route)
        .slice(0, MAX_EVIDENCE_TESTS)
        .map((f) => f.input.id),
      // The control lives on a page; if that page is behind the wall, so is the
      // control, and a test that cannot get to the page cannot click it.
      requiresAuth: node?.behindAuth === true,
      authProfile: node?.behindAuth === true ? chooseAuthProfile(authProfiles, node) : null,
      subject: {
        kind: 'affordance',
        route: locator.route,
        label: locator.label,
        expression: locator.expression,
        controlKind: locator.kind,
      },
    });
  }

  affordanceGaps.sort((a, b) => b.score - a.score);
  if (affordanceGaps.length > MAX_AFFORDANCE_GAPS) {
    caveats.push(
      `${affordanceGaps.length} controls are never mentioned by any test; the ${MAX_AFFORDANCE_GAPS} highest-scoring are listed. This usually means the suite is thin rather than that each button is separately worth a test.`,
    );
  }
  gaps.push(...affordanceGaps.slice(0, MAX_AFFORDANCE_GAPS));

  // ── 6. Features tested only on the happy path ──────────────────────────────
  // Scoped to features that can actually FAIL in an interesting way: something
  // with a form, or behind auth, or named like money. Demanding a negative case
  // for the marketing page is the kind of finding that gets a report ignored.
  for (const group of featureGroups(crawl, routes)) {
    const groupTests = [
      ...new Map(
        group.routes
          .flatMap((route) => visitorsOf(route))
          .map((f) => [f.input.id, f] as const),
      ).values(),
    ];
    if (groupTests.length === 0) continue; // that is a route gap, already reported
    if (groupTests.some((f) => f.negative)) continue;

    const groupNodes = group.routes
      .map((route) => byRoute.get(route))
      .filter((n): n is CrawlNode => Boolean(n));
    const forms = groupNodes.flatMap((n) => n.forms);
    const interesting =
      forms.length > 0 ||
      groupNodes.some((n) => n.behindAuth) ||
      HIGH_VALUE.test(`${group.name} ${group.routes.join(' ')}`.toLowerCase());
    if (!interesting) continue;

    const anchor = groupNodes.sort((a, b) => b.inbound - a.inbound)[0] ?? null;
    const scored = scoreGap('NO_NEGATIVE_CASE', anchor, {
      maxInbound,
      maxOutbound,
      journeyPriority: anchor ? (routeJourneyPriority.get(anchor.route) ?? null) : null,
      text: `${group.name} ${group.routes.join(' ')}`,
    });

    /*
     * THE EXPANSION, ON THE GAP ITSELF.
     *
     * The gap used to say "nobody tests this failing" and stop there, and the
     * proposal built from it then invented one case out of the first required
     * field. Running the expansion HERE means the gap can state what the
     * negative half actually consists of — how many cases, over how many
     * fields, in how many equivalence classes — and, more importantly, what it
     * leaves out. Same seed, same forms, so `planItemForGap` re-derives the
     * identical table without the cases having to ride through the client.
     */
    const id = gapId('NO_NEGATIVE_CASE', group.name, ...group.routes);
    const expansion = expandNegativeCases(id, forms);

    gaps.push({
      id,
      kind: 'NO_NEGATIVE_CASE',
      title: `"${group.name}" is only ever tested succeeding`,
      route: anchor?.route ?? group.routes[0] ?? null,
      feature: group.name,
      evidence: [
        `${groupTests.length} test(s) cover ${group.routes.slice(0, 4).join(', ')}: ${groupTests
          .slice(0, MAX_EVIDENCE_TESTS)
          .map((f) => `"${f.input.name}"`)
          .join(', ')}.`,
        'None of them names or asserts a failure — no error status, no validation message, no alert role, no rejected input.',
        forms.length > 0
          ? `This feature accepts input (${forms.length} form(s)), and input validation is only proven by the input that is refused.`
          : 'This feature is behind a permission boundary, and a boundary is only proven by the request that is denied.',
        ...(expansion.cases.length > 0
          ? [
              `Partitioning the input space of those field(s) gives ${expansion.totalCases} boundary case(s) over ${expansion.fields} field(s); the top ${expansion.cases.length} by rank, in ${expansion.classes} equivalence class(es), become this test's input table — one invalid field per case, every other field valid, so a failure names exactly one cause.`,
              `NOT enumerated: ${describeDropped(expansion.dropped)}`,
              ...expansion.caveats.slice(0, 2),
            ]
          : [
              'No form on this feature could be expanded into boundary cases, so the negative test proposed for it covers the permission or precondition rather than input validation.',
            ]),
        'The claim that nobody tests this failing is a keyword scan of test names and code, so it is the weakest claim in this report — check it before you act on it. The expansion above is not a claim about your suite; it is the list of cases a test would have to run.',
      ],
      confidence: 'LOW',
      reachability: scored.reachability,
      blastRadius: scored.blastRadius,
      score: scored.score,
      scoreWhy: scored.why,
      relatedTestIds: groupTests.slice(0, MAX_EVIDENCE_TESTS).map((f) => f.input.id),
      // A permission boundary IS the thing being tested here, and the denial
      // that proves it is asserted signed out. So the negative case needs a
      // role only when the feature's own pages are behind the wall AND the
      // failure being covered is a failure a signed-in user would hit.
      requiresAuth: false,
      authProfile: null,
      subject: {
        kind: 'negative',
        feature: group.name,
        routes: group.routes,
        forms,
        testIds: groupTests.map((f) => f.input.id),
      },
    });
  }

  // ── Rank and return ────────────────────────────────────────────────────────

  /*
   * Collapse gaps that are the same gap.
   *
   * A dynamic route is crawled once per real URL — five products all normalise
   * to `/products/:param` — and the per-node loops above emit one gap per NODE.
   * `gapId` keys on the logical identity (kind + route + subject), which is
   * correct, so those five arrive carrying ONE id between them.
   *
   * Measured on the seeded project: 24 gaps holding 21 distinct ids, with a
   * single "nobody submits POST /cart/add" occupying ranks 0-3. The top of the
   * differentiator's output was one finding printed four times, which is how a
   * reader decides the list is noise and stops reading.
   *
   * It also had a second-order cost. `/propose` looks gaps up by id, so a user
   * selecting the visible duplicates got a TestPlan with four identical items —
   * duplicate work generated from one fact.
   *
   * Merged rather than dropped: how many crawled pages carry the same untested
   * form is real information, so it is folded into the evidence instead of
   * being thrown away with the copies.
   */
  const byId = new Map<string, CoverageGap>();
  const copiesOf = new Map<string, number>();
  for (const gap of gaps) {
    copiesOf.set(gap.id, (copiesOf.get(gap.id) ?? 0) + 1);
    const existing = byId.get(gap.id);
    // Keep the highest-scoring copy: they are the same finding, and the best
    // ranking evidence among them is the honest one to rank it by.
    if (!existing || gap.score > existing.score) byId.set(gap.id, gap);
  }

  const deduped = [...byId.values()].map((gap) => {
    const pages = copiesOf.get(gap.id) ?? 1;
    if (pages < 2) return gap;
    return {
      ...gap,
      evidence: [
        ...gap.evidence,
        `The crawl found this on ${pages} pages that share the route ${gap.route}; they are one gap, not ${pages}.`,
      ],
    };
  });

  gaps.length = 0;
  gaps.push(...deduped);

  /*
   * Said once, at the top, as well as on each gap: a project with pages behind
   * a wall and no auth profile has a ceiling on its coverage that no amount of
   * test writing can lift, and that is a fact about the setup rather than about
   * any one gap. Only raised when it BITES — gaps that need a role and have
   * none — so it never nags a project whose whole surface is public.
   */
  const unclosableAuthGaps = gaps.filter((g) => g.requiresAuth && !g.authProfile).length;
  if (unclosableAuthGaps > 0) {
    caveats.push(
      authProfiles.length === 0
        ? `${unclosableAuthGaps} gap(s) are behind an auth wall and this environment has no auth profile configured, so no test we generate for them can sign in. They are reported, and they will stay open until a profile exists — a test written for them now would assert only that a signed-out visitor is refused.`
        : `${unclosableAuthGaps} gap(s) are behind an auth wall and none of the ${authProfiles.length} configured auth profile(s) could be matched to them from the crawl. Name the profile on the plan item before generating, or the test will cover the wall rather than the page.`,
    );
  }

  // ── 7. Surfaces the crawl refused to drive ─────────────────────────────────
  /*
   * The class that used to vanish. See `EXCLUSION_AS_EXERCISE` for the full
   * argument; the short version is that /logout, /delete-account and
   * /destroy-workspace are the highest-risk surfaces in an application and were
   * the one set guaranteed to be absent from the denominator rather than
   * uncovered. Absent raises the percentage; uncovered lowers it.
   *
   * THE REFUSED HALF IS NOT A GAP, and that is deliberate. A policy rule
   * excluded it, we did not look, and nothing is claimed about it in either
   * direction — so it is a counted caveat naming the rule rather than a finding
   * with an owner. The UNEXERCISABLE half IS a gap, because its remedy belongs
   * to us and somebody can act on it this afternoon.
   */
  let unexercisableSurfaces: number | null = null;
  let refusedSurfaces: number | null = null;
  if (crawl.excluded !== null) {
    unexercisableSurfaces = 0;
    refusedSurfaces = 0;
    const unexercisableGaps: CoverageGap[] = [];
    let notOurSurface = 0;

    for (const exclusion of crawl.excluded) {
      const exercise = exclusionAsExercise(exclusion.kind, exclusion.rule);
      if (!exercise) {
        notOurSurface += 1;
        continue;
      }
      if (exercise.state === 'REFUSED') {
        refusedSurfaces += 1;
        continue;
      }
      unexercisableSurfaces += 1;

      const where = exclusion.route ?? exclusion.url;
      // `scoreGap` wants the node it is scoring, and by construction there is
      // none — the crawl refused to visit it, so it has no inbound edges and no
      // forms. Passing null is the honest input and `scoreGap` already handles
      // it; the text is what carries HIGH_VALUE's signal.
      const scored = scoreGap('UNEXERCISABLE_SURFACE', null, {
        maxInbound,
        maxOutbound,
        journeyPriority: null,
        text: `${where} ${exclusion.kind}`,
      });

      unexercisableGaps.push({
        id: gapId('UNEXERCISABLE_SURFACE', where, exclusion.kind),
        kind: 'UNEXERCISABLE_SURFACE',
        title: `Nothing can test ${where} — it ${EXCLUSION_KIND_LABELS[exclusion.kind]}`,
        route: exclusion.route,
        feature: null,
        evidence: [
          `The crawl refused ${exclusion.url} under the rule "${exclusion.rule}": it ${EXCLUSION_KIND_LABELS[exclusion.kind]}.`,
          `That refusal is correct and is about THIS environment, not about the surface: ${UNEXERCISABLE_REASON_LABELS[exercise.reason!]}.`,
          `REMEDY: ${exercise.remedy}`,
          'Until then this surface is counted and named rather than tested. It is not reported as covered and it is not quietly dropped — dropping it would raise the coverage percentage by removing the hardest thing in the application from the denominator.',
        ],
        // Never HIGH. The crawl's own refusal heuristic is a path and label
        // scan, so "this looks destructive" is a guess about the customer's
        // application and deserves a human's eye before it is believed.
        confidence: 'MEDIUM',
        reachability: scored.reachability,
        blastRadius: scored.blastRadius,
        score: scored.score,
        scoreWhy: scored.why,
        // A refused surface was never visited, so no test can be "in the
        // neighbourhood" of it in the sense the other gaps mean.
        relatedTestIds: [],
        // Unknown, not false. The crawl never reached it, so whether it sits
        // behind the wall is something we did not measure — and `false` here
        // would propose an anonymous test of a logged-in flow.
        requiresAuth: false,
        authProfile: null,
        subject: {
          kind: 'unexercisable',
          route: exclusion.route,
          url: exclusion.url,
          reason: exercise.reason!,
          rule: exclusion.rule,
          remedy: exercise.remedy,
        },
      });
    }

    unexercisableGaps.sort((a, b) => b.score - a.score);
    if (unexercisableGaps.length > MAX_UNEXERCISABLE_GAPS) {
      caveats.push(
        `${unexercisableGaps.length} surfaces cannot be driven in this environment; the ${MAX_UNEXERCISABLE_GAPS} highest-scoring are listed. At least ${unexercisableGaps.length - MAX_UNEXERCISABLE_GAPS} more exist.`,
      );
    }
    gaps.push(...unexercisableGaps.slice(0, MAX_UNEXERCISABLE_GAPS));

    if (refusedSurfaces > 0) {
      const byRule = exclusionsByRule(
        crawl.excluded
          .filter((exclusion) => exclusionAsExercise(exclusion.kind, exclusion.rule)?.state === 'REFUSED')
          .map((exclusion) => ({ ...exclusion, discoveredFrom: null })),
      );
      caveats.push(
        `${refusedSurfaces} surface${refusedSurfaces === 1 ? '' : 's'} were refused by a crawl policy rule and never attempted, so nothing is claimed about ${refusedSurfaces === 1 ? 'it' : 'them'} in either direction: ${byRule
          .slice(0, 3)
          .map((group) => `${group.rule} (${group.count})`)
          .join('; ')}. A refused surface and a surface that does not exist are opposite facts, and this sentence is the only place the difference appears.`,
      );
    }
    if (notOurSurface > 0) {
      caveats.push(
        `${notOurSurface} refused URL${notOurSurface === 1 ? ' was' : 's were'} off-origin or not a page at all, so ${notOurSurface === 1 ? 'it is' : 'they are'} not counted as this application's surface. Counting a third party's login form as your route produces a gap you could not possibly close.`,
      );
    }
    if (crawl.exclusionsDeduped > 0) {
      caveats.push(
        `${crawl.exclusionsDeduped} refusal${crawl.exclusionsDeduped === 1 ? '' : 's'} named a route another refusal had already named — a link to /logout from fifty pages is one refused surface — and ${crawl.exclusionsDeduped === 1 ? 'was' : 'were'} folded together.`,
      );
    }
    if (crawl.exclusionsDiscarded > 0) {
      caveats.push(
        `The refusal ledger was read up to ${MAX_EXCLUSIONS} distinct surfaces and discarded ${crawl.exclusionsDiscarded} more, so at least ${crawl.exclusionsDiscarded} further refused surfaces exist beyond the ones listed.`,
      );
    }
  } else {
    caveats.push(
      'This crawl recorded no refusal ledger, so whether it declined to drive a logout or a delete flow is unknown — not "none". Re-crawl to find out: a destructive surface absent from the denominator raises the coverage percentage, which is the wrong direction.',
    );
  }

  // ── 8. What the tests know that the crawl does not ─────────────────────────
  /*
   * The only direction that can see our own blind spot. See
   * `reverseReconcile` — a test navigating somewhere the crawl never reached is
   * a human writing down a URL of the application that our denominator does not
   * contain, which is the hardest evidence of undercount obtainable.
   *
   * Scoped to the crawl's routes HERE, deliberately: this function's whole
   * input is one flow map, so the honest denominator for it is what that crawl
   * reached. apps/api/src/lib/coverage-store.ts calls the same function against
   * the FULL unioned inventory, which is strictly stronger and will report
   * fewer targets — two measurements of the same thing against two different
   * surfaces, each labelled with the surface it used.
   */
  const reverse = reverseReconcile({
    enumerated: routes.map((node) => node.route),
    tests: input.tests,
  });
  caveats.push(...reverse.caveats);

  gaps.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = Math.min(input.limit ?? MAX_GAPS, MAX_GAPS);
  const returned = gaps.slice(0, limit);
  if (gaps.length > returned.length) {
    caveats.push(`${gaps.length} gaps found; the ${returned.length} highest-ranked are returned.`);
  }

  return {
    crawled: true,
    flowMapVersion: crawl.version,
    baseUrl: crawl.baseUrl,
    gaps: returned,
    unknowns,
    unreadable: crawl.unreadable,
    caveats,
    totals: {
      tests: input.tests.length,
      testsWithReadableRoutes: facts.filter((f) => f.routes.length > 0).length,
      routes: routes.length,
      routesVisited: visitedRoutes.size,
      journeys: crawl.journeys.length,
      journeysWalked,
      forms: totalForms,
      formsExercised,
      affordances: allControls.length,
      affordancesUsed,
      gaps: gaps.length,
      gapsReturned: returned.length,
      unexercisableSurfaces,
      refusedSurfaces,
    },
    reverse,
    fingerprint: fingerprintOf(crawl.version, input.tests, gaps),
  };
}

function featureOf(crawl: CrawlModel, node: CrawlNode): string | undefined {
  return crawl.features.find((f) => f.nodeIds.includes(node.id))?.name;
}

/**
 * The units the negative-case check runs over: the Explorer's own feature
 * groupings when it made any, and one group per route otherwise. Falling back to
 * per-route rather than skipping is the fail-open choice — a project whose crawl
 * predates feature inference should still hear that its checkout has no failure
 * test.
 */
function featureGroups(
  crawl: CrawlModel,
  routes: CrawlNode[],
): Array<{ name: string; routes: string[] }> {
  if (crawl.features.length > 0) {
    const byId = new Map(crawl.nodes.map((n) => [n.id, n.route]));
    const groups = crawl.features
      .map((f) => ({
        name: f.name,
        routes: [...new Set(f.nodeIds.map((id) => byId.get(id)).filter((r): r is string => Boolean(r)))],
      }))
      .filter((g) => g.routes.length > 0);
    if (groups.length > 0) return groups;
  }
  return routes.map((n) => ({ name: n.title || n.route, routes: [n.route] }));
}

/**
 * Changes whenever the answer could change: the crawl version, the set of tests,
 * and each test's declared coverage. POST /propose compares it so a human who
 * ticked a gap on a stale screen is told, rather than quietly having a test
 * written for a gap somebody else closed ten minutes ago.
 */
function fingerprintOf(
  version: number | null,
  tests: CoverageTestInput[],
  gaps: CoverageGap[],
): string {
  const hash = createHash('sha256');
  hash.update(`v:${version ?? 'none'}\n`);
  for (const test of [...tests].sort((a, b) => a.id.localeCompare(b.id))) {
    // The role binding is part of what a test covers, not metadata about it: a
    // test bound to the admin profile reaches pages the same code reaches
    // nothing on when it is anonymous. Leaving it out would let a re-bind pass
    // the staleness check and propose a test for a gap it had just closed.
    hash.update(
      `t:${test.id}:${[...test.routes].sort().join(',')}:${test.code?.length ?? 0}:${test.authProfileId ?? 'anon'}${test.authProfileRequired ? ':needs-role' : ''}\n`,
    );
  }
  // Same gap, different role to close it, is a different proposal.
  for (const line of gaps.map((g) => `g:${g.id}:${g.authProfile?.id ?? 'none'}`).sort()) {
    hash.update(`${line}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

// ─── Handing a gap to the Generator ──────────────────────────────────────────

/**
 * Turn a gap into the exact shape the Generator already eats.
 *
 * This is the seam between the deterministic half and the model. Everything the
 * proposal says about the APPLICATION comes from the crawl — the steps are the
 * actions the crawler actually performed, the fields are the fields it actually
 * found — so the model is never asked to invent facts, only to write the code
 * that expresses them. And the rationale IS the evidence, so the test that
 * lands in the repo carries the argument for its own existence.
 *
 * `planItemSchema` in @qaai/shared bounds every field (title 160, rationale
 * 1000, 1–40 steps, 1–20 assertions); the clamps below are those bounds, not
 * arbitrary tidiness. A proposal that violates them is one the plan endpoint
 * would reject at the last moment.
 */
export function planItemForGap(gap: CoverageGap): PlanItem {
  const subject = gap.subject;
  const clamp = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`;

  /*
   * THE ROLE, CARRIED. This field used to be a hard-coded `null`, and that one
   * literal was the defect: `PlanItem.authProfileId` existed, the Generator was
   * handed it, the Test row had nowhere to put it, and every auth gap therefore
   * produced a test that could only assert anonymous denial. A gap asking for a
   * signed-in test, answered with a signed-out one, is a loop with no exit —
   * the next analysis reports the same gap, for ever.
   *
   * Null is still the right answer twice over, and both are honest rather than
   * lazy: the subject is not behind a wall, or it is and no profile could be
   * named (see `authProfileEvidence`). The second case is the one that must not
   * pass quietly, which is why the steps and assertions below change shape when
   * `gap.requiresAuth` is true and `gap.authProfile` is null — the item then
   * proposes a test of the WALL and says in its own assertions that the page
   * behind it stays uncovered, rather than proposing a test of the page that
   * would run as nobody and pass.
   */
  const profile = gap.authProfile;
  const base = {
    id: gap.id,
    feature: clamp(gap.feature || routeFeatureName(gap.route) || 'Uncovered', 80),
    priority: priorityForGap(gap),
    journeyId: subject.kind === 'journey' ? subject.journeyId : null,
    authProfileId: profile?.id ?? null,
  };

  /** The sign-in step, worded so the Generator asks the runner for a session. */
  const signInSteps = profile
    ? [
        `Sign in as the "${profile.name}" auth profile — the runner injects its stored session before the first navigation, so do NOT write a login form in the test`,
      ]
    : [];

  let title: string;
  let steps: string[];
  let assertions: string[];
  let testType: TestType;

  switch (subject.kind) {
    case 'journey': {
      title = `Walk "${subject.name}" end to end`;
      testType = 'E2E';
      steps = [
        ...signInSteps,
        `Start at ${subject.routes[0] ?? '/'}`,
        ...subject.steps,
        ...(subject.routes.length > 1
          ? [`Confirm the final state is ${subject.routes[subject.routes.length - 1]}`]
          : []),
      ];
      assertions = [
        `The journey completes and the application ends on ${subject.routes[subject.routes.length - 1] ?? subject.routes[0] ?? '/'}`,
        'Each hand-off between steps carries its data forward — assert the value produced by one step is the value the next step uses, not merely that the next page rendered',
      ];
      break;
    }
    case 'form': {
      const required = subject.form.fields.filter((f) => f.required);
      title = `Submit the "${subject.form.name}" form on ${subject.route}`;
      testType = 'E2E';
      steps = [
        // The sign-in comes FIRST, before the navigation: arriving signed out
        // and then signing in walks a redirect the journey does not contain.
        ...signInSteps,
        `Navigate to ${subject.route}`,
        ...(subject.behindAuth && !profile
          ? ['Sign in first — this page is behind an auth wall and no auth profile was bound to this test']
          : []),
        ...subject.form.fields.map(
          (f) => `Fill "${f.label}" with a valid ${f.semantic.replace(/_/g, ' ')} value`,
        ),
        subject.form.submitLabel
          ? `Submit with "${subject.form.submitLabel}"`
          : 'Submit the form',
      ];
      assertions = [
        'The submission is accepted and the resulting state reflects what was entered, not merely that a success message appeared',
        required.length > 0
          ? `Leaving "${required[0]!.label}" empty is refused, and the error names that field`
          : 'Submitting invalid input is refused rather than silently accepted',
      ];
      break;
    }
    case 'affordance': {
      title = `Exercise "${subject.label}" on ${subject.route}`;
      testType = 'E2E';
      steps = [
        // A control on a page behind the wall cannot be clicked by a visitor
        // who cannot reach the page. The binding on `base` is what actually
        // delivers the session; this step is so the written test says so.
        ...signInSteps,
        `Navigate to ${subject.route}`,
        `Activate the ${subject.controlKind} "${subject.label}" (the crawl located it as ${subject.expression})`,
      ];
      assertions = [
        `Activating "${subject.label}" changes something observable — assert the state it produces, not that the control exists`,
      ];
      break;
    }
    case 'negative': {
      /*
       * ─── ONE ITEM CARRYING A TABLE, NOT N ITEMS ──────────────────────────
       *
       * THE DEFECT, VERBATIM FROM THE REGISTER: "one whole feature becomes ONE
       * negative item, built from the FIRST required field. Nothing enumerates
       * empty / too-long / wrong-type / off-by-one / Luhn-invalid /
       * future-date." What stood here was literally
       * `subject.forms.flatMap((f) => f.fields).find((f) => f.required)`
       * followed by one step and two assertions, so a twelve-field checkout
       * form produced the single negative fact that almost every form in the
       * world already gets right.
       *
       * It is now `expandBoundaries`, and the shape of the output is a
       * decision with three arguments behind it:
       *
       *   1. IT IS HOW A HUMAN WOULD WRITE IT. Every ecosystem fragment in
       *      `ecosystem-prompts.ts` already tells the model to prefer an input
       *      table over a loop — `@pytest.mark.parametrize` for pytest,
       *      `it.each` for vitest, `[TestCase]` for NUnit, `#[DataProvider]`
       *      for PHPUnit, `->with([...])` for Pest. A plan item carrying a
       *      table of cases maps onto exactly that: one parameterised test,
       *      one row per case, each row named after the class it exercises.
       *      Twelve items would map onto twelve files, which is not what
       *      anyone writes by hand and not what those prompts ask for.
       *
       *   2. A GAP IS ONE SUBJECT. `gapId` keys on (kind, feature, routes) and
       *      POST /coverage/:id/propose looks a gap up by that id to build its
       *      proposal, so the gap → item relation is one-to-one by
       *      construction. `planItemForGap` returns a `PlanItem`, singular,
       *      and the two callers (`apps/api/src/routes/coverage.ts` and
       *      `apps/worker/src/processors/explore.ts`) are both outside this
       *      package's reach. Returning many would be a change to their
       *      contract to express something the table already expresses.
       *
       *   3. ONE APPROVAL, ONE DECISION. A reviewer ticks a box per item. The
       *      question they are actually answering is "should this form's input
       *      validation be tested" — one question, not twelve.
       *
       * The cap is `MAX_BOUNDARY_CASES_PER_GAP`, and the point of the last
       * assertion below is that the cap SAYS SO. A capped list that presents
       * itself as complete is the same dishonesty as the one-case item it
       * replaces, wearing a better suit.
       */
      const expansion = expandNegativeCases(gap.id, subject.forms);
      const negativeCases = expansion.cases.filter((c) => c.field !== null);
      title = `Cover the failure path for ${subject.feature}`;
      testType = subject.forms.length > 0 ? 'E2E' : 'SECURITY_SMOKE';

      if (negativeCases.length === 0) {
        /*
         * No form, or no field any class applied to: a permission boundary
         * rather than an input. The old single-case wording is exactly right
         * here and is kept — what was wrong with it was being the ONLY wording.
         */
        steps = [
          `Navigate to ${subject.routes[0] ?? '/'}`,
          'Attempt the action without the permission or precondition it requires',
        ];
        assertions = [
          'The attempt is refused rather than partially applied',
          'The response is an explicit denial, and no privileged data appears in it',
          'No state was written — re-reading afterwards shows the original value',
        ];
        break;
      }

      /*
       * Every positive control is rendered, not just the first.
       *
       * `expandNegativeCases` exempts the controls from the rank cap (one per
       * form, for the reason given there), so a feature with three forms
       * carries three of them. Rendering one and holding two would put cases in
       * the item's own expansion that the item never mentions — a silent drop
       * inside the very code that exists to stop silent drops.
       */
      const controls = expansion.cases.filter((c) => c.field === null);
      steps = [
        `Navigate to ${subject.routes[0] ?? '/'}`,
        'Fill every field with a valid value, then change exactly ONE field per case from the table below — a submission with two bad fields fails for a reason nobody can attribute, and an unattributable failure gets deleted at the first red build',
        ...controls.map(
          (c) =>
            `[${c.equivalenceClass}] submit "${c.formName}" with every field valid — expect it to be ${c.expectation}. Run this row first: without it, every case below is equally consistent with a form that refuses all input`,
        ),
        ...negativeCases.map(
          (c) =>
            `[${c.equivalenceClass}] set "${c.fieldLabel ?? c.field}" to ${printableValue(c.value ?? '')}, leaving every other field valid, and submit — expect it to be ${c.expectation}`,
        ),
        'Write this as ONE parameterised test over those rows (parametrize / test.each / TestCase / DataProvider, whichever this project uses), not one test per row and not a loop inside a single test: a loop reports one failure for the first bad row and hides the rest',
      ];
      assertions = [
        ...controls.map((c) => `Positive control ("${c.formName}") — ${c.expected}`),
        ...negativeCases.map(
          (c) => `[${c.equivalenceClass}] "${c.fieldLabel ?? c.field}": ${c.expected}`,
        ),
        'Every rejection leaves no trace — re-reading afterwards shows the original value, not a partially written record',
        `NOT COVERED by this test: ${describeDropped(expansion.dropped, 3)}`,
        ...expansion.caveats.slice(0, 1).map((c) => `READ BEFORE TRUSTING A PASS: ${c}`),
      ];
      break;
    }
    case 'unexercisable': {
      /*
       * THE ONE PLAN ITEM THAT IS NOT A PROPOSAL.
       *
       * Every other arm writes the test a Generator should produce. This one
       * must not: the surface is session-ending or destructive, the environment
       * cannot afford the side effect, and a generated test that drove it would
       * either log the suite out mid-run or delete a record nobody can restore.
       *
       * So the item states the PRECONDITION as its first step and says in its
       * own assertions that it covers nothing until that precondition is met —
       * the same shape the auth-profile-less branch below uses, and for the
       * same reason: `PlanItem` has nowhere to put "do not generate this yet",
       * so it has to be a sentence a human reads on the approval screen.
       */
      const where = subject.route ?? subject.url;
      title = `Needs disposable data: ${where}`;
      testType = subject.reason === 'SESSION_ENDING' ? 'SECURITY_SMOKE' : 'E2E';
      steps = [
        `BLOCKED until this is true: ${subject.remedy}`,
        `Once it is, navigate to ${where} and drive the flow to completion — it ${UNEXERCISABLE_REASON_LABELS[subject.reason].toLowerCase()}, so it must run against data this environment can afford to lose.`,
        `The crawl refused it under the rule "${subject.rule}"; that rule is about OUR harness and does not need changing for the test to be written.`,
      ];
      assertions = [
        `NOT COVERED by this test until the precondition above is met: ${where}. ${subject.remedy}`,
        `When it can run, assert the side effect actually happened — that the session is gone, or that the record is gone and the application says so — rather than that a confirmation dialog appeared.`,
      ];
      break;
    }
    default: {
      /*
       * Three shapes, not two, and the third is the point of this change.
       *
       *   behind a wall, profile named   → an E2E test that SIGNS IN and
       *       asserts the page. This is the test the gap asked for, and it is
       *       what makes the gap close: it carries `authProfileId`, so the next
       *       analysis sees an authenticated visitor to this route and stops
       *       reporting it. Nothing about it reads as a security test any more,
       *       so the type is E2E — SECURITY_SMOKE's schema can only express
       *       anonymous denial, which is exactly the assertion we are escaping.
       *
       *   behind a wall, NO profile      → a SECURITY_SMOKE of the wall, which
       *       is a real and useful test, plus an assertion that says out loud
       *       that the page behind it is still uncovered. The gap stays open on
       *       purpose. Proposing the signed-in test anyway would produce a test
       *       that runs as nobody, passes, and reports a page it never saw.
       *
       *   not behind a wall              → unchanged.
       */
      if (subject.behindAuth && profile) {
        title = `Reach ${subject.route} as "${profile.name}"`;
        testType = 'E2E';
        steps = [
          ...signInSteps,
          ...(subject.entryActions.length > 0
            ? [`Arrive the way the crawler did: ${subject.entryActions[0]}`]
            : []),
          `Navigate to ${subject.route}`,
          ...subject.forms.slice(0, 1).map((f) => `Exercise the "${f.name}" form on the page`),
        ];
        assertions = [
          `Signed in as "${profile.name}", ${subject.route} renders its own content and not a redirect to a login page — assert something only this page can produce once you are through the wall`,
          ...(subject.forms.length > 0
            ? ['The form on the page accepts a valid submission and refuses an invalid one']
            : []),
        ];
        break;
      }

      title = subject.behindAuth
        ? `Reach ${subject.route} as a signed-in user`
        : `Cover ${subject.route}`;
      testType = subject.behindAuth ? 'SECURITY_SMOKE' : 'E2E';
      steps = [
        ...(subject.behindAuth ? ['Sign in with a profile that can reach this page'] : []),
        ...(subject.entryActions.length > 0
          ? [`Arrive the way the crawler did: ${subject.entryActions[0]}`]
          : []),
        `Navigate to ${subject.route}`,
        ...subject.forms.slice(0, 1).map((f) => `Exercise the "${f.name}" form on the page`),
      ];
      assertions = [
        subject.behindAuth
          ? `A signed-in user sees the real ${subject.route} page rather than a redirect, and a signed-out one does not`
          : `${subject.route} renders its own content — assert something only this page can produce, not that the layout loaded`,
        ...(subject.forms.length > 0
          ? ['The form on the page accepts a valid submission and refuses an invalid one']
          : []),
      ];
      break;
    }
  }

  /*
   * A test that NEEDED a role and has none must say so in its own text.
   *
   * There is nowhere else for it to go: `PlanItem` has one auth field and it is
   * the id, so "I asked for a role and did not get one" cannot be a flag — it
   * has to be a sentence the Generator writes into the test and a human reads
   * on the approval screen. Without it the item is indistinguishable from a
   * deliberate anonymous test, which is how a test ends up passing while
   * covering nothing.
   */
  if (gap.requiresAuth && !profile) {
    assertions.push(
      'NOT COVERED by this test: the page behind the auth wall. No auth profile was available to bind, so this asserts only that an unauthenticated visitor is refused — do not read a pass here as coverage of what the page does once you are signed in',
    );
  }

  // Every gap carries evidence by construction, but a proposal with an empty
  // rationale would still be schema-valid and useless, so the fallback is real.
  const rationale =
    gap.evidence.length > 0
      ? gap.evidence.join(' ')
      : `${gap.title}. Found by coverage gap analysis over flow map and test routes.`;

  return {
    ...base,
    title: clamp(title, 160),
    rationale: clamp(rationale, 1000),
    testType,
    steps: steps.filter(Boolean).map((s) => clamp(s, 400)).slice(0, 40),
    assertions: assertions.filter(Boolean).map((s) => clamp(s, 400)).slice(0, 20),
  };
}

/**
 * A gap's score is a heuristic; a journey's priority is a judgement the Explorer
 * made and a human approved. So CRITICAL_PATH is only ever inherited, never
 * invented here — this file is not entitled to tell a team what is critical.
 */
function priorityForGap(gap: CoverageGap): Priority {
  if (gap.subject.kind === 'journey' && gap.subject.priority === 'CRITICAL_PATH') {
    return 'CRITICAL_PATH';
  }
  if (gap.score >= 45) return 'IMPORTANT';
  return 'NICE_TO_HAVE';
}

function routeFeatureName(route: string | null): string | null {
  if (!route) return null;
  const first = route.split('/').filter(Boolean)[0];
  if (!first || first === ':param' || first === '*') return null;
  return first.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// ─── Provenance, and verifying that a gap actually closed ────────────────────

/**
 * THE DEFECT, VERBATIM: "Gap → plan item → test provenance and verified
 * closure — the gapId→planItemId map is returned in the HTTP response only and
 * PlanItem has no gap column, so QAAI cannot say 'this gap is closed by this
 * test' or notice that it is not."
 *
 * Everything below is the deterministic half of fixing that, and it lives here
 * rather than next to the database for the same reason the rest of this file
 * does: NOTHING IN IT CALLS A MODEL. "Is this gap closed?" is a claim about the
 * customer's suite, and a claim we cannot show the working for is worse than no
 * claim at all. So the rule is a pure function over (what the ledger remembers,
 * what the report just found), it returns the sentence it decided on, and the
 * worker's only job is to store what it says.
 *
 * The failure mode being designed against is specific, and the product has
 * already had one instance of it: `Test.authProfileId` exists because an
 * UNREACHED_AUTH_ROUTE gap asked for an authenticated test, the only test that
 * could be generated asserted anonymous denial, and so closing the gap
 * re-created the gap — for ever, with nothing anywhere noticing that the same
 * gap had now been "closed" four times. A loop with no memory can only ever be
 * hopeful. These functions are the memory.
 */

/**
 * The gap identity a PlanItem row — and the Test that item produces — must both
 * carry, so that closure is verifiable from either end.
 *
 * Deliberately NOT the whole gap. The evidence, the score and the confidence
 * all move as tests are added, so storing them would mean a provenance record
 * that disagrees with itself the moment anything changes. What is stored is the
 * stable identity (`gapId` is a hash of kind + subject, unchanged across
 * recomputation by construction) plus the two fields a human needs to read the
 * row six months later: the kind, because the id is a hash and tells nobody
 * anything, and the title, because the gap may well have stopped being reported
 * by the time anyone asks what it was.
 *
 * TODO(shared-types): `gapId: string | null` belongs on `PlanItem` in
 * packages/shared/src/types.ts, beside `authProfileId`, so that the plan
 * endpoints carry it through their own schema instead of the two writers
 * (apps/api/src/routes/coverage.ts and apps/worker/src/processors/close-loop.ts)
 * each attaching it by hand. `planItemSchema` in packages/shared/src/schemas.ts
 * needs the matching `.nullable().default(null)` field. That file belongs to
 * another agent this round; this interface is the local stand-in.
 */
export interface GapProvenance {
  /** `CoverageGap.id`. Stable across recomputation for the same subject. */
  gapId: string;
  gapKind: GapKind;
  /** Clamped to the DB column's practical width; the full title is in the gap. */
  gapTitle: string;
  /** The rank at the moment of proposal, for "why did it pick this one?". */
  gapScore: number;
}

/** The three fields a provenance row needs, taken off the gap itself. */
export function gapProvenance(gap: CoverageGap): GapProvenance {
  return {
    gapId: gap.id,
    gapKind: gap.kind,
    gapTitle: gap.title.length <= 300 ? gap.title : `${gap.title.slice(0, 299)}…`,
    gapScore: gap.score,
  };
}

/**
 * The closure ledger's vocabulary.
 *
 * Seven states, and the two that look redundant are the only reason this is
 * worth building:
 *
 *   NOT_CLOSED    re-measured, a test exists, and the gap is STILL reported.
 *                 This is the FINDING — the sentence "we wrote a test for this
 *                 and it did not close it" is the single most useful thing this
 *                 ledger can produce, and folding it into OPEN would lose the
 *                 fact that a generation was already spent on it.
 *   UNVERIFIABLE  closure could not be checked at all. No readable crawl, or
 *                 the gap report was a ranked PAGE and this gap's absence from
 *                 that page is evidence of nothing. A gap that drops off a
 *                 truncated list recorded as CLOSED is the easiest way for this
 *                 number to become fiction, and it is the one this file exists
 *                 to refuse.
 *
 * Text rather than a TypeScript enum because the database column is text: see
 * the migration header for why a new Prisma enum would be an enum with no drift
 * guard. This array IS the domain; the writer validates against it.
 */
export const CLOSURE_STATES = [
  'OPEN',
  'PROPOSED',
  'TEST_WRITTEN',
  'CLOSED',
  'NOT_CLOSED',
  'REOPENED',
  'UNVERIFIABLE',
] as const;

export type ClosureState = (typeof CLOSURE_STATES)[number];

/** True for a value that may be stored in `GapClosure.state`. */
export function isClosureState(value: string): value is ClosureState {
  return (CLOSURE_STATES as readonly string[]).includes(value);
}

/** What the ledger remembers about one gap. The stored row, as the rule sees it. */
export interface ClosureLedgerEntry {
  gapId: string;
  state: ClosureState;
  /** The plan item minted for it, when one was. */
  planItemId: string | null;
  /** The test that item produced, when it produced one. */
  testId: string | null;
}

/**
 * What a freshly computed report can say about closure, and — crucially — what
 * it cannot.
 *
 * `complete` is the field that keeps this honest. `analyzeCoverage` takes a
 * `limit` and reports `totals.gaps` alongside `totals.gapsReturned`, so a
 * caller holding a page of the ranked list knows only that a gap is not ON THE
 * PAGE. Passing `complete: false` turns every absence into UNVERIFIABLE instead
 * of into a closure, which is the difference between a ledger and a flattering
 * log.
 */
export interface ClosureEvidence {
  /** `CoverageReport.crawled`. False means we know nothing about the app. */
  crawled: boolean;
  /** Gap ids the report just produced. */
  openGapIds: ReadonlySet<string>;
  /** True only when the report held EVERY gap it found, not a ranked page. */
  complete: boolean;
}

export interface ClosureVerdict {
  gapId: string;
  state: ClosureState;
  /** Whether this differs from what the ledger held. Only changes are written. */
  changed: boolean;
  /** The sentence behind the state, stored on the row. */
  why: string;
}

/**
 * Decide what the ledger should now say about one gap.
 *
 * The order of the branches is the whole rule, and every one of them is a way
 * this could otherwise lie:
 *
 *   1. We could not see the application → UNVERIFIABLE. Not "closed", not
 *      "open". An empty crawl makes every gap vanish from the report, so a rule
 *      that read absence as closure would mark an entire project closed the
 *      first time the Explorer failed.
 *   2. The gap is still reported → it is not closed, and WHICH not-closed
 *      matters. A gap with a test behind it that is still reported is
 *      NOT_CLOSED (or REOPENED, if we had previously recorded it closed); a gap
 *      with nothing behind it is just still open.
 *   3. The gap is gone, and the report was complete → CLOSED, and the `why`
 *      names the test if there is one and says there is none if there is not.
 *      "It closed and no test of ours is responsible" is a true and useful
 *      sentence — somebody else's test, or a deleted route — and pretending
 *      credit would corrupt the only metric this ledger produces.
 *   4. The gap is gone and the report was a page → UNVERIFIABLE. See
 *      `ClosureEvidence.complete`.
 */
export function verifyClosure(
  entry: ClosureLedgerEntry,
  evidence: ClosureEvidence,
): ClosureVerdict {
  const settle = (state: ClosureState, why: string): ClosureVerdict => ({
    gapId: entry.gapId,
    state,
    changed: state !== entry.state,
    why,
  });

  if (!evidence.crawled) {
    return settle(
      'UNVERIFIABLE',
      'Closure could not be checked: this project has no readable crawl, so the gap report is empty for a reason that has nothing to do with coverage. An absent gap is not a closed gap.',
    );
  }

  const stillOpen = evidence.openGapIds.has(entry.gapId);

  if (stillOpen) {
    if (entry.state === 'CLOSED') {
      return settle(
        'REOPENED',
        entry.testId
          ? `This gap was recorded closed and is being reported again. Test ${entry.testId} was supposed to have closed it — check that it still exists, still runs, and still asserts what the gap asked for.`
          : 'This gap was recorded closed and is being reported again. No test of ours was ever credited with closing it, so whatever did close it has been undone.',
      );
    }
    if (entry.testId) {
      return settle(
        'NOT_CLOSED',
        `Test ${entry.testId} was written for this gap and the gap is still being reported. Proposing the same item again would produce the same test, so the loop stops here and says so rather than spending another generation on it.`,
      );
    }
    if (entry.planItemId) {
      return settle(
        'PROPOSED',
        `Plan item ${entry.planItemId} exists for this gap and no test has landed from it yet. Generation has not finished, or there is no model key on this deployment.`,
      );
    }
    return settle('OPEN', 'Still reported as a gap, and nothing has been proposed for it yet.');
  }

  if (!evidence.complete) {
    return settle(
      'UNVERIFIABLE',
      'Closure could not be checked: the gap report this was measured against was a ranked page rather than the full list, so this gap being absent from it means only that it is not in the top slice.',
    );
  }

  return settle(
    'CLOSED',
    entry.testId
      ? `Closed: the gap is no longer reported, and test ${entry.testId} is the test written for it.`
      : 'Closed: the gap is no longer reported. No test of ours was written for it, so something else closed it — an existing test, or the surface it described no longer exists.',
  );
}

/**
 * Pick the gaps a campaign should spend its budget on next.
 *
 * ── WHY THIS IS NOT JUST `gaps.slice(0, k)` ─────────────────────────────────
 *
 * Because the obvious version is an infinite loop with a budget attached. The
 * gap list is recomputed every tick and the ranking is deterministic, so the
 * top K is the SAME top K until something actually closes — and a campaign that
 * re-proposes its top K every fifteen minutes spends a whole night's budget
 * writing the same eight tests eight times, each time believing it is making
 * progress. The ledger is what breaks that: anything already in flight, already
 * attempted and known not to have closed, or re-opened after a closure, is
 * skipped BY NAME with the reason attached.
 *
 * NOT_CLOSED and REOPENED are skipped rather than retried, and that is the
 * important one. `planItemForGap` is deterministic: given the same gap it
 * returns the same title, the same steps and the same assertions, so a retry is
 * not another attempt — it is the identical attempt, and it will fail
 * identically. A loop that retries a deterministic failure is the shape of
 * every runaway job this repo has ever had. The honest move is to stop, record
 * that the gap resisted the obvious test, and let a human read the row.
 *
 * Nothing is dropped silently: `considered` is the full count and every
 * exclusion is named, because a campaign that proposed three items out of a
 * hundred gaps has to be able to say why.
 */
export interface ClosureSelection {
  /** Chosen, worst-first, at most `limit`. */
  gaps: CoverageGap[];
  /** Everything deliberately not chosen, with the reason. Never silent. */
  skipped: Array<{ gapId: string; title: string; why: string }>;
  /** How many gaps were offered. `gaps.length + skipped.length` by construction. */
  considered: number;
}

export function rankGapsForClosure(
  gaps: readonly CoverageGap[],
  options: {
    /** Hard cap on the returned list — the tick's share of the night's budget. */
    limit: number;
    /** What the ledger already knows, keyed by gap id. */
    ledger?: ReadonlyMap<string, ClosureState>;
  },
): ClosureSelection {
  const ledger = options.ledger ?? new Map<string, ClosureState>();
  const skipped: ClosureSelection['skipped'] = [];

  /*
   * Score descending, then gap id ascending. The tiebreak is not tidiness: two
   * ticks of one campaign must pick the same gap for the same reason, or the
   * ledger's "already attempted" bookkeeping is comparing two different
   * orderings and the skip list stops meaning anything.
   */
  const ordered = [...gaps].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id),
  );

  const chosen: CoverageGap[] = [];
  for (const gap of ordered) {
    const state = ledger.get(gap.id);

    if (state === 'PROPOSED' || state === 'TEST_WRITTEN') {
      skipped.push({
        gapId: gap.id,
        title: gap.title,
        why: 'Work is already in flight for this gap — an item was proposed and no test has landed from it yet. Proposing again would mint a duplicate and hand the Generator the same job twice.',
      });
      continue;
    }
    if (state === 'NOT_CLOSED') {
      skipped.push({
        gapId: gap.id,
        title: gap.title,
        why: 'A test was already written for this gap and the gap is still reported. The proposal is deterministic, so a retry would produce the identical test and fail identically. This one needs a human, not another generation.',
      });
      continue;
    }
    if (state === 'REOPENED') {
      skipped.push({
        gapId: gap.id,
        title: gap.title,
        why: 'This gap was recorded closed and has come back. Re-proposing the same item would re-close it on paper and change nothing, so the campaign leaves it for review.',
      });
      continue;
    }

    if (chosen.length >= options.limit) {
      skipped.push({
        gapId: gap.id,
        title: gap.title,
        why: `Past this tick's budget of ${options.limit} item(s). It stays in the ledger and is eligible on the next tick.`,
      });
      continue;
    }

    chosen.push(gap);
  }

  return { gaps: chosen, skipped, considered: ordered.length };
}
