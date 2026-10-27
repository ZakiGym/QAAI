/**
 * ADVERSARIAL VERIFICATION — can the honesty contracts be bypassed?
 *
 * Written by the verifier. The builders claim four refusals; this file tries to
 * get past each one by the route a careless writer would actually take, which
 * is not the constructor but a hand-built object literal handed straight to
 * zod. A contract held only by a constructor is a convention; a contract held
 * by the schema as well is a rule, and the difference matters because the write
 * path is the schema and not the constructor.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_TIERS,
  coverageLadder,
  coverageRollupSchema,
  dimensionMeasurementSchema,
  dimensionPercentAt,
  measuredDimension,
  rollupScopeKey,
  unmeasuredDimension,
} from './index.js';

describe('an unmeasured measurement with no reason cannot be built OR parsed', () => {
  it('refuses it through the constructor', () => {
    expect(() =>
      measuredDimension({
        dimension: 'FORM_FIELD',
        measuredCells: ['ASSERTED'],
        unmeasured: 400,
        // no reason
      }),
    ).toThrow(/unmeasured cell\(s\) with no reason/);
  });

  it('refuses a HAND-BUILT literal that bypasses the constructor entirely', () => {
    /*
     * The shape a writer produces when they assemble the object themselves
     * because the constructor was inconvenient. `cells` and `measured` are
     * internally consistent, so only the reason contract can catch this.
     */
    const smuggled = {
      dimension: 'FORM_FIELD',
      cells: 401,
      measured: 1,
      unmeasured: 400,
      unmeasuredReason: null,
      unmeasuredDetail: null,
      tiers: coverageLadder(['ASSERTED']),
      caps: [],
    };
    const parsed = dimensionMeasurementSchema.safeParse(smuggled);
    expect(parsed.success).toBe(false);
  });

  it('refuses a literal whose unmeasuredReason key is simply ABSENT', () => {
    const smuggled = {
      dimension: 'FORM_FIELD',
      cells: 401,
      measured: 1,
      unmeasured: 400,
      unmeasuredDetail: null,
      tiers: coverageLadder(['ASSERTED']),
      caps: [],
    };
    expect(dimensionMeasurementSchema.safeParse(smuggled).success).toBe(false);
  });

  it('refuses a ladder whose denominator is not the measured count', () => {
    /*
     * The attack that would make `dimensionPercentAt` divide by the wrong
     * number: claim 400 measured cells and hand it a one-cell ladder, so the
     * figure reads 100%.
     */
    const smuggled = {
      dimension: 'FORM_FIELD',
      cells: 400,
      measured: 400,
      unmeasured: 0,
      unmeasuredReason: null,
      unmeasuredDetail: null,
      tiers: coverageLadder(['ASSERTED']),
      caps: [],
    };
    expect(dimensionMeasurementSchema.safeParse(smuggled).success).toBe(false);
  });

  it('refuses a reading whose parts do not reconstruct its whole', () => {
    const smuggled = {
      dimension: 'FORM_FIELD',
      cells: 999,
      measured: 1,
      unmeasured: 1,
      unmeasuredReason: 'CAP_BIT',
      unmeasuredDetail: 'a cap bit',
      tiers: coverageLadder(['ASSERTED']),
      caps: [],
    };
    expect(dimensionMeasurementSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe('an unmeasured axis is NULL at every rung, never 0', () => {
  it('holds for the constructor', () => {
    const reading = unmeasuredDimension({
      dimension: 'ROLE_CELL',
      reason: 'NO_EXTRACTOR',
      detail: 'nothing in this build matches a test to a route x role cell',
      cells: 120,
    });
    expect(reading.cells).toBe(120);
    expect(reading.measured).toBe(0);
    for (const tier of COVERAGE_TIERS) {
      expect(dimensionPercentAt(reading, tier), `rung ${tier}`).toBeNull();
    }
  });

  it('holds after a zod round trip, so the write path cannot turn it into 0', () => {
    const reading = unmeasuredDimension({
      dimension: 'ROLE_CELL',
      reason: 'NO_EXTRACTOR',
      detail: 'nothing in this build matches a test to a route x role cell',
      cells: 120,
    });
    const parsed = dimensionMeasurementSchema.parse(reading);
    for (const tier of COVERAGE_TIERS) {
      expect(dimensionPercentAt(parsed, tier), `rung ${tier} after parse`).toBeNull();
    }
  });
});

describe('a rollup whose numerator exceeds its denominator cannot be parsed', () => {
  const base = {
    dimension: null,
    feature: null,
    teamId: null,
    tier: 'ASSERTED' as const,
    unmeasured: 0,
    unmeasuredReason: null,
    unmeasuredDetail: null,
    caps: [],
    exclusions: [],
  };

  it('refuses 11 covered of 10', () => {
    const row = {
      ...base,
      scopeKey: rollupScopeKey({ dimension: null, feature: null, teamId: null }),
      numerator: 11,
      denominator: 10,
      percent: 110,
    };
    expect(coverageRollupSchema.safeParse(row).success).toBe(false);
  });

  it('refuses a percent on an empty denominator', () => {
    const row = {
      ...base,
      scopeKey: rollupScopeKey({ dimension: null, feature: null, teamId: null }),
      numerator: 0,
      denominator: 0,
      percent: 0,
    };
    expect(coverageRollupSchema.safeParse(row).success).toBe(false);
  });

  it('accepts the honest version of the same row, so the refusals are not blanket', () => {
    const row = {
      ...base,
      scopeKey: rollupScopeKey({ dimension: null, feature: null, teamId: null }),
      numerator: 9,
      denominator: 10,
      percent: 90,
    };
    const parsed = coverageRollupSchema.safeParse(row);
    expect(parsed.success).toBe(true);
  });

  it('refuses a scopeKey that disagrees with its own filter columns', () => {
    const row = {
      ...base,
      dimension: 'FORM_FIELD' as const,
      // The key says headline; the columns say FORM_FIELD.
      scopeKey: rollupScopeKey({ dimension: null, feature: null, teamId: null }),
      numerator: 1,
      denominator: 10,
      percent: 10,
    };
    expect(coverageRollupSchema.safeParse(row).success).toBe(false);
  });
});
