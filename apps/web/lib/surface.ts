/**
 * The arithmetic and the wording behind the dark-surface screen.
 *
 * WHY THIS FILE EXISTS
 *
 * The screen's job is to print one number and a list of names, and the five
 * ways a coverage product lies are all ways of printing that number wrongly:
 * a zero where there was nothing to divide, a gap count that quietly absorbed
 * "a test exists but has never run", an axis we do not measure drawn as 0%.
 * Every one of those is a formatting decision, and a formatting decision made
 * inside JSX cannot be tested.
 *
 * So the rules live here as functions over the API's own shapes, and the
 * components are left with nothing to decide. `formatPercent` is the only
 * place in the cockpit allowed to turn a percent into text, which is what
 * makes "null is not 0% and not 100%" enforceable rather than aspirational.
 *
 * Nothing here touches React, the network or the DOM.
 */

import { MEASURED_SURFACE_KINDS, SURFACE_KIND_LABELS, SURFACE_STATUS_LABELS } from '@qaai/shared';
import type {
  SurfaceItemCoverage,
  SurfaceKind,
  SurfaceKindTotals,
  SurfaceOrigin,
  SurfaceSnapshot,
  SurfaceSnapshotTotals,
  SurfaceStatus,
} from '@qaai/shared';

// ─── What the endpoints return ───────────────────────────────────────────────

/**
 * A snapshot as the database hands it back — `GET /surface/:id/trend` and the
 * `lastStored` field on the report.
 *
 * Deliberately NOT `SurfaceSnapshot`: the stored row is flat (the totals are
 * columns, not a nested object), `createdAt` has been through JSON and is a
 * string, and `byKind` is a Json column the client has no use for. Declaring
 * the row's real shape is better than casting it into a type it does not have.
 */
export interface StoredSnapshot {
  id: string;
  createdAt: string;
  commitSha: string | null;
  percent: number | null;
  denominator: number;
  covered: number;
  uncovered: number;
  unknown: number;
  waived: number;
  assertedNotRun: number;
  declaredNeverReached: number;
  reachedNeverDeclared: number;
  caveats: string[];
  fingerprint: string;
  testCount: number;
  flowMapVersion: number | null;
}

/** `GET /surface/:projectId`. */
export interface SurfaceReport {
  projectId: string;
  snapshot: SurfaceSnapshot;
  items: SurfaceItemCoverage[];
  /** The full count behind the page, never the page's own length. */
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
  unmeasuredKinds: SurfaceKind[];
  /** The last PERSISTED snapshot, so a reader can see the live number drift. */
  lastStored: StoredSnapshot | null;
}

/** `GET /surface/:projectId/trend`. Newest first — see {@link sparkline}. */
export interface SurfaceTrend {
  projectId: string;
  snapshots: StoredSnapshot[];
}

/** `POST /surface/:projectId/recompute`. */
export interface RecomputeResult {
  snapshotId: string;
  snapshot: SurfaceSnapshot;
  unmeasuredKinds: SurfaceKind[];
}

// ─── Percentages ─────────────────────────────────────────────────────────────

/**
 * The one place a percent becomes text.
 *
 * Null means the denominator was zero, and it is neither 0% nor 100%: both of
 * those are claims about the customer's application made out of our own
 * silence. It renders as words, with no digit in them, so a reader skimming for
 * a number does not find one that was never measured.
 */
export function formatPercent(percent: number | null): string {
  if (percent === null) return 'not measured';
  // The server already rounds to one decimal. An integer prints without the
  // trailing `.0`, because "100.0%" reads as a measurement precision we do not
  // have and "62.4%" reads as the one we do.
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

export type Headline =
  | {
      measured: true;
      percent: number;
      /** The sentence, with the number in it. */
      sentence: string;
      /** The division, spelled out, so the reader can check it. */
      detail: string;
    }
  | {
      measured: false;
      /** Never a number. */
      sentence: string;
      /** Why there was nothing to divide. */
      reason: string;
      /** The one thing that would change the answer. */
      next: string;
    };

/**
 * The headline, as a sentence.
 *
 * A zero denominator is the case this function exists for. "0% covered" and
 * "100% covered" are both defensible-sounding and both wrong — the honest
 * answer is that no measurement happened, and the reader needs to know which
 * of the two reasons applies, because one is fixed by connecting a repository
 * and the other by withdrawing a waiver.
 */
export function headlineFor(totals: SurfaceSnapshotTotals): Headline {
  if (totals.denominator > 0 && totals.percent !== null) {
    return {
      measured: true,
      percent: totals.percent,
      sentence: `You cover ${formatPercent(totals.percent)} of your application`,
      detail: `${totals.covered} of ${totals.denominator} surfaces your source declares have a test that has been seen to run.`,
    };
  }

  // Everything waived is a different fact from nothing extracted, and the
  // reader can act on exactly one of them.
  if (totals.waived > 0) {
    return {
      measured: false,
      sentence: 'Not measured yet',
      reason: `Every one of the ${totals.waived} items in the inventory is waived, so there is nothing left to divide by. This is not full coverage and it is not zero coverage — it is an empty denominator.`,
      next: 'Withdraw a waiver to put something back in the denominator.',
    };
  }

  return {
    measured: false,
    sentence: 'Not measured yet',
    reason:
      'Nothing has been extracted from this application yet, so there is no denominator. A percentage here would be a number invented out of our own silence rather than measured from your code.',
    next: 'Connect the repository and record a snapshot — the denominator comes from the source, not from a crawl.',
  };
}

/**
 * One axis, in words.
 *
 * Three different reasons an axis has no percentage, and merging them is how
 * "0% of your component states are covered" gets printed — a lie about the
 * customer's app, where "we do not measure component states" is a fact about
 * ours.
 */
export function describeKind(totals: SurfaceKindTotals): {
  text: string;
  /** False when the text is a statement about QAAI rather than a measurement. */
  measured: boolean;
} {
  if (!totals.measured) return { text: 'not measured by QAAI', measured: false };
  if (totals.denominator === 0) return { text: 'nothing to divide', measured: false };
  return { text: `${formatPercent(totals.percent)} covered`, measured: true };
}

/** The axes with no extractor, named. A customer is entitled to the list. */
export function describeUnmeasured(kinds: readonly SurfaceKind[]): string[] {
  return kinds.map((kind) => `We do not measure ${SURFACE_KIND_LABELS[kind].toLowerCase()}.`);
}

/** True for an axis QAAI has an extractor for. Mirrors the shared constant. */
export function isMeasuredKind(kind: SurfaceKind): boolean {
  return MEASURED_SURFACE_KINDS.includes(kind);
}

// ─── The states that are not "covered" and not "a gap" ───────────────────────

export interface OtherState {
  status: SurfaceStatus;
  count: number;
  /** The shared vocabulary's own words, so every surface agrees. */
  label: string;
  /** Why this is its own number and not part of the gap count. */
  note: string;
}

/**
 * The three states a reader will otherwise assume are gaps.
 *
 * Always three entries, including the zeroes. A count that disappears when it
 * reaches zero cannot be told apart from a count that was never shown, and the
 * whole point of this strip is that the reader knows these were kept out of
 * the gap number.
 */
export function otherStates(totals: SurfaceSnapshotTotals): OtherState[] {
  return [
    {
      status: 'ASSERTED_NOT_RUN',
      count: totals.assertedNotRun,
      label: SURFACE_STATUS_LABELS.ASSERTED_NOT_RUN,
      note: 'Not covered: a test that has never executed has not been shown to pass, or to assert anything. Not a gap either — the test exists.',
    },
    {
      status: 'UNKNOWN',
      count: totals.unknown,
      label: SURFACE_STATUS_LABELS.UNKNOWN,
      note: 'Static analysis could not tell, because the suite navigates to URLs built at run time. In the denominator, never presented as a gap.',
    },
    {
      status: 'WAIVED',
      count: totals.waived,
      label: SURFACE_STATUS_LABELS.WAIVED,
      note: 'Excluded from the denominator on the record, each with a reason and an owner.',
    },
  ];
}

/** The gap count itself. UNCOVERED and nothing else — see {@link otherStates}. */
export function gapCount(totals: SurfaceSnapshotTotals): number {
  return totals.uncovered;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export interface Reconciliation {
  declaredNeverReached: number;
  reachedNeverDeclared: number;
  /** What the first number means for the customer. */
  declaredNote: string;
  /** Whose fault the second number is. Ours. */
  reachedNote: string;
}

export function reconciliation(totals: SurfaceSnapshotTotals): Reconciliation {
  return {
    declaredNeverReached: totals.declaredNeverReached,
    reachedNeverDeclared: totals.reachedNeverDeclared,
    declaredNote:
      'Declared in your source and never reached by a crawl: dead code, or — far more often — a page behind a button, a wizard step, a role we do not hold or a flag we did not set. These are the rows a runtime-only tool cannot see at all.',
    reachedNote:
      "Reached by a crawl and never found in your source: that is a gap in QAAI's own extraction, not in your tests. The route table we read is probably not the one your app uses.",
  };
}

// ─── Filters and paging ──────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;

export interface SurfaceFilters {
  /** Empty means every kind. */
  kinds: SurfaceKind[];
  /** Empty means every state — see {@link surfaceQuery}. */
  statuses: SurfaceStatus[];
  origin: SurfaceOrigin | null;
  offset: number;
  limit: number;
}

/** What the screen opens on: the gaps, which is what it is for. */
export const DEFAULT_FILTERS: SurfaceFilters = {
  kinds: [],
  statuses: ['UNCOVERED'],
  origin: null,
  offset: 0,
  limit: DEFAULT_PAGE_SIZE,
};

/** Every status, for the "all" selection. Kept explicit — see below. */
const ALL_STATUSES: readonly SurfaceStatus[] = [
  'COVERED',
  'ASSERTED_NOT_RUN',
  'UNCOVERED',
  'UNKNOWN',
  'WAIVED',
];

/**
 * The query string for `GET /surface/:projectId`.
 *
 * The one trap worth the comment: the endpoint DEFAULTS `status` to UNCOVERED
 * when the parameter is absent. So "show me every state" cannot be expressed
 * by omitting it — that silently answers with gaps only, under a filter row
 * claiming everything was selected. An empty selection is therefore sent as
 * all five values explicitly.
 */
export function surfaceQuery(filters: SurfaceFilters): string {
  const params = new URLSearchParams();
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  const statuses = filters.statuses.length > 0 ? filters.statuses : ALL_STATUSES;
  params.set('status', statuses.join(','));
  if (filters.kinds.length > 0) params.set('kind', filters.kinds.join(','));
  if (filters.origin) params.set('origin', filters.origin);
  return params.toString();
}

/**
 * How many rows the response held back.
 *
 * Reported rather than quietly applied: a list showing 50 of 243 gaps while
 * saying nothing is the kind of truncation that makes a number untrustworthy.
 */
export function heldBack(report: {
  total: number;
  offset: number;
  items: readonly unknown[];
}): number {
  return Math.max(0, report.total - (report.offset + report.items.length));
}

/** Which page we are on, 1-based, for a "page 2 of 5" line. */
export function pageOf(report: { total: number; offset: number; limit: number }): {
  page: number;
  pages: number;
} {
  const pages = Math.max(1, Math.ceil(report.total / Math.max(1, report.limit)));
  return {
    page: Math.min(pages, Math.floor(report.offset / Math.max(1, report.limit)) + 1),
    pages,
  };
}

// ─── The named list ──────────────────────────────────────────────────────────

export interface SurfaceGroup {
  kind: SurfaceKind;
  label: string;
  items: SurfaceItemCoverage[];
}

/**
 * The list, grouped by axis, worst axis first.
 *
 * "Worst first" is the SERVER's ranking, not a second opinion computed here:
 * `rankUncovered` already orders auth surfaces before endpoints before routes
 * before forms, and declared-but-never-reached first within an axis. Grouping
 * by first appearance preserves that order exactly, so there is one definition
 * of "worst" in the product instead of two that drift apart.
 */
export function groupByKind(items: readonly SurfaceItemCoverage[]): SurfaceGroup[] {
  const groups: SurfaceGroup[] = [];
  const byKind = new Map<SurfaceKind, SurfaceGroup>();
  for (const entry of items) {
    const existing = byKind.get(entry.item.kind);
    if (existing) {
      existing.items.push(entry);
      continue;
    }
    const group: SurfaceGroup = {
      kind: entry.item.kind,
      label: SURFACE_KIND_LABELS[entry.item.kind],
      items: [entry],
    };
    byKind.set(entry.item.kind, group);
    groups.push(group);
  }
  return groups;
}

// ─── Waivers ─────────────────────────────────────────────────────────────────

/** Mirrors `waiverBody.reason` in apps/api/src/routes/surface.ts. */
export const WAIVER_REASON_MIN = 10;

/** Days ahead the expiry field is pre-filled with. A default, never a ceiling. */
export const WAIVER_DEFAULT_DAYS = 90;

export interface WaiverDraft {
  reason: string;
  /** `YYYY-MM-DD` from a date input, or empty for no expiry. */
  expiresAt: string;
}

export interface WaiverCheck {
  /** A message to block submission with, or null. */
  problem: string | null;
  /**
   * True when the draft has no expiry. Not a problem — the API allows it — but
   * a waiver with no expiry is how a denominator quietly shrinks forever, so
   * the UI says so out loud instead of accepting it silently.
   */
  permanent: boolean;
}

/**
 * The same two rules the API enforces, checked before the request.
 *
 * Both are mirrored rather than left to the server because the server's 400
 * arrives after the dialog has closed over the row it was about. The trimming
 * matters: the endpoint validates `z.string().trim().min(10)`, so ten spaces
 * and a word is not a ten-character reason there and must not be one here.
 */
export function checkWaiver(draft: WaiverDraft, now: Date = new Date()): WaiverCheck {
  const reason = draft.reason.trim();
  const permanent = draft.expiresAt.trim().length === 0;

  if (reason.length < WAIVER_REASON_MIN) {
    return {
      problem: `A waiver removes this item from the denominator, so it needs a reason somebody can read months later — at least ${WAIVER_REASON_MIN} characters (${reason.length} so far).`,
      permanent,
    };
  }

  if (!permanent) {
    const expires = new Date(draft.expiresAt);
    if (Number.isNaN(expires.getTime())) {
      return { problem: 'That is not a date the API will accept.', permanent };
    }
    // The same check the endpoint makes, and for the same reason: a waiver that
    // has already expired is filtered out on the next computation, so it would
    // look recorded and do nothing.
    if (expires.getTime() <= now.getTime()) {
      return { problem: 'A waiver that has already expired would have no effect.', permanent };
    }
  }

  return { problem: null, permanent };
}

/** The expiry the dialog opens with, as a date input's `YYYY-MM-DD`. */
export function defaultExpiry(now: Date = new Date()): string {
  const then = new Date(now.getTime() + WAIVER_DEFAULT_DAYS * 24 * 60 * 60 * 1000);
  return then.toISOString().slice(0, 10);
}

/** The POST body. `expiresAt` is omitted rather than sent null when absent. */
export function waiverBody(
  key: string,
  draft: WaiverDraft,
): { key: string; reason: string; expiresAt?: string } {
  const expiresAt = draft.expiresAt.trim();
  return {
    key,
    reason: draft.reason.trim(),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

// ─── The trend ───────────────────────────────────────────────────────────────

export interface Sparkline {
  /** `x,y x,y …` for an SVG polyline, oldest on the left. */
  points: string;
  oldest: number;
  newest: number;
  /** How many snapshots are actually drawn. */
  count: number;
  /** How many were dropped for having no percentage at all. */
  unmeasured: number;
}

/**
 * The trend, as polyline coordinates. No chart library, and none needed.
 *
 * Two things here are the whole reason it is a function and not inline JSX:
 *
 *  - The endpoint returns snapshots NEWEST FIRST. Plotted in that order the
 *    line runs backwards, so a suite that improved appears to be sliding. The
 *    reversal is the point.
 *  - A snapshot with a null percent had nothing to divide. Treating it as zero
 *    would draw a cliff where no measurement happened, so those are dropped
 *    and counted, not plotted.
 *
 * The vertical scale is the series' own min..max rather than 0..100: a trend
 * from 61.8% to 62.4% is invisible against a full scale, and the caller prints
 * both end values beside the line so the magnitude is never implied by the
 * drawing alone.
 */
export function sparkline(
  snapshots: readonly { percent: number | null }[],
  width = 96,
  height = 22,
): Sparkline | null {
  const measured = snapshots.filter(
    (snapshot): snapshot is { percent: number } => snapshot.percent !== null,
  );
  const unmeasured = snapshots.length - measured.length;
  // Oldest first. The API's order is newest first.
  const series = [...measured].reverse().map((snapshot) => snapshot.percent);

  // One point is not a trend, and a line drawn through it would assert a
  // direction nobody measured.
  if (series.length < 2) return null;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const points = series
    .map((percent, index) => {
      const x = (index / (series.length - 1)) * width;
      // A flat series has no span to scale against: draw it down the middle
      // rather than dividing by zero and pinning it to an edge.
      const y = span === 0 ? height / 2 : height - ((percent - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');

  return {
    points,
    oldest: series[0] as number,
    newest: series[series.length - 1] as number,
    count: series.length,
    unmeasured,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Whether the number on screen has moved away from the one a CI gate last
 * acted on. Both may legitimately be null, which is not a drift.
 */
export function storedDrift(
  live: SurfaceSnapshotTotals,
  stored: StoredSnapshot | null,
): { drifted: boolean; stored: StoredSnapshot } | null {
  if (!stored) return null;
  if (stored.percent === live.percent && stored.denominator === live.denominator) return null;
  return { drifted: true, stored };
}
