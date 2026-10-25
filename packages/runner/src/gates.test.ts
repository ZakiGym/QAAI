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
import type {
  FindingSeverity,
  GateResult,
  GateRule,
  NotRunKind,
  PatchCoverage,
  Priority,
  TestResultStatus,
  Verdict,
} from '@qaai/shared';
import {
  checkQuarantineBudget,
  emptyRunCounts,
  evaluateGates,
  evaluateQuarantineHealth,
  gateAwaitsTriage,
  quarantineBudget,
  quarantineExpiryFrom,
  quarantineHealthFrom,
  quarantineSuppresses,
  rescoreGate,
  runOutcome,
  tallyResult,
  untriagedBlockers,
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
    notRun: NotRunKind | null;
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
    // Absent, not NOT_RUN: a row nobody classified has made no claim.
    notRun: null as NotRunKind | null,
    verdict: null as Verdict | null,
    durationMs: 100,
    ...over,
  };
}

/** A test the environment, or this deployment, never attempted. */
const blocked = (over: Parameters<typeof result>[0] = {}) =>
  result({ status: 'SKIPPED', notRun: 'BLOCKED_BY_ENV', durationMs: 0, ...over });

/** The rows an evaluation is computed from, named so a table of cases can be typed. */
type GateInputResults = Parameters<typeof evaluateGates>[1]['results'];

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
    // `passed`, `action` and `detail` and nothing else.
    //
    // `passed` is now boolean OR NULL and `action` has a fourth member: a rule
    // whose input was never measured has no boolean answer, and giving it one
    // would be inventing either a pass or a failure. Every consumer that reads
    // `!e.passed` therefore reads an unmeasured rule as "not passed", which is
    // the safe direction — it shows the detail, which says "not measured".
    const gate = evaluateGates([...blockRealBugs, { kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' }], {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 40 },
    });
    for (const evaluation of gate.evaluations) {
      expect(['boolean', 'object']).toContain(typeof evaluation.passed);
      expect(['WARN', 'BLOCK', 'PASS', 'UNMEASURED']).toContain(evaluation.action);
      expect(typeof evaluation.detail).toBe('string');
      expect(evaluation.detail.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The measurement rules, and the third state.
//
// The defect these cover is one sentence long: a pull request that DELETED the
// only checkout test passed every gate in the product. Every remaining test
// passed, the flake rate was zero, p95 was fine, and the thing that had changed
// — what is tested at all — was not a quantity any rule could read.
//
// The second defect is subtler and is why `UNMEASURED` exists. Each rule below
// gates on a measurement that can be absent, and the two obvious answers for an
// absent measurement are both lies: a pass is a claim about the customer's suite
// made from our own silence, and a block holds a merge over a measurement we
// did not take. So nothing here is allowed to assert `gate.passed` alone — the
// tests assert the ACTION of the rule, which is the only place the difference
// between "measured and fine" and "never measured" is visible.
// ─────────────────────────────────────────────────────────────────────────────

const only = (gate: GateResult, kind: GateRule['kind']) =>
  gate.evaluations.find((e) => e.rule.kind === kind)!;

const patchOf = (over: Partial<PatchCoverage> = {}): PatchCoverage => ({
  denominator: 0,
  covered: 0,
  assertedNotRun: 0,
  uncovered: 0,
  unknown: 0,
  waived: 0,
  unrecognised: 0,
  percent: null,
  routes: [],
  caveats: [],
  measured: true,
  ...over,
});

const finding = (
  over: Partial<{
    kind: 'ACCESSIBILITY' | 'SECURITY' | 'PERFORMANCE' | 'LOCALIZATION' | 'VISUAL';
    severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
    code: string;
    location: string;
    testName: string | null;
  }> = {},
) => ({
  kind: 'ACCESSIBILITY' as const,
  severity: 'CRITICAL' as const,
  code: 'color-contrast',
  location: '/checkout',
  testName: 'a11y: checkout',
  ...over,
});

describe('a rule whose input was not measured neither passes nor blocks', () => {
  const rules: GateRule[] = [{ kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' }];

  it('reports UNMEASURED, with null rather than a boolean, when there is no snapshot', () => {
    const gate = evaluateGates(rules, { results: [result()] });
    const evaluation = only(gate, 'MIN_COVERAGE');

    expect(evaluation.action).toBe('UNMEASURED');
    expect(evaluation.passed).toBeNull();
    // It must not block: holding a merge over a measurement WE never took is
    // the opposite failure from the one this rule exists to prevent.
    expect(gate.passed).toBe(true);
    // And it must not vanish. A configured rule that is silently dropped is an
    // absent gate, and absent looks exactly like green.
    expect(evaluation.detail).toContain('not measured');
    expect(gate.unmeasured).toBe(1);
    /*
     * And it makes no claim it has no input for. This used to read "this
     * project has no stored coverage snapshot", which is a statement about the
     * customer's data inferred from our own silence — and false on the common
     * path, where an absent field means the CALLER assembled no coverage input.
     * The customer reads WHY, and the why is about the read.
     */
    expect(evaluation.detail).toContain('read by whatever scored this gate');
    expect(evaluation.detail).not.toContain('this project has no stored coverage snapshot');
  });

  it('treats a NULL percentage as unmeasured and says why it is not 0%', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      coverage: {
        percent: null,
        denominator: 0,
        covered: 0,
        measuredAtIso: '2026-10-24T00:00:00.000Z',
        commitSha: null,
      },
    });
    const evaluation = only(gate, 'MIN_COVERAGE');
    expect(evaluation.action).toBe('UNMEASURED');
    expect(evaluation.detail).toContain('NULL rather than 0');
  });

  it('BLOCKS when the measured percentage is under the floor', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      coverage: {
        percent: 41.5,
        denominator: 200,
        covered: 83,
        measuredAtIso: '2026-10-24T00:00:00.000Z',
        commitSha: 'abcdef1234',
      },
    });
    expect(only(gate, 'MIN_COVERAGE').action).toBe('BLOCK');
    expect(gate.passed).toBe(false);
    expect(only(gate, 'MIN_COVERAGE').detail).toContain('41.5%');
    // The inputs travel with the number, because a percentage with no inputs
    // cannot be argued with.
    expect(only(gate, 'MIN_COVERAGE').detail).toContain('abcdef1');
  });

  it('passes when the measured percentage clears the floor', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      coverage: {
        percent: 80,
        denominator: 10,
        covered: 8,
        measuredAtIso: '2026-10-24T00:00:00.000Z',
        commitSha: null,
      },
    });
    expect(only(gate, 'MIN_COVERAGE').action).toBe('PASS');
  });

  it('refuses to call an empty suite a 100% pass rate', () => {
    // Every test quarantined, or a selection that ran nothing: the old
    // arithmetic returned 100% and the gate reported a clean pass over a suite
    // that gated nothing at all.
    const gate = evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }], {
      results: [result({ status: 'FAILED', quarantined: true })],
    });
    expect(only(gate, 'MIN_PASS_RATE').action).toBe('UNMEASURED');
    expect(only(gate, 'MIN_PASS_RATE').detail).toContain('not a 100% pass rate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A test nobody could attempt is not a test that did not pass.
//
// THE DEFECT. `GateInput.results` had no way to say "this did not run", so a
// test the environment blocked and a test that ran and failed were the same row
// to every rule here. Eleven tests behind a dead staging box therefore counted
// eleven times against the pass rate, the flake rate and p95 — a MIN_PASS_RATE
// gate held a merge over tests nobody attempted, which is a verdict about our
// own infrastructure printed as a verdict about the customer's code.
//
// The counters were fixed for exactly this and the RULES were not. What was NOT
// done is the fix that would have worked and lied: passing `quarantined: true`
// for those rows. They are not quarantined, nobody signed anything, and every
// surface renders quarantine as a deliberate suppression.
// ─────────────────────────────────────────────────────────────────────────────

describe('a result that did not run is out of the rate rules, and the subtraction is shown', () => {
  const minPassRate: GateRule[] = [{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }];

  it('keeps blocked and unsupported tests out of the pass-rate denominator', () => {
    const gate = evaluateGates(minPassRate, {
      results: [
        ...Array.from({ length: 8 }, (_, i) => result({ testId: `p${i}`, status: 'PASSED' })),
        blocked({ testId: 'b1', testName: 'checkout (staging down)' }),
        blocked({ testId: 'b2', testName: 'k6 load', notRun: 'UNSUPPORTED' }),
      ],
    });
    const rule = only(gate, 'MIN_PASS_RATE');

    // 8/8, not 8/10. The old arithmetic reported 80% and BLOCKED.
    expect(rule.detail).toContain('100.0% passed (8/8)');
    expect(rule.action).toBe('PASS');
    // And it never happens quietly: the rows that left the denominator are
    // counted and their kinds named, so nobody reads a 100% pass rate off a run
    // that attempted four fifths of itself.
    expect(rule.detail).toContain('2 not attempted and left out');
    expect(rule.detail).toContain('BLOCKED_BY_ENV, UNSUPPORTED');
  });

  it('refuses to report a rate at all when nothing was attempted', () => {
    // Not 100%, and not 0% either: there is no denominator. A run that could
    // not be attempted is the case the environment gate BLOCKS over, and a pass
    // rate computed here would be the reassuring half of that same run.
    const gate = evaluateGates(minPassRate, {
      results: [blocked({ testId: 'b1' }), blocked({ testId: 'b2' })],
    });
    expect(only(gate, 'MIN_PASS_RATE').action).toBe('UNMEASURED');
    expect(only(gate, 'MIN_PASS_RATE').detail).toContain('not a 100% pass rate');
  });

  it('keeps an unexplained skip IN the denominator, and says it is unexplained', () => {
    // "Not recorded" is the fifth state, not a fifth kind. A plugin that
    // returns SKIPPED with a plain sentence has made no claim about why, and
    // dropping the row would be this rule deciding on no evidence that the test
    // could not be attempted — which is how a suite comes to report a rate over
    // the tests that suited it.
    const gate = evaluateGates(minPassRate, {
      results: [
        result({ testId: 'p1', status: 'PASSED' }),
        result({ testId: 's1', status: 'SKIPPED', notRun: null }),
      ],
    });
    const rule = only(gate, 'MIN_PASS_RATE');
    expect(rule.detail).toContain('50.0% passed (1/2)');
    expect(rule.action).toBe('BLOCK');
    expect(rule.detail).toContain('1 skipped result(s) record no reason');
    // And the clause that makes the number honest, not just the count beside
    // it. The denominator is 2, so the sentence has to say these rows are IN
    // it: a disclosure reading "left out" would describe a subtraction this
    // rate did not perform, which is worse than no disclosure — a reader would
    // take 50.0% to be a rate over the tests that ran.
    expect(rule.detail).toContain('still counted');
    expect(rule.detail).not.toContain('left out');
  });

  it('keeps them out of the flake rate too', () => {
    const gate = evaluateGates([{ kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'BLOCK' }], {
      results: [
        result({ testId: 'f1', status: 'FLAKY' }),
        ...Array.from({ length: 19 }, (_, i) => blocked({ testId: `b${i}` })),
      ],
    });
    // 1 of 1 attempted is 100% flaky; 1 of 20 would have read as 5% and passed,
    // which is a flake rate over nineteen tests that never ran.
    expect(only(gate, 'MAX_FLAKE_RATE').detail).toContain('100.0% flaky (1/1)');
    expect(only(gate, 'MAX_FLAKE_RATE').action).toBe('BLOCK');
  });

  it('reports the 95th percentile of what ran, by nearest rank', () => {
    // Twenty-one attempted tests, so the rank is not a whole number and the
    // rounding is visible: nearest-rank p95 is the 20th sample, which is what a
    // CI report means by p95. Rounding the rank down instead reads the 19th and
    // reports a lower number under the name p95 — which on a latency gate is
    // the difference between seeing the slow test and not.
    const gate = evaluateGates([{ kind: 'MAX_P95_LATENCY_MS', ms: 1_000, action: 'BLOCK' }], {
      results: Array.from({ length: 21 }, (_, i) =>
        result({ testId: `t${i}`, durationMs: (i + 1) * 100 }),
      ),
    });
    expect(only(gate, 'MAX_P95_LATENCY_MS').detail).toContain('p95 was 2000ms');
    expect(only(gate, 'MAX_P95_LATENCY_MS').action).toBe('BLOCK');
  });

  it('passes a rate exactly on the floor, because the rule says "at least"', () => {
    const gate = evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 100, action: 'BLOCK' }], {
      results: [result({ status: 'PASSED' })],
    });
    expect(only(gate, 'MIN_PASS_RATE').action).toBe('PASS');
  });

  it('keeps a never-started test out of p95, where its row holds a placeholder', () => {
    const gate = evaluateGates([{ kind: 'MAX_P95_LATENCY_MS', ms: 1_000, action: 'BLOCK' }], {
      results: [
        result({ testId: 'slow', durationMs: 9_000 }),
        ...Array.from({ length: 19 }, (_, i) => blocked({ testId: `b${i}` })),
      ],
    });
    // A blocked row's durationMs is zero because nothing ran, not because
    // something was fast. Nineteen of them moved the 95th percentile to 0ms and
    // the rule passed on a suite whose one real test took nine seconds.
    expect(only(gate, 'MAX_P95_LATENCY_MS').detail).toContain('p95 was 9000ms');
    expect(only(gate, 'MAX_P95_LATENCY_MS').action).toBe('BLOCK');
  });

  it('reports no rate when every gating test was blocked, on all three rules', () => {
    const gate = evaluateGates(
      [
        { kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' },
        { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'BLOCK' },
        { kind: 'MAX_P95_LATENCY_MS', ms: 1_000, action: 'BLOCK' },
      ],
      { results: [blocked()] },
    );
    for (const kind of ['MIN_PASS_RATE', 'MAX_FLAKE_RATE', 'MAX_P95_LATENCY_MS'] as const) {
      expect(only(gate, kind).action).toBe('UNMEASURED');
      expect(only(gate, kind).passed).toBeNull();
    }
    // Three rules measured nothing, and the count says so rather than leaving a
    // reader to infer it from three sentences.
    expect(gate.unmeasured).toBe(3);
    expect(gate.passed).toBe(true);
  });
});

describe('the re-score waits on exactly what the verdict rule waits on', () => {
  const criticalOnly: GateRule[] = [
    { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
  ];

  const mixed = [
    result({ testId: 'c1', status: 'FAILED', priority: 'CRITICAL_PATH', verdict: 'REAL_BUG' }),
    result({ testId: 'q1', status: 'FAILED', priority: 'CRITICAL_PATH', quarantined: true }),
    result({ testId: 'i1', status: 'FAILED', priority: 'IMPORTANT' }),
  ];

  it('does not wait on a quarantined or out-of-scope failure', () => {
    // THE DEFECT, and it is a gate stuck for ever rather than a wrong number:
    // the guard counted any untriaged failure, so a run with one untriaged
    // quarantined or IMPORTANT failure beside a triaged CRITICAL_PATH one never
    // got re-scored — while the rule had long since stopped waiting.
    expect(untriagedBlockers(criticalOnly, mixed)).toHaveLength(0);
  });

  it('does wait on an untriaged failure the rule would read', () => {
    const waiting = untriagedBlockers(criticalOnly, [
      result({ testId: 'q1', status: 'FAILED', priority: 'CRITICAL_PATH', quarantined: true }),
      result({ testId: 'i1', status: 'FAILED', priority: 'IMPORTANT' }),
      result({ testId: 'c2', status: 'FAILED', priority: 'CRITICAL_PATH' }),
    ]);
    expect(waiting.map((row) => row.testId)).toEqual(['c2']);
  });

  it('waits on nothing once the rule has found the verdict it refuses', () => {
    // A decided gate is not a waiting gate. The rule BLOCKS on `c1` whatever
    // triage decides about `c2`, so holding the re-score open until the rest of
    // triage finishes would keep a refusal off the merge box for no reason.
    const waiting = untriagedBlockers(criticalOnly, [
      result({ testId: 'c1', status: 'FAILED', priority: 'CRITICAL_PATH', verdict: 'REAL_BUG' }),
      result({ testId: 'c2', status: 'FAILED', priority: 'CRITICAL_PATH' }),
    ]);
    expect(waiting).toHaveLength(0);
  });

  it('is the same answer the rule gives, case for case', () => {
    // The parity assertion rather than three hand-written cases: what went
    // wrong was not an arm of the predicate, it was two predicates.
    const cases: Array<{ rules: GateRule[]; results: GateInputResults }> = [
      { rules: criticalOnly, results: mixed },
      { rules: criticalOnly, results: [...mixed, result({ testId: 'c2', status: 'FAILED', priority: 'CRITICAL_PATH' })] },
      { rules: criticalOnly, results: [result({ testId: 'x', status: 'TIMED_OUT', priority: 'CRITICAL_PATH' })] },
      {
        rules: [{ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] }],
        results: mixed,
      },
      { rules: [{ kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'WARN' }], results: mixed },
      { rules: criticalOnly, results: [blocked({ priority: 'CRITICAL_PATH' })] },
    ];

    for (const { rules, results } of cases) {
      const gate = evaluateGates(rules, { results });
      const verdictRule = gate.evaluations.find((e) => e.rule.kind === 'BLOCK_ON_VERDICT');
      const ruleIsWaiting = verdictRule?.action === 'UNMEASURED';
      expect(untriagedBlockers(rules, results).length > 0).toBe(ruleIsWaiting);
    }
  });

  it('counts a test once however many verdict rules name it', () => {
    const waiting = untriagedBlockers(
      [
        { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
        { kind: 'BLOCK_ON_VERDICT', verdict: 'FLAKE', onlyPriorities: ['CRITICAL_PATH'] },
      ],
      [result({ testId: 'c1', status: 'FAILED', priority: 'CRITICAL_PATH' })],
    );
    expect(waiting).toHaveLength(1);
  });
});

describe('the verdict rule knows it was scored before triage', () => {
  const rules: GateRule[] = [
    { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
  ];

  it('is UNMEASURED while a failure has no verdict, instead of reporting a pass', () => {
    // THE defect: `gateResult` is computed at finalisation, before any verdict
    // row exists, so "no REAL_BUG verdicts" was true and meaningless, and the
    // chip said GATE — PASS beside "1 failed".
    const gate = evaluateGates(rules, {
      results: [result({ status: 'FAILED', verdict: null })],
    });
    expect(only(gate, 'BLOCK_ON_VERDICT').action).toBe('UNMEASURED');
    expect(only(gate, 'BLOCK_ON_VERDICT').detail).toContain('not been triaged');
    expect(gateAwaitsTriage(gate)).toBe(true);
  });

  it('BLOCKS once the verdict exists', () => {
    const gate = evaluateGates(rules, {
      results: [result({ status: 'FAILED', verdict: 'REAL_BUG' })],
    });
    expect(only(gate, 'BLOCK_ON_VERDICT').action).toBe('BLOCK');
    expect(gateAwaitsTriage(gate)).toBe(false);
  });

  it('passes a triaged failure that is not a real bug', () => {
    const gate = evaluateGates(rules, {
      results: [result({ status: 'FAILED', verdict: 'FLAKE' })],
    });
    expect(only(gate, 'BLOCK_ON_VERDICT').action).toBe('PASS');
  });

  it('does not wait on a passing test that has no verdict', () => {
    // Only a FAILURE can carry the verdict this rule looks for. Waiting on a
    // green suite would leave every run provisional forever.
    const gate = evaluateGates(rules, { results: [result({ status: 'PASSED' })] });
    expect(only(gate, 'BLOCK_ON_VERDICT').action).toBe('PASS');
  });
});

describe('findings gate a merge, which is what the a11y plugin always said they would', () => {
  const noCriticals: GateRule[] = [
    { kind: 'MAX_FINDINGS', atOrAbove: 'CRITICAL', onlyKinds: [], max: 0, action: 'BLOCK' },
  ];

  it('BLOCKS a PASSED test that carries a critical violation', () => {
    // The registered defect, verbatim: the plugin files a critical a11y
    // violation as information and fails the test only on criticals it is sure
    // of, "whether it blocks a merge is a quality-gate decision" — and no such
    // rule existed, so the gate went green over it.
    const gate = evaluateGates(noCriticals, {
      results: [result({ status: 'PASSED' })],
      findings: { findings: [finding()] },
    });
    expect(gate.passed).toBe(false);
    expect(only(gate, 'MAX_FINDINGS').detail).toContain('color-contrast at /checkout');
  });

  it('is UNMEASURED when nobody read the findings', () => {
    const gate = evaluateGates(noCriticals, { results: [result({ status: 'PASSED' })] });
    expect(only(gate, 'MAX_FINDINGS').action).toBe('UNMEASURED');
    expect(gate.passed).toBe(true);
  });

  it('passes when the findings WERE read and there were none', () => {
    // The distinction the whole design turns on: read-and-empty is a pass,
    // never-read is not.
    const gate = evaluateGates(noCriticals, {
      results: [result({ status: 'PASSED' })],
      findings: { findings: [] },
    });
    expect(only(gate, 'MAX_FINDINGS').action).toBe('PASS');
  });

  it('uses the plugins own severity order rather than counting everything', () => {
    const gate = evaluateGates(
      [{ kind: 'MAX_FINDINGS', atOrAbove: 'SERIOUS', onlyKinds: [], max: 0, action: 'BLOCK' }],
      {
        results: [result()],
        findings: {
          findings: [
            finding({ severity: 'MODERATE', code: 'landmark-one-main' }),
            finding({ severity: 'MINOR', code: 'region' }),
          ],
        },
      },
    );
    // MODERATE and MINOR are both BELOW serious; a rule that counted every
    // finding would block on a page's two nits.
    expect(only(gate, 'MAX_FINDINGS').action).toBe('PASS');
  });

  it('filters by kind, so a security rule is not tripped by an a11y nit', () => {
    const gate = evaluateGates(
      [
        {
          kind: 'MAX_FINDINGS',
          atOrAbove: 'SERIOUS',
          onlyKinds: ['SECURITY'],
          max: 0,
          action: 'BLOCK',
        },
      ],
      {
        results: [result()],
        findings: {
          findings: [
            finding({ kind: 'ACCESSIBILITY', severity: 'CRITICAL' }),
            finding({ kind: 'SECURITY', severity: 'MODERATE', code: 'missing-csp' }),
          ],
        },
      },
    );
    expect(only(gate, 'MAX_FINDINGS').action).toBe('PASS');
  });

  it('reports the muted and quarantined findings it left out', () => {
    // Muted findings never gate — the schema says so — but a gate that silently
    // dropped 40 muted criticals and printed "0 findings" would be the
    // quarantine defect again in a different table.
    const gate = evaluateGates(noCriticals, {
      results: [result()],
      findings: { findings: [], excludedMuted: 40, excludedQuarantined: 2 },
    });
    expect(only(gate, 'MAX_FINDINGS').detail).toContain('40 muted');
    expect(only(gate, 'MAX_FINDINGS').detail).toContain('2 from quarantined');
  });

  it('refuses a kind filter this build does not understand', () => {
    // `onlyKinds` comes out of a Json column. A project configured against a
    // newer vocabulary, or a hand-edited row, would otherwise filter to nothing
    // and report a clean pass — a gate switched off by a typo.
    const gate = evaluateGates(
      [
        {
          kind: 'MAX_FINDINGS',
          atOrAbove: 'CRITICAL',
          onlyKinds: ['SUPPLY_CHAIN' as never],
          max: 0,
          action: 'BLOCK',
        },
      ],
      { results: [result()], findings: { findings: [finding()] } },
    );
    expect(only(gate, 'MAX_FINDINGS').action).toBe('UNMEASURED');
    expect(only(gate, 'MAX_FINDINGS').detail).toContain('does not know');
  });

  it('a capped list cannot CLEAR the rule, but can still fail it', () => {
    const under = evaluateGates(noCriticals, {
      results: [result()],
      findings: { findings: [], truncated: true },
    });
    // Nobody counted the rest, so a pass would be a claim about rows no query
    // returned.
    expect(only(under, 'MAX_FINDINGS').action).toBe('UNMEASURED');

    const over = evaluateGates(noCriticals, {
      results: [result()],
      findings: { findings: [finding()], truncated: true },
    });
    // More rows can only make it worse, so the failure stands.
    expect(only(over, 'MAX_FINDINGS').action).toBe('BLOCK');
  });
});

describe('a severity this build does not know is counted, and said out loud', () => {
  // `FindingSeverity` is a TypeScript union over a TEXT column that PLUGINS
  // write, so an unrecognised value is not hypothetical — an external plugin's
  // JSON, a newer vocabulary, a hand-edited row. `severityRank` answers 0 for
  // it, which is the worst rank because the list is worst-first, and nothing
  // noticed: changing that to 99 (an unknown severity silently dropped from the
  // count) left every test in this file green.
  const noCriticals: GateRule[] = [
    { kind: 'MAX_FINDINGS', atOrAbove: 'CRITICAL', onlyKinds: [], max: 0, action: 'BLOCK' },
  ];

  const exotic = finding({ severity: 'CATASTROPHIC' as unknown as FindingSeverity, code: 'plugin.unknown' });

  it('counts it rather than dropping it', () => {
    const gate = evaluateGates(noCriticals, { results: [result()], findings: { findings: [exotic] } });
    // Dropped, this is "0 finding(s) at or above CRITICAL" and a clean PASS: a
    // failure suppressed without being counted, decided by this build not
    // knowing a word.
    expect(only(gate, 'MAX_FINDINGS').action).toBe('BLOCK');
    expect(only(gate, 'MAX_FINDINGS').detail).toContain('1 finding(s) at or above CRITICAL');
  });

  it('says that is what it did, because it may have been a MINOR', () => {
    // The cost of ranking it as the worst, in the sentence a team reads off the
    // block — otherwise they can only tell this case from a real critical by
    // reading our source.
    const detail = only(
      evaluateGates(noCriticals, { results: [result()], findings: { findings: [exotic] } }),
      'MAX_FINDINGS',
    ).detail;
    expect(detail).toContain('severity this build does not know');
    expect(detail).toContain('CATASTROPHIC');
    expect(detail).toContain('counted as the worst rather than dropped');
  });

  it('says nothing of the kind when every severity is known', () => {
    const detail = only(
      evaluateGates(noCriticals, { results: [result()], findings: { findings: [finding()] } }),
      'MAX_FINDINGS',
    ).detail;
    expect(detail).not.toContain('does not know');
  });
});

describe('the mutation score can finally refuse a merge', () => {
  const rules: GateRule[] = [{ kind: 'MIN_MUTATION_SCORE', percent: 60, action: 'BLOCK' }];

  it('is UNMEASURED when no mutation test ran, and says 0 would have meant something else', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      mutation: { resultsWithData: 0, detected: 0, undetected: 0, excluded: 0 },
    });
    expect(only(gate, 'MIN_MUTATION_SCORE').action).toBe('UNMEASURED');
    expect(only(gate, 'MIN_MUTATION_SCORE').detail).toContain('every mutant survived');
  });

  it('is UNMEASURED when a run produced no valid mutant', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      mutation: { resultsWithData: 3, detected: 0, undetected: 0, excluded: 12 },
    });
    expect(only(gate, 'MIN_MUTATION_SCORE').action).toBe('UNMEASURED');
    expect(only(gate, 'MIN_MUTATION_SCORE').detail).toContain('12 excluded');
  });

  it('BLOCKS on a measured score of zero — which is not the same as unmeasured', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      mutation: { resultsWithData: 1, detected: 0, undetected: 40, excluded: 0 },
    });
    expect(only(gate, 'MIN_MUTATION_SCORE').action).toBe('BLOCK');
    expect(only(gate, 'MIN_MUTATION_SCORE').detail).toContain('0% of 40 valid mutant(s)');
  });

  it('pools by mutant rather than averaging percentages', () => {
    // 1 of 1 killed in one file and 10 of 100 in another is 11/101 = 10.9%, not
    // the mean of 100% and 10%. The mean would let a tiny well-asserted file
    // clear the gate for a large unasserted one.
    const gate = evaluateGates(rules, {
      results: [result()],
      mutation: { resultsWithData: 2, detected: 11, undetected: 90, excluded: 4 },
    });
    expect(only(gate, 'MIN_MUTATION_SCORE').detail).toContain('10.9% of 101 valid mutant(s)');
    expect(only(gate, 'MIN_MUTATION_SCORE').action).toBe('BLOCK');
  });
});

describe('Core Web Vitals gate on the breach the product actually stores', () => {
  const rules: GateRule[] = [
    { kind: 'MAX_VITAL_BREACHES', metric: 'ANY', max: 0, action: 'BLOCK' },
  ];

  it('is UNMEASURED when no performance test ran', () => {
    // "Zero breaches" out of a suite with no performance test in it is a fact
    // about the suite, not about the pages.
    const gate = evaluateGates(rules, {
      results: [result()],
      vitals: { performanceTests: 0, breaches: [] },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('UNMEASURED');
    expect(only(gate, 'MAX_VITAL_BREACHES').detail).toContain('about the suite');
  });

  it('BLOCKS on a breach once something measured one', () => {
    const gate = evaluateGates(rules, {
      results: [result()],
      vitals: {
        performanceTests: 1,
        breaches: [{ metric: 'lcpMs', location: '/', message: 'performance.budget-exceeded.lcpMs' }],
      },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('BLOCK');
    expect(only(gate, 'MAX_VITAL_BREACHES').detail).toContain('lcpMs at /');
  });

  it('scopes to one metric when the rule names one', () => {
    const gate = evaluateGates([{ kind: 'MAX_VITAL_BREACHES', metric: 'clsScore', max: 0, action: 'BLOCK' }], {
      results: [result()],
      vitals: {
        performanceTests: 2,
        breaches: [{ metric: 'lcpMs', location: '/', message: 'x' }],
      },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('PASS');
  });
});

describe('a breach list the cap could have cut cannot clear the vitals rule', () => {
  // The breaches ride on the SAME findings list `MAX_FINDINGS` reads, so the
  // caller's 500-row cap drops them too — and `VitalsGateInput` had no way to
  // say so, which is how `MAX_VITAL_BREACHES max: 0` came to report "0 budget
  // breach(es)" on a run that had recorded one.
  const noBreaches: GateRule[] = [
    { kind: 'MAX_VITAL_BREACHES', metric: 'ANY', max: 0, action: 'BLOCK' },
  ];

  it('is UNMEASURED when the list was capped and the breaches read are within the cap', () => {
    const gate = evaluateGates(noBreaches, {
      results: [result()],
      vitals: { performanceTests: 2, breaches: [], truncated: true },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('UNMEASURED');
    expect(only(gate, 'MAX_VITAL_BREACHES').detail).toContain('capped before it was counted');
    expect(gate.passed).toBe(true);
  });

  it('still FAILS over the cap, because rows nobody read can only make it worse', () => {
    const gate = evaluateGates(noBreaches, {
      results: [result()],
      vitals: {
        performanceTests: 2,
        breaches: [{ metric: 'lcpMs', location: '/checkout', message: 'x' }],
        truncated: true,
      },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('BLOCK');
  });

  it('passes a complete list of none, which is the fact the flag protects', () => {
    const gate = evaluateGates(noBreaches, {
      results: [result()],
      vitals: { performanceTests: 2, breaches: [], truncated: false },
    });
    expect(only(gate, 'MAX_VITAL_BREACHES').action).toBe('PASS');
  });
});

describe('a project cannot configure the environment rule as one of its own', () => {
  it('reports UNMEASURED and says where that answer is produced instead', () => {
    // The same answer, and for the same reason, as the quarantine budget below:
    // the environment evaluation is appended by the run finaliser, which is the
    // only caller that knows which tests were blocked and why. A PASS here
    // would be this file certifying an environment it was given no policy
    // about — and the brake exists so that a run which measured nothing cannot
    // merge, which a project-removable rule would not do.
    const gate = evaluateGates([{ kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' }], {
      results: [blocked()],
    });
    const rule = only(gate, 'ENVIRONMENT_AVAILABLE');
    expect(rule.action).toBe('UNMEASURED');
    expect(rule.passed).toBeNull();
    expect(rule.detail).toContain('The environment must be usable');
    expect(rule.detail).toContain('produced by the run finaliser');
    expect(gate.passed).toBe(true);
  });
});

describe('patch coverage gates the diff rather than the project', () => {
  it('BLOCKS a diff whose changed route has no test', () => {
    const gate = evaluateGates([{ kind: 'NO_NEW_UNCOVERED_ROUTES', action: 'BLOCK' }], {
      results: [result()],
      patch: patchOf({
        denominator: 2,
        covered: 1,
        uncovered: 1,
        percent: 50,
        routes: [
          { route: '/checkout', state: 'COVERED', key: 'ROUTE:/checkout', paths: ['app/checkout/page.tsx'], subtree: false },
          { route: '/promo', state: 'UNCOVERED', key: 'ROUTE:/promo', paths: ['app/promo/page.tsx'], subtree: false },
        ],
      }),
    });
    expect(gate.passed).toBe(false);
    expect(only(gate, 'NO_NEW_UNCOVERED_ROUTES').detail).toContain('/promo');
  });

  it('carries the caveats into the sentence a reviewer reads', () => {
    // The number is only as good as the join behind it, and "a rename and an
    // addition leave the same evidence" has to travel WITH the percentage.
    const gate = evaluateGates([{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }], {
      results: [result()],
      patch: patchOf({
        denominator: 1,
        covered: 1,
        percent: 100,
        unrecognised: 1,
        caveats: ['1 changed route(s) have no inventory row: a route this diff adds, a route it renames, or a stale inventory.'],
        routes: [
          { route: '/cart', state: 'COVERED', key: 'ROUTE:/cart', paths: ['app/cart/page.tsx'], subtree: false },
        ],
      }),
    });
    expect(only(gate, 'MIN_PATCH_COVERAGE').action).toBe('PASS');
    expect(only(gate, 'MIN_PATCH_COVERAGE').detail).toContain('renames');
  });

  it('is UNMEASURED when the changed surface could not be scoped', () => {
    const gate = evaluateGates(
      [
        { kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' },
        { kind: 'NO_NEW_UNCOVERED_ROUTES', action: 'BLOCK' },
      ],
      {
        results: [result()],
        patch: patchOf({
          measured: false,
          caveats: ['This diff changes package-lock.json, which can affect any page.'],
        }),
      },
    );
    expect(only(gate, 'MIN_PATCH_COVERAGE').action).toBe('UNMEASURED');
    expect(only(gate, 'NO_NEW_UNCOVERED_ROUTES').action).toBe('UNMEASURED');
    expect(only(gate, 'MIN_PATCH_COVERAGE').detail).toContain('package-lock.json');
  });

  it('is UNMEASURED when there is no diff at all, rather than 0%', () => {
    const gate = evaluateGates([{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }], {
      results: [result()],
    });
    expect(only(gate, 'MIN_PATCH_COVERAGE').action).toBe('UNMEASURED');
  });
});

describe('a project cannot configure the quarantine budget as one of its own rules', () => {
  it('reports UNMEASURED and says where the budget is read from instead', () => {
    // It used to fall off the end of the evaluator's switch and leave `passed`
    // at its initialised `true`, so writing this rule into a project's list
    // produced a silent PASS — a configured gate that scored nothing.
    const gate = evaluateGates([{ kind: 'MAX_QUARANTINE_PERCENT', percent: 1, action: 'BLOCK' }], {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 40 },
    });
    const configured = gate.evaluations[0]!;
    expect(configured.action).toBe('UNMEASURED');
    expect(configured.detail).toContain('cannot configure it away');
    // And the real alarm still blocks, from the appended evaluation.
    expect(gate.passed).toBe(false);
  });
});

// ─── Re-scoring after triage ─────────────────────────────────────────────────

describe('rescoreGate supersedes rather than accumulates', () => {
  const blockedGate = (): GateResult => ({
    passed: false,
    evaluations: [
      {
        rule: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
        passed: false,
        action: 'BLOCK',
        detail: 'Block on REAL_BUG — 1 REAL_BUG verdict(s): checkout',
      },
    ],
    unmeasured: 0,
  });

  const provisional = (): GateResult =>
    evaluateGates([{ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] }], {
      results: [result({ status: 'FAILED', verdict: null })],
    });

  it('writes nothing when the re-score comes out identical', () => {
    const first = provisional();
    const decision = rescoreGate({ stored: first, next: provisional(), at: NOW });
    expect(decision.changed).toBe(false);
    expect(decision.gate).toBeNull();
    expect(decision.generation).toBe(1);
  });

  it('is idempotent across the jsonb round trip, which reorders keys', () => {
    // The whole of the idempotence. `Run.gateResult` is a jsonb column and jsonb
    // does not preserve key order, so a stringify comparison would decide the
    // gate had changed on EVERY read — and the sweep ticks every minute, so the
    // generation counter would climb forever. That is accumulation wearing the
    // word supersede.
    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorderKeys);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, held]) => [key, reorderKeys(held)]),
        );
      }
      return value;
    };

    const stored = reorderKeys(JSON.parse(JSON.stringify(provisional())));
    expect(rescoreGate({ stored, next: provisional(), at: NOW }).changed).toBe(false);
  });

  it('names a pass that became a block, and counts the generation', () => {
    const decision = rescoreGate({ stored: provisional(), next: blockedGate(), at: NOW });

    expect(decision.changed).toBe(true);
    expect(decision.reversedGreen).toBe(true);
    expect(decision.generation).toBe(2);
    expect(decision.gate!.rescored).toEqual({
      atIso: NOW.toISOString(),
      generation: 2,
      previousPassed: true,
      reversedGreen: true,
      reason: decision.reason,
    });
    // The sentence is printed verbatim by every surface that shows a gate, so
    // the flip can never be silent.
    expect(decision.reason).toContain('reported a PASS and now BLOCKS');
    expect(decision.reason).toContain('checkout');
  });

  it('does not keep incrementing the generation once it has settled', () => {
    const first = rescoreGate({ stored: provisional(), next: blockedGate(), at: NOW });
    const again = rescoreGate({ stored: first.gate, next: blockedGate(), at: NOW });

    expect(again.changed).toBe(false);
    expect(again.gate).toBeNull();
    expect(again.generation).toBe(2);
  });

  it('counts generations only when the answer actually changed', () => {
    const second = rescoreGate({ stored: provisional(), next: blockedGate(), at: NOW });
    const third = rescoreGate({ stored: second.gate, next: provisional(), at: NOW });
    expect(third.generation).toBe(3);
    expect(third.reversedGreen).toBe(false);
  });

  it('says plainly that clearing the gate does not clear the failures', () => {
    const cleared = evaluateGates(
      [{ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] }],
      { results: [result({ status: 'FAILED', verdict: 'FLAKE' })] },
    );
    const decision = rescoreGate({ stored: blockedGate(), next: cleared, at: NOW });
    expect(decision.gate!.passed).toBe(true);
    expect(decision.reason).toContain('counted separately');
  });

  // ── What a re-score may not drop SILENTLY ─────────────────────────────────
  //
  // `rescoreRunGate` scores with the PROJECT's current rule list, while the
  // stored gate was written from the run's frozen snapshot. So a project that
  // edits a rule out between finalisation and triage — the ordinary way to stop
  // a gate blocking — gets a gate with an evaluation missing, and `changedCount`
  // counts only what the NEW gate holds that the stored one did not, so a pure
  // removal moves nothing it can see.

  it('names the rule kinds it stopped scoring, so a BLOCK it dropped is not silent', () => {
    // The gate flips BLOCK -> PASS on the strength of a dropped MAX_FINDINGS
    // BLOCK, and the sentence used to account for exactly one change: the
    // verdict line. The one evaluation that turned the gate green was named
    // nowhere. Dropping it is CORRECT — the project deleted the rule — so this
    // reports it rather than carrying it.
    const verdict: GateRule = { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] };
    const stored = asStored(
      evaluateGates(
        [verdict, { kind: 'MAX_FINDINGS', atOrAbove: 'CRITICAL', onlyKinds: [], max: 0, action: 'BLOCK' }],
        { results: [result({ status: 'FAILED', verdict: null })], findings: { findings: [finding()] } },
      ),
    );
    const next = evaluateGates([verdict], {
      results: [result({ status: 'FAILED', verdict: 'FLAKE' })],
    });
    const decision = rescoreGate({ stored, next, at: NOW });

    expect(decision.gate!.passed).toBe(true);
    expect(decision.reason).toContain('no longer scored at all');
    expect(decision.reason).toContain('MAX_FINDINGS');
  });

  it('does not report "0 evaluation(s) changed" over a gate it has just rewritten', () => {
    // The pure-removal case. Nothing in the new gate is new, so `changedCount`
    // is 0 — and the gate is still written and the generation still bumped,
    // because an evaluation left it. "0 evaluation(s) changed" beside a rewrite
    // is a re-score accounting for no change at all.
    const verdict: GateRule = { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] };
    const results = [result({ status: 'FAILED', verdict: 'REAL_BUG' })];
    const stored = asStored(
      evaluateGates([verdict, { kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'WARN' }], { results }),
    );
    const decision = rescoreGate({ stored, next: evaluateGates([verdict], { results }), at: NOW });

    expect(decision.changed).toBe(true);
    expect(decision.reason).toContain('0 evaluation(s) changed');
    expect(decision.reason).toContain('MIN_PASS_RATE');
    expect(decision.reason).toContain('no longer scored at all');
  });

  it('says nothing about dropped rules when a threshold was merely edited', () => {
    // Compared by KIND on purpose: a rule whose number changed is still scored,
    // and reporting it as "no longer scored at all" would be a second false
    // account replacing the first. It belongs in `changedCount`.
    const verdict: GateRule = { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] };
    const results = [result({ status: 'FAILED', verdict: 'REAL_BUG' })];
    const stored = asStored(
      evaluateGates([verdict, { kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'WARN' }], { results }),
    );
    const decision = rescoreGate({
      stored,
      next: evaluateGates([verdict, { kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'WARN' }], {
        results,
      }),
      at: NOW,
    });

    expect(decision.changed).toBe(true);
    expect(decision.reason).toContain('1 evaluation(s) changed');
    expect(decision.reason).not.toContain('no longer scored at all');
  });

  it('will not clear a BLOCK it cannot account for', () => {
    // A stored gate that says `passed: false` and carries no readable
    // evaluations. We cannot say which rule blocked, so replacing it with a
    // freshly computed pass would be clearing a refusal on the strength of not
    // understanding it. Found by an existing test rather than by reasoning,
    // which is why it is pinned here.
    const decision = rescoreGate({ stored: { passed: false }, next: provisional(), at: NOW });
    expect(decision.changed).toBe(false);
    expect(decision.gate).toBeNull();
    expect(decision.reason).toContain('must not be cleared');
  });

  it('treats an unreadable stored gate as a first scoring, not as a supersede', () => {
    for (const stored of [null, undefined, 'nope', [], { passed: 'yes' }, { evaluations: {} }]) {
      const decision = rescoreGate({ stored, next: blockedGate(), at: NOW });
      expect(decision.changed).toBe(true);
      expect(decision.generation).toBe(1);
      expect(decision.previousPassed).toBeNull();
      // No `rescored` block: claiming to supersede a result that never existed
      // would put a `previousPassed` on the row that nothing ever said.
      expect(decision.gate!.rescored).toBeUndefined();
    }
  });

  // ── What a re-score may not drop ──────────────────────────────────────────
  //
  // The environment evaluation is APPENDED by the run finaliser — it is the only
  // caller that knows which tests were blocked and why — so `evaluateGates`
  // cannot produce it, and a re-score that replaces the evaluations wholesale
  // deleted it. On a WARN that lost the report. On the unattemptable BLOCK it
  // turned a run that executed nothing green, and said "2 evaluation(s) changed
  // once the verdicts existed" about verdicts that had not changed.

  const ENV_BLOCK_DETAIL =
    'Environment — nothing in this run could be attempted: 2 test(s) are of a type this ' +
    'deployment cannot execute (k6 load, lighthouse) — install the missing tool on the worker. ' +
    'There is no verdict here, so nothing may merge on the strength of it.';
  const ENV_WARN_DETAIL =
    'Environment — 2 test(s) could not be attempted because the environment was not usable ' +
    '(checkout, cart). None of this is a verdict on your application.';

  /** The gate as the jsonb column hands it back: a plain object and nothing else. */
  const asStored = (gate: GateResult | null): unknown => JSON.parse(JSON.stringify(gate));

  const envEvaluation = (action: 'WARN' | 'BLOCK'): GateResult['evaluations'][number] => ({
    rule: { kind: 'ENVIRONMENT_AVAILABLE', action },
    passed: false,
    action,
    detail: action === 'BLOCK' ? ENV_BLOCK_DETAIL : ENV_WARN_DETAIL,
  });

  /** A finalisation gate with the environment line the finaliser appended. */
  const storedWithEnvironment = (action: 'WARN' | 'BLOCK'): GateResult => {
    const base = provisional();
    const evaluations = [...base.evaluations, envEvaluation(action)];
    return {
      ...base,
      evaluations,
      passed: evaluations.every((e) => e.action !== 'BLOCK'),
    };
  };

  /** The same gate, once triage has settled the failure as a flake. */
  const triagedFlake = (): GateResult =>
    evaluateGates([{ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] }], {
      results: [result({ status: 'FAILED', verdict: 'FLAKE' })],
    });

  it('may not clear an environment BLOCK it cannot recompute', () => {
    // THE defect, and the worst one re-scoring has had: a sharded run whose
    // every selected test was of an unsupported type took the unattemptable
    // BLOCK, and the first re-score rewrote the gate `passed: true`.
    const stored = asStored(storedWithEnvironment('BLOCK'));
    const decision = rescoreGate({ stored, next: triagedFlake(), at: NOW });

    expect(decision.gate!.passed).toBe(false);
    expect(decision.carriedForward).toBe(1);
    const environment = decision.gate!.evaluations.find(
      (e) => e.rule.kind === 'ENVIRONMENT_AVAILABLE',
    )!;
    // Verbatim. The detail is the whole message — it is what the check summary,
    // the chat alert and the CLI print — so a paraphrase would lose the names.
    expect(environment.detail).toBe(ENV_BLOCK_DETAIL);
    expect(environment.action).toBe('BLOCK');
    expect(decision.reason).toContain('carried forward');
    expect(decision.reason).toContain('ENVIRONMENT_AVAILABLE');
  });

  it('does not rewrite a gate just to drop the environment WARN', () => {
    // Probe 1: the WARN simply vanished the first time the gate was re-scored,
    // on any run holding one test of an unsupported type. Carried forward, the
    // re-score comes out identical and writes nothing at all.
    const stored = asStored(storedWithEnvironment('WARN'));
    const decision = rescoreGate({ stored, next: provisional(), at: NOW });

    expect(decision.changed).toBe(false);
    expect(decision.gate).toBeNull();
    expect(decision.carriedForward).toBe(1);
  });

  it('carries it once, so repeat re-scores do not grow the gate', () => {
    const first = rescoreGate({
      stored: asStored(storedWithEnvironment('BLOCK')),
      next: triagedFlake(),
      at: NOW,
    });
    const again = rescoreGate({ stored: asStored(first.gate), next: triagedFlake(), at: NOW });

    expect(again.changed).toBe(false);
    expect(again.gate).toBeNull();
    expect(again.generation).toBe(2);
  });

  it('does not accumulate the stored UNMEASURED line beside the carried one', () => {
    // A project that writes ENVIRONMENT_AVAILABLE into its own rule list ends up
    // with TWO lines of that kind on its stored gate: the UNMEASURED one
    // `evaluateGates` writes saying where the answer really comes from, and the
    // real one the finaliser appends. Only the MEASURED one may be carried.
    // Carrying the UNMEASURED one as well would re-add a line the fresh scoring
    // has already produced, so the gate would grow by one evaluation and
    // `unmeasured` by one on EVERY re-score, for ever — accumulation wearing
    // the word supersede, which is the one thing rule 1 forbids.
    const rules: GateRule[] = [
      { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
      { kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' },
    ];
    const configured = evaluateGates(rules, {
      results: [result({ status: 'FAILED', verdict: null })],
    });
    const storedGate: GateResult = {
      ...configured,
      evaluations: [...configured.evaluations, envEvaluation('BLOCK')],
      passed: false,
    };
    const triaged = () =>
      evaluateGates(rules, { results: [result({ status: 'FAILED', verdict: 'FLAKE' })] });

    const first = rescoreGate({ stored: asStored(storedGate), next: triaged(), at: NOW });
    expect(first.carriedForward).toBe(1);
    // Three: the verdict line, the configured UNMEASURED line, the carried real
    // one. Not four, and `unmeasured` describes exactly that list.
    expect(first.gate!.evaluations).toHaveLength(3);
    expect(first.gate!.unmeasured).toBe(1);
    expect(first.gate!.passed).toBe(false);

    // And it settles: a second re-score of the gate it just wrote comes out
    // identical, so the generation stops climbing.
    const again = rescoreGate({ stored: asStored(first.gate), next: triaged(), at: NOW });
    expect(again.changed).toBe(false);
    expect(again.gate).toBeNull();
  });

  it('is superseded by a scoring that actually measured that kind', () => {
    // The carry-forward is for what this scoring did NOT measure. The quarantine
    // alarm is appended too, and when the re-score read the project's quarantine
    // state its answer is the current one — carrying the old line as well would
    // print two budgets.
    const stored = asStored(
      evaluateGates([], { results: [result()], quarantine: { totalTests: 100, quarantinedCount: 40 } }),
    );
    const next = evaluateGates([], {
      results: [result()],
      quarantine: { totalTests: 100, quarantinedCount: 1 },
    });
    const decision = rescoreGate({ stored, next, at: NOW });

    expect(decision.carriedForward).toBe(0);
    expect(
      decision.gate!.evaluations.filter((e) => e.rule.kind === 'MAX_QUARANTINE_PERCENT'),
    ).toHaveLength(1);
    expect(decision.gate!.passed).toBe(true);
  });

  it('does not treat a project-configured environment rule as the measurement', () => {
    // A project that writes ENVIRONMENT_AVAILABLE into its own rule list gets an
    // UNMEASURED line saying where that answer really comes from. Reading that
    // line as a recomputation would delete the finaliser's real one — the same
    // drop, through the door marked configuration.
    const stored = asStored(storedWithEnvironment('BLOCK'));
    const next = evaluateGates(
      [
        { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
        { kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' },
      ],
      { results: [result({ status: 'FAILED', verdict: 'FLAKE' })] },
    );
    const decision = rescoreGate({ stored, next, at: NOW });

    expect(decision.carriedForward).toBe(1);
    expect(decision.gate!.passed).toBe(false);
    const lines = decision.gate!.evaluations.filter(
      (e) => e.rule.kind === 'ENVIRONMENT_AVAILABLE',
    );
    // Both: the configured rule's "this is not where it is read from", and the
    // finaliser's actual refusal.
    expect(lines.map((e) => e.action).sort()).toEqual(['BLOCK', 'UNMEASURED']);
  });

  it('refuses the whole re-score when a stored evaluation cannot be read', () => {
    // An evaluation nobody can account for must not be deleted on the strength
    // of not understanding it — the rule `claimedPassed` already applies to a
    // whole gate, applied one level down.
    const broken_ = [
      null,
      7,
      'nope',
      {},
      // A rule with no kind: this could be the environment line and nothing can
      // say that it is not.
      { rule: {}, action: 'BLOCK', detail: 'x', passed: false },
      // An action outside the four.
      { rule: { kind: 'ENVIRONMENT_AVAILABLE' }, action: 'NOPE', detail: 'x', passed: false },
      // A `passed` that is neither a boolean nor null, so "was this measured"
      // has no answer — which is the question the carry-forward turns on.
      { rule: { kind: 'ENVIRONMENT_AVAILABLE' }, action: 'BLOCK', detail: 'x', passed: 'nope' },
      // No detail, which is the whole message on an environment line.
      { rule: { kind: 'ENVIRONMENT_AVAILABLE' }, action: 'BLOCK', passed: false },
    ];
    for (const broken of broken_) {
      const stored = { passed: false, evaluations: [broken] };
      const decision = rescoreGate({ stored, next: triagedFlake(), at: NOW });
      expect(decision.gate).toBeNull();
      expect(decision.changed).toBe(false);
      expect(decision.reason).toContain('cannot read');
    }
  });

  it('carries a quarantine budget BLOCK that this scoring could not measure', () => {
    // The budget is appended too, from the PROJECT's quarantine state, and only
    // when the caller could read it — `quarantineHealthFor` in the run finaliser
    // returns nothing on a failed query, on purpose. A re-score that could not
    // read it either must not thereby clear the refusal: the budget bounds the
    // mechanism that switches signals off, and dropping it would be that
    // mechanism, performed by its own brake.
    const stored = asStored(
      evaluateGates([], {
        results: [result()],
        quarantine: { totalTests: 100, quarantinedCount: 40 },
      }),
    );
    // A scoring that read no quarantine state, and whose other rule DID change,
    // so the merged gate is written rather than coming out identical.
    const decision = rescoreGate({
      stored,
      next: evaluateGates([{ kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'WARN' }], {
        results: [result()],
      }),
      at: NOW,
    });

    expect(decision.carriedForward).toBe(1);
    expect(decision.gate!.passed).toBe(false);
    expect(
      decision.gate!.evaluations.find((e) => e.rule.kind === 'MAX_QUARANTINE_PERCENT')!.detail,
    ).toContain('Quarantine budget');
  });

  it('does NOT carry a configured rule the project has since removed', () => {
    // The other half of the same judgement, and the reason the carried set is
    // the APPENDED kinds rather than "anything this scoring did not measure". A
    // rule is in a gate because the project's rule list put it there, so its
    // absence is the customer's own change — carrying it would mean a rule they
    // deleted went on blocking their merges with nothing able to clear it.
    const stored = asStored(
      evaluateGates([{ kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' }], {
        results: [result()],
        coverage: {
          percent: 41.5,
          denominator: 200,
          covered: 83,
          measuredAtIso: '2026-10-24T00:00:00.000Z',
          commitSha: null,
        },
      }),
    );
    const decision = rescoreGate({ stored, next: provisional(), at: NOW });

    expect(decision.carriedForward).toBe(0);
    expect(decision.gate!.evaluations.some((e) => e.rule.kind === 'MIN_COVERAGE')).toBe(false);
    expect(decision.gate!.passed).toBe(true);
  });

  it('no longer blames the verdicts for a change it cannot attribute', () => {
    // The old sentence read "N evaluation(s) changed once the verdicts existed",
    // and on the defect above it was printed over a gate whose verdicts were
    // exactly what had NOT changed. This function is handed two gates and no
    // account of what moved between them.
    const decision = rescoreGate({ stored: blockedGate(), next: triagedFlake(), at: NOW });
    expect(decision.reason).not.toContain('once the verdicts existed');
    expect(decision.reason).toContain('changed since it was first scored');
  });

  it('gateAwaitsTriage waits on the VERDICT rule and not on any unmeasured rule', () => {
    // The kind test is what bounds the re-score sweep: `sweepRescoreWithoutCheck`
    // in apps/worker/src/processors/checks.ts uses this as its pre-filter and its
    // docstring promises only a PROVISIONAL gate is swept. Every measurement
    // rule reports UNMEASURED when its input was not read, and a configured
    // ENVIRONMENT_AVAILABLE rule reports it on EVERY run by design — so without
    // the kind test those projects would have every gate re-scored for ever,
    // every sweep tick, to discover nothing had changed.
    const unread = evaluateGates([{ kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' }], {
      results: [result()],
    });
    expect(only(unread, 'MIN_COVERAGE').action).toBe('UNMEASURED');
    expect(gateAwaitsTriage(unread)).toBe(false);

    const appended = evaluateGates([{ kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' }], {
      results: [result()],
    });
    expect(only(appended, 'ENVIRONMENT_AVAILABLE').action).toBe('UNMEASURED');
    expect(gateAwaitsTriage(appended)).toBe(false);
  });

  it('gateAwaitsTriage reads a stored gate defensively', () => {
    expect(gateAwaitsTriage(null)).toBe(false);
    expect(gateAwaitsTriage({ passed: true, evaluations: [{}, null, 7] })).toBe(false);
    expect(gateAwaitsTriage(JSON.parse(JSON.stringify(provisional())))).toBe(true);
  });
});

// ─── The quarantine classification, shared with the re-score ─────────────────

describe('quarantineHealthFrom', () => {
  const row = (
    over: Partial<{
      id: string;
      name: string;
      quarantinedAt: Date | null;
      quarantineExpiresAt: Date | null;
    }> = {},
  ) => ({ id: 't1', name: 'checkout', quarantinedAt: day(-1), quarantineExpiresAt: day(10), ...over });

  it('sorts the rows into the three warnings', () => {
    const health = quarantineHealthFrom({
      totalTests: 100,
      quarantinedCount: 4,
      rows: [
        row({ id: 'a', name: 'expired', quarantineExpiresAt: day(-1) }),
        row({ id: 'b', name: 'soon', quarantineExpiresAt: day(1) }),
        row({
          id: 'c',
          name: 'unbounded',
          quarantineExpiresAt: null,
          quarantinedAt: day(-(QUARANTINE_MAX_DAYS + 1)),
        }),
        row({ id: 'd', name: 'fine', quarantineExpiresAt: day(10) }),
      ],
      now: NOW,
    });

    expect(health.expired?.map((e) => e.testName)).toEqual(['expired']);
    expect(health.expiringSoon?.map((e) => e.testName)).toEqual(['soon']);
    expect(health.unbounded?.map((e) => e.testName)).toEqual(['unbounded']);
  });

  it('keeps the count the caller measured rather than counting the capped rows', () => {
    // The rows are a bounded sample for the NAMES. Counting the budget from
    // them is how a project with 4,000 quarantined tests reports 200, lands
    // under its cap, and the alarm goes quiet on the worst suite in the install.
    const health = quarantineHealthFrom({
      totalTests: 4_000,
      quarantinedCount: 4_000,
      rows: [row()],
      now: NOW,
    });
    expect(health.quarantinedCount).toBe(4_000);
    expect(evaluateGates([], { results: [result()], quarantine: health }).passed).toBe(false);
  });

  it('does not report a fresh quarantine with no expiry as unbounded', () => {
    // Those predate the expiry rule; one taken out this morning by a writer
    // that does not stamp an expiry yet is not news, and reporting it would
    // fire this warning on every run of every install.
    const health = quarantineHealthFrom({
      totalTests: 10,
      quarantinedCount: 1,
      rows: [row({ quarantineExpiresAt: null, quarantinedAt: day(-1) })],
      now: NOW,
    });
    expect(health.unbounded).toEqual([]);
  });
});
