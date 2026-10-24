/**
 * The on-prem finaliser's verdict — specifically, that a quarantined failure
 * does not turn a self-hosted build red.
 *
 * This file exists because the defect it guards survived in plain sight. The
 * counting rule had THREE hand-written copies (the worker's in-loop switch, the
 * worker's aggregate, and this one) and the "did the run pass" expression had
 * five. Only the gate honoured quarantine, so a quarantined test that failed
 * was excluded from the gate rules AND counted in `failedCount`, which is what
 * every other consumer reads: quarantine stopped the signal without stopping
 * the gate. Nobody saw the failure and nobody could merge.
 *
 * On-prem runs finalise HERE and not in the worker, so a fix that stopped at
 * the worker would have left every self-hosted-pool customer with the original
 * bug and nothing to show it. There was no test on this function at all, which
 * is the condition that let the bug live — `runners.test.ts` deliberately
 * covers only the pool arithmetic and makes any database call throw.
 *
 * The prisma fake here is the narrow one `finalizeIfComplete` actually uses:
 * every call it makes, nothing else, and it records the `run.update` payload so
 * the assertions are about what WOULD BE WRITTEN rather than about a return
 * value the caller ignores.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
  },
  isProd: false,
}));

interface ResultRow {
  testId: string;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  test: {
    name: string;
    priority: string;
    quarantined: boolean;
    quarantineExpiresAt: Date | null;
  };
  verdict: null;
}

/** What the fake was asked to write, so a test can read the verdict. */
let written: Record<string, unknown> | null = null;
let jobRows: Array<{ status: string; errorMessage: string | null }> = [];
let resultRows: ResultRow[] = [];
let gateRules: unknown = null;

vi.mock('./prisma.js', () => ({
  prisma: {
    runnerJob: { findMany: async () => jobRows },
    run: {
      // The claim: one finaliser wins, and this fake always lets it win.
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({
        id: 'run_1',
        trigger: 'MANUAL',
        prNumber: null,
        project: { gateRules },
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written = data;
        return { id: 'run_1' };
      },
    },
    testResult: { findMany: async () => resultRows },
  },
  unscoped: <T,>(fn: () => T) => fn(),
  withTenant: <T,>(_orgId: string, fn: () => T) => fn(),
  currentTenant: () => null,
}));

const published: Array<Record<string, unknown>> = [];
vi.mock('./queues.js', () => ({ enqueue: async () => {}, QUEUE_NAMES: { notify: 'notify' } }));
vi.mock('./events.js', () => ({
  publish: (_orgId: string, frame: Record<string, unknown>) => {
    published.push(frame);
  },
}));
vi.mock('./audit.js', () => ({ audit: async () => {} }));
vi.mock('./logger.js', () => ({
  logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { finalizeIfComplete } = await import('./runners.js');

function result(over: Partial<ResultRow> & { testId: string; status: string }): ResultRow {
  return {
    retriedAndPassed: false,
    durationMs: 1_000,
    verdict: null,
    ...over,
    test: {
      name: `test ${over.testId}`,
      priority: 'NORMAL',
      quarantined: false,
      quarantineExpiresAt: null,
      ...over.test,
    },
  };
}

beforeEach(() => {
  written = null;
  published.length = 0;
  jobRows = [{ status: 'COMPLETED', errorMessage: null }];
  resultRows = [];
  gateRules = null;
});

describe('an on-prem run whose only failure is quarantined', () => {
  beforeEach(() => {
    resultRows = [
      result({ testId: 't_ok', status: 'PASSED' }),
      result({
        testId: 't_quarantined',
        status: 'FAILED',
        test: {
          name: 'flaky checkout',
          priority: 'NORMAL',
          quarantined: true,
          quarantineExpiresAt: null,
        },
      }),
    ];
  });

  it('passes, and does not count the failure as a failure', async () => {
    expect(await finalizeIfComplete('org_1', 'run_1')).toBe(true);
    expect(written?.status).toBe('PASSED');
    expect(written?.failedCount).toBe(0);
  });

  it('still reports the suppressed failure rather than losing it', async () => {
    await finalizeIfComplete('org_1', 'run_1');
    // Not folded into skippedCount: a suppressed failure and a deliberate skip
    // are different facts, and the whole point is that this one still failed.
    expect(written?.quarantinedFailedCount).toBe(1);
    expect(written?.skippedCount).toBe(0);
  });

  it('tells subscribers the verdict without clobbering the passing-test count', async () => {
    await finalizeIfComplete('org_1', 'run_1');
    const frame = published.find((f) => f.type === 'run.finished');
    const data = frame?.data as Record<string, unknown>;
    // `...counts` carries `passed` as a NUMBER. A top-level boolean verdict
    // would silently replace it for every subscriber, so it is nested.
    expect(data.passed).toBe(1);
    expect((data.verdict as Record<string, unknown>).passed).toBe(true);
    expect((data.verdict as Record<string, unknown>).suppressedFailures).toBe(1);
  });
});

describe('an on-prem run with a real failure', () => {
  it('fails, so the suppression is not a blanket amnesty', async () => {
    resultRows = [
      result({ testId: 't_real', status: 'FAILED' }),
      result({
        testId: 't_quarantined',
        status: 'TIMED_OUT',
        test: {
          name: 'flaky checkout',
          priority: 'NORMAL',
          quarantined: true,
          quarantineExpiresAt: null,
        },
      }),
    ];
    await finalizeIfComplete('org_1', 'run_1');
    expect(written?.status).toBe('FAILED');
    expect(written?.failedCount).toBe(1);
    expect(written?.quarantinedFailedCount).toBe(1);
  });
});

describe('a quarantine that has run out', () => {
  it('gates again, because an expiry nobody renewed is not a suppression', async () => {
    resultRows = [
      result({
        testId: 't_expired',
        status: 'FAILED',
        test: {
          name: 'long-quarantined checkout',
          priority: 'NORMAL',
          quarantined: true,
          // Yesterday. The flag is still set — expiry deliberately does not
          // clear it, so the reason survives — it simply stops being honoured.
          quarantineExpiresAt: new Date(Date.now() - 86_400_000),
        },
      }),
    ];
    await finalizeIfComplete('org_1', 'run_1');
    expect(written?.status).toBe('FAILED');
    expect(written?.failedCount).toBe(1);
    expect(written?.quarantinedFailedCount).toBe(0);
  });
});

describe('a run where nothing executed', () => {
  it('errors rather than passing over an untested application', async () => {
    jobRows = [{ status: 'SKIPPED', errorMessage: 'no runner could serve chromium' }];
    resultRows = [result({ testId: 't_skipped', status: 'SKIPPED' })];
    await finalizeIfComplete('org_1', 'run_1');
    expect(written?.status).toBe('ERRORED');
  });
});
