import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EDGE_SOURCES,
  COVERAGE_EDGE_SOURCE_CEILING,
  COVERAGE_EDGE_SOURCE_RANK,
  COVERAGE_TIERS,
  COVERAGE_TIER_EVIDENCE,
  COVERAGE_TIER_IS_OBSERVED,
  COVERAGE_TIER_LABELS,
  COVERAGE_TIER_RANK,
  DEFAULT_COVERAGE_FRESHNESS_DAYS,
  MINIMUM_COVERED_TIER,
  TIER_CAP_REASONS,
  TIER_CAP_REASON_LABELS,
  coverageLadder,
  edgeSourceOutranks,
  isFreshConfirmation,
  nextTier,
  promoteCoverageTier,
  resolveCoverageEdges,
  surfaceStatusForTier,
  tierAtLeast,
  type CoverageEdgeEvidence,
  type CoverageTier,
} from './coverage-tiers';
import { coverageEdgeSourceSchema, coverageTierSchema, tierCapReasonSchema } from './schemas';

/**
 * The ladder, and the five lies it exists to separate.
 *
 * ── Why the parity assertions come first ───────────────────────────────────
 *
 * `coverageTierSchema` is the ONLY write path to `TestCoverageEdge.tier`.
 * Twelve arms of `gateRuleSchema` and a `Record<GateRule['kind'], true>` exist
 * because eight gate kinds could not be saved for two slices with nothing
 * anywhere to notice — `check:wiring` looks for a FILE nobody reaches, and a
 * vocabulary member with no write path is live code in a reached file.
 *
 * So this file holds the run-time half of the guard the compiler cannot
 * provide: `COVERAGE_TIERS` against the zod enum's own options, which exist
 * only at run time. The compile-time half is the `Record<CoverageTier, …>`
 * tables — a sixth rung added to the array fails to compile until somebody
 * states its rank, its label and the evidence that earns it.
 */

describe('the ladder is a closed vocabulary with a write path', () => {
  it('has one zod option per rung, and no others', () => {
    expect([...coverageTierSchema.options].sort()).toEqual([...COVERAGE_TIERS].sort());
  });

  it('names every rung the ladder names — spelled out, so a failure reads', () => {
    // The same assertion phrased so the diff says WHICH rung cannot be stored,
    // rather than printing two lists for a reader to compare by eye.
    const inZod = new Set<string>(coverageTierSchema.options);
    expect(COVERAGE_TIERS.filter((tier) => !inZod.has(tier))).toEqual([]);
  });

  it('has one zod option per edge source, and one per cap reason', () => {
    expect([...coverageEdgeSourceSchema.options].sort()).toEqual([...COVERAGE_EDGE_SOURCES].sort());
    expect([...tierCapReasonSchema.options].sort()).toEqual([...TIER_CAP_REASONS].sort());
  });

  it('pins the five rungs by name and in order', () => {
    // Order IS the contract: `COVERAGE_TIER_RANK` is read as a total ordering
    // by `tierAtLeast`, `resolveCoverageEdges` and `coverageLadder`, and a
    // reordering would silently change what "34% passing" counts.
    expect([...COVERAGE_TIERS]).toEqual(['DECLARED', 'NAVIGATED', 'ASSERTED', 'PASSING', 'FRESH']);
  });

  it('gives every rung a rank, a label and a stated evidence sentence', () => {
    // The Records are compiler-enforced, so this is the run-time half: it also
    // catches a rung whose evidence sentence was left as an empty string, which
    // the type system permits and an auditor cannot use.
    for (const tier of COVERAGE_TIERS) {
      expect(COVERAGE_TIER_RANK[tier]).toBeGreaterThan(0);
      expect(COVERAGE_TIER_LABELS[tier].length).toBeGreaterThan(0);
      expect(COVERAGE_TIER_EVIDENCE[tier].length).toBeGreaterThan(20);
    }
    for (const reason of TIER_CAP_REASONS) {
      expect(TIER_CAP_REASON_LABELS[reason].length).toBeGreaterThan(10);
    }
  });

  it('ranks the rungs strictly increasingly in declaration order', () => {
    const ranks = COVERAGE_TIERS.map((tier) => COVERAGE_TIER_RANK[tier]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('has no duplicate member in any of the three vocabularies', () => {
    for (const vocabulary of [COVERAGE_TIERS, COVERAGE_EDGE_SOURCES, TIER_CAP_REASONS]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});

describe('DECLARED is visibly weaker than everything above it', () => {
  it('is the only rung that rests on a claim rather than an observation', () => {
    /*
     * THE COMMERCIAL ASSERTION. Conflating "a regex found this string in a spec
     * file" with "a run asserted this and passed" is how every number in this
     * market is built, and this single `false` is where the product refuses to.
     * If someone later marks DECLARED as observed, every report that separates
     * claims from evidence silently stops separating them.
     */
    expect(COVERAGE_TIER_IS_OBSERVED.DECLARED).toBe(false);
    for (const tier of COVERAGE_TIERS.filter((t) => t !== 'DECLARED')) {
      expect(COVERAGE_TIER_IS_OBSERVED[tier]).toBe(true);
    }
  });

  it('caps STATIC and SPEC evidence at DECLARED and lets only RUNTIME climb', () => {
    // The one line that stops `covers: ['ROUTE:/billing']` manufacturing a
    // green coverage report.
    expect(COVERAGE_EDGE_SOURCE_CEILING.STATIC).toBe('DECLARED');
    expect(COVERAGE_EDGE_SOURCE_CEILING.SPEC).toBe('DECLARED');
    expect(COVERAGE_EDGE_SOURCE_CEILING.RUNTIME).toBe('FRESH');
  });

  it('ranks RUNTIME above SPEC above STATIC', () => {
    expect(edgeSourceOutranks('RUNTIME', 'STATIC')).toBe(true);
    expect(edgeSourceOutranks('RUNTIME', 'SPEC')).toBe(true);
    expect(edgeSourceOutranks('SPEC', 'STATIC')).toBe(true);
    expect(edgeSourceOutranks('STATIC', 'RUNTIME')).toBe(false);
    expect(edgeSourceOutranks('STATIC', 'STATIC')).toBe(false);
    expect(new Set(Object.values(COVERAGE_EDGE_SOURCE_RANK)).size).toBe(
      COVERAGE_EDGE_SOURCES.length,
    );
  });

  it('draws COVERED at NAVIGATED, which is where surface.ts draws it', () => {
    /*
     * The two vocabularies are pinned to each other here. `SURFACE_STATUSES`
     * says COVERED means a matched test "has been observed to run" and
     * ASSERTED_NOT_RUN means it has not; if this floor moved to DECLARED, a
     * regex match would start reading as COVERED and there would be two
     * definitions of covered in one product — which is two percentages.
     */
    expect(MINIMUM_COVERED_TIER).toBe('NAVIGATED');
    expect(surfaceStatusForTier('DECLARED')).toBe('ASSERTED_NOT_RUN');
    expect(surfaceStatusForTier('NAVIGATED')).toBe('COVERED');
    expect(surfaceStatusForTier('FRESH')).toBe('COVERED');
    expect(surfaceStatusForTier(null)).toBe('UNCOVERED');
  });
});

describe('tierAtLeast', () => {
  it('treats null as satisfying nothing, not as the weakest rung', () => {
    // NOT MEASURED IS NULL. If `tierAtLeast(null, 'DECLARED')` were true, every
    // item nothing claims would count as declared and the bottom of the ladder
    // would read 100%.
    expect(tierAtLeast(null, 'DECLARED')).toBe(false);
    expect(tierAtLeast(null, 'FRESH')).toBe(false);
  });

  it('is monotonic — a rung satisfies itself and everything below it', () => {
    for (const tier of COVERAGE_TIERS) {
      for (const floor of COVERAGE_TIERS) {
        expect(tierAtLeast(tier, floor)).toBe(
          COVERAGE_TIER_RANK[tier] >= COVERAGE_TIER_RANK[floor],
        );
      }
    }
  });

  it('walks up the ladder and stops at the top', () => {
    expect(nextTier('DECLARED')).toBe('NAVIGATED');
    expect(nextTier('PASSING')).toBe('FRESH');
    expect(nextTier('FRESH')).toBeNull();
  });
});

/** A RUNTIME edge that reached the top, as the base every case below edits. */
const FRESH_RUNTIME: CoverageEdgeEvidence = {
  source: 'RUNTIME',
  navigationObserved: true,
  assertionObserved: true,
  runStatus: 'PASSED',
  retriedAndPassed: false,
  quarantined: false,
  confirmedAtIso: '2026-10-25T00:00:00.000Z',
};
const NOW = '2026-10-26T00:00:00.000Z';

describe('promoteCoverageTier', () => {
  it('reaches FRESH only with navigation, an assertion, a clean pass and a recent one', () => {
    const verdict = promoteCoverageTier(FRESH_RUNTIME, NOW);
    expect(verdict.tier).toBe('FRESH');
    expect(verdict.reached).toBe('FRESH');
    expect(verdict.cappedBy).toBeNull();
    expect(verdict.blockedBy).toBeNull();
    expect(verdict.freshnessDays).toBe(DEFAULT_COVERAGE_FRESHNESS_DAYS);
  });

  it('stops at DECLARED when nothing ran, and says so', () => {
    // WRITTEN IS NOT RUN. A test file is not a run, however much of it a regex
    // can read.
    const verdict = promoteCoverageTier(
      { ...FRESH_RUNTIME, runStatus: null, navigationObserved: false, confirmedAtIso: null },
      NOW,
    );
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.blockedBy).toBe('NO_RUN_OBSERVED');
    expect(verdict.why).toContain('no run has executed');
  });

  it('treats a SKIPPED run as not having run', () => {
    // A skipped test asserted nothing — the same rule
    // `SurfaceVerification.executed` already applies.
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, runStatus: 'SKIPPED' }, NOW);
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.blockedBy).toBe('NO_RUN_OBSERVED');
  });

  it('stops at NAVIGATED when the run reached it and asserted nothing', () => {
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, assertionObserved: false }, NOW);
    expect(verdict.tier).toBe('NAVIGATED');
    expect(verdict.blockedBy).toBe('NO_ASSERTION_OBSERVED');
  });

  it('stops at ASSERTED when the run failed — covered AND failing are two facts', () => {
    /*
     * A FAILING TEST IS COVERAGE. Calling this uncovered would be the sentence
     * "no test has ever asserted anything about this" said about a surface
     * whose test asserts something and finds a bug.
     */
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, runStatus: 'FAILED' }, NOW);
    expect(verdict.tier).toBe('ASSERTED');
    expect(verdict.blockedBy).toBe('RUN_NOT_PASSED');
    expect(tierAtLeast(verdict.tier, MINIMUM_COVERED_TIER)).toBe(true);
    expect(surfaceStatusForTier(verdict.tier)).toBe('COVERED');
  });

  it('refuses PASSING for a test that only passed on a retry', () => {
    // §5 — a retry that passes is not a pass.
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, retriedAndPassed: true }, NOW);
    expect(verdict.tier).toBe('ASSERTED');
    expect(verdict.blockedBy).toBe('RETRY_PASS_NOT_A_PASS');
  });

  it('stops at PASSING when the pass is older than the window', () => {
    const verdict = promoteCoverageTier(
      { ...FRESH_RUNTIME, confirmedAtIso: '2026-09-01T00:00:00.000Z' },
      NOW,
    );
    expect(verdict.tier).toBe('PASSING');
    expect(verdict.blockedBy).toBe('CONFIRMATION_STALE');
  });

  it('honours an explicit freshness window and reports the one it used', () => {
    const stale = { ...FRESH_RUNTIME, confirmedAtIso: '2026-10-16T00:00:00.000Z' };
    expect(promoteCoverageTier(stale, NOW, 30).tier).toBe('FRESH');
    expect(promoteCoverageTier(stale, NOW, 30).freshnessDays).toBe(30);
    expect(promoteCoverageTier(stale, NOW, 3).tier).toBe('PASSING');
  });

  it('does not treat an undatable pass as stale, and does not call it fresh', () => {
    // "We cannot date this pass" is not "this pass is old". Demoting on an
    // unparseable timestamp would make a clock problem look like a rotting
    // suite; promoting would claim freshness from our own silence.
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, confirmedAtIso: 'not a date' }, NOW);
    expect(verdict.tier).toBe('PASSING');
    expect(verdict.blockedBy).toBe('CONFIRMATION_STALE');
  });

  it('caps a quarantined test at DECLARED, however well it ran', () => {
    /*
     * COVERAGE MUST NOT BE ATTRIBUTED TO A QUARANTINED TEST. Its result is
     * suppressed from every gate in the product, so counting it as observed
     * evidence means the coverage number rests on a result nothing will ever
     * check. The claim survives; the evidence does not.
     */
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, quarantined: true }, NOW);
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.reached).toBe('FRESH');
    expect(verdict.cappedBy).toBe('TEST_QUARANTINED');
    expect(verdict.why).toContain('quarantined');
  });

  it('caps a STATIC edge at DECLARED and names the reason, not the evidence', () => {
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, source: 'STATIC' }, NOW);
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.reached).toBe('FRESH');
    expect(verdict.cappedBy).toBe('STATIC_EVIDENCE_ONLY');
  });

  it('caps a SPEC edge at DECLARED with its own reason', () => {
    // A declaration is a claim. The reason differs from STATIC's because the
    // remedy differs: one asks for a run, the other asks whether the regex is
    // even right.
    const verdict = promoteCoverageTier({ ...FRESH_RUNTIME, source: 'SPEC' }, NOW);
    expect(verdict.tier).toBe('DECLARED');
    expect(verdict.cappedBy).toBe('DECLARATION_ONLY');
  });

  it('never returns a tier above its source ceiling, for any combination', () => {
    /*
     * The exhaustive version, because the three cases above are the ones
     * somebody remembered. This one is satisfied only by the ceiling actually
     * being applied, for all 2^4 x 3 x 6 combinations of evidence.
     */
    for (const source of COVERAGE_EDGE_SOURCES) {
      for (const runStatus of [null, 'PASSED', 'FAILED', 'SKIPPED', 'FLAKY', 'TIMED_OUT'] as const) {
        for (const navigationObserved of [true, false]) {
          for (const assertionObserved of [true, false]) {
            for (const retriedAndPassed of [true, false]) {
              for (const quarantined of [true, false]) {
                const verdict = promoteCoverageTier(
                  {
                    source,
                    navigationObserved,
                    assertionObserved,
                    runStatus,
                    retriedAndPassed,
                    quarantined,
                    confirmedAtIso: FRESH_RUNTIME.confirmedAtIso,
                  },
                  NOW,
                );
                expect(verdict.tier).not.toBeNull();
                expect(
                  tierAtLeast(verdict.tier, COVERAGE_EDGE_SOURCE_CEILING[source]) &&
                    verdict.tier !== COVERAGE_EDGE_SOURCE_CEILING[source],
                  `${source} reached ${verdict.tier}`,
                ).toBe(false);
                if (quarantined) expect(verdict.tier).toBe('DECLARED');
              }
            }
          }
        }
      }
    }
  });

  it('always states a reason unless the edge is at the very top', () => {
    // Every rung an item did not reach has a reason, and the reason is the only
    // actionable half of a coverage report.
    const top = promoteCoverageTier(FRESH_RUNTIME, NOW);
    expect(top.cappedBy ?? top.blockedBy).toBeNull();
    const notTop = promoteCoverageTier({ ...FRESH_RUNTIME, assertionObserved: false }, NOW);
    expect(notTop.cappedBy ?? notTop.blockedBy).not.toBeNull();
  });
});

describe('isFreshConfirmation', () => {
  it('returns null rather than false when a timestamp cannot be read', () => {
    expect(isFreshConfirmation('yesterday', NOW)).toBeNull();
    expect(isFreshConfirmation(NOW, 'soon')).toBeNull();
  });

  it('counts a future confirmation as fresh, so clock skew is not read as rot', () => {
    expect(isFreshConfirmation('2026-11-01T00:00:00.000Z', NOW)).toBe(true);
  });

  it('is inclusive at the boundary', () => {
    // Exactly the window is inside it. An exclusive boundary would make a
    // suite that runs every 7 days alternate between FRESH and PASSING.
    expect(isFreshConfirmation('2026-10-19T00:00:00.000Z', NOW, 7)).toBe(true);
    expect(isFreshConfirmation('2026-10-18T23:00:00.000Z', NOW, 7)).toBe(false);
  });
});

describe('resolveCoverageEdges', () => {
  it('returns null with no edges — not DECLARED', () => {
    const resolved = resolveCoverageEdges([]);
    expect(resolved.tier).toBeNull();
    expect(resolved.authoritative).toBeNull();
    expect(resolved.conflicting).toBe(false);
  });

  it('takes the highest rung, so adding a weak test cannot lower an item', () => {
    const resolved = resolveCoverageEdges([
      { source: 'STATIC', tier: 'DECLARED' },
      { source: 'RUNTIME', tier: 'PASSING' },
    ]);
    expect(resolved.tier).toBe('PASSING');
    expect(resolved.authoritative?.source).toBe('RUNTIME');
  });

  it('lets RUNTIME win a tie, because one is evidence and the other is a regex', () => {
    const resolved = resolveCoverageEdges([
      { source: 'STATIC', tier: 'DECLARED' },
      { source: 'RUNTIME', tier: 'DECLARED' },
      { source: 'SPEC', tier: 'DECLARED' },
    ]);
    expect(resolved.tier).toBe('DECLARED');
    expect(resolved.authoritative?.source).toBe('RUNTIME');
    expect(resolved.conflicting).toBe(false);
  });

  it('reports a disagreement instead of maxing it away', () => {
    /*
     * A RUNTIME edge stuck at DECLARED beside a STATIC one claiming the same
     * thing is how you discover a test that MENTIONS a route it never visits.
     * Silently taking the max would hide the finding inside the number.
     */
    const resolved = resolveCoverageEdges([
      { source: 'RUNTIME', tier: 'NAVIGATED' },
      { source: 'STATIC', tier: 'DECLARED' },
    ]);
    expect(resolved.conflicting).toBe(true);
    expect(resolved.tier).toBe('NAVIGATED');
  });

  it('carries the caller’s own row shape through, so nothing has to be mapped', () => {
    const resolved = resolveCoverageEdges([
      { source: 'RUNTIME', tier: 'ASSERTED', id: 'edge_1', evidence: 'reached /orders/42' },
    ]);
    expect(resolved.authoritative?.id).toBe('edge_1');
  });
});

describe('coverageLadder', () => {
  it('is cumulative, so the series can only fall as the bar rises', () => {
    const entries: Array<CoverageTier | null> = [
      'FRESH',
      'PASSING',
      'ASSERTED',
      'NAVIGATED',
      'DECLARED',
      null,
    ];
    const ladder = coverageLadder(entries);
    expect(ladder.denominator).toBe(6);
    expect(ladder.unclaimed).toBe(1);
    expect(ladder.tiers.map((t) => t.atOrAbove)).toEqual([5, 4, 3, 2, 1]);
    // The reading the whole file exists to make sayable: two figures from one
    // measurement, not two measurements.
    expect(ladder.tiers.find((t) => t.tier === 'DECLARED')?.percent).toBe(83.3);
    expect(ladder.tiers.find((t) => t.tier === 'PASSING')?.percent).toBe(33.3);
  });

  it('never rises as the bar rises, for any mix', () => {
    const ladder = coverageLadder([null, 'DECLARED', 'DECLARED', 'FRESH', 'NAVIGATED']);
    const counts = ladder.tiers.map((t) => t.atOrAbove);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('reports NULL and not 0 or 100 when there is nothing to divide', () => {
    /*
     * `percent` is NULL, never 0 and never 100, when the denominator is zero.
     * An empty denominator means our extractor found nothing, and printing
     * either number would be a claim about the customer's application made from
     * our own silence.
     */
    const ladder = coverageLadder([]);
    expect(ladder.denominator).toBe(0);
    for (const tier of ladder.tiers) {
      expect(tier.percent).toBeNull();
      expect(tier.atOrAbove).toBe(0);
    }
  });

  it('keeps unclaimed items IN the denominator', () => {
    // An item nothing claims is the gap this product exists to shrink. Dropping
    // it would raise every figure on the ladder at once.
    const ladder = coverageLadder([null, null, 'FRESH']);
    expect(ladder.denominator).toBe(3);
    expect(ladder.tiers.find((t) => t.tier === 'DECLARED')?.percent).toBe(33.3);
  });
});
