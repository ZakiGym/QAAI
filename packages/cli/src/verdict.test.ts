/**
 * The CLI's exit code.
 *
 * This is the consumer the original defect was most expensive in: a quarantined
 * test's failure made `failedCount` nonzero, the CLI exited 1, and the build
 * went red over a test the quality gate had already agreed to ignore. Nothing
 * tested it, which is why it survived.
 *
 * Two things are asserted throughout, and the second matters as much as the
 * first: the exit code, and that the suppressed failures are still PRINTED. A
 * quarantine that silences the build log is the failure mode this product
 * exists to remove, not one it is allowed to introduce.
 */

import { describe, expect, it } from 'vitest';
import { summaryLine, verdictOf } from './verdict.js';
import type { RunVerdictView } from './verdict.js';

function view(over: Partial<RunVerdictView> = {}): RunVerdictView {
  return {
    status: 'PASSED',
    failedCount: 0,
    gateResult: { passed: true },
    ...over,
  };
}

describe('verdictOf — the server answered', () => {
  it('exits zero on a run whose only failures were quarantined', () => {
    // THE DEFECT. This run used to exit 1.
    const verdict = verdictOf(
      view({
        status: 'PASSED',
        failedCount: 0,
        quarantinedFailedCount: 3,
        verdict: {
          passed: true,
          suppressedFailures: 3,
          reason:
            '4 test(s) passed and nothing that gates failed. 3 failing test(s) were quarantined.',
        },
      }),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.source).toBe('server');
  });

  it('still reports the suppressed failures on that passing run', () => {
    const verdict = verdictOf(
      view({ quarantinedFailedCount: 3, verdict: { passed: true, suppressedFailures: 3 } }),
    );
    expect(verdict.suppressedFailures).toBe(3);
  });

  it('prefers the server over the counters even when they disagree', () => {
    // A stale `failedCount` must not be able to override the verdict — the whole
    // point of a single source of truth is that the CLI stops having an opinion.
    const verdict = verdictOf(
      view({ status: 'FAILED', failedCount: 9, verdict: { passed: true, reason: 'ok' } }),
    );
    expect(verdict.passed).toBe(true);
  });

  it('exits nonzero when the server says the run failed', () => {
    const verdict = verdictOf(
      view({ status: 'FAILED', failedCount: 2, verdict: { passed: false, reason: '2 failed.' } }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe('2 failed.');
  });

  it('exits nonzero on a gate block even with every test green', () => {
    const verdict = verdictOf(
      view({
        status: 'FAILED',
        failedCount: 0,
        gateResult: { passed: false },
        verdict: { passed: false, reason: 'a quality gate blocked the run' },
      }),
    );
    expect(verdict.passed).toBe(false);
  });
});

describe('verdictOf — an older server that sends no verdict', () => {
  it('falls back to the counters and says it did', () => {
    const verdict = verdictOf(view({ status: 'FAILED', failedCount: 1 }));
    expect(verdict.source).toBe('counters');
    expect(verdict.passed).toBe(false);
  });

  it('says out loud that quarantine will not have worked', () => {
    // A customer whose quarantine is not taking effect deserves to be told it is
    // their server and not their quarantine.
    const verdict = verdictOf(view({ status: 'FAILED', failedCount: 1 }));
    expect(verdict.reason).toMatch(/did not report a verdict/i);
    expect(verdict.reason).toMatch(/Upgrade QAAI/);
  });

  it('honours quarantinedFailedCount if the server happens to send it', () => {
    const verdict = verdictOf(
      view({ status: 'PASSED', failedCount: 2, quarantinedFailedCount: 2 }),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.suppressedFailures).toBe(2);
  });

  it('never reports a negative suppressed count', () => {
    const verdict = verdictOf(
      view({ status: 'PASSED', failedCount: 0, quarantinedFailedCount: 0 }),
    );
    expect(verdict.suppressedFailures).toBe(0);
  });

  it('a cancelled run is not a green build', () => {
    const verdict = verdictOf(view({ status: 'CANCELLED', failedCount: 0 }));
    expect(verdict.passed).toBe(false);
  });

  it('an errored run is not a green build', () => {
    const verdict = verdictOf(view({ status: 'ERRORED', failedCount: 0 }));
    expect(verdict.passed).toBe(false);
  });

  it('a blocking gate still fails the build on the fallback path', () => {
    const verdict = verdictOf(view({ status: 'FAILED', gateResult: { passed: false } }));
    expect(verdict.passed).toBe(false);
  });

  it('passes a clean run', () => {
    expect(verdictOf(view()).passed).toBe(true);
  });
});

describe('summaryLine', () => {
  const counts = {
    status: 'PASSED',
    passedCount: 4,
    failedCount: 0,
    flakyCount: 1,
    skippedCount: 2,
  };

  it('gives quarantined failures a column of their own, never folded into skipped', () => {
    const line = summaryLine(
      { ...counts, quarantinedFailedCount: 3 },
      { passed: true, suppressedFailures: 3, reason: '', source: 'server' },
    );
    expect(line).toContain('2 skipped');
    expect(line).toContain('3 quarantined and failing');
  });

  it('says nothing about quarantine when nothing is suppressed', () => {
    const line = summaryLine(counts, {
      passed: true,
      suppressedFailures: 0,
      reason: '',
      source: 'server',
    });
    expect(line).not.toMatch(/quarantin/i);
  });

  it('marks a passing run with a tick and a failing one with a cross', () => {
    const base = { suppressedFailures: 0, reason: '', source: 'server' } as const;
    expect(summaryLine(counts, { ...base, passed: true })).toMatch(/^✓/);
    expect(summaryLine(counts, { ...base, passed: false })).toMatch(/^✗/);
  });
});
