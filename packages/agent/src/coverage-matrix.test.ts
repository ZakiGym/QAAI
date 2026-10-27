/**
 * Tests for the three matrix dimensions.
 *
 * Every test below is one way this module could report something nobody
 * measured, because on these three axes that is the only failure mode that
 * matters. A matrix that is merely incomplete is the product working; a matrix
 * that credits an E2E obligation to a performance test, or a de-DE cell to a
 * run that never left en-US, is a coverage number built out of nothing.
 *
 *   - a PERFORMANCE test satisfying an ACCESSIBILITY obligation, which is the
 *     single-boolean defect this module exists to end
 *   - an obligation nobody declared being minted anyway, which turns QAAI's
 *     opinion about what a team should test into the team's debt
 *   - an axis with nothing enumerated rendering as 0% instead of as unmeasured
 *   - an empty denominator rendering as 0% or 100% instead of as null
 *   - a test type this deployment cannot execute being scored, which puts a
 *     test that can never fail inside a percentage
 *   - a waived or undrivable item being silently dropped rather than held out
 *     with a reason
 *   - a rung above DECLARED with no run behind it
 *   - the cross product being used as a denominator, on either multi-axis
 *     dimension
 *   - a worst-wins `TestResult` promoting a device or locale cell it never ran
 *   - an `<unvaried>` row being credited to the project's default cell
 *   - a cell held out for a reason nobody can read, or held out for one reason
 *     when several applied
 *   - a cap that bit without being disclosed as a count AND a reason
 *   - two combinations sharing one cell because a flag key forged a separator
 *   - three denominators being added together to make one percentage
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_DIMENSIONS,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIERS,
  DIMENSION_UNMEASURED_REASON_LABELS,
  dimensionMeasurementSchema,
  dimensionPercentAt,
  dimensionWasMeasured,
  parseDimensionCellIdentity,
  parseSurfaceKey,
  surfaceKey,
  type DimensionMeasurement,
  type DimensionUnmeasuredReason,
  type TestType,
} from '@qaai/shared';
import {
  MATRIX_DIMENSIONS,
  MAX_REPORTED_COMBINATION_SPACE,
  buildCoverageMatrix,
  buildDeviceLocaleMatrix,
  buildFlagCombinationMatrix,
  buildTypeObligationMatrix,
  dominantUnmeasuredReason,
  flagCombinationKey,
  parseFlagCombinationKey,
  resolveTypeObligations,
  type DeclaredTypeObligation,
  type DeviceLocaleValue,
  type FlagCombinationDeclaration,
  type ObligationSubject,
  type TypedCoverageEdge,
  type VariantCellObservation,
} from './coverage-matrix.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AT = '2026-10-24T10:00:00.000Z';
const NOW = '2026-10-24T12:00:00.000Z';
/** Older than the 7-day default freshness window, so PASSING and not FRESH. */
const LONG_AGO = '2026-09-01T10:00:00.000Z';

function route(path: string, overrides: Partial<ObligationSubject> = {}): ObligationSubject {
  return { key: surfaceKey('ROUTE', path), kind: 'ROUTE', ...overrides };
}

function owes(
  itemKey: string,
  testType: TestType,
  overrides: Partial<DeclaredTypeObligation> = {},
): DeclaredTypeObligation {
  return {
    itemKey,
    testType,
    declaredBy: 'REQUIREMENT',
    evidence: `AC-1 says a ${testType} test is required here`,
    ...overrides,
  };
}

function edge(
  itemKey: string,
  testType: TestType,
  overrides: Partial<TypedCoverageEdge> = {},
): TypedCoverageEdge {
  return {
    itemKey,
    testId: `t-${testType}`,
    testType,
    source: 'RUNTIME',
    tier: 'PASSING',
    cappedBy: null,
    runId: 'run-1',
    ...overrides,
  };
}

function variant(
  baseKey: string,
  overrides: Partial<VariantCellObservation> = {},
): VariantCellObservation {
  return {
    baseKey,
    testId: 'test-1',
    runId: 'run-1',
    viewport: 'desktop-1280',
    locale: 'en-US',
    browser: 'chromium',
    status: 'PASSED',
    assertionObserved: true,
    observedAtIso: AT,
    ...overrides,
  };
}

const DEVICES: DeviceLocaleValue[] = [
  { kind: 'DEVICE', key: 'desktop-1280', isDefault: true },
  { kind: 'DEVICE', key: 'iphone-15' },
];
const LOCALES: DeviceLocaleValue[] = [
  { kind: 'LOCALE', key: 'en-US', isDefault: true },
  { kind: 'LOCALE', key: 'de-DE' },
  { kind: 'LOCALE', key: 'pt-BR' },
];

function combo(
  baseKey: string,
  assignments: Array<[string, string]>,
  overrides: Partial<FlagCombinationDeclaration> = {},
): FlagCombinationDeclaration {
  return {
    baseKey,
    assignments: assignments.map(([flag, vrt]) => ({ flag, variant: vrt })),
    source: 'CRAWL',
    evidence: 'the crawl recorded the flag payload it was served',
    observed: true,
    ...overrides,
  };
}

/** Every rung's percent, so "null, never 0" can be asserted at all five. */
function percentsAt(measurement: DimensionMeasurement): Array<number | null> {
  return COVERAGE_TIERS.map((tier) => dimensionPercentAt(measurement, tier));
}

function rung(measurement: DimensionMeasurement, tier: (typeof COVERAGE_TIERS)[number]): number {
  const found = measurement.tiers.tiers.find((entry) => entry.tier === tier);
  if (!found) throw new Error(`no ${tier} rung`);
  return found.atOrAbove;
}

// ─── The vocabulary this module measures ─────────────────────────────────────

describe('MATRIX_DIMENSIONS', () => {
  it('names only real dimensions, each with a descriptor', () => {
    for (const dimension of MATRIX_DIMENSIONS) {
      expect(COVERAGE_DIMENSIONS).toContain(dimension);
      expect(COVERAGE_DIMENSION_DESCRIPTORS[dimension].dimension).toBe(dimension);
    }
    expect(MATRIX_DIMENSIONS).toHaveLength(3);
  });

  it('measures the one dimension whose cells are counted per refined kind, and no other', () => {
    // TEST_TYPE is the only dimension with no cell axis of its own, which is
    // why its measurement is one population of obligations rather than a
    // thirteenth SurfaceKind. If a sibling axis ever acquires a null cellAxis
    // this assertion is the place the assumption is written down.
    expect(COVERAGE_DIMENSION_DESCRIPTORS.TEST_TYPE.cellAxis).toBeNull();
    expect(COVERAGE_DIMENSION_DESCRIPTORS.DEVICE_LOCALE.cellAxis).toBe('DEVICE_LOCALE');
    expect(COVERAGE_DIMENSION_DESCRIPTORS.FLAG_COMBINATION.cellAxis).toBe('FLAG_COMBINATION');
  });
});

// ─── dominantUnmeasuredReason ────────────────────────────────────────────────

describe('dominantUnmeasuredReason', () => {
  it('names every reason with its count, not only the largest', () => {
    const result = dominantUnmeasuredReason(
      new Map<DimensionUnmeasuredReason, number>([
        ['HELD_OUT', 3],
        ['NO_EXTRACTOR', 7],
      ]),
    );
    expect(result?.reason).toBe('NO_EXTRACTOR');
    expect(result?.unmeasured).toBe(10);
    expect(result?.detail).toContain('7 — ');
    expect(result?.detail).toContain('3 — ');
    expect(result?.detail).toContain(DIMENSION_UNMEASURED_REASON_LABELS.HELD_OUT);
  });

  it('breaks a tie on declaration order, so two runs cannot report two reasons', () => {
    const result = dominantUnmeasuredReason(
      new Map<DimensionUnmeasuredReason, number>([
        ['HELD_OUT', 2],
        ['NO_EXTRACTOR', 2],
      ]),
    );
    // NO_EXTRACTOR comes first in DIMENSION_UNMEASURED_REASONS. A Map-iteration
    // order answer would have said HELD_OUT here.
    expect(result?.reason).toBe('NO_EXTRACTOR');
  });

  it('claims nothing when nothing is unmeasured', () => {
    expect(dominantUnmeasuredReason(new Map())).toBeNull();
    expect(dominantUnmeasuredReason(new Map([['HELD_OUT', 0]]))).toBeNull();
  });
});

// ─── What is owed ────────────────────────────────────────────────────────────

describe('resolveTypeObligations — an obligation nobody declared is not owed', () => {
  it('owes nothing with no policy and no declarations', () => {
    expect(resolveTypeObligations({ items: [route('/a'), route('/b')] })).toEqual([]);
  });

  it('resolves the policy only for the axes it names', () => {
    const resolved = resolveTypeObligations({
      items: [route('/a'), { key: surfaceKey('FORM', 'signup.tsx#0'), kind: 'FORM' }],
      policy: { byKind: { ROUTE: ['E2E', 'ACCESSIBILITY'] } },
    });
    expect(resolved).toHaveLength(2);
    expect(resolved.every((obligation) => obligation.itemKey === surfaceKey('ROUTE', '/a'))).toBe(
      true,
    );
    expect(resolved.every((obligation) => obligation.declaredBy === 'MANUAL')).toBe(true);
  });

  it('keeps an explicit declaration rather than the policy’s generic one', () => {
    const resolved = resolveTypeObligations({
      items: [route('/a')],
      declarations: [owes(surfaceKey('ROUTE', '/a'), 'E2E')],
      policy: { byKind: { ROUTE: ['E2E'] } },
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.declaredBy).toBe('REQUIREMENT');
    expect(resolved[0]?.evidence).toContain('AC-1');
  });

  it('counts the same obligation declared twice once', () => {
    const resolved = resolveTypeObligations({
      items: [route('/a')],
      declarations: [
        owes(surfaceKey('ROUTE', '/a'), 'E2E'),
        owes(surfaceKey('ROUTE', '/a'), 'E2E', { declaredBy: 'SOURCE' }),
      ],
    });
    expect(resolved).toHaveLength(1);
  });
});

// ─── TEST_TYPE: the end of the single boolean ────────────────────────────────

describe('buildTypeObligationMatrix — coverage stops being type-blind', () => {
  it('does not let a PERFORMANCE test satisfy an ACCESSIBILITY obligation', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'ACCESSIBILITY')],
      edges: [edge(key, 'PERFORMANCE')],
    });

    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]?.testType).toBe('ACCESSIBILITY');
    // The whole point: the obligation is in the denominator and unclaimed.
    expect(matrix.cells[0]?.tier).toBeNull();
    expect(matrix.cells[0]?.counted).toBe(true);
    expect(matrix.measurement.tiers.denominator).toBe(1);
    expect(matrix.measurement.tiers.unclaimed).toBe(1);
    expect(dimensionPercentAt(matrix.measurement, 'NAVIGATED')).toBe(0);
    // And the performance evidence is NOT silently discarded.
    expect(matrix.uncredited).toEqual([{ testType: 'PERFORMANCE', edges: 1 }]);
  });

  it('says "routes with an ACCESSIBILITY test: 3 of 14"', () => {
    const items = Array.from({ length: 14 }, (_, index) => route(`/p${index}`));
    const matrix = buildTypeObligationMatrix({
      items,
      obligations: items.map((item) => owes(item.key, 'ACCESSIBILITY')),
      edges: items
        .slice(0, 3)
        .map((item) => edge(item.key, 'ACCESSIBILITY', { tier: 'NAVIGATED' })),
    });

    const accessibility = matrix.byType.find((entry) => entry.testType === 'ACCESSIBILITY');
    expect(accessibility?.owed).toBe(14);
    expect(accessibility?.tiers.denominator).toBe(14);
    const navigated = accessibility?.tiers.tiers.find((entry) => entry.tier === 'NAVIGATED');
    expect(navigated?.atOrAbove).toBe(3);
    expect(navigated?.percent).toBe(21.4);
    // One type, one denominator. Nothing here is added to another type's.
    expect(matrix.byType).toHaveLength(1);
  });

  it('gives each type its own ladder rather than one figure over nineteen', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'E2E'), owes(key, 'ACCESSIBILITY')],
      edges: [edge(key, 'E2E', { tier: 'PASSING' })],
    });

    const e2e = matrix.byType.find((entry) => entry.testType === 'E2E');
    const a11y = matrix.byType.find((entry) => entry.testType === 'ACCESSIBILITY');
    expect(e2e?.tiers.denominator).toBe(1);
    expect(a11y?.tiers.denominator).toBe(1);
    expect(dimensionPercentAt(matrix.measurement, 'PASSING')).toBe(50);
    expect(e2e?.tiers.tiers.find((entry) => entry.tier === 'PASSING')?.percent).toBe(100);
    expect(a11y?.tiers.tiers.find((entry) => entry.tier === 'PASSING')?.percent).toBe(0);
  });

  it('resolves several edges on one cell by MAX, with the strongest source winning a tie', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'E2E')],
      edges: [
        edge(key, 'E2E', { testId: 'static', source: 'STATIC', tier: 'DECLARED', runId: null }),
        edge(key, 'E2E', { testId: 'runtime', source: 'RUNTIME', tier: 'DECLARED', runId: null }),
      ],
    });
    // Same rung, so the sentence printed is the RUN's — but DECLARED carries no
    // run id by contract, so the column stays null either way.
    expect(matrix.cells[0]?.tier).toBe('DECLARED');
    expect(matrix.cells[0]?.lastConfirmedRunId).toBeNull();
    expect(matrix.unattributedPromotions).toBe(0);
  });

  it('caps a rung above DECLARED that names no run, and counts it', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'E2E')],
      edges: [edge(key, 'E2E', { tier: 'PASSING', runId: null })],
    });
    expect(matrix.cells[0]?.tier).toBe('DECLARED');
    expect(matrix.cells[0]?.tierCappedBy).toBe('NO_RUN_OBSERVED');
    expect(matrix.unattributedPromotions).toBe(1);
  });

  it('counts a failing test as coverage — covered and failing are two facts', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'E2E')],
      edges: [edge(key, 'E2E', { tier: 'ASSERTED', cappedBy: null })],
    });
    expect(matrix.cells[0]?.tier).toBe('ASSERTED');
    expect(matrix.cells[0]?.counted).toBe(true);
    expect(rung(matrix.measurement, 'ASSERTED')).toBe(1);
    expect(rung(matrix.measurement, 'PASSING')).toBe(0);
  });
});

describe('buildTypeObligationMatrix — an empty denominator is null, never 0', () => {
  it('reports NOT_ENUMERATED when there is no inventory to owe anything', () => {
    const matrix = buildTypeObligationMatrix({ items: [], obligations: [] });
    expect(matrix.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(matrix.measurement.unmeasuredDetail).toBeTruthy();
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
    expect(dimensionWasMeasured(matrix.measurement)).toBe(false);
  });

  it('distinguishes "nothing is owed" from "we failed to look"', () => {
    const matrix = buildTypeObligationMatrix({
      items: [route('/a'), route('/b')],
      obligations: [],
    });
    // Nothing is owed and we know that exactly: DEFAULT_TYPE_OBLIGATIONS owes
    // nothing. So no reason code, and still no figure.
    expect(matrix.measurement.unmeasuredReason).toBeNull();
    expect(matrix.measurement.cells).toBe(0);
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
    expect(matrix.rule).toContain('not 0%');
    expect(dimensionMeasurementSchema.safeParse(matrix.measurement).success).toBe(true);
  });
});

describe('buildTypeObligationMatrix — the four ways a cell leaves the denominator', () => {
  it('holds out a type this deployment cannot execute, and keeps an unprobed one in', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout')],
      obligations: [owes(key, 'LOAD'), owes(key, 'MUTATION'), owes(key, 'E2E')],
      capabilities: [
        { testType: 'LOAD', status: 'MISSING', detail: 'k6 is not on this image' },
        { testType: 'MUTATION', status: 'WRONG_VERSION', detail: 'Stryker 6 is too old' },
      ],
    });

    const load = matrix.cells.find((cell) => cell.testType === 'LOAD');
    const mutation = matrix.cells.find((cell) => cell.testType === 'MUTATION');
    const e2e = matrix.cells.find((cell) => cell.testType === 'E2E');
    expect(load?.counted).toBe(false);
    expect(load?.unmeasuredReason).toBe('HELD_OUT');
    expect(load?.unmeasuredDetail).toContain('k6 is not on this image');
    expect(mutation?.counted).toBe(false);
    // NOT_CHECKED stays IN: shedding an unprobed type would raise the figure
    // for a preflight nobody ran.
    expect(e2e?.capability).toBe('NOT_CHECKED');
    expect(e2e?.counted).toBe(true);
    expect(matrix.measurement.tiers.denominator).toBe(1);
    expect(matrix.measurement.unmeasured).toBe(2);
    expect(matrix.measurement.cells).toBe(3);
  });

  it('reports NO_EXTRACTOR for an obligation on an axis nothing matches', () => {
    const key = surfaceKey('BACKGROUND_JOB', 'cron:nightly-billing');
    const matrix = buildTypeObligationMatrix({
      items: [{ key, kind: 'BACKGROUND_JOB' }],
      obligations: [owes(key, 'E2E')],
    });
    expect(matrix.cells[0]?.unmeasuredReason).toBe('NO_EXTRACTOR');
    expect(matrix.cells[0]?.counted).toBe(false);
    // Unmeasured, NOT 0%: the ladder divides by what was measured, which is 0.
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
    expect(matrix.measurement.unmeasured).toBe(1);
  });

  it('reports NO_EXTRACTOR before HELD_OUT when both apply', () => {
    // A job obligation for a type this image cannot run. Installing k6 would
    // not help, so the row must not tell the reader to.
    const key = surfaceKey('BACKGROUND_JOB', 'cron:nightly-billing');
    const matrix = buildTypeObligationMatrix({
      items: [{ key, kind: 'BACKGROUND_JOB', waived: true }],
      obligations: [owes(key, 'LOAD')],
      capabilities: [{ testType: 'LOAD', status: 'MISSING', detail: 'k6 is not on this image' }],
    });
    expect(matrix.cells[0]?.unmeasuredReason).toBe('NO_EXTRACTOR');
    expect(matrix.cells[0]?.unmeasuredDetail).toContain('BACKGROUND_JOB');
  });

  it('holds out a waived item’s obligations with the team’s decision named', () => {
    const key = surfaceKey('ROUTE', '/legacy');
    const matrix = buildTypeObligationMatrix({
      items: [route('/legacy', { waived: true })],
      obligations: [owes(key, 'E2E')],
      edges: [edge(key, 'E2E', { tier: 'PASSING' })],
    });
    expect(matrix.cells[0]?.counted).toBe(false);
    expect(matrix.cells[0]?.unmeasuredReason).toBe('HELD_OUT');
    expect(matrix.cells[0]?.unmeasuredDetail).toContain('waiver');
    // Never scored as a pass, even though a passing edge exists for it.
    expect(matrix.cells[0]?.tier).toBeNull();
    expect(rung(matrix.measurement, 'PASSING')).toBe(0);
  });

  it('holds out an item the harness cannot drive, with our own limit named', () => {
    const key = surfaceKey('ROUTE', '/logout');
    const matrix = buildTypeObligationMatrix({
      items: [
        route('/logout', {
          exercise: {
            state: 'UNEXERCISABLE',
            reason: 'SESSION_ENDING',
            detail: 'driving it would end the crawl’s session',
          },
        }),
      ],
      obligations: [owes(key, 'E2E')],
    });
    expect(matrix.cells[0]?.unmeasuredReason).toBe('HELD_OUT');
    expect(matrix.cells[0]?.unmeasuredDetail).toContain('end the crawl');
    expect(matrix.heldOut[0]?.cells).toBe(1);
  });

  it('refuses an obligation on an axis TEST_TYPE does not refine', () => {
    const key = surfaceKey('DEVICE_LOCALE', '/checkout|LOCALE=de-DE');
    const matrix = buildTypeObligationMatrix({
      items: [{ key, kind: 'DEVICE_LOCALE' }, route('/checkout')],
      obligations: [owes(key, 'LOCALIZATION')],
    });
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.refused).toHaveLength(1);
    expect(matrix.refused[0]?.why).toContain('does not refine');
    // Refused, not minted: nineteen obligations on a cell would be nineteen
    // fabricated denominators built out of one real one.
    expect(matrix.measurement.cells).toBe(0);
  });

  it('refuses an obligation whose item is not in the inventory', () => {
    const matrix = buildTypeObligationMatrix({
      items: [route('/a')],
      obligations: [owes(surfaceKey('ROUTE', '/gone'), 'E2E')],
    });
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.refused[0]?.why).toContain('not in the inventory');
  });

  it('produces a measurement the stored schema accepts', () => {
    const key = surfaceKey('ROUTE', '/checkout');
    const matrix = buildTypeObligationMatrix({
      items: [route('/checkout'), { key: surfaceKey('NOTIFICATION', 'welcome'), kind: 'NOTIFICATION' }],
      obligations: [
        owes(key, 'E2E'),
        owes(key, 'LOAD'),
        owes(surfaceKey('NOTIFICATION', 'welcome'), 'EMAIL_OTP'),
      ],
      edges: [edge(key, 'E2E')],
      capabilities: [{ testType: 'LOAD', status: 'MISSING', detail: 'no k6' }],
    });
    const parsed = dimensionMeasurementSchema.safeParse(matrix.measurement);
    expect(parsed.success).toBe(true);
    expect(matrix.measurement.cells).toBe(
      matrix.measurement.measured + matrix.measurement.unmeasured,
    );
  });
});

// ─── DEVICE_LOCALE: declared pairings, never the cross product ───────────────

describe('buildDeviceLocaleMatrix — the denominator is declared pairings', () => {
  it('counts declared pairings and reports the cross product beside them', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout', '/pricing'],
      values: LOCALES,
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'pt-BR'], source: 'SOURCE' },
      ],
      nowIso: NOW,
    });

    // /checkout declares two locales; /pricing declares none and gets one cell
    // at the default. 3 cells, not 2 x 3 = 6.
    expect(matrix.declaredCells).toBe(3);
    expect(matrix.crossProduct).toBe(6);
    expect(matrix.cells).toHaveLength(3);
    expect(matrix.byDimension[0]?.declaredCells).toBe(2);
    expect(matrix.byDimension[0]?.defaultCells).toBe(1);
    expect(matrix.measurement.tiers.denominator).toBe(3);
    expect(matrix.rule).toContain('never multiplied');
  });

  it('sums the two axes rather than multiplying them', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: [...DEVICES, ...LOCALES],
      declarations: [
        { baseKey: '/checkout', kind: 'DEVICE', values: ['desktop-1280', 'iphone-15'], source: 'SOURCE' },
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'pt-BR'], source: 'SOURCE' },
      ],
      nowIso: NOW,
    });
    // 2 device cells + 2 locale cells = 4. The product would be 4 as well for
    // these numbers, so the cell LIST is what proves it: four cells each
    // carrying ONE coordinate, not four carrying two.
    expect(matrix.declaredCells).toBe(4);
    expect(matrix.cells).toHaveLength(4);
    for (const cell of matrix.cells) {
      const parsed = parseDimensionCellIdentity(cell.identity);
      expect(parsed?.coordinates).toHaveLength(1);
    }
    expect(matrix.byDimension.map((axis) => axis.dimension)).toEqual(['DEVICE', 'LOCALE']);
    expect(matrix.crossProduct).toBe(2 + 3);
  });

  it('counts no cell for a base with no declaration when the project has no default', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/pricing'],
      values: [{ kind: 'LOCALE', key: 'de-DE' }],
      nowIso: NOW,
    });
    // Inventing a default would be inventing a measurement.
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.byDimension[0]?.defaultCells).toBe(0);
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
  });

  it('does not inflate the denominator with a declaration naming a value no row holds', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'fr-CA'], source: 'SOURCE' },
      ],
      nowIso: NOW,
    });
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.byDimension[0]?.undeclaredValues).toEqual(['fr-CA']);
    expect(matrix.declaredCells).toBeLessThanOrEqual(matrix.crossProduct);
  });

  it('builds cell keys with the one cell-identity format', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      nowIso: NOW,
    });
    const cell = matrix.cells[0]!;
    expect(cell.identity).toBe('/checkout|LOCALE=de-DE');
    expect(parseSurfaceKey(cell.key)).toEqual({ kind: 'DEVICE_LOCALE', identity: cell.identity });
    expect(parseDimensionCellIdentity(cell.identity)).toEqual({
      base: '/checkout',
      coordinates: [{ dimension: 'LOCALE', value: 'de-DE' }],
    });
  });

  it('names the axis as not enumerated when the project holds no device or locale rows', () => {
    const matrix = buildDeviceLocaleMatrix({ baseKeys: ['/a'], values: [], nowIso: NOW });
    expect(matrix.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
    expect(matrix.measurement.unmeasuredDetail).toContain('not the same as an application');
    expect(matrix.declaredCells).toBe(0);
  });

  it('names the axis as not enumerated when there are no base items', () => {
    const matrix = buildDeviceLocaleMatrix({ baseKeys: [], values: LOCALES, nowIso: NOW });
    expect(matrix.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
  });
});

describe('buildDeviceLocaleMatrix — only a variant row may promote a cell', () => {
  it('promotes the cell the variant row actually ran in, and no other', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'pt-BR'], source: 'SOURCE' },
      ],
      observations: [variant('/checkout', { locale: 'de-DE' })],
      nowIso: NOW,
    });

    const de = matrix.cells.find((cell) => cell.value === 'de-DE');
    const pt = matrix.cells.find((cell) => cell.value === 'pt-BR');
    expect(de?.tier).toBe('FRESH');
    expect(de?.lastConfirmedRunId).toBe('run-1');
    expect(pt?.tier).toBeNull();
    expect(pt?.observations).toBe(0);
    expect(dimensionPercentAt(matrix.measurement, 'PASSING')).toBe(50);
  });

  it('does not let a worst-wins roll-up reach either cell', () => {
    // One test, two cells: en-US passed and de-DE failed. `TestResult.status`
    // for that test is FAILED, and there is no input on this module through
    // which it could reach a cell — so en-US keeps its pass and de-DE does not
    // get one. The inverse lie is checked too: de-DE is still COVERAGE.
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['en-US', 'de-DE'], source: 'SOURCE' },
      ],
      observations: [
        variant('/checkout', { locale: 'en-US', status: 'PASSED' }),
        variant('/checkout', { locale: 'de-DE', status: 'FAILED' }),
      ],
      nowIso: NOW,
    });

    const en = matrix.cells.find((cell) => cell.value === 'en-US');
    const de = matrix.cells.find((cell) => cell.value === 'de-DE');
    expect(en?.tier).toBe('FRESH');
    expect(de?.tier).toBe('ASSERTED');
    expect(de?.tierCappedBy).toBeNull();
    expect(de?.counted).toBe(true);
    expect(rung(matrix.measurement, 'ASSERTED')).toBe(2);
    expect(rung(matrix.measurement, 'PASSING')).toBe(1);
  });

  it('refuses to invent an assertion — a run that asserted nothing stops at NAVIGATED', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [variant('/checkout', { locale: 'de-DE', assertionObserved: false })],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.tier).toBe('NAVIGATED');
  });

  it('keeps an undatable-by-the-window pass at PASSING rather than FRESH', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [variant('/checkout', { locale: 'de-DE', observedAtIso: LONG_AGO })],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.tier).toBe('PASSING');
    expect(matrix.cells[0]?.tierCappedBy).toBeNull();
  });

  it('takes the strongest rung across runs, so a later red does not erase a green', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [
        variant('/checkout', { locale: 'de-DE', runId: 'run-green', status: 'PASSED' }),
        variant('/checkout', { locale: 'de-DE', runId: 'run-red', status: 'FAILED' }),
      ],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.tier).toBe('FRESH');
    expect(matrix.cells[0]?.lastConfirmedRunId).toBe('run-green');
    expect(matrix.cells[0]?.observations).toBe(2);
  });

  it('credits an <unvaried> row to nothing, and counts it per axis', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/pricing'],
      values: [...DEVICES, ...LOCALES],
      observations: [
        variant('/pricing', { viewport: '<unvaried>', locale: '<unvaried>' }),
      ],
      nowIso: NOW,
    });
    // Two default cells (one per axis), neither promoted.
    expect(matrix.cells).toHaveLength(2);
    expect(matrix.cells.every((cell) => cell.tier === null)).toBe(true);
    expect(matrix.cells.every((cell) => cell.atDefault)).toBe(true);
    // One disclosure per axis the row left at the sentinel.
    expect(matrix.unvariedObservations).toBe(2);
    expect(matrix.measurement.tiers.unclaimed).toBe(2);
    // And the sentinel is NOT reported as a coordinate the dimension table is
    // missing. "Nobody recorded which cell this ran in" and "the harness ran a
    // viewport the inventory does not hold" are different findings with
    // different fixes, and the second one would send a reader to correct a
    // dimension table that is already right.
    expect(matrix.unknownCoordinates).toEqual([]);
  });

  it('counts only the measured axes when a row is unvaried on one of them', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/pricing'],
      values: LOCALES,
      observations: [variant('/pricing', { viewport: '<unvaried>', locale: 'en-US' })],
      nowIso: NOW,
    });
    // There is no DEVICE axis here, so the unvaried viewport is not a gap on an
    // axis this report says it does not measure.
    expect(matrix.unvariedObservations).toBe(0);
    expect(matrix.cells[0]?.tier).toBe('FRESH');
  });

  it('reports a coordinate the dimension table does not hold rather than crediting it', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [variant('/checkout', { locale: 'fr-CA' })],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.tier).toBeNull();
    expect(matrix.unknownCoordinates).toEqual([
      { dimension: 'LOCALE', value: 'fr-CA', observations: 1 },
    ]);
  });

  it('reports an observation attributed to a base outside the inventory', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [variant('/gone', { locale: 'de-DE' })],
      nowIso: NOW,
    });
    expect(matrix.unattributedObservations).toBe(1);
    expect(matrix.cells[0]?.tier).toBeNull();
  });
});

describe('buildDeviceLocaleMatrix — a cell nobody could attempt leaves the denominator', () => {
  it('holds out a cell every run of which recorded UNSUPPORTED', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: DEVICES,
      declarations: [
        { baseKey: '/checkout', kind: 'DEVICE', values: ['desktop-1280', 'iphone-15'], source: 'SOURCE' },
      ],
      observations: [
        variant('/checkout', { viewport: 'iphone-15', status: 'SKIPPED', notRunKind: 'UNSUPPORTED' }),
        variant('/checkout', { viewport: 'desktop-1280' }),
      ],
      nowIso: NOW,
    });

    const phone = matrix.cells.find((cell) => cell.value === 'iphone-15');
    expect(phone?.counted).toBe(false);
    expect(phone?.unmeasuredReason).toBe('HELD_OUT');
    expect(phone?.unmeasuredDetail).toContain('UNSUPPORTED');
    // One cell in, one out. A percentage over tests that always skip is a pass
    // that means "we did not check".
    expect(matrix.measurement.tiers.denominator).toBe(1);
    expect(matrix.measurement.unmeasured).toBe(1);
    expect(dimensionPercentAt(matrix.measurement, 'PASSING')).toBe(100);
    expect(matrix.heldOut[0]?.reason).toBe('HELD_OUT');
  });

  it('holds out a cell blocked by the environment rather than scoring it red', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [
        variant('/checkout', { locale: 'de-DE', status: 'SKIPPED', notRunKind: 'BLOCKED_BY_ENV' }),
      ],
      nowIso: NOW,
    });
    expect(matrix.measurement.tiers.denominator).toBe(0);
    expect(matrix.measurement.unmeasured).toBe(1);
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
  });

  it('holds out a cell whose only run recorded the weakest reason of the four', () => {
    // NOT_RUN is a placeholder row for a cell this run selected and never
    // reached — a dead shard, a lost queue job. `NOT_RUN_KINDS` is on the
    // record that it "is not evidence of anything and should not be averaged
    // over either", so it leaves the denominator exactly as the other three do.
    // This is the pair to the test below: a RECORDED NOT_RUN and an
    // UNRECORDED reason are opposite decisions, and the only thing that tells
    // them apart is whether the column is null.
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [
        variant('/checkout', { locale: 'de-DE', status: 'SKIPPED', notRunKind: 'NOT_RUN' }),
      ],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.counted).toBe(false);
    expect(matrix.cells[0]?.unmeasuredReason).toBe('HELD_OUT');
    expect(matrix.cells[0]?.unmeasuredDetail).toContain('NOT_RUN');
    expect(matrix.measurement.tiers.denominator).toBe(0);
  });

  it('keeps a skip whose reason was never recorded IN the denominator', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [{ baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE'], source: 'SOURCE' }],
      observations: [variant('/checkout', { locale: 'de-DE', status: 'SKIPPED' })],
      nowIso: NOW,
    });
    // An unrecorded reason must not shed a cell — the same direction
    // `capabilityCounts` takes with NOT_CHECKED.
    expect(matrix.cells[0]?.counted).toBe(true);
    expect(matrix.measurement.tiers.denominator).toBe(1);
    expect(matrix.cells[0]?.tier).toBe('DECLARED');
  });

  it('produces a measurement the stored schema accepts', () => {
    const matrix = buildDeviceLocaleMatrix({
      baseKeys: ['/checkout', '/pricing'],
      values: [...DEVICES, ...LOCALES],
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'pt-BR'], source: 'SOURCE' },
      ],
      observations: [
        variant('/checkout', { locale: 'de-DE' }),
        variant('/checkout', { locale: 'pt-BR', status: 'SKIPPED', notRunKind: 'UNSUPPORTED' }),
      ],
      nowIso: NOW,
    });
    expect(dimensionMeasurementSchema.safeParse(matrix.measurement).success).toBe(true);
    expect(matrix.measurement.cells).toBe(
      matrix.measurement.measured + matrix.measurement.unmeasured,
    );
  });
});

// ─── FLAG_COMBINATION ────────────────────────────────────────────────────────

describe('flagCombinationKey', () => {
  it('is canonical regardless of the order a declarer listed the assignments', () => {
    const forward = flagCombinationKey([
      { flag: 'promo-banner', variant: 'off' },
      { flag: 'checkout-v2', variant: 'on' },
    ]);
    const backward = flagCombinationKey([
      { flag: 'checkout-v2', variant: 'on' },
      { flag: 'promo-banner', variant: 'off' },
    ]);
    expect(forward).toBe('checkout-v2=on;promo-banner=off');
    expect(forward).toBe(backward);
  });

  it('round-trips', () => {
    const assignments = [
      { flag: 'checkout-v2', variant: 'on' },
      { flag: 'promo-banner', variant: 'variant-b' },
    ];
    expect(parseFlagCombinationKey(flagCombinationKey(assignments))).toEqual(assignments);
  });

  it('refuses a separator inside a flag or a variant, so two combinations cannot share one cell', () => {
    expect(() => flagCombinationKey([{ flag: 'a;b', variant: 'on' }])).toThrow(/forge/);
    expect(() => flagCombinationKey([{ flag: 'a=b', variant: 'on' }])).toThrow(/forge/);
    expect(() => flagCombinationKey([{ flag: 'a', variant: 'on;off' }])).toThrow(/forge/);
  });

  it('refuses the same flag twice, an empty part and an empty combination', () => {
    expect(() =>
      flagCombinationKey([
        { flag: 'a', variant: 'on' },
        { flag: 'a', variant: 'off' },
      ]),
    ).toThrow(/two combinations, not one/);
    expect(() => flagCombinationKey([{ flag: '', variant: 'on' }])).toThrow(/neither may be empty/);
    expect(() => flagCombinationKey([])).toThrow(/at least one assignment/);
  });

  it('parses nothing out of a string that is not one of ours', () => {
    expect(parseFlagCombinationKey('')).toBeNull();
    expect(parseFlagCombinationKey('checkout-v2')).toBeNull();
    expect(parseFlagCombinationKey('=on')).toBeNull();
    expect(parseFlagCombinationKey('a=')).toBeNull();
    expect(parseFlagCombinationKey('a=on;a=off')).toBeNull();
  });
});

describe('buildFlagCombinationMatrix — declared combinations, never the cross product', () => {
  const FLAGS = [
    { key: 'checkout-v2', variants: ['on', 'off'], defaultVariant: 'off' },
    { key: 'promo-banner', variants: ['on', 'off'], defaultVariant: 'off' },
  ];

  it('divides by the combinations somebody asserted and reports the remainder', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [
        combo('/checkout', [
          ['checkout-v2', 'on'],
          ['promo-banner', 'off'],
        ]),
        combo('/checkout', [
          ['checkout-v2', 'off'],
          ['promo-banner', 'off'],
        ]),
      ],
      observations: [
        {
          baseKey: '/checkout',
          combination: 'checkout-v2=on;promo-banner=off',
          runId: 'run-1',
          status: 'PASSED',
          assertionObserved: true,
          observedAtIso: AT,
        },
      ],
      nowIso: NOW,
    });

    expect(matrix.declaredCombinations).toBe(2);
    expect(matrix.observedCombinations).toBe(2);
    // Two flags, two variants each: four reachable assignments of /checkout.
    expect(matrix.combinationSpace).toBe(4);
    expect(matrix.unobservedRemainder).toBe(2);
    // The denominator is the two declared cells, NOT the space.
    expect(matrix.measurement.tiers.denominator).toBe(2);
    expect(dimensionPercentAt(matrix.measurement, 'PASSING')).toBe(50);
    expect(matrix.rule).toContain('never a denominator');
  });

  it('counts a declaration nobody ran separately from one a run was observed in', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [
        combo('/checkout', [['checkout-v2', 'on']], { observed: false, source: 'MANUAL' }),
        combo('/checkout', [['checkout-v2', 'off']]),
      ],
      nowIso: NOW,
    });
    expect(matrix.declaredCombinations).toBe(2);
    expect(matrix.observedCombinations).toBe(1);
    // Declared and unclaimed is the gap; both are in the denominator.
    expect(matrix.measurement.tiers.unclaimed).toBe(2);
  });

  it('builds cell keys with the one cell-identity format, one coordinate deep', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [
        combo('/checkout', [
          ['checkout-v2', 'on'],
          ['promo-banner', 'off'],
        ]),
      ],
      nowIso: NOW,
    });
    const cell = matrix.cells[0]!;
    expect(cell.combination).toBe('checkout-v2=on;promo-banner=off');
    expect(parseSurfaceKey(cell.key)?.kind).toBe('FLAG_COMBINATION');
    const parsed = parseDimensionCellIdentity(cell.identity);
    expect(parsed?.base).toBe('/checkout');
    expect(parsed?.coordinates).toEqual([
      { dimension: 'FLAG', value: 'checkout-v2=on;promo-banner=off' },
    ]);
  });

  it('refuses a combination naming a flag or a variant no row holds', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [
        combo('/checkout', [['ghost-flag', 'on']]),
        combo('/checkout', [['checkout-v2', 'maybe']]),
        combo('/elsewhere', [['checkout-v2', 'on']]),
      ],
      nowIso: NOW,
    });
    expect(matrix.cells).toHaveLength(0);
    expect(matrix.refused).toHaveLength(3);
    expect(matrix.refused.map((entry) => entry.why).join(' ')).toContain('no flag row is held');
    expect(matrix.refused.map((entry) => entry.why).join(' ')).toContain('does not declare the variant');
    expect(matrix.refused.map((entry) => entry.why).join(' ')).toContain('not in the inventory');
  });

  it('refuses a malformed declaration rather than throwing on one stored row', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: [{ key: 'checkout-v2', variants: ['on'] }],
      declarations: [
        {
          baseKey: '/checkout',
          assignments: [
            { flag: 'checkout-v2', variant: 'on' },
            { flag: 'checkout-v2', variant: 'on' },
          ],
          source: 'CRAWL',
          evidence: 'a duplicated assignment from a stored row',
          observed: true,
        },
        combo('/checkout', [['checkout-v2', 'on']]),
      ],
      nowIso: NOW,
    });
    expect(matrix.refused).toHaveLength(1);
    expect(matrix.cells).toHaveLength(1);
  });

  it('reports an unbounded space as null with the cap disclosed, never as a number', () => {
    const flags = Array.from({ length: 21 }, (_, index) => ({
      key: `flag-${index}`,
      variants: ['on', 'off'],
    }));
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags,
      declarations: [combo('/checkout', flags.map((flag) => [flag.key, 'on'] as [string, string]))],
      nowIso: NOW,
    });

    expect(matrix.combinationSpace).toBeNull();
    expect(matrix.unobservedRemainder).toBeNull();
    const cap = matrix.caps.find((entry) => entry.cap === 'MAX_REPORTED_COMBINATION_SPACE');
    expect(cap?.limit).toBe(MAX_REPORTED_COMBINATION_SPACE);
    // Null, not the partial product: a cap that bit does not always know what
    // it hid, and 0 would claim nothing was hidden.
    expect(cap?.atLeastMore).toBeNull();
    expect(cap?.detail).toContain('unbounded');
    // The denominator is still the one declared cell. The space never enters it.
    expect(matrix.measurement.tiers.denominator).toBe(1);
    expect(matrix.measurement.caps).toHaveLength(1);
  });

  it('holds out a combination no run could attempt', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [combo('/checkout', [['checkout-v2', 'on']])],
      observations: [
        {
          baseKey: '/checkout',
          combination: 'checkout-v2=on',
          runId: 'run-1',
          status: 'SKIPPED',
          assertionObserved: false,
          notRunKind: 'BLOCKED_BY_ENV',
          observedAtIso: AT,
        },
      ],
      nowIso: NOW,
    });
    expect(matrix.cells[0]?.counted).toBe(false);
    expect(matrix.cells[0]?.unmeasuredReason).toBe('HELD_OUT');
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
  });

  it('names the axis as not enumerated when the project holds no flag rows', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: [],
      declarations: [combo('/checkout', [['checkout-v2', 'on']])],
      nowIso: NOW,
    });
    expect(matrix.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(matrix.measurement.unmeasuredDetail).toContain('one of several applications');
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
    expect(matrix.combinationSpace).toBeNull();
  });

  it('names the axis as not enumerated when flags exist and nothing declared a combination', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      nowIso: NOW,
    });
    expect(matrix.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(matrix.measurement.unmeasuredDetail).toContain('which configuration');
    expect(matrix.declaredCombinations).toBe(0);
    expect(percentsAt(matrix.measurement)).toEqual([null, null, null, null, null]);
  });

  it('produces a measurement the stored schema accepts', () => {
    const matrix = buildFlagCombinationMatrix({
      baseKeys: ['/checkout'],
      flags: FLAGS,
      declarations: [
        combo('/checkout', [['checkout-v2', 'on']]),
        combo('/checkout', [['checkout-v2', 'off']]),
      ],
      observations: [
        {
          baseKey: '/checkout',
          combination: 'checkout-v2=off',
          runId: 'run-1',
          status: 'SKIPPED',
          assertionObserved: false,
          notRunKind: 'CANCELLED',
          observedAtIso: AT,
        },
      ],
      nowIso: NOW,
    });
    expect(dimensionMeasurementSchema.safeParse(matrix.measurement).success).toBe(true);
  });
});

// ─── Three denominators, never summed ────────────────────────────────────────

describe('buildCoverageMatrix', () => {
  const built = buildCoverageMatrix({
    testType: {
      items: [route('/checkout')],
      obligations: [owes(surfaceKey('ROUTE', '/checkout'), 'ACCESSIBILITY')],
    },
    deviceLocale: {
      baseKeys: ['/checkout'],
      values: LOCALES,
      declarations: [
        { baseKey: '/checkout', kind: 'LOCALE', values: ['de-DE', 'pt-BR'], source: 'SOURCE' },
      ],
      observations: [variant('/checkout', { locale: 'de-DE' })],
      nowIso: NOW,
    },
    flagCombination: {
      baseKeys: ['/checkout'],
      flags: [{ key: 'checkout-v2', variants: ['on', 'off'] }],
      declarations: [
        combo('/checkout', [['checkout-v2', 'on']]),
        combo('/checkout', [['checkout-v2', 'off']]),
        combo('/checkout', [['checkout-v2', 'off']]),
      ],
      nowIso: NOW,
    },
  });

  it('keeps three measurements with three different denominators', () => {
    expect(built.testType.measurement.tiers.denominator).toBe(1);
    expect(built.deviceLocale.measurement.tiers.denominator).toBe(2);
    expect(built.flagCombination.measurement.tiers.denominator).toBe(2);
    expect(built.testType.measurement.dimension).toBe('TEST_TYPE');
    expect(built.deviceLocale.measurement.dimension).toBe('DEVICE_LOCALE');
    expect(built.flagCombination.measurement.dimension).toBe('FLAG_COMBINATION');
  });

  it('exposes no combined figure — every percentage comes off one ladder', () => {
    // Structural, not stylistic: a `percent`, `total` or `headline` on this
    // object would be a fraction over three incommensurable populations, which
    // is the arithmetic that made controls ~80% of this product's first
    // headline. The only accessor is `dimensionPercentAt`, one measurement at a
    // time.
    const keys = Object.keys(built);
    expect(keys).toEqual(['testType', 'deviceLocale', 'flagCombination', 'rule']);
    for (const key of keys) {
      expect(/percent|total|headline|combined/i.test(key)).toBe(false);
    }
    expect(built.rule).toContain('never summed');
  });

  it('gives each dimension its own unmeasured story rather than one shared one', () => {
    const half = buildCoverageMatrix({
      testType: { items: [], obligations: [] },
      deviceLocale: { baseKeys: ['/checkout'], values: LOCALES, nowIso: NOW },
      flagCombination: { baseKeys: ['/checkout'], flags: [], nowIso: NOW },
    });
    expect(half.testType.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
    expect(half.deviceLocale.measurement.unmeasuredReason).toBeNull();
    expect(half.deviceLocale.measurement.tiers.denominator).toBe(1);
    expect(half.flagCombination.measurement.unmeasuredReason).toBe('NOT_ENUMERATED');
  });
});
