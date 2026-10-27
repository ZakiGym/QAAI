/**
 * The dimension registry: the tests that stop a number being invented.
 *
 * `coverage.test.ts` is the honesty suite for GAPS — a claim about somebody's
 * work. This file is the honesty suite for the DIMENSION REPORT, and it is
 * judged on three failures rather than one, because all three have already cost
 * this product a round:
 *
 *   1. TWO DENOMINATORS ADDED TOGETHER TO MAKE ONE PERCENTAGE. The previous
 *      headline summed routes + journeys + forms + controls, which made
 *      controls roughly 80% of the figure. Nine more axes is nine more chances,
 *      so the report is asserted to carry NO combined figure at all.
 *   2. A NULL THAT BECAME A ZERO. An axis with no extractor must read as "not
 *      measured", never as 0%, and the test checks that at every rung rather
 *      than at one.
 *   3. A CLAIM NOBODY CHECKS. `EXTRACTED_COVERAGE_DIMENSIONS` in
 *      packages/shared is the published list of measured axes, and
 *      `DIMENSION_REGISTRY` here is where the producers actually are. The test
 *      that holds them equal is the run-time half of this codebase's
 *      two-mechanism guard; without it either file could be edited alone.
 *
 * Nothing here touches a database, a browser, a clock or a model. Every input
 * is a literal.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_DIMENSIONS,
  COVERAGE_TIERS,
  EXTRACTED_COVERAGE_DIMENSIONS,
  coverageLadder,
  dimensionMeasurementSchema,
  dimensionPercentAt,
  dimensionWasMeasured,
  measuredDimension,
} from '@qaai/shared';
import type { CoverageDimensionKind, DimensionMeasurement } from '@qaai/shared';
import {
  DIMENSIONS_NEVER_SUMMED,
  DIMENSION_REGISTRY,
  coverageDimensionReport,
  dimensionReading,
  dimensionUnmeasuredDisclosures,
  measuredDimensionKinds,
  unmeasuredDimensionKinds,
  unmeasuredDimensionReading,
} from './coverage.js';

/**
 * A reading with one ASSERTED cell and one measured-but-unclaimed cell.
 *
 * `null` is a MEASURED cell that nothing claims — the gap this product exists
 * to shrink — and it stays in the denominator. It is not the same as an
 * unmeasured cell, and the two being two arguments to `measuredDimension` is
 * what stops them being merged.
 */
function reading(dimension: CoverageDimensionKind): DimensionMeasurement {
  return measuredDimension({ dimension, measuredCells: ['ASSERTED', null] });
}

// ─── The two-mechanism guard ────────────────────────────────────────────────

describe('the registry and the published extractor list', () => {
  it('agree exactly about which axes this build measures', () => {
    /*
     * THE RUN-TIME HALF OF THE GUARD. `EXTRACTED_COVERAGE_DIMENSIONS` is what
     * the attestation, the digest and the badge disclose; `DIMENSION_REGISTRY`
     * is where the producers are. A member added to one alone makes the
     * published list a claim nobody checks — which is how an axis comes to be
     * reported as measured by a module that does not exist.
     */
    expect(measuredDimensionKinds()).toEqual([...EXTRACTED_COVERAGE_DIMENSIONS]);
  });

  it('covers all thirteen axes between the two halves, with no axis in both', () => {
    const measured = measuredDimensionKinds();
    const unmeasured = unmeasuredDimensionKinds();
    expect([...measured, ...unmeasured].sort()).toEqual([...COVERAGE_DIMENSIONS].sort());
    expect(measured.filter((kind) => unmeasured.includes(kind))).toEqual([]);
  });

  it('names a module and an entry point for every axis it claims to measure', () => {
    // A registered axis with no module is an axis nobody can trace a finding
    // back to, which is the state every one of these modules shipped in before
    // the barrel lines landed: built, tested and reachable from nothing.
    for (const dimension of measuredDimensionKinds()) {
      const entry = DIMENSION_REGISTRY[dimension];
      expect(entry.measured, dimension).toBe(true);
      if (!entry.measured) return;
      expect(entry.module, dimension).toMatch(/^packages\/agent\/src\/.+\.ts$/);
      expect(entry.entryPoint.length, dimension).toBeGreaterThan(0);
      expect(entry.measures.length, dimension).toBeGreaterThan(20);
    }
  });

  it('gives every unmeasured axis a reason from the closed vocabulary and a sentence', () => {
    for (const dimension of unmeasuredDimensionKinds()) {
      const entry = DIMENSION_REGISTRY[dimension];
      expect(entry.measured, dimension).toBe(false);
      if (entry.measured) return;
      // A reason code with no sentence is a disclosure only somebody holding
      // this repository can read.
      expect(entry.detail.length, dimension).toBeGreaterThan(40);
    }
  });

  it('keeps ROLE_CELL enumerated and unscored, because a probe is not an assertion', () => {
    const entry = DIMENSION_REGISTRY.ROLE_CELL;
    expect(entry.measured).toBe(false);
    if (entry.measured) return;
    expect(entry.reason).toBe('NO_EXTRACTOR');
    /*
     * `enumeratedBy` is the field that separates "we cannot even count these"
     * from "we count them and cannot score them". The access matrix produces
     * the cells, so ROLE_CELL's denominator is real — and nothing matches a
     * TEST to one of them, so scoring the probe would attribute coverage to a
     * test that never ran.
     */
    expect(entry.enumeratedBy).toBe('packages/agent/src/access-matrix.ts');
  });
});

// ─── Never summed ───────────────────────────────────────────────────────────

describe('the report refuses to produce a combined figure', () => {
  const report = coverageDimensionReport({
    supplied: { PAGE_STATE: reading('PAGE_STATE'), FORM_FIELD: reading('FORM_FIELD') },
  });

  it('carries no total, percent, overall or score anywhere on it', () => {
    /*
     * Asserted over the KEYS rather than by reading a field, so a future writer
     * who adds `overall` to the interface fails here instead of shipping the
     * one defect this registry exists to prevent.
     */
    for (const forbidden of ['percent', 'total', 'overall', 'score', 'combined']) {
      expect(Object.keys(report), forbidden).not.toContain(forbidden);
    }
  });

  it('prints the reason where a combined figure would go', () => {
    expect(report.rule).toBe(DIMENSIONS_NEVER_SUMMED);
    expect(report.rule).toContain('ITS OWN cells');
  });

  it('keeps each dimension dividing by its own denominator', () => {
    const pageStates = dimensionReading(report, 'PAGE_STATE');
    const formFields = dimensionReading(report, 'FORM_FIELD');
    expect(pageStates?.tiers.denominator).toBe(2);
    expect(formFields?.tiers.denominator).toBe(2);
    // Two separate readings of 1/2, and nowhere a 2/4.
    expect(dimensionPercentAt(pageStates!, 'ASSERTED')).toBe(50);
    expect(dimensionPercentAt(formFields!, 'ASSERTED')).toBe(50);
  });
});

// ─── All thirteen, always ───────────────────────────────────────────────────

describe('the report lists every axis, including the ones nothing measured', () => {
  const report = coverageDimensionReport({ supplied: {} });

  it('returns thirteen measurements in the vocabulary order', () => {
    /*
     * An axis OMITTED from the list is an axis a reader cannot see we do not
     * measure, and invisible raises the perceived completeness of a report
     * exactly as an unenumerated state raises a percentage.
     */
    expect(report.measurements.map((m) => m.dimension)).toEqual([...COVERAGE_DIMENSIONS]);
  });

  it('reports NULL at every rung for an axis with no extractor, not 0', () => {
    const roleCell = dimensionReading(report, 'ROLE_CELL')!;
    expect(dimensionWasMeasured(roleCell)).toBe(false);
    // Every rung, not one: a renderer that checks only the top rung would print
    // 0% for the rest, which is the lie in its most common form.
    for (const tier of COVERAGE_TIERS) {
      expect(dimensionPercentAt(roleCell, tier), tier).toBeNull();
    }
  });

  it('tells "no extractor" apart from "the extractor was given no facts"', () => {
    /*
     * Two unmeasured axes, two different reasons, two different remedies: wait
     * for us to build one, versus run a crawl. Collapsing them would make every
     * shortfall look like the same shrug.
     */
    expect(dimensionReading(report, 'ROLE_CELL')?.unmeasuredReason).toBe('NO_EXTRACTOR');
    expect(dimensionReading(report, 'PAGE_STATE')?.unmeasuredReason).toBe('NOT_ENUMERATED');
  });

  it('keeps a known cell count on an axis it could not score', () => {
    // ROLE_CELL's whole point: the denominator is known and the percentage is
    // not. "0 of 198 measured" is a far more useful sentence than "not
    // measured", and it is still not a percentage.
    const withCells = coverageDimensionReport({ supplied: {}, knownCells: { ROLE_CELL: 198 } });
    const roleCell = dimensionReading(withCells, 'ROLE_CELL')!;
    expect(roleCell.cells).toBe(198);
    expect(roleCell.measured).toBe(0);
    expect(roleCell.unmeasured).toBe(198);
    expect(dimensionPercentAt(roleCell, 'ASSERTED')).toBeNull();
  });

  it('produces measurements dimensionMeasurementSchema accepts', () => {
    // The write path is not in this package, so the proof that these readings
    // can be stored is the schema that guards the column.
    for (const measurement of report.measurements) {
      expect(() => dimensionMeasurementSchema.parse(measurement), measurement.dimension).not.toThrow();
    }
  });
});

// ─── The two refusals ───────────────────────────────────────────────────────

describe('the report refuses a reading filed on the wrong axis', () => {
  it('refuses a measurement whose dimension disagrees with its key', () => {
    /*
     * A COMPONENT_STATE reading filed under COMPONENT would be counted on the
     * wrong denominator and stored where no component reader looks, and nothing
     * downstream could see that the figure was wrong.
     */
    expect(() =>
      coverageDimensionReport({ supplied: { COMPONENT: reading('COMPONENT_STATE') } }),
    ).toThrow(/COMPONENT_STATE measurement was supplied under COMPONENT/);
  });

  it('refuses a measurement for an axis the registry says nothing measures', () => {
    expect(() =>
      coverageDimensionReport({ supplied: { ROLE_CELL: reading('ROLE_CELL') } }),
    ).toThrow(/recorded as unmeasured in DIMENSION_REGISTRY/);
  });

  it('refuses to call a measured axis unmeasured', () => {
    // The mirror of the rule above, on the constructor rather than the
    // assembler: reporting a measurement we took as one we did not is the same
    // lie pointing the other way.
    expect(() => unmeasuredDimensionReading('PAGE_STATE')).toThrow(/HAS a producer/);
  });
});

// ─── Caps, as a count and a reason ──────────────────────────────────────────

describe('caps that bit are collected onto the report', () => {
  const capped = measuredDimension({
    dimension: 'FORM_FIELD',
    measuredCells: ['ASSERTED'],
    unmeasured: 240,
    unmeasuredReason: 'CAP_BIT',
    unmeasuredDetail: 'maxFields stopped the read at 60 fields',
    caps: [
      {
        cap: 'maxFields',
        limit: 60,
        atLeastMore: 240,
        detail: 'at least 240 more form fields existed on this project',
      },
    ],
  });

  it('reports the bite as a count AND a reason on the report itself', () => {
    /*
     * Rule 10 is a property of the REPORT and not only of a measurement: a
     * caller rendering the headline must be able to say "at least 240 more form
     * fields existed" without walking thirteen measurements to find out.
     */
    const report = coverageDimensionReport({ supplied: { FORM_FIELD: capped } });
    expect(report.caps).toHaveLength(1);
    expect(report.caps[0]?.atLeastMore).toBe(240);
    expect(report.caps[0]?.detail).toContain('240 more');
  });

  it('collects no cap from an axis that was not truncated', () => {
    const report = coverageDimensionReport({ supplied: { PAGE_STATE: reading('PAGE_STATE') } });
    expect(report.caps).toEqual([]);
  });
});

// ─── The attestation disclosures ────────────────────────────────────────────

describe('the unmeasured axes an attestation has to disclose', () => {
  it('names every axis that measured nothing, with its reason and its sentence', () => {
    const report = coverageDimensionReport({ supplied: { PAGE_STATE: reading('PAGE_STATE') } });
    const disclosures = dimensionUnmeasuredDisclosures(report);
    // Twelve of thirteen: PAGE_STATE was measured, the other twelve were not.
    expect(disclosures).toHaveLength(12);
    expect(disclosures.map((entry) => entry.dimension)).not.toContain('PAGE_STATE');
    for (const entry of disclosures) {
      expect(entry.detail.length, String(entry.dimension)).toBeGreaterThan(40);
      expect(entry.kind, String(entry.dimension)).toBeNull();
    }
  });

  it('maps a zero cell count to NULL, because 0 would claim no cells exist', () => {
    const report = coverageDimensionReport({ supplied: {}, knownCells: { ROLE_CELL: 198 } });
    const byAxis = new Map(
      dimensionUnmeasuredDisclosures(report).map((entry) => [entry.dimension, entry]),
    );
    // ROLE_CELL's count is known; PAGE_STATE's is not, and `cells: 0` there
    // would be published as "no page states exist", which is the opposite claim.
    expect(byAxis.get('ROLE_CELL')?.cells).toBe(198);
    expect(byAxis.get('PAGE_STATE')?.cells).toBeNull();
  });

  it('omits an axis with a disclosed shortfall, so no axis appears twice', () => {
    /*
     * A measurement with SOME cells measured carries its own shortfall. Listing
     * it in the scope section as well would make one axis appear twice in the
     * one part of the document whose whole job is to be countable.
     */
    const partial = measuredDimension({
      dimension: 'DEVICE_LOCALE',
      measuredCells: ['ASSERTED'],
      unmeasured: 9,
      unmeasuredReason: 'NOT_ENUMERATED',
      unmeasuredDetail: 'nine locale cells were never enumerated',
    });
    const report = coverageDimensionReport({ supplied: { DEVICE_LOCALE: partial } });
    expect(dimensionUnmeasuredDisclosures(report).map((entry) => entry.dimension)).not.toContain(
      'DEVICE_LOCALE',
    );
  });

  it('skips a hand-built reading with no reason rather than inventing one', () => {
    /*
     * Neither constructor can produce this, so reaching the branch means a
     * literal got in. Defaulting it to NO_EXTRACTOR would put our own guess in
     * a procurement document.
     */
    const forged: DimensionMeasurement = {
      dimension: 'PAGE_STATE',
      cells: 4,
      measured: 0,
      unmeasured: 4,
      unmeasuredReason: null,
      unmeasuredDetail: null,
      tiers: coverageLadder([]),
      caps: [],
    };
    const report: Parameters<typeof dimensionUnmeasuredDisclosures>[0] = {
      measurements: [forged],
      measured: [],
      unmeasured: [],
      producers: DIMENSION_REGISTRY,
      caps: [],
      rule: DIMENSIONS_NEVER_SUMMED,
    };
    expect(dimensionUnmeasuredDisclosures(report)).toEqual([]);
  });
});
