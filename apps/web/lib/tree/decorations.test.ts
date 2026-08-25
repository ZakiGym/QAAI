import { describe, expect, it } from 'vitest';
import { TEST_RESULT_STATUSES } from '@qaai/shared';
import {
  DECORATION_META,
  DECORATION_ORDER,
  LAST_RESULT_STATUSES,
  aggregateDecorations,
  decorationCounts,
  decorationsFor,
  mergeDecorationCounts,
  primaryDecoration,
  rowClassName,
  rowStyle,
  topDecoration,
  type DecorationKind,
  type LastResultStatus,
  type RowSignals,
  type RowStyleInput,
} from './decorations';

/** Only design tokens. A raw hex or a stock palette name breaks both themes. */
const TOKEN_CLASS = /^text-(ink|ink-dim|ink-faint|accent|pass|fail|flake|skip)$/;
const NO_RAW_COLOUR = /#|rgb|blue|slate|gray|grey|zinc|indigo|amber|emerald|\d{3}\b/;

/**
 * The classes as a LIST, so `toContain` means "this exact utility is present".
 * Against the joined string it means "this substring appears somewhere", and
 * `'text-ink'` is a substring of both `text-ink-dim` and `text-ink-faint` — so
 * the two assertions that mattered most, that an active row and a dirty row are
 * at FULL ink, would have passed on the two colours they exist to rule out.
 */
const classesOf = (input: RowStyleInput): string[] => rowClassName(input).split(' ');

const kindOf = (signals: RowSignals): DecorationKind | null => primaryDecoration(signals)?.kind ?? null;

// ─── The table itself ────────────────────────────────────────────────────────

describe('the decoration table', () => {
  it('orders every kind exactly once', () => {
    expect([...DECORATION_ORDER].sort()).toEqual(Object.keys(DECORATION_META).sort());
    expect(new Set(DECORATION_ORDER).size).toBe(DECORATION_ORDER.length);
  });

  /*
   * Three of these are flake-amber and two are fail-red, which is fine only
   * because no two share a silhouette. If a future edit gives `warning` the
   * flag glyph, a colour-blind reviewer loses the ability to tell a generator
   * flag from a compiler warning — and nothing else in the app would notice.
   */
  it('draws a different glyph for every kind', () => {
    const glyphs = DECORATION_ORDER.map((k) => DECORATION_META[k].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    for (const g of glyphs) expect(g.trim().length).toBeGreaterThan(0);
  });

  it('colours every kind with a design token', () => {
    for (const kind of DECORATION_ORDER) {
      expect(DECORATION_META[kind].className).toMatch(TOKEN_CLASS);
      expect(DECORATION_META[kind].className).not.toMatch(NO_RAW_COLOUR);
    }
  });

  it('labels every kind in words, at one and at many', () => {
    for (const kind of DECORATION_ORDER) {
      expect(DECORATION_META[kind].label(1).length).toBeGreaterThan(0);
      expect(DECORATION_META[kind].label(7)).toContain('7');
    }
  });
});

// ─── decorationCounts: one row's raw tally ───────────────────────────────────

describe('decorationCounts', () => {
  it('says nothing about a clean, never-run file', () => {
    expect(decorationCounts({})).toEqual({});
    expect(decorationsFor({})).toEqual([]);
    expect(primaryDecoration({})).toBeNull();
  });

  it('tallies each signal on its own', () => {
    expect(decorationCounts({ dirty: true })).toEqual({ dirty: 1 });
    expect(decorationCounts({ quarantined: true })).toEqual({ quarantined: 1 });
    expect(decorationCounts({ errorCount: 3 })).toEqual({ error: 3 });
    expect(decorationCounts({ warningCount: 2 })).toEqual({ warning: 2 });
    expect(decorationCounts({ reviewFlags: ['a', 'b'] })).toEqual({ review: 2 });
    expect(decorationCounts({ lastResult: 'PASSED' })).toEqual({ passed: 1 });
  });

  const results: Array<[LastResultStatus | null | undefined, DecorationKind | null]> = [
    ['PASSED', 'passed'],
    ['FAILED', 'failed'],
    // A timeout is a failure the user has to look at. The distinction matters
    // to triage, not to a 13px badge.
    ['TIMED_OUT', 'failed'],
    ['FLAKY', 'flaky'],
    // A skip is the absence of a result, not a result. Badging it would mark
    // every row of a suite somebody filtered.
    ['SKIPPED', null],
    [null, null],
    [undefined, null],
  ];
  it.each(results)('last result %s → %s', (status, expected) => {
    expect(kindOf({ lastResult: status })).toBe(expected);
  });

  const bogus: Array<[unknown, string]> = [
    [0, 'zero'],
    [-4, 'negative'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [undefined, 'absent'],
  ];
  it.each(bogus)('treats an error count of %s (%s) as no badge', (count) => {
    expect(decorationCounts({ errorCount: count as number })).toEqual({});
    expect(decorationCounts({ warningCount: count as number })).toEqual({});
  });

  it('floors a fractional count rather than printing one', () => {
    expect(decorationCounts({ errorCount: 2.7 })).toEqual({ error: 2 });
    // Below one is none, not a rounded-up one.
    expect(decorationCounts({ errorCount: 0.9 })).toEqual({});
  });

  it('treats an empty or absent flag list as unflagged', () => {
    expect(decorationCounts({ reviewFlags: [] })).toEqual({});
    expect(decorationCounts({ reviewFlags: null })).toEqual({});
  });
});

// ─── Precedence ──────────────────────────────────────────────────────────────

describe('precedence — one badge, and the right one', () => {
  /**
   * Walk the whole order top to bottom: start with a row that has earned every
   * badge it possibly can, then remove the winner and check the next one takes
   * over. Eight assertions that between them pin every step of the order, and
   * that fail loudly if two entries are ever swapped.
   *
   * The result-derived three (failed/flaky/passed) are mutually exclusive by
   * construction, so each step supplies the result that keeps the walk going.
   */
  const walk: Array<[DecorationKind | null, RowSignals]> = [
    ['dirty', { dirty: true, errorCount: 2, warningCount: 3, reviewFlags: ['x'], quarantined: true, lastResult: 'FAILED' }],
    ['error', { errorCount: 2, warningCount: 3, reviewFlags: ['x'], quarantined: true, lastResult: 'FAILED' }],
    ['failed', { warningCount: 3, reviewFlags: ['x'], quarantined: true, lastResult: 'FAILED' }],
    ['quarantined', { warningCount: 3, reviewFlags: ['x'], quarantined: true, lastResult: 'FLAKY' }],
    ['flaky', { warningCount: 3, reviewFlags: ['x'], lastResult: 'FLAKY' }],
    ['warning', { warningCount: 3, reviewFlags: ['x'], lastResult: 'PASSED' }],
    ['review', { reviewFlags: ['x'], lastResult: 'PASSED' }],
    ['passed', { lastResult: 'PASSED' }],
    [null, {}],
  ];
  it.each(walk)('shows %s', (expected, signals) => {
    expect(kindOf(signals)).toBe(expected);
  });

  it('keeps every badge the row earned, in order, behind the one it shows', () => {
    const all = decorationsFor(walk[0]![1]);
    expect(all.map((d) => d.kind)).toEqual(['dirty', 'error', 'failed', 'quarantined', 'warning', 'review']);
    expect(all[0]).toEqual(primaryDecoration(walk[0]![1]));
  });

  /* The pairs the order was argued over, asserted directly so the argument is
     the thing that breaks if someone disagrees with it later. */
  it('puts unsaved work above everything, because it is the only losable state', () => {
    expect(kindOf({ dirty: true, errorCount: 9 })).toBe('dirty');
  });

  it('puts a compile error above a run result, which describes older code', () => {
    expect(kindOf({ errorCount: 1, lastResult: 'FAILED' })).toBe('error');
  });

  it('does NOT let quarantine hide a failure', () => {
    expect(kindOf({ quarantined: true, lastResult: 'FAILED' })).toBe('failed');
    expect(kindOf({ quarantined: true, lastResult: 'TIMED_OUT' })).toBe('failed');
  });

  it('does let quarantine explain a flake, and a pass', () => {
    expect(kindOf({ quarantined: true, lastResult: 'FLAKY' })).toBe('quarantined');
    expect(kindOf({ quarantined: true, lastResult: 'PASSED' })).toBe('quarantined');
  });

  it('puts a warning below every statement about whether the test works', () => {
    expect(kindOf({ warningCount: 5, lastResult: 'FLAKY' })).toBe('flaky');
    expect(kindOf({ warningCount: 5, reviewFlags: ['x'] })).toBe('warning');
  });
});

// ─── Counts on the badge ─────────────────────────────────────────────────────

describe('showCount', () => {
  it('always numbers diagnostics, because "3 errors" is the fact', () => {
    expect(primaryDecoration({ errorCount: 1 })).toMatchObject({ count: 1, showCount: true });
    expect(primaryDecoration({ warningCount: 1 })).toMatchObject({ count: 1, showCount: true });
  });

  it('never numbers a single state', () => {
    expect(primaryDecoration({ dirty: true })).toMatchObject({ count: 1, showCount: false });
    expect(primaryDecoration({ lastResult: 'FAILED' })).toMatchObject({ count: 1, showCount: false });
  });

  it('numbers a state once several have been folded together', () => {
    const folder = aggregateDecorations([{ dirty: true }, { dirty: true }, { dirty: true }]);
    expect(folder).toMatchObject({ kind: 'dirty', count: 3, showCount: true });
    expect(folder?.label).toContain('3');
  });

  it('counts a file’s review flags rather than the file', () => {
    expect(primaryDecoration({ reviewFlags: ['a', 'b', 'c'] })).toMatchObject({ count: 3, showCount: true });
  });
});

// ─── Folder aggregation ──────────────────────────────────────────────────────

describe('aggregateDecorations', () => {
  it('says nothing about an empty folder, or one full of clean files', () => {
    expect(aggregateDecorations([])).toBeNull();
    expect(aggregateDecorations([{}, {}, {}])).toBeNull();
    expect(aggregateDecorations([{ lastResult: 'SKIPPED' }, { reviewFlags: [] }])).toBeNull();
  });

  it('shows the highest-severity thing beneath it', () => {
    const folder = aggregateDecorations([
      { lastResult: 'PASSED' },
      { reviewFlags: ['x'] },
      { lastResult: 'FAILED' },
      { lastResult: 'PASSED' },
    ]);
    expect(folder).toMatchObject({ kind: 'failed', count: 1 });
  });

  it('sums magnitudes, so a folder’s error count is the real one', () => {
    const folder = aggregateDecorations([{ errorCount: 2 }, { errorCount: 3 }, {}]);
    expect(folder).toMatchObject({ kind: 'error', count: 5, showCount: true });
    expect(folder?.label).toBe('5 errors');
  });

  /*
   * The bug this function's shape exists to avoid. Fold each descendant's
   * WINNING badge and the two failures below vanish, because `dirty` outranked
   * them on both rows — the folder would show "1 unsaved" and, once expanded,
   * two red files that its badge never mentioned. Folding every badge each row
   * earned keeps the tally honest.
   */
  it('counts what is underneath, not only what each row displays', () => {
    const rows: RowSignals[] = [
      { dirty: true, lastResult: 'FAILED' },
      { dirty: true, lastResult: 'FAILED' },
    ];
    expect(aggregateDecorations(rows)).toMatchObject({ kind: 'dirty', count: 2 });
    expect(mergeDecorationCounts(rows.map(decorationCounts))).toEqual({ dirty: 2, failed: 2 });
  });

  it('folds bottom-up to the same answer as folding all the leaves at once', () => {
    const leaves: RowSignals[] = [
      { errorCount: 1, lastResult: 'FAILED' },
      { reviewFlags: ['a'] },
      { warningCount: 4, lastResult: 'FLAKY' },
      { lastResult: 'PASSED' },
    ];
    // Two subfolders' tallies merged, versus every leaf merged in one go.
    const nested = mergeDecorationCounts([
      mergeDecorationCounts(leaves.slice(0, 2).map(decorationCounts)),
      mergeDecorationCounts(leaves.slice(2).map(decorationCounts)),
    ]);
    expect(nested).toEqual(mergeDecorationCounts(leaves.map(decorationCounts)));
    expect(topDecoration(nested)).toEqual(aggregateDecorations(leaves));
  });

  it('merges nothing into nothing', () => {
    expect(mergeDecorationCounts([])).toEqual({});
    expect(mergeDecorationCounts([{}, {}])).toEqual({});
    expect(topDecoration({})).toBeNull();
    // A zero in the tally is not a badge.
    expect(topDecoration({ error: 0, review: 0 })).toBeNull();
  });
});

// ─── Colour by last result ───────────────────────────────────────────────────

describe('rowStyle', () => {
  it('gives the open row its contrast and never trades it for a status hue', () => {
    for (const result of ['PASSED', 'FAILED', 'FLAKY'] as const) {
      const input: RowStyleInput = { active: true, tintByResult: true, lastResult: result, dirty: true };
      const style = rowStyle(input);
      expect(style.reason).toBe('active');
      expect(classesOf(input)).toContain('bg-surface-2');
      expect(classesOf(input)).toContain('text-ink');
      expect(style.className).not.toMatch(/text-(pass|fail|flake)\b/);
    }
  });

  it('leaves an unsaved row at full ink, because the result predates the edit', () => {
    const input: RowStyleInput = { dirty: true, tintByResult: true, lastResult: 'FAILED' };
    const style = rowStyle(input);
    expect(style.reason).toBe('dirty');
    // FULL ink — not `text-ink-dim`, which is what a substring match allows.
    expect(classesOf(input)).toContain('text-ink');
    expect(classesOf(input)).not.toContain('text-ink-dim');
    expect(style.className).not.toContain('text-fail');
  });

  it('mutes a quarantined row instead of colouring it by a result that cannot gate', () => {
    const style = rowStyle({ quarantined: true, tintByResult: true, lastResult: 'FAILED' });
    expect(style.reason).toBe('quarantined');
    expect(style.className).toContain('text-skip');
    expect(style.className).not.toContain('text-fail');
  });

  it('is off unless asked for — a tree that is 90% green has stopped saying anything', () => {
    const style = rowStyle({ lastResult: 'FAILED' });
    expect(style.reason).toBe('neutral');
    expect(style.className).toContain('text-ink-dim');
  });

  const tints: Array<[LastResultStatus, string]> = [
    ['PASSED', 'text-pass'],
    ['FAILED', 'text-fail'],
    ['TIMED_OUT', 'text-fail'],
    ['FLAKY', 'text-flake'],
  ];
  it.each(tints)('tints a %s row %s when the preference is on', (result, cls) => {
    const style = rowStyle({ tintByResult: true, lastResult: result });
    expect(style.reason).toBe('result');
    expect(style.className).toContain(cls);
  });

  it('degrades to neutral for a test that has never run, or was skipped', () => {
    for (const result of [null, undefined, 'SKIPPED' as const]) {
      const style = rowStyle({ tintByResult: true, lastResult: result });
      expect(style.reason).toBe('neutral');
      expect(style.className).toContain('text-ink-dim');
    }
  });

  it('reads folders as structure, and never tints them', () => {
    const style = rowStyle({ kind: 'dir', tintByResult: true, lastResult: 'FAILED' });
    expect(style.reason).toBe('neutral');
    expect(style.className).toContain('text-ink-faint');
    expect(style.className).not.toContain('text-fail');
  });

  it('still highlights the folder row when it is the active one', () => {
    expect(rowStyle({ kind: 'dir', active: true }).reason).toBe('active');
  });

  it('gives every row a hover state except the active one', () => {
    expect(rowStyle({}).className).toContain('hover:bg-surface-1');
    expect(rowStyle({ active: true }).className).not.toContain('hover:bg-surface-1');
  });

  it('emits exactly one text colour, so nothing fights in the cascade', () => {
    const inputs: RowStyleInput[] = [
      {},
      { active: true },
      { dirty: true },
      { quarantined: true },
      { kind: 'dir' },
      { tintByResult: true, lastResult: 'FAILED' },
      { tintByResult: true, lastResult: 'PASSED' },
    ];
    for (const input of inputs) {
      const classes = rowClassName(input).split(' ');
      expect(classes.filter((c) => c.startsWith('text-'))).toHaveLength(1);
      expect(rowClassName(input)).not.toMatch(NO_RAW_COLOUR);
    }
  });

  it('sets no size, weight or layout — the panel owns those', () => {
    for (const input of [{}, { active: true }, { dirty: true }, { kind: 'dir' as const }]) {
      expect(rowClassName(input)).not.toMatch(/\b(text-(row|micro|body-sm|meta)|font-|flex|gap-|p[xytblr]?-)/);
    }
  });

  /*
   * Written out, because `rowClassName` is DEFINED as `rowStyle(...).className`
   * — asserting the two are equal restates the definition and cannot fail. What
   * can fail is the string itself: a hover state, one text colour, and nothing
   * else, for a row whose result is deliberately being ignored.
   */
  it('rowClassName is the finished class string, ready to render', () => {
    const input: RowStyleInput = { dirty: true, tintByResult: true, lastResult: 'FLAKY' };
    expect(rowClassName(input)).toBe('hover:bg-surface-1 text-ink');
    expect(rowClassName({ active: true })).toBe('bg-surface-2 text-ink');
    expect(rowClassName({})).toBe('hover:bg-surface-1 text-ink-dim');
    expect(rowClassName({ kind: 'dir' })).toBe('hover:bg-surface-1 text-ink-faint');
    expect(rowClassName({ tintByResult: true, lastResult: 'FAILED' })).toBe(
      'hover:bg-surface-1 text-fail',
    );
  });

  /*
   * The drift guard. `LastResultStatus` is TEST_RESULT_STATUSES restated — the
   * web bundle cannot import that package — and a status the enum grows would
   * otherwise reach `RESULT_TINT` as an undefined lookup and paint nothing,
   * silently, on the rows that had just started failing in a new way.
   */
  it('knows every status the shared enum defines, and no others', () => {
    expect([...LAST_RESULT_STATUSES].sort()).toEqual([...TEST_RESULT_STATUSES].sort());
    for (const status of TEST_RESULT_STATUSES) {
      // Assignable without a cast, which is itself part of the guard: the day
      // the shared enum grows a member this file has no badge for, this line
      // stops compiling instead of painting nothing at runtime.
      const input: RowStyleInput = { tintByResult: true, lastResult: status };
      expect(['result', 'neutral']).toContain(rowStyle(input).reason);
      expect(classesOf(input).filter((c) => c.startsWith('text-'))).toHaveLength(1);
    }
  });
});
