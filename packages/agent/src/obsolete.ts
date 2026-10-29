/**
 * Obsolete tests, and selector drift — the two things a fresh crawl knows and
 * nobody ever asked it.
 *
 * ── THE TWO DEFECTS ─────────────────────────────────────────────────────────
 *
 * 1. NOTHING EVER RETIRED A TEST. A page gets deleted; the test that drove it
 *    keeps running, keeps failing, keeps getting triaged, and keeps being
 *    offered a Healer patch against a route that no longer exists. The customer
 *    pays for the runs, reads the verdicts, and the only way out is noticing by
 *    hand. There was no verdict for "this test should stop existing" — see
 *    `HealRisk.RETIRE`, added with this work.
 *
 * 2. NOTHING COMPARED A TEST TO THE NEWEST CRAWL UNTIL IT FAILED. The Explorer
 *    re-crawls and knows, that instant, that `getByRole('button', { name: 'Pay'
 *    })` is not on the checkout page any more. Nothing looked. So every rename
 *    cost a failing CI run, a triage call and a heal proposal before anyone
 *    heard about it, when the information was sitting in the flow map before the
 *    run started.
 *
 * ── THE DISTINCTION THIS FILE IS BUILT AROUND ───────────────────────────────
 *
 * A test whose route is missing from the latest crawl is NOT obsolete. It is
 * UNREACHED, and the difference is the difference between a useful feature and
 * one that destroys the customer's work:
 *
 *   OBSOLETE   the route is in NEITHER the application's source NOR a crawl
 *              that ran to completion. The page is gone. Retirement is a
 *              reasonable proposal — for a human to accept.
 *   UNREACHED  the source still declares the route; this crawl simply did not
 *              get there. A crawler stops at a login wall, a feature flag, a
 *              button it did not think to press, a budget, a depth cap. That is
 *              a fact about OUR crawl, not about the customer's test, and the
 *              same fact `surface-inventory.ts` reports as SOURCE_ONLY. A test
 *              covering a page our crawler cannot reach is often the MOST
 *              valuable test in the suite.
 *   PARTLY_    the test drives several routes and the crawl reached SOME of
 *   UNREACHED  them. Part of this test was compared and part was not, so it is
 *              neither CURRENT nor a retirement candidate — it still drives a
 *              page that is plainly there. It exists because the alternative is
 *              worse: with no branch for the mixed case the test fell through to
 *              CURRENT, which is the one verdict whose caveats are documented
 *              empty, carrying the sentence "every route this test drives was
 *              reached" about a route the crawl never saw.
 *   UNMEASURED we could not read the test, or there is no crawl, or the crawl
 *              stopped early, or the declared-route list we were handed was
 *              itself capped. No verdict at all. A truncated scan can never
 *              support a retirement, because "past where we stopped" and "not
 *              there" are indistinguishable from inside it.
 *
 * The rule that makes it hold: **a retirement needs two independent negatives
 * plus a complete scan on both sides.** Source analysis must exist (otherwise
 * "not declared" is not a fact, it is an absence of a detector), the DECLARED
 * LIST must be complete and not a capped page of it, the crawl must not be
 * truncated, and the test's code must have been read in full. Any one of those
 * missing downgrades the verdict to UNMEASURED and emits no proposal. Several
 * ways to say "I do not know" and one way to say "retire it" is the right ratio
 * for an operation the customer cannot undo by re-running anything.
 *
 * BOTH SIDES ARE FENCED THE SAME WAY, and the symmetry is the point. The crawl
 * side has been fenced since this file was written (`truncatedReason` blocks
 * every proposal). The source side was not: the callers read the project's route
 * items with a `take`, so on a project with more items than that cap a route the
 * source DOES declare arrived here as `declared: false` — precisely the negative
 * OBSOLETE needs — and the cap could manufacture a retirement for a test whose
 * page is fine. `declaredRoutesTruncatedReason` is how a caller says so, and it
 * blocks a proposal exactly as hard as a truncated crawl does.
 *
 * ── LOCATOR DRIFT IS NEVER EVIDENCE OF OBSOLESCENCE ─────────────────────────
 *
 * The crawl's affordance list is a LOWER BOUND: the Explorer records what it
 * found, not everything that exists. So a locator the newest crawl did not see
 * is a warning worth sending before the test fails — and nothing more. It never
 * contributes to a retirement, and drift is only ever claimed for a route the
 * crawl actually REACHED, because on a route it never visited every locator is
 * trivially "missing" and the finding would be noise by construction.
 *
 * NOTHING HERE CALLS A MODEL. Same rule as `coverage.ts` and
 * `surface-inventory.ts`: a claim about the customer's application that we
 * cannot show the working for is worse than no claim.
 */

import { locatorExpression } from '@qaai/shared';
import type { CrawlAcceptanceState, FlowMap, OwnerRef, Priority } from '@qaai/shared';
/*
 * The suppression and ownership vocabularies, through the package barrel.
 *
 * Copying either of them here would have been the sixth implementation of the
 * idea those two files exist to end, which is why this module asks for
 * `retirementAdmissible` and `retirementDenominatorEffect` rather than deciding
 * for itself whether a test may be retired and what that does to the
 * denominator. One answer, one place, every caller.
 */
import {
  OBSOLESCENCE_MIN_CONFIRMATIONS,
  OBSOLESCENCE_SIGNAL_RULES,
  applySuppression,
  expiryFor,
  retirementAdmissible,
  retirementDenominatorEffect,
  summariseSuppressions,
} from '@qaai/shared';
import type {
  ObsolescenceSignal,
  ObsolescenceSignalKind,
  RetirementDenominatorEffect,
  RetirementState,
  Suppression,
  SuppressionRefusal,
  SuppressionSummary,
  SuppressionTally,
} from '@qaai/shared';
import type { OwnerProvenance } from '@qaai/shared';
import { extractBehavior, normalizeLocator, normalizeRoute } from './suite-health.js';
import type { SuiteHealthTestInput } from './suite-health.js';
import { routeVisits } from './coverage.js';

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * The locator strategies a crawl can enumerate, and therefore the only ones a
 * "the crawl did not see this" claim may be made about.
 *
 * A `css=` locator, a locator held in a variable, or one this module could not
 * parse is UNCOMPARABLE: the Explorer does not enumerate arbitrary CSS, so its
 * absence from the flow map says nothing whatsoever. Counting those as drift
 * would make the report mostly false on any suite that uses CSS selectors —
 * which is the suite that needs this report most.
 */
const COMPARABLE_LOCATOR_KEYS = new Set(['role', 'label', 'placeholder', 'text', 'testid']);

/**
 * Strip the positional modifiers `normalizeLocator` appends.
 *
 * `.first()`, `.last()`, `.nth(2)` and `hasText` narrow a selection; they do not
 * change WHICH ELEMENT KIND the test is talking about, and the crawl records an
 * affordance without them. Comparing with them attached would report every
 * `getByRole('row').first()` in the suite as drifted.
 */
export function locatorIdentity(normalized: string): string {
  let out = normalized.replace(/:has:.*$/, '');
  for (;;) {
    const next = out.replace(/:(?:first|last|nth\d+)$/, '');
    if (next === out) return next;
    out = next;
  }
}

/** The comparable key of a normalised locator, or null when it is not comparable. */
function comparableKey(normalized: string): string | null {
  const identity = locatorIdentity(normalized);
  const key = identity.split('=')[0] ?? '';
  // A chained locator (`role=…>text=…`) is keyed by its first factory, which is
  // the element the chain is rooted at.
  return COMPARABLE_LOCATOR_KEYS.has(key.split('>')[0] ?? '') ? identity : null;
}

// ─── What the newest crawl knows ─────────────────────────────────────────────

export interface CrawlSurface {
  /** Canonical routes the crawl REACHED. */
  routes: string[];
  /**
   * Comparable locator identities the crawl saw, across every node.
   *
   * Deliberately global rather than per-route. A per-route comparison sounds
   * more precise and is more WRONG: the Explorer records an affordance on the
   * node where it happened to find it, and a header link exists on every page of
   * the application. Erring towards "the crawl has seen this somewhere" costs a
   * missed drift warning; erring the other way costs a false accusation about
   * code that is fine, which is how a report stops being read.
   */
  locators: Set<string>;
  version: number | null;
  exploredAt: string | null;
  /** Set when the crawl stopped early. Blocks every retirement proposal. */
  truncatedReason: string | null;
  /** Affordances seen but not comparable (CSS, unparsed). Reported, never used. */
  uncomparableAffordances: number;
  /**
   * The crawl's own adjudication (`adjudicateCrawl`, packages/shared/src/flow-map.ts),
   * or NULL for a map written before acceptance existed and never adjudicated.
   *
   * ONLY `ACCEPTED` MAY SUPPORT A RETIREMENT. A CANDIDATE crawl is one the
   * enumerate round already decided not to measure against — it was rate
   * limited, it was not logged in, it SHRANK — and every one of those
   * degradations produces the same evidence as a deleted page. A REJECTED one
   * enumerated nothing usable at all.
   *
   * `null` blocks a retirement too, and the asymmetry is deliberate: an
   * un-adjudicated crawl is good enough to WARN from (a drift warning costs
   * nothing when it is wrong) and not good enough to retire from (a retirement
   * destroys coverage the customer paid for). Several ways to say "I do not
   * know" and one way to say "retire it".
   */
  acceptance: CrawlAcceptanceState | null;
  /** The adjudicator's own sentences, so a blocked retirement can quote why. */
  acceptanceReasons: string[];
}

/**
 * Read a flow map into the two sets this module compares against.
 *
 * Defensive about shape, like `coverage.ts`'s crawl reader: a stored FlowMap is
 * JSON written by an older version of the crawler, and a missing `affordances`
 * array must narrow the comparison rather than throw inside a sweep.
 */
export function crawlSurfaceOf(flowMap: FlowMap | null): CrawlSurface {
  const routes = new Set<string>();
  const locators = new Set<string>();
  let uncomparable = 0;

  for (const node of flowMap?.nodes ?? []) {
    if (typeof node?.route === 'string') routes.add(normalizeRoute(node.route));
    for (const affordance of node?.affordances ?? []) {
      if (!affordance?.selector) continue;
      const key = comparableKey(normalizeLocator(`page.${locatorExpression(affordance.selector)}`));
      if (key) locators.add(key);
      else uncomparable += 1;
    }
    for (const form of node?.forms ?? []) {
      for (const field of form?.fields ?? []) {
        if (!field?.selector) continue;
        const key = comparableKey(normalizeLocator(`page.${locatorExpression(field.selector)}`));
        if (key) locators.add(key);
        else uncomparable += 1;
      }
    }
  }

  return {
    routes: [...routes].sort(),
    locators,
    version: flowMap?.version ?? null,
    exploredAt: flowMap?.exploredAt ?? null,
    truncatedReason: flowMap?.truncatedReason ?? null,
    uncomparableAffordances: uncomparable,
    acceptance: flowMap?.acceptance?.state ?? null,
    acceptanceReasons: [...(flowMap?.acceptance?.reasons ?? [])],
  };
}

/**
 * Why this crawl cannot support an obsolescence claim, or null when it can.
 *
 * One function, asked by the audit and by {@link proposeRetirement}, so the
 * verdict screen and the retirement queue cannot disagree about whether the
 * crawl was good enough — which is the shape the quarantine bug had.
 */
export function retirementBlockedBy(crawl: CrawlSurface): string | null {
  /*
   * TRUNCATION FIRST, and the order is a choice about which sentence a reader
   * gets. A crawl can be ACCEPTED and still have stopped early, and "stopped
   * early at 25 pages — re-crawl with a wider budget" is something the customer
   * can act on this afternoon. "Never adjudicated" is true of the same map and
   * tells them nothing to do.
   */
  if (crawl.truncatedReason !== null) {
    return `the crawl stopped early (${crawl.truncatedReason}), so a route it did not reach may simply be past where it stopped`;
  }
  if (crawl.acceptance === null) {
    return 'this crawl was never adjudicated, so nothing has established that it enumerated the application rather than a login wall';
  }
  if (crawl.acceptance !== 'ACCEPTED') {
    const why = crawl.acceptanceReasons[0];
    return `the crawl was held as ${crawl.acceptance}${why ? ` (${why})` : ''}, and a degraded crawl produces the same evidence as a deleted page`;
  }
  return null;
}

// ─── Per-test verdict ────────────────────────────────────────────────────────

export type SurfaceVerdict =
  | 'CURRENT'
  | 'DRIFTED'
  | 'UNREACHED'
  | 'PARTLY_UNREACHED'
  | 'OBSOLETE'
  | 'UNMEASURED';

/**
 * The reasons a route that is ABSENT FROM THE CRAWL is nevertheless not gone.
 *
 * Every one of these looks identical to "deleted" from the crawl's point of
 * view, which is exactly why each needs a name: an unnamed exclusion is an
 * exclusion a reader cannot audit, and a missing one is a retirement proposal
 * for a feature that is simply switched off this week.
 *
 * The facts come from the CALLER, not from guesswork here. QAAI has a flag
 * store, a set of auth profiles and a surface inventory that records
 * exercisability; this module compares routes. A module that inferred "probably
 * behind a flag" from a route's shape would be inventing the one fact that
 * decides whether a customer loses a test.
 */
export const OBSOLESCENCE_EXCLUSIONS = [
  /** A feature flag was off during the crawl. The route exists; it was dark. */
  'BEHIND_FEATURE_FLAG',
  /** The route needs a role the crawl held no session for. */
  'ROLE_NOT_CRAWLED',
  /**
   * The surface inventory says QAAI is not PERMITTED to drive this — it ends the
   * session, it destroys data, it charges money. See `UNEXERCISABLE_REASONS`
   * (packages/shared/src/surface.ts). Those routes are absent from every crawl
   * BY DESIGN, so a retirement argued from their absence would retire the tests
   * covering precisely the surfaces QAAI refuses to touch itself.
   */
  'UNEXERCISABLE',
] as const;
export type ObsolescenceExclusion = (typeof OBSOLESCENCE_EXCLUSIONS)[number];

export const OBSOLESCENCE_EXCLUSION_LABELS = {
  BEHIND_FEATURE_FLAG: 'a feature flag was off during the crawl',
  ROLE_NOT_CRAWLED: 'the crawl held no session for the role it needs',
  UNEXERCISABLE: 'QAAI is not permitted to drive it here',
} as const satisfies Record<ObsolescenceExclusion, string>;

/** One route the caller has excluded from the obsolescence argument, and why. */
export interface RouteExclusion {
  route: string;
  exclusion: ObsolescenceExclusion;
  /**
   * The caller's own evidence: the flag key, the role name, the
   * `UnexercisableReason`. Shown to the reviewer verbatim.
   */
  detail: string;
}

export interface RouteCheck {
  route: string;
  /** The crawl got here. */
  reached: boolean;
  /** The application's source still declares it. */
  declared: boolean;
  /** The extractor used to find this route and no longer does. */
  retired: boolean;
  /**
   * Set when the caller excluded this route from the obsolescence argument.
   * An excluded route is NEVER evidence of deletion, however absent it is.
   */
  excluded: RouteExclusion | null;
}

export interface LocatorCheck {
  locator: string;
  line: number;
  /** True when the newest crawl saw an element with this identity. */
  seen: boolean;
  /** True when the crawl cannot enumerate this kind of locator at all. */
  comparable: boolean;
}

export interface RetirementProposal {
  /** 0–1. Never 1: this is an argument from absence, however well fenced. */
  confidence: number;
  /** The prose a reviewer decides on. */
  explanation: string;
  /** The facts behind it, each one re-derivable by the customer. */
  evidence: string[];
}

export interface TestSurfaceReport {
  testId: string;
  name: string;
  filePath: string;
  priority: Priority;
  /**
   * The test's declared feature, carried through so FEATURE_GONE — the
   * strongest signal in the vocabulary — can be derived from the report without
   * a second read of the suite. Null on a test that declares none, and a null
   * feature can never produce FEATURE_GONE.
   */
  feature: string | null;
  verdict: SurfaceVerdict;
  routes: RouteCheck[];
  locators: LocatorCheck[];
  /** Why this verdict, in sentences. Never empty. */
  evidence: string[];
  /**
   * What stops this being a stronger claim. Empty only on CURRENT — and CURRENT
   * is only ever reached when every route was reached and nothing comparable
   * drifted, which is what makes an empty list here mean something.
   */
  caveats: string[];
  /** Present only when every retirement condition holds. */
  retirement: RetirementProposal | null;
}

export interface ObsoleteInput {
  tests: readonly SuiteHealthTestInput[];
  /** The newest readable crawl. Null means nothing to compare against. */
  flowMap: FlowMap | null;
  /**
   * Canonical routes the SOURCE declares, or NULL when no source analysis has
   * run for this project.
   *
   * Null is not an empty list and the difference decides the feature: with no
   * source analysis, "the source does not declare this route" is not a fact
   * about the application, it is the absence of a detector — and every
   * retirement proposal is withheld.
   */
  declaredRoutes: readonly string[] | null;
  /**
   * Set when `declaredRoutes` is a CAPPED PAGE of the project's route items
   * rather than all of them, naming the cap. Blocks every retirement proposal.
   *
   * The crawl side of the argument has always been fenced by
   * `truncatedReason`; this is the same fence on the source side, and it is not
   * hypothetical. Both callers read `CoverageItem` with a `take`, so beyond that
   * many route items a route the source genuinely declares does not appear in
   * this list — and `declared: false` on a route that IS declared is exactly
   * the negative OBSOLETE needs. Null means "this is the whole list", which is
   * the claim a caller has to be able to make for a retirement to be possible
   * at all; it is NOT the same as `declaredRoutes: null`, which says no detector
   * ran.
   */
  declaredRoutesTruncatedReason?: string | null;
  /**
   * Routes the extractor used to find and no longer does
   * (`CoverageItem.retiredAt`). POSITIVE evidence of deletion rather than an
   * argument from absence, so it raises a retirement's confidence; absent, the
   * proposal is still possible but weaker and says so.
   */
  retiredRoutes?: readonly string[];
  /**
   * Routes the caller knows are absent from this crawl for a reason that is NOT
   * deletion — see {@link OBSOLESCENCE_EXCLUSIONS}.
   *
   * Matched template-aware, both ways, exactly like `declaredRoutes`: an
   * exclusion written as `/orders/:id` covers `/orders/7`, because the caller's
   * flag and role facts are about the route pattern and the test's token may be
   * either shape.
   */
  excludedRoutes?: readonly RouteExclusion[];
  /**
   * Feature names the SOURCE still declares, or null when nothing has told us.
   *
   * Only consulted for the FEATURE_GONE signal, which is the strongest one in
   * the vocabulary and therefore the one that must not be argued from a crawl
   * alone. Null withholds FEATURE_GONE entirely rather than treating "we were
   * not told" as "the feature is gone".
   */
  declaredFeatures?: readonly string[] | null;
}

export interface ObsoleteReport {
  crawl: CrawlSurface;
  /** False when `declaredRoutes` was null. Gates every retirement. */
  sourceAnalysed: boolean;
  /**
   * Echoed back from the input, so a reader of the report can see that the
   * declared list was capped without having to hold the caller's query in their
   * head. Non-null gates every retirement, exactly like `crawl.truncatedReason`.
   */
  declaredRoutesTruncatedReason: string | null;
  tests: TestSurfaceReport[];
  summary: Record<SurfaceVerdict, number>;
  /** Facts a reader must know before trusting any count here. Never empty. */
  caveats: string[];
  /**
   * Null when this crawl may support a retirement, otherwise the one sentence
   * saying why not. Computed once by {@link retirementBlockedBy}.
   */
  retirementBlockedBy: string | null;
  /** Feature names the newest crawl clustered nodes under. */
  crawlFeatures: string[];
  /**
   * Feature names the SOURCE declares, or null when nothing told us. Null
   * withholds every FEATURE_GONE signal — see {@link ObsoleteInput.declaredFeatures}.
   */
  declaredFeatures: string[] | null;
  /**
   * Routes excluded from the obsolescence argument, COUNTED BY REASON.
   *
   * An exclusion is a suppression of a finding, and rule: every suppression is
   * counted out loud. "3 routes were not considered: 2 behind a feature flag, 1
   * unexercisable" is a sentence a reader can check; silently skipping them
   * would make "no retirement candidates" and "we did not look at nine routes"
   * the same output.
   */
  exclusionCounts: Record<ObsolescenceExclusion, number>;
}

/**
 * The routes a test drives, out of `TestBehavior.routes`.
 *
 * Those are behaviour TOKENS, not paths: `extractBehavior` prefixes each one
 * `nav:` so the duplicate scanner can tell a route facet from an action facet.
 * Reading them as paths is how this module first reported every test in the
 * suite as obsolete — `nav:/checkout` matches no crawled route, so the two
 * independent negatives both fired on a page that was plainly there.
 *
 * Taken from the token list rather than from `navigationSites`, because a
 * spec-driven test (API, accessibility, load) has no navigation statements at
 * all: its routes come from `spec` and only ever appear here.
 */
function routesOf(tokens: readonly string[]): string[] {
  const prefix = 'nav:';
  return tokens
    .filter((token) => token.startsWith(prefix))
    .map((token) => normalizeRoute(token.slice(prefix.length)));
}

/** Did any declared/crawled route cover this one? Template-aware, both ways. */
function matchesAny(route: string, known: readonly string[]): boolean {
  return known.some((candidate) => routeVisits(route, candidate) || routeVisits(candidate, route));
}

/**
 * Compare every test against the newest crawl.
 *
 * Deterministic and order-stable: tests come back in the order given, routes and
 * locators sorted, so two consecutive reports differ only when the answer does.
 */
export function auditTestsAgainstCrawl(input: ObsoleteInput): ObsoleteReport {
  const crawl = crawlSurfaceOf(input.flowMap);
  const sourceAnalysed = input.declaredRoutes !== null;
  const declared = (input.declaredRoutes ?? []).map((route) => normalizeRoute(route));
  const retired = (input.retiredRoutes ?? []).map((route) => normalizeRoute(route));
  const haveCrawl = input.flowMap !== null && crawl.routes.length > 0;
  const completeCrawl = haveCrawl && crawl.truncatedReason === null;
  const crawlBlocked = haveCrawl ? retirementBlockedBy(crawl) : null;
  const declaredTruncated = input.declaredRoutesTruncatedReason ?? null;
  const exclusions = input.excludedRoutes ?? [];
  const exclusionCounts: Record<ObsolescenceExclusion, number> = {
    BEHIND_FEATURE_FLAG: 0,
    ROLE_NOT_CRAWLED: 0,
    UNEXERCISABLE: 0,
  };
  // The source-side twin of `completeCrawl`. A capped declared list cannot
  // support "the source does not declare this route" any more than a capped
  // crawl can support "nothing reached it".
  const completeSource = sourceAnalysed && declaredTruncated === null;

  const tests: TestSurfaceReport[] = [];

  for (const test of input.tests) {
    const behavior = extractBehavior(test);
    const base = {
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      priority: test.priority,
      feature: test.feature,
    };

    const routes: RouteCheck[] = [...new Set(routesOf(behavior.routes))]
      .sort()
      .map((route) => ({
        route,
        reached: matchesAny(route, crawl.routes),
        declared: matchesAny(route, declared),
        retired: matchesAny(route, retired),
        excluded: exclusionFor(route, exclusions),
      }));

    for (const check of routes) {
      if (check.excluded && !check.reached) exclusionCounts[check.excluded.exclusion] += 1;
    }

    // ─ The reasons there is no verdict at all ─

    if (!haveCrawl) {
      tests.push({
        ...base,
        verdict: 'UNMEASURED',
        routes,
        locators: [],
        evidence: [
          'Nothing has crawled this application, so there is nothing to compare this test against.',
        ],
        caveats: [
          'No crawl means no verdict. This is a gap in QAAI’s measurement, not a statement about your test.',
        ],
        retirement: null,
      });
      continue;
    }

    if (behavior.incomplete) {
      tests.push({
        ...base,
        verdict: 'UNMEASURED',
        routes,
        locators: [],
        evidence: [
          `QAAI could not read this test in full (${behavior.incompleteReason ?? 'unknown reason'}), so no claim is made about whether the application still has what it drives.`,
        ],
        caveats: [
          'A test QAAI cannot read is never proposed for retirement, however little of it was readable.',
        ],
        retirement: null,
      });
      continue;
    }

    if (routes.length === 0) {
      tests.push({
        ...base,
        verdict: 'UNMEASURED',
        routes,
        locators: [],
        evidence: [
          'This test navigates to no route QAAI can read, so there is nothing to compare against a crawl. A unit, API or contract test is expected to look like this.',
        ],
        caveats: [
          'Obsolescence here would have to be argued from something other than routes, and QAAI does not guess.',
        ],
        retirement: null,
      });
      continue;
    }

    // ─ Locator drift, for the routes the crawl actually reached ─

    const reachedSomething = routes.some((route) => route.reached);
    const locators: LocatorCheck[] = reachedSomething
      ? dedupeLocators(behavior.actionSites).map((site) => {
          const key = comparableKey(site.locator);
          return {
            locator: site.locator,
            line: site.line,
            comparable: key !== null,
            seen: key !== null && crawl.locators.has(key),
          };
        })
      : [];

    const drifted = locators.filter((check) => check.comparable && !check.seen);
    const uncomparable = locators.filter((check) => !check.comparable);

    const excludedRoutes = routes.filter((route) => !route.reached && route.excluded !== null);
    const missingRoutes = routes.filter(
      (route) => !route.reached && !route.declared && route.excluded === null,
    );
    const unreachedRoutes = routes.filter((route) => !route.reached && route.declared);

    /*
     * AN EXCLUDED ROUTE ENDS THE ARGUMENT, BEFORE ANY OF THE BRANCHES BELOW.
     *
     * A route behind a dark flag, a route needing a role the crawl had no
     * session for, and a route QAAI is not permitted to drive are all ABSENT
     * from the crawl and all three mean the page is there. They are handled
     * here rather than folded into UNREACHED because UNREACHED's own evidence
     * sentence is "the source still declares it", which says nothing about a
     * flag — and a reader who is told the wrong reason stops trusting the
     * right ones.
     */
    if (excludedRoutes.length > 0) {
      tests.push({
        ...base,
        verdict: 'UNMEASURED',
        routes,
        locators: [],
        evidence: [
          `The newest crawl did not reach ${excludedRoutes.map((route) => route.route).join(', ')}, and QAAI already knows why: ` +
            `${excludedRoutes.map((route) => `${route.route} — ${OBSOLESCENCE_EXCLUSION_LABELS[route.excluded!.exclusion]} (${route.excluded!.detail})`).join('; ')}.`,
          'That is a fact about this crawl, not about the application, so no obsolescence claim is made from it.',
        ],
        caveats: [
          'This test is NOT a retirement candidate. A route that is dark, role-gated or off-limits to QAAI is absent from every crawl by design.',
        ],
        retirement: null,
      });
      continue;
    }

    // ─ OBSOLETE, and only under every condition at once ─

    const allRoutesGone = missingRoutes.length === routes.length;
    if (
      allRoutesGone &&
      sourceAnalysed &&
      completeCrawl &&
      completeSource &&
      crawlBlocked === null
    ) {
      const retiredEvidence = routes.filter((route) => route.retired);
      const confidence = retiredEvidence.length > 0 ? 0.9 : 0.7;
      const evidence = [
        `Every route this test drives is absent from the application: ${routes.map((route) => route.route).join(', ')}.`,
        `The crawl of version ${crawl.version ?? '?'} ran to completion and reached ${crawl.routes.length} route(s); none of them is this test’s.`,
        `Source analysis has run for this project and the complete list of the ${declared.length} route(s) it declares — not a capped page of it — contains none of them either, so this is two independent negatives rather than one crawl’s opinion.`,
        ...retiredEvidence.map(
          (route) =>
            `${route.route} was found by the source extractor in an earlier scan and is no longer found — positive evidence that it was deleted, not merely missed.`,
        ),
      ];
      tests.push({
        ...base,
        verdict: 'OBSOLETE',
        routes,
        locators,
        evidence,
        caveats: [
          retiredEvidence.length > 0
            ? 'Still an argument partly from absence: accept this only if you recognise the route as deleted.'
            : 'This is an argument from absence on both sides. Nothing proves the route was deleted rather than renamed — if it was renamed, the test wants a patch and not a retirement.',
        ],
        retirement: {
          confidence,
          explanation:
            `"${test.name}" drives ${routes.length === 1 ? 'a route' : 'routes'} the application no longer has ` +
            `(${routes.map((route) => route.route).join(', ')}). It cannot pass, and a Healer patch cannot ` +
            `help it: there is nothing to retarget. Retiring it DISABLES the test — the code stays in your ` +
            `repository and in its version history, and you can switch it back on — so the reversible ` +
            `action is the one being proposed.` +
            (retiredEvidence.length > 0
              ? ` QAAI used to find ${retiredEvidence[0]!.route} in your source and no longer does, which is why this one is proposed with confidence rather than as a guess.`
              : ` Nothing here proves the page was deleted rather than renamed, so read it before accepting.`),
          evidence,
        },
      });
      continue;
    }

    // ─ The honest downgrades ─

    if (allRoutesGone) {
      /*
       * Three ways to get here, and the one a reader must be told apart from the
       * others is the third: a capped declared list means the route may well be
       * declared and simply past the end of the page we were handed, which is
       * the same shape of mistake as a truncated crawl and not a fact about the
       * customer's application at all.
       */
      const why = !sourceAnalysed
        ? 'no source analysis has run for this project, so "the code does not declare this route" is the absence of a detector rather than a fact'
        : crawlBlocked !== null
          ? crawlBlocked
          : `the list of routes your source declares was capped before it got here (${declaredTruncated}), so "the code does not declare this route" may only mean the route is past the end of the page QAAI read`;
      tests.push({
        ...base,
        verdict: 'UNMEASURED',
        routes,
        locators,
        evidence: [
          `No route this test drives was reached by the newest crawl: ${routes.map((route) => route.route).join(', ')}.`,
          `That is NOT being reported as obsolete, because ${why}.`,
        ],
        caveats: [
          !sourceAnalysed
            ? 'Connect the repository so source analysis can run, and this test gets a real verdict instead of a shrug.'
            : crawlBlocked !== null
              ? 'A retirement needs a crawl that was ACCEPTED and ran to completion. Re-crawl, or clear the degradation the adjudicator recorded, and this test gets a real verdict.'
              : 'This is a limit in QAAI’s own read of your route inventory, not a finding about your test. It is not a retirement candidate while that list is capped.',
        ],
        retirement: null,
      });
      continue;
    }

    if (unreachedRoutes.length > 0 && !reachedSomething) {
      tests.push({
        ...base,
        verdict: 'UNREACHED',
        routes,
        locators,
        evidence: [
          `The crawl did not reach ${unreachedRoutes.map((route) => route.route).join(', ')}, and the application’s source still declares ${unreachedRoutes.length === 1 ? 'it' : 'them'}.`,
          'A crawler stops at a login wall, a feature flag, a role it does not hold or a button it did not press. A test covering a page our crawler cannot reach is often the most valuable test in the suite.',
        ],
        caveats: [
          'This test is NOT a retirement candidate and no part of this report should be read as suggesting it is.',
        ],
        retirement: null,
      });
      continue;
    }

    if (drifted.length > 0) {
      tests.push({
        ...base,
        verdict: 'DRIFTED',
        routes,
        locators,
        evidence: [
          `The newest crawl (version ${crawl.version ?? '?'}) did not see ${drifted.length} of the ${locators.filter((l) => l.comparable).length} comparable element(s) this test acts on: ${drifted.map((check) => `${check.locator} (line ${check.line})`).join(', ')}.`,
          `The route${routes.length === 1 ? '' : 's'} ${routes.filter((r) => r.reached).map((r) => r.route).join(', ')} ${routes.filter((r) => r.reached).length === 1 ? 'was' : 'were'} reached, so this is a comparison against a page the crawl actually loaded.`,
        ],
        caveats: [
          'The crawl records what it FOUND, not everything that exists, so this is a warning and not a proof. It is worth hearing before the test fails in CI rather than after.',
          ...(uncomparable.length > 0
            ? [
                `${uncomparable.length} further locator(s) could not be compared at all — QAAI’s crawler does not enumerate arbitrary CSS or locators held in variables — so this test may have drifted in ways not listed here.`,
              ]
            : []),
          /*
           * DRIFTED wins over PARTLY_UNREACHED below, because drift is the
           * actionable half and only a DRIFTED verdict becomes a warning in
           * `driftCheck` — demoting it would suppress a finding. The unreached
           * part of the test does not vanish for that, so it is said here.
           */
          ...(routes.some((route) => !route.reached)
            ? [
                `This test also drives ${routes.filter((route) => !route.reached).map((route) => route.route).join(', ')}, which the crawl did not reach, so the drift comparison covers part of this test and not all of it.`,
              ]
            : []),
        ],
        retirement: null,
      });
      continue;
    }

    // ─ Reached some, not others: a verdict that did not exist ─

    /*
     * THE DEFECT THIS BRANCH IS: a test driving /checkout and /invoice against a
     * complete crawl that reached only /checkout matched none of the branches
     * above — `allRoutesGone` needs every route missing, UNREACHED was gated on
     * nothing having been reached, DRIFTED needs a missing locator — and fell
     * through to CURRENT, with caveats empty and the sentence "every route this
     * test drives was reached by the newest crawl" attached to a route the crawl
     * never saw. The per-route facts in `routes[]` said the opposite the whole
     * time, which is the worst version of this: the evidence was right there and
     * the verdict contradicted it.
     *
     * It is NOT a retirement candidate and never can be. Part of what this test
     * drives is live, so there is nothing here that "the page is gone" describes
     * — whatever the missing routes turn out to be, the answer is an edit to the
     * test, not an end to it.
     */
    if (routes.some((route) => !route.reached)) {
      const notReached = routes.filter((route) => !route.reached);
      const reached = routes.filter((route) => route.reached);
      const gone = notReached.filter((route) => !route.declared);
      tests.push({
        ...base,
        verdict: 'PARTLY_UNREACHED',
        routes,
        locators,
        evidence: [
          `The newest crawl reached ${reached.map((route) => route.route).join(', ')} but not ${notReached.map((route) => route.route).join(', ')}, so part of what this test drives was compared and part of it was not.`,
          gone.length > 0
            ? `${gone.map((route) => route.route).join(', ')} ${gone.length === 1 ? 'is' : 'are'} absent from the application’s source as well as from the crawl, so ${gone.length === 1 ? 'it' : 'they'} may genuinely be gone — but this test also drives a page that is plainly there, so the answer is an edit to the test and not a retirement.`
            : `The application’s source still declares ${notReached.map((route) => route.route).join(', ')}, so this is a fact about how far our crawl got.`,
          `${locators.filter((check) => check.comparable).length} comparable element(s) were compared, against the route(s) the crawl did reach, and none of them had drifted.`,
        ],
        caveats: [
          'This test is NOT a retirement candidate: a test that still drives a live page is never proposed for retirement, whatever happened to its other routes.',
          `Nothing is claimed about this test’s use of ${notReached.map((route) => route.route).join(', ')} — a page the crawl did not load can neither be confirmed nor faulted from here.`,
          ...(uncomparable.length > 0
            ? [
                `${uncomparable.length} locator(s) could not be compared at all, so even the reached part of this comparison is over the comparable locators only.`,
              ]
            : []),
        ],
        retirement: null,
      });
      continue;
    }

    tests.push({
      ...base,
      verdict: 'CURRENT',
      routes,
      locators,
      evidence: [
        `Every route this test drives was reached by the newest crawl, and every element it acts on that the crawl can enumerate was seen${uncomparable.length > 0 ? ` (${uncomparable.length} could not be compared)` : ''}.`,
      ],
      caveats:
        uncomparable.length > 0
          ? [
              `${uncomparable.length} locator(s) could not be compared, so "nothing has drifted" is a claim about the comparable ones only.`,
            ]
          : [],
      retirement: null,
    });
  }

  const summary: Record<SurfaceVerdict, number> = {
    CURRENT: 0,
    DRIFTED: 0,
    UNREACHED: 0,
    PARTLY_UNREACHED: 0,
    OBSOLETE: 0,
    UNMEASURED: 0,
  };
  for (const report of tests) summary[report.verdict] += 1;

  const caveats: string[] = [];
  if (!haveCrawl) {
    caveats.push(
      'Nothing has crawled this application, so no test could be compared against anything. Every verdict here is UNMEASURED.',
    );
  } else if (crawlBlocked !== null) {
    caveats.push(
      `No retirement can be proposed from this crawl: ${crawlBlocked}. ` +
        'A route QAAI did not see looks exactly like a route that is gone, and only one of those two is worth acting on.',
    );
  }
  if (!sourceAnalysed) {
    caveats.push(
      'No source analysis has run for this project, so a route missing from the crawl cannot be checked against the code. Nothing is proposed for retirement on a crawl alone.',
    );
  } else if (declaredTruncated) {
    caveats.push(
      `The list of routes your source declares was capped before it reached this comparison (${declaredTruncated}), so no retirement can be proposed from it: a route past the end of that page looks exactly like a route the code does not declare.`,
    );
  }
  if (crawl.uncomparableAffordances > 0) {
    caveats.push(
      `${crawl.uncomparableAffordances} element(s) in the crawl have locators QAAI cannot compare (CSS fallbacks), so the drift comparison is over the role, label, placeholder, text and test-id locators only.`,
    );
  }
  caveats.push(
    'Drift is a lower bound in both directions: the crawl lists what it found, and this comparison only runs for routes it reached.',
  );
  const excludedTotal = OBSOLESCENCE_EXCLUSIONS.reduce((a, k) => a + exclusionCounts[k], 0);
  if (excludedTotal > 0) {
    caveats.push(
      `${excludedTotal} route-level absence(s) were NOT considered as evidence of deletion: ` +
        OBSOLESCENCE_EXCLUSIONS.filter((kind) => exclusionCounts[kind] > 0)
          .map((kind) => `${exclusionCounts[kind]} because ${OBSOLESCENCE_EXCLUSION_LABELS[kind]}`)
          .join(', ') +
        '.',
    );
  }

  return {
    crawl,
    sourceAnalysed,
    declaredRoutesTruncatedReason: declaredTruncated,
    tests,
    summary,
    caveats,
    retirementBlockedBy: crawlBlocked,
    crawlFeatures: [
      ...new Set((input.flowMap?.features ?? []).map((f) => f?.name).filter((n): n is string => typeof n === 'string')),
    ].sort(),
    declaredFeatures:
      input.declaredFeatures === undefined || input.declaredFeatures === null
        ? null
        : [...new Set(input.declaredFeatures)].sort(),
    exclusionCounts,
  };
}

/** The caller's exclusion covering this route, template-aware both ways, or null. */
function exclusionFor(
  route: string,
  exclusions: readonly RouteExclusion[],
): RouteExclusion | null {
  for (const candidate of exclusions) {
    const pattern = normalizeRoute(candidate.route);
    if (routeVisits(route, pattern) || routeVisits(pattern, route)) {
      return { ...candidate, route: pattern };
    }
  }
  return null;
}

/** Newest-first de-duplication by locator, so one element is reported once. */
function dedupeLocators(
  sites: readonly { line: number; locator: string }[],
): Array<{ line: number; locator: string }> {
  const seen = new Map<string, { line: number; locator: string }>();
  for (const site of sites) {
    if (site.locator === 'unknown') continue;
    if (!seen.has(site.locator)) seen.set(site.locator, site);
  }
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

// ─── The pre-failure drift check ─────────────────────────────────────────────

export interface DriftWarning {
  testId: string;
  name: string;
  filePath: string;
  priority: Priority;
  /** The locators the newest crawl did not see, with the line each is on. */
  missing: Array<{ locator: string; line: number }>;
  /** One sentence, ready to put in a notification. */
  summary: string;
}

export interface DriftCheck {
  /** The crawl this was computed against. Null version = no crawl. */
  crawlVersion: number | null;
  warnings: DriftWarning[];
  /** Tests that WILL be proposed for retirement, counted separately. */
  obsoleteCount: number;
  /** Verdict counts, so a reader can see the denominator behind the warnings. */
  summary: Record<SurfaceVerdict, number>;
  caveats: string[];
}

/**
 * The warning a new crawl should produce, before anything fails.
 *
 * Derived from the same audit rather than from a second scan, so the drift
 * screen and the retirement queue can never disagree about a test. A DRIFTED
 * test is the only kind that becomes a warning: an OBSOLETE one gets a
 * retirement proposal instead (a warning about a page that no longer exists is
 * advice nobody can act on), and UNREACHED, PARTLY_UNREACHED and UNMEASURED
 * produce nothing at all, which is the point of separating them. A test whose
 * reached routes HAVE drifted is DRIFTED even when its other routes were not
 * reached — see the verdict order in `auditTestsAgainstCrawl` — so no drift
 * warning is lost to the partial verdict.
 */
export function driftCheck(report: ObsoleteReport): DriftCheck {
  const warnings: DriftWarning[] = [];
  for (const test of report.tests) {
    if (test.verdict !== 'DRIFTED') continue;
    const missing = test.locators
      .filter((check) => check.comparable && !check.seen)
      .map((check) => ({ locator: check.locator, line: check.line }));
    if (missing.length === 0) continue;
    warnings.push({
      testId: test.testId,
      name: test.name,
      filePath: test.filePath,
      priority: test.priority,
      missing,
      summary:
        `"${test.name}" acts on ${missing.length} element(s) the newest crawl did not find ` +
        `(${missing.map((m) => m.locator).join(', ')}). It has not failed yet. Fix it now, or wait for ` +
        `the next run to tell you the same thing more expensively.`,
    });
  }

  return {
    crawlVersion: report.crawl.version,
    // Highest-priority, most-drifted first: a CRITICAL_PATH test about to break
    // is the one worth reading.
    warnings: warnings.sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        b.missing.length - a.missing.length ||
        a.name.localeCompare(b.name),
    ),
    obsoleteCount: report.summary.OBSOLETE,
    summary: report.summary,
    caveats: report.caveats,
  };
}

function priorityRank(priority: Priority): number {
  return priority === 'CRITICAL_PATH' ? 0 : priority === 'IMPORTANT' ? 1 : 2;
}

// ─── Signals, in the one suppression vocabulary ──────────────────────────────

/**
 * Obsolescence and retirement, rebuilt on `packages/shared/src/suppression.ts`.
 *
 * ── WHAT WAS WRONG WITH WHAT IS ABOVE ───────────────────────────────────────
 *
 * Everything above this line computes a correct verdict and then hands the
 * reviewer a `RetirementProposal` with a confidence and some prose. What it
 * never had is the four properties that make a suppression safe, and a
 * retirement is a suppression — it is the fifth kind in
 * `SUPPRESSION_KINDS`, and the one with the largest blast radius:
 *
 *   COUNTED      a retirement nobody counted is a test that stopped running and
 *                a board that went quiet for a reason nobody can name.
 *   OWNED        by a HUMAN. `isHumanSetProvenance` is the predicate: a glob may
 *                route a failure to a team, it may not decide that a test stops
 *                existing.
 *   EXPIRING     the PROPOSAL expires. A queue of proposals nobody reviewed is
 *                not a decision somebody is about to make, it is a backlog
 *                pretending to be one.
 *   REVERSIBLE   with the evidence kept, so "we retired this and put it back" is
 *                a question with an answer.
 *
 * ── AND THE ONE THAT MATTERS MOST ───────────────────────────────────────────
 *
 * RETIRING A TEST MAKES ITS SURFACE UNCOVERED AGAIN. The surface stays in the
 * denominator; the numerator goes DOWN. A retirement that quietly improved the
 * coverage percentage would be the worst defect this module could ship, because
 * it would turn "delete the failing tests" into the fastest way to hit a
 * coverage target — and the product would then be actively worse than no
 * product. {@link coverageAfterRetirement} is that rule as arithmetic rather
 * than as a comment: the denominator is passed through untouched and the
 * covered count can only fall.
 *
 * Nothing here calls a model. Signal derivation is a set difference, admission
 * is a count against a threshold, and the owner and expiry checks are the
 * keystone's.
 */

/** A persisted `ObsoleteTestSignal` row, as the caller reads it back. */
export interface PriorObsolescenceSignal {
  testId: string;
  kind: ObsolescenceSignalKind;
  /** The route, locator or feature name, verbatim — the row's third unique key. */
  reference: string;
  confirmations: number;
}

export interface TestObsolescenceSignals {
  testId: string;
  name: string;
  filePath: string;
  signals: ObsolescenceSignal[];
}

export interface ObsolescenceSignalReport {
  /**
   * Null when signals were derived. Otherwise the reason none were, and the
   * reason is never "there was nothing wrong".
   *
   * A CANDIDATE crawl must not contribute a CONFIRMATION, which is why this
   * gate is here and not only in {@link proposeRetirement}: confirmations
   * accumulate across crawls, so one degraded crawl that was allowed to add one
   * would let two degraded crawls retire a test between them.
   */
  withheldBecause: string | null;
  tests: TestObsolescenceSignals[];
  /** Every kind, always present, so "none of these" and "we did not look" differ. */
  counts: Record<ObsolescenceSignalKind, number>;
  /** Signals now at or above {@link OBSOLESCENCE_MIN_CONFIRMATIONS}. */
  confirmed: number;
}

const SIGNAL_SEP = '\u0000';

function priorKey(testId: string, kind: ObsolescenceSignalKind, reference: string): string {
  return `${testId}${SIGNAL_SEP}${kind}${SIGNAL_SEP}${reference}`;
}

/**
 * Derive this crawl's obsolescence signals, with confirmations carried forward.
 *
 * `prior` is the `ObsoleteTestSignal` rows already stored for these tests. A
 * signal seen before has its confirmation count INCREMENTED; a signal seen for
 * the first time starts at 1, which is below the threshold by construction —
 * so no single crawl can ever produce an admissible retirement, whatever it
 * saw. That is the same rule the unique key `(testId, kind, reference)` enforces
 * in the database, implemented here so the two cannot disagree.
 */
export function obsolescenceSignalsFor(
  report: ObsoleteReport,
  prior: readonly PriorObsolescenceSignal[] = [],
): ObsolescenceSignalReport {
  const counts: Record<ObsolescenceSignalKind, number> = {
    ROUTE_GONE: 0,
    LOCATOR_GONE: 0,
    ROUTE_UNREACHABLE: 0,
    FEATURE_GONE: 0,
  };

  if (report.retirementBlockedBy !== null) {
    return {
      withheldBecause: `No obsolescence signal was recorded from this crawl: ${report.retirementBlockedBy}. A signal from a crawl that cannot support a retirement would still count towards one.`,
      tests: [],
      counts,
      confirmed: 0,
    };
  }

  const priorCounts = new Map<string, number>();
  for (const row of prior) {
    priorCounts.set(priorKey(row.testId, row.kind, row.reference), row.confirmations);
  }

  const tests: TestObsolescenceSignals[] = [];
  let confirmed = 0;

  for (const test of report.tests) {
    const signals: ObsolescenceSignal[] = [];
    const add = (kind: ObsolescenceSignalKind, reference: string): void => {
      const seenBefore = priorCounts.get(priorKey(test.testId, kind, reference)) ?? 0;
      signals.push({ kind, reference, confirmations: seenBefore + 1 });
      counts[kind] += 1;
      if (seenBefore + 1 >= OBSOLESCENCE_MIN_CONFIRMATIONS) confirmed += 1;
    };

    for (const route of test.routes) {
      if (route.reached) continue;
      // An EXCLUDED route produces no signal of any kind. Its absence is
      // already explained, and a ROUTE_UNREACHABLE row for a dark flag would
      // accumulate confirmations towards a retirement of a live feature.
      if (route.excluded !== null) continue;
      if (route.declared) add('ROUTE_UNREACHABLE', route.route);
      else add('ROUTE_GONE', route.route);
    }

    for (const locator of test.locators) {
      if (locator.comparable && !locator.seen) add('LOCATOR_GONE', locator.locator);
    }

    /*
     * FEATURE_GONE needs BOTH negatives and an unexcluded clean sweep.
     *
     * `declaredFeatures: null` withholds it entirely rather than reading "we
     * were not told which features the source declares" as "the feature is
     * gone" — the exact mistake `declaredRoutes: null` already exists to stop
     * on the route side.
     */
    const everyRouteGone =
      test.routes.length > 0 &&
      test.routes.every((route) => !route.reached && !route.declared && route.excluded === null);
    if (
      test.feature !== null &&
      test.feature.length > 0 &&
      report.declaredFeatures !== null &&
      everyRouteGone &&
      !report.crawlFeatures.includes(test.feature) &&
      !report.declaredFeatures.includes(test.feature)
    ) {
      add('FEATURE_GONE', test.feature);
    }

    if (signals.length > 0) {
      tests.push({
        testId: test.testId,
        name: test.name,
        filePath: test.filePath,
        signals: signals.sort(
          (a, b) =>
            OBSOLESCENCE_SIGNAL_RULES[b.kind].confidence -
              OBSOLESCENCE_SIGNAL_RULES[a.kind].confidence ||
            a.reference.localeCompare(b.reference),
        ),
      });
    }
  }

  return { withheldBecause: null, tests, counts, confirmed };
}

// ─── The coverage arithmetic, so the rule cannot be forgotten ────────────────

export interface CoverageAfterRetirement {
  /** UNCHANGED. The application still has those surfaces. */
  denominator: number;
  coveredBefore: number;
  /** Never above {@link coveredBefore}. */
  coveredAfter: number;
  /** Null when the denominator is 0 — a null that became 0 is its own lie. */
  percentBefore: number | null;
  percentAfter: number | null;
  disclosure: string;
}

/**
 * The coverage numbers after a set of retirements is applied.
 *
 * THE DEFECT THIS IS: every other way of writing this invites the caller to
 * shrink the denominator, because shrinking the denominator is what makes the
 * arithmetic come out flattering and nobody notices a number that went the
 * direction they wanted. Here the denominator is an input that is returned
 * unmodified and `coveredAfter` is `coveredBefore` minus the surfaces that lost
 * their only cover, clamped at zero. There is no argument that could make this
 * function raise a percentage.
 */
export function coverageAfterRetirement(args: {
  denominator: number;
  covered: number;
  surfacesReturnedToUncovered: number;
}): CoverageAfterRetirement {
  const denominator = Math.max(0, Math.trunc(args.denominator));
  const coveredBefore = Math.max(0, Math.min(Math.trunc(args.covered), denominator));
  const coveredAfter = Math.max(0, coveredBefore - Math.max(0, Math.trunc(args.surfacesReturnedToUncovered)));
  const pct = (n: number): number | null =>
    denominator === 0 ? null : Math.round((n / denominator) * 1000) / 10;
  const before = pct(coveredBefore);
  const after = pct(coveredAfter);
  return {
    denominator,
    coveredBefore,
    coveredAfter,
    percentBefore: before,
    percentAfter: after,
    disclosure:
      denominator === 0
        ? 'No surface is being measured, so retiring a test changes no coverage number. The percentage is UNAVAILABLE rather than 0.'
        : coveredAfter === coveredBefore
          ? `Coverage is unchanged at ${after}%: every surface these tests reached is also reached by another test. The denominator stays at ${denominator}.`
          : `Coverage falls from ${before}% to ${after}%. The denominator stays at ${denominator} — the application still has these surfaces and now nothing tests them.`,
  };
}

// ─── Proposing a retirement ──────────────────────────────────────────────────

export const RETIREMENT_REFUSALS = [
  /** The audit did not call this test obsolete. */
  'VERDICT_NOT_OBSOLETE',
  /** The crawl was REJECTED, held as a CANDIDATE, never adjudicated, or truncated. */
  'CRAWL_DOES_NOT_SUPPORT_RETIREMENT',
  /** Too few confirmations, or only weak signals. `retirementAdmissible`'s own reason. */
  'SIGNALS_NOT_ADMISSIBLE',
  /** The owner or the expiry did not satisfy `applySuppression`. */
  'SUPPRESSION_REFUSED',
] as const;
export type RetirementRefusal = (typeof RETIREMENT_REFUSALS)[number];

export interface RetirementRecord {
  testId: string;
  name: string;
  filePath: string;
  /** Always PROPOSED from here. Nothing in this module applies anything. */
  state: RetirementState;
  /**
   * The strongest confirmed signal's DECLARED confidence from
   * `OBSOLESCENCE_SIGNAL_RULES` — a prior from a table, not a measurement, and
   * never 1: this is an argument from absence however well fenced.
   */
  confidence: number;
  explanation: string;
  evidence: string[];
  signals: ObsolescenceSignal[];
  /** What this does to the coverage number. Carried, not remembered. */
  denominator: RetirementDenominatorEffect;
  /** Owner, expiry and count, from the one constructor. */
  suppression: Suppression;
  /** How to undo it, in the reviewer's terms. */
  reversal: string;
}

export interface RetirementRefused {
  proposed: false;
  refusal: RetirementRefusal;
  /** The PATH of the offending field, never a message built from its value. */
  path: string;
  /** One sentence for the reviewer. Never assembled from customer text. */
  why: string;
  /** The keystone's own refusal when `refusal` is SUPPRESSION_REFUSED. */
  suppressionRefusal: SuppressionRefusal | null;
}

export type RetirementDecision = { proposed: true; proposal: RetirementRecord } | RetirementRefused;

export interface RetirementRequest {
  report: ObsoleteReport;
  test: TestSurfaceReport;
  signals: readonly ObsolescenceSignal[];
  /** Surface item ids this test covers. */
  covers: readonly string[];
  /** Of those, the ones some OTHER live test also covers. */
  alsoCoveredElsewhere: readonly string[];
  owner: OwnerRef | null;
  ownerProvenance: OwnerProvenance;
  /** Review window in days. Clamped to the kind's ceiling by `expiryFor`. */
  reviewDays: number;
}

/**
 * Propose retiring one test, or refuse and say which condition was missing.
 *
 * Four gates, in this order, because the cheapest and most decisive one goes
 * first: the crawl, then the verdict, then the signals, then the ownership and
 * expiry rules that every suppression in this product shares. The order is also
 * the order a reader wants the answer in — "your crawl was degraded" is a more
 * useful sentence than "this test has only weak signals", and both are true.
 */
export function proposeRetirement(request: RetirementRequest, now: Date): RetirementDecision {
  if (request.report.retirementBlockedBy !== null) {
    return {
      proposed: false,
      refusal: 'CRAWL_DOES_NOT_SUPPORT_RETIREMENT',
      path: 'report.crawl.acceptance',
      why: `No retirement can be proposed: ${request.report.retirementBlockedBy}.`,
      suppressionRefusal: null,
    };
  }

  if (request.test.verdict !== 'OBSOLETE') {
    return {
      proposed: false,
      refusal: 'VERDICT_NOT_OBSOLETE',
      path: 'test.verdict',
      why: `This test is ${request.test.verdict}, not OBSOLETE. Only a test whose every route is absent from both the crawl and the source is a retirement candidate.`,
      suppressionRefusal: null,
    };
  }

  const admission = retirementAdmissible(request.signals);
  if (!admission.admissible) {
    return {
      proposed: false,
      refusal: 'SIGNALS_NOT_ADMISSIBLE',
      path: 'signals',
      why: admission.reason,
      suppressionRefusal: null,
    };
  }

  const denominator = retirementDenominatorEffect({
    covers: request.covers,
    alsoCoveredElsewhere: request.alsoCoveredElsewhere,
  });

  /*
   * The reason sentence is composed from QAAI'S OWN RECORDS ONLY — the test id,
   * the route strings the audit matched, the signal kinds. The test's NAME is
   * customer text and it is deliberately absent from here: this string ends up
   * on a `Suppression` row and in an audit entry, and a name is the one field
   * an attacker controls.
   */
  const strong = request.signals
    .filter(
      (s) =>
        s.confirmations >= OBSOLESCENCE_MIN_CONFIRMATIONS &&
        OBSOLESCENCE_SIGNAL_RULES[s.kind].soleBasisForRetirement,
    )
    .sort(
      (a, b) =>
        OBSOLESCENCE_SIGNAL_RULES[b.kind].confidence - OBSOLESCENCE_SIGNAL_RULES[a.kind].confidence,
    );

  const applied = applySuppression(
    {
      kind: 'RETIREMENT',
      target: { scope: 'TEST', key: request.test.testId },
      reason: `Obsolete: ${strong.map((s) => s.kind).join(', ')} confirmed by at least ${OBSOLESCENCE_MIN_CONFIRMATIONS} accepted crawls.`,
      owner: request.owner,
      ownerProvenance: request.ownerProvenance,
      expiresAt: expiryFor('RETIREMENT', now, request.reviewDays),
      // Checked against the kind's own rule rather than trusted. A caller that
      // believed retirement shrinks the denominator is refused here instead of
      // being quietly corrected and shipping a wrong percentage elsewhere.
      expectedDenominator: 'RETURNS_TO_UNCOVERED',
    },
    now,
  );

  if (!applied.applied) {
    return {
      proposed: false,
      refusal: 'SUPPRESSION_REFUSED',
      path: applied.path,
      why: 'A retirement is a suppression: it needs a named human owner and a review window that expires.',
      suppressionRefusal: applied.refusal,
    };
  }

  const confidence = Math.min(
    0.95,
    strong.length > 0 ? OBSOLESCENCE_SIGNAL_RULES[strong[0]!.kind].confidence : 0,
  );

  return {
    proposed: true,
    proposal: {
      testId: request.test.testId,
      name: request.test.name,
      filePath: request.test.filePath,
      state: 'PROPOSED',
      confidence,
      explanation:
        `Every route this test drives is absent from an ACCEPTED crawl and from the application's source ` +
        `(${request.test.routes.map((route) => route.route).join(', ')}), confirmed across ` +
        `${OBSOLESCENCE_MIN_CONFIRMATIONS} or more crawls. Retiring it DISABLES the test — the code stays in your ` +
        `repository and in its history. ${denominator.disclosure}`,
      evidence: [...request.test.evidence, admission.reason, denominator.disclosure],
      signals: [...request.signals],
      denominator,
      suppression: applied.suppression,
      reversal:
        'Reject or revoke this proposal and the test runs again on the next run. ' +
        'The surfaces it covered are reopened as UNCOVERED when it is applied and re-close when it is reverted, so the coverage number tracks the decision in both directions.',
    },
  };
}

// ─── Counted, out loud ───────────────────────────────────────────────────────

export interface RetirementSummary {
  proposed: number;
  /** Every refusal reason, always present. */
  refused: Record<RetirementRefusal, number>;
  /** Surfaces that would go back to UNCOVERED across all proposals. */
  surfacesReturnedToUncovered: number;
  /** Surfaces that stay covered because another live test reaches them. */
  surfacesStillCovered: number;
  /** Through the one summariser, so retirement is counted like every other kind. */
  suppressions: SuppressionSummary;
  disclosure: string;
}

/**
 * The sentence a reviewer sees above the queue.
 *
 * Reports the refusals as loudly as the proposals. "No retirement candidates"
 * and "nine candidates, all refused because your crawl was degraded" are
 * completely different facts about a project, and a surface that showed only
 * the first would teach a customer that the feature does nothing.
 */
export function summariseRetirements(decisions: readonly RetirementDecision[]): RetirementSummary {
  const refused: Record<RetirementRefusal, number> = {
    VERDICT_NOT_OBSOLETE: 0,
    CRAWL_DOES_NOT_SUPPORT_RETIREMENT: 0,
    SIGNALS_NOT_ADMISSIBLE: 0,
    SUPPRESSION_REFUSED: 0,
  };
  let proposed = 0;
  let returned = 0;
  let stillCovered = 0;
  for (const decision of decisions) {
    if (decision.proposed) {
      proposed += 1;
      returned += decision.proposal.denominator.surfacesReturnedToUncovered.length;
      stillCovered += decision.proposal.denominator.surfacesStillCovered.length;
    } else {
      refused[decision.refusal] += 1;
    }
  }

  const tallies: SuppressionTally[] =
    proposed > 0
      ? [{ kind: 'RETIREMENT', suppressions: proposed, suppressed: proposed, expired: 0 }]
      : [];
  const suppressions = summariseSuppressions(tallies);

  const refusalParts = RETIREMENT_REFUSALS.filter((kind) => refused[kind] > 0).map(
    (kind) => `${refused[kind]} ${kind}`,
  );

  return {
    proposed,
    refused,
    surfacesReturnedToUncovered: returned,
    surfacesStillCovered: stillCovered,
    suppressions,
    disclosure:
      `${proposed} retirement(s) proposed for review` +
      (proposed > 0
        ? `, which would return ${returned} surface(s) to UNCOVERED (${stillCovered} stay covered by another test). The coverage percentage goes DOWN, not up.`
        : '.') +
      (refusalParts.length > 0 ? ` ${refusalParts.join(', ')} refused.` : ''),
  };
}
