/**
 * Matches tests to surface items, and does the division.
 *
 * This is the file that turns an inventory into a number. Three rules decide
 * everything in it, and all three exist because the failure mode of a coverage
 * product is not being slightly wrong — it is being confidently wrong in the
 * direction that flatters the vendor.
 *
 * 1. ASYMMETRIC MATCHING. Strict where the evidence is strong, generous where
 *    it is weak. A route literal either appears in a spec or it does not, so
 *    route matching is exact on the canonical key. A form has no literal to
 *    match, so a form counts as exercised if a test mentions any of its field
 *    names or its submit label — generous on purpose, because a false "nobody
 *    tests your signup form" is the claim that makes a team close the tab.
 *
 * 2. UNKNOWN IS NOT UNCOVERED. A test that navigates to a URL built at run time
 *    is invisible to static extraction. It might be the only test covering
 *    /refunds. Marking that route uncovered would assert knowledge we do not
 *    have, so the presence of such tests moves affected items to UNKNOWN rather
 *    than inflating the gap count. This is inherited from coverage.ts and is
 *    the single most important rule here.
 *
 * 3. WRITTEN IS NOT RUN. A string appearing in a spec file proves a test was
 *    written. It does not prove the test executes, passes, or asserts anything.
 *    So a match alone yields ASSERTED_NOT_RUN, and only observed execution
 *    yields COVERED. Every competitor that publishes a percentage conflates
 *    these two; keeping them apart costs us headline points and is the reason
 *    the number can be defended.
 */

import { createHash } from 'node:crypto';
import {
  COVERED_STATUSES,
  MEASURED_SURFACE_KINDS,
  surfaceKey,
  totalsForItems,
  type SurfaceItem,
  type SurfaceItemCoverage,
  type SurfaceKind,
  type SurfaceMatch,
  type SurfaceSnapshotTotals,
  type SurfaceStatus,
  type SurfaceWaiver,
  type TestResultStatus,
} from '@qaai/shared';
import { canonicalRoute, routeVisits, type CoverageTestInput } from './coverage.js';

// ─── Input ───────────────────────────────────────────────────────────────────

/** What a run told us about a test, so `executed` can be more than a guess. */
export interface TestExecutionFact {
  testId: string;
  runId: string;
  /** The runner's own vocabulary; see TEST_RESULT_STATUSES in shared. */
  status: TestResultStatus;
  /**
   * When this result was recorded, ISO-8601.
   *
   * Load-bearing: several tests can match one surface item, so "the last run"
   * is only answerable by comparing dates. Without it the matcher took
   * whichever matched test it happened to see first.
   */
  atIso: string;
  /**
   * Whether this test has EVER passed, which the caller knows from history the
   * single latest result cannot show.
   */
  everPassed?: boolean;
  /** Null when no mutation run has had an opinion about this test. */
  mutationKilled?: boolean | null;
  /**
   * Whether this test's quarantine is IN FORCE, as the caller answered it with
   * `quarantineSuppresses` from @qaai/runner — not a raw read of
   * `Test.quarantined`, because an expired quarantine gates again.
   *
   * ── WHY THIS FIELD CHANGES A NUMBER ───────────────────────────────────────
   *
   * A quarantined test's result is suppressed from every gate rule. So
   * coverage attributed to it is coverage nothing will ever check, and this
   * matcher used to count it identically to a test that ran green an hour ago.
   * Three parts of the product then disagreed about one test: this report
   * called its surface COVERED, `gates.ts` excluded it from every rule, and
   * suite health counted it as a liability.
   *
   * The item keeps its match and its ASSERTED_NOT_RUN status — somebody DID
   * write a test, and erasing that would be the opposite error — and stops
   * being COVERED. That is precisely the DECLARED rung of the coverage ladder
   * in @qaai/shared's coverage-tiers.ts, which `surfaceStatusForTier` maps onto
   * ASSERTED_NOT_RUN; see this file's note on why the ladder is not imported
   * here yet.
   *
   * Absent is read as not quarantined, which is what every caller that does not
   * pass it has always meant.
   */
  quarantined?: boolean;
  /**
   * §5 — a retry that passes is not a pass. RECORDED, and deliberately not used
   * to withhold coverage: covered-and-flaky are two facts, exactly as
   * covered-and-failing are, and pass/fail is the run report's grade rather
   * than the denominator's.
   */
  retriedAndPassed?: boolean;
}

export interface SurfaceCoverageInput {
  items: readonly SurfaceItem[];
  tests: readonly CoverageTestInput[];
  /**
   * The most recent execution of each test. Absent entries are not failures —
   * they are tests that have never run, which is exactly ASSERTED_NOT_RUN.
   */
  executions?: readonly TestExecutionFact[];
  /** Keyed by surface key. A waived item leaves the denominator entirely. */
  waivers?: Readonly<Record<string, SurfaceWaiver>>;
}

export interface SurfaceCoverageResult {
  entries: SurfaceItemCoverage[];
  totals: SurfaceSnapshotTotals;
  caveats: string[];
  fingerprint: string;
}

// ─── Reading tests ───────────────────────────────────────────────────────────

/**
 * A test whose navigation we cannot see.
 *
 * `page.goto(url)` where `url` is a variable, a template with an expression, or
 * a helper call. coverage.ts already treats these as project-wide confidence
 * caps; here they cap the ROUTE axis specifically, because a runtime URL tells
 * us nothing about forms or endpoints.
 */
function navigatesOpaquely(code: string | null): boolean {
  if (!code) return false;
  // A goto whose argument is not a plain quoted string.
  return /\.goto\(\s*(?!['"`][^'"`$]*['"`]\s*[),])/.test(code);
}

/** Lower-cased source, cached per test, for the heuristic matchers. */
function haystack(test: CoverageTestInput): string {
  return (test.code ?? '').toLowerCase();
}

/**
 * Reads a string out of an item's `meta`.
 *
 * `meta` is `Record<string, unknown>` because its shape differs per axis, so a
 * bare `String(meta.path)` would turn an object into the literal text
 * `[object Object]` and then cheerfully match it against source. A matcher that
 * can silently compare against a stringified object is a matcher that can
 * report coverage it does not have, so the narrowing is explicit.
 */
function metaString(item: SurfaceItem, key: string): string {
  const value = item.meta?.[key];
  return typeof value === 'string' ? value : '';
}

// ─── Matchers, one per axis ──────────────────────────────────────────────────

/**
 * ROUTE — strict. The canonical key either matches or it does not.
 *
 * `routeVisits` is reused rather than reimplemented so a spec's `/orders/123`
 * and an inventory's `/orders/:param` are one route, and `/docs/*` swallows its
 * subtree. Both sides have already been through `canonicalRoute`.
 */
function matchRoute(item: SurfaceItem, tests: readonly CoverageTestInput[]): SurfaceMatch[] {
  const target = item.key.slice('ROUTE:'.length);
  const matches: SurfaceMatch[] = [];
  for (const test of tests) {
    for (const raw of test.routes) {
      const declared = canonicalRoute(raw);
      if (!routeVisits(declared, target)) continue;
      matches.push({
        testId: test.id,
        testName: test.name,
        basis: declared === target ? 'LITERAL' : 'NORMALISED',
        evidence:
          declared === target
            ? `${test.filePath} navigates to ${target}`
            : `${test.filePath} navigates to ${declared}, which is ${target}`,
      });
      break;
    }
  }
  return matches;
}

/**
 * ENDPOINT — strict on the path, tolerant on how the call is spelled.
 *
 * A test hits an endpoint through `request.post('/api/x')`, a fetch, an API
 * plugin spec, or a route literal that happens to be the same string. So the
 * path must appear, and the method must appear somewhere near it or the test
 * must be an API-type test. An endpoint whose verb we could not read
 * (`UNKNOWN`) matches on path alone — claiming otherwise would hold the
 * customer responsible for our unreadable parse.
 */
function matchEndpoint(item: SurfaceItem, tests: readonly CoverageTestInput[]): SurfaceMatch[] {
  const method = metaString(item, 'method') || 'UNKNOWN';
  const path = metaString(item, 'path');
  if (!path) return [];

  const matches: SurfaceMatch[] = [];
  for (const test of tests) {
    const code = haystack(test);
    // The path as a literal, or via the route list (an API spec's url field
    // comes through the same extractor).
    const pathSeen =
      test.routes.some((raw) => routeVisits(canonicalRoute(raw), path)) ||
      (code.length > 0 && code.includes(path.toLowerCase()));
    if (!pathSeen) continue;

    const verbUnreadable = method === 'UNKNOWN';
    const verbSeen =
      verbUnreadable ||
      test.testType === 'API' ||
      test.testType === 'CONTRACT' ||
      code.includes(`'${method.toLowerCase()}'`) ||
      code.includes(`"${method.toLowerCase()}"`) ||
      code.includes(`.${method.toLowerCase()}(`) ||
      code.includes(`method: '${method.toLowerCase()}'`);
    if (!verbSeen) continue;

    matches.push({
      testId: test.id,
      testName: test.name,
      basis: verbUnreadable ? 'HEURISTIC' : 'NORMALISED',
      evidence: verbUnreadable
        ? `${test.filePath} references ${path}; this endpoint's HTTP verb could not be read from source, so the path alone is taken as covering it`
        : `${test.filePath} issues ${method} against ${path}`,
    });
  }
  return matches;
}

/**
 * FORM — generous, because there is no literal to be strict about.
 *
 * A form is exercised if a test fills any of its fields or clicks its submit
 * control. Field names and labels are the signal; the submit label is a weaker
 * one and is accepted too. Short field names are ignored — a form with a field
 * called `id` would otherwise be matched by every test in the suite, which is
 * the generous direction taken too far.
 */
function matchForm(item: SurfaceItem, tests: readonly CoverageTestInput[]): SurfaceMatch[] {
  const fields = Array.isArray(item.meta?.fields)
    ? (item.meta.fields as Array<{ name?: string; label?: string | null }>)
    : [];
  const needles = new Set<string>();
  for (const field of fields) {
    for (const candidate of [field.name, field.label]) {
      // Four characters is the shortest length at which a field name is more
      // likely to be a field name than a coincidence.
      if (candidate && candidate.length >= 4) needles.add(candidate.toLowerCase());
    }
  }
  const submitLabel = metaString(item, 'submitLabel');
  if (submitLabel.length >= 4) needles.add(submitLabel.toLowerCase());
  if (needles.size === 0) return [];

  const matches: SurfaceMatch[] = [];
  for (const test of tests) {
    const code = haystack(test);
    if (!code) continue;
    const hit = [...needles].find((needle) => code.includes(needle));
    if (!hit) continue;
    matches.push({
      testId: test.id,
      testName: test.name,
      basis: 'HEURISTIC',
      evidence: `${test.filePath} mentions "${hit}", a field or control of this form`,
    });
  }
  return matches;
}

/**
 * AUTH_SURFACE — the route plus the act.
 *
 * Reaching /login is not testing login. So the surface's path must be reached
 * AND the test must do the thing: sign in, submit a password, assert a
 * rejection. `signsIn` already exists in coverage.ts for the project-wide
 * authenticated-route question; here the same signal is applied per surface.
 */
function matchAuthSurface(item: SurfaceItem, tests: readonly CoverageTestInput[]): SurfaceMatch[] {
  const path = metaString(item, 'path');
  const authKind = metaString(item, 'authKind').toLowerCase();
  const matches: SurfaceMatch[] = [];

  for (const test of tests) {
    const code = haystack(test);
    const reaches =
      test.routes.some((raw) => routeVisits(canonicalRoute(raw), path)) ||
      (code.length > 0 && path.length > 1 && code.includes(path.toLowerCase()));
    if (!reaches) continue;

    /**
     * The act, not just the arrival — and the path must be removed from the
     * haystack before looking for it.
     *
     * Without this, `await page.goto('/login')` satisfies the check: the
     * string `/login` contains `login`, so a test that merely opens the page
     * reads as a test that signs in. That is precisely the false positive this
     * matcher exists to avoid, and it is the easy mistake — reaching a login
     * page is the one thing almost every suite does.
     */
    const withoutPath = path.length > 1 ? code.split(path.toLowerCase()).join(' ') : code;
    const acts =
      /password|sign\s*in|signin|log\s*in|credential|otp|magic\s*link|reset|verif|sso|saml|auth\(/.test(
        withoutPath,
      ) || withoutPath.includes(authKind.replace(/_/g, ' '));
    if (!acts) continue;

    matches.push({
      testId: test.id,
      testName: test.name,
      basis: 'HEURISTIC',
      evidence: `${test.filePath} reaches ${path} and exercises an authentication step`,
    });
  }
  return matches;
}

const MATCHERS: Partial<
  Record<SurfaceKind, (item: SurfaceItem, tests: readonly CoverageTestInput[]) => SurfaceMatch[]>
> = {
  ROUTE: matchRoute,
  ENDPOINT: matchEndpoint,
  FORM: matchForm,
  AUTH_SURFACE: matchAuthSurface,
};

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * ── WHY THE COVERAGE LADDER IS NOT IMPORTED HERE ────────────────────────────
 *
 * `packages/shared/src/coverage-tiers.ts` holds the five-rung ladder and
 * `surfaceStatusForTier`, which maps a rung onto the three words below:
 * NAVIGATED and above → COVERED, DECLARED → ASSERTED_NOT_RUN, null →
 * UNCOVERED. This function implements exactly that mapping and should BE that
 * call, so that there is one definition of covered in the product instead of
 * two.
 *
 * It is not, yet, for one mechanical reason: coverage-tiers.ts is not on
 * `packages/shared/src/index.ts`, and nothing outside @qaai/shared can import
 * it until the barrel line lands. Reaching it by a relative path across the
 * workspace boundary compiles and silently bypasses the package entry point,
 * which is a defect nine files in this repo have already committed, so it is
 * not done here. The one-line change is reported in this round's
 * needsFromOtherFiles; when it lands, the three branches below become
 * `surfaceStatusForTier(promoteCoverageTier(evidence, nowIso).tier)` and the
 * `quarantined` handling comes for free from the ladder's TEST_QUARANTINED cap.
 */
function statusFor(
  item: SurfaceItem,
  matches: readonly SurfaceMatch[],
  /** A terminal status was observed — not necessarily a passing one. */
  executed: boolean,
  opaqueNavigation: boolean,
  waived: boolean,
): SurfaceStatus {
  if (waived) return 'WAIVED';
  if (matches.length > 0) return executed ? 'COVERED' : 'ASSERTED_NOT_RUN';
  // Rule 2: a suite that navigates to URLs we cannot read makes an unmatched
  // ROUTE unknowable rather than uncovered. It does not make a FORM or an
  // ENDPOINT unknowable — a runtime URL says nothing about those.
  if (opaqueNavigation && item.kind === 'ROUTE') return 'UNKNOWN';
  return 'UNCOVERED';
}

// ─── The division ────────────────────────────────────────────────────────────

export function analyseSurfaceCoverage(input: SurfaceCoverageInput): SurfaceCoverageResult {
  const { items, tests } = input;
  const waivers = input.waivers ?? {};

  const executions = new Map<string, TestExecutionFact>();
  for (const fact of input.executions ?? []) executions.set(fact.testId, fact);

  /**
   * Items at least one of whose matched tests is quarantined. Collected so the
   * caveat can report the count — an item that silently stopped being covered
   * is the same defect as one that silently started.
   */
  const quarantinedCovers = new Set<string>();

  const opaqueTests = tests.filter((test) => navigatesOpaquely(test.code));
  const opaqueNavigation = opaqueTests.length > 0;
  const truncatedTests = tests.filter((test) => test.coverageTruncated === true);

  const entries: SurfaceItemCoverage[] = items.map((item) => {
    const matcher = MATCHERS[item.kind];
    const matches = matcher ? matcher(item, tests) : [];

    /*
     * Rule 3: a match is not an execution — and the three questions below are
     * three different questions.
     *
     * This block used to let a PASSED result overwrite `lastRunId`/`lastStatus`
     * whatever its date, so an item whose newest run FAILED reported
     * `lastStatus: 'PASSED'` from an older run. That is a wrong fact in the
     * direction that flatters the vendor, printed on a surface whose only test
     * is red. It also took the FIRST matched test's result as "the last run",
     * which is only correct when exactly one test matches.
     *
     * So: `lastRunId`/`lastStatus` is the genuinely newest execution across
     * every matched test, chosen by timestamp; `everPassed` is its own field;
     * and `executed` means a terminal status was observed, pass or fail.
     */
    let latest: TestExecutionFact | null = null;
    let everPassed = false;
    let executed = false;
    let mutationKilled: boolean | null = null;
    const quarantinedTestIds: string[] = [];
    for (const match of matches) {
      const fact = executions.get(match.testId);
      if (!fact) continue;
      if (fact.quarantined === true) {
        /*
         * A SUPPRESSED RESULT MAY NOT MAKE AN ITEM EXERCISED.
         *
         * `executed` is skipped and nothing else is: the row still wins
         * `lastStatus` and `everPassed` below, because the result exists and a
         * reader is entitled to see it. What it must not do is move the item
         * from ASSERTED_NOT_RUN to COVERED, which is the rung the ladder calls
         * DECLARED for exactly this reason.
         */
        quarantinedTestIds.push(match.testId);
        if (fact.status === 'PASSED' || fact.everPassed === true) everPassed = true;
        if (!latest || fact.atIso > latest.atIso) latest = fact;
        continue;
      }
      // SKIPPED is not a run: a skipped test asserted nothing.
      if (fact.status !== 'SKIPPED') executed = true;
      if (fact.status === 'PASSED' || fact.everPassed === true) everPassed = true;
      if (!latest || fact.atIso > latest.atIso) latest = fact;
      if (fact.mutationKilled === true) mutationKilled = true;
      else if (fact.mutationKilled === false && mutationKilled === null) mutationKilled = false;
    }
    if (quarantinedTestIds.length > 0) quarantinedCovers.add(item.key);

    const waiver = waivers[item.key];
    const status = statusFor(item, matches, executed, opaqueNavigation, waiver !== undefined);

    return {
      item,
      status,
      matches,
      verification: {
        lastRunId: latest?.runId ?? null,
        lastStatus: latest?.status ?? null,
        executed,
        everPassed,
        mutationKilled,
      },
      ...(waiver ? { waiver } : {}),
    };
  });

  const totals = totalsForItems(entries);
  const caveats: string[] = [];

  if (opaqueNavigation) {
    caveats.push(
      `${opaqueTests.length} test${opaqueTests.length === 1 ? '' : 's'} navigate to URLs built at run time, which static analysis cannot read. Unmatched routes are reported as "cannot tell" rather than untested, because one of those tests may be the only coverage a route has.`,
    );
  }
  if (truncatedTests.length > 0) {
    caveats.push(
      `Route extraction hit its cap on ${truncatedTests.length} test${truncatedTests.length === 1 ? '' : 's'}, so their route lists are partial and some matches may be missed.`,
    );
  }

  /*
   * ── THE DENOMINATOR REDUCTION NOBODY WAS TOLD ABOUT ───────────────────────
   *
   * `totalsForKind` subtracts UNEXERCISABLE and REFUSED items from the
   * denominator (`NON_DENOMINATOR_EXERCISABILITIES`, and the constant's own
   * name says so). That is a defensible decision — a flow this harness cannot
   * drive here is our limit, not the team's untested surface — and it is also a
   * subtraction that RAISES the percentage, which is the direction that
   * flatters us. Measured on a 10-route fixture with 5 covered and 2 marked
   * UNEXERCISABLE: 5/8 = 62.5% reported where 5/10 = 50% would be the figure
   * over every item enumerated. Twelve and a half points, from two rows the
   * reader never saw leave.
   *
   * `totals.unexercisable` and `totals.refused` carried the counts the whole
   * time and NOTHING said they had been taken out of the division. A budget,
   * take or exclusion that BIT has to be reported as a count AND as a reason,
   * and that is the only thing missing here, so it is the only thing added:
   * the arithmetic is untouched.
   *
   * The reasons are named rather than summarised, because "2 items held out" is
   * a number a customer cannot act on and "1 session-ending, 1 destructive" is
   * one they can.
   */
  /*
   * UNDEFINED IS NOT ZERO HERE EITHER. `SurfaceKindTotals.unexercisable` is
   * optional because `byKind` is stored as JSON on every CoverageSnapshot ever
   * written and an old one has not got the field: absent means "this
   * measurement did not classify exercisability", 0 means "it did and found
   * none". A caveat built on `?? 0` would tell an old install that nothing was
   * held out, which is a claim made from our own silence — so an absent count
   * produces no sentence at all rather than a reassuring one.
   *
   * UNREACHABLE FROM THIS FUNCTION TODAY, and said plainly rather than left to
   * look tested: `totals` here is always fresh from `totalsForItems`, which
   * always populates both fields, so no input to `analyseSurfaceCoverage` can
   * take the undefined branch. A mutation replacing it with `?? 0` therefore
   * SURVIVES the suite. It is kept because the type permits absence for a
   * reason — a `byKind` array read back off a stored `CoverageSnapshot` — and
   * the first caller to pass one would otherwise get the zero this comment
   * exists to refuse.
   */
  const unexercisableCount = totals.unexercisable;
  const refusedCount = totals.refused;
  const heldOut =
    unexercisableCount === undefined || refusedCount === undefined
      ? 0
      : unexercisableCount + refusedCount;
  if (heldOut > 0) {
    /*
     * The reasons are counted over MEASURED kinds only, because that is the set
     * `totals.unexercisable` and `totals.denominator` are both summed over. A
     * breakdown drawn from every entry would name rows that never entered the
     * division and would not add up to the count beside it.
     */
    const reasons = new Map<string, number>();
    for (const entry of entries) {
      if (!MEASURED_SURFACE_KINDS.includes(entry.item.kind)) continue;
      const state = entry.item.exercise?.state;
      if (state !== 'UNEXERCISABLE' && state !== 'REFUSED') continue;
      if (entry.status === 'WAIVED') continue;
      const label =
        state === 'REFUSED'
          ? `refused by policy${entry.item.exercise?.rule ? ` (${entry.item.exercise.rule})` : ''}`
          : (entry.item.exercise?.reason ?? 'reason not recorded');
      reasons.set(label, (reasons.get(label) ?? 0) + 1);
    }
    const breakdown = [...reasons.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([label, count]) => `${count} ${label}`)
      .join(', ');
    caveats.push(
      `${heldOut} item${heldOut === 1 ? '' : 's'} (${breakdown}) are OUT of the denominator because this harness cannot drive ${heldOut === 1 ? 'it' : 'them'} here — ${unexercisableCount} unexercisable, ${refusedCount} refused by policy. The denominator is ${totals.denominator}, not ${totals.denominator + heldOut}, so this percentage is higher than it would be over every item enumerated. These are our limits, not waivers: they carry no owner and no expiry, and they stay in \`entries\` so you can see which surfaces they are.`,
    );
  }

  const assertedNotRun = entries.filter((entry) => entry.status === 'ASSERTED_NOT_RUN').length;
  if (assertedNotRun > 0) {
    caveats.push(
      `${assertedNotRun} item${assertedNotRun === 1 ? ' has a test that has' : 's have tests that have'} never been run, so ${assertedNotRun === 1 ? 'it is' : 'they are'} not counted as covered. A test that has not executed has not been shown to pass or to assert anything.`,
    );
  }

  const unverifiedAssertions = entries.filter(
    (entry) =>
      COVERED_STATUSES.includes(entry.status) && entry.verification.mutationKilled !== true,
  ).length;
  if (unverifiedAssertions > 0) {
    caveats.push(
      `${unverifiedAssertions} covered item${unverifiedAssertions === 1 ? '' : 's'} have no mutation result, so their tests are known to run but not known to assert anything meaningful. Run a mutation suite to turn that into a fact.`,
    );
  }

  if (quarantinedCovers.size > 0) {
    const stillUncovered = entries.filter(
      (entry) => quarantinedCovers.has(entry.item.key) && !COVERED_STATUSES.includes(entry.status),
    ).length;
    caveats.push(
      `${quarantinedCovers.size} item${quarantinedCovers.size === 1 ? '' : 's'} are matched by a quarantined test, whose result is suppressed from every gate rule. ${stillUncovered === 0 ? 'All of them are also matched by a test that is not' : `${stillUncovered} of them have no unquarantined cover at all and are reported as not covered`} — a test nothing gates on is not coverage, and it keeps its match so you can see which test it is.`,
    );
  }
  if (tests.length === 0) {
    caveats.push('This project has no tests, so the numerator is zero by construction.');
  }

  return { entries, totals, caveats, fingerprint: fingerprintCoverage(entries) };
}

/**
 * Changes whenever the answer could change.
 *
 * Over the key, the status and the matched test ids — the fields a consumer of
 * this result actually branches on. Evidence prose is excluded for the same
 * reason as in the inventory: it moves without the measurement moving.
 */
export function fingerprintCoverage(entries: readonly SurfaceItemCoverage[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.item.key);
    hash.update('\u0000');
    hash.update(entry.status);
    hash.update('\u0000');
    hash.update(
      entry.matches
        .map((match) => match.testId)
        .sort()
        .join(','),
    );
    hash.update('\u0000');
    hash.update(entry.verification.executed ? '1' : '0');
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The named list, worst first — the actual deliverable.
 *
 * Ordering is by how much a reader should care, not alphabetically: auth
 * surfaces before endpoints before routes before forms, because an untested
 * login is a different category of problem from an untested form field, and
 * within a kind, source-declared-never-reached first, because those are the
 * items no other tool in this market can even see.
 */
const KIND_WEIGHT: Record<SurfaceKind, number> = {
  AUTH_SURFACE: 0,
  ENDPOINT: 1,
  ROUTE: 2,
  FORM: 3,
  ROLE_CELL: 4,
  BACKGROUND_JOB: 5,
  NOTIFICATION: 6,
  ERROR_STATE: 7,
  COMPONENT_STATE: 8,
  FLAG_COMBINATION: 9,
  DEVICE_LOCALE: 10,
  DATA_VARIANT: 11,
};

export function rankUncovered(entries: readonly SurfaceItemCoverage[]): SurfaceItemCoverage[] {
  return entries
    .filter((entry) => entry.status === 'UNCOVERED')
    .sort((left, right) => {
      const byKind = KIND_WEIGHT[left.item.kind] - KIND_WEIGHT[right.item.kind];
      if (byKind !== 0) return byKind;
      const originWeight = (entry: SurfaceItemCoverage) =>
        entry.item.origin === 'SOURCE_ONLY' ? 0 : entry.item.origin === 'BOTH' ? 1 : 2;
      const byOrigin = originWeight(left) - originWeight(right);
      if (byOrigin !== 0) return byOrigin;
      return left.item.key.localeCompare(right.item.key);
    });
}

/**
 * `totals.percent` — THE SUM OF FOUR DENOMINATORS, AND NOT THE HEADLINE.
 *
 * ── WHAT THIS FUNCTION USED TO CLAIM ────────────────────────────────────────
 *
 * "Convenience for the CLI gate: the headline, or null when nothing is
 * measured." It is not the headline, and no gate should quote it.
 * `totalsForItems` computes it as `sum(covered) / sum(denominator)` over the
 * four MEASURED_SURFACE_KINDS — ROUTE, ENDPOINT, FORM, AUTH_SURFACE — which is
 * precisely the arithmetic `coverage.ts` built {@link CoverageHeadline} to
 * replace, four kinds instead of four axes and otherwise the same mistake.
 *
 * Measured, not argued: ten routes with five covered, holding ROUTE at a
 * constant 5/10 = 50%, and adding uncovered ENDPOINT rows —
 *
 *     0 endpoints  →  50%        ROUTE still 5/10
 *    10 endpoints  →  25%        ROUTE still 5/10
 *   100 endpoints  →   4.5%      ROUTE still 5/10
 *  1000 endpoints  →   0.5%      ROUTE still 5/10
 *
 * Nothing about the suite changed across those four rows. The number moved by
 * two orders of magnitude because ONE axis grew, which is the same thing that
 * made controls ~80% of the old React figure. It runs the other way too: an
 * endpoint extractor that stops finding endpoints takes the denominator with
 * it and the percentage climbs.
 *
 * ── WHY IT IS STILL EXPORTED ────────────────────────────────────────────────
 *
 * Because `apps/api/src/lib/coverage-store.ts` persists the same field as
 * `CoverageSnapshot.percent`, so the figure is in the database whether this
 * function exists or not, and deleting the one named accessor would hide the
 * problem rather than fix it. Fixing it means weighting `totalsForItems` in
 * packages/shared/src/surface.ts the way `COVERAGE_AXIS_WEIGHT` weights the
 * four axes — a published per-kind weight table, asserted to sum to 1 — and
 * that file is not this slice's to edit. `packages/runner/src/coverage/types.ts`
 * is already on the record about it: "There is no `headlinePercent` in this
 * directory and there must not be one: the four denominators are
 * incommensurable and the product already has one number that sums four of
 * them." This is that number.
 *
 * So: use it for the ratchet, where it is compared against ITSELF over an
 * unchanged set of kinds and the summation cancels. Do not put it on a screen,
 * in a badge, or in front of a customer. {@link CoverageHeadline} in
 * coverage.ts is the figure with a defined formula and published weights.
 */
export function summedKindPercent(result: SurfaceCoverageResult): number | null {
  return result.totals.percent;
}

/**
 * @deprecated Renamed to {@link summedKindPercent}, which says what it is. The
 * old name asserted that this is the product's headline; it is a ratio of
 * summed incommensurable denominators and must not be quoted as one.
 */
export const headlinePercent = summedKindPercent;

/** Re-exported so callers do not need to know which module owns the key format. */
export { surfaceKey };
