/**
 * WHETHER A BREAKDOWN CAN BE TRUSTED, AND WHETHER UNOWNED SURFACE SURVIVES IT.
 *
 * Four questions, and the first one is the reason this file exists:
 *
 *   1. IS A BUCKET'S PERCENTAGE ITS OWN? The fixture below is built so that the
 *      MEAN of two features (50%) and the POOLED figure (25%) differ, because
 *      averaging buckets to make a parent is the mistake that looks right in
 *      review and is wrong by a factor of two in production.
 *   2. DOES UNOWNED SURFACE GET A NAMED BUCKET AND A SENTENCE, rather than
 *      being distributed among the teams that do own things or dropped?
 *   3. DO THE PARTS RECONSTRUCT THE WHOLE, and when they cannot, does the row
 *      say which items were excluded and why?
 *   4. IS EVERY ROW STORABLE? `coverageRollupSchema` is the API's door and it
 *      refuses a `scopeKey` that disagrees with its own columns, so parsing
 *      every row through it is the cheapest proof that this module's output can
 *      actually be written rather than only computed.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_TIERS,
  DIMENSION_UNMEASURED_REASONS,
  HEADLINE_SCOPE_KEY,
  UNATTRIBUTED_FEATURE,
  UNOWNED_TEAM,
  coverageRollupSchema,
  parseRollupScopeKey,
} from '@qaai/shared';
import type { CoverageTier, DimensionUnmeasuredReason } from '@qaai/shared';
import {
  MAX_ROLLUP_CAPS,
  MAX_ROLLUP_EXCLUSIONS,
  MAX_ROLLUP_ROWS,
  dominantRollupReason,
  rollupCoverage,
  unmeasuredSentence,
  type RollupItem,
} from './coverage-rollup.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const cell = (key: string, over: Partial<RollupItem> = {}): RollupItem => ({
  key,
  dimension: 'PAGE_STATE',
  tier: null,
  feature: null,
  teamId: null,
  excluded: null,
  ...over,
});

/**
 * One cell at PASSING under `payments`, three unclaimed under `search`.
 *
 * The mean of the two features at the PASSING rung is (100 + 0) / 2 = 50. The
 * pooled figure is 1 / 4 = 25. Any implementation that averages buckets to make
 * the headline reports 50, and this fixture is the only reason that mistake
 * cannot ship.
 */
const simpson: RollupItem[] = [
  cell('PAGE:/pay|one', { feature: 'payments', teamId: 't_billing', tier: 'PASSING' }),
  cell('PAGE:/search|one', { feature: 'search', teamId: 't_core' }),
  cell('PAGE:/search|two', { feature: 'search', teamId: 't_core' }),
  cell('PAGE:/search|three', { feature: 'search', teamId: 't_core' }),
];

const rowFor = (
  rows: ReturnType<typeof rollupCoverage>['rows'],
  scopeKey: string,
): (typeof rows)[number] => {
  const found = rows.find((row) => row.scopeKey === scopeKey);
  if (found === undefined) throw new Error(`no row with scopeKey ${scopeKey}`);
  return found;
};

// ─── 1. A bucket's percentage is its own ────────────────────────────────────

describe('rollupCoverage arithmetic', () => {
  it('pools the headline from its own cells rather than averaging the buckets', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: simpson });

    // 1 of 4, not the 50% that averaging 100% and 0% would produce.
    expect(result.headline.numerator).toBe(1);
    expect(result.headline.denominator).toBe(4);
    expect(result.headline.percent).toBe(25);
    expect(result.headline.scopeKey).toBe('DIM=PAGE_STATE');
  });

  it('computes each feature from its own numerator and denominator', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: simpson });

    const payments = rowFor(result.rows, 'DIM=PAGE_STATE|FEATURE=payments');
    expect([payments.numerator, payments.denominator, payments.percent]).toEqual([1, 1, 100]);

    const search = rowFor(result.rows, 'DIM=PAGE_STATE|FEATURE=search');
    expect([search.numerator, search.denominator, search.percent]).toEqual([0, 3, 0]);
  });

  it('reads the rung it was given, so the same cells give two different figures', () => {
    const items = [
      cell('a', { tier: 'NAVIGATED' }),
      cell('b', { tier: 'PASSING' }),
      cell('c', { tier: null }),
    ];
    const navigated = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'NAVIGATED', items });
    const passing = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });

    expect(navigated.headline.percent).toBe(66.7);
    expect(passing.headline.percent).toBe(33.3);
    expect(navigated.headline.tier).toBe('NAVIGATED');
    expect(passing.headline.tier).toBe('PASSING');
  });

  it('never puts more in a numerator than its own denominator holds', () => {
    for (const tier of COVERAGE_TIERS) {
      const result = rollupCoverage({ dimension: 'PAGE_STATE', tier, items: simpson });
      for (const row of result.rows) {
        expect(row.numerator).toBeLessThanOrEqual(row.denominator);
      }
    }
  });

  it('reports NULL and not 0 when a bucket has an empty denominator', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: [] });
    expect(result.headline.denominator).toBe(0);
    expect(result.headline.percent).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.scopeKey).toBe('DIM=PAGE_STATE');
  });

  it('builds the HEADLINE scope key for a rollup across every dimension', () => {
    const result = rollupCoverage({
      dimension: null,
      tier: 'NAVIGATED',
      items: [cell('ROUTE:/a', { dimension: null, tier: 'NAVIGATED' })],
    });
    expect(result.headline.scopeKey).toBe(HEADLINE_SCOPE_KEY);
    expect(parseRollupScopeKey(result.headline.scopeKey)).toEqual({
      dimension: null,
      feature: null,
      teamId: null,
    });
  });
});

// ─── 2. Unowned surface is a finding ────────────────────────────────────────

describe('attribution', () => {
  it('names the unowned bucket rather than distributing or dropping it', () => {
    const items = [
      cell('a', { feature: 'payments', teamId: 't_billing', tier: 'PASSING' }),
      cell('b'),
      cell('c'),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });

    const unowned = rowFor(result.rows, `DIM=PAGE_STATE|TEAM=${UNOWNED_TEAM}`);
    expect(unowned.denominator).toBe(2);
    const unattributed = rowFor(result.rows, `DIM=PAGE_STATE|FEATURE=${UNATTRIBUTED_FEATURE}`);
    expect(unattributed.denominator).toBe(2);

    // The sentence this module exists to produce.
    expect(result.attribution.unownedTeam).toBe(2);
    expect(result.attribution.unownedPercent).toBe(66.7);
    expect(result.attribution.sentence).toContain('66.7% of the surface has no owner');
  });

  it('says nothing was in scope rather than "0% owned" for an empty rollup', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: [] });
    expect(result.attribution.unownedPercent).toBeNull();
    expect(result.attribution.unattributedPercent).toBeNull();
    expect(result.attribution.sentence).toContain('nothing was in scope');
    /*
     * The sentence says "not 0% owned" on purpose, so the check is that it
     * makes no CLAIM about a share — an empty scope must not produce the
     * "N% of the surface has no owner" phrasing at any value.
     */
    expect(result.attribution.sentence).not.toMatch(/\d+% of the surface/);
  });

  it('states plainly when everything is attributed', () => {
    const result = rollupCoverage({
      dimension: 'PAGE_STATE',
      tier: 'PASSING',
      items: [cell('a', { feature: 'f', teamId: 't' })],
    });
    expect(result.attribution.sentence).toContain('carries a feature and an owning team');
    expect(result.attribution.collidedWithSentinel).toEqual([]);
  });

  it('takes the shares over the denominator, not over the excluded rows as well', () => {
    const items = [
      cell('a', { feature: 'f', teamId: 't' }),
      cell('b', { excluded: { reason: 'HELD_OUT', detail: 'waived by owner@example.com' } }),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });
    // The excluded cell has no owner, and it is not part of the surface either.
    expect(result.attribution.surface).toBe(1);
    expect(result.attribution.unownedTeam).toBe(0);
  });

  it('discloses a customer value spelled exactly like a sentinel bucket', () => {
    const result = rollupCoverage({
      dimension: 'PAGE_STATE',
      tier: 'PASSING',
      items: [cell('a', { feature: UNATTRIBUTED_FEATURE, teamId: 't' }), cell('b')],
    });
    expect(result.attribution.collidedWithSentinel).toEqual([`feature ${UNATTRIBUTED_FEATURE}`]);
    expect(result.attribution.sentence).toContain('spelled exactly like the');
    // The COUNT is still taken from `feature === null`, so the finding stays true.
    expect(result.attribution.unattributedFeature).toBe(1);
  });
});

// ─── 3. The parts, the whole, and what left ─────────────────────────────────

describe('reconciliation', () => {
  it('shows both partitions adding back to the whole', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: simpson });
    expect(result.reconciliation.whole).toBe(4);
    expect(result.reconciliation.featurePartsSum).toBe(4);
    expect(result.reconciliation.teamPartsSum).toBe(4);
    expect(result.reconciliation.reconciles).toBe(true);
    expect(result.reconciliation.detail).toContain('add back to');
  });

  it('still reconciles when some cells are unattributed, because they get a bucket', () => {
    const items = [
      cell('a', { feature: 'payments', teamId: 't_billing', tier: 'PASSING' }),
      cell('b'),
      cell('c', { teamId: 't_core' }),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });
    // Dropping the UNATTRIBUTED and UNOWNED buckets — the tempting shortcut —
    // would leave both sums short of the whole.
    expect(result.reconciliation.whole).toBe(3);
    expect(result.reconciliation.featurePartsSum).toBe(3);
    expect(result.reconciliation.teamPartsSum).toBe(3);
    expect(result.reconciliation.reconciles).toBe(true);
  });

  it('still reconciles when cells left the denominator, and says which and why', () => {
    const items = [
      cell('a', { feature: 'f', teamId: 't', tier: 'PASSING' }),
      cell('b', {
        feature: 'f',
        teamId: 't',
        excluded: { reason: 'HELD_OUT', detail: 'UNEXERCISABLE — destroys the workspace' },
      }),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });

    expect(result.headline.denominator).toBe(1);
    expect(result.headline.unmeasured).toBe(1);
    expect(result.headline.unmeasuredReason).toBe('HELD_OUT');
    expect(result.headline.exclusions).toEqual(['b: UNEXERCISABLE — destroys the workspace']);
    expect(result.reconciliation.reconciles).toBe(true);
    expect(result.reconciliation.detail).toContain('left every denominator');
  });

  it('keeps a bucket whose every cell left, with a null percent and a reason', () => {
    const items = [
      cell('a', {
        feature: 'legacy',
        excluded: { reason: 'HELD_OUT', detail: 'waived until 2027' },
      }),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });
    const legacy = rowFor(result.rows, 'DIM=PAGE_STATE|FEATURE=legacy');
    expect(legacy.denominator).toBe(0);
    expect(legacy.percent).toBeNull();
    expect(legacy.unmeasured).toBe(1);
    expect(legacy.unmeasuredDetail).toContain('held out');
  });
});

// ─── The refusals ───────────────────────────────────────────────────────────

describe('refusals', () => {
  it('refuses a cell from another dimension, so two denominators cannot be summed', () => {
    expect(() =>
      rollupCoverage({
        dimension: 'PAGE_STATE',
        tier: 'PASSING',
        items: [cell('a'), cell('b', { dimension: 'FORM_FIELD' })],
      }),
    ).toThrow(/two denominators in one percentage/);
  });

  it('refuses an item-axis cell in a dimension rollup', () => {
    expect(() =>
      rollupCoverage({
        dimension: 'PAGE_STATE',
        tier: 'PASSING',
        items: [cell('a', { dimension: null })],
      }),
    ).toThrow(/item-axis cell/);
  });

  it('refuses a duplicate key, which would inflate both halves of the fraction', () => {
    expect(() =>
      rollupCoverage({
        dimension: 'PAGE_STATE',
        tier: 'PASSING',
        items: [cell('a'), cell('a')],
      }),
    ).toThrow(/one cell counted twice/);
  });

  it('refuses an exclusion with no sentence', () => {
    expect(() =>
      rollupCoverage({
        dimension: 'PAGE_STATE',
        tier: 'PASSING',
        items: [cell('a', { excluded: { reason: 'HELD_OUT', detail: '' } })],
      }),
    ).toThrow(/no sentence explaining it/);
  });
});

// ─── Why cells are unmeasured, when several reasons apply ───────────────────

describe('dominantRollupReason', () => {
  const counts = (entries: Array<[DimensionUnmeasuredReason, number]>) => new Map(entries);

  it('returns null for a bucket with nothing unmeasured', () => {
    expect(dominantRollupReason(counts([]))).toBeNull();
    expect(unmeasuredSentence(counts([]))).toBeNull();
  });

  it('lets the biggest group win, not the first one encountered', () => {
    expect(
      dominantRollupReason(
        counts([
          ['HELD_OUT', 3],
          ['CAP_BIT', 12],
        ]),
      ),
    ).toBe('CAP_BIT');
  });

  it('breaks a tie by the keystone declaration order and not by insertion order', () => {
    const insertedLateFirst = counts([
      ['HELD_OUT', 2],
      ['NO_EXTRACTOR', 2],
    ]);
    // NO_EXTRACTOR is declared first in DIMENSION_UNMEASURED_REASONS.
    expect(DIMENSION_UNMEASURED_REASONS.indexOf('NO_EXTRACTOR')).toBeLessThan(
      DIMENSION_UNMEASURED_REASONS.indexOf('HELD_OUT'),
    );
    expect(dominantRollupReason(insertedLateFirst)).toBe('NO_EXTRACTOR');
  });

  it('names EVERY group in the sentence, so the losing groups are not invisible', () => {
    const sentence = unmeasuredSentence(
      counts([
        ['CAP_BIT', 12],
        ['HELD_OUT', 3],
      ]),
    );
    expect(sentence).toContain('12 —');
    expect(sentence).toContain('3 —');
  });

  it('fits inside the 500 characters the stored column allows with all five groups', () => {
    const all = new Map(DIMENSION_UNMEASURED_REASONS.map((reason) => [reason, 7] as const));
    const sentence = unmeasuredSentence(all);
    expect(sentence).not.toBeNull();
    expect((sentence ?? '').length).toBeLessThanOrEqual(500);
    for (const reason of DIMENSION_UNMEASURED_REASONS) {
      expect(dominantRollupReason(all)).not.toBeNull();
      expect(sentence).toContain(reason === 'CAP_BIT' ? 'a cap stopped' : '7 —');
    }
  });
});

// ─── The caps, each disclosed as a count and a reason ───────────────────────

describe('caps', () => {
  it('lists at most MAX_ROLLUP_EXCLUSIONS sentences and says how many it did not', () => {
    const items = Array.from({ length: MAX_ROLLUP_EXCLUSIONS + 3 }, (_, index) =>
      cell(`c${index}`, { excluded: { reason: 'HELD_OUT', detail: 'waived' } }),
    );
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });

    expect(result.headline.exclusions).toHaveLength(MAX_ROLLUP_EXCLUSIONS);
    expect(result.headline.unmeasured).toBe(MAX_ROLLUP_EXCLUSIONS + 3);
    const bite = result.headline.caps.find((entry) => entry.cap === 'rollupExclusions');
    expect(bite?.atLeastMore).toBe(3);
  });

  it('keeps the headline and discloses the buckets the row cap dropped', () => {
    const items = Array.from({ length: MAX_ROLLUP_ROWS + 50 }, (_, index) =>
      cell(`c${index}`, { feature: `f${index}`, teamId: `t${index}` }),
    );
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });

    expect(result.rows).toHaveLength(MAX_ROLLUP_ROWS);
    expect(result.rows[0]?.scopeKey).toBe('DIM=PAGE_STATE');
    expect(result.reconciliation.rowsDropped).toBeGreaterThan(0);
    const bite = result.headline.caps.find((entry) => entry.cap === 'rollupRows');
    expect(bite?.atLeastMore).toBe(result.reconciliation.rowsDropped);
    // The arithmetic still reconciles: the cap is about what was SHOWN.
    expect(result.reconciliation.reconciles).toBe(true);
    expect(result.reconciliation.detail).toContain('dropped by the row cap');
  });

  it('carries an upstream cap bite onto every row rather than dropping it', () => {
    const result = rollupCoverage({
      dimension: 'PAGE_STATE',
      tier: 'PASSING',
      items: simpson,
      caps: [
        { cap: 'pageBudget', limit: 1_000, atLeastMore: null, detail: 'the crawl stopped early' },
      ],
    });
    for (const row of result.rows) {
      expect(row.caps.some((entry) => entry.cap === 'pageBudget')).toBe(true);
    }
  });

  it('says how many cap bites it could not carry rather than silently truncating', () => {
    const many = Array.from({ length: MAX_ROLLUP_CAPS + 4 }, (_, index) => ({
      cap: `cap${index}`,
      limit: index,
      atLeastMore: null,
      detail: 'bit',
    }));
    const result = rollupCoverage({
      dimension: 'PAGE_STATE',
      tier: 'PASSING',
      items: simpson,
      caps: many,
    });
    expect(result.headline.caps).toHaveLength(MAX_ROLLUP_CAPS);
    const bite = result.headline.caps.find((entry) => entry.cap === 'rollupCaps');
    expect(bite?.atLeastMore).toBe(5);
  });
});

// ─── 4. Every row is storable ───────────────────────────────────────────────

describe('the write path', () => {
  it('produces rows coverageRollupSchema accepts, scopeKey refinement included', () => {
    const items = [
      ...simpson,
      cell('held', {
        feature: 'legacy',
        teamId: 't_core',
        excluded: { reason: 'HELD_OUT', detail: 'waived by owner@example.com until 2027' },
      }),
    ];
    const result = rollupCoverage({
      dimension: 'PAGE_STATE',
      tier: 'PASSING',
      items,
      caps: [{ cap: 'maxFields', limit: 200, atLeastMore: 40, detail: 'at least 40 more' }],
    });

    expect(result.rows.length).toBeGreaterThan(4);
    for (const row of result.rows) {
      const parsed = coverageRollupSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(`${row.scopeKey} was refused: ${parsed.error.issues[0]?.message ?? ''}`);
      }
    }
  });

  it('round-trips every scope key through the shared parser', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: simpson });
    for (const row of result.rows) {
      expect(parseRollupScopeKey(row.scopeKey)).toEqual({
        dimension: row.dimension,
        feature: row.feature,
        teamId: row.teamId,
      });
    }
  });

  it('emits a pair row only for pairs that actually occur, never the cross product', () => {
    const items = [
      cell('a', { feature: 'payments', teamId: 't_billing' }),
      cell('b', { feature: 'search', teamId: 't_core' }),
    ];
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items });
    const pairs = result.rows.filter((row) => row.feature !== null && row.teamId !== null);
    // Two observed pairs, not the four a cross product would assert.
    expect(pairs).toHaveLength(2);
    expect(pairs.map((row) => row.scopeKey).sort()).toEqual([
      'DIM=PAGE_STATE|FEATURE=payments|TEAM=t_billing',
      'DIM=PAGE_STATE|FEATURE=search|TEAM=t_core',
    ]);
  });

  it('orders the buckets by denominator so the cap keeps the ones worth acting on', () => {
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier: 'PASSING', items: simpson });
    const buckets = result.rows.slice(1);
    const denominators = buckets.map((row) => row.denominator);
    expect(denominators).toEqual([...denominators].sort((left, right) => right - left));
  });

  it('stamps the rung on every row, so two rows cannot silently be at two bars', () => {
    const tier: CoverageTier = 'FRESH';
    const result = rollupCoverage({ dimension: 'PAGE_STATE', tier, items: simpson });
    for (const row of result.rows) expect(row.tier).toBe(tier);
  });
});
