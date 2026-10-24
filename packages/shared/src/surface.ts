/**
 * The surface of the application under test — the denominator.
 *
 * WHY THIS FILE EXISTS
 *
 * QAAI could already answer "what did the crawl reach, and which of those did a
 * test touch?" That is a ratio of things already visited, and every vendor in
 * this market computes some version of it: a link crawl's page list, the DOM
 * elements a suite happened to interact with, the sessions a recorder captured,
 * the tickets a human linked. All of them share one property — the denominator
 * is produced by the same process that produces the numerator, so a surface
 * nothing has ever touched is not merely uncovered, it is INVISIBLE.
 *
 * This file is the other denominator: the surface the SOURCE declares, read
 * independently of whether anything has ever reached it. `analyseCodebase`
 * already extracts it — routes, endpoints, forms, auth surfaces, each with the
 * file it was declared in. Nothing has ever divided by it.
 *
 * THE TWO PROPERTIES THAT MAKE A COVERAGE NUMBER WORTH PRINTING
 *
 * 1. It is RECOMPUTABLE by the customer. A percentage a vendor computes in
 *    private is a marketing number. Every item below carries its `kind`, its
 *    stable `key`, the `file` it came from and the `evidence` sentence that
 *    justifies it, so the same extractor run in the customer's own CI produces
 *    the same inventory and they can check our arithmetic.
 *
 * 2. It is HONEST about what it does not know. Three states do real work here
 *    and must never be collapsed into "uncovered":
 *      - UNKNOWN: a test navigates to a URL built at run time, so static
 *        extraction cannot see which item it covers. Counting that as a gap
 *        asserts knowledge we do not have.
 *      - WAIVED: the team has said, on the record, that this item is not worth
 *        testing. Without waivers 100% is unreachable, and an unreachable
 *        target gets gamed instead of met.
 *      - UNREACHED: the source declares it and the crawl never got there. That
 *        is a fact about our enumeration, not about their tests.
 *
 * WHAT THIS FILE IS NOT
 *
 * It computes nothing. It is the vocabulary — the kinds, the key format, the
 * statuses and the snapshot shape — so that the extractor, the matcher, the
 * persistence layer, the API, the CLI gate and the cockpit all mean the same
 * thing by "covered". The arithmetic lives in packages/agent.
 */

// ─── Axes ────────────────────────────────────────────────────────────────────

/**
 * The dimensions of a surface.
 *
 * Four ship now because `analyseCodebase` already extracts all four. The rest
 * are declared deliberately, in one list, because the alternative is what this
 * codebase has done before: a measurement built for routes, then widened one
 * special case at a time until no two screens agree on the denominator.
 *
 * An axis listed here but not yet extracted is reported as a known-absent
 * dimension rather than silently omitted — "we do not measure component states"
 * is a true and useful sentence, and a customer comparing us to a vendor who
 * quietly measures only frontend lines deserves to hear it.
 */
import type { TestResultStatus } from './constants';

export const SURFACE_KINDS = [
  /** A page the source declares a URL for. */
  'ROUTE',
  /** An HTTP operation: method plus path. */
  'ENDPOINT',
  /** A form, identified by its file and index, with its fields. */
  'FORM',
  /** A login/signup/reset/verify/SSO surface. */
  'AUTH_SURFACE',

  // ─ Declared, not yet extracted. Reported as unmeasured dimensions. ─
  /** A route × role cell: "a VIEWER requesting /admin/billing". */
  'ROLE_CELL',
  /** A component in a named state: loading, empty, error. */
  'COMPONENT_STATE',
  /** A combination of feature flags that yields a different application. */
  'FLAG_COMBINATION',
  /** A queue consumer, cron entry or webhook receiver. */
  'BACKGROUND_JOB',
  /** An outbound email or notification template. */
  'NOTIFICATION',
  /** A declared error or empty state of a route. */
  'ERROR_STATE',
  /** A device, viewport or locale the app claims to support. */
  'DEVICE_LOCALE',
  /** A distinct data shape a route must handle: empty, one, many, pathological. */
  'DATA_VARIANT',
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** The axes an extractor exists for today. Everything else is reported unmeasured. */
export const MEASURED_SURFACE_KINDS: readonly SurfaceKind[] = [
  'ROUTE',
  'ENDPOINT',
  'FORM',
  'AUTH_SURFACE',
];

export const SURFACE_KIND_LABELS: Record<SurfaceKind, string> = {
  ROUTE: 'Routes',
  ENDPOINT: 'API endpoints',
  FORM: 'Forms',
  AUTH_SURFACE: 'Auth surfaces',
  ROLE_CELL: 'Route × role cells',
  COMPONENT_STATE: 'Component states',
  FLAG_COMBINATION: 'Feature-flag combinations',
  BACKGROUND_JOB: 'Jobs, crons and webhooks',
  NOTIFICATION: 'Emails and notifications',
  ERROR_STATE: 'Error and empty states',
  DEVICE_LOCALE: 'Devices and locales',
  DATA_VARIANT: 'Data variants',
};

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * Where an item came from, which is the reconciliation the product turns on.
 *
 * `SOURCE_ONLY` is the interesting one and the reason this whole file exists:
 * the code declares it and the crawl has never reached it. That is either a
 * genuinely unreachable route (dead code the customer will want to delete) or —
 * far more often — a page behind a button, a wizard step, a role we do not hold,
 * or a flag we did not set. Either way it is a thing no runtime-only competitor
 * can see at all.
 *
 * `CRAWL_ONLY` is the mirror and is equally diagnostic: the app serves it and
 * the source analysis never declared it, which usually means a route table we
 * failed to parse. It is evidence about OUR extractor, and suppressing it would
 * be hiding our own error rate.
 */
export const SURFACE_ORIGINS = ['SOURCE_ONLY', 'CRAWL_ONLY', 'BOTH'] as const;
export type SurfaceOrigin = (typeof SURFACE_ORIGINS)[number];

export const SURFACE_ORIGIN_LABELS: Record<SurfaceOrigin, string> = {
  SOURCE_ONLY: 'declared in source, never reached by a crawl',
  CRAWL_ONLY: 'reached by a crawl, never found in source',
  BOTH: 'declared in source and reached by a crawl',
};

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Whether an item is covered — and the three answers that are not yes or no.
 *
 * COVERED means at least one test is matched to this item AND that test has
 * been seen to run. Those are two different claims and conflating them is how a
 * coverage number becomes a lie: a string appearing in a spec file proves a test
 * was written, not that it executes, not that it passes, and not that it
 * asserts anything. {@link SurfaceItemCoverage.verification} keeps them apart.
 */
export const SURFACE_STATUSES = [
  /** A test is matched to it and has been observed to run. */
  'COVERED',
  /** A test is matched to it, but no run has exercised that test yet. */
  'ASSERTED_NOT_RUN',
  /** Nothing is matched to it. The number this product exists to shrink. */
  'UNCOVERED',
  /**
   * A test might cover it, but static extraction cannot tell — a runtime URL,
   * a computed selector. Never counted as covered and never counted as a gap.
   */
  'UNKNOWN',
  /** The team recorded a reason not to test it. Excluded from the denominator. */
  'WAIVED',
] as const;
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];

export const SURFACE_STATUS_LABELS: Record<SurfaceStatus, string> = {
  COVERED: 'covered',
  ASSERTED_NOT_RUN: 'a test exists but has never run',
  UNCOVERED: 'no test',
  UNKNOWN: 'cannot tell',
  WAIVED: 'waived',
};

/** Statuses that count toward the numerator. */
export const COVERED_STATUSES: readonly SurfaceStatus[] = ['COVERED'];

/**
 * Statuses excluded from the denominator entirely.
 *
 * Only WAIVED. UNKNOWN deliberately stays IN the denominator: an item we cannot
 * reason about is a hole in our knowledge, and moving it out of the denominator
 * would quietly raise the percentage every time our extractor got worse.
 */
export const EXCLUDED_STATUSES: readonly SurfaceStatus[] = ['WAIVED'];

// ─── Items ───────────────────────────────────────────────────────────────────

/**
 * One thing that can be tested.
 *
 * `key` is the identity, and it must be stable across runs or a snapshot cannot
 * be diffed against the one before it and no trend exists. It is derived only
 * from facts that do not move when the repo is reformatted: the kind and the
 * canonical identity of the thing. Never a line number — adding an import above
 * a form must not retire the form and mint a new one.
 */
export interface SurfaceItem {
  kind: SurfaceKind;
  /** Stable identity. See {@link surfaceKey}. */
  key: string;
  /** What to call it on screen: `/orders/:id`, `POST /api/refunds`. */
  label: string;
  /** Repo-relative file it was declared in, when a source detector found it. */
  file: string | null;
  /**
   * Line in that file, for the editor link. Deliberately NOT part of `key`:
   * it is navigation, not identity.
   */
  line: number | null;
  origin: SurfaceOrigin;
  /**
   * The sentence that justifies the item's existence, in the customer's terms:
   * "app/orders/[id]/page.tsx — directory path is the URL". This is what makes
   * the denominator auditable rather than asserted.
   */
  evidence: string;
  /** Which detector produced it, so a systematically wrong one can be found. */
  detector: string | null;
  /** Kind-specific detail the cockpit renders — a form's fields, an auth kind. */
  meta?: Record<string, unknown>;
}

/** How a test came to be matched to an item — the audit trail for `COVERED`. */
export interface SurfaceMatch {
  testId: string;
  testName: string;
  /**
   * Why we believe this test covers this item. Mirrors the asymmetry the gap
   * analyser already uses: `LITERAL` where a route string appears verbatim,
   * `HEURISTIC` where the evidence is weaker (a label mentioned in a spec).
   */
  basis: 'LITERAL' | 'NORMALISED' | 'HEURISTIC' | 'DECLARED';
  evidence: string;
}

/** Whether the matched tests have actually been seen to execute. */
export interface SurfaceVerification {
  /** The most recent run that executed a test matched to this item. */
  lastRunId: string | null;
  /**
   * The status that run reported for it, in the vocabulary the database and the
   * runner already use — never a parallel spelling invented here.
   */
  lastStatus: TestResultStatus | null;
  /**
   * True when a matched test ran and passed. The difference between this and
   * `matches.length > 0` is the difference between a coverage number and a
   * coverage claim.
   */
  executed: boolean;
  /**
   * Whether any matched test has been shown to kill a mutant in the code behind
   * this item. Null until a mutation run has had an opinion.
   *
   * This is the field no competitor in this market publishes: coverage without
   * it cannot distinguish a test that asserts behaviour from one that asserts
   * the page loaded.
   */
  mutationKilled: boolean | null;
}

export interface SurfaceItemCoverage {
  item: SurfaceItem;
  status: SurfaceStatus;
  matches: SurfaceMatch[];
  verification: SurfaceVerification;
  /** Present only when status is WAIVED. */
  waiver?: SurfaceWaiver;
}

export interface SurfaceWaiver {
  reason: string;
  /** Who recorded it — a waiver with no owner is a silent exclusion. */
  byUserId: string | null;
  byEmail: string | null;
  createdAtIso: string;
  /**
   * When the waiver lapses. Optional, but a waiver with no expiry is how a
   * denominator quietly shrinks forever, so the UI defaults to proposing one.
   */
  expiresAtIso: string | null;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * The stable identity of a surface item.
 *
 * Format: `KIND:identity`. The identity is already canonical by the time it
 * reaches here — routes through `canonicalRoute`, endpoints upper-cased with a
 * canonical path, forms as `file#index`. Keeping the kind as a visible prefix
 * means a key is readable in a log, a URL and a CLI argument, which matters
 * because customers will paste these into waiver files.
 */
export function surfaceKey(kind: SurfaceKind, identity: string): string {
  return `${kind}:${identity}`;
}

/** Splits a key back apart. Returns null when the string is not one of ours. */
export function parseSurfaceKey(key: string): { kind: SurfaceKind; identity: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator) as SurfaceKind;
  if (!SURFACE_KINDS.includes(kind)) return null;
  const identity = key.slice(separator + 1);
  if (identity.length === 0) return null;
  return { kind, identity };
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/** Per-axis arithmetic. Every field is a count, so the division is checkable. */
export interface SurfaceKindTotals {
  kind: SurfaceKind;
  /** Items on this axis, excluding waived. */
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  /**
   * `covered / denominator`, rounded to one decimal, or null when the
   * denominator is zero.
   *
   * Null is not 0% and not 100%. An axis with nothing on it means the extractor
   * found nothing, and printing either number would be a claim about the
   * customer's app made from our own silence.
   */
  percent: number | null;
  /** False for an axis QAAI has no extractor for. Stated, never omitted. */
  measured: boolean;
}

export interface SurfaceSnapshotTotals {
  /** The headline. Same formula as the per-axis one, over every measured axis. */
  percent: number | null;
  denominator: number;
  covered: number;
  assertedNotRun: number;
  uncovered: number;
  unknown: number;
  waived: number;
  byKind: SurfaceKindTotals[];
  /** Items the source declares that no crawl has reached. */
  declaredNeverReached: number;
  /** Items a crawl reached that the source analysis never declared. */
  reachedNeverDeclared: number;
}

/**
 * A stored measurement, so a trend exists and a gate has something to compare.
 *
 * The inputs are recorded alongside the number because a percentage without its
 * inputs cannot be defended in a meeting. If the crawl was truncated at 60
 * pages, that belongs next to the figure it produced, not in a tooltip.
 */
export interface SurfaceSnapshot {
  id: string;
  projectId: string;
  createdAtIso: string;
  /** The commit this was measured against, when the caller knew it. */
  commitSha: string | null;
  totals: SurfaceSnapshotTotals;
  /** What the measurement was computed from, for auditability. */
  inputs: {
    analysisId: string | null;
    flowMapVersion: number | null;
    testCount: number;
    runId: string | null;
  };
  /** Things a reader must know before trusting the number. Never empty-by-default. */
  caveats: string[];
  /** Changes whenever the answer could change. */
  fingerprint: string;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * The dark-surface report: the named list, which is the actual product.
 *
 * A percentage gets argued about; a list of 43 named routes with the file each
 * one is declared in gets forwarded. So this is the shape the API returns and
 * the CLI prints, and the percentage is a field on it rather than the point.
 */
export interface DarkSurfaceReport {
  projectId: string;
  snapshot: SurfaceSnapshot;
  /** Uncovered items, worst axis first, each with its file and evidence. */
  uncovered: SurfaceItemCoverage[];
  /** Items we cannot reason about. Reported separately, never as gaps. */
  unknown: SurfaceItemCoverage[];
  /** Waived items, so an exclusion is always visible next to the number. */
  waived: SurfaceItemCoverage[];
  /** Axes with no extractor, named so the gap in our own measurement is stated. */
  unmeasuredKinds: SurfaceKind[];
  /** True when more uncovered items exist than were returned. */
  truncated: boolean;
}

// ─── Arithmetic ──────────────────────────────────────────────────────────────

/**
 * One decimal place, and null rather than a number when there is nothing to
 * divide. Centralised because a coverage product with two rounding rules has
 * two coverage numbers.
 */
export function coveragePercent(covered: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((covered / denominator) * 1000) / 10;
}

/** Totals for one axis from its items. The only place a per-kind count is derived. */
export function totalsForKind(
  kind: SurfaceKind,
  items: readonly SurfaceItemCoverage[],
): SurfaceKindTotals {
  const mine = items.filter((entry) => entry.item.kind === kind);
  const count = (status: SurfaceStatus) => mine.filter((entry) => entry.status === status).length;

  const waived = count('WAIVED');
  const covered = count('COVERED');
  const denominator = mine.length - waived;

  return {
    kind,
    denominator,
    covered,
    assertedNotRun: count('ASSERTED_NOT_RUN'),
    uncovered: count('UNCOVERED'),
    unknown: count('UNKNOWN'),
    waived,
    percent: coveragePercent(covered, denominator),
    measured: MEASURED_SURFACE_KINDS.includes(kind),
  };
}

/**
 * The headline totals.
 *
 * Only MEASURED axes contribute. An axis we have no extractor for must not
 * enter the denominator as a row of zeroes — that would read as "0% of your
 * component states are covered" when the truth is "we do not look at component
 * states", and the first sentence is a lie about the customer's app while the
 * second is a fact about our product.
 */
export function totalsForItems(items: readonly SurfaceItemCoverage[]): SurfaceSnapshotTotals {
  const byKind = SURFACE_KINDS.map((kind) => totalsForKind(kind, items)).filter(
    (totals) => totals.measured || totals.denominator + totals.waived > 0,
  );

  const measured = byKind.filter((totals) => totals.measured);
  const sum = (pick: (totals: SurfaceKindTotals) => number) =>
    measured.reduce((running, totals) => running + pick(totals), 0);

  const covered = sum((t) => t.covered);
  const denominator = sum((t) => t.denominator);

  return {
    percent: coveragePercent(covered, denominator),
    denominator,
    covered,
    assertedNotRun: sum((t) => t.assertedNotRun),
    uncovered: sum((t) => t.uncovered),
    unknown: sum((t) => t.unknown),
    waived: sum((t) => t.waived),
    byKind,
    declaredNeverReached: items.filter((entry) => entry.item.origin === 'SOURCE_ONLY').length,
    reachedNeverDeclared: items.filter((entry) => entry.item.origin === 'CRAWL_ONLY').length,
  };
}

/** The axes with no extractor, for the report to name rather than omit. */
export function unmeasuredKinds(): SurfaceKind[] {
  return SURFACE_KINDS.filter((kind) => !MEASURED_SURFACE_KINDS.includes(kind));
}
