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
  FIXTURE_PREFIX,
  FLAKE_AUDIT_ACTIONS,
  FLAKE_POLICY_DEFAULTS,
  PLAN_LIMITS,
  resolveFlakePolicy,
} from '@qaai/shared';
import type { FlakePolicy, TestResultStatus } from '@qaai/shared';
import { verificationRunTag } from '@qaai/agent';
/*
 * The production expression under test. `processVerifyHeal(healVerificationPorts(), job)`
 * is verbatim the body of the `VERIFY_HEAL_QUEUE` registration in
 * apps/worker/src/index.ts, so the chain tests at the bottom of this file
 * exercise the registration's own code rather than a re-derivation of it.
 */
import { processVerifyHeal } from './verify-heal.js';
import type { FlakeSample } from './flake.js';

// The worker's context opens Postgres and Redis at import time, so it is
// replaced wholesale; `h.prisma` is swapped per test through the proxy below.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    enqueued: Array<{ runId: string; background: boolean }>;
    /** Every `enqueueVerifyHeal` the hole sweep made, in order. */
    verifyHealJobs: Array<{ orgId: string; healId: string; reason: string }>;
    /** Heal ids whose enqueue throws, for the one-bad-row arm. */
    verifyHealThrows: Set<string>;
  } => ({ prisma: {}, enqueued: [], verifyHealJobs: [], verifyHealThrows: new Set() }),
);

beforeEach(() => {
  h.verifyHealJobs.length = 0;
  h.verifyHealThrows.clear();
});

vi.mock('../context.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_target, key: string) => h.prisma[key] }),
}));

vi.mock('../queues.js', () => ({
  enqueueRun: async (job: { runId: string }, opts?: { background?: boolean }) => {
    h.enqueued.push({ runId: job.runId, background: opts?.background === true });
  },
  /*
   * The hole sweep's producer. Recorded rather than ignored, because the thing
   * under test is WHICH heals it asks for — a sweep that enqueued the wrong set
   * (or the right set twice) would look identical with a no-op stand-in.
   *
   * `verifyHealThrows` is the Redis-blip arm: one org's failed enqueue must not
   * stop the sweep for every other org.
   */
  enqueueVerifyHeal: async (job: { orgId: string; healId: string; reason: string }) => {
    if (h.verifyHealThrows.has(job.healId)) throw new Error('redis is down');
    h.verifyHealJobs.push(job);
  },
}));

const {
  decideFlakeAction,
  deflakeSweep,
  describeMeasurement,
  driftSweep,
  findSuspects,
  investigationTag,
  isMachineQuarantine,
  measureSamples,
  parseInvestigationTag,
  processFlakeTick,
  pruneFlakeHistory,
  verifyAppliedHeals,
  healVerificationPorts,
  startVerificationHoles,
  HEAL_AUDIT_ACTIONS,
  HEAL_VERIFY_DEADLINE_MINUTES,
  HEAL_VERIFY_START_LOOKBACK_DAYS,
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
  quarantinedTests?: Array<{
    id: string;
    orgId: string;
    projectId: string;
    quarantineExpiresAt?: Date | null;
  }>;
  /**
   * Live tests in the project — the denominator the quarantine budget divides
   * by. Defaults to a suite big enough that the default 5% cap leaves room, so
   * every pre-existing test in this file keeps the behaviour it asserted.
   */
  projectTestCount?: number;
  /** The project's own cap. Null means the documented default. */
  quarantineBudgetPercent?: number | null;
  /** Flake-trend rows, for the retention prune. */
  flakeHistory?: Array<{ id: string; day: Date }>;
  queuedRuns?: number;
  /** Queued runs to filter for real, so the yield check is tested semantically. */
  queuedRunTriggers?: Array<string | null>;
  realBugAt?: Date | null;
  /**
   * The org's plan and its month-to-date run count, which a confirmation run
   * now costs one of. A flake sweep creates real Runs, and until it went
   * through the shared toll (apps/api/src/lib/start-run.ts) it created them
   * without asking the plan or moving the counter.
   */
  plan?: string;
  runsThisMonth?: number;
}) {
  const audits = scenario.audits ?? [];
  const calls = {
    audits,
    /** Every `runs` UsageRecord increment, so metering can be asserted. */
    metered: [] as Array<{ orgId: string; metric: string }>,
    created: [] as Array<{ testId: string; triggeredBy: string }>,
    updated: [] as Array<{ testId: string; data: Record<string, unknown> }>,
    transactions: [] as number[],
    cancelled: [] as unknown[],
    /** Flake-history ids the retention prune deleted. */
    pruned: [] as string[],
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
      /*
       * The budget's denominator. Modelled rather than left off: a stand-in
       * that threw here would make `quarantineBudgetFor` fall into its catch
       * and decide with NO budget, which is exactly the state in which the
       * refusal is unobservable — the shape of hole the original defect lived
       * in.
       */
      count: async ({ where }: { where?: Record<string, any> } = {}) => {
        // The denominator, or the suppressions in force — two queries, one
        // model. The in-force count excludes an EXPIRED quarantine and the test
        // under investigation, both in SQL, so the fake applies both here.
        if (where?.quarantined !== true) return scenario.projectTestCount ?? 1_000;
        const now = Date.now();
        const excluded = where.id?.not as string | undefined;
        return (scenario.quarantinedTests ?? []).filter((t) => {
          if (excluded && t.id === excluded) return false;
          const expires = t.quarantineExpiresAt;
          return expires === null || expires === undefined || expires.getTime() > now;
        }).length;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.updated.push({ testId: where.id, data });
        return {};
      },
    },
    project: {
      findFirst: async () => ({
        quarantineBudgetPercent: scenario.quarantineBudgetPercent ?? null,
      }),
    },
    testFlakeHistory: {
      findMany: async ({ where, take }: { where: Record<string, any>; take?: number }) => {
        const before = where.day?.lt as Date | undefined;
        return (scenario.flakeHistory ?? [])
          .filter((row) => !before || row.day < before)
          .sort((a, b) => a.day.getTime() - b.day.getTime())
          .slice(0, take ?? undefined)
          .map((row) => ({ id: row.id }));
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        calls.pruned.push(...where.id.in);
        scenario.flakeHistory = (scenario.flakeHistory ?? []).filter((row) => !ids.has(row.id));
        return { count: ids.size };
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
    /*
     * Billing, as the run toll reads it: which plan the org is on, and how many
     * runs it has already spent this month. Modelled rather than left off the
     * stand-in, because a confirmation run is a run — it costs a browser and it
     * belongs on the bill.
     */
    subscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ plan: scenario.plan ?? 'ENTERPRISE' }) },
    usageRecord: {
      findUnique: async () => ({ quantity: BigInt(scenario.runsThisMonth ?? 0) }),
      upsert: async ({ where }: { where: Record<string, any> }) => {
        calls.metered.push({
          orgId: where.orgId_metric_period.orgId,
          metric: where.orgId_metric_period.metric,
        });
        return {};
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
  /** Null means "never expires", which every pre-expiry quarantine is. */
  quarantineExpiresAt: null,
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
    // And it is billed for. A confirmation run is a real browser against the
    // customer's app; five of the seven paths that create Runs — this one
    // included — used to make them without the counter ever moving, which is
    // what made `usage.runsThisMonth` on the billing screen wrong.
    expect(calls.metered).toEqual([{ orgId: 'org-1', metric: 'runs' }]);
    // Nothing decided while the measurement is still being taken.
    expect(calls.updated).toEqual([]);
    expect(calls.audits).toEqual([]);
  });

  it('ends an investigation it cannot finish rather than creating runs over the cap', async () => {
    /*
     * The org has spent its month. The sweep must not throw — one org's plan
     * limit cannot be allowed to fail the tick for every other org sharing it —
     * and it must not leave the investigation open either: waiting would end in
     * an abandonment whose stated reason was the deadline rather than the truth.
     */
    const { prisma, calls } = fakePrisma({
      flakeRuns: [confirmationRun(0, 'PASSED', 'PASSED'), confirmationRun(1, 'FAILED', 'FAILED')],
      tests: { 'test-1': testRow() },
      plan: 'FREE',
      runsThisMonth: PLAN_LIMITS.FREE.maxRunsPerMonth!,
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.created).toEqual([]);
    expect(h.enqueued).toEqual([]);
    // Refusing costs nothing: no row written, so nothing to count.
    expect(calls.metered).toEqual([]);

    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(FLAKE_AUDIT_ACTIONS.abandoned);
    expect(String(audit.metadata.reason)).toContain('runs included with Free');
    // Nothing was suppressed on the strength of a measurement never taken.
    expect(calls.updated).toEqual([]);
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

// ─────────────────────────────────────────────────────────────────────────────
// The budget: an escape hatch that always opens is not a safety feature.
//
// Quarantine was unbounded. Nothing refused the 40th quarantine and nobody was
// paged, so a quarter of a suite could stop gating while the board stayed
// green. The budget is checked LAST, after every other reason to leave a test
// gating, because it is the only one that is about the SUITE rather than about
// this test.
// ─────────────────────────────────────────────────────────────────────────────

describe('the quarantine budget, as a decision', () => {
  const overBudget = {
    allowed: false,
    current: 5,
    limit: 5,
    percent: 5,
    wouldBePercent: 6,
    nearLimit: true,
    reason: 'Refused: 5 of 100 test(s) are already quarantined. Fix one or delete it.',
  };

  it('REFUSES a quarantine the suite has no budget for', () => {
    const d = decide({ measurement: measured(4, 10), budget: overBudget });
    expect(d.action).toBe('NONE');
  });

  it('says why, with the budget reason carried verbatim', () => {
    const d = decide({ measurement: measured(4, 10), budget: overBudget });
    expect(d.reason).toContain('at its quarantine budget');
    expect(d.reason).toContain('Fix one or delete it');
    expect(d.reason).toContain('It keeps gating');
  });

  it('still reports the measurement, so the evidence is not lost with the refusal', () => {
    const d = decide({ measurement: measured(4, 10), budget: overBudget });
    expect(d.reason).toContain('failed 4 of 10');
  });

  it('quarantines when the suite has room', () => {
    const d = decide({
      measurement: measured(4, 10),
      budget: { ...overBudget, allowed: true, current: 1, reason: 'Allowed: 2 of a cap of 5.' },
    });
    expect(d.action).toBe('QUARANTINE');
  });

  it('decides on the measurement alone when the budget could not be read', () => {
    // Every other uncertainty in this module resolves towards "leave it
    // gating" because it is about the TEST. This one is about a count, and
    // refusing a measured quarantine because a count() failed would be refusing
    // on no information at all.
    const d = decide({ measurement: measured(4, 10) });
    expect(d.action).toBe('QUARANTINE');
  });

  it('is checked after every other reason to leave a test gating', () => {
    // A critical-path test over the threshold is refused for being
    // critical-path, not for the budget — the more specific reason is the one a
    // human needs.
    const d = decide({
      measurement: measured(4, 10),
      priority: 'CRITICAL_PATH',
      budget: overBudget,
    });
    expect(d.action).toBe('NONE');
    expect(d.reason).toContain('critical-path');
    expect(d.reason).not.toContain('quarantine budget');
  });

  it('cannot refuse a RELEASE — restoring a gate is always allowed', () => {
    const d = decide({
      measurement: measured(0, 10),
      quarantined: true,
      machineQuarantined: true,
      budget: overBudget,
    });
    expect(d.action).toBe('RELEASE');
  });
});

describe('expiry: a quarantine with no end date is a deletion nobody signed', () => {
  it('stamps an expiry when it quarantines', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    const write = calls.updated.find((u) => u.data.quarantined === true);
    expect(write!.data.quarantineExpiresAt).toBeInstanceOf(Date);
    expect((write!.data.quarantineExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('says in the reason that it will run out', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    const write = calls.updated.find((u) => u.data.quarantined === true)!;
    expect(String(write.data.quarantineReason)).toContain('14 days');
    expect(String(write.data.quarantineReason)).toContain('expires');
  });

  it('renews the expiry on a test it re-confirms, so quarantine is a loan on evidence', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: {
        'test-1': testRow({
          quarantined: true,
          quarantineReason: `${AUTO_QUARANTINE_REASON_PREFIX}: an earlier measurement`,
          quarantinedAt: new Date(Date.now() - 20 * 86_400_000),
          quarantineExpiresAt: new Date(Date.now() - 6 * 86_400_000),
        }),
      },
      audits: [
        {
          orgId: 'org-1',
          action: FLAKE_AUDIT_ACTIONS.quarantined,
          targetType: 'Test',
          targetId: 'test-1',
          metadata: {},
          createdAt: new Date(Date.now() - 20 * 86_400_000),
        },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    const write = calls.updated.find((u) => u.data.quarantined === true)!;
    expect((write.data.quarantineExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    // The ORIGINAL date is preserved — the audit row records when the
    // measurement landed, not the row.
    expect(write.data.quarantinedAt).toBeUndefined();
  });

  it('clears the expiry with the quarantine on release', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(0),
      tests: {
        'test-1': testRow({
          quarantined: true,
          quarantineReason: `${AUTO_QUARANTINE_REASON_PREFIX}: an earlier measurement`,
          quarantineExpiresAt: new Date(Date.now() + 86_400_000),
        }),
      },
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    const write = calls.updated.find((u) => u.data.quarantined === false)!;
    // A stale end date on a test that is not quarantined is how the next reader
    // gets the story wrong.
    expect(write.data).toMatchObject({
      quarantined: false,
      quarantinedAt: null,
      quarantineReason: null,
      quarantineExpiresAt: null,
    });
  });
});

describe('the budget, end to end through the sweep', () => {
  it('refuses the quarantine and audits the refusal as a measurement', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
      // Ten live tests, three already suppressed: over a default cap of 5%
      // (floor 2).
      projectTestCount: 10,
      quarantinedTests: [
        { id: 'q1', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
        { id: 'q2', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
        { id: 'q3', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    // Nothing was suppressed.
    expect(calls.updated.filter((u) => u.data.quarantined === true)).toEqual([]);
    // And the decision is on the record. `measured` is the existing vocabulary
    // for "a decision to do nothing", and it does not change who owns a
    // quarantine the way a `quarantined` row would.
    const audit = calls.audits.find((a) => a.action === FLAKE_AUDIT_ACTIONS.measured);
    expect(String((audit!.metadata as { reason: string }).reason)).toContain('quarantine budget');
  });

  it('quarantines the same test once the project raises its cap on purpose', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
      projectTestCount: 10,
      quarantineBudgetPercent: 60,
      quarantinedTests: [
        { id: 'q1', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
        { id: 'q2', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
        { id: 'q3', orgId: 'org-1', projectId: 'proj-1', quarantineExpiresAt: null },
      ],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.updated.some((u) => u.data.quarantined === true)).toBe(true);
  });

  it('does not charge the budget for a quarantine that has EXPIRED', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
      projectTestCount: 10,
      // Three quarantines, all run out. They are not suppressing anything any
      // more, so charging the project for them would make the budget tighten on
      // its own over time.
      quarantinedTests: ['q1', 'q2', 'q3'].map((id) => ({
        id,
        orgId: 'org-1',
        projectId: 'proj-1',
        quarantineExpiresAt: new Date(Date.now() - 86_400_000),
      })),
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.updated.some((u) => u.data.quarantined === true)).toBe(true);
  });
});

describe('flake-history retention', () => {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('deletes points past the window and keeps the rest', async () => {
    const { prisma, calls } = fakePrisma({
      flakeHistory: [
        { id: 'old-1', day: day(200) },
        { id: 'old-2', day: day(120) },
        { id: 'keep-1', day: day(30) },
        { id: 'keep-2', day: day(1) },
      ],
    });
    h.prisma = prisma;

    const deleted = await pruneFlakeHistory(new Date());

    expect(deleted).toBe(2);
    expect(calls.pruned.sort()).toEqual(['old-1', 'old-2']);
  });

  it('does nothing when there is nothing past the window', async () => {
    const { prisma, calls } = fakePrisma({ flakeHistory: [{ id: 'keep', day: day(1) }] });
    h.prisma = prisma;

    expect(await pruneFlakeHistory(new Date())).toBe(0);
    expect(calls.pruned).toEqual([]);
  });

  it('runs on the tick, and a failure there does not stop the sweep', async () => {
    const { prisma, calls } = fakePrisma({
      flakeRuns: tenSamples(4),
      tests: { 'test-1': testRow() },
    });
    (prisma.testFlakeHistory as unknown as { findMany: () => Promise<unknown> }).findMany =
      async () => {
        throw new Error('table missing');
      };
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    // The quarantine decision still landed: a sweep that stopped measuring
    // flakes in order to tidy up a table would be trading the product for the
    // housekeeping.
    expect(calls.updated.some((u) => u.data.quarantined === true)).toBe(true);
  });
});

describe('a run QAAI started itself never makes its own test a suspect', () => {
  /*
   * Through the sweep, not through `findSuspects` directly — the question is
   * whether the QUERY MAPPING marks these rows, and a test that computed
   * `fromConfirmationRun` itself would pass however that mapping was written.
   * (It did, until this was rewritten: the mutation that dropped the
   * verification arm from the mapping left every assertion green.)
   */
  const scenarioFor = (triggeredBy: string | null) => ({
    tests: { 'test-1': testRow() },
    suspectRows: [
      {
        testId: 'test-1',
        orgId: 'org-1',
        status: 'PASSED',
        retriedAndPassed: true,
        run: { projectId: 'proj-1', environmentId: 'env-1', triggeredBy },
      },
    ],
  });

  it('opens an investigation from a run of the customer\u2019s own suite', async () => {
    const { prisma, calls } = fakePrisma(scenarioFor('user_42'));
    h.prisma = prisma;
    await processFlakeTick({ at: new Date().toISOString() });
    expect(calls.created).toHaveLength(1);
  });

  it('ignores a flake investigation\u2019s own confirmation runs', async () => {
    const { prisma, calls } = fakePrisma(scenarioFor(investigationTag('test-1', 'inv98765')));
    h.prisma = prisma;
    await processFlakeTick({ at: new Date().toISOString() });
    expect(calls.created).toEqual([]);
  });

  it('ignores a heal verification run', async () => {
    /*
     * THE HOLE: a verification runs ONE test, on purpose, right after that
     * test's code changed. A verification that fails is exactly the "it passed
     * and failed across recent runs" pattern the suspect scan reads as
     * instability — so every applied heal that did not work would open a flake
     * investigation about a test we already know is broken, and spend ten more
     * runs confirming it.
     */
    const { prisma, calls } = fakePrisma(scenarioFor(verificationRunTag('heal-1')));
    h.prisma = prisma;
    await processFlakeTick({ at: new Date().toISOString() });
    expect(calls.created).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three sweeps that turn a flake into a fix: heal verification, deflake
// proposals, and the drift check.
//
// A separate stand-in from the one above, deliberately. These sweeps read
// different tables, and widening the investigation fake until it served both
// would have made every existing case above depend on rows it does not care
// about — which is how a fake starts passing tests for the wrong reason.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape of a Prisma argument object in these stand-ins. */
type Row = Record<string, any>;

const HEAL_CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout completes', async ({ page }) => {",
  "  await page.goto('/checkout');",
  '  await page.waitForTimeout(500);',
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  "  await expect(page.getByTestId('receipt')).toBeVisible();",
  '});',
  '',
].join('\n');

/** A diff that applies to HEAL_CODE. */
const HEAL_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -7,1 +7,1 @@',
  "-  await expect(page.getByTestId('receipt')).toBeVisible();",
  "+  await expect(page.getByTestId('order-receipt')).toBeVisible();",
].join('\n');

/**
 * Project a row the way `select` does, so DROPPING A FIELD FROM A QUERY IS
 * VISIBLE.
 *
 * A select-blind fake hands back every column whatever the query asked for, so
 * deleting a `select` entry cannot fail a test — and one of those entries
 * (`acceptance`, on the drift query) killed every retirement proposal in
 * production while this file stayed green. `true` keys are copied; a nested
 * `{ select }` recurses, which is how `test: { select: { projectId: true } }`
 * on the heal read is honoured.
 */
function project(row: Row | null, select: Row | undefined): Row | null {
  if (row === null) return null;
  if (!select) return row;
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) {
    if (want === true) out[key] = row[key];
    else if (want && typeof want === 'object' && 'select' in want) {
      out[key] = project(row[key] ?? null, (want as Row).select as Row | undefined);
    }
  }
  return out;
}

interface HealScenario {
  pendingHeals?: Row[];
  /**
   * Applied heals with `verifyState: null` — the rows `verifyAppliedHeals` is
   * structurally unable to see. Answered by the `verifyState: null` branch of
   * `healProposal.findMany` below.
   */
  holeHeals?: Row[];
  /** Keyed by heal id, for the `loadHeal` port. Carries `test.projectId`. */
  healsById?: Record<string, Row>;
  /** The environment the test last ran in, for the `lastEnvironmentFor` port. */
  lastEnvironmentId?: string | null;
  /** The three reads `startRun`'s plan toll makes. */
  subscription?: Row | null;
  organization?: Row | null;
  usage?: Row | null;
  /** Keyed by run id. */
  runs?: Record<string, { status: string; results: Row[] }>;
  versions?: Array<{ version: number; code: string }>;
  flakeVerdicts?: Row[];
  tests?: Record<string, Row>;
  /** Open proposals `openHealsFor` returns. */
  openHeals?: Row[];
  audits?: AuditRow[];
  crawls?: Row[];
  projectTests?: Row[];
  coverageItems?: Array<{ key: string; origin: string; retiredAt: Date | null }>;
}

function fakeHealPrisma(scenario: HealScenario) {
  const audits = scenario.audits ?? [];
  const calls = {
    audits,
    healCreates: [] as Row[],
    healUpdates: [] as Row[],
    healUpdateMany: [] as Row[],
    testUpdates: [] as Row[],
    runsCancelled: [] as Row[],
    transactions: [] as number[],
    /** The arguments the route-item read was made with. See the ORDER BY test. */
    coverageQueries: [] as Row[],
    /** The arguments the hole query was made with. See the cap test. */
    holeQueries: [] as Row[],
    /** Run rows the verification port asked `startRun` to create. */
    runCreates: [] as Row[],
    /** The usage counter the toll incremented. A run nobody metered is a lie. */
    usageUpserts: [] as Row[],
  };

  const prisma = {
    healProposal: {
      /*
       * HONOURS `select`, `take` AND `orderBy` on the hole branch, because the
       * hole sweep uses all three and its CAP is a disclosed fact: a fake that
       * ignored `take` could not show the cap biting, and `capped` is computed
       * from `take + 1` rows coming back.
       */
      findMany: async (args: Row) => {
        if (args.where && 'verifyState' in args.where && args.where.verifyState === null) {
          calls.holeQueries.push(args);
          const since = args.where?.decidedAt?.gte as Date | undefined;
          let rows = (scenario.holeHeals ?? []).filter(
            (row) => since === undefined || row.decidedAt === null || row.decidedAt >= since,
          );
          if (args.orderBy?.decidedAt === 'asc') {
            rows = [...rows].sort(
              (a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0),
            );
          }
          if (typeof args.take === 'number') rows = rows.slice(0, args.take);
          return rows.map((row) => project(row, args.select as Row | undefined));
        }
        return args.where?.verifyState === 'PENDING'
          ? (scenario.pendingHeals ?? [])
          : (scenario.openHeals ?? []);
      },
      /** The `loadHeal` port's read. Honours `select`, including the nested test. */
      findFirst: async (args: Row) => {
        const row = scenario.healsById?.[args.where?.id] ?? null;
        if (row === null) return null;
        if (args.where?.orgId !== undefined && row.orgId !== args.where.orgId) return null;
        return project(row, args.select as Row | undefined);
      },
      create: async (args: Row) => {
        calls.healCreates.push(args.data);
        return args.data;
      },
      update: async (args: Row) => {
        calls.healUpdates.push(args);
        return {};
      },
      updateMany: async (args: Row) => {
        calls.healUpdateMany.push(args);
        return { count: (args.where?.id?.in ?? []).length };
      },
    },
    testVersion: {
      findFirst: async (args: Row) => {
        const all = scenario.versions ?? [];
        if (args.where?.version !== undefined) {
          return all.find((v) => v.version === args.where.version) ?? null;
        }
        return [...all].sort((a, b) => b.version - a.version)[0] ?? null;
      },
    },
    test: {
      findFirst: async (args: Row) => scenario.tests?.[args.where.id] ?? null,
      // `take` honoured here too, so the test-scan cap can be seen to bite.
      findMany: async (args: Row = {}) => {
        const all = scenario.projectTests ?? [];
        return typeof args.take === 'number' ? all.slice(0, args.take) : all;
      },
      update: async (args: Row) => {
        calls.testUpdates.push(args);
        return {};
      },
    },
    run: {
      findMany: async () => [],
      create: async (args: Row) => {
        calls.runCreates.push(args.data);
        return { id: 'run-new-1', ...args.data };
      },
      findFirst: async (args: Row) => {
        const run = scenario.runs?.[args.where.id];
        return run ? { id: args.where.id, ...run } : null;
      },
      updateMany: async (args: Row) => {
        calls.runsCancelled.push(args);
        return { count: 1 };
      },
    },
    triageVerdict: { findMany: async () => scenario.flakeVerdicts ?? [] },
    /*
     * ── WHAT `startRun` NEEDS, AND WHY IT IS FAKED RATHER THAN BYPASSED ─────
     *
     * A verification run is a Run, so it goes through the ONE toll every path
     * that creates a Run goes through: the plan gate and the usage counter. A
     * port that inserted a row behind the plan's back would be a run the
     * billing screen under-reports for ever, so the fake answers the toll's own
     * three reads instead of the port skipping it.
     *
     * `runQuota` reads the subscription, the org plan and this period's usage;
     * `unscope` defaults to calling through, so these are plain delegates.
     */
    subscription: { findUnique: async () => scenario.subscription ?? null },
    organization: { findUnique: async () => scenario.organization ?? { plan: 'TEAM' } },
    usageRecord: {
      findUnique: async () => scenario.usage ?? null,
      upsert: async (args: Row) => {
        calls.usageUpserts.push(args);
        return {};
      },
    },
    /*
     * The investigation half of the tick, answered with nothing. Present so the
     * one test that goes through `processFlakeTick` reaches the sweeps below
     * rather than dying on a missing stand-in — and absent from the per-sweep
     * tests, which call their sweep directly.
     */
    testResult: {
      findMany: async () => [],
      /*
       * The `lastEnvironmentFor` port. `in` and not `??` on the scenario key:
       * an explicit `lastEnvironmentId: null` is the "this test has never run"
       * case, and `null ?? 'env-1'` would quietly hand it an environment.
       */
      findFirst: async (args: Row = {}) =>
        'lastEnvironmentId' in scenario
          ? scenario.lastEnvironmentId === null
            ? null
            : project(
                { run: { environmentId: scenario.lastEnvironmentId } },
                args.select as Row | undefined,
              )
          : null,
    },
    testFlakeHistory: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    /*
     * HONOURS `select`, because a select-blind fake made deleting a field from
     * the drift query UNDETECTABLE — and one of those fields is `acceptance`,
     * whose absence killed every retirement proposal in production while this
     * file stayed green. Projecting to the named columns makes a dropped
     * `select` entry read as the `undefined` Prisma would really hand back.
     */
    flowMap: {
      findMany: async (args: Row) => {
        const rows = scenario.crawls ?? [];
        const select = args?.select as Record<string, boolean> | undefined;
        if (!select) return rows;
        const keys = Object.keys(select).filter((key) => select[key] === true);
        return rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])));
      },
    },
    coverageItem: {
      count: async () =>
        (scenario.coverageItems ?? []).filter((item) => item.origin !== 'CRAWL_ONLY').length,
      /*
       * HONOURS `take`, like the database does. A fake that returns every row
       * however small the `take` is cannot show a cap biting — and the cap on
       * this query is the authority for one of the two independent negatives a
       * retirement rests on, so "the fake ignored the cap" is the difference
       * between a test that proves the fence and one that cannot see it.
       */
      findMany: async (args: Row = {}) => {
        calls.coverageQueries.push(args);
        const all = [...(scenario.coverageItems ?? [])].sort((a, b) => a.key.localeCompare(b.key));
        return typeof args.take === 'number' ? all.slice(0, args.take) : all;
      },
    },
    auditLog: {
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        const action = where.action as { in?: string[] } | string | undefined;
        const wanted =
          typeof action === 'string' ? [action] : Array.isArray(action?.in) ? action.in : null;
        return (
          audits.find((row) => {
            if (where.targetId && row.targetId !== where.targetId) return false;
            if (where.targetType && row.targetType !== where.targetType) return false;
            if (wanted && !wanted.includes(row.action)) return false;
            const createdAt = where.createdAt as { gte?: Date } | undefined;
            if (createdAt?.gte && row.createdAt < createdAt.gte) return false;
            return true;
          }) ?? null
        );
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
  };

  return { prisma, calls };
}

const pendingHeal = (over: Row = {}): Row => ({
  id: 'heal-1',
  orgId: 'org-1',
  testId: 'test-1',
  state: 'APPLIED',
  verifyRunId: 'run-verify-1',
  appliedVersion: 4,
  decidedAt: new Date(Date.now() - 10 * 60_000),
  createdAt: new Date(Date.now() - 20 * 60_000),
  ...over,
});

describe('verifying a heal that was applied', () => {
  it('records VERIFIED when the test passed, and changes no code', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal()],
      runs: {
        'run-verify-1': {
          status: 'PASSED',
          results: [{ status: 'PASSED', retriedAndPassed: false }],
        },
      },
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.healUpdates[0]!.data.verifyState).toBe('VERIFIED');
    expect(calls.testUpdates).toEqual([]);
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.verified);
  });

  it('does NOT revert a heal a person approved, and leaves the test red', async () => {
    // Silently rolling back an approved change is its own surprise. Nothing is
    // suppressed: the test is still failing and still gating.
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal({ state: 'APPLIED' })],
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.healUpdates[0]!.data.verifyState).toBe('STILL_FAILING');
    expect(calls.testUpdates).toEqual([]);
    expect(String(calls.healUpdates[0]!.data.verifyNote)).toMatch(/a person approved it/);
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.verificationFailed);
    expect(calls.audits.at(-1)!.metadata.reverted).toBe(false);
  });

  it('DOES revert an unattended heal that failed verification, by appending a version', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal({ state: 'AUTO_APPLIED' })],
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.testUpdates).toHaveLength(1);
    const data = calls.testUpdates[0]!.data;
    expect(data.code).toBe('OLD CODE');
    // Append, never rewind: the history of what QAAI wrote is not ours to edit.
    expect(data.versions.create.version).toBe(5);
    expect(data.versions.create.code).toBe('OLD CODE');
    expect(String(data.versions.create.message)).toMatch(/Reverted an auto-applied heal/);
    // The proposal keeps AUTO_APPLIED rather than going back in the queue: a fix
    // we now have evidence does not work must not be re-offered.
    expect(calls.healUpdates[0]!.data.state).toBeUndefined();
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.reverted);
    expect(calls.audits.at(-1)!.metadata).toMatchObject({ reverted: true, revertedToVersion: 3 });
    // Both halves in one transaction: a revert whose audit row failed to write
    // is a change to the customer's test nobody can explain.
    expect(calls.transactions).toEqual([3]);
  });

  it('refuses to revert when the version it replaced is not in the history', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal({ state: 'AUTO_APPLIED' })],
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [{ version: 4, code: 'HEALED CODE' }],
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.testUpdates).toEqual([]);
    expect(String(calls.healUpdates[0]!.data.verifyNote)).toMatch(/could NOT be reverted/);
    expect(calls.audits.at(-1)!.metadata.reverted).toBe(false);
  });

  it('calls it UNVERIFIABLE when the verifying run is gone', async () => {
    const { prisma, calls } = fakeHealPrisma({ pendingHeals: [pendingHeal()], runs: {} });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.healUpdates[0]!.data.verifyState).toBe('UNVERIFIABLE');
    expect(String(calls.healUpdates[0]!.data.verifyNote)).toMatch(/has NOT been shown to pass/);
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.unverifiable);
    expect(calls.testUpdates).toEqual([]);
  });

  it('waits while the run is still in flight, and claims nothing', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal()],
      runs: { 'run-verify-1': { status: 'RUNNING', results: [] } },
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.healUpdates).toEqual([]);
    expect(calls.audits).toEqual([]);
  });

  it('gives up on a run past the deadline, cancels it, and says nobody checked', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [
        pendingHeal({
          decidedAt: new Date(Date.now() - (HEAL_VERIFY_DEADLINE_MINUTES + 10) * 60_000),
        }),
      ],
      runs: { 'run-verify-1': { status: 'QUEUED', results: [] } },
    });
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.runsCancelled).toHaveLength(1);
    expect(calls.healUpdates[0]!.data.verifyState).toBe('UNVERIFIABLE');
    expect(String(calls.healUpdates[0]!.data.verifyNote)).toMatch(/did not finish within 90/);
  });

  it('one bad row does not stop the sweep for every other org', async () => {
    const { prisma, calls } = fakeHealPrisma({
      pendingHeals: [pendingHeal({ id: 'heal-bad' }), pendingHeal({ id: 'heal-good' })],
      runs: {
        'run-verify-1': {
          status: 'PASSED',
          results: [{ status: 'PASSED', retriedAndPassed: false }],
        },
      },
    });
    let first = true;
    (prisma.run as unknown as { findFirst: (a: Row) => Promise<unknown> }).findFirst = async (
      args: Row,
    ) => {
      if (first) {
        first = false;
        throw new Error('connection reset');
      }
      return args.where.id === 'run-verify-1'
        ? { id: args.where.id, status: 'PASSED', results: [{ status: 'PASSED', retriedAndPassed: false }] }
        : null;
    };
    h.prisma = prisma;

    await verifyAppliedHeals(new Date());

    expect(calls.healUpdates).toHaveLength(1);
    expect(calls.audits.at(-1)!.targetId).toBe('heal-good');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 2: THE ROLLBACK, AGAINST THE REAL WRITE.
//
// `processVerifyHeal` reporting `reverted: true` was pinned by a test against a
// FAKE recorder that was told what to say. The actual revert — appending a new
// TestVersion from `appliedVersion - 1` — was pinned only by the three
// `calls.testUpdates` assertions above, which observe the WRITE and never the
// RETURN, so no caller could be shown to learn what happened. A rollback nobody
// has watched is a rollback.
//
// These go through `healVerificationPorts().recorder`, which is the EXACT
// object the `VERIFY_HEAL_QUEUE` handler in apps/worker/src/index.ts passes to
// `processVerifyHeal` — not a copy of it and not a re-derivation.
// ─────────────────────────────────────────────────────────────────────────────

const recorderArgs = (over: Row = {}): Row => ({
  healId: 'heal-1',
  orgId: 'org-1',
  testId: 'test-1',
  healState: 'AUTO_APPLIED',
  verifyRunId: 'run-verify-1',
  appliedVersion: 4,
  decidedAt: new Date(Date.now() - 10 * 60_000),
  createdAt: new Date(Date.now() - 20 * 60_000),
  now: new Date(),
  ...over,
});

describe('the revert tells its caller what it did', () => {
  it('names the version restored AND the version it was appended as', async () => {
    const { prisma, calls } = fakeHealPrisma({
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    const out = await healVerificationPorts().recorder.record(recorderArgs() as never);

    // The RETURN, which is what the queue path reports to the customer.
    expect(out).toEqual({
      wrote: true,
      state: 'STILL_FAILING',
      reverted: true,
      revertedToVersion: 3,
    });
    // And the WRITE it is a report of, in the same assertion block: a return
    // value that agreed with itself while writing nothing would pass half of
    // this test.
    expect(calls.testUpdates).toHaveLength(1);
    expect(calls.testUpdates[0]!.data.code).toBe('OLD CODE');
    // Append, never rewind.
    expect(calls.testUpdates[0]!.data.versions.create.version).toBe(5);
    expect(calls.audits.at(-1)!.metadata).toMatchObject({
      reverted: true,
      revertedToVersion: 3,
    });
  });

  it('reports the revert it could NOT do, and why, rather than a bare false', async () => {
    /*
     * The decision said revert and the history cannot support it: version 3 is
     * not there, so writing "whatever came before" would put a version of the
     * test in the customer's repository that this heal never replaced. The
     * patch STAYS — and `reverted: false` on its own is indistinguishable from
     * "no revert was asked for", which is a cap that bit and was not disclosed.
     */
    const { prisma, calls } = fakeHealPrisma({
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [{ version: 4, code: 'HEALED CODE' }],
    });
    h.prisma = prisma;

    const out = await healVerificationPorts().recorder.record(recorderArgs() as never);

    expect(out).toEqual({
      wrote: true,
      state: 'STILL_FAILING',
      reverted: false,
      revertedToVersion: null,
    });
    expect(calls.testUpdates).toEqual([]);
    expect(String(calls.healUpdates[0]!.data.verifyNote)).toMatch(/could NOT be reverted/);
  });

  it('never reverts a heal a person approved, and says so in the return', async () => {
    const { prisma, calls } = fakeHealPrisma({
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    const out = await healVerificationPorts().recorder.record(
      recorderArgs({ healState: 'APPLIED' }) as never,
    );

    expect(out.reverted).toBe(false);
    expect(out.revertedToVersion).toBeNull();
    // The predecessor EXISTS here, so a false that came from the refusal above
    // and a false that came from the decision are told apart by the write.
    expect(calls.testUpdates).toEqual([]);
  });

  it('reports a run still in flight as "nothing was written", not as PENDING recorded', async () => {
    /*
     * THE LIE THIS PINS: a thing reported as measured that was not measured.
     * `wrote: false` is the only field that separates "the row was already
     * PENDING and I left it alone" from "I just wrote PENDING".
     */
    const { prisma, calls } = fakeHealPrisma({
      runs: { 'run-verify-1': { status: 'RUNNING', results: [] } },
    });
    h.prisma = prisma;

    const out = await healVerificationPorts().recorder.record(recorderArgs() as never);

    expect(out).toEqual({
      wrote: false,
      state: 'PENDING',
      reverted: false,
      revertedToVersion: null,
    });
    expect(calls.healUpdates).toEqual([]);
    expect(calls.audits).toEqual([]);
    expect(calls.testUpdates).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The heal nothing would ever have checked.
//
// `verifyAppliedHeals` scans `where: { verifyState: 'PENDING' }`. A heal whose
// apply committed and whose verification start then failed has `verifyState:
// null` FOR EVER and no query in that sweep can find it — an applied patch in a
// customer's test that nothing will re-measure.
// ─────────────────────────────────────────────────────────────────────────────

const holeHeal = (over: Row = {}): Row => ({
  id: 'heal-hole',
  orgId: 'org-1',
  state: 'AUTO_APPLIED',
  verifyState: null,
  decidedAt: new Date(Date.now() - 60 * 60_000),
  ...over,
});

describe('the applied heal with no verification state', () => {
  it('is found and asked for, with the sweep reason on the job', async () => {
    const { prisma } = fakeHealPrisma({ holeHeals: [holeHeal()] });
    h.prisma = prisma;

    const out = await startVerificationHoles(new Date());

    expect(out).toMatchObject({ scanned: 1, enqueued: 1, capped: false, failed: 0 });
    expect(h.verifyHealJobs).toEqual([
      { orgId: 'org-1', healId: 'heal-hole', reason: 'SWEEP_FOUND_NO_START' },
    ]);
  });

  it('asks the query for only the window it claims to read', async () => {
    // The lookback is a BOUND and it is disclosed on the function. A query
    // without the `decidedAt` floor would be reading the whole NULL section of
    // the index while the constant said otherwise — a doc comment that
    // contradicts the code under it.
    const now = new Date();
    const { prisma, calls } = fakeHealPrisma({ holeHeals: [holeHeal()] });
    h.prisma = prisma;

    await startVerificationHoles(now);

    const where = calls.holeQueries[0]!.where;
    expect(where.verifyState).toBeNull();
    expect(where.state).toEqual({ in: ['APPLIED', 'AUTO_APPLIED'] });
    expect((where.decidedAt.gte as Date).getTime()).toBe(
      now.getTime() - HEAL_VERIFY_START_LOOKBACK_DAYS * 24 * 60 * 60_000,
    );
  });

  it('refuses with a counted reason rather than silently skipping', async () => {
    const now = new Date();
    const { prisma } = fakeHealPrisma({
      holeHeals: [
        // Inside the grace period: the apply path's own start may be in flight.
        holeHeal({ id: 'heal-fresh', decidedAt: new Date(now.getTime() - 60_000) }),
        // No apply time, so the grace period cannot be measured.
        holeHeal({ id: 'heal-no-time', decidedAt: null }),
        holeHeal({ id: 'heal-real' }),
      ],
    });
    h.prisma = prisma;

    const out = await startVerificationHoles(now);

    expect(out.scanned).toBe(3);
    expect(out.enqueued).toBe(1);
    expect(out.refusals).toEqual({ WITHIN_GRACE: 1, NO_APPLY_TIME: 1 });
    expect(h.verifyHealJobs.map((job) => job.healId)).toEqual(['heal-real']);
  });

  it('DISCLOSES the cap when it bites, so the count reads as a floor', async () => {
    /*
     * A cap applied without being disclosed is one of the lies this product
     * cannot afford. The query asks for `limit + 1` precisely so this can be
     * SEEN rather than inferred from a length that happens to equal the limit.
     */
    const { prisma } = fakeHealPrisma({
      holeHeals: Array.from({ length: 60 }, (_, i) =>
        holeHeal({ id: `heal-${i}`, decidedAt: new Date(Date.now() - (60 + i) * 60_000) }),
      ),
    });
    h.prisma = prisma;

    const out = await startVerificationHoles(new Date());

    expect(out.capped).toBe(true);
    expect(out.scanned).toBe(50);
    expect(out.enqueued).toBe(50);
    expect(h.verifyHealJobs).toHaveLength(50);
  });

  it('one failed enqueue does not stop the sweep for every other org', async () => {
    const { prisma } = fakeHealPrisma({
      holeHeals: [holeHeal({ id: 'heal-bad' }), holeHeal({ id: 'heal-good' })],
    });
    h.prisma = prisma;
    h.verifyHealThrows.add('heal-bad');

    const out = await startVerificationHoles(new Date());

    expect(out).toMatchObject({ scanned: 2, enqueued: 1, failed: 1 });
    expect(h.verifyHealJobs.map((job) => job.healId)).toEqual(['heal-good']);
  });

  it('runs on the tick, and a failure there does not stop the rest of it', async () => {
    /*
     * Through `processFlakeTick`, because the question is whether the sweep is
     * REACHED FROM PRODUCTION. A test that called `startVerificationHoles`
     * directly would pass with the tick's call deleted, which is the exact
     * defect — correct code connected to nothing — this whole round is about.
     */
    const { prisma } = fakeHealPrisma({ holeHeals: [holeHeal()] });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(h.verifyHealJobs).toEqual([
      { orgId: 'org-1', healId: 'heal-hole', reason: 'SWEEP_FOUND_NO_START' },
    ]);
  });
});

describe('the ports the queue reaches this file through', () => {
  it('starts exactly ONE test, tagged so the sweep can find the run again', async () => {
    const { prisma, calls } = fakeHealPrisma({ lastEnvironmentId: 'env-7' });
    h.prisma = prisma;

    const started = await healVerificationPorts().runs.start({
      orgId: 'org-1',
      projectId: 'proj-1',
      environmentId: 'env-7',
      testId: 'test-1',
      triggeredBy: verificationRunTag('heal-1'),
    });

    expect(started.created).toBe(true);
    expect(calls.runCreates).toHaveLength(1);
    const data = calls.runCreates[0]!;
    // ONE test, and only one: re-running five thousand tests to verify one heal
    // is why this has to be targeted.
    expect(data.totalCount).toBe(1);
    expect(data.results.create).toEqual([
      { orgId: 'org-1', testId: 'test-1', status: 'SKIPPED' },
    ]);
    // The tag is what lets the sweep find this run again with no column
    // pointing at it.
    expect(data.triggeredBy).toBe(verificationRunTag('heal-1'));
    // And it went through the toll: a run nobody metered is a run the billing
    // screen under-reports for ever.
    expect(calls.usageUpserts).toHaveLength(1);
  });

  it('reports the plan limit that BIT instead of creating a run behind it', async () => {
    // `advisory`, so the heal still applies — but the verification is recorded
    // UNVERIFIABLE with the org's own plan sentence as its reason. "Applied,
    // nobody checked, here is why" is a true sentence; a silently skipped
    // verification is the defect this whole path exists to close.
    const { prisma, calls } = fakeHealPrisma({
      lastEnvironmentId: 'env-7',
      organization: { plan: 'FREE' },
      usage: { quantity: 10_000n },
    });
    h.prisma = prisma;

    const started = await healVerificationPorts().runs.start({
      orgId: 'org-1',
      projectId: 'proj-1',
      environmentId: 'env-7',
      testId: 'test-1',
      triggeredBy: verificationRunTag('heal-1'),
    });

    expect(started.created).toBe(false);
    expect(started.created === false && started.reason).toContain('runs included with');
    expect(calls.runCreates).toEqual([]);
  });

  it('reads the environment the test last ran in, and NULL when it never has', async () => {
    const ports = healVerificationPorts();
    const { prisma } = fakeHealPrisma({ lastEnvironmentId: 'env-7' });
    h.prisma = prisma;
    expect(await ports.store.lastEnvironmentFor({ orgId: 'org-1', testId: 'test-1' })).toEqual({
      environmentId: 'env-7',
    });

    // NULL means "this test has never run", so there is no environment to
    // reproduce — which `startHealVerification` turns into an honest
    // UNVERIFIABLE rather than guessing a URL to run the customer's test at.
    const never = fakeHealPrisma({ lastEnvironmentId: null });
    h.prisma = never.prisma;
    expect(await ports.store.lastEnvironmentFor({ orgId: 'org-1', testId: 'test-1' })).toBeNull();
  });

  it('loads the heal with the project from its test, in one read', async () => {
    const { prisma } = fakeHealPrisma({
      healsById: {
        'heal-1': {
          id: 'heal-1',
          orgId: 'org-1',
          testId: 'test-1',
          state: 'AUTO_APPLIED',
          verifyState: null,
          verifyRunId: null,
          appliedVersion: 4,
          decidedAt: new Date('2026-10-01T00:00:00.000Z'),
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
          test: { projectId: 'proj-9' },
        },
      },
    });
    h.prisma = prisma;

    const heal = await healVerificationPorts().store.loadHeal({
      orgId: 'org-1',
      healId: 'heal-1',
    });

    // `projectId` is on the TEST, not the proposal: a verification run is a Run
    // and a Run needs a project. Two reads would be two chances for the test to
    // have been deleted in between.
    expect(heal?.projectId).toBe('proj-9');
    // And `createdAt` comes back, because the verification deadline is
    // `decidedAt ?? createdAt` — dropping it from the projection would make
    // every heal with no apply time undateable.
    expect(heal?.createdAt).toEqual(new Date('2026-09-30T00:00:00.000Z'));
  });

  it('refuses a heal from another org', async () => {
    const { prisma } = fakeHealPrisma({
      healsById: { 'heal-1': { id: 'heal-1', orgId: 'org-1', test: { projectId: 'p' } } },
    });
    h.prisma = prisma;
    expect(
      await healVerificationPorts().store.loadHeal({ orgId: 'org-2', healId: 'heal-1' }),
    ).toBeNull();
  });
});

describe('the whole chain, from the job to the customer code', () => {
  /*
   * `processVerifyHeal(healVerificationPorts(), job)` is VERBATIM the body of
   * the `VERIFY_HEAL_QUEUE` registration in apps/worker/src/index.ts. Every
   * other test of this path either stops at the sweep's enqueue or runs the
   * processor against a FAKE recorder that was told what to say. This one runs
   * the production expression and watches the customer's test change.
   */
  const queued = (over: Row = {}): Row => ({
    id: 'heal-1',
    orgId: 'org-1',
    testId: 'test-1',
    state: 'AUTO_APPLIED',
    verifyState: 'PENDING',
    verifyRunId: 'run-verify-1',
    appliedVersion: 4,
    decidedAt: new Date(Date.now() - 10 * 60_000),
    createdAt: new Date(Date.now() - 20 * 60_000),
    test: { projectId: 'proj-1' },
    ...over,
  });

  it('REVERTS the applied version when the verification came back STILL RED', async () => {
    const { prisma, calls } = fakeHealPrisma({
      healsById: { 'heal-1': queued() },
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    const out = await processVerifyHeal(healVerificationPorts(), {
      orgId: 'org-1',
      healId: 'heal-1',
      reason: 'SWEEP_FOUND_NO_START',
    });

    expect(out.outcome).toBe('RECORDED');
    expect(out.verifyState).toBe('STILL_FAILING');
    expect(out.reverted).toBe(true);
    expect(out.revertedToVersion).toBe(3);
    expect(out.note).toContain('reverted to version 3');

    // The CODE moved, and it moved by APPENDING: the history of what QAAI wrote
    // to a customer's test is not ours to edit.
    expect(calls.testUpdates).toHaveLength(1);
    expect(calls.testUpdates[0]!.data.code).toBe('OLD CODE');
    expect(calls.testUpdates[0]!.data.versions.create.version).toBe(5);
    // One transaction: the state, the audit row and the revert. A revert whose
    // audit row failed to write is a change nobody can explain.
    expect(calls.transactions).toEqual([3]);
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.reverted);
  });

  it('leaves a heal a PERSON approved in the customer code, still red', async () => {
    // Silently rolling back an approved change is its own surprise. Nothing is
    // suppressed: the test is still failing and still gating.
    const { prisma, calls } = fakeHealPrisma({
      healsById: { 'heal-1': queued({ state: 'APPLIED' }) },
      runs: {
        'run-verify-1': {
          status: 'FAILED',
          results: [{ status: 'FAILED', retriedAndPassed: false }],
        },
      },
      versions: [
        { version: 3, code: 'OLD CODE' },
        { version: 4, code: 'HEALED CODE' },
      ],
    });
    h.prisma = prisma;

    const out = await processVerifyHeal(healVerificationPorts(), {
      orgId: 'org-1',
      healId: 'heal-1',
      reason: 'OPERATOR',
    });

    expect(out.verifyState).toBe('STILL_FAILING');
    expect(out.reverted).toBe(false);
    expect(out.revertedToVersion).toBeNull();
    expect(calls.testUpdates).toEqual([]);
  });

  it('starts the verifying run for an APPLY job, right after the apply', async () => {
    /*
     * The apply path's door. The job arrives seconds after the apply — inside
     * `VERIFY_START_GRACE_MINUTES` — and it must NOT be refused, because it is
     * the only start this heal is ever going to get.
     */
    const { prisma, calls } = fakeHealPrisma({
      healsById: {
        'heal-1': queued({
          verifyState: null,
          verifyRunId: null,
          decidedAt: new Date(Date.now() - 2_000),
        }),
      },
      lastEnvironmentId: 'env-7',
    });
    h.prisma = prisma;

    const out = await processVerifyHeal(healVerificationPorts(), {
      orgId: 'org-1',
      healId: 'heal-1',
      reason: 'APPLY',
    });

    expect(out.outcome).toBe('STARTED');
    expect(out.verifyState).toBe('PENDING');
    // A real Run, through the real toll, for exactly one test.
    expect(calls.runCreates).toHaveLength(1);
    expect(calls.runCreates[0]!.triggeredBy).toBe(verificationRunTag('heal-1'));
    expect(calls.runCreates[0]!.totalCount).toBe(1);
    // Queued in the background lane: a verification nobody is waiting on must
    // not sit in front of the runs people are.
    // `.at(-1)`, because `h.enqueued` accumulates across this file's cases and
    // a whole-array assertion here would be asserting the order of every other
    // test rather than this one's enqueue.
    expect(h.enqueued.at(-1)).toEqual({ runId: 'run-new-1', background: true });
    // And the four columns were written by the ONE writer, not by the caller.
    expect(calls.healUpdates).toHaveLength(1);
    expect(calls.healUpdates[0]!.data).toMatchObject({
      verifyState: 'PENDING',
      verifyRunId: 'run-new-1',
      // PENDING is not an outcome, so it does not stamp a verification time.
      verifiedAt: null,
    });
  });

  it('records UNVERIFIABLE, never PENDING, when the test has never run', async () => {
    // No environment to reproduce. Guessing one would be running the customer's
    // test against a URL nobody chose, and PENDING would leave the sweep
    // chasing a run that does not exist for ever.
    const { prisma, calls } = fakeHealPrisma({
      healsById: {
        'heal-1': queued({
          verifyState: null,
          verifyRunId: null,
          decidedAt: new Date(Date.now() - 2_000),
        }),
      },
      lastEnvironmentId: null,
    });
    h.prisma = prisma;

    const out = await processVerifyHeal(healVerificationPorts(), {
      orgId: 'org-1',
      healId: 'heal-1',
      reason: 'APPLY',
    });

    expect(out.verifyState).toBe('UNVERIFIABLE');
    expect(calls.runCreates).toEqual([]);
    expect(calls.healUpdates[0]!.data.verifyState).toBe('UNVERIFIABLE');
    // An outcome, so it IS stamped.
    expect(calls.healUpdates[0]!.data.verifiedAt).toBeInstanceOf(Date);
  });

  it('reports a heal that is gone without failing the job', async () => {
    // A project can be deleted mid-flight. Not an error.
    const { prisma } = fakeHealPrisma({ healsById: {} });
    h.prisma = prisma;
    const out = await processVerifyHeal(healVerificationPorts(), {
      orgId: 'org-1',
      healId: 'heal-nope',
      reason: 'OPERATOR',
    });
    expect(out.outcome).toBe('NO_SUCH_HEAL');
  });
});

describe('turning a FLAKE verdict into a repair', () => {
  const verdictRow = (over: Row = {}): Row => ({
    id: 'verdict-1',
    orgId: 'org-1',
    explanation: 'the step timed out once and passed on retry',
    testResult: { testId: 'test-1', errorMessage: 'Timeout 5000ms exceeded' },
    ...over,
  });

  const healTestRow = (over: Row = {}): Row => ({
    id: 'test-1',
    name: 'checkout completes',
    filePath: 'tests/checkout.spec.ts',
    code: HEAL_CODE,
    disabledAt: null,
    projectId: 'proj-1',
    ...over,
  });

  it('proposes the deterministic fix and records how it was derived', async () => {
    const { prisma, calls } = fakeHealPrisma({
      flakeVerdicts: [verdictRow()],
      tests: { 'test-1': healTestRow() },
    });
    h.prisma = prisma;

    await deflakeSweep(new Date());

    expect(calls.healCreates).toHaveLength(1);
    const proposal = calls.healCreates[0]!;
    // STRUCTURAL, never SELECTOR_ONLY: an unattended rewrite of how a test waits
    // is a bigger claim than an unattended rename of a button.
    expect(proposal.riskLevel).toBe('STRUCTURAL');
    expect(proposal.diff).toContain('waitForTimeout');
    expect(proposal.verdictId).toBe('verdict-1');
    expect(proposal.evidence.kind).toBe('DEFLAKE');
    expect(proposal.evidence.findings[0].kind).toBe('FIXED_SLEEP');
    // The never-weaken arithmetic rides along as evidence, not as a promise.
    expect(proposal.evidence.assertionsAfter).toBeGreaterThan(
      proposal.evidence.assertionsBefore as number,
    );
    expect(calls.audits.at(-1)!.action).toBe(HEAL_AUDIT_ACTIONS.deflakeProposed);
  });

  it('records an honest refusal, and no proposal, when it has no automatic fix', async () => {
    // A proposal with an empty diff is a review-queue row with a dead Approve
    // button. The finding still has to be somewhere, so it is in the audit log.
    const { prisma, calls } = fakeHealPrisma({
      flakeVerdicts: [verdictRow()],
      tests: {
        'test-1': healTestRow({
          code: [
            "import { test, expect } from '@playwright/test';",
            "test('clean', async ({ page }) => {",
            "  await page.goto('/checkout');",
            "  await expect(page.getByTestId('total')).toHaveText('$42.00');",
            '});',
          ].join('\n'),
        }),
      },
    });
    h.prisma = prisma;

    await deflakeSweep(new Date());

    expect(calls.healCreates).toEqual([]);
    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(HEAL_AUDIT_ACTIONS.deflakeUnfixable);
    expect(String(audit.metadata.reason)).toMatch(/somewhere QAAI cannot see/);
  });

  it('does not mint a second proposal while an open one still applies', async () => {
    // THE DEFECT: the guard was per TestResult, so one permanently flaky test
    // minted a fresh proposal every run and filled the queue by itself.
    const { prisma, calls } = fakeHealPrisma({
      flakeVerdicts: [verdictRow()],
      tests: { 'test-1': healTestRow() },
      openHeals: [
        {
          id: 'open-1',
          state: 'PROPOSED',
          riskLevel: 'SELECTOR_ONLY',
          diff: HEAL_DIFF,
          createdAt: new Date(),
        },
      ],
    });
    h.prisma = prisma;

    await deflakeSweep(new Date());

    expect(calls.healCreates).toEqual([]);
    expect(calls.audits).toEqual([]);
  });

  it('supersedes an open proposal that no longer applies, and nothing else', async () => {
    const { prisma, calls } = fakeHealPrisma({
      flakeVerdicts: [verdictRow()],
      tests: { 'test-1': healTestRow() },
      openHeals: [
        {
          id: 'stale-1',
          state: 'PROPOSED',
          riskLevel: 'SELECTOR_ONLY',
          diff: [
            '--- a/tests/checkout.spec.ts',
            '+++ b/tests/checkout.spec.ts',
            '@@ -7,1 +7,1 @@',
            "-  await expect(page.getByTestId('gone')).toBeVisible();",
            "+  await expect(page.getByTestId('other')).toBeVisible();",
          ].join('\n'),
          createdAt: new Date(),
        },
      ],
    });
    h.prisma = prisma;

    await deflakeSweep(new Date());

    expect(calls.healCreates).toHaveLength(1);
    expect(calls.healUpdateMany[0]!.where.id.in).toEqual(['stale-1']);
    expect(calls.healUpdateMany[0]!.data.state).toBe('SUPERSEDED');
    expect(calls.healUpdateMany[0]!.data.supersededById).toBe(calls.healCreates[0]!.id);
  });

  it('respects the cooldown, so an unfixable flake is not re-analysed every tick', async () => {
    const { prisma, calls } = fakeHealPrisma({
      flakeVerdicts: [verdictRow()],
      tests: { 'test-1': healTestRow() },
      audits: [
        {
          orgId: 'org-1',
          action: HEAL_AUDIT_ACTIONS.deflakeUnfixable,
          targetType: 'Test',
          targetId: 'test-1',
          metadata: {},
          createdAt: new Date(),
        },
      ],
    });
    h.prisma = prisma;

    await deflakeSweep(new Date());

    expect(calls.healCreates).toEqual([]);
    expect(calls.audits).toHaveLength(1);
  });

  it('never deflakes a fixture or a disabled test', async () => {
    for (const over of [{ filePath: `${FIXTURE_PREFIX}data.json` }, { disabledAt: new Date() }]) {
      const { prisma, calls } = fakeHealPrisma({
        flakeVerdicts: [verdictRow()],
        tests: { 'test-1': healTestRow(over) },
      });
      h.prisma = prisma;
      await deflakeSweep(new Date());
      expect(calls.healCreates).toEqual([]);
    }
  });
});

describe('the drift check and retirement proposals', () => {
  const crawlRow = (nodes: unknown[], truncatedReason: string | null = null): Row => ({
    id: 'flowmap-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    version: 9,
    graph: { baseUrl: 'https://app.test', nodes, exploredAt: '2026-10-24T00:00:00.000Z' },
    truncatedReason,
    acceptance: 'ACCEPTED',
    acceptanceReason: null,
  });

  const projectTest = (over: Row = {}): Row => ({
    id: 'test-1',
    name: 'checkout completes',
    filePath: 'tests/checkout.spec.ts',
    type: 'E2E',
    priority: 'IMPORTANT',
    feature: 'checkout',
    tags: [],
    code: HEAL_CODE,
    spec: null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
    ...over,
  });

  const ordersNode = {
    id: 'n1',
    route: '/orders',
    url: 'https://app.test/orders',
    title: 'Orders',
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
  };

  it('proposes retiring a test whose route is gone from the code and the crawl', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toHaveLength(1);
    const proposal = calls.healCreates[0]!;
    expect(proposal.riskLevel).toBe('RETIRE');
    // No diff, on purpose: a retirement is not a patch.
    expect(proposal.diff).toBe('');
    expect(proposal.evidence.kind).toBe('RETIREMENT');
    expect(String(proposal.explanation)).toMatch(/DISABLES the test/);
    expect(calls.audits.map((row) => row.action)).toEqual([
      HEAL_AUDIT_ACTIONS.retirementProposed,
      HEAL_AUDIT_ACTIONS.driftChecked,
    ]);
  });

  it('proposes nothing from a truncated crawl, and still records the check', async () => {
    // "Past where the crawl stopped" and "not there" are indistinguishable from
    // inside a truncated crawl. The audit row is still written, so the check is
    // not repeated every five minutes for ever.
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode], 'page budget exhausted')],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(HEAL_AUDIT_ACTIONS.driftChecked);
    expect(audit.metadata.summary).toMatchObject({ OBSOLETE: 0, UNMEASURED: 1 });
    expect(String((audit.metadata.caveats as string[]).join(' '))).toMatch(/stopped early/);
  });

  it('proposes nothing when no source analysis has run', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      // Crawl-only items: nothing has read the code, so "not declared" is the
      // absence of a detector rather than a fact.
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'CRAWL_ONLY', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    expect(String((calls.audits.at(-1)!.metadata.caveats as string[]).join(' '))).toMatch(
      /No source analysis/,
    );
  });

  it('warns about drift without proposing anything, before the test fails', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [
        crawlRow([
          {
            ...ordersNode,
            route: '/checkout',
            affordances: [
              {
                label: 'Place order',
                kind: 'button',
                selector: { strategy: 'ROLE', value: 'button', name: 'Place order', confidence: 0.9 },
              },
            ],
          },
        ]),
      ],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/checkout', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    const audit = calls.audits.at(-1)!;
    expect(audit.metadata.summary).toMatchObject({ DRIFTED: 1 });
    const warnings = audit.metadata.warnings as Array<{ missing: Array<{ locator: string }> }>;
    expect(warnings[0]!.missing[0]!.locator).toBe('role=button[pay]');
  });

  it('runs once per crawl, however often the tick fires', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();
    const after = calls.audits.length;
    await driftSweep();

    expect(calls.audits).toHaveLength(after);
  });

  it('never compares a fixture', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest({ filePath: `${FIXTURE_PREFIX}users.json` })],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    expect(calls.audits.at(-1)!.metadata.testsCompared).toBe(0);
  });

  it('is reached by the tick', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await processFlakeTick({ at: new Date().toISOString() });

    expect(calls.audits.some((row) => row.action === HEAL_AUDIT_ACTIONS.driftChecked)).toBe(true);
  });

  /*
   * ── THE CAP THAT COULD MANUFACTURE A RETIREMENT ───────────────────────────
   *
   * The declared-route list is the authority for ONE OF THE TWO independent
   * negatives behind an OBSOLETE verdict, and it was read with a bare
   * `take: 2000`. On a project with more route items than that, a route the
   * source DOES declare does not come back, arrives at `obsolete.ts` as
   * `declared: false` — precisely the negative a retirement needs — and the cap
   * proposes switching off a test whose page is perfectly fine. The crawl side
   * has been fenced since the feature was written; this is the other side.
   */
  const routeItems = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      key: `ROUTE:/filler-${String(i).padStart(4, '0')}`,
      origin: 'BOTH',
      retiredAt: null,
    }));

  it('proposes nothing when the route-item cap bit, and records that it bit', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      // Exactly the scenario of the first test in this block — /checkout absent
      // from a complete crawl and from the declared routes — plus one route item
      // too many, which is the only difference.
      coverageItems: [
        { key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null },
        ...routeItems(2_000),
      ],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(HEAL_AUDIT_ACTIONS.driftChecked);
    expect(audit.metadata.summary).toMatchObject({ OBSOLETE: 0, UNMEASURED: 1 });
    // The disclosure: a count with a "more exist" flag beside it, not a bare
    // number that reads as the whole table.
    expect(audit.metadata.routeItemsTruncated).toBe(true);
    expect(audit.metadata.routesCompared).toBe(2_000);
    expect(audit.metadata.routeItemScanLimit).toBe(2_000);
    expect(String((audit.metadata.caveats as string[]).join(' '))).toMatch(
      /capped before it reached this comparison/,
    );
  });

  it('reads the route items in a defined order, so two readers cannot disagree', async () => {
    // Without an ORDER BY, Postgres returns whichever 2,000 rows it likes, so
    // this sweep and GET /agent/projects/:id/drift can be handed different
    // subsets of one table and reach different verdicts about one test — the
    // screen and the queue disagreeing, which is what sharing the analysis is
    // supposed to make impossible.
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.coverageQueries).toHaveLength(1);
    expect(calls.coverageQueries[0]!.orderBy).toEqual({ key: 'asc' });
    // Read one over the cap on purpose: "there are more" has to be a fact, not
    // an inference from a full page.
    expect(calls.coverageQueries[0]!.take).toBe(2_001);
  });

  it('discloses the test-scan cap instead of reporting a page as the whole suite', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: Array.from({ length: 501 }, (_, i) => projectTest({ id: `test-${i}` })),
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    const audit = calls.audits.at(-1)!;
    expect(audit.metadata.testsCompared).toBe(500);
    expect(audit.metadata.testsTruncated).toBe(true);
    expect(audit.metadata.testScanLimit).toBe(500);
  });

  /*
   * THE TWO TESTS BELOW ARE THE BLOCKING DIRECTION OF `acceptance`, and they
   * exist because its absence shipped.
   *
   * `retirementBlockedBy` (packages/agent/src/obsolete.ts) refuses to retire
   * from a crawl that was never adjudicated or was held as degraded. The gate
   * was correct and `readFlowMap` passed it nothing, so it answered "never
   * adjudicated" for EVERY crawl and no retirement could ever be proposed. The
   * two tests above cover the permissive direction and went red; nothing
   * covered the refusing direction, so once the pass-through exists a revert of
   * it would read as a tightening rather than as the whole feature dying.
   */
  it('withholds the retirement when the crawl was never adjudicated, and says so', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [{ ...crawlRow([ordersNode]), acceptance: null, acceptanceReason: null }],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    // The check still happened and still says what it could not answer.
    const audit = calls.audits.at(-1)!;
    expect(audit.action).toBe(HEAL_AUDIT_ACTIONS.driftChecked);
    expect(String((audit.metadata.caveats as string[]).join(' '))).toMatch(/never adjudicated/);
  });

  it('withholds the retirement from a crawl held as a CANDIDATE, and quotes why', async () => {
    // A degraded crawl produces exactly the evidence a deleted page does: the
    // route is not in the map. Retiring on it destroys coverage because a
    // login expired.
    const { prisma, calls } = fakeHealPrisma({
      crawls: [
        {
          ...crawlRow([ordersNode]),
          acceptance: 'CANDIDATE',
          acceptanceReason: 'the crawl shrank by 71% against v8',
        },
      ],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    expect(calls.healCreates).toEqual([]);
    const caveats = String((calls.audits.at(-1)!.metadata.caveats as string[]).join(' '));
    expect(caveats).toMatch(/CANDIDATE/);
    // The adjudicator's own sentence reaches the reader, not just the state.
    expect(caveats).toMatch(/shrank by 71%/);
  });

  it('records both caps as not having bitten on an ordinary project', async () => {
    const { prisma, calls } = fakeHealPrisma({
      crawls: [crawlRow([ordersNode])],
      projectTests: [projectTest()],
      coverageItems: [{ key: 'ROUTE:/orders', origin: 'BOTH', retiredAt: null }],
    });
    h.prisma = prisma;

    await driftSweep();

    const audit = calls.audits.at(-1)!;
    expect(audit.metadata.testsTruncated).toBe(false);
    expect(audit.metadata.routeItemsTruncated).toBe(false);
    expect(audit.metadata.routesCompared).toBe(1);
    // And the retirement it would have withheld is still proposed, so the fence
    // is a fence and not a blanket refusal.
    expect(calls.healCreates).toHaveLength(1);
  });
});
