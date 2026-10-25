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
import type { FlowMap, Priority } from '@qaai/shared';
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
  };
}

// ─── Per-test verdict ────────────────────────────────────────────────────────

export type SurfaceVerdict =
  | 'CURRENT'
  | 'DRIFTED'
  | 'UNREACHED'
  | 'PARTLY_UNREACHED'
  | 'OBSOLETE'
  | 'UNMEASURED';

export interface RouteCheck {
  route: string;
  /** The crawl got here. */
  reached: boolean;
  /** The application's source still declares it. */
  declared: boolean;
  /** The extractor used to find this route and no longer does. */
  retired: boolean;
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
  const declaredTruncated = input.declaredRoutesTruncatedReason ?? null;
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
    };

    const routes: RouteCheck[] = [...new Set(routesOf(behavior.routes))]
      .sort()
      .map((route) => ({
        route,
        reached: matchesAny(route, crawl.routes),
        declared: matchesAny(route, declared),
        retired: matchesAny(route, retired),
      }));

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

    const missingRoutes = routes.filter((route) => !route.reached && !route.declared);
    const unreachedRoutes = routes.filter((route) => !route.reached && route.declared);

    // ─ OBSOLETE, and only under every condition at once ─

    const allRoutesGone = missingRoutes.length === routes.length;
    if (allRoutesGone && sourceAnalysed && completeCrawl && completeSource) {
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
        : !completeCrawl
          ? `the crawl stopped early (${crawl.truncatedReason}), so a route it did not reach may simply be past where it stopped`
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
            : !completeCrawl
              ? 'Re-crawl with a wider budget and this test gets a real verdict.'
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
  } else if (crawl.truncatedReason) {
    caveats.push(
      `The crawl stopped early (${crawl.truncatedReason}), so no retirement can be proposed from it: a route past where a crawl stopped looks exactly like a route that is gone.`,
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

  return {
    crawl,
    sourceAnalysed,
    declaredRoutesTruncatedReason: declaredTruncated,
    tests,
    summary,
    caveats,
  };
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
