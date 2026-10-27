/**
 * Explore processor (§3.1): crawl the app, ask the Explorer what is worth
 * testing, persist the Flow Map and the proposed plan.
 *
 * The crawl and the plan are stored separately and versioned separately. That
 * matters for the "3 uncovered flows — propose tests" prompt in the cockpit:
 * a later crawl can be diffed against the tests that already exist without
 * re-running the model.
 */

import {
  analyzeCoverage,
  canScaffoldWithoutModel,
  crawlApp,
  holdForInterstitial,
  looksLikeAuthPath,
  planItemForGap,
  proposePlan,
  proposeTypeCoverage,
  resumeAdvice,
  resumePointFrom,
  withObservation,
  withResumePoint,
} from '@qaai/agent';
import { signalsFromFlowMap } from '@qaai/agent';
import type { AuthProfileChoice, CrawlOutcome, TypeSignals, TypeVerdict } from '@qaai/agent';
import { signInWithProfile } from '@qaai/runner';
import type { LoginFailure, LoginResult } from '@qaai/runner';
import { adjudicateCrawl } from '@qaai/shared';
import type {
  AuthProfileKind,
  CrawlAcceptance,
  ExploreJob,
  FlowEdge,
  FlowMap,
  FlowNode,
  Journey,
  Plan,
  RouteAccess,
  TestPlan,
  TestType,
} from '@qaai/shared';
import {
  ANONYMOUS_ROLE,
  roleHadNoExtraSurface,
  roleKey,
} from '@qaai/shared';
import type { RoleCrawlOutcome } from '@qaai/shared';
import {
  accessMatrixFindings,
  buildAccessMatrix,
  shouldReplaceCell,
} from '../../../../packages/agent/src/access-matrix.js';
import type {
  AccessFinding,
  AccessMatrix,
  RoleProbe,
  RouteProbeObservation,
} from '../../../../packages/agent/src/access-matrix.js';
import { effectivePlan } from '../../../api/src/lib/start-run.js';
import { config, llm, logger, prisma, publishEvent } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueGenerate } from '../queues.js';

/** Parity with the Explorer's own default, so both paths propose the same size. */
const MAX_PLAN_ITEMS = 12;

/**
 * The plan a crawl can produce with no model at all.
 *
 * `analyzeCoverage` compares the crawl against the suite; on a project with no
 * tests every route, form, affordance and journey it saw comes back as a gap,
 * and `planItemForGap` turns each into a complete PlanItem — title, rationale,
 * priority, ordered steps, assertions. Both are pure, both are unit tested in
 * packages/agent/src/coverage.test.ts, and routes/coverage.ts and
 * routes/traffic.ts have shipped on them for a while.
 *
 * They were never reachable from the first-run path, which is the only path a
 * new customer takes. Without a key `proposePlan` threw, the whole job failed,
 * the finished FlowMap was left with no plan pointing at it, and onboarding sat
 * on a spinner for five minutes before claiming "the crawl did not finish" —
 * about a crawl that had in fact finished and was sitting in the database.
 */
/**
 * The funnel's verdicts for this map, for the MODEL prompt's type offer.
 *
 * A function rather than a value threaded through, because the two callers sit
 * in different branches of the same `if` and only one of them runs: computing
 * it twice is two passes over a declared thirty-row table with no I/O in it,
 * which is cheaper than restructuring the branch and much easier to read.
 *
 * Deterministic for one map — the seed is derived from the map, never a clock —
 * so the two callers cannot disagree about what this application earns.
 */
function typeVerdictsFor(
  flowMap: FlowMap,
  observed: TypeSignals = {},
): readonly TypeVerdict[] {
  return proposeTypeCoverage({
    seed: `${flowMap.projectId}:${flowMap.version}`,
    signals: { ...signalsFromFlowMap(flowMap), ...observed },
  }).verdicts;
}

/**
 * EXPORTED SO THE WIRING IS PROVABLE, which is this file's own established
 * pattern — see the note on {@link adjudicateExplore}: "pure and exported so
 * the composition is testable… an inline version of it would be untestable in
 * exactly the way the old crawl was."
 *
 * It applies with more force here. This is the NO-MODEL branch, the one that
 * runs on a deployment with no ANTHROPIC_API_KEY, and it is now the only place
 * the type funnel is reached in production. An unexported version of it would
 * mean the widening from two proposable types to nineteen was asserted only in
 * packages/agent and connected to nothing provable — the defect this whole
 * round exists to remove, reproduced by the change that removes it.
 */
export function planFromCrawl(
  flowMap: FlowMap,
  reason: string,
  authProfiles: AuthProfileChoice[],
  caveats: readonly string[] = [],
  /**
   * SIGNALS THE CRAWL COULD NOT OBSERVE, from a caller that has them.
   *
   * ── WHY THIS PARAMETER EXISTS, AND THE MEASUREMENT THAT FORCED IT ──────────
   *
   * A crawl can see a card field, a file input, a download affordance and an id
   * in a route. It CANNOT see a database, a CLI entry point, a unit runner, a
   * native build, a declared locale set or a throughput budget — and every
   * MINTED type the funnel can propose needs one of those. The consequence,
   * measured rather than assumed: from crawl signals ALONE the funnel earns
   * ZERO storable types. It produces the honest disclosures (PAYMENTS and
   * DOCUMENT are EARNED and unstorable; DATABASE and CLI are NOT_PROBED) and no
   * items.
   *
   * That is a correct and useful output and it is not the whole feature. This
   * parameter is the seam the rest arrives through: a caller that has run source
   * analysis or read the environment's declared locales and browsers merges its
   * readings over the crawl's, and the funnel then proposes LOCALIZATION,
   * UNIT_GEN, DATABASE and the rest. NOTHING IN THIS PROCESSOR GATHERS THEM
   * YET — that is named in this round's handover rather than faked here, and an
   * absent override leaves every such signal NOT_PROBED, which is the true
   * reading and never ABSENT.
   *
   * The caller's readings WIN over the crawl's, because a caller that probed the
   * environment knows more about it than a browser did. The crawl is the floor.
   */
  observed: TypeSignals = {},
): TestPlan {
  /*
   * The roles are passed even here — ESPECIALLY here. This is the no-key path,
   * the one every new customer takes on their first run, so it is where a gap
   * behind an auth wall is most likely to be turned into a test. Without the
   * profiles every such item would come out unbound and assert nothing but the
   * redirect, which is the loop this change exists to break.
   */
  const report = analyzeCoverage({ flowMapGraph: flowMap, tests: [], authProfiles });
  const chosen = report.gaps.slice(0, MAX_PLAN_ITEMS);

  /*
   * ── THE TYPE FUNNEL, ON THE PATH EVERY NEW CUSTOMER TAKES ─────────────────
   *
   * THE DEFECT THIS CLOSES. `analyzeCoverage` produces GAPS, and
   * `planItemForGap` turns each one into an item whose `testType` comes from the
   * gap's kind — which is why this path proposed E2E, SMOKE, API, ACCESSIBILITY
   * and SECURITY_SMOKE and NOTHING ELSE, against nineteen minted types with
   * working plugins. Nine of those nineteen had no producer anywhere in the
   * product: a customer could store a LOCALIZATION test, the plugin would run
   * it, and nothing in QAAI had ever proposed one.
   *
   * `proposeTypeCoverage` is the other question — not "which gap is worth a
   * test" but "which TYPE does this application earn" — and it is deliberately
   * wired HERE, in the no-model branch, rather than only beside `proposePlan`:
   * this deployment has no ANTHROPIC_API_KEY and this is the branch that runs,
   * so a widening reachable only from the model path would be a widening
   * reachable from nothing.
   *
   * THE SEED IS DERIVED FROM THE MAP, NEVER FROM A CLOCK. The funnel's ids are
   * a function of the TYPE and not of the seed (so re-running re-proposes the
   * same id instead of minting a duplicate), and the seed is carried only
   * because the input type demands one. `Date.now()` here would make the plan
   * unreproducible for no gain.
   */
  const typeCoverage = proposeTypeCoverage({
    seed: `${flowMap.projectId}:${flowMap.version}`,
    signals: { ...signalsFromFlowMap(flowMap), ...observed },
  });
  const typeItems = typeCoverage.proposals.map((proposal) => proposal.item);

  const proposedCount = chosen.length + typeItems.length;

  return {
    summary:
      `${proposedCount} test${proposedCount === 1 ? '' : 's'} proposed directly from the crawl of ` +
      `${flowMap.baseUrl} — ${report.totals.routes} route(s), ${report.totals.forms} form(s) and ` +
      `${report.totals.journeys} journey(s) seen` +
      (typeItems.length > 0
        ? `, of which ${typeItems.length} cover${typeItems.length === 1 ? 's' : ''} a test TYPE ` +
          `this application earns (${typeItems.map((item) => item.testType).join(', ')})`
        : '') +
      `${typeCoverage.unminted.length > 0 ? `; ${typeCoverage.unminted.length} further type(s) are earned and cannot be stored yet — see below` : ''}` +
      `. Written by the crawler, not by a model: ${reason} ` +
      `Every item below is real and approvable; turning an approved item into code is the step that ` +
      `needs the model.`,
    // The reason rides in `skipped` too, because that is the field the approval
    // screen renders as "deliberately not proposed" — a plan that is quietly
    // shorter than usual has to say why, or it reads as the agent's judgement.
    skipped: [
      { what: 'Model-written test proposals', why: reason },
      /*
       * The enumeration caveats ride in `skipped` because that is the field the
       * approval screen renders as "deliberately not proposed". A plan built
       * over a denominator that was truncated, refused or held as a candidate
       * has to say so where the person approving it is looking — a percentage
       * quoted against an unknown whole with no sentence beside it is the one
       * output this product may not produce.
       */
      ...caveats.map((why) => ({ what: 'Enumeration caveat', why })),
      ...report.gaps.slice(MAX_PLAN_ITEMS, MAX_PLAN_ITEMS + 50).map((gap) => ({
        what: gap.title,
        why: `ranked below the top ${MAX_PLAN_ITEMS} gaps from this crawl`,
      })),
      /*
       * EVERY TYPE THE FUNNEL WITHHELD, WITH ITS REASON, IN THE FIELD THE
       * APPROVAL SCREEN RENDERS AS "DELIBERATELY NOT PROPOSED".
       *
       * This is the honesty half of widening the funnel, and it is the half
       * that is easy to leave out. A plan that proposes a LOCALIZATION test
       * against one application and not another, with no sentence beside the
       * omission, reads as the agent's judgement — and the two reasons are not
       * interchangeable: NOT_WARRANTED means the crawl looked and the surface
       * is not there (a finished answer), NOT_PROBED means nobody enumerated it
       * (a hole in OUR work, which a crawl-only run has a great many of).
       * UNMINTED is the third: the application EARNS the type and no `Test` row
       * can carry it, which is a gap in the product rather than in the
       * application, and it comes with the mint steps.
       */
      /*
       * THE SUFFIX IS A MACHINE-READABLE TAG, AND IT IS A COMPROMISE WITH A
       * REASON. `testPlanSchema.skipped` is `{ what, why }` and nothing else,
       * so there is no typed field for "which KIND of not-proposed this is" —
       * widening that wire shape is a schema change this round does not own.
       *
       * Without a tag the plan screen renders all three kinds as one grey list,
       * and they are not one thing: an EARNED type nobody can store is OUR
       * backlog and somebody should act on it, an unenumerated type is a hole
       * in OUR crawl, and an inapplicable type is a finished answer that needs
       * nobody. Thirty such lines, undifferentiated, bury the two entries a
       * human actually has to read. `SKIPPED_TAGS` in apps/web/lib/plan-skipped
       * .ts holds the other half of this contract and a test pins both.
       */
      ...typeCoverage.verdicts
        .filter((verdict) => verdict.decision === 'NOT_WARRANTED')
        .map((verdict) => ({
          what: `${verdict.type} tests — not applicable`,
          why: verdict.decision === 'NOT_WARRANTED' ? verdict.why : '',
        })),
      ...typeCoverage.verdicts
        .filter((verdict) => verdict.decision === 'NOT_PROBED')
        .map((verdict) => ({
          what: `${verdict.type} tests — not enumerated`,
          why: verdict.decision === 'NOT_PROBED' ? verdict.why : '',
        })),
      ...typeCoverage.unminted.map((entry) => ({
        what: `${entry.type} tests — earned, not yet storable`,
        why:
          `This application EARNS ${entry.type} tests — the enumeration found the surface it ` +
          `tests — and no test of that type can be stored yet, so none was proposed. ` +
          `${entry.remedy}`,
      })),
    ],
    /*
     * GAP ITEMS FIRST, THEN THE TYPE ITEMS. A measured gap is a stronger signal
     * than an earned type — the first is an absence this product PROVED, the
     * second is an inference from a declared rule — so the gaps keep the top of
     * the list and the cap bites the type items first.
     */
    items: [...chosen.map(planItemForGap), ...typeItems].slice(0, MAX_PLAN_ITEMS + typeItems.length),
    flowMapVersion: flowMap.version,
  };
}

// ─── The acceptance gate ────────────────────────────────────────────────────

/**
 * Whether this crawl is allowed to BE the denominator.
 *
 * TWO STEPS, in this order, and the second is not optional.
 *
 * `adjudicateCrawl` reads the counts a crawl produces when something is wrong:
 * zero nodes, rate limiting, TLS failures, an auth wall reached WITH
 * credentials, a collapse against the last accepted map.
 *
 * `holdForInterstitial` reads the one case the counts cannot see. A bot
 * challenge, a consent wall and a maintenance page all answer 200, with one
 * node, no error statuses and no throttling — so adjudication ALONE returns
 * ACCEPTED, the wall becomes the denominator, the numerator does not move, and
 * the coverage percentage goes UP on the day the customer's environment started
 * refusing us. The interstitial classifier is the only thing in the product
 * that stops that, and it can only ever make the verdict worse.
 *
 * Pure and exported so the composition is testable: the ordering is the
 * behaviour, and an inline version of it would be untestable in exactly the way
 * the old crawl was.
 */
export function adjudicateExplore(input: {
  outcome: CrawlOutcome;
  /** True when an auth profile's storageState was supplied to the crawl. */
  authenticated: boolean;
  previous: { version: number; nodeCount: number } | null;
}): CrawlAcceptance {
  const { outcome } = input;
  const adjudicated: CrawlAcceptance = adjudicateCrawl({
    nodeCount: outcome.flowMap.nodes.length,
    errorNodeCount: outcome.degradationCounts.errorNodeCount,
    loadFailureCount: outcome.degradationCounts.loadFailureCount,
    throttledCount: outcome.degradationCounts.throttledCount,
    // Exactly "a profile was supplied AND we were bounced to a login anyway".
    // Either half alone is not a degradation: an anonymous crawl SHOULD hit the
    // wall, and a profile that was never needed is not evidence of anything.
    expectedAuthButHitWall: input.authenticated && outcome.degradationCounts.authWallBounces > 0,
    tlsFailureCount: outcome.degradationCounts.tlsFailureCount,
    previous: input.previous,
  });
  return outcome.interstitial
    ? holdForInterstitial(adjudicated, outcome.interstitial)
    : adjudicated;
}

// ─── Incremental merge: a disappeared node is TWO different facts ────────────

/**
 * What a merge did, because "the denominator changed" needs a reason attached.
 *
 * `carried` is the number that matters. A node in the previous map and not in
 * this one is either GONE (the feature was deleted) or NOT REACHED (this crawl
 * ran out of budget before it got there), and those are completely different
 * facts about the application. Today every crawl writes a new version that
 * REPLACES the last, so the second case silently deletes real surface and the
 * coverage percentage goes UP — which is the lie this slice exists to remove.
 */
export interface MergeReport {
  added: number;
  /** Seen in both. The previous node's content is replaced by the fresh read. */
  refreshed: number;
  /**
   * In the previous map, not in this one, and KEPT: this crawl could not prove
   * it is gone. Carried with its previous content and counted here.
   */
  carried: number;
  /**
   * In the previous map, not in this one, and DROPPED: this enumeration
   * CONVERGED over the whole in-scope surface, so a route it did not reach is
   * a route that no longer exists.
   */
  dropped: number;
  rule: string;
}

/**
 * Merges a fresh crawl into the previous accepted map.
 *
 * THE RULE, and it is the only honest one available: a node the fresh crawl did
 * not reach is dropped ONLY when the fresh crawl is entitled to say the surface
 * does not exist — which means enumeration CONVERGED and nothing was left in
 * the frontier. Anything less and the node is CARRIED, because "we did not get
 * there" and "it is gone" produce the same absence and guessing between them is
 * the lie.
 *
 * Carrying is the conservative direction: it keeps surface in the denominator
 * that might have been removed, so the percentage is too LOW rather than too
 * high. A dropped node that was merely unreached would make the percentage go
 * up with nobody told, and that is the failure mode this product cannot have.
 */
export function mergeFlowMaps(
  previous: FlowMap | null,
  fresh: FlowMap,
  input: { converged: boolean; atLeastMoreUrls: number },
): { merged: FlowMap; report: MergeReport } {
  if (previous === null || previous.nodes.length === 0) {
    return {
      merged: fresh,
      report: {
        added: fresh.nodes.length,
        refreshed: 0,
        carried: 0,
        dropped: 0,
        rule: 'no previous accepted map to merge into, so this crawl is the whole denominator',
      },
    };
  }

  const key = (node: FlowNode): string => `${node.route}#${node.stateKey}`;
  const freshByKey = new Map(fresh.nodes.map((node) => [key(node), node]));
  const mayDrop = input.converged && input.atLeastMoreUrls === 0;

  const nodes: FlowNode[] = [...fresh.nodes];
  const nodeIds = new Set(fresh.nodes.map((node) => node.id));
  let carried = 0;
  let dropped = 0;
  let refreshed = 0;
  const carriedIds = new Map<string, string>();

  for (const node of previous.nodes) {
    if (freshByKey.has(key(node))) {
      refreshed += 1;
      continue;
    }
    if (mayDrop) {
      dropped += 1;
      continue;
    }
    /*
     * Re-identified rather than kept under its old id: the fresh map numbers
     * its nodes `node-0..n` from the schedule's deterministic order, and
     * reusing a previous id would collide with a different state.
     */
    let id = node.id;
    while (nodeIds.has(id)) id = `carried-${nodes.length}-${id}`;
    nodeIds.add(id);
    carriedIds.set(node.id, id);
    nodes.push({ ...node, id });
    carried += 1;
  }

  const edges = [...fresh.edges];
  if (carried > 0) {
    // Only edges BETWEEN carried nodes come across. An edge from a carried node
    // into the fresh graph would point at an id that means something else now.
    for (const edge of previous.edges) {
      const from = carriedIds.get(edge.from);
      const to = carriedIds.get(edge.to);
      if (from === undefined || to === undefined) continue;
      edges.push({ ...edge, id: `edge-${edges.length}`, from, to });
    }
  }

  const rule = mayDrop
    ? `enumeration converged with an empty frontier, so ${dropped} node(s) the previous map had ` +
      `and this crawl did not reach are reported as REMOVED from the application`
    : `enumeration did not converge (${input.atLeastMoreUrls} in-scope URL(s) were known and not ` +
      `visited), so ${carried} node(s) from v${previous.version} are CARRIED rather than dropped: ` +
      `"we did not reach it" and "it is gone" are different facts and this crawl cannot tell them ` +
      `apart`;

  return {
    merged: { ...fresh, nodes, edges },
    report: { added: fresh.nodes.length - refreshed, refreshed, carried, dropped, rule },
  };
}

// ─── Enumeration completeness: converged, or merely unproven ────────────────

export interface CompletenessVerdict {
  /** CONVERGED only when the frontier emptied and no cap discarded anything. */
  state: 'CONVERGED' | 'UNPROVEN';
  /**
   * The share of nodes discovered in the LAST QUARTER of the visits. A small
   * number means the discovery rate had flattened, which is SUGGESTIVE and is
   * not proof — see `why`.
   */
  tailDiscoveryRate: number | null;
  why: string;
}

/**
 * Whether a percentage may be quoted against this denominator without a caveat.
 *
 * The saturation curve is the CHEAP HALF and it is all that is implemented
 * here: new nodes per page visited, and whether that rate had flattened by the
 * end. A flattened curve is evidence that the crawl was running out of new
 * surface; it is NOT evidence that none was left, because a disconnected
 * section reached only from a page the budget never opened produces exactly the
 * same flat tail. So a flat curve downgrades nothing and upgrades nothing — it
 * is reported beside the verdict and the verdict stays UNPROVEN.
 *
 * THE HARD HALF IS NOT IMPLEMENTED: proving that no unreached component exists
 * needs the route table from the repository compared against the crawl, which
 * is the source-analysis lane's reconciliation and a slice of its own.
 */
export function enumerationCompleteness(outcome: CrawlOutcome): CompletenessVerdict {
  const lower = outcome.flowMap.frontier?.atLeastMoreUrls ?? 0;
  const tail = tailDiscoveryRate(outcome.saturation);
  if (outcome.outcome === 'CONVERGED' && lower === 0) {
    return {
      state: 'CONVERGED',
      tailDiscoveryRate: tail,
      why:
        'every discovered URL in scope was visited and no cap discarded anything, so a ' +
        'percentage quoted against this denominator is a percentage of the whole known surface',
    };
  }
  const suffix =
    tail === null
      ? ''
      : `; ${Math.round(tail * 100)}% of the nodes were discovered in the last quarter of the ` +
        `visits, which is suggestive of saturation and is NOT proof of it — a section reachable ` +
        `only from a page the budget never opened produces the same flat tail`;
  return {
    state: 'UNPROVEN',
    tailDiscoveryRate: tail,
    why:
      `enumeration stopped rather than converged: at least ${lower} in-scope URL(s) were known ` +
      `and not visited, so any percentage quoted against this denominator is a percentage of an ` +
      `unknown whole${suffix}`,
  };
}

/** Null when there were too few visits for the share to mean anything. */
function tailDiscoveryRate(
  curve: ReadonlyArray<{ visited: number; nodes: number }>,
): number | null {
  if (curve.length < 8) return null;
  const cut = Math.floor(curve.length * 0.75);
  const atCut = curve[cut - 1]?.nodes ?? 0;
  const total = curve[curve.length - 1]?.nodes ?? 0;
  if (total === 0) return null;
  return (total - atCut) / total;
}

// ─── Half the app, per identity ─────────────────────────────────────────────

/**
 * Why a login's own verdict becomes the attempt's outcome.
 *
 * `signInWithProfile` refuses in three stages before it drives anything —
 * policy, then capability, then config — and reports WHICH, with the fault and
 * the missing capability's remedy. This processor must not re-decide any of it:
 * a second opinion here about what the login module can perform is the exact
 * defect the capability record exists to prevent, one layer up. A kind this
 * worker has no adapter for would otherwise be attempted, fail, and be recorded
 * as the customer's bad password.
 *
 * COMPILER-ENFORCED over `LoginFailure`, so a tenth failure kind cannot ship
 * silently mapped to LOGIN_FAILED — which would blame a customer for whatever
 * it turns out to be. `explore.test.ts` asserts the keys are exactly
 * `LOGIN_FAILURES` at run time, because the compiler cannot check a list.
 *
 * The three that are NOT a failed login are the point:
 *
 *   UNAVAILABLE         ours, and not a login attempt at all.
 *   REFUSED_BY_POLICY   a decision, which must not read as an absence of
 *                       surface.
 *   BLOCKED             we never reached the form, which is the customer's edge
 *                       refusing us and has nothing to do with their tests.
 */
export const ROLE_OUTCOME_FOR_LOGIN_FAILURE: Record<LoginFailure, RoleCrawlOutcome> = {
  UNAVAILABLE: 'LOGIN_UNAVAILABLE',
  REFUSED_BY_POLICY: 'SKIPPED_BY_POLICY',
  BLOCKED: 'UNREACHABLE_BEHIND_BOT_PROTECTION',
  MISCONFIGURED: 'LOGIN_FAILED',
  MISSING_SECRET: 'LOGIN_FAILED',
  REJECTED: 'LOGIN_FAILED',
  TIMED_OUT: 'LOGIN_FAILED',
  DRIVER_ERROR: 'LOGIN_FAILED',
  NOT_CAPTURED: 'LOGIN_FAILED',
};

/**
 * How many authenticated identities one explore job crawls.
 *
 * FOUR, and the number is a cost decision rather than a technical one: the
 * budget is MULTIPLIED (see {@link RoleBudgetDisclosure}), so five passes is
 * five crawls of the application, and a customer with thirty profiles on one
 * environment would otherwise get a thirty-one-pass job. Four covers the shape
 * nearly every application has — owner, admin, member, viewer — and whatever
 * the cap discards is reported as a COUNT and a REASON rather than quietly
 * dropped, so the report can say "at least 26 more roles existed".
 */
export const MAX_ROLE_PASSES = 4;

/** One identity a pass will be run as. */
export interface RoleIdentity {
  authProfileId: string;
  profileName: string;
  /** `roleKey()`-spelled, so it joins RouteAccessCell.role and the matrix. */
  role: string;
  /**
   * True when `role` came from the profile's NAME because `AuthProfile.role`
   * was null.
   *
   * DISCLOSED rather than smoothed over. A null role means "this profile
   * predates the column and nobody said what it is", which must not be read as
   * anonymous — and the name is what the crawler has always passed as its
   * `role`, so falling back to it keeps today's behaviour instead of silently
   * dropping the profile. But a name is not a role declaration: "Ahmad's test
   * login" is not a role, and a reader comparing roles across environments has
   * to know which column the string came from.
   */
  roleFromName: boolean;
  kind: AuthProfileKind;
}

/** An identity that will NOT be crawled, and whose fault that is. */
export interface RolePassSkip {
  role: string;
  profileName: string;
  authProfileId: string;
  outcome: RoleCrawlOutcome;
  detail: string;
  remedy: string | null;
}

/**
 * What N roles cost, stated rather than hidden.
 *
 * ── MULTIPLIED, NOT DIVIDED, AND WHY ───────────────────────────────────────
 *
 * The two options are to divide one page budget across the passes or to spend
 * one budget per pass. Dividing is cheaper and it is the wrong answer here:
 * today's accepted denominator was produced by ONE full-budget pass, so giving
 * each pass a quarter of it would make the next crawl enumerate a quarter as
 * much per identity and the union smaller than the map it replaces. The shrink
 * test would then either hold a perfectly good crawl or — worse, on an
 * application whose roles overlap heavily — accept a denominator that got
 * smaller because we started measuring MORE of the application. A cap that
 * shrinks the thing the product sells is not a saving.
 *
 * So each pass gets the environment's own budget, the total is reported, and
 * the pass count is the multiplier a reader can see.
 */
export interface RoleBudgetDisclosure {
  strategy: 'MULTIPLIED';
  /** 1 anonymous + the authenticated identities. */
  passes: number;
  rolesProbed: number;
  /** Every distinct role the environment declares, before the cap. */
  rolesDeclared: number;
  /** Non-null exactly when the cap bit. A floor, never an estimate. */
  atLeastMoreRoles: number | null;
  cappedBy: string | null;
  why: string;
}

export interface RolePassPlan {
  identities: RoleIdentity[];
  skipped: RolePassSkip[];
  /** Profiles dropped because another profile already covers their role. */
  duplicates: Array<{ role: string; profileName: string; keptProfileName: string }>;
  disclosure: RoleBudgetDisclosure;
}

/**
 * Decides which identities get a pass, before any browser is launched.
 *
 * Pure, and it decides only what `signInWithProfile` cannot: a profile that
 * cannot be attributed to a ROLE at all, two profiles that are the same role,
 * and the per-job cap. Whether a KIND can be performed here, and whether it is
 * permitted against this environment, are deliberately NOT decided here — the
 * login module owns both, refuses before it drives anything, and reports which
 * stage refused with the remedy attached. See
 * {@link ROLE_OUTCOME_FOR_LOGIN_FAILURE}.
 */
export function planRolePasses(input: {
  profiles: ReadonlyArray<{ id: string; name: string; kind: AuthProfileKind; role: string | null }>;
  maxRolePasses?: number;
}): RolePassPlan {
  const cap = input.maxRolePasses ?? MAX_ROLE_PASSES;
  const identities: RoleIdentity[] = [];
  const skipped: RolePassSkip[] = [];
  const duplicates: RolePassPlan['duplicates'] = [];
  const claimed = new Map<string, string>();

  for (const profile of input.profiles) {
    const declared = profile.role === null ? '' : profile.role.trim();
    const fallback = profile.name.trim();
    /*
     * `roleKey('')` returns the reserved `<anonymous>` spelling, which is a
     * claim about a logged-OUT visitor — the opposite of an unlabelled
     * logged-in one. A profile with neither a role nor a usable name cannot be
     * put in the role axis without making that claim, so it is refused with the
     * reason instead.
     */
    if (declared === '' && fallback === '') {
      skipped.push({
        role: ANONYMOUS_ROLE,
        profileName: profile.name,
        authProfileId: profile.id,
        outcome: 'NEVER_ATTEMPTED',
        detail:
          'this profile declares no role and has no usable name, so a crawl as it could not be ' +
          'attributed to any role without claiming it is the anonymous visitor',
        remedy: "Set this profile's role to the identity the application sees, e.g. admin.",
      });
      continue;
    }

    const role = roleKey(declared === '' ? fallback : declared);
    const keptBy = claimed.get(role);
    if (keptBy !== undefined) {
      // Not a skipped ROLE: the role IS being crawled, by the older profile.
      // Recording an attempt here would also collide with
      // RoleCrawlAttempt's unique (environment, role).
      duplicates.push({ role, profileName: profile.name, keptProfileName: keptBy });
      continue;
    }

    claimed.set(role, profile.name);
    identities.push({
      authProfileId: profile.id,
      profileName: profile.name,
      role,
      roleFromName: declared === '',
      kind: profile.kind,
    });
  }

  const declaredRoles = claimed.size;
  const overflow = identities.slice(cap);
  for (const identity of overflow) {
    skipped.push({
      role: identity.role,
      profileName: identity.profileName,
      authProfileId: identity.authProfileId,
      outcome: 'SKIPPED_BY_POLICY',
      detail: `only ${cap} authenticated identities are crawled per job and this one is beyond that`,
      remedy:
        'Remove a profile this environment no longer needs, or run the Explorer again once the ' +
        'per-job role cap is configurable.',
    });
  }
  const probed = identities.slice(0, cap);

  return {
    identities: probed,
    skipped,
    duplicates,
    disclosure: {
      strategy: 'MULTIPLIED',
      passes: probed.length + 1,
      rolesProbed: probed.length,
      rolesDeclared: declaredRoles,
      atLeastMoreRoles: overflow.length > 0 ? overflow.length : null,
      cappedBy: overflow.length > 0 ? `MAX_ROLE_PASSES=${cap}` : null,
      why:
        `${probed.length + 1} crawl(s) of this application — one anonymous and ${probed.length} ` +
        `authenticated — each with the environment's FULL page budget rather than a share of it, ` +
        `so the per-role denominators are comparable to the single-identity crawl they replace. ` +
        `Cost is ${probed.length + 1}× one crawl` +
        (overflow.length > 0
          ? `; at least ${overflow.length} more role(s) exist and were not crawled because the ` +
            `per-job cap of ${cap} bit`
          : '') +
        '.',
    },
  };
}

// ─── Running the passes ──────────────────────────────────────────────────────

/**
 * What one pass produced, with the attempt's verdict attached.
 *
 * `contributed` and `outcome` carry different information and both are stored.
 * A pass can have run to completion and still not contribute — a bot wall
 * answers 200 on every URL — and a pass that never got a session contributes
 * nothing for a completely different reason. Collapsing the two is the lie rule
 * ten names: a login that FAILED recorded as a crawl that found nothing behind
 * the wall.
 */
export interface RolePassResult {
  /** Null for the anonymous pass, which needs no profile and always runs. */
  identity: RoleIdentity | null;
  role: string;
  outcome: RoleCrawlOutcome;
  detail: string | null;
  remedy: string | null;
  /** Null when no crawl ran at all. */
  acceptance: CrawlAcceptance | null;
  crawl: CrawlOutcome | null;
  /** Whether this pass's nodes may enter the union and its cells be stored. */
  contributed: boolean;
  /** NULL unless the crawl ran: a zero here would be a measurement. */
  routesReached: number | null;
  cappedBy: string | null;
  atLeastMoreRoutes: number | null;
}

/** The injected surfaces. Neither can exist in a unit test. */
export interface RolePassDeps {
  /**
   * One crawl. `storageState: undefined` is the anonymous pass — the honest one,
   * and the only one that needs no capability at all.
   */
  crawl(input: { role: string | null; storageState: unknown }): Promise<CrawlOutcome>;
  /**
   * Sign one identity in. `storageState: null` with `ok: true` is a real and
   * distinct answer: an SSO bypass token is a HEADER, not a session, so there is
   * nothing for the crawler to carry.
   *
   * The `failure` report is `LoginResult`'s own, unmodified: this processor maps
   * it to an attempt outcome and never re-derives it.
   */
  signIn(identity: RoleIdentity): Promise<
    Pick<LoginResult, 'ok' | 'storageState' | 'message' | 'failure'>
  >;
}

/**
 * The anonymous pass, then one pass per identity, each adjudicated on its own.
 *
 * ── WHY ANONYMOUS GOES FIRST, AND WHY IT GOES AT ALL ───────────────────────
 *
 * Because labelling the auth wall and seeing behind it are mutually exclusive
 * in one pass. With a valid `storageState` the crawler never gets bounced, so
 * `behindAuth` is FALSE EVERYWHERE and the product cannot tell a customer where
 * their auth boundary is — while without one, everything behind the wall is
 * simply absent. Two passes, merged, is the only way to hold both facts: this
 * route was reachable logged out, and this route was reachable as admin.
 *
 * ── WHY EACH PASS IS ADJUDICATED SEPARATELY, AND AGAINST NO BASELINE ───────
 *
 * `previous` is deliberately not passed to the per-pass gate. The shrink test
 * compares a crawl against the last ACCEPTED map, and an anonymous pass of an
 * application that is 90% behind a login SHOULD be a tenth of it — adjudicating
 * that against the baseline would report the one pass that finds the wall as a
 * collapse, every time. The shrink test belongs to the UNION, which is the
 * thing that replaces the denominator; see `adjudicateUnion`.
 */
export async function runRolePasses(
  deps: RolePassDeps,
  plan: RolePassPlan,
): Promise<RolePassResult[]> {
  const results: RolePassResult[] = [];

  const anonymous = await deps.crawl({ role: null, storageState: undefined });
  results.push(
    passResultFrom({
      identity: null,
      role: ANONYMOUS_ROLE,
      crawl: anonymous,
      acceptance: adjudicateExplore({ outcome: anonymous, authenticated: false, previous: null }),
      authenticated: false,
    }),
  );

  for (const skip of plan.skipped) {
    results.push({
      identity: null,
      role: skip.role,
      outcome: skip.outcome,
      detail: `${skip.profileName}: ${skip.detail}`,
      remedy: skip.remedy,
      acceptance: null,
      crawl: null,
      contributed: false,
      routesReached: null,
      cappedBy: null,
      atLeastMoreRoutes: null,
    });
  }

  for (const identity of plan.identities) {
    const signIn = await deps.signIn(identity);
    if (!signIn.ok) {
      /*
       * The login module's verdict, carried through rather than re-decided.
       * LOGIN_UNAVAILABLE and LOGIN_FAILED are the two facts rule ten is about —
       * one is ours and one is theirs — and the login module is the only thing
       * that knows which, because it knows which stage refused.
       */
      const failure = signIn.failure;
      results.push({
        identity,
        role: identity.role,
        outcome: failure ? ROLE_OUTCOME_FOR_LOGIN_FAILURE[failure.kind] : 'LOGIN_FAILED',
        detail: `${identity.profileName}: ${signIn.message}`,
        remedy:
          failure?.unavailable?.remedy ??
          (failure?.fault === 'OURS'
            ? `This is ours to fix: ${failure.kind} at the ${failure.step} step of the ` +
              `"${identity.profileName}" profile.`
            : `Check the credentials and the success locator on the "${identity.profileName}" ` +
              `profile, then run the Explorer again.`),
        acceptance: null,
        crawl: null,
        contributed: false,
        routesReached: null,
        cappedBy: null,
        atLeastMoreRoutes: null,
      });
      continue;
    }
    if (signIn.storageState === null) {
      /*
       * Signed in, and the identity cannot be CARRIED. An SSO bypass token is a
       * header the crawler has no way to send, so crawling now would produce an
       * ANONYMOUS crawl labelled with this role's name — the worst available
       * outcome, because every cell in it would be a confident lie about an
       * identity that was never used.
       */
      results.push({
        identity,
        role: identity.role,
        outcome: 'LOGIN_UNAVAILABLE',
        detail:
          `the "${identity.profileName}" profile authenticates with a header rather than a ` +
          `session, and the crawler cannot yet send one — so a crawl as this role would in fact ` +
          `be an anonymous crawl under this role's name`,
        remedy:
          'Use a FORM_LOGIN or COOKIE_INJECTION profile for enumeration, or wait for the crawler ' +
          'to carry this environment\'s extra headers.',
        acceptance: null,
        crawl: null,
        contributed: false,
        routesReached: null,
        cappedBy: null,
        atLeastMoreRoutes: null,
      });
      continue;
    }

    const crawl = await deps.crawl({ role: identity.role, storageState: signIn.storageState });
    results.push(
      passResultFrom({
        identity,
        role: identity.role,
        crawl,
        acceptance: adjudicateExplore({ outcome: crawl, authenticated: true, previous: null }),
        authenticated: true,
      }),
    );
  }

  return results;
}

/**
 * Turns one finished crawl into an attempt row.
 *
 * The three demotions here are the ones that keep zero rows meaningful:
 *
 *   · a bot challenge that BLOCKS enumeration is
 *     UNREACHABLE_BEHIND_BOT_PROTECTION — we never reached the application, let
 *     alone the form, and reporting it as a crawl that found one page would put
 *     the wall in the denominator;
 *   · an authenticated pass that was bounced to a login is LOGIN_FAILED even
 *     though the sign-in reported success, because the crawl is the better
 *     witness: the session we captured was not honoured, and recording
 *     "we got in" against a crawl that says otherwise is the contradiction rule
 *     ten forbids;
 *   · anything else that was not ACCEPTED keeps its CRAWLED/CRAWLED_PARTIAL
 *     outcome — the crawl did run — and loses `contributed`, so its statuses
 *     are kept as evidence about the crawl and never stored as access facts.
 */
function passResultFrom(input: {
  identity: RoleIdentity | null;
  role: string;
  crawl: CrawlOutcome;
  acceptance: CrawlAcceptance;
  authenticated: boolean;
}): RolePassResult {
  const { crawl, acceptance } = input;
  const accepted = acceptance.state === 'ACCEPTED';
  const partial =
    crawl.outcome !== 'CONVERGED' || (crawl.flowMap.frontier?.atLeastMoreUrls ?? 0) > 0;

  let outcome: RoleCrawlOutcome = partial ? 'CRAWLED_PARTIAL' : 'CRAWLED';
  let detail: string | null = null;
  let remedy: string | null = null;

  if (crawl.interstitial?.blocksEnumeration && crawl.interstitial.kind === 'BOT_CHALLENGE') {
    outcome = 'UNREACHABLE_BEHIND_BOT_PROTECTION';
    detail = crawl.interstitial.reason;
    remedy =
      'Configure this non-production environment with your bot-protection provider\'s documented ' +
      'test keys, allowlist QAAI at your edge, or issue a signed bypass header for this ' +
      'environment and store its value in the vault.';
  } else if (input.authenticated && crawl.degradationCounts.authWallBounces > 0) {
    outcome = 'LOGIN_FAILED';
    detail =
      `signed in as this role and the crawl was still bounced to a login on ` +
      `${crawl.degradationCounts.authWallBounces} navigation(s), so the captured session was not ` +
      `honoured`;
    remedy =
      'The session expired or is scoped to a different origin. Check the success locator and the ' +
      'cookie domain on this profile.';
  } else if (!accepted) {
    detail = `the crawl ran and was held as ${acceptance.state}: ${acceptance.reasons.join('; ')}`;
  }

  const contributed = accepted && outcome !== 'UNREACHABLE_BEHIND_BOT_PROTECTION';
  const atLeastMore = crawl.flowMap.frontier?.atLeastMoreUrls ?? 0;

  return {
    identity: input.identity,
    role: input.role,
    outcome,
    detail,
    remedy,
    acceptance,
    crawl,
    contributed,
    /*
     * NULL unless the pass contributed. A zero here reads as "this role reached
     * nothing", which is a measurement; the whole reason the column is nullable
     * is that a held crawl has not measured anything at all.
     */
    routesReached: contributed ? new Set(crawl.flowMap.nodes.map((node) => node.route)).size : null,
    cappedBy: contributed && partial ? crawl.stoppedBecause : null,
    atLeastMoreRoutes: contributed && atLeastMore > 0 ? atLeastMore : null,
  };
}

// ─── Merging the passes into one map ─────────────────────────────────────────

/**
 * What the union did, as sentences a report can print.
 *
 * `rolesContributing` is the number a reader needs beside the node count: a
 * union of one pass and a union of five are different objects and look
 * identical once they are a single number.
 */
export interface RoleMergeReport {
  rolesContributing: number;
  rolesRefused: number;
  nodesFromAnonymous: number;
  /** Nodes no anonymous visitor reached. The half of the app that was absent. */
  nodesBehindAuth: number;
  /** Routes reached by an identity and never by the anonymous pass. */
  routesOnlyAuthenticated: number;
  /** Routes the anonymous pass reached and no identity did. */
  routesOnlyAnonymous: number;
  rule: string;
}

/**
 * Unions the passes, attributing every node to the roles that reached it.
 *
 * ── THE TWO FACTS EVERY NODE NOW CARRIES ───────────────────────────────────
 *
 *   `requiresRoles`  the roles that reached it, and EMPTY when the anonymous
 *                    pass reached its route — which is the field's documented
 *                    meaning ("empty = reachable logged out") and has never
 *                    once been written with a value, because the crawler sets
 *                    `[]` unconditionally.
 *   `behindAuth`     true on POSITIVE anonymous evidence of a wall: the
 *                    anonymous pass asked for this route and was refused or
 *                    bounced to the login. Not "the authenticated pass did not
 *                    get bounced", which is what it meant before and is why it
 *                    was false everywhere a profile existed.
 *
 * `access` carries the per-role cells, which is where "reachable anonymously"
 * and "reachable as admin" stop being one boolean and become the matrix.
 *
 * ── WHAT IS NOT INFERRED ───────────────────────────────────────────────────
 *
 * A node only another role reached gets NO anonymous cell. It does not get a
 * cell saying the anonymous visitor was refused: nobody asked. That absence is
 * exactly what `buildAccessMatrix` turns into a NOT_PROBED cell with a reason,
 * and inventing a refusal here would be the fabrication the whole axis exists
 * to avoid.
 */
export function mergeRolePasses(
  passes: readonly RolePassResult[],
  base: FlowMap,
): { merged: FlowMap; report: RoleMergeReport; probes: RoleProbe[] } {
  const contributing = passes.filter((pass) => pass.contributed && pass.crawl !== null);
  const anonymous = contributing.find((pass) => pass.role === ANONYMOUS_ROLE) ?? null;

  /** route → the anonymous pass's own cell for it, when it probed it. */
  const anonymousByRoute = new Map<string, RouteAccess>();
  if (anonymous?.crawl) {
    for (const node of anonymous.crawl.flowMap.nodes) {
      const cell = node.access?.[0];
      if (cell && !anonymousByRoute.has(node.route)) anonymousByRoute.set(node.route, cell);
    }
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const journeys: Journey[] = [];
  const ids = new Set<string>();
  const index = new Map<string, number>();
  const rolesByRoute = new Map<string, Set<string>>();
  const probes: RoleProbe[] = [];

  for (const pass of passes) {
    const observations: RouteProbeObservation[] = [];
    if (pass.contributed && pass.crawl) {
      for (const node of pass.crawl.flowMap.nodes) {
        const cell = node.access?.[0];
        observations.push({
          routeTemplate: node.route,
          /*
           * NULL rather than a guess when the crawl recorded no cell. A node
           * with no access cell predates the ledger or came from a path that
           * does not record one, and `routeAccessOutcomeFrom` turns a null
           * coarse outcome into NOT_PROBED — which is correct: we have the node
           * and no evidence about what answered for it.
           */
          observed: cell?.outcome ?? null,
          status: cell?.status ?? node.status?.code ?? null,
          /*
           * WHERE WE LANDED, AND NEVER WHERE WE ASKED.
           *
           * This was `cell?.destinationRoute ?? node.url` and the fallback made
           * every login page report as REDIRECTED_TO_LOGIN for every role that
           * was SERVED it. `routeAccessOutcomeFrom` uses this field for the
           * soft-redirect test — a 200 that landed on the login wall is the
           * wall working, not the route being served — and it compares it
           * against the environment's login globs. `node.url` is `nav.finalUrl`
           * and `loginRoutesFrom` puts every `looksLikeAuthPath` route in those
           * globs, so asking for /login, being served /login with a 200, and
           * handing /login in as the landing URL matched the glob and stored
           * "this role was sent to the login wall" about a route the
           * application had just served. On the anonymous column it read as a
           * logged-out visitor being bounced off the login page.
           *
           * NOTHING IS LOST BY DROPPING THE FALLBACK. `observe.ts` sets
           * `destinationRoute` to the final route for every outcome it labels
           * REDIRECTED, which is exactly the cases where the browser MOVED —
           * a hard 3xx, an off-origin hop, an auth wall, and the soft
           * client-side navigation the test exists for. It is null only for
           * NONE and ERROR_STATUS, and both mean the browser stayed put: there
           * is no second URL to report, so null is the honest value and the
           * glob test correctly does not fire.
           */
          finalUrl: cell?.destinationRoute ?? null,
          observedAtIso: cell?.observedAtIso ?? pass.crawl.flowMap.exploredAt,
        });
      }
    }
    probes.push({
      role: pass.role,
      authProfileId: pass.identity?.authProfileId ?? null,
      attemptId: null,
      outcome: pass.outcome,
      contributed: pass.contributed,
      detail: pass.detail,
      observations,
    });
  }

  for (const pass of contributing) {
    const crawl = pass.crawl;
    if (!crawl) continue;
    const renamed = new Map<string, string>();

    for (const node of crawl.flowMap.nodes) {
      const roles = rolesByRoute.get(node.route) ?? new Set<string>();
      if (pass.role !== ANONYMOUS_ROLE) roles.add(pass.role);
      rolesByRoute.set(node.route, roles);

      const key = `${node.route}#${node.stateKey}`;
      const at = index.get(key);
      const cell = node.access?.[0];
      if (at !== undefined) {
        /*
         * The same state reached by two identities is ONE node with two cells.
         * Keeping two would double the denominator for every shared page, which
         * on a typical application is most of it.
         */
        const existing = nodes[at];
        if (existing && cell) existing.access = [...(existing.access ?? []), cell];
        if (existing) renamed.set(node.id, existing.id);
        continue;
      }
      let id = node.id;
      while (ids.has(id)) id = `${pass.role}-${id}`;
      ids.add(id);
      renamed.set(node.id, id);
      index.set(key, nodes.length);
      nodes.push({ ...node, id, access: cell ? [cell] : (node.access ?? []) });
    }

    for (const edge of crawl.flowMap.edges) {
      const from = renamed.get(edge.from);
      const to = renamed.get(edge.to);
      if (from === undefined || to === undefined) continue;
      edges.push({ ...edge, id: `edge-${edges.length}`, from, to });
    }
    for (const journey of crawl.flowMap.journeys) {
      journeys.push({
        ...journey,
        id: journeys.some((existing) => existing.id === journey.id)
          ? `${pass.role}-${journey.id}`
          : journey.id,
        // The journey's own role axis, which was likewise always empty.
        roles: pass.role === ANONYMOUS_ROLE ? [] : [pass.role],
      });
    }
  }

  let nodesBehindAuth = 0;
  for (const node of nodes) {
    const anonymousCell = anonymousByRoute.get(node.route);
    const servedAnonymously = anonymousCell?.outcome === 'ALLOWED';
    const walled =
      anonymousCell !== undefined &&
      (anonymousCell.outcome === 'DENIED' || anonymousCell.outcome === 'REDIRECTED');
    node.requiresRoles = servedAnonymously ? [] : [...(rolesByRoute.get(node.route) ?? [])].sort();
    /*
     * `behindAuth` stays whatever the node's own pass said unless the anonymous
     * pass has positive evidence either way. False is not a measurement here —
     * it is the field's default — so an un-probed route keeps its pass's value
     * rather than being asserted public.
     */
    if (walled) node.behindAuth = true;
    else if (servedAnonymously) node.behindAuth = false;
    if (node.behindAuth) nodesBehindAuth += 1;
  }

  const authenticatedRoutes = new Set<string>();
  for (const [route, roles] of rolesByRoute) if (roles.size > 0) authenticatedRoutes.add(route);
  const anonymousRoutes = new Set(
    anonymous?.crawl?.flowMap.nodes.map((node) => node.route) ?? [],
  );

  const refused = passes.filter((pass) => !pass.contributed).length;
  return {
    merged: { ...base, nodes, edges, journeys },
    report: {
      rolesContributing: contributing.length,
      rolesRefused: refused,
      nodesFromAnonymous: anonymous?.crawl?.flowMap.nodes.length ?? 0,
      nodesBehindAuth,
      routesOnlyAuthenticated: [...authenticatedRoutes].filter(
        (route) => !anonymousRoutes.has(route),
      ).length,
      routesOnlyAnonymous: [...anonymousRoutes].filter(
        (route) => !authenticatedRoutes.has(route),
      ).length,
      rule:
        `${contributing.length} pass(es) contributed to this denominator and ${refused} did not; ` +
        `a pass that was refused or held contributes NO nodes and NO access cells, so a role we ` +
        `could not crawl is never counted as a role with no extra surface`,
    },
    probes,
  };
}

/** One role's line in the report, with the one answer that may be null. */
export interface RoleAttemptReport {
  role: string;
  outcome: RoleCrawlOutcome;
  contributed: boolean;
  routesReached: number | null;
  routesNewToThisRole: number | null;
  /**
   * Whether this role turned out to have no surface the others do not — NULL
   * when the question cannot be answered.
   *
   * NULL IS THE POINT, and it is why this goes through
   * `roleHadNoExtraSurface` rather than being computed here. The tempting local
   * version is `routesNewToThisRole === 0`, which answers TRUE for a crawl that
   * was CAPPED at zero new routes — and the routes it did not reach are exactly
   * the ones in question. "We could not finish crawling as admin" and "admin
   * sees nothing extra" are different sentences and only one of them is safe.
   */
  hadNoExtraSurface: boolean | null;
  cappedBy: string | null;
  atLeastMoreRoutes: number | null;
  detail: string | null;
  remedy: string | null;
}

/** The report line for one pass. Pure, so the null above is testable. */
export function roleAttemptReport(
  pass: RolePassResult,
  passes: readonly RolePassResult[],
): RoleAttemptReport {
  const routesNewToThisRole = pass.contributed ? routesNewToRole(pass, passes) : null;
  return {
    role: pass.role,
    outcome: pass.outcome,
    contributed: pass.contributed,
    routesReached: pass.routesReached,
    routesNewToThisRole,
    hadNoExtraSurface: roleHadNoExtraSurface({ outcome: pass.outcome, routesNewToThisRole }),
    cappedBy: pass.cappedBy,
    atLeastMoreRoutes: pass.atLeastMoreRoutes,
    detail: pass.detail,
    remedy: pass.remedy,
  };
}

/**
 * Stored attempts for roles this environment no longer has an identity for.
 *
 * ── THE LIE THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `RoleCrawlAttempt` is the CURRENT state per role per environment, upserted
 * rather than appended. So when a profile is deleted between crawls its row
 * SURVIVES, and a reader asking "what is the admin situation" gets a CRAWLED
 * row with route counts on it for a role this environment cannot be any more.
 * The row is not wrong about the past and it is wrong about the present, which
 * is the worst combination available: it renders as current.
 *
 * Not deleted, and deliberately. The measurement happened and deleting it to
 * tidy the table would destroy a fact; what it needs is the sentence beside it,
 * which is what this returns. Dropping the row is also the one action that
 * cannot be undone from here, and a profile can come back.
 */
export function staleRoleAttempts(
  stored: ReadonlyArray<{ role: string; outcome: RoleCrawlOutcome; attemptedAt: Date | null }>,
  currentRoles: readonly string[],
): Array<{ role: string; outcome: RoleCrawlOutcome; attemptedAt: Date | null; why: string }> {
  const current = new Set(currentRoles);
  return stored
    .filter((row) => !current.has(row.role))
    .map((row) => ({
      ...row,
      why:
        `the stored crawl attempt for role ${row.role} (${row.outcome}` +
        `${row.attemptedAt === null ? '' : `, ${row.attemptedAt.toISOString()}`}) belongs to an ` +
        `identity this environment no longer has, so it describes the past and not this ` +
        `denominator`,
    }));
}

/**
 * How many routes this pass reached that NO other contributing pass did.
 *
 * The number `roleHadNoExtraSurface` reads, and the reason it is nullable at
 * the column: a zero from a pass that CONVERGED means this identity genuinely
 * sees nothing the others do not, and a zero from a pass that was capped means
 * the routes in question are precisely the ones it did not get to. The caller
 * stores null for every pass that did not contribute, so a role we could not
 * crawl never produces a zero at all.
 *
 * Counted against CONTRIBUTING passes only. Comparing against a held pass's
 * nodes would let a bot wall's single page make every real route look shared.
 */
export function routesNewToRole(
  pass: RolePassResult,
  passes: readonly RolePassResult[],
): number | null {
  if (!pass.contributed || !pass.crawl) return null;
  const others = new Set<string>();
  for (const other of passes) {
    if (other === pass || !other.contributed || !other.crawl) continue;
    for (const node of other.crawl.flowMap.nodes) others.add(node.route);
  }
  const mine = new Set(pass.crawl.flowMap.nodes.map((node) => node.route));
  return [...mine].filter((route) => !others.has(route)).length;
}

/**
 * Where this application's login wall is, as the anonymous pass found it.
 *
 * Observed rather than configured, and that is the point: the wall is wherever
 * the application SENT a logged-out visitor, which is a measurement. A profile
 * config's `loginUrl` is the customer's claim about the same thing and is not
 * read here — partly because the claim and the behaviour can differ, and partly
 * because the config is a credential-adjacent object this processor has no
 * reason to open.
 *
 * `looksLikeAuthPath` is the crawler's own predicate, imported rather than
 * re-expressed, so "is this the sign-in surface" has one implementation and the
 * matrix cannot disagree with the bounce ledger that produced its cells.
 */
export function loginRoutesFrom(passes: readonly RolePassResult[]): string[] {
  const routes = new Set<string>();
  for (const pass of passes) {
    if (pass.role !== ANONYMOUS_ROLE || !pass.contributed || !pass.crawl) continue;
    for (const node of pass.crawl.flowMap.nodes) {
      // Positive evidence: an auth wall bounced us, and this is where to.
      if (node.behindAuth) {
        const destination = node.access?.[0]?.destinationRoute;
        if (destination) routes.add(destination);
      }
      if (looksLikeAuthPath(node.route)) routes.add(node.route);
    }
  }
  return [...routes].sort();
}

/**
 * Adjudicates the UNION, which is the thing that replaces the denominator.
 *
 * The shrink test lives here and nowhere else, for the reason `runRolePasses`
 * gives: a single pass is not comparable to a baseline built from several. The
 * degradation counts are SUMMED across contributing passes — five passes
 * against a rate-limited host see five times the throttling and it is all
 * evidence about the same host — and any contributing pass's blocking
 * interstitial holds the union, because a wall that got into the union taints
 * it whichever identity met it. A REFUSED pass cannot taint anything: it
 * contributed nothing to taint.
 */
export function adjudicateUnion(input: {
  passes: readonly RolePassResult[];
  nodeCount: number;
  previous: { version: number; nodeCount: number } | null;
}): CrawlAcceptance {
  const contributing = input.passes.filter((pass) => pass.contributed && pass.crawl !== null);
  const sum = (pick: (counts: CrawlOutcome['degradationCounts']) => number): number =>
    contributing.reduce(
      (total, pass) => total + (pass.crawl ? pick(pass.crawl.degradationCounts) : 0),
      0,
    );

  let acceptance = adjudicateCrawl({
    nodeCount: input.nodeCount,
    errorNodeCount: sum((counts) => counts.errorNodeCount),
    loadFailureCount: sum((counts) => counts.loadFailureCount),
    throttledCount: sum((counts) => counts.throttledCount),
    /*
     * The union's own version of "a profile was supplied and we hit the wall
     * anyway". Only an AUTHENTICATED pass can say it, and a pass that was
     * demoted to LOGIN_FAILED for exactly this reason is not contributing, so
     * this is about a pass that otherwise looked healthy.
     */
    expectedAuthButHitWall: contributing.some(
      (pass) =>
        pass.identity !== null && (pass.crawl?.degradationCounts.authWallBounces ?? 0) > 0,
    ),
    tlsFailureCount: sum((counts) => counts.tlsFailureCount),
    previous: input.previous,
  });

  for (const pass of contributing) {
    const interstitial = pass.crawl?.interstitial;
    if (interstitial) acceptance = holdForInterstitial(acceptance, interstitial);
  }
  return acceptance;
}

export async function processExplore(job: ExploreJob): Promise<void> {
  const { orgId, projectId, environmentId } = job;

  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, orgId },
    // `crawlPolicy` is the whole point of the configurable budget: the crawl's
    // scope is reviewable on the environment it applies to, which an
    // environment variable or a hard-coded 25 is not.
    //
    // `kind` is read for `SignInContext.environmentKind`, which is required
    // with no default: `signInWithProfile` refuses MOCK_IDP on PRODUCTION —
    // minting an assertion against a real system is forging a real identity —
    // and a refusal that depends on a caller remembering an argument is not a
    // refusal.
    select: { id: true, baseUrl: true, projectId: true, crawlPolicy: true, kind: true },
  });
  if (!environment) throw new Error(`Environment ${environmentId} not found for org ${orgId}`);

  /*
   * ── TWO LOOKUPS, NOT ONE, AND THE FILTER IS THE POINT ──────────────────────
   *
   * `newest` is for the VERSION NUMBER, which must not collide with a row that
   * already exists however degraded it was.
   *
   * `accepted` is for everything else — the merge baseline, the shrink
   * comparison and the resume point — and it filters `acceptance: 'ACCEPTED'`.
   * Without that filter a crawl run while the site was down becomes the
   * baseline for the NEXT crawl's shrink test, so the collapse is only ever
   * detected once and the degraded denominator becomes the new normal.
   * `acceptance: null` is included: it is every row written before adjudication
   * existed, and it is not evidence of degradation.
   */
  const [newest, accepted] = await Promise.all([
    prisma.flowMap.findFirst({
      where: { orgId, projectId, environmentId },
      orderBy: { version: 'desc' },
      select: { version: true },
    }),
    prisma.flowMap.findFirst({
      where: {
        orgId,
        projectId,
        environmentId,
        OR: [{ acceptance: 'ACCEPTED' }, { acceptance: null }],
      },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, nodeCount: true, graph: true },
    }),
  ]);
  const version = (newest?.version ?? 0) + 1;

  const previousMap = (accepted?.graph ?? null) as FlowMap | null;
  /*
   * THE REGISTER ITEM: "an incremental crawl that merges into the previous
   * map". The blocker was that the queue lived in a local `const` inside
   * `crawl()`, so an application over the cap could never be fully enumerated
   * however often it ran — every run started at the base URL and stopped at the
   * same budget. The snapshot is only taken from an ACCEPTED crawl: a resume
   * point whose visited set is full of bot-wall pages would make the next crawl
   * SKIP the real ones.
   */
  const resumeFrom = resumePointFrom(accepted?.graph ?? null);
  const resume = resumeAdvice(resumeFrom);

  const [subscription, org] = await Promise.all([
    prisma.subscription.findUnique({ where: { orgId }, select: { plan: true, status: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  ]);
  const orgPlan: Plan = effectivePlan(subscription, org?.plan ?? null).effective;

  /*
   * The environment's auth profiles, read once and used for two different
   * things.
   *
   * The FIRST is the crawl: a cached storageState lets the crawler get past the
   * login wall and see the half of the app that actually matters (§2), and the
   * oldest profile is the one used, as it always has been.
   *
   * The SECOND is new and is the point of this read being a findMany rather
   * than a findFirst: the plan. An item for a page behind the wall has to name
   * the role its test will assume, and it can only name a role it has been
   * shown. Id, name and kind only — choosing which role a test runs as needs
   * neither the config nor the live session, and both of those travel into plan
   * text that people read.
   */
  const profiles = await prisma.authProfile.findMany({
    where: { orgId, environmentId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      kind: true,
      // THE ROLE AXIS. Null means "nobody said what this profile is", which
      // `planRolePasses` falls back from and DISCLOSES rather than reading as
      // the anonymous visitor.
      role: true,
      config: true,
      storageState: true,
      storageStateExpiresAt: true,
    },
  });
  const authProfileChoices: AuthProfileChoice[] = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
  }));

  logger.info({ projectId, baseUrl: environment.baseUrl, version }, 'crawl starting');
  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'log',
    data: { message: `Crawling ${environment.baseUrl}` },
    at: new Date().toISOString(),
  });

  /*
   * ── THE CONFIGURABLE BUDGET, END TO END ────────────────────────────────────
   *
   * `job.maxPages`/`maxDepth` are the API's hard-coded 25/3, clamped at 60/6 by
   * routes/agent.ts. They are now treated as an OPTIONAL CALLER OVERRIDE and a
   * value of 0 or less means "no override": the environment's own `crawlPolicy`
   * decides, clamped by the plan ceiling, and whatever bound the crawl is
   * reported in `policyApplied.overridden` and in the run event. A hard-coded
   * 25 is the reason "100% covered" meant "100% of at most 25 states", and it
   * could not be fixed inside the crawler while the caller overrode it.
   */
  /*
   * ── ONE PASS PER IDENTITY, ANONYMOUS FIRST ─────────────────────────────────
   *
   * This used to be a single `crawlApp` with the OLDEST profile's cached
   * `storageState` and `role: profile.name`. Two whole classes of surface were
   * absent as a result and neither looked like a bug:
   *
   *   · every role but the first. `requiresRoles` was written `[]`
   *     unconditionally, so the admin area of every customer's application was
   *     not uncovered — it was not in the denominator.
   *   · the auth boundary itself. With a valid session the crawler is never
   *     bounced, so `behindAuth` was FALSE EVERYWHERE and the product could not
   *     tell a customer where their own wall is.
   *
   * The sign-in is injected, which is what makes the decisions above testable:
   * Playwright cannot drive a browser in a unit test, and a login adapter that
   * only exists inside this function is a login adapter nothing can check.
   */
  const rolePlan = planRolePasses({ profiles });

  /*
   * THE PREVIOUS ATTEMPTS, READ BEFORE ANYTHING RUNS.
   *
   * `RoleCrawlAttempt` is upserted per (environment, role), so a row for a
   * profile that has since been deleted SURVIVES and goes on rendering as the
   * current situation for that role — with route counts on it. The read is what
   * makes `staleRoleAttempts` able to say so; the row itself is kept, because
   * the measurement did happen and deleting it would destroy a fact.
   */
  const previousAttempts = await prisma.roleCrawlAttempt.findMany({
    where: { orgId, environmentId },
    select: { role: true, outcome: true, attemptedAt: true },
  });

  const passes = await runRolePasses(
    {
      /*
       * ── THE CONFIGURABLE BUDGET, END TO END ────────────────────────────────
       *
       * `job.maxPages`/`maxDepth` are the API's hard-coded 25/3, clamped at
       * 60/6 by routes/agent.ts. They are treated as an OPTIONAL CALLER
       * OVERRIDE and a value of 0 or less means "no override": the
       * environment's own `crawlPolicy` decides, clamped by the plan ceiling,
       * and whatever bound the crawl is reported in `policyApplied.overridden`
       * and in the run event.
       *
       * EVERY PASS GETS THE SAME BUDGET — see `RoleBudgetDisclosure` for why
       * dividing it would shrink the thing the product sells — and the
       * multiplier is reported rather than inferred from the bill.
       */
      crawl: (input) =>
        crawlApp({
          baseUrl: environment.baseUrl,
          projectId,
          environmentId,
          version,
          ...(job.maxPages > 0 ? { maxPages: job.maxPages } : {}),
          ...(job.maxDepth > 0 ? { maxDepth: job.maxDepth } : {}),
          crawlPolicy: environment.crawlPolicy,
          plan: orgPlan,
          storageState: input.storageState,
          role: input.role,
          resumeFrom,
          onProgress: (message) => {
            logger.debug({ message, role: input.role }, 'crawl progress');
            publishEvent(orgId, {
              runId: `explore:${projectId}`,
              type: 'log',
              data: { message: input.role === null ? message : `[${input.role}] ${message}` },
              at: new Date().toISOString(),
            });
          },
        }),
      /*
       * A CACHED SESSION FIRST, AND A REAL SIGN-IN ONLY IF THERE IS NONE.
       *
       * The cached state is what every crawl has always used, so preferring it
       * keeps the cheap path cheap; the fallback is what makes a role with no
       * cached session crawlable at all instead of silently becoming an
       * anonymous crawl under that role's name. Nothing here logs the result:
       * `message` can quote the page and `storageState` IS the session.
       */
      signIn: async (identity) => {
        const profile = profiles.find((candidate) => candidate.id === identity.authProfileId);
        const fresh =
          profile?.storageState &&
          (!profile.storageStateExpiresAt || profile.storageStateExpiresAt > new Date())
            ? profile.storageState
            : null;
        if (fresh !== null) {
          return {
            ok: true,
            storageState: fresh,
            message: 'used the cached session',
            failure: null,
          };
        }
        if (!profile) {
          return {
            ok: false,
            storageState: null,
            message: 'the profile disappeared mid-job',
            failure: {
              kind: 'MISCONFIGURED',
              step: 'CONFIG',
              fault: 'OURS',
              detail: 'the profile row was deleted after the job started',
              unavailable: null,
            },
          };
        }
        const secrets = await secretsFor(orgId, environmentId);
        const result = await signInWithProfile(
          { id: profile.id, name: profile.name, kind: profile.kind, config: profile.config },
          secrets,
          // `environmentKind` is required with no default, because MOCK_IDP is
          // refused on PRODUCTION and a refusal that depends on a caller
          // remembering an argument is not a refusal.
          { environmentKind: environment.kind, baseUrl: environment.baseUrl },
        );
        return {
          ok: result.ok,
          storageState: result.storageState,
          message: result.message,
          failure: result.failure,
        };
      },
    },
    rolePlan,
  );

  /*
   * ── THE ACCEPTANCE GATE, NOW OVER THE UNION ────────────────────────────────
   *
   * A crawl run while the site was down, rate-limited or logged out returns a
   * small graph. Stored as the newest version it replaces the denominator, the
   * numerator does not move, and the coverage percentage goes UP on the day the
   * customer's staging environment fell over — with nobody told.
   *
   * Each pass is adjudicated on its own inside `runRolePasses` and a pass that
   * was held contributes NOTHING; the union is then adjudicated against the
   * last accepted map, which is where the shrink test belongs because the union
   * is the thing that would replace it. A degraded per-role crawl therefore
   * cannot replace a good denominator by any path: it is excluded from the
   * union before the union is judged.
   */
  /*
   * THE PASS WHOSE SINGLE-PASS FACTS ARE STORED.
   *
   * The frontier snapshot, the observation report, the device dimensions, the
   * budget and the detected route mode are properties of ONE crawl and there is
   * no honest way to union them — two frontiers merged would resume a crawl
   * from a visited set that no single identity ever had. So the first
   * contributing authenticated pass wins, falling back to the anonymous one,
   * and WHICH pass it was is reported beside the numbers rather than left for a
   * reader to assume it was all of them.
   */
  const primary =
    passes.find((pass) => pass.contributed && pass.identity !== null) ??
    passes.find((pass) => pass.contributed) ??
    passes.find((pass) => pass.crawl !== null);
  const outcome = primary?.crawl ?? null;
  if (outcome === null || primary === undefined) {
    // The anonymous pass always drives a crawl, so reaching here means the
    // crawler threw and `runRolePasses` returned without it — stated as an
    // invariant rather than papered over with an empty graph, which would be a
    // zero-node denominator presented as a measurement.
    throw new Error(
      `No pass produced a crawl of ${environment.baseUrl}; nothing can be stored as a denominator.`,
    );
  }

  const { merged: union, report: roleReport, probes } = mergeRolePasses(passes, outcome.flowMap);
  const acceptance = adjudicateUnion({
    passes,
    nodeCount: union.nodes.length,
    previous: accepted ? { version: accepted.version, nodeCount: accepted.nodeCount } : null,
  });
  const promoted = acceptance.state === 'ACCEPTED';

  /*
   * ── THE INCREMENTAL MERGE ──────────────────────────────────────────────────
   *
   * Only an ACCEPTED union merges. A degraded one is stored on its own, visible
   * and diffable, and is NOT allowed to carry the previous map's nodes forward
   * under its own version — that would launder a bot wall into a denominator
   * that looks complete.
   *
   * CONVERGENCE IS NOW A CONJUNCTION. A node may be dropped only when the
   * enumeration was entitled to say the surface is gone, and with several
   * passes that means EVERY contributing pass converged and no cap bit in any
   * of them: one capped pass is enough for "we did not reach it" to be the
   * better explanation than "it is gone".
   */
  const contributing = passes.filter((pass) => pass.contributed && pass.crawl !== null);
  const perPassCompleteness = contributing.map((pass) =>
    enumerationCompleteness(pass.crawl as CrawlOutcome),
  );
  const unionAtLeastMoreUrls = contributing.reduce(
    (total, pass) => total + (pass.crawl?.flowMap.frontier?.atLeastMoreUrls ?? 0),
    0,
  );
  const unionConverged =
    perPassCompleteness.length > 0 &&
    perPassCompleteness.every((verdict) => verdict.state === 'CONVERGED');
  const completeness: CompletenessVerdict = enumerationCompleteness(outcome);

  const { merged, report: mergeReport } = promoted
    ? mergeFlowMaps(previousMap, union, {
        converged: unionConverged,
        atLeastMoreUrls: unionAtLeastMoreUrls,
      })
    : {
        merged: union,
        report: {
          added: union.nodes.length,
          refreshed: 0,
          carried: 0,
          dropped: 0,
          rule:
            `held as ${acceptance.state}, so nothing was merged: a degraded crawl must not ` +
            `become the denominator`,
        },
      };

  const flowMap: FlowMap = {
    ...merged,
    acceptance,
    provenance: { derivedFrom: 'CRAWL', acceptance: acceptance.state, outcome: outcome.outcome },
    truncatedReason:
      [merged.truncatedReason, completeness.state === 'UNPROVEN' ? completeness.why : null]
        .filter((line): line is string => line !== null && line !== '')
        .join('; ') || null,
  };

  /*
   * EVERY SENTENCE A PERCENTAGE MUST NOT BE QUOTED WITHOUT.
   *
   * The role axis contributes four kinds of caveat and all four are the same
   * obligation: a budget that bit, a role we could not be, a role we were told
   * not to be, and a cell nobody asked about. Each is a count AND a reason,
   * because "partially enumerated" is an adjective and "at least 240 more
   * routes existed for admin" is a fact.
   */
  const caveats = [
    ...outcome.caveats,
    mergeReport.rule,
    completeness.why,
    ...acceptance.reasons,
    resume.why,
    rolePlan.disclosure.why,
    roleReport.rule,
    ...rolePlan.duplicates.map(
      (duplicate) =>
        `the "${duplicate.profileName}" profile was not crawled separately: it is the same role ` +
        `(${duplicate.role}) as "${duplicate.keptProfileName}", which was`,
    ),
    ...passes
      .filter((pass) => !pass.contributed)
      .map(
        (pass) =>
          `role ${pass.role} contributed NOTHING to this denominator (${pass.outcome})` +
          `${pass.detail === null ? '' : `: ${pass.detail}`}` +
          `${pass.remedy === null ? '' : ` — ${pass.remedy}`}`,
      ),
    ...staleRoleAttempts(
      previousAttempts,
      passes.map((pass) => pass.role),
    ).map((stale) => stale.why),
    ...passes
      .filter((pass) => pass.atLeastMoreRoutes !== null)
      .map(
        (pass) =>
          `the crawl as ${pass.role} was capped by ${pass.cappedBy ?? 'a budget'}; at least ` +
          `${pass.atLeastMoreRoutes} more in-scope URL(s) existed for this role and were not ` +
          `visited`,
      ),
  ];

  const stored = await prisma.flowMap.create({
    data: {
      orgId,
      projectId,
      environmentId,
      version,
      /*
       * The frontier snapshot rides in the graph, and ONLY for an accepted
       * crawl — see `mergeFlowMaps`. `FlowMap.frontierSnapshot Json?` is the
       * column it belongs in; the convention is read and written in exactly one
       * place (`withResumePoint`/`resumePointFrom` in @qaai/agent) so there is
       * one thing to change when the column lands.
       */
      /*
       * The observation report is stored for EVERY crawl, accepted or not: the
       * endpoints the UI called and the runtime errors it logged are facts
       * about the application whatever we decided about the denominator, and a
       * degraded crawl's bounce ledger is often the evidence for WHY it was
       * degraded. The frontier snapshot is the opposite and only an ACCEPTED
       * crawl writes one — a resume point whose visited set is full of
       * bot-wall pages would make the next crawl SKIP the real pages.
       */
      graph: withObservation(
        promoted ? withResumePoint(flowMap, outcome.snapshot) : { ...flowMap },
        outcome.observation,
      ) as unknown as object,
      nodeCount: flowMap.nodes.length,
      edgeCount: flowMap.edges.length,
      journeyCount: flowMap.journeys.length,
      truncatedReason: flowMap.truncatedReason,
      // Without this the column is null, `selectFlowMap` cannot tell a crawl
      // from a route table read out of the repository, and a source-derived
      // map at v9 goes on displacing a real crawl at v8.
      derivedFrom: 'CRAWL',
      acceptance: acceptance.state,
      // Never set for ACCEPTED and never null for the other two: "degraded"
      // with no reason is a denominator nobody can audit.
      acceptanceReason: promoted ? null : acceptance.reasons.join('; '),
      convergence: outcome.outcome,
      /*
       * THE MOST IMPORTANT COLUMN IN THE SLICE. Every cap is a lever that
       * silently flatters us; this is the number that makes the lever visible.
       * A floor and never an estimate.
       */
      atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
      excludedCount: flowMap.excluded?.length ?? null,
      policyApplied: flowMap.policyApplied as unknown as object,
    },
  });

  /*
   * ── THE ATTEMPT ROWS: ONE PER ROLE, WHATEVER HAPPENED ──────────────────────
   *
   * Written for EVERY pass, including the ones that never got a session, and
   * that is the whole reason the table exists. "The admin crawl found no routes
   * a member cannot see" is a finding if the admin crawl ran and a fabrication
   * if the admin login failed, and both produce zero cells — so the attempt is
   * stored and `roleHadNoExtraSurface` refuses to answer unless it succeeded.
   *
   * Upserted on (environment, role): this is the CURRENT state per role, not a
   * log. `detail` and `remedy` are rendered on screen and included in exports,
   * so neither is ever built from a credential — the login module masks its own
   * messages with the environment's secret values before they get here.
   */
  const attemptIdByRole = new Map<string, string>();
  for (const pass of passes) {
    const attempt = await prisma.roleCrawlAttempt.upsert({
      where: { environmentId_role: { environmentId, role: pass.role } },
      create: {
        orgId,
        projectId,
        environmentId,
        role: pass.role,
        authProfileId: pass.identity?.authProfileId ?? null,
        outcome: pass.outcome,
        detail: pass.detail,
        remedy: pass.remedy,
        // NULL for NEVER_ATTEMPTED only. A timestamp on an attempt that never
        // happened is the same lie as a status on an unprobed cell.
        attemptedAt: pass.outcome === 'NEVER_ATTEMPTED' ? null : new Date(),
        flowMapId: pass.contributed ? stored.id : null,
        routesReached: pass.routesReached,
        /*
         * BOTH NULL UNLESS THE CRAWL RAN. `roleHadNoExtraSurface` reads this
         * pair and returns null rather than "this role sees nothing extra",
         * which is the sentence a zero here would license.
         */
        routesNewToThisRole: pass.contributed
          ? routesNewToRole(pass, passes)
          : null,
        cappedBy: pass.cappedBy,
        atLeastMoreRoutes: pass.atLeastMoreRoutes,
      },
      update: {
        authProfileId: pass.identity?.authProfileId ?? null,
        outcome: pass.outcome,
        detail: pass.detail,
        remedy: pass.remedy,
        attemptedAt: pass.outcome === 'NEVER_ATTEMPTED' ? null : new Date(),
        flowMapId: pass.contributed ? stored.id : null,
        routesReached: pass.routesReached,
        routesNewToThisRole: pass.contributed ? routesNewToRole(pass, passes) : null,
        cappedBy: pass.cappedBy,
        atLeastMoreRoutes: pass.atLeastMoreRoutes,
      },
      select: { id: true },
    });
    attemptIdByRole.set(pass.role, attempt.id);
  }

  /*
   * ── THE ROUTE × ROLE MATRIX ────────────────────────────────────────────────
   *
   * Computed over the FINAL denominator's routes rather than over each role's
   * own reachable set, which is the difference between an axis of the
   * denominator and N unrelated little denominators. A route only the admin
   * pass reached gets a NOT_PROBED cell for every other role, with the reason,
   * and that set is the honest half of the product's claim on this axis.
   */
  const loginRoutes = loginRoutesFrom(passes);
  const matrix: AccessMatrix = buildAccessMatrix({
    routes: flowMap.nodes.map((node) => node.route),
    probes: probes.map((probe) => ({
      ...probe,
      attemptId: attemptIdByRole.get(probe.role) ?? null,
    })),
    loginRoutes,
  });
  const findings: AccessFinding[] = accessMatrixFindings(matrix, { loginRoutes });

  /*
   * THE READ BEFORE THE WRITE, and it is not an optimisation.
   *
   * The cell is unique on (environment, route, role) and this upserts, so
   * without the read a route measured in March and not reached in April would
   * have its real FORBIDDEN overwritten with NOT_PROBED — an observation turned
   * into "nobody asked", which is the one direction the vocabulary forbids
   * outright. `shouldReplaceCell` is the rule and it is unit tested; this loop
   * only obeys it.
   */
  const existingCells = await prisma.routeAccessCell.findMany({
    where: { orgId, environmentId },
    select: { routeTemplate: true, role: true, outcome: true, basis: true },
  });
  const storedCellByKey = new Map(
    existingCells.map((cell) => [`${cell.role}\u0000${cell.routeTemplate}`, cell]),
  );
  const routeItemByKey = new Map(
    (
      await prisma.coverageItem.findMany({
        where: { orgId, projectId, kind: 'ROUTE' },
        select: { id: true, key: true },
      })
    ).map((item) => [item.key, item.id]),
  );

  let cellsWritten = 0;
  let cellsKept = 0;
  for (const cell of matrix.cells) {
    const key = `${cell.role}\u0000${cell.routeTemplate}`;
    const verdict = shouldReplaceCell(storedCellByKey.get(key) ?? null, cell);
    if (!verdict.replace) {
      cellsKept += 1;
      continue;
    }
    const data = {
      outcome: cell.outcome,
      basis: cell.basis,
      status: cell.status,
      finalUrl: cell.finalUrl,
      probedAt: cell.probedAtIso === null ? null : new Date(cell.probedAtIso),
      authProfileId: cell.authProfileId,
      attemptId: cell.attemptId,
      /*
       * NULL here is a DANGLING REFERENCE in our own enumeration, not a
       * missing route: the cell is about a route the surface registry has no
       * item for. Stored as null and reported, because it is evidence about us.
       */
      coverageItemId: routeItemByKey.get(`ROUTE:${cell.routeTemplate}`) ?? null,
    };
    await prisma.routeAccessCell.upsert({
      where: {
        environmentId_routeTemplate_role: {
          environmentId,
          routeTemplate: cell.routeTemplate,
          role: cell.role,
        },
      },
      create: { orgId, projectId, environmentId, routeTemplate: cell.routeTemplate, role: cell.role, ...data },
      update: data,
    });
    cellsWritten += 1;
  }

  /*
   * ── THE DEVICE DIMENSION ROWS ──────────────────────────────────────────────
   *
   * The device set the variant pass was planned against, written from the SAME
   * objects the crawl was driven with. A row whose widthPx disagreed with the
   * viewport we actually set would make every cell on that axis a claim about a
   * configuration that never ran. `isDefault` is true for exactly one of them
   * (the 1280px viewport the URL pass itself uses), which matters because the
   * database does not enforce one default per (projectId, kind) and the
   * default-cell arithmetic is ambiguous with two.
   */
  for (const dimension of outcome.dimensions) {
    await prisma.surfaceDimension.upsert({
      where: {
        projectId_kind_key: {
          projectId,
          kind: dimension.kind,
          key: dimension.key,
        },
      },
      create: {
        orgId,
        projectId,
        kind: dimension.kind,
        key: dimension.key,
        label: dimension.label,
        source: dimension.source,
        evidence: dimension.evidence,
        isDefault: dimension.isDefault,
        available: dimension.available,
        detail: dimension.detail as unknown as object,
      },
      update: {
        label: dimension.label,
        evidence: dimension.evidence,
        isDefault: dimension.isDefault,
        available: dimension.available,
        detail: dimension.detail as unknown as object,
        // Cleared rather than left: a value the reader has found again is not
        // retired, and the row is the audit trail for both directions.
        retiredAt: null,
      },
    });
  }

  logger.info(
    {
      nodes: flowMap.nodes.length,
      edges: flowMap.edges.length,
      acceptance: acceptance.state,
      convergence: outcome.outcome,
      completeness: completeness.state,
      /*
       * Logged because it has no column. A re-crawl that detects a different
       * route mode re-keys every state and the version diff reads as a total
       * rewrite, so the value a crawl ran under has to be recoverable — a
       * `FlowMap.routeMode` field is requested, and until it lands this line is
       * the only record.
       */
      routeMode: outcome.routeMode,
      atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
      excluded: flowMap.excluded?.length ?? 0,
      pageBudget: outcome.budget.limits.pageBudget,
      plan: orgPlan,
      merge: mergeReport,
      variantsPlanned: outcome.variantPlan.variants.length,
      variantsRunnable: outcome.variantPlan.runnable,
      variantSurface: outcome.variantSurface.length,
      undeclaredEndpoints: outcome.observation.calls.length,
      /*
       * WHICH PASS the single-pass numbers above came from. Without it a reader
       * sees one `pageBudget` and one `routeMode` beside a five-pass union and
       * reasonably assumes they describe all of it.
       */
      singlePassFactsFrom: primary.role,
      roles: roleReport,
      budget: rolePlan.disclosure,
      access: {
        cells: matrix.counts,
        written: cellsWritten,
        keptBecauseStoredWasMeasured: cellsKept,
        findings: findings.map((finding) => `${finding.kind}:${finding.role}`),
      },
    },
    'crawl complete; asking the Explorer for a plan',
  );

  for (const caveat of caveats) {
    publishEvent(orgId, {
      runId: `explore:${projectId}`,
      type: 'log',
      data: { message: caveat },
      at: new Date().toISOString(),
    });
  }

  const secretNames = Object.keys(await secretsFor(orgId, environmentId));

  /*
   * The crawl is the expensive half — a browser, up to five minutes — and this
   * job runs with `attempts: 1`, so there is no retry to fall back on. Losing a
   * finished crawl because the step after it could not reach a model is the
   * wrong trade, and it is the trade that made the product unusable without a
   * key: the FlowMap landed, the plan never did, and every screen downstream
   * read as empty.
   *
   * So the model is best-effort and the crawl is not. Any failure here degrades
   * to the deterministic plan and says so on the plan itself — it fails OPEN and
   * the reason is carried to the human rather than swallowed. `writtenByModel`
   * is what the run.finished event reports, so the cockpit can tell the two
   * kinds of plan apart instead of guessing.
   */
  let plan: TestPlan;
  let writtenByModel: boolean;

  if (!config.anthropicApiKey) {
    // Not an error path: a missing credential is a missing tool. Skipped with a
    // sentence naming the fix, never failed.
    const reason =
      'ANTHROPIC_API_KEY is not set on this deployment, so the Explorer could not ask a model to rank these. Set it and re-run the Explorer for a model-ranked plan.';
    logger.warn({ projectId }, 'no ANTHROPIC_API_KEY — proposing the plan from the crawl');
    publishEvent(orgId, {
      runId: `explore:${projectId}`,
      type: 'log',
      data: { message: `Crawl complete. ${reason}` },
      at: new Date().toISOString(),
    });
    plan = planFromCrawl(flowMap, reason, authProfileChoices, caveats);
    writtenByModel = false;
  } else {
    try {
      plan = (
        await proposePlan(
          llm,
          { orgId, projectId, agent: 'EXPLORER', subjectId: stored.id },
          flowMap,
          {
            authProfiles: authProfileChoices,
            /*
             * THE DETERMINISTIC HALF RUNS FIRST AND THE MODEL ONLY WIDENS WHAT
             * IT PROVED — the shape every model path in this round takes.
             *
             * Without this the prompt's `testType` line falls back to the five
             * types the crawl owns, which is the honest floor and also the
             * defect: the model could not name a sixth type against an
             * application that plainly earned one. Passing the verdicts offers
             * it exactly the types the funnel established from observed signals
             * and no others, so it cannot propose a MOBILE test against a
             * website.
             */
            typeVerdicts: typeVerdictsFor(flowMap),
          },
        )
      ).plan;
      writtenByModel = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = `The Explorer's model call failed (${detail}), so these were read off the crawl instead. The crawl itself succeeded and is stored as flow map v${version}.`;
      logger.error({ err, projectId }, 'the Explorer model call failed; falling back to the crawl');
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message: reason },
        at: new Date().toISOString(),
      });
      plan = planFromCrawl(flowMap, reason, authProfileChoices, caveats);
      writtenByModel = false;
    }
  }

  const testPlan = await prisma.testPlan.create({
    data: {
      orgId,
      projectId,
      flowMapId: stored.id,
      summary: plan.summary,
      skipped: plan.skipped as unknown as object,
      items: {
        create: plan.items.map((item) => ({
          orgId,
          title: item.title,
          rationale: item.rationale,
          feature: item.feature,
          priority: item.priority,
          testType: item.testType,
          steps: item.steps as unknown as object,
          assertions: item.assertions as unknown as object,
          journeyId: item.journeyId,
          authProfileId: item.authProfileId,
        })),
      },
    },
    include: { items: { select: { id: true, testType: true } } },
  });

  logger.info(
    {
      planId: testPlan.id,
      items: testPlan.items.length,
      secretsAvailable: secretNames.length,
      writtenByModel,
    },
    'plan proposed',
  );

  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'run.finished',
    data: {
      planId: testPlan.id,
      items: testPlan.items.length,
      flowMapVersion: version,
      writtenByModel,
      /*
       * THE APPLIED BUDGET, VISIBLE. The cockpit could not previously tell a
       * deliberate 50-page budget from this build's default, so a customer
       * arguing about a number had nothing to look at. `enumeration` is the
       * other half: a percentage must never be quoted against this denominator
       * without `completeness` beside it.
       */
      budget: {
        pageBudget: outcome.budget.limits.pageBudget,
        maxDepth: outcome.budget.limits.maxDepth,
        perTemplatePageBudget: outcome.budget.limits.perTemplatePageBudget,
        wallClockMillis: outcome.budget.limits.wallClockMillis,
        plan: orgPlan,
        chosenFields: outcome.budget.policy.overridden,
        clampedByPlan: outcome.budget.clamped.map((clamp) => clamp.field),
        defaulted: outcome.budget.policy.defaulted,
      },
      enumeration: {
        completeness: completeness.state,
        /*
         * Logged because it has no column. A re-crawl that detects a different
         * route mode re-keys every state and the version diff reads as a total
         * rewrite, so the value a crawl ran under has to be recoverable — a
         * `FlowMap.routeMode` field is requested, and until it lands this line is
         * the only record.
         */
        routeMode: outcome.routeMode,
        convergence: outcome.outcome,
        atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
        excludedCount: flowMap.excluded?.length ?? 0,
        tailDiscoveryRate: completeness.tailDiscoveryRate,
        why: completeness.why,
      },
      acceptance: {
        state: acceptance.state,
        reasons: acceptance.reasons,
        degradations: acceptance.degradations.map((entry) => entry.kind),
      },
      merge: mergeReport,
      /*
       * ── HALF THE APP, PER ROLE, REPORTED ───────────────────────────────────
       *
       * `budget` carries the multiplier because N roles against one page budget
       * either divides the budget or multiplies the cost, and a cost a customer
       * cannot see is a cost they cannot argue about.
       *
       * `attempts` carries every role INCLUDING the ones that produced nothing,
       * with whose fault it was. A role whose crawl failed and a role with no
       * extra surface are opposite facts and only one of them is the customer's
       * problem; `routesNewToThisRole` is null rather than 0 for every failed
       * one, so no reader can accidentally average them.
       */
      roles: {
        budget: rolePlan.disclosure,
        merge: roleReport,
        singlePassFactsFrom: primary.role,
        attempts: passes.map((pass) => roleAttemptReport(pass, passes)),
        duplicates: rolePlan.duplicates,
        staleFromDeletedProfiles: staleRoleAttempts(
          previousAttempts,
          passes.map((pass) => pass.role),
        ),
      },
      /*
       * The matrix, with the NOT_PROBED count FIRST. That ordering is the
       * product: "25 of 412" is the sentence, and on this axis the sentence is
       * "this role was never asked about 94 of them" — which must be at least
       * as visible as the findings, or the findings read as a complete audit.
       */
      access: {
        routes: matrix.routes.length,
        roles: matrix.roles,
        counts: matrix.counts,
        gaps: matrix.gaps,
        loginRoutes,
        cellsWritten,
        cellsKeptBecauseStoredWasMeasured: cellsKept,
        findings: findings.map((finding) => ({
          kind: finding.kind,
          severity: finding.severity,
          route: finding.routeTemplate,
          role: finding.role,
          detail: finding.detail,
          evidence: finding.evidence,
          cells: finding.cells,
        })),
      },
      caveats: [...caveats, ...matrix.gaps.map((gap) => `${gap.cells} access cell(s): ${gap.reason}`)],
    },
    at: new Date().toISOString(),
  });

  // Onboarding can skip the approval screen; everywhere else a human ticks the
  // boxes before any code is written (§10).
  if (job.autoApprove && testPlan.items.length > 0) {
    await prisma.planItem.updateMany({
      where: { testPlanId: testPlan.id },
      data: { state: 'APPROVED', decidedBy: job.requestedBy, decidedAt: new Date() },
    });
    // Test CODE genuinely needs a model, but the spec-driven types do not:
    // the Generator scaffolds them deterministically from this very crawl
    // (see @qaai/agent's spec-strategies). So without a key the scaffoldable
    // subset is queued and the rest is skipped with the reason — the same
    // fail-open shape the plan itself took above. Code items stay APPROVED
    // and generate the moment a key is present and the plan is approved again.
    if (config.anthropicApiKey) {
      await enqueueGenerate({
        orgId,
        projectId,
        testPlanId: testPlan.id,
        planItemIds: testPlan.items.map((i) => i.id),
        requestedBy: job.requestedBy,
      });
    } else {
      const scaffoldable = testPlan.items.filter((i) =>
        canScaffoldWithoutModel(i.testType as TestType),
      );
      if (scaffoldable.length > 0) {
        await enqueueGenerate({
          orgId,
          projectId,
          testPlanId: testPlan.id,
          planItemIds: scaffoldable.map((i) => i.id),
          requestedBy: job.requestedBy,
        });
      }
      const needModel = testPlan.items.length - scaffoldable.length;
      const message =
        scaffoldable.length > 0
          ? `${testPlan.items.length} item(s) approved. ${scaffoldable.length} spec-driven item(s) were queued to scaffold from the crawl — each carries review flags naming what to fill in. ` +
            (needModel > 0
              ? `The other ${needModel} need a model: ANTHROPIC_API_KEY is not set on this deployment — set it and approve the plan again.`
              : `Set ANTHROPIC_API_KEY to have a model write them outright.`)
          : `${testPlan.items.length} item(s) approved, but no test code was written: ANTHROPIC_API_KEY is not set on this deployment. Set it and approve the plan again.`;
      logger.warn(
        { planId: testPlan.id, items: testPlan.items.length, scaffolded: scaffoldable.length },
        'auto-approve without ANTHROPIC_API_KEY — queued only the deterministic scaffolds',
      );
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message },
        at: new Date().toISOString(),
      });
    }
  }
}
