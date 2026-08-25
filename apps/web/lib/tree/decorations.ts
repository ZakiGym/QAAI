import { cn } from '../cn';

/**
 * Row decorations for the editor's explorer: the badge a row carries, which one
 * wins when several apply, how a folder folds up what is beneath it, and how a
 * row is tinted by the last run's result.
 *
 * Three rules shape all of it.
 *
 * ONE BADGE PER ROW. VS Code shows a single decoration and so does this, for
 * the same reason: the column is ~14px wide and a row that carries three badges
 * has stopped being a row and become a table. Everything a row has EARNED is
 * still computed (`decorationsFor`) — the precedence only decides what is
 * drawn, so a tooltip or a hover card can show the rest without recomputing.
 *
 * SHAPE FIRST, COLOUR SECOND. Three of the eight decorations are flake-amber
 * and two are fail-red. That is fine, and it is why every one of them is a
 * different GLYPH with a different silhouette, and why every one carries a
 * label. This is a QA tool: a reviewer who cannot distinguish red from green
 * still has to read pass from fail off this panel, every day.
 *
 * NO BRANCHING IN THE ROW. `rowStyle` returns finished class names. The row
 * component's job is to render what it is handed; every precedence argument
 * lives here, next to the reasoning for it, where it can be tested without a
 * DOM.
 */

// ─── The eight things a row can say ──────────────────────────────────────────

export type DecorationKind =
  | 'dirty'
  | 'error'
  | 'failed'
  | 'quarantined'
  | 'flaky'
  | 'warning'
  | 'review'
  | 'passed';

/**
 * Highest precedence first. The order IS the design decision, so it is argued
 * for rather than asserted:
 *
 *  1. `dirty`     — every other decoration describes the test as the server
 *                   knows it. This one describes the buffer in front of you,
 *                   and it is the only state whose information you can destroy
 *                   by clicking the next row. Losing work outranks learning
 *                   about work.
 *  2. `error`     — the file does not compile, so it cannot produce a result at
 *                   all, and every run-derived badge below is describing a
 *                   version of the file that no longer exists. It is also the
 *                   only badge that is true in the present tense.
 *  3. `failed`    — the last run failed. This is the reason a QA engineer
 *                   opened the panel, and it outranks quarantine deliberately:
 *                   a quarantined test that just failed is still a failure
 *                   somebody has to look at, and hiding it behind the calmer
 *                   badge is how a quarantine lane turns into a graveyard.
 *  4. `quarantined` — excluded from the gate. Above the softer signals because
 *                   it changes how they READ: a flaky quarantined test is
 *                   flaky BY DESIGN, and saying "quarantined" explains the
 *                   flake where saying "flaky" explains nothing.
 *  5. `flaky`     — the last run flaked. Real, actionable, not urgent.
 *  6. `warning`   — the language service has something to say and nothing is
 *                   broken by it. Below every statement about whether the test
 *                   actually works.
 *  7. `review`    — the generator asked a human to check its work. A to-do
 *                   rather than a fault, and the only badge that is nobody's
 *                   emergency.
 *  8. `passed`    — the quietest true thing a row can say, and last on purpose:
 *                   a green tick is the state you never have to go looking for.
 */
export const DECORATION_ORDER = [
  'dirty',
  'error',
  'failed',
  'quarantined',
  'flaky',
  'warning',
  'review',
  'passed',
] as const satisfies readonly DecorationKind[];

export interface DecorationMeta {
  /**
   * The badge's shape. Text rather than SVG because these sit inline with a
   * filename in a mono column, where a glyph shares the row's baseline, size
   * and colour for free — and because the shapes only have to differ from each
   * OTHER, which eight characters manage without eight more components.
   */
  glyph: string;
  /** Token class. Never a raw colour; the app has two themes and three accents. */
  className: string;
  /** `title` and `aria-label`. Takes the count so the label can be a sentence. */
  label: (count: number) => string;
  /**
   * Diagnostics are counts by nature — "3 errors" is the fact, not "errors" —
   * so their number is shown even at one. The rest are states, and a state
   * shows a number only once a folder has folded several of them together.
   */
  alwaysCount: boolean;
}

export const DECORATION_META: Record<DecorationKind, DecorationMeta> = {
  // The accent, not the flake amber: unsaved is a state of the buffer, not a
  // warning about the test. (This is the dot the explorer already draws.)
  dirty: {
    glyph: '●',
    className: 'text-accent',
    label: (n) => (n > 1 ? `${n} files with unsaved changes` : 'Unsaved changes'),
    alwaysCount: false,
  },
  error: {
    glyph: '✕',
    className: 'text-fail',
    label: (n) => (n === 1 ? '1 error' : `${n} errors`),
    alwaysCount: true,
  },
  failed: {
    glyph: '▲',
    className: 'text-fail',
    label: (n) => (n > 1 ? `${n} tests failed on their last run` : 'Failed on its last run'),
    alwaysCount: false,
  },
  quarantined: {
    glyph: '⊘',
    className: 'text-skip',
    label: (n) => (n > 1 ? `${n} quarantined tests — they run but never gate` : 'Quarantined — runs but never gates'),
    alwaysCount: false,
  },
  flaky: {
    glyph: '~',
    className: 'text-flake',
    label: (n) => (n > 1 ? `${n} tests flaked on their last run` : 'Flaked on its last run'),
    alwaysCount: false,
  },
  warning: {
    glyph: '!',
    className: 'text-flake',
    label: (n) => (n === 1 ? '1 warning' : `${n} warnings`),
    alwaysCount: true,
  },
  // The flag the explorer already uses for this, kept so nobody has to relearn it.
  review: {
    glyph: '⚑',
    className: 'text-flake',
    label: (n) => (n > 1 ? `${n} items flagged for review by the generator` : 'Flagged for review by the generator'),
    alwaysCount: false,
  },
  passed: {
    glyph: '✓',
    className: 'text-pass',
    label: (n) => (n > 1 ? `${n} tests passed on their last run` : 'Passed on its last run'),
    alwaysCount: false,
  },
};

/** A decoration, resolved and ready to render. */
export interface Decoration {
  kind: DecorationKind;
  glyph: string;
  className: string;
  /** Non-empty, always. Colour is never the only carrier of meaning here. */
  label: string;
  /** Magnitude: how many errors, how many flags, how many rows underneath. */
  count: number;
  /** Whether the row should print `count` next to the glyph. */
  showCount: boolean;
}

function decoration(kind: DecorationKind, count: number): Decoration {
  const meta = DECORATION_META[kind];
  return {
    kind,
    glyph: meta.glyph,
    className: meta.className,
    label: meta.label(count),
    count,
    showCount: meta.alwaysCount || count > 1,
  };
}

// ─── What a row knows about itself ───────────────────────────────────────────

/**
 * The statuses a test result can hold — TEST_RESULT_STATUSES from
 * `@qaai/shared`, restated rather than imported because this module is bundled
 * into the web app and that package ships source TS with no transpilePackages
 * entry. A tuple rather than a bare union so `decorations.test.ts` can hold it
 * against the shared list and fail when the enum grows a member this file has
 * no badge for.
 */
export const LAST_RESULT_STATUSES = ['PASSED', 'FAILED', 'SKIPPED', 'FLAKY', 'TIMED_OUT'] as const;

export type LastResultStatus = (typeof LAST_RESULT_STATUSES)[number];

/**
 * Everything about one FILE row that can produce a badge. Every field is
 * optional, so a caller with half the data loaded still gets a correct answer
 * about the half it has — the run history arrives on its own request, and a
 * tree that flickered its badges while that landed would be worse than one that
 * showed none.
 */
export interface RowSignals {
  /** The open buffer has edits that are not saved. */
  dirty?: boolean | undefined;
  /** Runs, but never gates a merge. */
  quarantined?: boolean | undefined;
  /** Generator review flags. Their COUNT is the badge's count. */
  reviewFlags?: readonly string[] | null | undefined;
  /** `null` when the test has never run, which is not the same as skipped. */
  lastResult?: LastResultStatus | null | undefined;
  /** From the language service. Non-integer or negative input counts as none. */
  errorCount?: number | undefined;
  warningCount?: number | undefined;
}

/** Negative, fractional and NaN counts all mean "no badge", never "a badge". */
function tally(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 0;
  return Math.floor(n);
}

/**
 * A result maps to at most one badge.
 *
 * TIMED_OUT is a failure: the distinction matters to the runner and to triage,
 * but at 13px in a file tree "it did not pass and you must look" is the whole
 * message. SKIPPED maps to nothing at all — a skip is the absence of a result,
 * and badging it would put a mark on every row of a suite somebody filtered.
 */
function resultDecoration(status: LastResultStatus | null | undefined): DecorationKind | null {
  switch (status) {
    case 'PASSED':
      return 'passed';
    case 'FAILED':
    case 'TIMED_OUT':
      return 'failed';
    case 'FLAKY':
      return 'flaky';
    default:
      return null;
  }
}

/** How many of each kind one row carries. The unit of aggregation. */
export type DecorationCounts = Partial<Record<DecorationKind, number>>;

/**
 * The raw tally for a single file row. Exported because folding a deep tree
 * bottom-up wants to merge counts, not re-derive them at every level.
 */
export function decorationCounts(signals: RowSignals): DecorationCounts {
  const counts: DecorationCounts = {};
  if (signals.dirty) counts.dirty = 1;
  if (signals.quarantined) counts.quarantined = 1;

  const errors = tally(signals.errorCount);
  if (errors > 0) counts.error = errors;
  const warnings = tally(signals.warningCount);
  if (warnings > 0) counts.warning = warnings;

  const flags = signals.reviewFlags?.length ?? 0;
  if (flags > 0) counts.review = flags;

  const result = resultDecoration(signals.lastResult);
  if (result) counts[result] = 1;

  return counts;
}

/** Sum tallies. A folder's counts are its descendants' counts added up. */
export function mergeDecorationCounts(parts: readonly DecorationCounts[]): DecorationCounts {
  const total: DecorationCounts = {};
  for (const part of parts) {
    for (const kind of DECORATION_ORDER) {
      const n = part[kind];
      if (n) total[kind] = (total[kind] ?? 0) + n;
    }
  }
  return total;
}

/** The one badge a tally resolves to, or null when there is nothing to say. */
export function topDecoration(counts: DecorationCounts): Decoration | null {
  for (const kind of DECORATION_ORDER) {
    const n = counts[kind];
    if (n && n > 0) return decoration(kind, n);
  }
  return null;
}

/**
 * Everything a row has earned, highest precedence first. The row draws
 * `[0]`; a tooltip or a hover card can use the rest.
 */
export function decorationsFor(signals: RowSignals): Decoration[] {
  const counts = decorationCounts(signals);
  const out: Decoration[] = [];
  for (const kind of DECORATION_ORDER) {
    const n = counts[kind];
    if (n && n > 0) out.push(decoration(kind, n));
  }
  return out;
}

/** The single badge a FILE row shows. */
export function primaryDecoration(signals: RowSignals): Decoration | null {
  return topDecoration(decorationCounts(signals));
}

/**
 * The single badge a FOLDER row shows: the highest-severity decoration anywhere
 * beneath it, with the total magnitude of that kind.
 *
 * It folds over every decoration each descendant earned rather than over each
 * descendant's winning one. That matters: a folder holding one dirty-and-failed
 * file and one failed file shows `● 1` either way — but if it held two
 * dirty-and-failed files, folding the winners would report `▲ 0` failures where
 * there are two, and the count on a folder badge exists precisely so that the
 * number can be trusted before anything is expanded.
 *
 * Takes descendant SIGNALS for the simple case. Deep trees should fold
 * `decorationCounts` upward with `mergeDecorationCounts` and finish with
 * `topDecoration`, which is one pass instead of one per level.
 */
export function aggregateDecorations(descendants: readonly RowSignals[]): Decoration | null {
  return topDecoration(mergeDecorationCounts(descendants.map(decorationCounts)));
}

// ─── Colour by last result (the row's own text) ──────────────────────────────

/**
 * Why the row looks the way it does. Returned alongside the classes so the
 * precedence is assertable without string-matching Tailwind, and so a caller
 * can put the reason in a tooltip.
 */
export type RowStyleReason = 'active' | 'dirty' | 'quarantined' | 'result' | 'neutral';

export interface RowStyleInput {
  /** Folders never tint: they have no result of their own. Defaults to file. */
  kind?: 'file' | 'dir' | undefined;
  /** The row is the open file. */
  active?: boolean | undefined;
  dirty?: boolean | undefined;
  quarantined?: boolean | undefined;
  lastResult?: LastResultStatus | null | undefined;
  /**
   * The preference. OFF by default, and it has to be: in a healthy suite this
   * paints most of the panel green, and a tree where 90% of the rows are
   * coloured is a tree where colour has stopped meaning anything. It earns its
   * keep for the person triaging a red build, who turns it on.
   */
  tintByResult?: boolean | undefined;
}

export interface RowStyle {
  /**
   * Background and text colour only. Layout, size and font belong to the row
   * component and to the panel — a file tree is a list of paths, and the panel
   * decides what a path looks like.
   */
  className: string;
  reason: RowStyleReason;
}

const RESULT_TINT: Record<LastResultStatus, string | null> = {
  PASSED: 'text-pass',
  FAILED: 'text-fail',
  TIMED_OUT: 'text-fail',
  FLAKY: 'text-flake',
  // Never ran, or ran and was skipped: there is nothing to say, so say nothing.
  SKIPPED: null,
};

const HOVER = 'hover:bg-surface-1';

/**
 * The row's colours, with the result tint fitted underneath the states that
 * outrank it.
 *
 * The tint is the LAST thing consulted, which is what "must never fight the
 * active-row or dirty styling" means in practice:
 *
 *  · ACTIVE wins outright. The open file is located by contrast against the
 *    rest of the list, and trading that contrast for a status hue costs the
 *    user the one row they are certain to be looking for.
 *  · DIRTY wins next, and brightens rather than tints. The buffer no longer
 *    matches what produced that result, so the result's colour would be a
 *    claim about code that is not on disk. Full-strength ink says "this row is
 *    live" without saying anything false; the accent dot carries the rest.
 *  · QUARANTINED mutes and suppresses the tint. A quarantined test cannot gate
 *    anything, so painting the row red overstates it — and the `⊘` badge has
 *    already said the true thing.
 *  · Otherwise the tint applies, if the preference is on and there is a result.
 *    A test that has never run degrades to exactly the neutral row it was
 *    before the feature existed.
 */
export function rowStyle(input: RowStyleInput): RowStyle {
  if (input.active) return { className: cn('bg-surface-2', 'text-ink'), reason: 'active' };

  if (input.kind === 'dir') {
    // Folders read as structure, not content — one step fainter than the files
    // inside them, which is what the explorer already does.
    return { className: cn(HOVER, 'text-ink-faint'), reason: 'neutral' };
  }

  if (input.dirty) return { className: cn(HOVER, 'text-ink'), reason: 'dirty' };
  if (input.quarantined) return { className: cn(HOVER, 'text-skip'), reason: 'quarantined' };

  const tint = input.tintByResult && input.lastResult ? RESULT_TINT[input.lastResult] : null;
  if (tint) return { className: cn(HOVER, tint), reason: 'result' };

  return { className: cn(HOVER, 'text-ink-dim'), reason: 'neutral' };
}

/** `rowStyle(...).className`, for callers that do not need the reason. */
export function rowClassName(input: RowStyleInput): string {
  return rowStyle(input).className;
}
