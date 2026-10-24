/**
 * The quarantine rule, and the one definition of "did this run pass".
 *
 * These tests exist because the original defect was INVISIBLE: `evaluateGates`
 * filtered quarantined tests out of the gate rules, nothing tested the
 * counters, and so a quarantined test's failure went on turning builds red
 * through `Run.failedCount` for as long as the feature existed. Nothing here
 * asserts that a function was called. Everything here asserts the number a
 * consumer reads.
 */

import { describe, expect, it } from 'vitest';
import type { GateRule, Priority, TestResultStatus, Verdict } from '@qaai/shared';
import {
  checkQuarantineBudget,
  emptyRunCounts,
  evaluateGates,
  evaluateQuarantineHealth,
  quarantineBudget,
  quarantineExpiryFrom,
  quarantineSuppresses,
  runOutcome,
  tallyResult,
  QUARANTINE_BUDGET_FLOOR,
  QUARANTINE_BUDGET_PERCENT_DEFAULT,
  QUARANTINE_EXPIRY_WARNING_DAYS,
  QUARANTINE_MAX_DAYS,
} from './gates.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function result(
  over: Partial<{
    testId: string;
    testName: string;
    status: TestResultStatus;
    priority: Priority;
    quarantined: boolean;
    retriedAndPassed: boolean;
    verdict: Verdict | null;
    durationMs: number;
  }> = {},
) {
  return {
    testId: 't1',
    testName: 'checkout',
    status: 'PASSED' as TestResultStatus,
    priority: 'IMPORTANT' as Priority,
    quarantined: false,
    retriedAndPassed: false,
    verdict: null as Verdict | null,
    durationMs: 100,
    ...over,
  };
}

// ─── quarantineSuppresses: expiry ────────────────────────────────────────────

describe('quarantineSuppresses', () => {
  it('is false for a test that is not quarantined', () => {
    expect(quarantineSuppresses({ quarantined: false, quarantineExpiresAt: day(5) }, NOW)).toBe(
      false,
    );
  });

  it('is true while the expiry is in the future', () => {
    expect(quarantineSuppresses({ quarantined: true, quarantineExpiresAt: day(1) }, NOW)).toBe(
      true,
    );
  });

  it('is FALSE once the expiry has passed — the test gates again', () => {
    expect(quarantineSuppresses({ quarantined: true, quarantineExpiresAt: day(-1) }, NOW)).toBe(
      false,
    );
  });

  it('honours a null expiry, so no existing quarantine is broken by the migration', () => {
    // The whole reason the migration back-fills nothing: stamping an expiry on
    // quarantines a customer never agreed to would turn thousands of suppressed
    // failures red in one deploy.
    expect(quarantineSuppresses({ quarantined: true, quarantineExpiresAt: null }, NOW)).toBe(true);
    expect(quarantineSuppresses({ quarantined: true }, NOW)).toBe(true);
  });

  it('keeps the quarantine when the expiry will not parse', () => {
    // A bad date must not turn a suppressed failure into a red build.
    expect(
      quarantineSuppresses({ quarantined: true, quarantineExpiresAt: 'not a date' }, NOW),
    ).toBe(true);
  });

  it('accepts an ISO string, which is what a JSON payload carries', () => {
    expect(
      quarantineSuppresses({ quarantined: true, quarantineExpiresAt: day(2).toISOString() }, NOW),
    ).toBe(true);
    expect(
      quarantineSuppresses({ quarantined: true, quarantineExpiresAt: day(-2).toISOString() }, NOW),
    ).toBe(false);
  });

  it('expires exactly QUARANTINE_MAX_DAYS after it is taken out', () => {
    const expires = quarantineExpiryFrom(NOW);
    expect(quarantineSuppresses({ quarantined: true, quarantineExpiresAt: expires }, NOW)).toBe(
      true,
    );
    expect(
      quarantineSuppresses(
        { quarantined: true, quarantineExpiresAt: expires },
        new Date(NOW.getTime() + (QUARANTINE_MAX_DAYS + 1) * 86_400_000),
      ),
    ).toBe(false);
  });
});

// ─── tallyResult: where a suppressed failure lands ───────────────────────────

describe('tallyResult', () => {
  it('counts a quarantined failure in quarantinedFailed, never in failed', () => {
    const counts = emptyRunCounts();
    tallyResult(counts, { status: 'FAILED', quarantineInForce: true });
    expect(counts).toEqual({ passed: 0, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 1 });
  });

  it('does NOT fold a suppressed failure into skipped', () => {
    // Folding it into `skipped` would make it indistinguishable from a
    // deliberate skip, which is the same defect wearing a kinder word.
    const counts = emptyRunCounts();
    tallyResult(counts, { status: 'TIMED_OUT', quarantineInForce: true });
    expect(counts.skipped).toBe(0);
    expect(counts.quarantinedFailed).toBe(1);
  });

  it('counts an unquarantined failure in failed', () => {
    const counts = emptyRunCounts();
    tallyResult(counts, { status: 'FAILED', quarantineInForce: false });
    tallyResult(counts, { status: 'TIMED_OUT', quarantineInForce: false });
    expect(counts.failed).toBe(2);
    expect(counts.quarantinedFailed).toBe(0);
  });

  it('leaves PASSED, FLAKY and SKIPPED alone whether or not quarantine is in force', () => {
    for (const quarantineInForce of [true, false]) {
      const counts = emptyRunCounts();
      tallyResult(counts, { status: 'PASSED', quarantineInForce });
      tallyResult(counts, { status: 'FLAKY', quarantineInForce });
      tallyResult(counts, { status: 'SKIPPED', quarantineInForce });
      expect(counts).toEqual({
        passed: 1,
        failed: 0,
        flaky: 1,
        skipped: 1,
        quarantinedFailed: 0,
      });
    }
  });

  it('every result lands in exactly one column, so no total double-counts', () => {
    const counts = emptyRunCounts();
    const rows: Array<{ status: TestResultStatus; quarantineInForce: boolean }> = [
      { status: 'PASSED', quarantineInForce: false },
      { status: 'FAILED', quarantineInForce: false },
      { status: 'FAILED', quarantineInForce: true },
      { status: 'FLAKY', quarantineInForce: false },
      { status: 'SKIPPED', quarantineInForce: false },
      { status: 'TIMED_OUT', quarantineInForce: true },
    ];
    for (const row of rows) tallyResult(counts, row);
    const total =
      counts.passed + counts.failed + counts.flaky + counts.skipped + counts.quarantinedFailed;
    expect(total).toBe(rows.length);
  });
});

// ─── runOutcome: the single source of truth ──────────────────────────────────

describe('runOutcome', () => {
  it('PASSES a run whose only failures are quarantined', () => {
    // THE DEFECT, as one assertion. This run used to be written FAILED.
    const outcome = runOutcome({
      counts: { passed: 4, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 3 },
      gatePassed: true,
    });
    expect(outcome.status).toBe('PASSED');
    expect(outcome.passed).toBe(true);
  });

  it('still SAYS the suppressed failures out loud on a passing run', () => {
    const outcome = runOutcome({
      counts: { passed: 4, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 3 },
      gatePassed: true,
    });
    expect(outcome.suppressedFailures).toBe(3);
    expect(outcome.reason).toContain('3 failing test(s) were quarantined');
    expect(outcome.reason).toContain('still failing');
  });

  it('fails a run with one unquarantined failure', () => {
    const outcome = runOutcome({
      counts: { passed: 4, failed: 1, flaky: 0, skipped: 0, quarantinedFailed: 0 },
      gatePassed: true,
    });
    expect(outcome).toMatchObject({ status: 'FAILED', passed: false });
  });

  it('fails a run the gate blocked even when every test that gates passed', () => {
    const outcome = runOutcome({
      counts: { passed: 4, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 0 },
      gatePassed: false,
    });
    expect(outcome).toMatchObject({ status: 'FAILED', passed: false });
    expect(outcome.reason).toContain('quality gate blocked');
  });

  it('mentions the suppressed failures on a FAILED run too', () => {
    const outcome = runOutcome({
      counts: { passed: 1, failed: 2, flaky: 0, skipped: 0, quarantinedFailed: 5 },
      gatePassed: true,
    });
    expect(outcome.reason).toContain('2 test(s) failed');
    expect(outcome.reason).toContain('5 failing test(s) were quarantined');
  });

  it('a forced status wins, and is never reported as a pass', () => {
    for (const forcedStatus of ['CANCELLED', 'ERRORED'] as const) {
      const outcome = runOutcome({
        counts: { passed: 9, failed: 0, flaky: 0, skipped: 0, quarantinedFailed: 0 },
        gatePassed: true,
        forcedStatus,
      });
      expect(outcome).toMatchObject({ status: forcedStatus, passed: false });
    }
  });
});

// ─── the budget ──────────────────────────────────────────────────────────────

describe('quarantineBudget', () => {
  it('uses the documented default when a project never configured one', () => {
    expect(quarantineBudget({ totalTests: 1_000 })).toEqual({
      allowed: 1_000 * (QUARANTINE_BUDGET_PERCENT_DEFAULT / 100),
      percent: QUARANTINE_BUDGET_PERCENT_DEFAULT,
    });
    expect(quarantineBudget({ totalTests: 1_000, budgetPercent: null }).percent).toBe(
      QUARANTINE_BUDGET_PERCENT_DEFAULT,
    );
  });

  it('honours a per-project percent', () => {
    expect(quarantineBudget({ totalTests: 200, budgetPercent: 10 })).toEqual({
      allowed: 20,
      percent: 10,
    });
  });

  it('floors, so a boundary refuses rather than allows', () => {
    // 5% of 59 is 2.95. `ceil` would allow 3.
    expect(quarantineBudget({ totalTests: 59, budgetPercent: 5 }).allowed).toBe(2);
  });

  it('never drops below the floor, so a small suite still has an escape hatch', () => {
    expect(quarantineBudget({ totalTests: 10 }).allowed).toBe(QUARANTINE_BUDGET_FLOOR);
    expect(quarantineBudget({ totalTests: 0 }).allowed).toBe(QUARANTINE_BUDGET_FLOOR);
  });

  it('clamps a nonsense percent instead of trusting it', () => {
    expect(quarantineBudget({ totalTests: 100, budgetPercent: -5 }).percent).toBe(0);
    expect(quarantineBudget({ totalTests: 100, budgetPercent: 500 }).percent).toBe(100);
    expect(quarantineBudget({ totalTests: 100, budgetPercent: Number.NaN }).percent).toBe(
      QUARANTINE_BUDGET_PERCENT_DEFAULT,
    );
  });
});

describe('checkQuarantineBudget', () => {
  it('allows a quarantine with room left', () => {
    const verdict = checkQuarantineBudget({ totalTests: 100, quarantinedCount: 1 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.limit).toBe(5);
  });

  it('REFUSES the one that would breach the cap', () => {
    const verdict = checkQuarantineBudget({ totalTests: 100, quarantinedCount: 5 });
    expect(verdict.allowed).toBe(false);
  });

  it('names what to do about it rather than just saying no', () => {
    const verdict = checkQuarantineBudget({ totalTests: 100, quarantinedCount: 5 });
    expect(verdict.reason).toMatch(/fix one of the quarantined tests or delete it/i);
    expect(verdict.reason).toContain('5 of 100');
    expect(verdict.reason).toContain('quarantineBudgetPercent');
  });

  it('warns before it refuses', () => {
    // 80% of a cap of 5 is 4, so the 4th is allowed and says the next may not be.
    const fourth = checkQuarantineBudget({ totalTests: 100, quarantinedCount: 3 });
    expect(fourth).toMatchObject({ allowed: true, nearLimit: true });
    expect(fourth.reason).toContain('will be refused');

    const second = checkQuarantineBudget({ totalTests: 100, quarantinedCount: 1 });
    expect(second.nearLimit).toBe(false);
  });

  it('never refuses a test that is already quarantined', () => {
    // Refusing here would only stop the reason and the audit row being updated
    // — it would hide the state rather than change it.
    const verdict = checkQuarantineBudget({
      totalTests: 100,
      quarantinedCount: 40,
      alreadyQuarantined: true,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('reports the share the suite would reach', () => {
    const verdict = checkQuarantineBudget({ totalTests: 40, quarantinedCount: 1 });
    expect(verdict.wouldBePercent).toBe(5);
  });
});

// ─── the alarm ───────────────────────────────────────────────────────────────

describe('evaluateQuarantineHealth', () => {
  it('passes quietly when a suite is well inside its budget', () => {
    const [budget, ...rest] = evaluateQuarantineHealth({
      totalTests: 100,
      quarantinedCount: 1,
    });
    expect(budget).toMatchObject({ action: 'PASS', passed: true });
    expect(rest).toEqual([]);
  });

  it('BLOCKS once the suite is over budget', () => {
    const evaluations = evaluateQuarantineHealth({ totalTests: 100, quarantinedCount: 6 });
    const blocking = evaluations.filter((e) => e.action === 'BLOCK');
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.detail).toContain('6 of 100');
    expect(blocking[0]!.detail).toMatch(/cap of 5/);
    expect(blocking[0]!.detail).toMatch(/fix or delete/i);
  });

  it('WARNS when the suite is near the cap', () => {
    const evaluations = evaluateQuarantineHealth({ totalTests: 100, quarantinedCount: 4 });
    expect(evaluations.map((e) => e.action)).toContain('WARN');
    expect(evaluations[0]!.detail).toContain('close to this project');
  });

  it('WARNS, by name, about a quarantine that expired and now gates again', () => {
    const evaluations = evaluateQuarantineHealth({
      totalTests: 100,
      quarantinedCount: 1,
      expired: [{ testId: 't9', testName: 'legacy upload' }],
    });
    const warn = evaluations.find((e) => e.detail.includes('Quarantine expired'));
    expect(warn).toMatchObject({ action: 'WARN', passed: false });
    expect(warn!.detail).toContain('legacy upload');
    expect(warn!.detail).toContain('GATE AGAIN');
  });

  it('WARNS about quarantines about to expire', () => {
    const evaluations = evaluateQuarantineHealth({
      totalTests: 100,
      quarantinedCount: 1,
      expiringSoon: [{ testId: 't3', testName: 'search', expiresAt: day(1) }],
    });
    const warn = evaluations.find((e) => e.detail.includes('Quarantine expiring'));
    expect(warn?.action).toBe('WARN');
    expect(warn!.detail).toContain(String(QUARANTINE_EXPIRY_WARNING_DAYS));
  });

  it('WARNS about a quarantine with no end date at all', () => {
    const evaluations = evaluateQuarantineHealth({
      totalTests: 100,
      quarantinedCount: 1,
      unbounded: [{ testId: 't1', testName: 'old flake', quarantinedAt: day(-60) }],
    });
    const warn = evaluations.find((e) => e.detail.includes('no end date'));
    expect(warn?.action).toBe('WARN');
    expect(warn!.detail).toContain('old flake');
  });

  it('names at most three tests and then counts, so the detail stays readable', () => {
    const evaluations = evaluateQuarantineHealth({
      totalTests: 100,
      quarantinedCount: 1,
      expired: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ testId: n, testName: n })),
    });
    const warn = evaluations.find((e) => e.detail.includes('Quarantine expired'))!;
    expect(warn.detail).toContain('a, b, c and 2 more');
  });
});

// ─── evaluateGates: the rules, plus the alarm riding with them ───────────────

describe('evaluateGates', () => {
  const blockRealBugs: GateRule[] = [
    { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
  ];

  it('excludes a quarantined test from every rule', () => {
    const gate = evaluateGates(blockRealBugs, {
      results: [result({ status: 'FAILED', verdict: 'REAL_BUG', quarantined: true })],
    });
    expect(gate.passed).toBe(true);
  });

  it('includes a test whose quarantine the caller reports as expired', () => {
    // The caller passes `quarantineSuppresses(...)`, not the raw column, so an
    // expired quarantine arrives here as `quarantined: false` and gates.
    const gate = evaluateGates(blockRealBugs, {
      results: [
        result({
          status: 'FAILED',
          verdict: 'REAL_BUG',
          quarantined: quarantineSuppresses(
            { quarantined: true, quarantineExpiresAt: day(-1) },
            NOW,
          ),
        }),
      ],
    });
    expect(gate.passed).toBe(false);
  });

  it('adds no quarantine evaluation when the health could not be read', () => {
    // An unmeasured budget must not look like a budget that is fine.
    const gate = evaluateGates([], { results: [result()] });
    expect(gate.evaluations).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  it('BLOCKS the run when the suite is over its quarantine budget', () => {
    const gate = evaluateGates([], {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 40 },
    });
    expect(gate.passed).toBe(false);
    expect(gate.evaluations.some((e) => e.action === 'BLOCK')).toBe(true);
  });

  it('a project cannot switch the budget off by writing its own rule list', () => {
    // The budget bounds the mechanism that switches signals off; a brake the
    // thing it brakes can remove is not a brake.
    const gate = evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 0, action: 'WARN' }], {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 40 },
    });
    expect(gate.passed).toBe(false);
  });

  it('a WARN-level quarantine alarm does not block the run', () => {
    const gate = evaluateGates([], {
      results: [result()],
      quarantine: {
        totalTests: 100,
        quarantinedCount: 1,
        expired: [{ testId: 't2', testName: 'profile edit' }],
      },
    });
    expect(gate.passed).toBe(true);
    expect(gate.evaluations.some((e) => e.action === 'WARN')).toBe(true);
  });

  it('keeps the configured rules ahead of the alarm, so a reader sees theirs first', () => {
    const gate = evaluateGates(blockRealBugs, {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 1 },
    });
    expect(gate.evaluations[0]!.rule.kind).toBe('BLOCK_ON_VERDICT');
    expect(gate.evaluations[1]!.rule.kind).toBe('MAX_QUARANTINE_PERCENT');
  });

  it('every evaluation carries the three fields consumers actually read', () => {
    // apps/web, the CLI's RunView and notify.ts's blockingGateRules all read
    // `passed`, `action` and `detail` and nothing else. The locally-declared
    // quarantine rule kind is only safe while that stays true.
    const gate = evaluateGates(blockRealBugs, {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 40 },
    });
    for (const evaluation of gate.evaluations) {
      expect(typeof evaluation.passed).toBe('boolean');
      expect(['WARN', 'BLOCK', 'PASS']).toContain(evaluation.action);
      expect(typeof evaluation.detail).toBe('string');
      expect(evaluation.detail.length).toBeGreaterThan(0);
    }
  });
});
