/**
 * Accuracy — the tests for the numbers QAAI reports about itself.
 *
 * These are the only numbers in the product whose failure mode is flattering US
 * rather than the customer, so nearly every test below has a sibling asserting
 * that the number did NOT improve for the wrong reason: a mute that did not
 * become an acceptance, a never-run test that did not become a survival, a
 * SUPERSEDED heal that did not become a failure, an unattributed defect that did
 * not land on the uncovered side. Each of those is one line of arithmetic away
 * from a better-looking figure, which is why each has a named test.
 *
 * The parity block is first. This module declares a threshold and a vocabulary
 * locally because the shared originals are not on @qaai/shared's barrel yet, and
 * a mirror nothing checks is a mirror that drifts — so the threshold is compared
 * against the default the shared validator applies, through the package entry
 * point.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERED_STATUSES,
  EXCLUDED_STATUSES,
  HEAL_STATES,
  VERDICTS,
  validityBacktestSchema,
  validityVerdictSchema,
} from '@qaai/shared';
import {
  GENERATION_OUTCOMES,
  GENERATION_OUTCOME_KINDS,
  MINIMUM_VALIDITY_DEFECTS,
  UNRATED_GENERATION_OUTCOMES,
  backtestValidity,
  faultClassDetection,
  generationCohort,
  generationOutcomeOf,
  generationSurvival,
  loadLatestBenchmarkRun,
  loadLatestValidityBacktest,
  persistBenchmarkRun,
  persistValidityBacktest,
  triageAccuracy,
  yieldTelemetry,
  type AccuracyClient,
  type DefectRow,
  type GeneratedTestRow,
  type SurfaceStatusRow,
  type TriageVerdictRow,
  type ValidityBacktest,
} from './accuracy.js';

// ─── The mirrors ────────────────────────────────────────────────────────────

describe('the thresholds and vocabularies this module mirrors', () => {
  it('uses the same minimum defect count the shared validator defaults to', () => {
    // MINIMUM_BACKTEST_DEFECTS is not on the barrel, so it is read back through
    // the default `validityBacktestSchema` applies. If somebody changes the
    // shared constant this goes red here, which is the whole point of the
    // local copy having a guard.
    const parsed = validityBacktestSchema.parse({
      windowStartAtIso: '2026-01-01T00:00:00.000Z',
      windowEndAtIso: '2026-02-01T00:00:00.000Z',
      defectCount: 0,
      coveredSurfaceCount: 0,
      uncoveredSurfaceCount: 0,
      defectsOnCovered: 0,
      defectsOnUncovered: 0,
      escapedRateCovered: null,
      escapedRateUncovered: null,
      verdict: 'INSUFFICIENT_DATA',
      verdictDetail: '0 defects',
      defectSource: 'test',
      fingerprint: 'f',
    });
    expect(parsed.minimumDefects).toBe(MINIMUM_VALIDITY_DEFECTS);
  });

  it('only ever produces a verdict the write path accepts', () => {
    const verdicts = new Set(
      [0, MINIMUM_VALIDITY_DEFECTS].map(
        (count) => backtest({ defectCount: count }).verdict as string,
      ),
    );
    for (const verdict of verdicts) expect(validityVerdictSchema.options).toContain(verdict);
  });

  it('has a presence record covering every generation outcome', () => {
    // The pattern this codebase enforces: a compiler-enforced presence Record
    // AND a run-time parity check. Eight GateRule kinds shipped unsaveable for
    // two slices because only one of the two existed.
    expect([...GENERATION_OUTCOME_KINDS]).toEqual([...GENERATION_OUTCOMES]);
  });

  it('keeps NEVER_RUN out of the survival rate', () => {
    expect([...UNRATED_GENERATION_OUTCOMES]).toEqual(['NEVER_RUN']);
  });

  it('agrees with the shared statuses about what covered and excluded mean', () => {
    // backtestValidity branches on these two lists. If COVERED_STATUSES ever
    // grows to include ASSERTED_NOT_RUN, this module's covered side silently
    // grows with it — so the assumption is asserted where it is relied on.
    expect([...COVERED_STATUSES]).toEqual(['COVERED']);
    expect([...EXCLUDED_STATUSES]).toEqual(['WAIVED']);
  });

  it('knows every heal state the shared vocabulary has', () => {
    expect(HEAL_STATES).toContain('SUPERSEDED');
  });
});

// ─── Validity ───────────────────────────────────────────────────────────────

describe('backtestValidity', () => {
  it('reports INSUFFICIENT_DATA with the n, and no rate at all, below the threshold', () => {
    // THE FLATTERING RESULT THIS PREVENTS: a 0.0 escaped-defect rate on covered
    // surface computed over three tickets, which is the most quotable number
    // this product could print and means nothing.
    const result = backtest({ defectCount: 3 });
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
    expect(result.escapedRateCovered).toBeNull();
    expect(result.escapedRateUncovered).toBeNull();
    expect(result.verdictDetail).toContain('3 defect(s)');
    expect(result.verdictDetail).toContain(String(MINIMUM_VALIDITY_DEFECTS));
  });

  it('reports both rates once there are enough defects', () => {
    const surfaces: SurfaceStatusRow[] = [
      { key: 'ROUTE:/a', status: 'COVERED' },
      { key: 'ROUTE:/b', status: 'COVERED' },
      { key: 'ROUTE:/c', status: 'UNCOVERED' },
    ];
    const defects = [
      ...defectsOn('ROUTE:/a', 10),
      ...defectsOn('ROUTE:/c', 20),
    ];
    const result = backtestValidity({
      defects,
      surfaces,
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'linear: project=QA label=escaped',
    });
    expect(result.verdict).toBe('SUFFICIENT');
    expect(result.defectCount).toBe(30);
    // 10 defects over 2 covered items, 20 over 1 uncovered item.
    expect(result.escapedRateCovered).toBe(5);
    expect(result.escapedRateUncovered).toBe(20);
  });

  it('keeps ASSERTED_NOT_RUN on the uncovered side', () => {
    // WRITTEN IS NOT RUN. Counting a static match as covered would move defects
    // onto the covered side with no test having executed, which is the
    // direction that makes coverage look useful.
    const result = backtestValidity({
      defects: defectsOn('ROUTE:/a', MINIMUM_VALIDITY_DEFECTS),
      surfaces: [{ key: 'ROUTE:/a', status: 'ASSERTED_NOT_RUN' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.defectsOnUncovered).toBe(MINIMUM_VALIDITY_DEFECTS);
    expect(result.defectsOnCovered).toBe(0);
    expect(result.uncoveredSurfaceCount).toBe(1);
    expect(result.coveredSurfaceCount).toBe(0);
  });

  it('keeps UNKNOWN in the uncovered denominator', () => {
    // A denominator that shrinks when an extractor gets worse is a denominator
    // that can be improved by breaking something.
    const result = backtestValidity({
      defects: [],
      surfaces: [{ key: 'ROUTE:/a', status: 'UNKNOWN' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.uncoveredSurfaceCount).toBe(1);
  });

  it('takes a WAIVED item out of both sides', () => {
    const result = backtestValidity({
      defects: defectsOn('ROUTE:/w', 40),
      surfaces: [{ key: 'ROUTE:/w', status: 'WAIVED' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.coveredSurfaceCount).toBe(0);
    expect(result.uncoveredSurfaceCount).toBe(0);
    expect(result.defectsOnCovered).toBe(0);
    expect(result.defectsOnUncovered).toBe(0);
    expect(result.defectsOnWaivedSurface).toBe(40);
    // Nothing to divide on either side, so both rates are null even though the
    // defect count is well above the threshold.
    expect(result.escapedRateCovered).toBeNull();
  });

  it('reports a defect on an unknown key as its own count, not as uncovered', () => {
    // Filing it under uncovered would inflate the uncovered rate, which is
    // exactly the direction that makes our own number look valid.
    const result = backtestValidity({
      defects: defectsOn('ROUTE:/never-enumerated', 40),
      surfaces: [{ key: 'ROUTE:/a', status: 'UNCOVERED' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.defectsOnUnknownSurface).toBe(40);
    expect(result.defectsOnUncovered).toBe(0);
  });

  it('counts a defect on both sides once per side, and never sums them into the total', () => {
    const result = backtestValidity({
      defects: [
        { id: 'd1', surfaceKeys: ['ROUTE:/a', 'ROUTE:/c'], reportedAt: new Date('2026-01-15') },
      ],
      surfaces: [
        { key: 'ROUTE:/a', status: 'COVERED' },
        { key: 'ROUTE:/c', status: 'UNCOVERED' },
      ],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.defectsOnCovered).toBe(1);
    expect(result.defectsOnUncovered).toBe(1);
    expect(result.defectCount).toBe(1);
  });

  it('excludes defects outside the window', () => {
    const result = backtestValidity({
      defects: [
        { id: 'in', surfaceKeys: ['ROUTE:/a'], reportedAt: new Date('2026-01-15') },
        { id: 'before', surfaceKeys: ['ROUTE:/a'], reportedAt: new Date('2025-12-15') },
        { id: 'after', surfaceKeys: ['ROUTE:/a'], reportedAt: new Date('2026-03-15') },
      ],
      surfaces: [{ key: 'ROUTE:/a', status: 'COVERED' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
    });
    expect(result.defectCount).toBe(1);
  });

  it('says out loud that the comparison is not a causal claim', () => {
    // Binding rather than stylistic: this is a correlation, the product may not
    // present it as a cause, and the disclaimer travels with the number rather
    // than living in a tooltip somebody has to open.
    const result = backtest({ defectCount: 40 });
    expect(result.verdictDetail).toContain('not a causal claim');
    const text = JSON.stringify(result).toUpperCase();
    expect(text).not.toContain('PROVEN');
    expect(text).not.toContain('PREDICTS');
    expect(text).not.toContain('BECAUSE');
  });

  it('fingerprints the same inputs identically and different ones differently', () => {
    // So a reader can tell "this is the same measurement" from "this is a new
    // one that happens to agree".
    expect(backtest({ defectCount: 5 }).fingerprint).toBe(backtest({ defectCount: 5 }).fingerprint);
    expect(backtest({ defectCount: 5 }).fingerprint).not.toBe(
      backtest({ defectCount: 6 }).fingerprint,
    );
  });

  it('discloses the threshold it applied', () => {
    const result = backtestValidity({
      defects: defectsOn('ROUTE:/a', 10),
      surfaces: [{ key: 'ROUTE:/a', status: 'COVERED' }],
      windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
      windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
      defectSource: 'test',
      minimumDefects: 5,
    });
    expect(result.minimumDefects).toBe(5);
    expect(result.verdict).toBe('SUFFICIENT');
  });
});

// ─── Generation survival ────────────────────────────────────────────────────

describe('generationOutcomeOf', () => {
  it('calls a human rewrite a human rewrite', () => {
    // The strongest negative signal this product can collect.
    expect(generationOutcomeOf(generated({ laterSources: ['HUMAN'] }))).toBe(
      'REWRITTEN_BY_HUMAN',
    );
  });

  it('counts a test that was both rewritten and disabled exactly once', () => {
    // Without a stated precedence the same test lands in two buckets and the
    // percentages add to more than 100.
    expect(
      generationOutcomeOf(
        generated({ laterSources: ['HUMAN'], disabledAt: new Date('2026-01-02') }),
      ),
    ).toBe('DISABLED');
  });

  it('does NOT call a never-run test a survival', () => {
    // A generated test nobody has executed tells us nothing about generation,
    // and counting it as KEPT is the single easiest way to make this number go
    // up without generation improving.
    const outcome = generationOutcomeOf(generated({ firstRunStatus: null }));
    expect(outcome).toBe('NEVER_RUN');
    expect(outcome).not.toBe('KEPT');
  });

  it('does not call a never-run test a failure either', () => {
    expect(generationOutcomeOf(generated({ firstRunStatus: null }))).not.toBe('RED_ON_FIRST_RUN');
  });

  it('treats a timeout on the first run as red', () => {
    expect(generationOutcomeOf(generated({ firstRunStatus: 'TIMED_OUT' }))).toBe(
      'RED_ON_FIRST_RUN',
    );
  });

  it('separates a heal from a human rewrite', () => {
    expect(generationOutcomeOf(generated({ laterSources: ['HEAL'] }))).toBe('HEALED');
  });

  it('calls an untouched green test KEPT', () => {
    expect(generationOutcomeOf(generated({}))).toBe('KEPT');
  });
});

describe('generationSurvival', () => {
  it('excludes never-run tests from the rate and counts them beside it', () => {
    const result = generationSurvival([
      generated({ testId: 'a' }),
      generated({ testId: 'b', firstRunStatus: null }),
    ]);
    expect(result.overall.total).toBe(2);
    expect(result.overall.rated).toBe(1);
    expect(result.overall.survivalPercent).toBe(100);
    expect(result.overall.counts.NEVER_RUN).toBe(1);
  });

  it('returns null rather than 0 when nothing could be rated', () => {
    const result = generationSurvival([generated({ firstRunStatus: null })]);
    expect(result.overall.survivalPercent).toBeNull();
    expect(result.overall.survivalPercent).not.toBe(0);
  });

  it('reports the human-rewrite share separately from survival', () => {
    const result = generationSurvival([
      generated({ testId: 'a' }),
      generated({ testId: 'b', laterSources: ['HUMAN'] }),
    ]);
    expect(result.overall.survivalPercent).toBe(50);
    expect(result.overall.humanRewritePercent).toBe(50);
  });

  it('groups by cohort, type and producer', () => {
    const result = generationSurvival([
      generated({ testId: 'a', generatedAt: new Date('2026-10-20T00:00:00Z'), type: 'E2E' }),
      generated({
        testId: 'b',
        generatedAt: new Date('2026-10-27T00:00:00Z'),
        type: 'API',
        producer: 'other',
      }),
    ]);
    expect(result.byCohort.map((row) => row.group)).toEqual(['cohort:2026-W43', 'cohort:2026-W44']);
    expect(result.byType.map((row) => row.group)).toEqual(['type:API', 'type:E2E']);
    expect(result.byProducer.map((row) => row.group)).toEqual([
      'producer:gen-1',
      'producer:other',
    ]);
  });

  it('keeps a row with no producer in the table rather than dropping it', () => {
    // Dropping it would make the producer table disagree with the overall n.
    const result = generationSurvival([generated({ producer: null })]);
    expect(result.byProducer[0]?.group).toBe('producer:<unattributed>');
    expect(result.byProducer.reduce((sum, row) => sum + row.total, 0)).toBe(result.overall.total);
  });

  it('puts every test in exactly one bucket', () => {
    const rows = [
      generated({ testId: 'a' }),
      generated({ testId: 'b', laterSources: ['HUMAN'], quarantined: true }),
      generated({ testId: 'c', disabledAt: new Date(), laterSources: ['HUMAN'] }),
      generated({ testId: 'd', firstRunStatus: null }),
      generated({ testId: 'e', firstRunStatus: 'FAILED', laterSources: ['HEAL'] }),
    ];
    const result = generationSurvival(rows);
    const total = Object.values(result.overall.counts).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(rows.length);
  });
});

describe('generationCohort', () => {
  it('puts a Sunday and the following Monday in different ISO weeks', () => {
    expect(generationCohort(new Date('2026-10-25T23:00:00Z'))).toBe('2026-W43');
    expect(generationCohort(new Date('2026-10-26T01:00:00Z'))).toBe('2026-W44');
  });

  it('keeps a year boundary in one week rather than splitting it', () => {
    // 2026-12-31 is a Thursday, so its ISO week belongs to 2026.
    expect(generationCohort(new Date('2026-12-31T00:00:00Z'))).toBe('2026-W53');
  });
});

// ─── Yield ──────────────────────────────────────────────────────────────────

describe('yieldTelemetry', () => {
  it('divides acceptance by the decided set and reports pending separately', () => {
    // THE DEFECT: dividing by the total makes a team that accepted everything
    // it looked at read as 20% acceptance because forty items are waiting.
    const result = yieldTelemetry({
      proposals: [
        { id: '1', state: 'APPROVED' },
        { id: '2', state: 'GENERATED' },
        { id: '3', state: 'REJECTED' },
        { id: '4', state: 'PROPOSED' },
        { id: '5', state: 'PROPOSED' },
      ],
      heals: [],
      firstRuns: [],
    });
    expect(result.acceptancePercent).toBe(66.7);
    expect(result.proposalsDecided).toBe(3);
    expect(result.proposalsPending).toBe(2);
  });

  it('returns null rather than 0 when nothing has been decided', () => {
    const result = yieldTelemetry({
      proposals: [{ id: '1', state: 'PROPOSED' }],
      heals: [{ id: 'h', state: 'PROPOSED' }],
      firstRuns: [],
    });
    expect(result.acceptancePercent).toBeNull();
    expect(result.healSuccessPercent).toBeNull();
    expect(result.firstRunPassPercent).toBeNull();
  });

  it('does NOT count a SUPERSEDED heal as a failure', () => {
    // It means "replaced by a newer proposal for the same test" — nobody judged
    // it. Counting it as rejected would make the heal success rate fall every
    // time the healer retried, which is the opposite of what a retry means.
    const result = yieldTelemetry({
      proposals: [],
      heals: [
        { id: '1', state: 'APPLIED' },
        { id: '2', state: 'SUPERSEDED' },
        { id: '3', state: 'SUPERSEDED' },
      ],
      firstRuns: [],
    });
    expect(result.healSuccessPercent).toBe(100);
    expect(result.healsDecided).toBe(1);
  });

  it('counts AUTO_APPLIED as a heal success', () => {
    const result = yieldTelemetry({
      proposals: [],
      heals: [
        { id: '1', state: 'AUTO_APPLIED' },
        { id: '2', state: 'REJECTED' },
      ],
      firstRuns: [],
    });
    expect(result.healSuccessPercent).toBe(50);
  });

  it('excludes a flaky first run from the pass rate and counts it', () => {
    // A flaky first run is not a pass and not a failure, and folding it into
    // either would make the figure move with the suite's reliability rather
    // than with generation quality.
    const result = yieldTelemetry({
      proposals: [],
      heals: [],
      firstRuns: [
        { testId: 'a', status: 'PASSED' },
        { testId: 'b', status: 'FAILED' },
        { testId: 'c', status: 'FLAKY' },
      ],
    });
    expect(result.firstRunPassPercent).toBe(50);
    expect(result.firstRuns).toBe(3);
    expect(result.firstRunsFlaky).toBe(1);
  });
});

// ─── Triage accuracy ────────────────────────────────────────────────────────

describe('triageAccuracy', () => {
  it('reports an override rate per verdict kind, not one number', () => {
    // A model right about FLAKE and wrong about ENV_ISSUE is not "85%
    // accurate", and ENV_ISSUE is the verdict that stops a team investigating a
    // bug that is not theirs.
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'ACCEPTED' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'ACCEPTED' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'ACCEPTED' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' }),
      verdictRow({ verdict: 'ENV_ISSUE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' }),
      verdictRow({ verdict: 'ENV_ISSUE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' }),
    ]);
    const byVerdict = new Map(result.byVerdict.map((row) => [row.verdict, row]));
    expect(byVerdict.get('FLAKE')?.overridePercent).toBe(25);
    expect(byVerdict.get('ENV_ISSUE')?.overridePercent).toBe(100);
    // Blended this would read as 50%, which describes neither kind.
    expect(result).not.toHaveProperty('overridePercent');
  });

  it('has a row for every verdict kind, including ones with no data', () => {
    // A missing row is indistinguishable from a perfect score on a screen.
    const result = triageAccuracy([]);
    expect(result.byVerdict.map((row) => row.verdict)).toEqual([...VERDICTS]);
    for (const row of result.byVerdict) expect(row.overridePercent).toBeNull();
  });

  it('does NOT count a mute as an acceptance', () => {
    // A human who muted a signature did not agree with the verdict, they
    // stopped hearing about it. Folding those into `accepted` would make the
    // model look better the more people switched it off.
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'MUTED' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' }),
    ]);
    const flake = result.byVerdict.find((row) => row.verdict === 'FLAKE');
    expect(flake?.accepted).toBe(0);
    expect(flake?.muted).toBe(1);
    expect(flake?.overridePercent).toBe(100);
  });

  it('does not count a pending verdict in the denominator', () => {
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'PENDING' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'ACCEPTED' }),
    ]);
    const flake = result.byVerdict.find((row) => row.verdict === 'FLAKE');
    expect(flake?.reviewed).toBe(1);
    expect(flake?.pending).toBe(1);
  });

  it('records what humans changed each verdict TO', () => {
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' }),
      verdictRow({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'ENV_ISSUE' }),
    ]);
    const flake = result.byVerdict.find((row) => row.verdict === 'FLAKE');
    expect(flake?.overriddenTo.REAL_BUG).toBe(1);
    expect(flake?.overriddenTo.ENV_ISSUE).toBe(1);
  });

  it('reports an OVERRIDDEN row with no replacement instead of treating it as an acceptance', () => {
    // A data defect, and the silent handling would have been the flattering
    // one: it would have shrunk the override count.
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: null }),
    ]);
    expect(result.overriddenWithNoReplacement).toBe(1);
    const flake = result.byVerdict.find((row) => row.verdict === 'FLAKE');
    expect(flake?.overridden).toBe(1);
    expect(flake?.accepted).toBe(0);
  });

  it('reports totals as counts a reader can re-divide', () => {
    const result = triageAccuracy([
      verdictRow({ verdict: 'FLAKE', reviewState: 'ACCEPTED' }),
      verdictRow({ verdict: 'REAL_BUG', reviewState: 'OVERRIDDEN', overriddenTo: 'FLAKE' }),
    ]);
    expect(result.totals).toEqual({
      accepted: 1,
      overridden: 1,
      reviewed: 2,
      pending: 0,
      muted: 0,
    });
  });
});

// ─── Seeded-fault aggregation ───────────────────────────────────────────────

describe('faultClassDetection', () => {
  it('divides by the rated set and leaves NOT_EXERCISED out of both halves', () => {
    const rates = faultClassDetection([
      { faultId: '1', faultClass: 'WRONG_TOTAL', outcome: 'DETECTED' },
      { faultId: '2', faultClass: 'WRONG_TOTAL', outcome: 'MISSED' },
      { faultId: '3', faultClass: 'WRONG_TOTAL', outcome: 'NOT_EXERCISED' },
    ]);
    expect(rates).toEqual([
      {
        faultClass: 'WRONG_TOTAL',
        detected: 1,
        missed: 1,
        notExercised: 1,
        rated: 2,
        detectionPercent: 50,
      },
    ]);
  });

  it('drops a BASELINE_DIRTY row entirely rather than counting it as a miss', () => {
    // The bench writes that outcome when a reading is void, and a void reading
    // is not a miss.
    const rates = faultClassDetection([
      { faultId: '1', faultClass: 'A', outcome: 'DETECTED' },
      { faultId: '2', faultClass: 'A', outcome: 'BASELINE_DIRTY' },
    ]);
    expect(rates[0]?.rated).toBe(1);
    expect(rates[0]?.detectionPercent).toBe(100);
  });

  it('returns null rather than 0 for a class where nothing was rated', () => {
    const rates = faultClassDetection([
      { faultId: '1', faultClass: 'A', outcome: 'NOT_EXERCISED' },
    ]);
    expect(rates[0]?.detectionPercent).toBeNull();
  });

  it('never blends two classes into one figure', () => {
    const rates = faultClassDetection([
      { faultId: '1', faultClass: 'A', outcome: 'DETECTED' },
      { faultId: '2', faultClass: 'B', outcome: 'MISSED' },
    ]);
    expect(rates.map((rate) => [rate.faultClass, rate.detectionPercent])).toEqual([
      ['A', 100],
      ['B', 0],
    ]);
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('persistValidityBacktest', () => {
  it('writes the row and the window as dates', async () => {
    const client = fakeClient();
    await persistValidityBacktest(client, {
      orgId: 'org-1',
      projectId: 'proj-1',
      snapshotId: 'snap-1',
      backtest: backtest({ defectCount: 40 }),
    });
    const written = client.writes.validityBacktest[0]!;
    expect(written.orgId).toBe('org-1');
    expect(written.windowStartAt).toBeInstanceOf(Date);
    expect(written.verdict).toBe('SUFFICIENT');
    expect(written.minimumDefects).toBe(MINIMUM_VALIDITY_DEFECTS);
  });

  it('refuses a row claiming SUFFICIENT below its own threshold', async () => {
    // The schema is the only thing standing between this table and a row a
    // buyer is later shown. A bug in backtestValidity has to be a 500 at the
    // write, not a flattering row.
    const forged: ValidityBacktest = {
      ...backtest({ defectCount: 2 }),
      verdict: 'SUFFICIENT',
    };
    await expect(
      persistValidityBacktest(fakeClient(), {
        orgId: 'o',
        projectId: 'p',
        snapshotId: null,
        backtest: forged,
      }),
    ).rejects.toThrow();
  });

  it('refuses a rate beside an INSUFFICIENT_DATA verdict', async () => {
    const forged: ValidityBacktest = {
      ...backtest({ defectCount: 2 }),
      escapedRateCovered: 0,
    };
    await expect(
      persistValidityBacktest(fakeClient(), {
        orgId: 'o',
        projectId: 'p',
        snapshotId: null,
        backtest: forged,
      }),
    ).rejects.toThrow();
  });
});

describe('loadLatestValidityBacktest', () => {
  it('asks for every field it returns', async () => {
    // A select-blind fake makes deleting a field from a query undetectable, so
    // this fake projects strictly and the test reads the result back.
    const client = fakeClient({
      validityBacktest: [
        {
          id: 'v1',
          orgId: 'org-1',
          projectId: 'proj-1',
          verdict: 'SUFFICIENT',
          defectCount: 40,
          escapedRateCovered: 0.5,
          escapedRateUncovered: 2,
          minimumDefects: 30,
          defectSource: 'linear',
          fingerprint: 'abc',
          createdAt: new Date('2026-10-20'),
          verdictDetail: 'should not be selected',
        },
      ],
    });
    const row = await loadLatestValidityBacktest(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(row?.verdict).toBe('SUFFICIENT');
    expect(row?.escapedRateCovered).toBe(0.5);
    expect(row?.fingerprint).toBe('abc');
    expect(row).not.toHaveProperty('verdictDetail');
  });

  it('returns null rather than an empty object when nothing has been computed', async () => {
    const row = await loadLatestValidityBacktest(fakeClient(), { orgId: 'o', projectId: 'p' });
    expect(row).toBeNull();
  });

  it('scopes the read to the org', async () => {
    const client = fakeClient({
      validityBacktest: [
        { id: 'v1', orgId: 'other-org', projectId: 'proj-1', verdict: 'SUFFICIENT' },
      ],
    });
    expect(
      await loadLatestValidityBacktest(client, { orgId: 'org-1', projectId: 'proj-1' }),
    ).toBeNull();
  });
});

describe('persistBenchmarkRun', () => {
  it('writes the run and its fault results in one nested statement', async () => {
    // A run row with half its results is a class rate over a partial
    // population, which is worse than no row because it looks complete.
    const client = fakeClient();
    await persistBenchmarkRun(client, benchmarkInput());
    const written = client.writes.benchmarkRun[0]!;
    expect(written.seed).toBe('seed-1');
    const nested = written.faultResults as { create: Array<Record<string, unknown>> };
    expect(nested.create).toHaveLength(2);
    expect(nested.create[0]?.orgId).toBe('org-1');
  });

  it('keeps a null count null rather than defaulting it to zero', async () => {
    // 0 detected is a result — a terrible one — and "we did not finish" is not
    // a result at all.
    const client = fakeClient();
    await persistBenchmarkRun(client, {
      ...benchmarkInput(),
      detectedCount: null,
      missedCount: null,
      notExercisedCount: null,
      finishedAt: null,
      baselineCleanAfter: null,
    });
    const written = client.writes.benchmarkRun[0]!;
    expect(written.detectedCount).toBeNull();
    expect(written.baselineCleanAfter).toBeNull();
    expect(written.finishedAt).toBeNull();
  });

  it('fingerprints the outcomes, so two runs over the same readings agree', async () => {
    const client = fakeClient();
    await persistBenchmarkRun(client, benchmarkInput());
    await persistBenchmarkRun(client, benchmarkInput());
    expect(client.writes.benchmarkRun[0]?.fingerprint).toBe(
      client.writes.benchmarkRun[1]?.fingerprint,
    );
  });
});

describe('loadLatestBenchmarkRun', () => {
  it('derives the class rates from the result rows', async () => {
    const client = fakeClient({
      benchmarkRun: [
        {
          id: 'b1',
          orgId: 'org-1',
          projectId: 'proj-1',
          seed: 'seed-1',
          faultCount: 2,
          detectedCount: 1,
          missedCount: 1,
          notExercisedCount: 0,
          baselineCleanBefore: true,
          baselineCleanAfter: true,
          finishedAt: new Date('2026-10-20'),
          caveats: [],
        },
      ],
      benchmarkFaultResult: [
        {
          orgId: 'org-1',
          benchmarkRunId: 'b1',
          faultId: 'F1',
          faultClass: 'WRONG_TOTAL',
          outcome: 'DETECTED',
        },
        {
          orgId: 'org-1',
          benchmarkRunId: 'b1',
          faultId: 'F2',
          faultClass: 'WRONG_TOTAL',
          outcome: 'MISSED',
        },
      ],
    });
    const summary = await loadLatestBenchmarkRun(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(summary?.byClass).toEqual([
      {
        faultClass: 'WRONG_TOTAL',
        detected: 1,
        missed: 1,
        notExercised: 0,
        rated: 2,
        detectionPercent: 50,
      },
    ]);
    expect(summary?.quotable).toBe(true);
  });

  it('marks a run with a dirty baseline as not quotable', async () => {
    const client = fakeClient({
      benchmarkRun: [
        {
          id: 'b1',
          orgId: 'org-1',
          projectId: 'proj-1',
          seed: 's',
          faultCount: 1,
          baselineCleanBefore: true,
          baselineCleanAfter: false,
          finishedAt: new Date(),
          caveats: [],
        },
      ],
      benchmarkFaultResult: [],
    });
    const summary = await loadLatestBenchmarkRun(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(summary?.quotable).toBe(false);
  });

  it('marks an unfinished run as not quotable', async () => {
    const client = fakeClient({
      benchmarkRun: [
        {
          id: 'b1',
          orgId: 'org-1',
          projectId: 'proj-1',
          seed: 's',
          faultCount: 1,
          baselineCleanBefore: true,
          baselineCleanAfter: true,
          finishedAt: null,
          caveats: [],
        },
      ],
      benchmarkFaultResult: [],
    });
    const summary = await loadLatestBenchmarkRun(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(summary?.quotable).toBe(false);
  });

  it('reads the result rows scoped to the run AND the org', async () => {
    const client = fakeClient({
      benchmarkRun: [
        {
          id: 'b1',
          orgId: 'org-1',
          projectId: 'proj-1',
          seed: 's',
          faultCount: 1,
          baselineCleanBefore: true,
          baselineCleanAfter: true,
          finishedAt: new Date(),
          caveats: [],
        },
      ],
      benchmarkFaultResult: [
        { orgId: 'other', benchmarkRunId: 'b1', faultId: 'X', faultClass: 'A', outcome: 'DETECTED' },
      ],
    });
    const summary = await loadLatestBenchmarkRun(client, { orgId: 'org-1', projectId: 'proj-1' });
    expect(summary?.byClass).toEqual([]);
  });
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function defectsOn(key: string, count: number): DefectRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${key}-${index}`,
    surfaceKeys: [key],
    reportedAt: new Date('2026-01-15T00:00:00.000Z'),
  }));
}

function backtest(over: { defectCount: number }): ValidityBacktest {
  return backtestValidity({
    defects: defectsOn('ROUTE:/a', over.defectCount),
    surfaces: [
      { key: 'ROUTE:/a', status: 'COVERED' },
      { key: 'ROUTE:/b', status: 'UNCOVERED' },
    ],
    windowStartAt: new Date('2026-01-01T00:00:00.000Z'),
    windowEndAt: new Date('2026-02-01T00:00:00.000Z'),
    defectSource: 'test fixture',
  });
}

function generated(over: Partial<GeneratedTestRow>): GeneratedTestRow {
  return {
    testId: 'test-1',
    type: 'E2E',
    producer: 'gen-1',
    generatedAt: new Date('2026-10-20T00:00:00.000Z'),
    laterSources: [],
    disabledAt: null,
    quarantined: false,
    firstRunStatus: 'PASSED',
    ...over,
  };
}

function verdictRow(over: Partial<TriageVerdictRow>): TriageVerdictRow {
  return {
    id: `v-${Math.random()}`,
    verdict: 'FLAKE',
    reviewState: 'PENDING',
    overriddenTo: null,
    ...over,
  };
}

function benchmarkInput(): Parameters<typeof persistBenchmarkRun>[1] {
  return {
    orgId: 'org-1',
    projectId: 'proj-1',
    seed: 'seed-1',
    suiteId: null,
    runId: null,
    faultCount: 2,
    detectedCount: 1,
    missedCount: 1,
    notExercisedCount: 0,
    baselineCleanBefore: true,
    baselineCleanAfter: true,
    startedAt: new Date('2026-10-26T00:00:00.000Z'),
    finishedAt: new Date('2026-10-26T00:10:00.000Z'),
    caveats: ['one fault was filtered out'],
    results: [
      {
        faultId: 'F1',
        faultClass: 'WRONG_TOTAL',
        surfaceItemKey: 'ROUTE:/cart',
        outcome: 'DETECTED',
        detail: 'cart.totals regressed',
        detectedByTestId: 'cart.totals',
      },
      {
        faultId: 'F2',
        faultClass: 'WRONG_TOTAL',
        surfaceItemKey: 'ROUTE:/checkout',
        outcome: 'MISSED',
        detail: 'a test exercised it and passed',
        detectedByTestId: null,
      },
    ],
  };
}

/**
 * An in-memory stand-in for the three delegates this module uses.
 *
 * IT HONOURS `select`. A fake that shrugged at a projection would make deleting
 * a field from a query undetectable — two defects have already survived a whole
 * slice behind select-blind fakes — so `project` below returns ONLY the
 * requested keys and the tests assert on an unselected field being absent.
 */
function fakeClient(
  seed: {
    validityBacktest?: Array<Record<string, unknown>>;
    benchmarkRun?: Array<Record<string, unknown>>;
    benchmarkFaultResult?: Array<Record<string, unknown>>;
  } = {},
): AccuracyClient & { writes: { validityBacktest: Array<Record<string, unknown>>; benchmarkRun: Array<Record<string, unknown>> } } {
  const rows = {
    validityBacktest: seed.validityBacktest ?? [],
    benchmarkRun: seed.benchmarkRun ?? [],
    benchmarkFaultResult: seed.benchmarkFaultResult ?? [],
  };
  const writes = {
    validityBacktest: [] as Array<Record<string, unknown>>,
    benchmarkRun: [] as Array<Record<string, unknown>>,
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const project = (
    row: Record<string, unknown>,
    select: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const [key, want] of Object.entries(select)) {
      if (want !== true) throw new Error(`fake prisma: unsupported select on ${key}`);
      out[key] = row[key];
    }
    return out;
  };

  return {
    writes,
    validityBacktest: {
      create: async ({ data }) => {
        writes.validityBacktest.push(data);
        return { id: `v-${writes.validityBacktest.length}` };
      },
      findFirst: async ({ where, select }) => {
        const found = rows.validityBacktest.find((row) => matches(row, where));
        return found ? project(found, select) : null;
      },
    },
    benchmarkRun: {
      create: async ({ data }) => {
        writes.benchmarkRun.push(data);
        return { id: `b-${writes.benchmarkRun.length}` };
      },
      findFirst: async ({ where, select }) => {
        const found = rows.benchmarkRun.find((row) => matches(row, where));
        return found ? project(found, select) : null;
      },
    },
    benchmarkFaultResult: {
      findMany: async ({ where, select }) =>
        rows.benchmarkFaultResult
          .filter((row) => matches(row, where))
          .map((row) => project(row, select)),
    },
  };
}
