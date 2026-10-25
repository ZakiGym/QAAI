import { describe, expect, it } from 'vitest';
import { dimensionDetailSchema, surfaceDimensionSchema, surfaceItemSchema } from './schemas';
import {
  DIMENSION_AXIS,
  DIMENSION_DETAIL_KINDS,
  NON_DENOMINATOR_EXERCISABILITIES,
  OBSERVED_SOURCES,
  SURFACE_DIMENSION_KINDS,
  SURFACE_EXERCISABILITIES,
  SURFACE_KINDS,
  SURFACE_SOURCES,
  type DimensionDetail,
  type SurfaceItemCoverage,
  type SurfaceKind,
  dimensionCellIdentity,
  dimensionDenominator,
  exercisabilityCounts,
  multiAxisDenominator,
  originFromSources,
  parseDimensionCellIdentity,
  surfaceKey,
  totalsForItems,
  totalsForKind,
} from './surface';

/**
 * The enumeration vocabularies, pinned at the words they were introduced with.
 *
 * Every one of these is STORED — `CoverageItem.sources`,
 * `CoverageItem.exercisability`, `SurfaceDimension.kind`, and the `key` column
 * that `dimensionCellIdentity` builds — so a member respelled in transit does
 * not fail to compile. It fails to match a row somebody already wrote, which is
 * silent and permanent. That is why these are literal lists rather than length
 * assertions: the assertion has to be the spelling.
 */
describe('the enumeration vocabularies', () => {
  it('keeps the eight declarers, in the order they are ranked by', () => {
    expect([...SURFACE_SOURCES]).toEqual([
      'CRAWL',
      'SOURCE',
      'SITEMAP',
      'OPENAPI',
      'TRAFFIC',
      'REQUIREMENT',
      'MANUAL',
      'CATALOGUE',
    ]);
  });

  it('treats exactly CRAWL and TRAFFIC as observations', () => {
    // The split `selectFlowMap` ranks on. Widening it would let a source-derived
    // map outrank a real crawl, which is the defect that made a FlowMap's
    // provenance a column in the first place.
    expect([...OBSERVED_SOURCES]).toEqual(['CRAWL', 'TRAFFIC']);
  });

  it('keeps the three exercisabilities and holds out exactly two', () => {
    expect([...SURFACE_EXERCISABILITIES]).toEqual(['EXERCISABLE', 'UNEXERCISABLE', 'REFUSED']);
    expect([...NON_DENOMINATOR_EXERCISABILITIES]).toEqual(['UNEXERCISABLE', 'REFUSED']);
    expect(NON_DENOMINATOR_EXERCISABILITIES).not.toContain('EXERCISABLE');
  });

  it('keeps the six dimensions', () => {
    expect([...SURFACE_DIMENSION_KINDS]).toEqual([
      'ROLE',
      'LOCALE',
      'DEVICE',
      'FLAG',
      'JOB',
      'EMAIL',
    ]);
  });

  it('lands every dimension on an axis SURFACE_KINDS already has', () => {
    // The reason this is an extension and not a fork. A dimension whose cells
    // landed on a thirteenth kind would be a second denominator, and two
    // denominators is two coverage numbers.
    for (const dimension of SURFACE_DIMENSION_KINDS) {
      expect(SURFACE_KINDS, dimension).toContain(DIMENSION_AXIS[dimension]);
    }
  });
});

/**
 * `origin` is derived from `sources` and must never be set beside it.
 *
 * Sixteen readers group and order by `CoverageItem.origin`. If a writer sets
 * both by hand they will eventually disagree about an item, and only one of the
 * two is on screen — so the screen would be confidently wrong with the right
 * answer sitting in the next column.
 */
describe('originFromSources', () => {
  it('returns null for an unrecorded declarer set, not a flattering guess', () => {
    // The state every row written before the column existed is in. BOTH would
    // claim the source declares it AND a crawl reached it; SOURCE_ONLY would
    // claim it is dark. Both are facts we would have invented.
    expect(originFromSources([])).toBeNull();
  });

  it('calls an observation-only item CRAWL_ONLY', () => {
    expect(originFromSources(['CRAWL'])).toBe('CRAWL_ONLY');
    expect(originFromSources(['TRAFFIC'])).toBe('CRAWL_ONLY');
  });

  it('calls a declaration-only item SOURCE_ONLY, including a hand entry', () => {
    expect(originFromSources(['SOURCE'])).toBe('SOURCE_ONLY');
    // The case the registry exists for: a background job nothing can crawl,
    // typed in by a human. SOURCE_ONLY is right — declared, never observed —
    // and it is the arm no runtime-only competitor can produce at all.
    expect(originFromSources(['MANUAL'])).toBe('SOURCE_ONLY');
    expect(originFromSources(['CATALOGUE', 'REQUIREMENT'])).toBe('SOURCE_ONLY');
  });

  it('calls a declared-and-observed item BOTH', () => {
    expect(originFromSources(['SOURCE', 'CRAWL'])).toBe('BOTH');
    expect(originFromSources(['OPENAPI', 'TRAFFIC'])).toBe('BOTH');
  });
});

// ─── Exercisability in the arithmetic ────────────────────────────────────────

function entry(
  over: Partial<SurfaceItemCoverage['item']> = {},
  status: 'COVERED' | 'UNCOVERED' | 'WAIVED' = 'UNCOVERED',
): SurfaceItemCoverage {
  return {
    item: {
      kind: 'ROUTE',
      key: surfaceKey('ROUTE', over.key ?? '/a'),
      label: '/a',
      file: null,
      line: null,
      origin: 'SOURCE_ONLY',
      evidence: 'test fixture',
      detector: null,
      ...over,
    },
    status,
    matches: [],
    verification: {
      lastRunId: null,
      lastStatus: null,
      executed: false,
      everPassed: false,
      mutationKilled: null,
    },
  };
}

describe('exercisabilityCounts', () => {
  it('counts an unclassified item', () => {
    /*
     * The migration-day defect. Every CoverageItem row that predates the column
     * has no exercisability, and reading "nobody classified it" as "we are not
     * allowed to touch it" would hold most of an existing install's denominator
     * out in one deploy. The percentage would jump and nothing anywhere would
     * explain why.
     */
    expect(exercisabilityCounts(undefined)).toBe(true);
    expect(exercisabilityCounts(null)).toBe(true);
  });

  it('counts EXERCISABLE and holds out the other two', () => {
    expect(exercisabilityCounts('EXERCISABLE')).toBe(true);
    expect(exercisabilityCounts('UNEXERCISABLE')).toBe(false);
    expect(exercisabilityCounts('REFUSED')).toBe(false);
  });
});

describe('totalsForKind holds out what it cannot drive, and names it', () => {
  it('keeps a held-out item in the inventory and out of the denominator', () => {
    const totals = totalsForKind('ROUTE', [
      entry({ key: surfaceKey('ROUTE', '/a') }, 'COVERED'),
      entry({ key: surfaceKey('ROUTE', '/b') }),
      entry({
        key: surfaceKey('ROUTE', '/logout'),
        exercise: { state: 'REFUSED', rule: 'excludeGlobs: /logout', detail: 'policy' },
      }),
      entry({
        key: surfaceKey('ROUTE', '/orders/:id/cancel'),
        exercise: {
          state: 'UNEXERCISABLE',
          reason: 'NEEDS_DISPOSABLE_DATA',
          detail: 'no disposable order',
        },
      }),
    ]);

    // Four items; two can be driven. The percentage is over the two, and the
    // other two are NAMED rather than dropped — the whole difference between
    // this and a vendor whose crawl quietly skipped them.
    expect(totals.denominator).toBe(2);
    expect(totals.covered).toBe(1);
    expect(totals.percent).toBe(50);
    expect(totals.refused).toBe(1);
    expect(totals.unexercisable).toBe(1);
  });

  it('never subtracts a waived-and-unexercisable item twice', () => {
    /*
     * Both exclusions apply to this one item. Subtracting it once per rule
     * would put the denominator BELOW the number of items it was derived from —
     * the kind of arithmetic a customer reproduces in a spreadsheet and never
     * trusts us again after.
     */
    const totals = totalsForKind('ROUTE', [
      entry({ key: surfaceKey('ROUTE', '/a') }, 'COVERED'),
      entry(
        {
          key: surfaceKey('ROUTE', '/wipe'),
          exercise: { state: 'UNEXERCISABLE', reason: 'DESTRUCTIVE', detail: 'wipes the tenant' },
        },
        'WAIVED',
      ),
    ]);
    expect(totals.denominator).toBe(1);
    expect(totals.waived).toBe(1);
    // Counted as waived, not also as unexercisable: the team's decision is the
    // one on screen, and double-reporting would make the two columns sum past
    // the item count.
    expect(totals.unexercisable).toBe(0);
  });

  it('reports a zero rather than omitting it when nothing is held out', () => {
    // 0 and absent are different facts about a measurement. This measurement
    // classified exercisability and found none held out; a snapshot from before
    // the column has `undefined`, and a reader must be able to tell.
    const totals = totalsForKind('ROUTE', [entry({}, 'COVERED')]);
    expect(totals.unexercisable).toBe(0);
    expect(totals.refused).toBe(0);
  });

  it('keeps an unmeasured axis that holds ONLY held-out items visible', () => {
    /*
     * The bug this filter clause fixes: an axis whose every item was refused
     * had denominator 0 and waived 0, so the old predicate dropped the row and
     * the report never mentioned the axis at all. The surfaces we cannot drive
     * are the ones most worth naming and they were the ones that disappeared.
     */
    const totals = totalsForItems([
      entry({
        kind: 'BACKGROUND_JOB' as SurfaceKind,
        key: surfaceKey('BACKGROUND_JOB', 'nightly-dunning'),
        exercise: {
          state: 'UNEXERCISABLE',
          reason: 'REAL_WORLD_SIDE_EFFECT',
          detail: 'charges real cards',
        },
      }),
    ]);
    expect(totals.byKind.map((row) => row.kind)).toContain('BACKGROUND_JOB');
    // ...and it contributes nothing to the headline, because the axis has no
    // extractor. "We do not measure jobs" is a fact about us; "0% of your jobs
    // are covered" would be a claim about them.
    expect(totals.percent).toBeNull();
    expect(totals.unexercisable).toBe(0);
  });
});

// ─── Cell identity ──────────────────────────────────────────────────────────

describe('dimensionCellIdentity', () => {
  it('sorts coordinates by declaration order, not by the order it was handed', () => {
    /*
     * Six writers mint these independently. If the key depended on argument
     * order, the locale sweep and the device sweep would produce two different
     * keys for the same cell and the diff against yesterday would show one
     * retired and one new, forever.
     */
    const a = dimensionCellIdentity('/checkout', [
      { dimension: 'LOCALE', value: 'pt-BR' },
      { dimension: 'DEVICE', value: 'iphone-15' },
    ]);
    const b = dimensionCellIdentity('/checkout', [
      { dimension: 'DEVICE', value: 'iphone-15' },
      { dimension: 'LOCALE', value: 'pt-BR' },
    ]);
    expect(a).toBe(b);
    // DEVICE precedes LOCALE? No — SURFACE_DIMENSION_KINDS puts LOCALE third
    // and DEVICE fourth, and THAT is the order, because declaration order in
    // surface.ts is fixed and alphabetical order of a customer's configuration
    // is not.
    expect(a).toBe('/checkout|LOCALE=pt-BR|DEVICE=iphone-15');
  });

  it('keeps the application’s own case', () => {
    // A role the app calls `Admin` and one it calls `admin` are two roles until
    // the customer says otherwise. Folding them here merges two cells and
    // shrinks a denominator with nothing to show for it.
    expect(dimensionCellIdentity('/admin', [{ dimension: 'ROLE', value: 'Admin' }])).not.toBe(
      dimensionCellIdentity('/admin', [{ dimension: 'ROLE', value: 'admin' }]),
    );
  });

  it('refuses two coordinates on one dimension', () => {
    // Two locales is two cells. Keeping the last silently would merge a cell
    // into its neighbour and lose one from the denominator.
    expect(() =>
      dimensionCellIdentity('/x', [
        { dimension: 'LOCALE', value: 'en' },
        { dimension: 'LOCALE', value: 'fr' },
      ]),
    ).toThrow(/two LOCALE coordinates/);
  });

  it('round-trips a value containing the reserved characters', () => {
    // A locale called `a=b|c` must not be able to forge a second coordinate.
    const identity = dimensionCellIdentity('/a|b', [{ dimension: 'FLAG', value: 'a=b|c%d' }]);
    expect(parseDimensionCellIdentity(identity)).toEqual({
      base: '/a|b',
      coordinates: [{ dimension: 'FLAG', value: 'a=b|c%d' }],
    });
  });

  it('parses nothing out of a key that is not one of ours', () => {
    expect(parseDimensionCellIdentity('')).toBeNull();
    expect(parseDimensionCellIdentity('/a|NOPE=1')).toBeNull();
    expect(parseDimensionCellIdentity('/a|ROLE=')).toBeNull();
    expect(parseDimensionCellIdentity('/a|ROLE')).toBeNull();
  });
});

// ─── The multi-axis denominator ─────────────────────────────────────────────

describe('dimensionDenominator counts declared pairings, never a product', () => {
  const base = ['/admin/billing', '/admin/users', '/pricing', '/about'];
  const roles = ['ADMIN', 'VIEWER', 'SUPPORT', 'anonymous'];

  function run(declared: Array<[string, string[]]>) {
    return dimensionDenominator({
      dimension: 'ROLE',
      baseKeys: base,
      values: roles,
      defaultValue: 'anonymous',
      declared: new Map(declared),
    });
  }

  it('counts one cell per declared pairing and one per undeclared base', () => {
    const result = run([
      ['/admin/billing', ['ADMIN', 'VIEWER']],
      ['/admin/users', ['ADMIN']],
    ]);
    expect(result.declaredCells).toBe(3);
    // /pricing and /about declare nothing, so one default cell each.
    expect(result.defaultCells).toBe(2);
    expect(result.cells).toBe(5);
    expect(result.pairedBases).toBe(2);
    expect(result.unpairedBases).toBe(2);
  });

  it('reports the cross product it refused to use', () => {
    const result = run([['/admin/billing', ['ADMIN']]]);
    // 4 bases × 4 roles. Printing 16 as a denominator would assert that every
    // role is meaningful on every route, which no declarer has said.
    expect(result.crossProduct).toBe(16);
    expect(result.cells).toBeLessThan(result.crossProduct);
    expect(result.rule).toContain('4 × 4 = 16');
    expect(result.rule).toContain('not what was counted');
  });

  it('never exceeds the cross product, even on a dangling declaration', () => {
    /*
     * The invariant a reader checks by eye, and the filter that keeps it true.
     * A declaration naming a role no row holds is a dangling reference in OUR
     * extractor; counting it would push the denominator above an arithmetic
     * ceiling and hide our own error rate behind a bigger number.
     */
    const result = run([['/pricing', ['GHOST', 'ADMIN']]]);
    expect(result.undeclaredValues).toEqual(['GHOST']);
    expect(result.declaredCells).toBe(1);
    expect(result.cells).toBeLessThanOrEqual(result.crossProduct);
  });

  it('names the values nothing declares — the finding, not the number', () => {
    const result = run([
      ['/admin/billing', ['ADMIN', 'VIEWER']],
      ['/admin/users', ['ADMIN']],
    ]);
    // "No route anywhere declares the SUPPORT role" is the sentence a customer
    // forwards. It is only computable because the roles are rows.
    expect(result.unpairedValues).toEqual(['SUPPORT']);
  });

  it('adds no cell at all when the project has not said what its default is', () => {
    // Inventing a default would be inventing a measurement: we would be
    // counting a cell at a value the customer never declared.
    const result = dimensionDenominator({
      dimension: 'FLAG',
      baseKeys: base,
      values: ['on', 'off'],
      defaultValue: null,
      declared: new Map(),
    });
    expect(result.defaultCells).toBe(0);
    expect(result.cells).toBe(0);
  });

  it('counts a repeated value once', () => {
    const result = run([['/admin/billing', ['ADMIN', 'ADMIN']]]);
    expect(result.declaredCells).toBe(1);
  });
});

describe('multiAxisDenominator sums the dimensions', () => {
  it('adds and does not multiply', () => {
    const roles = dimensionDenominator({
      dimension: 'ROLE',
      baseKeys: ['/a', '/b'],
      values: ['ADMIN', 'VIEWER'],
      defaultValue: null,
      declared: new Map([
        ['/a', ['ADMIN', 'VIEWER']],
        ['/b', ['ADMIN']],
      ]),
    });
    const locales = dimensionDenominator({
      dimension: 'LOCALE',
      baseKeys: ['/a', '/b'],
      values: ['en', 'pt-BR'],
      defaultValue: null,
      declared: new Map([['/a', ['en', 'pt-BR']]]),
    });

    const total = multiAxisDenominator([roles, locales]);
    // 3 role cells + 2 locale cells. Five things to test — not six, which is
    // what 3 × 2 would claim, and which would assert that role and locale
    // interact on every route when no declarer said so.
    expect(total.cells).toBe(5);
    expect(total.cells).toBe(roles.cells + locales.cells);
    expect(total.rule).toContain('never multiplied');
  });

  it('is zero over no dimensions, and says so without dividing', () => {
    const total = multiAxisDenominator([]);
    expect(total.cells).toBe(0);
    expect(total.crossProduct).toBe(0);
  });
});

// ─── The write path ─────────────────────────────────────────────────────────

/**
 * The zod ⇄ union parity assertion, copied from the `GateRule` guard.
 *
 * `dimensionDetailSchema` is the only write path to `SurfaceDimension.detail`.
 * Eight `GateRule` kinds existed in the TypeScript union and not in
 * `gateRuleSchema` for two slices, so no customer could save one — the features
 * were reachable only by hand-editing a database row, and `check:wiring` cannot
 * see it because a union member with no write path is live code in a reached
 * file. Two mechanisms, because each catches what the other cannot: the
 * compiler enforces `DIMENSION_DETAIL_KINDS` against the union, and this test
 * enforces zod's options against that list at run time.
 */
function zodDimensionKinds(): string[] {
  return dimensionDetailSchema.options.map((option) => option.shape.dimension.value as string);
}

describe('dimensionDetailSchema ⇄ DimensionDetail parity', () => {
  it('has one arm for every dimension the union names, and no others', () => {
    expect(zodDimensionKinds().slice().sort()).toEqual([...DIMENSION_DETAIL_KINDS].sort());
  });

  it('names every dimension in the kind vocabulary', () => {
    // The third list. SURFACE_DIMENSION_KINDS is what a `kind` column may hold;
    // a dimension that can be stored and whose detail cannot be written is a
    // row no reader can render.
    expect([...DIMENSION_DETAIL_KINDS].sort()).toEqual([...SURFACE_DIMENSION_KINDS].sort());
  });

  it('refuses a dimension the union does not have', () => {
    expect(dimensionDetailSchema.safeParse({ dimension: 'BROWSER', name: 'x' }).success).toBe(
      false,
    );
  });
});

const ACCEPTED_DETAILS: readonly DimensionDetail[] = [
  { dimension: 'ROLE', privileged: true, inheritsFrom: null },
  { dimension: 'LOCALE', tag: 'pt-BR', rtl: false },
  { dimension: 'DEVICE', widthPx: 393, heightPx: 852, touch: true, descriptor: 'iPhone 15' },
  { dimension: 'FLAG', variants: ['on', 'off'], defaultVariant: 'off', provider: 'table' },
  { dimension: 'JOB', trigger: 'CRON', schedule: '0 3 * * *', publiclyTriggerable: false },
  { dimension: 'EMAIL', templateId: 'welcome', sentBy: 'signup', transactional: true },
];

describe('dimensionDetailSchema accepts every arm', () => {
  it('covers every kind, so the list cannot go stale', () => {
    // The parity test above proves an ARM exists; it cannot prove the arm
    // accepts the shape the union declares. A DEVICE arm that required `width`
    // would satisfy parity and refuse every row a client sends.
    expect(ACCEPTED_DETAILS.map((detail) => detail.dimension).sort()).toEqual(
      [...DIMENSION_DETAIL_KINDS].sort(),
    );
  });

  it.each(ACCEPTED_DETAILS.map((detail) => [detail.dimension, detail] as const))(
    'accepts %s',
    (_dimension, detail) => {
      expect(dimensionDetailSchema.safeParse(detail).success).toBe(true);
    },
  );

  it('refuses a flag with one variant', () => {
    // A flag with one variant changes nothing, so it is not a dimension — it is
    // a constant, and counting it adds cells that cannot differ.
    expect(
      dimensionDetailSchema.safeParse({
        dimension: 'FLAG',
        variants: ['on'],
        defaultVariant: 'on',
        provider: null,
      }).success,
    ).toBe(false);
  });
});

describe('surfaceDimensionSchema', () => {
  const row = {
    kind: 'LOCALE',
    key: 'pt-BR',
    label: 'Portuguese (Brazil)',
    source: 'CATALOGUE',
    evidence: 'messages/pt-BR.json',
    detail: { dimension: 'LOCALE', tag: 'pt-BR', rtl: false },
  };

  it('accepts a row and defaults isDefault/available', () => {
    const parsed = surfaceDimensionSchema.parse(row);
    expect(parsed.isDefault).toBe(false);
    expect(parsed.available).toBe(true);
  });

  it('refuses a row whose kind and detail disagree', () => {
    // Prisma stores the enum and the JSON independently, so nothing else in the
    // stack would catch a LOCALE row carrying DEVICE detail — and no cell
    // identity could be built from it.
    expect(
      surfaceDimensionSchema.safeParse({
        ...row,
        detail: { dimension: 'DEVICE', widthPx: 393, heightPx: 852, touch: true, descriptor: null },
      }).success,
    ).toBe(false);
  });

  it('refuses a flag whose default is not one of its variants', () => {
    expect(
      surfaceDimensionSchema.safeParse({
        kind: 'FLAG',
        key: 'new-checkout',
        label: 'New checkout',
        source: 'CATALOGUE',
        evidence: 'flags table',
        detail: {
          dimension: 'FLAG',
          variants: ['on', 'off'],
          defaultVariant: 'maybe',
          provider: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe('surfaceItemSchema', () => {
  const item = {
    kind: 'BACKGROUND_JOB',
    key: 'BACKGROUND_JOB:nightly-dunning',
    label: 'nightly-dunning',
    sources: ['CATALOGUE'],
    evidence: 'jobs/registry.ts — queue consumer',
  };

  it('accepts a hand-declared surface nothing can crawl', () => {
    // The whole point of the registry. Before this, a job had no row to be in,
    // so it was ABSENT from the denominator rather than uncovered in it.
    const parsed = surfaceItemSchema.parse(item);
    expect(parsed.exercise).toBeNull();
    expect(parsed.environmentId).toBeNull();
    expect(parsed.coordinates).toEqual([]);
  });

  it('refuses an item no declarer claims', () => {
    // An item with no declarer has no business in a denominator, and this
    // schema is the only validator between a manual entry form and the row.
    expect(surfaceItemSchema.safeParse({ ...item, sources: [] }).success).toBe(false);
  });

  it('refuses an UNEXERCISABLE with no reason and a REFUSED with no rule', () => {
    /*
     * "Needs disposable data" is a remedy a customer can act on; a shrug is
     * not. And "excluded by policy" with no rule named is indistinguishable
     * from a bug in our crawler, whose only possible remedy is to distrust the
     * number.
     */
    expect(
      surfaceItemSchema.safeParse({
        ...item,
        exercise: { state: 'UNEXERCISABLE', detail: 'cannot' },
      }).success,
    ).toBe(false);
    expect(
      surfaceItemSchema.safeParse({ ...item, exercise: { state: 'REFUSED', detail: 'nope' } })
        .success,
    ).toBe(false);
    expect(
      surfaceItemSchema.safeParse({
        ...item,
        exercise: {
          state: 'REFUSED',
          rule: 'excludeGlobs: /logout',
          detail: 'session-ending',
        },
      }).success,
    ).toBe(true);
  });
});
