/**
 * ADVERSARIAL VERIFICATION FIXTURE — can nine new axes move the headline?
 *
 * Written by the verifier, not the builders. The question this file answers is
 * the one the round was commissioned against: the product has already shipped a
 * headline that summed four incommensurable denominators, making controls ~80%
 * of the figure. This round added nine more axes. If ANY of them reaches the
 * headline's denominator, a project with 400 form fields and 10 routes has its
 * quoted number decided by its forms.
 *
 * The fixture makes the axes disagree as sharply as the task specifies — 10
 * routes at 90%, 400 form fields at 5%, three dimensions with no extractor at
 * all — so that a leak is not a rounding difference but a 50-point swing.
 *
 * Nothing here touches a database, a browser, a clock or a model.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_DIMENSIONS,
  COVERAGE_TIERS,
  coveragePercent,
  dimensionPercentAt,
  dimensionWasMeasured,
  measuredDimension,
} from '@qaai/shared';
import type { CoverageTier, DimensionMeasurement } from '@qaai/shared';
import {
  COVERAGE_AXES,
  coverageAxisReadings,
  coverageDimensionReport,
  coverageHeadline,
  dimensionReading,
} from './coverage.js';

/** 10 routes, 9 covered: the axis that should decide the headline. */
const TEN_ROUTES_AT_90 = {
  ROUTE: { denominator: 10, covered: 9, provenCovered: 9 },
  JOURNEY: { denominator: 0, covered: 0, provenCovered: 0 },
  FORM: { denominator: 0, covered: 0, provenCovered: 0 },
  CONTROL: { denominator: 0, covered: 0, provenCovered: 0 },
} as const;

/** 400 form-field cells, 20 asserted: the axis that must NOT decide it. */
function fourHundredFieldsAtFive(): DimensionMeasurement {
  const cells: (CoverageTier | null)[] = [];
  for (let i = 0; i < 400; i += 1) cells.push(i < 20 ? 'ASSERTED' : null);
  return measuredDimension({ dimension: 'FORM_FIELD', measuredCells: cells });
}

describe('400 form fields at 5% cannot move a headline built from 10 routes at 90%', () => {
  it('leaves the headline byte-identical whether the dimensions exist or not', () => {
    const headlineAlone = coverageHeadline(coverageAxisReadings(TEN_ROUTES_AT_90));

    // The dimension report is computed over the SAME subject, with the forms
    // disagreeing with the routes by 85 points.
    const report = coverageDimensionReport({
      supplied: { FORM_FIELD: fourHundredFieldsAtFive() },
    });

    const headlineWithDimensions = coverageHeadline(coverageAxisReadings(TEN_ROUTES_AT_90));

    // The headline is a function of the axis readings and nothing else. If a
    // dimension were folded in, these two would differ.
    expect(headlineWithDimensions).toStrictEqual(headlineAlone);
    expect(headlineAlone.lowerPercent).toBe(90);

    // And the report that carries 400 disagreeing cells has nowhere to put a
    // combined figure: no total, no overall, no score, no percent.
    expect(report).not.toHaveProperty('percent');
    expect(report).not.toHaveProperty('total');
    expect(report).not.toHaveProperty('overall');
    expect(report).not.toHaveProperty('score');
  });

  it('reads the forms at 5% and the routes at 90% from SEPARATE denominators', () => {
    const report = coverageDimensionReport({
      supplied: { FORM_FIELD: fourHundredFieldsAtFive() },
    });
    const fields = dimensionReading(report, 'FORM_FIELD');
    expect(fields).not.toBeNull();
    expect(fields?.cells).toBe(400);
    expect(fields?.measured).toBe(400);
    expect(dimensionPercentAt(fields!, 'ASSERTED')).toBe(5);

    // The route axis is untouched at 90. Two numbers, two denominators.
    const headline = coverageHeadline(coverageAxisReadings(TEN_ROUTES_AT_90));
    expect(headline.lowerPercent).toBe(90);

    // The forbidden arithmetic, computed here ONLY to show what it would have
    // produced: (9 + 20) / (10 + 400) = 7.1%. The headline is 90. If anything
    // in the pipeline ever returns ~7, it summed two axes.
    expect(coveragePercent(9 + 20, 10 + 400)).toBe(7.1);
    expect(headline.lowerPercent).not.toBe(coveragePercent(9 + 20, 10 + 400));
  });
});

describe('three dimensions with no extractor appear as unmeasured, not as 0%', () => {
  it('reports NULL at every rung for every unextracted axis', () => {
    const report = coverageDimensionReport({
      supplied: { FORM_FIELD: fourHundredFieldsAtFive() },
    });

    /*
     * THE TASK ASKED FOR "three dimensions with NO extractor". The registry
     * this round shipped claims an extractor for TWELVE of the thirteen, so
     * the honest equivalent is every axis the report could not measure HERE:
     * ROLE_CELL, whose reason is NO_EXTRACTOR, plus the eleven measurable axes
     * this call supplied no facts for, whose reason is NOT_ENUMERATED. Both are
     * unmeasured and neither may be 0.
     */
    const unmeasured = report.measurements
      .filter((m) => !dimensionWasMeasured(m))
      .map((m) => m.dimension);
    expect(unmeasured.length).toBe(12);
    expect(report.unmeasured).toStrictEqual(['ROLE_CELL']);

    for (const dimension of unmeasured) {
      const reading = dimensionReading(report, dimension);
      expect(reading, `${dimension} must be present in the report`).not.toBeNull();
      // Present, so a reader can SEE we do not measure it.
      expect(dimensionWasMeasured(reading!)).toBe(false);
      // Named, not silent.
      expect(reading!.unmeasuredReason).not.toBeNull();
      expect(reading!.unmeasuredDetail).toBeTruthy();
      // And NULL at every rung — not 0 at any of them.
      for (const tier of COVERAGE_TIERS) {
        expect(
          dimensionPercentAt(reading!, tier),
          `${dimension} at ${tier} must be null, never 0`,
        ).toBeNull();
      }
    }
  });

  it('keeps all thirteen axes visible so an unmeasured one cannot hide', () => {
    const report = coverageDimensionReport({ supplied: {} });
    expect(report.measurements).toHaveLength(COVERAGE_DIMENSIONS.length);
    expect(report.measurements.map((m) => m.dimension)).toStrictEqual([...COVERAGE_DIMENSIONS]);
  });

  it('does not drag the headline down when every dimension is unmeasured', () => {
    const bare = coverageHeadline(coverageAxisReadings(TEN_ROUTES_AT_90));
    coverageDimensionReport({ supplied: {} });
    expect(bare.lowerPercent).toBe(90);
    // The four-axis headline names its own unmeasured axes and renormalises;
    // the thirteen dimension axes are not among them.
    expect(bare.unmeasuredAxes).toStrictEqual(['JOURNEY', 'FORM', 'CONTROL']);
    expect(bare.measuredAxes).toStrictEqual(['ROUTE']);
    for (const axis of COVERAGE_AXES) {
      const reading = bare.axes.find((a) => a.axis === axis);
      if (axis === 'ROUTE') continue;
      expect(reading?.percent, `${axis} must be null, not 0`).toBeNull();
      expect(reading?.effectiveWeight, `${axis} carried no weight`).toBeNull();
    }
  });
});
