/**
 * Selector drift — the rename the crawl already knows about, hours before CI
 * finds it the expensive way.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Somebody relabels a button from "Pay" to "Pay now". The next crawl records
 * the new label that afternoon. Nothing compares it against the suite. So the
 * sequence is: a green dashboard, a nightly run, a failing test, a triage call,
 * a strong-model heal proposal, a human review — for a one-word rename that was
 * visible, deterministically and for free, the moment the crawl landed.
 *
 * `driftCheck` in obsolete.ts was the first half of this: it reports that a
 * locator is MISSING. Missing is not the useful fact. The useful facts are
 * WHICH of four things happened — the target is still there, it moved to
 * another page, its accessible name changed, its role changed — and, when there
 * is exactly one candidate, the replacement expression, with no model involved
 * at all.
 *
 * ── THE RULE THAT KEEPS IT HONEST ───────────────────────────────────────────
 *
 * A CONFIDENT WRONG REWRITE IS WORSE THAN A FAILING RUN. A failing run costs a
 * CI cycle and tells the truth. A locator rewritten to the wrong element
 * produces a test that passes while asserting nothing about the thing it was
 * written for, and nobody ever looks at it again. So:
 *
 *   · a proposal is emitted ONLY when exactly one candidate survives every
 *     filter. Two candidates is AMBIGUOUS and emits nothing;
 *   · a candidate another test already targets successfully is not a rename, it
 *     is a different live control, and it is excluded;
 *   · a chained locator (`getByRole('dialog').getByText('OK')`) is never
 *     rewritten, because "which segment moved" has no deterministic answer;
 *   · drift is only ever claimed for a route the crawl REACHED. On a page it
 *     never loaded every locator is trivially missing and the whole report
 *     would be noise by construction.
 *
 * ── AND THE TEXT IS UNTRUSTED ───────────────────────────────────────────────
 *
 * An accessible name is PAGE TEXT. It ends up inside a string literal in the
 * customer's test file, so it is never concatenated by hand here: every
 * replacement expression goes through `locatorExpression` (packages/shared/src/
 * locators.ts), which is the one place that escapes a quote and a backslash.
 * A name that is longer than {@link DRIFT_MAX_NAME_LENGTH}, or that carries a
 * newline, is not a rename — it is a page that scraped something into a label —
 * and it is refused with the refusal COUNTED, never silently dropped.
 *
 * NOTHING HERE CALLS A MODEL, AND NOTHING HERE OPENS A SOCKET. The flow map is
 * the input; set membership and string equality are the whole method.
 */

import { locatorExpression } from '@qaai/shared';
import type { FlowMap, Priority, Selector } from '@qaai/shared';
import { extractBehavior, normalizeLocator, normalizeRoute } from './suite-health.js';
import type { SuiteHealthTestInput } from './suite-health.js';
import { locatorIdentity } from './obsolete.js';
import { routeVisits } from './coverage.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * What happened to one locator, between the suite and the newest crawl.
 *
 * PRESENT and GONE were the only two states `driftCheck` could express. The
 * three in the middle are the ones worth paying for: each one names a DIFFERENT
 * repair, and only two of them can be repaired without a human choosing.
 */
export const DRIFT_STATES = [
  /** The crawl still sees this exact target on a route this test drives. */
  'PRESENT',
  /**
   * The target exists in the crawl, on none of the routes this test drives.
   * The locator is fine and the NAVIGATION is wrong, so no locator rewrite can
   * help — which is why this is a separate state and not a GONE with a note.
   */
  'MOVED',
  /** Same role, on a route the test drives, under a different accessible name. */
  'NAME_CHANGED',
  /** Same accessible name, on a route the test drives, under a different role. */
  'ROLE_CHANGED',
  /** No candidate at all. The element is not in the crawl in any form. */
  'GONE',
  /**
   * A `css=` locator, one held in a variable, or one this module could not
   * parse. The Explorer does not enumerate arbitrary CSS, so its absence from
   * the flow map says NOTHING — counting these as drift would make the report
   * mostly false on the suites that need it most.
   */
  'UNCOMPARABLE',
] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/** Whether a state means "this test is about to fail". */
export const DRIFT_STATE_RULES = {
  PRESENT: { willFail: false, repairable: false },
  // A navigation change, not a locator change: QAAI knows the element exists
  // and does not know which page the test MEANT to be on.
  MOVED: { willFail: true, repairable: false },
  NAME_CHANGED: { willFail: true, repairable: true },
  ROLE_CHANGED: { willFail: true, repairable: true },
  GONE: { willFail: true, repairable: false },
  // Not "fine": UNKNOWN. A pass that means "we did not check" is the lie this
  // table exists to avoid, so UNCOMPARABLE claims no failure and no repair.
  UNCOMPARABLE: { willFail: false, repairable: false },
} as const satisfies Record<DriftState, { willFail: boolean; repairable: boolean }>;

/**
 * Why a candidate that looked like the new target was not proposed.
 *
 * A closed vocabulary, because these are counted and rendered. "We found
 * nothing" and "we found four things and would not guess" are different facts
 * and a reader who cannot tell them apart will assume the first.
 */
export const DRIFT_REFUSALS = [
  /** More than one candidate survived. Choosing would be guessing. */
  'AMBIGUOUS_CANDIDATES',
  /** Both a name candidate and a role candidate exist. Same reason. */
  'CONFLICTING_EXPLANATIONS',
  /** A chained locator. "Which segment moved" has no deterministic answer. */
  'CHAINED_LOCATOR',
  /** The candidate's accessible name is longer than the cap, or has a newline. */
  'CANDIDATE_NAME_UNUSABLE',
  /** The only candidate is a target some other test already drives successfully. */
  'CANDIDATE_ALREADY_CLAIMED',
] as const;
export type DriftRefusal = (typeof DRIFT_REFUSALS)[number];

/**
 * The longest accessible name this module will write into a customer's source.
 *
 * 120 characters. Playwright names are button labels and headings; a 4 KB
 * "name" is a page that scraped a paragraph into an aria-label, and pasting it
 * into a test file would produce an unreadable diff for a locator that is
 * unlikely to be stable anyway. The cap BITING is reported as a count with a
 * reason — an undisclosed cap is the defect this codebase keeps finding.
 */
export const DRIFT_MAX_NAME_LENGTH = 120;

/**
 * The most warnings one report will carry.
 *
 * A suite with 4,000 drifted locators has a crawl problem, not a rename
 * problem, and a 4,000-row report is one nobody reads. The TOTAL is always
 * reported alongside, so a capped list can never read as the whole list.
 */
export const DRIFT_MAX_WARNINGS = 200;

// ─── Reading the crawl, per route ────────────────────────────────────────────

/**
 * One element the crawl saw, with everything the comparison needs.
 *
 * Keeps the `Selector` rather than only its rendered expression, because a
 * replacement must be produced by `locatorExpression` and never by string
 * concatenation here — see the module header on untrusted text.
 */
export interface CrawlElement {
  route: string;
  identity: string;
  /** `role` | `label` | `placeholder` | `text` | `testid`. */
  key: string;
  /** The factory's first argument, lower-cased: 'button', 'email'. */
  value: string;
  /** The accessible name, lower-cased, for role locators. Null otherwise. */
  name: string | null;
  /** The crawl's own label, verbatim — the only thing that may be written out. */
  selector: Selector;
}

export interface CrawlIndex {
  /** Routes the crawl REACHED. */
  routes: string[];
  elements: CrawlElement[];
  /** Identity → the routes it was seen on. */
  byIdentity: Map<string, Set<string>>;
  version: number | null;
  /** The adjudication, disclosed rather than enforced — see {@link driftReport}. */
  acceptance: string | null;
  /** Elements whose locator kind the crawl cannot be compared on. Reported. */
  uncomparable: number;
}

const COMPARABLE_KEYS = new Set(['role', 'label', 'placeholder', 'text', 'testid']);

/**
 * Split a normalised locator into its parts, or null when it is not comparable.
 *
 * The input shape is `normalizeLocator`'s output: `role=button[pay]`,
 * `label=email`, `testid=receipt`, or a chain joined with `>`. Modifiers have
 * already been stripped by `locatorIdentity`, which is imported rather than
 * re-implemented — the two must agree about what "the same element" means, and
 * two copies of that rule is two chances to disagree.
 */
export function locatorParts(
  normalized: string,
): { key: string; value: string; name: string | null; identity: string; chained: boolean } | null {
  const identity = locatorIdentity(normalized);
  if (identity.length === 0) return null;
  const segments = identity.split('>');
  const first = segments[0] ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const key = first.slice(0, eq);
  if (!COMPARABLE_KEYS.has(key)) return null;
  const rest = first.slice(eq + 1);
  const bracket = rest.indexOf('[');
  const value = (bracket === -1 ? rest : rest.slice(0, bracket)).trim();
  const name =
    bracket === -1 || !rest.endsWith(']') ? null : rest.slice(bracket + 1, -1).trim() || null;
  return { key, value, name, identity, chained: segments.length > 1 };
}

/** Read a flow map into the per-route index this comparison needs. */
export function crawlIndex(flowMap: FlowMap | null): CrawlIndex {
  const routes = new Set<string>();
  const elements: CrawlElement[] = [];
  const byIdentity = new Map<string, Set<string>>();
  let uncomparable = 0;

  const consider = (route: string, selector: Selector | null | undefined): void => {
    if (!selector) return;
    const parts = locatorParts(normalizeLocator(`page.${locatorExpression(selector)}`));
    if (!parts) {
      uncomparable += 1;
      return;
    }
    elements.push({
      route,
      identity: parts.identity,
      key: parts.key,
      value: parts.value,
      name: parts.name,
      selector,
    });
    const seen = byIdentity.get(parts.identity) ?? new Set<string>();
    seen.add(route);
    byIdentity.set(parts.identity, seen);
  };

  for (const node of flowMap?.nodes ?? []) {
    if (typeof node?.route !== 'string') continue;
    const route = normalizeRoute(node.route);
    routes.add(route);
    for (const affordance of node?.affordances ?? []) consider(route, affordance?.selector);
    for (const form of node?.forms ?? []) {
      consider(route, form?.selector);
      consider(route, form?.submit);
      for (const field of form?.fields ?? []) consider(route, field?.selector);
    }
  }

  return {
    routes: [...routes].sort(),
    elements,
    byIdentity,
    version: flowMap?.version ?? null,
    acceptance: flowMap?.acceptance?.state ?? null,
    uncomparable,
  };
}

// ─── Per-locator finding ─────────────────────────────────────────────────────

export interface DriftFinding {
  locator: string;
  line: number;
  state: DriftState;
  /**
   * The replacement expression, ready to paste, or null.
   *
   * Non-null ONLY for a NAME_CHANGED or ROLE_CHANGED with exactly one surviving
   * candidate, and always produced by `locatorExpression` so the page's own
   * text is escaped by the one function that knows how.
   */
  proposal: string | null;
  /** Why no proposal, when the state was repairable in principle. */
  refusal: DriftRefusal | null;
  /**
   * Candidate expressions considered, capped at four and counted. Shown so a
   * reviewer can finish by hand what QAAI would not guess at.
   */
  candidates: string[];
  /** How many candidates there were in total, so the four cannot read as all. */
  candidateCount: number;
  /** One sentence. QAAI's own words about QAAI's own comparison. */
  why: string;
}

export interface DriftTestFinding {
  testId: string;
  name: string;
  filePath: string;
  priority: Priority;
  /** Routes this test drives that the crawl reached. The comparison's basis. */
  comparedOn: string[];
  findings: DriftFinding[];
  /** Findings whose state says this test fails next run. */
  willFail: number;
  /** Of those, how many QAAI can repair with no model. */
  repairable: number;
}

export interface DriftReport {
  crawlVersion: number | null;
  /** The crawl's adjudication, disclosed: a CANDIDATE crawl may still warn. */
  crawlAcceptance: string | null;
  tests: DriftTestFinding[];
  /** Every state, always present, so "none" and "not checked" differ. */
  counts: Record<DriftState, number>;
  /** Every refusal reason, always present. */
  refusals: Record<DriftRefusal, number>;
  /** Tests that will fail on the next run unless a locator is updated. */
  testsThatWillFail: number;
  /** Distinct locators behind that number. */
  locatorsToUpdate: number;
  /** Of those, how many have exactly one unambiguous new target. */
  deterministicallyRepairable: number;
  /** Set when {@link DRIFT_MAX_WARNINGS} bit, with the total it bit at. */
  cappedAt: number | null;
  /** THE sentence. The cheapest number in the product. */
  headline: string;
  caveats: string[];
}

export interface DriftInput {
  tests: readonly SuiteHealthTestInput[];
  flowMap: FlowMap | null;
  /** Defaults to {@link DRIFT_MAX_WARNINGS}. */
  maxWarnings?: number;
}

/** Did any route this test drives match this crawled route? Template-aware. */
function drives(route: string, testRoutes: readonly string[]): boolean {
  return testRoutes.some(
    (candidate) => routeVisits(candidate, route) || routeVisits(route, candidate),
  );
}

/** A name safe to write into a customer's source file, or null. */
function usableName(selector: Selector): string | null {
  const name = selector.name ?? selector.value;
  if (name.length === 0 || name.length > DRIFT_MAX_NAME_LENGTH) return null;
  // A newline in an accessible name means the page concatenated block content
  // into a label. Pasting it into a test file produces a locator nobody can
  // read and that the next render will change again.
  if (/[\n\r\t]/.test(name)) return null;
  return name;
}

const PRIORITY_RANK = { CRITICAL_PATH: 0, IMPORTANT: 1 } as const;

function priorityRank(priority: Priority): number {
  return PRIORITY_RANK[priority as keyof typeof PRIORITY_RANK] ?? 2;
}

/**
 * Compare every test's locators against the newest crawl.
 *
 * TWO PASSES, and the second one needs the first. Pass one decides which
 * targets are PRESENT across the whole suite; pass two uses that set to exclude
 * candidates that are somebody else's live control rather than this test's
 * renamed one. A single pass would propose rewriting "Pay" to "Pay now" on a
 * page that has both, which is the confident wrong rewrite this module exists
 * to refuse.
 */
export function driftReport(input: DriftInput): DriftReport {
  const crawl = crawlIndex(input.flowMap);
  const maxWarnings = input.maxWarnings ?? DRIFT_MAX_WARNINGS;

  const counts: Record<DriftState, number> = {
    PRESENT: 0,
    MOVED: 0,
    NAME_CHANGED: 0,
    ROLE_CHANGED: 0,
    GONE: 0,
    UNCOMPARABLE: 0,
  };
  const refusals: Record<DriftRefusal, number> = {
    AMBIGUOUS_CANDIDATES: 0,
    CONFLICTING_EXPLANATIONS: 0,
    CHAINED_LOCATOR: 0,
    CANDIDATE_NAME_UNUSABLE: 0,
    CANDIDATE_ALREADY_CLAIMED: 0,
  };

  if (crawl.routes.length === 0) {
    return {
      crawlVersion: crawl.version,
      crawlAcceptance: crawl.acceptance,
      tests: [],
      counts,
      refusals,
      testsThatWillFail: 0,
      locatorsToUpdate: 0,
      deterministicallyRepairable: 0,
      cappedAt: null,
      headline:
        'No crawl has reached a page of this application, so nothing could be compared. This is a gap in QAAI’s measurement, not a statement about your tests.',
      caveats: [
        'Drift is UNMEASURED without a crawl. It is not "no drift": the two look identical from a dashboard and only one of them is good news.',
      ],
    };
  }

  // ─ Pass one: what every test drives, and which targets are live ─

  interface Prepared {
    test: SuiteHealthTestInput;
    routes: string[];
    comparedOn: string[];
    sites: Array<{ line: number; locator: string }>;
    incomplete: boolean;
  }

  const prepared: Prepared[] = [];
  const claimed = new Set<string>();

  for (const test of input.tests) {
    const behavior = extractBehavior(test);
    const routes = [
      ...new Set(
        behavior.routes
          .filter((token) => token.startsWith('nav:'))
          .map((token) => normalizeRoute(token.slice('nav:'.length))),
      ),
    ].sort();
    const comparedOn = crawl.routes.filter((route) => drives(route, routes));
    const sites = dedupe(behavior.actionSites);
    prepared.push({ test, routes, comparedOn, sites, incomplete: behavior.incomplete });

    // A target is "claimed" only when it is PRESENT on a route its own test
    // drives. A drifted locator claims nothing — otherwise a suite-wide rename
    // would make every candidate look taken and no repair would ever be
    // proposed.
    if (behavior.incomplete || comparedOn.length === 0) continue;
    for (const site of sites) {
      const parts = locatorParts(site.locator);
      if (!parts) continue;
      const seenOn = crawl.byIdentity.get(parts.identity);
      if (seenOn && comparedOn.some((route) => seenOn.has(route))) claimed.add(parts.identity);
    }
  }

  // ─ Pass two: classify, and propose where exactly one candidate survives ─

  const tests: DriftTestFinding[] = [];
  let capped = 0;

  for (const entry of prepared) {
    /*
     * Both skips are refusals to make a claim, not findings of health. A test
     * QAAI could not read in full, and a test whose pages this crawl never
     * loaded, are the two cases where every locator is trivially "missing" —
     * reporting them as drift is how a report stops being read.
     */
    if (entry.incomplete || entry.comparedOn.length === 0) continue;

    const findings: DriftFinding[] = [];
    for (const site of entry.sites) {
      const parts = locatorParts(site.locator);
      if (!parts) {
        findings.push({
          locator: site.locator,
          line: site.line,
          state: 'UNCOMPARABLE',
          proposal: null,
          refusal: null,
          candidates: [],
          candidateCount: 0,
          why: 'QAAI’s crawler does not enumerate arbitrary CSS or locators held in variables, so its absence from the flow map says nothing about this element.',
        });
        continue;
      }

      const seenOn = crawl.byIdentity.get(parts.identity);
      if (seenOn && entry.comparedOn.some((route) => seenOn.has(route))) {
        findings.push({
          locator: site.locator,
          line: site.line,
          state: 'PRESENT',
          proposal: null,
          refusal: null,
          candidates: [],
          candidateCount: 0,
          why: `The newest crawl saw this element on ${entry.comparedOn.filter((route) => seenOn.has(route)).join(', ')}.`,
        });
        continue;
      }

      if (seenOn && seenOn.size > 0) {
        const elsewhere = [...seenOn].sort();
        findings.push({
          locator: site.locator,
          line: site.line,
          state: 'MOVED',
          proposal: null,
          // Not a refusal: there is nothing to repair HERE. The locator is
          // right and the page the test is on is wrong, and QAAI cannot know
          // which page the test meant.
          refusal: null,
          candidates: [],
          candidateCount: 0,
          why:
            `This element is in the newest crawl, on ${elsewhere.join(', ')} — not on ` +
            `${entry.comparedOn.join(', ')}, which is where this test looks for it. ` +
            'The locator is fine; the navigation is what moved.',
        });
        continue;
      }

      // ─ The element is nowhere. Is there exactly one explanation? ─

      const onRoute = crawl.elements.filter(
        (element) => entry.comparedOn.includes(element.route) && !claimed.has(element.identity),
      );

      const nameCandidates =
        parts.key === 'role' && parts.name !== null
          ? dedupeByIdentity(
              onRoute.filter(
                (element) =>
                  element.key === 'role' &&
                  element.value === parts.value &&
                  element.name !== null &&
                  element.name !== parts.name,
              ),
            )
          : [];
      const roleCandidates =
        parts.key === 'role' && parts.name !== null
          ? dedupeByIdentity(
              onRoute.filter(
                (element) =>
                  element.key === 'role' &&
                  element.name === parts.name &&
                  element.value !== parts.value,
              ),
            )
          : [];

      const total = nameCandidates.length + roleCandidates.length;
      const shown = [...nameCandidates, ...roleCandidates]
        .slice(0, 4)
        .map((element) => `page.${locatorExpression(element.selector)}`);

      const gone = (refusal: DriftRefusal | null, why: string): void => {
        if (refusal) refusals[refusal] += 1;
        findings.push({
          locator: site.locator,
          line: site.line,
          state: 'GONE',
          proposal: null,
          refusal,
          candidates: shown,
          candidateCount: total,
          why,
        });
      };

      if (parts.chained) {
        gone(
          'CHAINED_LOCATOR',
          'This is a chained locator, and QAAI will not guess which segment of a chain moved. The repair is a human one.',
        );
        continue;
      }
      if (nameCandidates.length > 0 && roleCandidates.length > 0) {
        gone(
          'CONFLICTING_EXPLANATIONS',
          `The crawl offers ${nameCandidates.length} element(s) with this role under a different name AND ${roleCandidates.length} with this name under a different role. Both explain the failure and QAAI cannot tell which is the rename, so it proposes neither.`,
        );
        continue;
      }
      if (total > 1) {
        gone(
          'AMBIGUOUS_CANDIDATES',
          `${total} element(s) on ${entry.comparedOn.join(', ')} could be this one renamed. Choosing between them would be guessing, and a locator pointed at the wrong element produces a test that passes while asserting nothing.`,
        );
        continue;
      }
      if (total === 0) {
        // One more thing worth saying: was the only candidate taken?
        const takenByAnother = crawl.elements.some(
          (element) =>
            entry.comparedOn.includes(element.route) &&
            claimed.has(element.identity) &&
            element.key === 'role' &&
            (element.value === parts.value || element.name === parts.name),
        );
        if (takenByAnother) {
          gone(
            'CANDIDATE_ALREADY_CLAIMED',
            'The nearest element the crawl saw is one another test already drives successfully, so it is a different live control and not this one renamed.',
          );
          continue;
        }
        gone(
          null,
          `The newest crawl did not see this element on ${entry.comparedOn.join(', ')}, and offers nothing with the same role or the same accessible name. It is either deleted or behind an interaction the crawl did not perform.`,
        );
        continue;
      }

      const only = (nameCandidates[0] ?? roleCandidates[0])!;
      const name = usableName(only.selector);
      if (name === null) {
        refusals.CANDIDATE_NAME_UNUSABLE += 1;
        findings.push({
          locator: site.locator,
          line: site.line,
          state: nameCandidates.length === 1 ? 'NAME_CHANGED' : 'ROLE_CHANGED',
          proposal: null,
          refusal: 'CANDIDATE_NAME_UNUSABLE',
          candidates: shown,
          candidateCount: total,
          why: `The one candidate's accessible name is unusable as source (longer than ${DRIFT_MAX_NAME_LENGTH} characters, or containing a line break), so QAAI will not write it into your test file.`,
        });
        continue;
      }

      const state: DriftState = nameCandidates.length === 1 ? 'NAME_CHANGED' : 'ROLE_CHANGED';
      findings.push({
        locator: site.locator,
        line: site.line,
        state,
        // Through `locatorExpression`, always: it is the one function that
        // escapes a quote and a backslash in page text.
        proposal: `page.${locatorExpression(only.selector)}`,
        refusal: null,
        candidates: shown,
        candidateCount: total,
        why:
          state === 'NAME_CHANGED'
            ? `Exactly one element on ${only.route} has this role under a different accessible name, and no other test drives it. That is a rename, and the replacement needs no model.`
            : `Exactly one element on ${only.route} has this accessible name under a different role, and no other test drives it. The element is the same; its role changed.`,
      });
    }

    for (const finding of findings) counts[finding.state] += 1;
    const willFail = findings.filter((f) => DRIFT_STATE_RULES[f.state].willFail).length;
    if (findings.length === 0) continue;
    tests.push({
      testId: entry.test.id,
      name: entry.test.name,
      filePath: entry.test.filePath,
      priority: entry.test.priority,
      comparedOn: entry.comparedOn,
      findings,
      willFail,
      repairable: findings.filter((f) => f.proposal !== null).length,
    });
  }

  // Highest-priority, most-broken first: a CRITICAL_PATH test about to break is
  // the one worth reading.
  tests.sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      b.willFail - a.willFail ||
      a.name.localeCompare(b.name),
  );

  const failing = tests.filter((test) => test.willFail > 0);
  const testsThatWillFail = failing.length;
  const locatorsToUpdate = failing.reduce((sum, test) => sum + test.willFail, 0);
  const repairable = failing.reduce((sum, test) => sum + test.repairable, 0);

  let reported = tests;
  if (tests.length > maxWarnings) {
    capped = tests.length;
    reported = tests.slice(0, maxWarnings);
  }

  const caveats: string[] = [
    'A crawl records what it FOUND, not everything that exists, so every finding here is a warning and not a proof — worth hearing before the run rather than after.',
    'Drift is only compared on routes the crawl REACHED. On a page it never loaded every locator is trivially missing, and no claim is made about those.',
  ];
  if (crawl.acceptance !== null && crawl.acceptance !== 'ACCEPTED') {
    caveats.push(
      `This crawl was adjudicated ${crawl.acceptance} rather than ACCEPTED, so read these warnings as cheap hints and not as a measurement. A warning that is wrong costs nothing; a retirement argued from the same crawl is refused outright.`,
    );
  }
  if (crawl.uncomparable > 0) {
    caveats.push(
      `${crawl.uncomparable} element(s) in the crawl have locators QAAI cannot compare, so this comparison is over role, label, placeholder, text and test-id locators only.`,
    );
  }
  if (counts.UNCOMPARABLE > 0) {
    caveats.push(
      `${counts.UNCOMPARABLE} locator(s) in your suite could not be compared at all, so these tests may have drifted in ways not listed here.`,
    );
  }
  if (capped > 0) {
    caveats.push(
      `${capped} tests have drifted locators and the first ${maxWarnings} are listed. A suite drifting at that scale usually has a crawl problem rather than a rename problem.`,
    );
  }
  if (refusals.CANDIDATE_NAME_UNUSABLE > 0) {
    caveats.push(
      `${refusals.CANDIDATE_NAME_UNUSABLE} repair(s) were withheld because the candidate's accessible name is not usable as source — longer than ${DRIFT_MAX_NAME_LENGTH} characters, or containing a line break.`,
    );
  }

  return {
    crawlVersion: crawl.version,
    crawlAcceptance: crawl.acceptance,
    tests: reported,
    counts,
    refusals,
    testsThatWillFail,
    locatorsToUpdate,
    deterministicallyRepairable: repairable,
    cappedAt: capped > 0 ? capped : null,
    headline: headlineFor(testsThatWillFail, locatorsToUpdate, repairable),
    caveats,
  };
}

/**
 * THE sentence: "N tests will fail on the next run unless these M locators are
 * updated."
 *
 * Written here, once, so every surface says it the same way and none of them
 * can decide not to. Reports ZERO out loud for the same reason
 * `summariseSuppressions` does: a surface that renders nothing when nothing
 * drifted is indistinguishable from one that forgot to ask.
 */
export function headlineFor(tests: number, locators: number, repairable: number): string {
  if (tests === 0) {
    return 'No test in this suite acts on an element the newest crawl could not find. Nothing is predicted to fail for a locator reason.';
  }
  const noun = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const repair =
    repairable === 0
      ? ' None of them has a single unambiguous new target, so every repair is a human decision.'
      : repairable === locators
        ? ' Every one has exactly one unambiguous new target, so QAAI can rewrite them all with no model.'
        : ` ${repairable} of them have exactly one unambiguous new target and can be rewritten with no model; the rest need a human.`;
  return `${noun(tests, 'test')} will fail on the next run unless ${noun(locators, 'locator')} ${locators === 1 ? 'is' : 'are'} updated.${repair}`;
}

/** Newest-first de-duplication by locator, so one element is reported once. */
function dedupe(
  sites: readonly { line: number; locator: string }[],
): Array<{ line: number; locator: string }> {
  const seen = new Map<string, { line: number; locator: string }>();
  for (const site of sites) {
    if (site.locator === 'unknown') continue;
    if (!seen.has(site.locator)) seen.set(site.locator, site);
  }
  return [...seen.values()].sort((a, b) => a.line - b.line);
}

/**
 * One candidate per identity, so the same control seen on three crawled nodes
 * is one candidate and not three.
 *
 * Without this, a header button on four pages reads as four candidates and
 * every repair is refused as AMBIGUOUS — the refusal would be real and the
 * reason would be wrong, which is worse than either.
 */
function dedupeByIdentity(elements: readonly CrawlElement[]): CrawlElement[] {
  const seen = new Map<string, CrawlElement>();
  for (const element of elements) if (!seen.has(element.identity)) seen.set(element.identity, element);
  return [...seen.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}
