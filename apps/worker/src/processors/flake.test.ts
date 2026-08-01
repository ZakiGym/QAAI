/**
 * Safety tests for flake confirmation and auto-quarantine.
 *
 * This module is allowed to stop a test from gating a deploy, so its dangerous
 * failure is not an exception — it is a green board over a broken build. The
 * contract, stated in flake.ts and enforced here, is that **anything short of
 * measured, intermittent, un-triaged evidence must leave the test gating.**
 *
 * Every case below is a way a plausible implementation quietly suppresses a real
 * signal: a test that fails 10 times out of 10 is not flaky, a failure someone
 * already called a real bug is not flaky, and a rate computed from three usable
 * samples is not a rate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_QUARANTINE_REASON_PREFIX,
  FLAKE_AUDIT_ACTIONS,
  FLAKE_POLICY_DEFAULTS,
  resolveFlakePolicy,
} from '@qaai/shared';
import type { FlakePolicy, TestResultStatus } from '@qaai/shared';
import type { FlakeSample } from './flake.js';

// The worker's context opens Postgres and Redis at import time, so it is
// replaced wholesale; `h.prisma` is swapped per test through the proxy below.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    enqueued: Array<{ runId: string; background: boolean }>;
  } => ({ prisma: {}, enqueued: [] }),
);

vi.mock('../context.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_target, key: string) => h.prisma[key] }),
}));

vi.mock('../queues.js', () => ({
  enqueueRun: async (job: { runId: string }, opts?: { background?: boolean }) => {
    h.enqueued.push({ runId: job.runId, background: opts?.background === true });
  },
}));

const {
  decideFlakeAction,
  describeMeasurement,
  findSuspects,
  investigationTag,
  isMachineQuarantine,
  measureSamples,
  parseInvestigationTag,
  processFlakeTick,
} = await import('./flake.js');

type Measurement = ReturnType<typeof measureSamples>;

const policy = (over: Partial<FlakePolicy> = {}): FlakePolicy => ({
  ...FLAKE_POLICY_DEFAULTS,
  ...over,
});

const measured = (failed: number, of: number, discarded = 0): Measurement => ({
  failed,
  of,
  ratePercent: of === 0 ? 0 : (failed / of) * 100,
  discarded,
});

const decide = (over: Partial<Parameters<typeof decideFlakeAction>[0]> = {}) =>
  decideFlakeAction({
    policy: policy(),
    measurement: measured(4, 10),
    quarantined: false,
    machineQuarantined: false,
    priority: 'IMPORTANT',
    realBugTriagedAt: null,
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────────

describe('a suspicion is never enough on its own', () => {
  it('takes no action when too few samples came back usable', () => {
    // Six runs errored on our own infrastructure. Blaming the test for that is
    // exactly the sin the house rules forbid.
    const d = decide({ measurement: measured(4, 4, 6) });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('4 of 10');
    expect(d.reason).toMatch(/below the 8/);
  });

  it('will not release on thin evidence either', () => {
    // Fail-open cuts both ways only for the SUPPRESSING direction; releasing on
    // two clean samples would flap the gate every afternoon.
    const d = decide({
      measurement: measured(0, 3, 7),
      quarantined: true,
      machineQuarantined: true,
    });
    expect(d.action).toBe('NONE');
  });

  it('never quarantines at exactly the threshold, only above it', () => {
    expect(decide({ measurement: measured(3, 10) }).action).toBe('NONE');
    expect(decide({ measurement: measured(4, 10) }).action).toBe('QUARANTINE');
  });
});

describe('the failures that must never be called flakes', () => {
  it('does not quarantine a test that failed every single sample', () => {
    // 100% is not a flake rate, it is a broken test — and quarantining it hides
    // a deterministic failure behind a word that means "ignore me".
    const d = decide({ measurement: measured(10, 10) });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('consistent failure');
  });

  it('releases a machine-quarantined test that has started failing every time', () => {
    // The quarantine was for a flake. What it is catching now is not one, so the
    // gate comes back.
    const d = decide({
      measurement: measured(10, 10),
      quarantined: true,
      machineQuarantined: true,
    });
    expect(d.action).toBe('RELEASE');
    expect(d.reason).toContain('gates again');
  });

  it('does not quarantine a test whose failure was triaged REAL_BUG', () => {
    const d = decide({
      measurement: measured(6, 10),
      realBugTriagedAt: new Date('2026-07-14T10:00:00Z'),
    });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('REAL_BUG');
    expect(d.reason).toContain('2026-07-14');
  });

  it('releases a machine-quarantined test once one of its failures is a REAL_BUG', () => {
    const d = decide({
      measurement: measured(6, 10),
      quarantined: true,
      machineQuarantined: true,
      realBugTriagedAt: new Date('2026-07-14T10:00:00Z'),
    });
    expect(d.action).toBe('RELEASE');
  });

  it('leaves a critical-path test gating and says so', () => {
    const d = decide({ measurement: measured(9, 10), priority: 'CRITICAL_PATH' });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('critical-path');
    // …unless the project opted out of that protection.
    expect(
      decide({
        measurement: measured(9, 10),
        priority: 'CRITICAL_PATH',
        policy: policy({ protectCriticalPath: false }),
      }).action,
    ).toBe('QUARANTINE');
  });
});

describe('what it does act on', () => {
  it('quarantines above the threshold, with the measured rate in the reason', () => {
    const d = decide({ measurement: measured(4, 10) });
    expect(d.action).toBe('QUARANTINE');
    expect(d.reason).toContain('failed 4 of 10 confirmation re-runs (40%)');
    expect(d.reason).toContain('still runs');
    // The reason is also the marker auto-release later reads back.
    expect(
      isMachineQuarantine({ quarantineReason: d.reason, lastQuarantineAuditAction: null }),
    ).toBe(true);
  });

  it('does not take ownership of a quarantine a person already applied', () => {
    // Overwriting their reason would make this ours to auto-release later, which
    // is how a machine quietly undoes a human decision.
    const d = decide({
      measurement: measured(9, 10),
      quarantined: true,
      machineQuarantined: false,
    });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('Their quarantine stands');
  });

  it('refreshes its own quarantine reason with the newer measurement', () => {
    const d = decide({ measurement: measured(9, 10), quarantined: true, machineQuarantined: true });
    expect(d.action).toBe('QUARANTINE');
    expect(d.reason).toContain('failed 9 of 10');
  });

  it('records the evidence but takes no action when auto-quarantine is off', () => {
    const d = decide({ measurement: measured(9, 10), policy: policy({ autoQuarantine: false }) });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('auto-quarantine is off');
  });

  it('releases a machine quarantine once the test stops failing', () => {
    const d = decide({ measurement: measured(0, 10), quarantined: true, machineQuarantined: true });
    expect(d.action).toBe('RELEASE');
    expect(d.reason).toContain('failed 0 of 10');
  });

  it("never releases a person's quarantine", () => {
    const d = decide({
      measurement: measured(0, 10),
      quarantined: true,
      machineQuarantined: false,
    });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('Only a person');
  });

  it('leaves the middle ground alone', () => {
    // 10% is above the release bar and below the quarantine bar: measured,
    // recorded, and deliberately not acted on.
    const d = decide({ measurement: measured(1, 10), quarantined: true, machineQuarantined: true });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('between');
  });
});

describe('measuring', () => {
  const sample = (
    status: TestResultStatus | null,
    over: Partial<FlakeSample> = {},
  ): FlakeSample => ({
    runStatus: status === null ? 'ERRORED' : status === 'PASSED' ? 'PASSED' : 'FAILED',
    status,
    retriedAndPassed: false,
    ...over,
  });

  it('counts a pass that only happened on retry as a failure', () => {
    const m = measureSamples([
      sample('PASSED', { retriedAndPassed: true }),
      sample('PASSED'),
      sample('PASSED'),
      sample('PASSED'),
    ]);
    expect(m).toMatchObject({ failed: 1, of: 4, discarded: 0 });
    expect(describeMeasurement(m)).toBe('failed 1 of 4 confirmation re-runs (25%)');
  });

  it('discards samples that measured our infrastructure rather than the test', () => {
    const m = measureSamples([
      sample('PASSED'),
      sample('FAILED'),
      { runStatus: 'ERRORED', status: null, retriedAndPassed: false },
      { runStatus: 'CANCELLED', status: null, retriedAndPassed: false },
      // No plugin supports the type, so it never executed.
      { runStatus: 'PASSED', status: 'SKIPPED' as const, retriedAndPassed: false },
    ]);
    expect(m).toMatchObject({ failed: 1, of: 2, discarded: 3, ratePercent: 50 });
  });

  it('reports 0 rather than dividing by nothing', () => {
    expect(measureSamples([]).ratePercent).toBe(0);
  });

  it('counts a timeout as a failure', () => {
    expect(measureSamples([sample('TIMED_OUT'), sample('PASSED')]).failed).toBe(1);
  });
});

describe('who owns a quarantine', () => {
  it('believes the audit log over the reason string', () => {
    // A person quarantined it last, over a stale machine reason left behind by
    // an earlier auto-quarantine that someone had already lifted by hand.
    expect(
      isMachineQuarantine({
        quarantineReason: `${AUTO_QUARANTINE_REASON_PREFIX}: it failed 4 of 10…`,
        lastQuarantineAuditAction: 'test.quarantine',
      }),
    ).toBe(false);

    expect(
      isMachineQuarantine({
        quarantineReason: 'anything at all',
        lastQuarantineAuditAction: FLAKE_AUDIT_ACTIONS.quarantined,
      }),
    ).toBe(true);
  });

  it('treats an unexplained quarantine as a human decision', () => {
    // Being wrong here leaves a flaky test quarantined. Being wrong the other
    // way silently overrides a person.
    expect(isMachineQuarantine({ quarantineReason: null, lastQuarantineAuditAction: null })).toBe(
      false,
    );
  });

  it('recognises the run finaliser‘s own auto-quarantine reason', () => {
    expect(
      isMachineQuarantine({
        quarantineReason: 'Auto-quarantined at a 30% flake rate over the last 50 runs',
        lastQuarantineAuditAction: null,
      }),
    ).toBe(true);
  });
});

describe('the policy will not be talked into acting on nothing', () => {
  it('falls back to the defaults for anything unparseable', () => {
    expect(resolveFlakePolicy(null)).toEqual(FLAKE_POLICY_DEFAULTS);
    expect(resolveFlakePolicy('{"samples":3}')).toEqual(FLAKE_POLICY_DEFAULTS);
    expect(resolveFlakePolicy([1, 2])).toEqual(FLAKE_POLICY_DEFAULTS);
    expect(resolveFlakePolicy({ samples: 'lots' }).samples).toBe(FLAKE_POLICY_DEFAULTS.samples);
    expect(resolveFlakePolicy({ minSamples: Number.NaN }).minSamples).toBe(
      FLAKE_POLICY_DEFAULTS.minSamples,
    );
  });

  it('refuses a zero-evidence policy', () => {
    expect(resolveFlakePolicy({ minSamples: 0 }).minSamples).toBe(2);
    expect(resolveFlakePolicy({ samples: 0 }).samples).toBe(3);
  });

  it('never lets the evidence bar exceed the sample count', () => {
    const p = resolveFlakePolicy({ samples: 5, minSamples: 20 });
    expect(p.minSamples).toBeLessThanOrEqual(p.samples);
  });

  it('never lets the release bar sit above the quarantine bar', () => {
    const p = resolveFlakePolicy({ quarantineRatePercent: 20, releaseRatePercent: 90 });
    expect(p.releaseRatePercent).toBeLessThanOrEqual(p.quarantineRatePercent);
  });

  it('keeps a real override', () => {
    const p = resolveFlakePolicy({ samples: 20, quarantineRatePercent: 50, autoRelease: false });
    expect(p).toMatchObject({ samples: 20, quarantineRatePercent: 50, autoRelease: false });
  });
});

describe('spotting suspects', () => {
  const row = (over: Record<string, unknown>) => ({
    testId: 't1',
    orgId: 'org',
    projectId: 'proj',
    environmentId: 'env-staging',
    status: 'PASSED',
    retriedAndPassed: false,
    fromConfirmationRun: false,
    ...over,
  });

  it('suspects a retry-pass, a FLAKY result, and a pass/fail flip', () => {
    expect(findSuspects([row({ retriedAndPassed: true })])[0]?.why).toContain('on retry');
    expect(findSuspects([row({ status: 'FLAKY' })])[0]?.why).toContain('flaky');
    expect(findSuspects([row({ status: 'PASSED' }), row({ status: 'FAILED' })])[0]?.why).toContain(
      'passed and failed',
    );
  });

  it('ignores a test that only ever passed, and one that only ever failed', () => {
    expect(findSuspects([row({ status: 'PASSED' }), row({ status: 'PASSED' })])).toEqual([]);
    expect(findSuspects([row({ status: 'FAILED' }), row({ status: 'FAILED' })])).toEqual([]);
  });

  it('never suspects a test on the strength of its own confirmation runs', () => {
    // Otherwise an investigation re-suspects the test it is currently measuring,
    // forever.
    expect(
      findSuspects([
        row({ status: 'PASSED', fromConfirmationRun: true }),
        row({ status: 'FAILED', fromConfirmationRun: true }),
      ]),
    ).toEqual([]);
  });

  it('re-runs against the environment the suspicion arose in', () => {
    // Rows arrive newest first; a flake on staging is not confirmed on prod.
    const suspects = findSuspects([
      row({ status: 'FAILED', environmentId: 'env-staging' }),
      row({ status: 'PASSED', environmentId: 'env-prod' }),
    ]);
    expect(suspects[0]?.environmentId).toBe('env-staging');
  });
});

describe('the investigation tag', () => {
  it('round-trips', () => {
    const tag = investigationTag('cltest123', 'ab12cd34');
    expect(parseInvestigationTag(tag)).toEqual({
      testId: 'cltest123',
      investigationId: 'ab12cd34',
    });
  });

  it('rejects anything else', () => {
    expect(parseInvestigationTag(null)).toBeNull();
    expect(parseInvestigationTag('alice@example.com')).toBeNull();
    expect(parseInvestigationTag('flake-radar:')).toBeNull();
    expect(parseInvestigationTag('flake-radar:onlyatest')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep, against a fake database. Enough of Prisma to prove the wiring:
// what it writes, what it refuses to write, and that it writes both halves of a
// decision together.
// ─────────────────────────────────────────────────────────────────────────────

interface AuditRow {
  orgId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface FakeRun {
  id: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  status: string;
  triggeredBy: string | null;
  queuedAt: Date;
  results: Array<{ testId: string; status: string; retriedAndPassed: boolean }>;
}

function fakePrisma(scenario: {
  flakeRuns?: FakeRun[];
  tests?: Record<string, Record<string, unknown>>;
  audits?: AuditRow[];
  suspectRows?: unknown[];
  quarantinedTests?: Array<{ id: string; orgId: string; projectId: string }>;
  queuedRuns?: number;
  /** Queued runs to filter for real, so the yield check is tested semantically. */
  queuedRunTriggers?: Array<string | null>;
  realBugAt?: Date | null;
}) {
  const audits = scenario.audits ?? [];
  const calls = {
    audits,
    created: [] as Array<{ testId: string; triggeredBy: string }>,
    updated: [] as Array<{ testId: string; data: Record<string, unknown> }>,
    transactions: [] as number[],
    cancelled: [] as unknown[],
  };

  const matchesAudit = (row: AuditRow, where: Record<string, unknown>): boolean => {
    if (where.targetId && row.targetId !== where.targetId) return false;
    if (where.orgId && row.orgId !== where.orgId) return false;
    const action = where.action as { in?: string[] } | undefined;
    if (action?.in && !action.in.includes(row.action)) return false;
    const createdAt = where.createdAt as { gte?: Date } | undefined;
    if (createdAt?.gte && row.createdAt < createdAt.gte) return false;
    return true;
  };

  /**
   * Prisma's `not: { startsWith }` resolves to NULL for a null column, so the
   * row is DROPPED rather than matched — reproduced faithfully here, because the
   * rows with no trigger are the scheduled runs the sweep is supposed to yield
   * to. A query that forgets the null arm counts zero and never yields.
   */
  const matchesTrigger = (trigger: string | null, where: Record<string, unknown>): boolean => {
    const arms = (where.OR as Array<Record<string, unknown>> | undefined) ?? [where];
    return arms.some((arm) => {
      const filter = arm.triggeredBy as
        null | undefined | { not?: { startsWith?: string }; startsWith?: string };
      if (filter === null) return trigger === null;
      if (filter === undefined) return true;
      if (filter.not?.startsWith !== undefined) {
        if (trigger === null) return false;
        return !trigger.startsWith(filter.not.startsWith);
      }
      if (filter.startsWith !== undefined) return trigger?.startsWith(filter.startsWith) === true;
      return true;
    });
  };

  const prisma = {
    run: {
      findMany: async () => scenario.flakeRuns ?? [],
      count: async ({ where }: { where: Record<string, unknown> }) =>
        scenario.queuedRunTriggers
          ? scenario.queuedRunTriggers.filter((trigger) => matchesTrigger(trigger, where)).length
          : (scenario.queuedRuns ?? 0),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = data.results as { create: Array<{ testId: string }> };
        calls.created.push({
          testId: created.create[0]!.testId,
          triggeredBy: String(data.triggeredBy),
        });
        return { id: `run-${calls.created.length}` };
      },
      update: async () => ({}),
      updateMany: async (args: unknown) => {
        calls.cancelled.push(args);
        return { count: 1 };
      },
    },
    test: {
      findFirst: async ({ where }: { where: { id: string } }) => scenario.tests?.[where.id] ?? null,
      findMany: async () => scenario.quarantinedTests ?? [],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.updated.push({ testId: where.id, data });
        return {};
      },
    },
    testResult: {
      findMany: async () => scenario.suspectRows ?? [],
      findFirst: async () => ({ run: { environmentId: 'env-1' } }),
    },
    triageVerdict: {
      findFirst: async () => (scenario.realBugAt ? { createdAt: scenario.realBugAt } : null),
    },
    auditLog: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: Record<string, unknown>;
        orderBy?: unknown;
      }) => {
        const found = audits.filter((row) => matchesAudit(row, where));
        if (orderBy) found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return found[0] ?? null;
      },
      create: async ({ data }: { data: Omit<AuditRow, 'createdAt'> }) => {
        const row = { ...data, createdAt: new Date() };
        audits.push(row);
        return row;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => {
      calls.transactions.push(ops.length);
      return Promise.all(ops);
    },
    $queryRaw: async () => [],
  };

  return { prisma, calls };
}

const testRow = (over: Record<string, unknown> = {}) => ({
  id: 'test-1',
  name: 'Checkout completes',
  priority: 'IMPORTANT',
  quarantined: false,
  quarantineReason: null,
  disabledAt: null,
  filePath: 'specs/checkout.spec.ts',
  ...over,
});

const confirmationRun = (index: number, status: string, resultStatus: string): FakeRun => ({
  id: `run-${index}`,
  orgId: 'org-1',
  projectId: 'proj-1',
  environmentId: 'env-1',
  status,
  triggeredBy: investigationTag('test-1', 'inv12345'),
  queuedAt: new Date(Date.now() - (20 - index) * 60_000),
  results: [{ testId: 'test-1', status: resultStatus, retriedAndPassed: false }],
});

const tenSamples = (failures: number): FakeRun[] =>
  Array.from({ length: 10 }, (_, i) =>
    i < failures ? confirmationRun(i, 'FAILED', 'FAILED') : confirmationRun(i, 'PASSED', 'PASSED'),
  );

describe('the sweep', () => {
  beforeEach(() => {
    h.enqueued = [];
    delete process.env.QAAI_FLAKE_AUTOMATION;
  });

  it('quarantines and audits in one transaction once the samples are in', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.transactions).toEqual([2]);
    expect(calls.updated[0]?.data).toMatchObject({ quarantined: true });
    expect(String(calls.updated[0]?.data.quarantineReason)).toContain('failed 4 of 10');
    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(FLAKE_AUDIT_ACTIONS.quarantined);
    expect(audit.metadata).toMatchObject({
      investigationId: 'inv12345',
      measured: { failed: 4, of: 10, ratePercent: 40, discarded: 0 },
    });
    // The evidence is inspectable: every run that produced the number.
    expect((audit.metadata.runIds as string[]).length).toBe(10);
  });

  it('records the measurement but touches nothing when triage called it a real bug', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(5),
      tests: { 'test-1': testRow() },
      realBugAt: new Date('2026-07-20T00:00:00Z'),
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.updated).toEqual([]);
    expect(calls.audits.at(-1)?.action).toBe(FLAKE_AUDIT_ACTIONS.measured);
  });

  it('queues the next sample one at a time, in the background', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [confirmationRun(0, 'PASSED', 'PASSED'), confirmationRun(1, 'FAILED', 'FAILED')],
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({ testId: 'test-1' });
    expect(h.enqueued).toEqual([{ runId: 'run-1', background: true }]);
    // Nothing decided while the measurement is still being taken.
    expect(calls.updated).toEqual([]);
    expect(calls.audits).toEqual([]);
  });

  it('yields the queue to real runs', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [confirmationRun(0, 'PASSED', 'PASSED')],
      tests: { 'test-1': testRow() },
      queuedRuns: 9,
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('yields to queued runs that carry no trigger at all', async () => {
    // Schedules and monitors leave `triggeredBy` null, and they are exactly the
    // work worth yielding to. A filter that only excludes our own runs drops
    // them and reports an idle project.
    const { prisma, calls } = fakePrisma({
      flakeRuns: [confirmationRun(0, 'PASSED', 'PASSED')],
      tests: { 'test-1': testRow() },
      queuedRunTriggers: [null, null, null],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
  });

  it('abandons the investigation when a person cancels one of its runs', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [
        confirmationRun(0, 'PASSED', 'PASSED'),
        confirmationRun(1, 'CANCELLED', 'SKIPPED'),
      ],
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.updated).toEqual([]);
    expect(calls.created).toEqual([]);
    expect(calls.audits.at(-1)?.action).toBe(FLAKE_AUDIT_ACTIONS.abandoned);
  });

  it('opens an investigation for a fresh suspect and stops at one run', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [],
      tests: { 'test-1': testRow() },
      suspectRows: [
        {
          testId: 'test-1',
          orgId: 'org-1',
          status: 'PASSED',
          retriedAndPassed: true,
          run: { projectId: 'proj-1', environmentId: 'env-staging', triggeredBy: null },
        },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]!.triggeredBy).toMatch(/^flake-radar:test-1:/);
    expect(h.enqueued).toEqual([{ runId: 'run-1', background: true }]);
  });

  it('leaves a suspect alone inside its cooldown', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [],
      tests: { 'test-1': testRow() },
      audits: [
        {
          orgId: 'org-1',
          action: FLAKE_AUDIT_ACTIONS.measured,
          targetType: 'Test',
          targetId: 'test-1',
          metadata: {},
          createdAt: new Date(Date.now() - 60 * 60_000),
        },
      ],
      suspectRows: [
        {
          testId: 'test-1',
          orgId: 'org-1',
          status: 'FLAKY',
          retriedAndPassed: false,
          run: { projectId: 'proj-1', environmentId: 'env-1', triggeredBy: null },
        },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
  });

  it('never investigates a fixture', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [],
      tests: { 'test-1': testRow({ filePath: 'fixtures/users.json' }) },
      suspectRows: [
        {
          testId: 'test-1',
          orgId: 'org-1',
          status: 'FLAKY',
          retriedAndPassed: false,
          run: { projectId: 'proj-1', environmentId: 'env-1', triggeredBy: null },
        },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
  });

  it('does nothing at all when the kill switch is set', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(9),
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;
    process.env.QAAI_FLAKE_AUTOMATION = 'off';

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.updated).toEqual([]);
    expect(calls.audits).toEqual([]);
    expect(calls.created).toEqual([]);
  });

  it('releases a machine-quarantined test that came back clean', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(0),
      tests: {
        'test-1': testRow({
          quarantined: true,
          quarantineReason: `${AUTO_QUARANTINE_REASON_PREFIX}: it failed 4 of 10 confirmation re-runs (40%)`,
        }),
      },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.transactions).toEqual([2]);
    expect(calls.updated[0]?.data).toMatchObject({
      quarantined: false,
      quarantinedAt: null,
      quarantineReason: null,
    });
    expect(calls.audits.at(-1)?.action).toBe(FLAKE_AUDIT_ACTIONS.released);
  });

  it("will not measure a person's quarantine, because it would never lift it", async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: [],
      tests: { 'test-1': testRow({ quarantined: true, quarantineReason: 'Flaky on CI — Dana' }) },
      quarantinedTests: [{ id: 'test-1', orgId: 'org-1', projectId: 'proj-1' }],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
  });
});
