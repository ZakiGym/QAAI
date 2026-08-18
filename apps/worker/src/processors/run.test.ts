/**
 * Lifecycle tests for the run processor (§5).
 *
 * Every other test in this directory asks whether a processor produced the
 * right answer. These ask something narrower and more dangerous: whether the
 * processor executed at all, and whether it said so when it stopped.
 *
 * The three failures below were each observed, and each is a case where the
 * worker and the rest of the product disagreed about what a run was:
 *
 *  1. The API wrote CANCELLED, the cockpit said "Run cancelled before it
 *     started", and the worker wrote RUNNING straight over it and drove a
 *     browser through the whole suite — against whatever environment the run
 *     was pointed at, production included. The user pressed Cancel and the
 *     tests ran anyway.
 *  2. Something in the pre-loop setup threw — one rotated vault key did it to
 *     every run in an org — and the run stayed at QUEUED/RUNNING for good. The
 *     elapsed clock never stopped, the gate never resolved, and no
 *     `run.finished` notification was enqueued, so the Slack message and the PR
 *     comment never arrived.
 *  3. A cancel that landed mid-flight bailed with a bare `return`, skipping the
 *     counts, the gate result and the notification, so the cockpit showed a
 *     cancelled run with a blank summary forever.
 *
 * So the assertions here are mostly about absence: no test executed, no status
 * written over someone else's decision — and about the one thing that must
 * always be present, which is a terminal status plus a `run.finished` that
 * somebody downstream can hear.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '@qaai/shared';
import type { ShardedRunJob } from '@qaai/shared';

// The worker's context opens Postgres, Redis and object storage at import time,
// so it is replaced wholesale; `h.prisma` is swapped per test through the proxy.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    published: Array<{ orgId: string; type: string; data: Record<string, unknown> }>;
    notified: Array<{ orgId: string; event: string; payload: Record<string, unknown> }>;
    triaged: Array<{ runId: string; testResultId: string }>;
    executed: string[];
    log: string[];
    /** Set by a test to make the vault (or another setup step) blow up. */
    secretsThrows: Error | null;
    /** Called after each test executes, so a test can cancel the run mid-flight. */
    afterExecute: ((testId: string) => void) | null;
    workers: Array<{ name: string; listeners: Map<string, (...args: never[]) => void> }>;
  } => ({
    prisma: {},
    published: [],
    notified: [],
    triaged: [],
    executed: [],
    log: [],
    secretsThrows: null,
    afterExecute: null,
    workers: [],
  }),
);

vi.mock('../context.js', () => ({
  config: { concurrency: 2, artifactsLocal: true, anthropicApiKey: 'test' },
  connection: { disconnect: () => {} },
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  publishEvent: (orgId: string, event: { type: string; data: Record<string, unknown> }) => {
    h.published.push({ orgId, type: event.type, data: event.data });
  },
  storage: {
    put: async () => {},
    putFile: async () => {},
    get: async () => null,
  },
}));

// The queue producers are plumbing; these tests only care WHAT was asked for.
// `enqueueNotify` in particular is the whole point of two of them — it is what
// carries the Slack message and the PR comment.
vi.mock('../queues.js', () => ({
  ANALYZE_SOURCE_QUEUE: 'qaai.analyze-source',
  DELIVERY_JOB: 'delivery',
  armFlakeTick: async () => {},
  armScheduleTick: async () => {},
  closeProducers: async () => {},
  enqueueNotify: async (job: {
    orgId: string;
    event: string;
    payload: Record<string, unknown>;
  }) => {
    h.notified.push(job);
  },
  enqueueTriage: async (job: { runId: string; testResultId: string }) => {
    h.triaged.push(job);
  },
}));

vi.mock('../vault.js', () => ({
  secretsFor: async () => {
    if (h.secretsThrows) throw h.secretsThrows;
    return {};
  },
  open: () => 'access-key',
}));

vi.mock('../grids.js', () => ({ gridWsEndpoint: () => 'wss://grid.example/ws' }));

vi.mock('@qaai/storage', () => ({
  artifactKey: (a: { orgId: string; runId: string; name: string }) =>
    `orgs/${a.orgId}/runs/${a.runId}/${a.name}`,
}));

/*
 * A plugin that records that it RAN. Nothing here cares what a test returns —
 * the question these tests ask is whether the suite was executed at all, and
 * `h.executed` is the answer to it.
 */
vi.mock('@qaai/runner', () => ({
  DEFAULT_GATE_RULES: [],
  evaluateGates: () => ({ passed: true, evaluations: [] }),
  reasonUnsupported: (type: string) => `${type} is not supported`,
  pluginFor: () => ({
    validate: () => {},
    execute: async (_ctx: unknown, test: { id: string }) => {
      h.executed.push(test.id);
      h.afterExecute?.(test.id);
      return {
        testId: test.id,
        status: 'PASSED' as const,
        durationMs: 10,
        steps: [],
        network: [],
        console: [],
        videoKey: null,
        traceKey: null,
        errorMessage: null,
        retriedAndPassed: false,
        findings: [],
      };
    },
  }),
}));

// run.ts reaches into schedule.ts for the monitor streak; index.ts imports the
// tick from the same module, so one mock serves both.
vi.mock('./schedule.js', () => ({
  recordMonitorResult: async () => {},
  processScheduleTick: async () => {},
}));

/*
 * ── index.ts's own imports ──────────────────────────────────────────────────
 * One test below drives the worker's `failed` handler, which only exists inside
 * index.ts. Importing that file pulls in every processor it registers, and most
 * of them open an LLM client or a browser at import time, so they are stubbed
 * down to the symbols index.ts actually names. `./run.js` is deliberately NOT
 * among them: it is the module under test, and index.ts must get the real one.
 */
vi.mock('./analyze-source.js', () => ({ processAnalyzeSource: async () => {} }));
vi.mock('./explore.js', () => ({ processExplore: async () => {} }));
vi.mock('./generate.js', () => ({ processGenerate: async () => {} }));
vi.mock('./triage.js', () => ({ processTriage: async () => {} }));
vi.mock('./copilot.js', () => ({ processCopilot: async () => {} }));
vi.mock('./edit.js', () => ({ processEdit: async () => {} }));
vi.mock('./notify.js', () => ({ processDelivery: async () => {}, processNotify: async () => {} }));
vi.mock('./import.js', () => ({ processImport: async () => {} }));
vi.mock('./flake.js', () => ({ processFlakeTick: async () => {} }));
vi.mock('./bisect.js', () => ({ processBisect: async () => {} }));
vi.mock('./checks.js', () => ({ armCheckSweep: async () => {}, processChecks: async () => {} }));
vi.mock('./digest.js', () => ({ processDigestTick: async () => {} }));
vi.mock('./retention.js', () => ({
  RETENTION_QUEUE: 'qaai.retention',
  armRetentionSweep: async () => {},
  closeRetentionQueue: async () => {},
  processRetentionTick: async () => {},
}));
vi.mock('./backup.js', () => ({
  BACKUP_QUEUE: 'qaai.backup',
  armBackupSweep: async () => {},
  closeBackupQueue: async () => {},
  processBackupTick: async () => {},
}));
vi.mock('../../../api/src/lib/bisect.js', () => ({ BISECT_QUEUE: 'qaai.bisect' }));
vi.mock('../../../api/src/lib/github-app.js', () => ({ CHECKS_QUEUE: 'qaai.checks' }));

// A BullMQ stand-in that never touches Redis. It keeps the constructor
// arguments and the listeners, because the listener registered on 'failed' IS
// the fix under test.
vi.mock('bullmq', () => ({
  Worker: class {
    name: string;
    listeners = new Map<string, (...args: never[]) => void>();
    constructor(name: string) {
      this.name = name;
      h.workers.push(this);
    }
    on(event: string, fn: (...args: never[]) => void): this {
      this.listeners.set(event, fn);
      return this;
    }
    async close(): Promise<void> {}
  },
}));

const { failRunFromDeadJob, processRun } = await import('./run.js');

// ─────────────────────────────────────────────────────────────────────────────
// A prisma stand-in around one run
// ─────────────────────────────────────────────────────────────────────────────

interface TestRow {
  id: string;
  name: string;
  type: string;
  code: string;
  filePath: string;
  spec: unknown;
  timeoutMs: number;
  quarantined: boolean;
  tags: string[];
  priority: string;
  consecutiveFailures: number;
}

interface ResultRow {
  id: string;
  testId: string;
  shardIndex: number | null;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  test: TestRow;
}

interface RunRow {
  id: string;
  orgId: string;
  projectId: string;
  status: string;
  trigger: string;
  prNumber: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  finalizedAt: Date | null;
  totalCount: number;
  shardCount: number;
  baseUrlOverride: string | null;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  skippedCount: number;
  gateResult: unknown;
  errorMessage: string | null;
}

interface Db {
  run: RunRow;
  results: ResultRow[];
  /** Ordered record of every write to the run row, so a test can see clobbering. */
  runWrites: Array<{ op: 'update' | 'updateMany'; data: Record<string, unknown>; matched: number }>;
  /** Runs updateMany matched, by id — proves an unfiltered where never fans out. */
  otherRuns: RunRow[];
}

const ORG = 'org1';
const RUN = 'run1';

function testRow(id: string): TestRow {
  return {
    id,
    name: `test ${id}`,
    type: 'E2E',
    code: 'await page.goto("/")',
    filePath: `tests/${id}.spec.ts`,
    spec: null,
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
    priority: 'IMPORTANT',
    consecutiveFailures: 0,
  };
}

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    id: RUN,
    orgId: ORG,
    projectId: 'proj1',
    status: 'QUEUED',
    trigger: 'MANUAL',
    prNumber: 42,
    startedAt: null,
    finishedAt: null,
    finalizedAt: null,
    totalCount: 3,
    shardCount: 1,
    baseUrlOverride: null,
    passedCount: 0,
    failedCount: 0,
    flakyCount: 0,
    skippedCount: 0,
    gateResult: null,
    errorMessage: null,
    ...over,
  };
}

/**
 * Prisma's `undefined` semantics, faithfully: a `where` key whose value is
 * `undefined` is NOT a filter, it is an absent filter, and the row matches
 * regardless. That is not a detail worth papering over in a fake — an id that
 * arrives undefined turns a single-row update into an unscoped one, and one of
 * the tests below exists only because of it.
 */
function runMatches(row: RunRow, where: Record<string, unknown>): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.orgId !== undefined && row.orgId !== where.orgId) return false;
  if ('finalizedAt' in where && where.finalizedAt === null && row.finalizedAt !== null)
    return false;
  if ('startedAt' in where && where.startedAt === null && row.startedAt !== null) return false;
  const status = where.status;
  if (typeof status === 'string' && row.status !== status) return false;
  if (status && typeof status === 'object') {
    const list = (status as { in?: string[] }).in;
    if (Array.isArray(list) && !list.includes(row.status)) return false;
    // `notIn` is how a write refuses to relabel a terminal status. A fake that
    // ignored it would let an unconditional write pass every assertion here,
    // which is the shape of hole that lets a real regression through unseen.
    const excluded = (status as { notIn?: string[] }).notIn;
    if (Array.isArray(excluded) && excluded.includes(row.status)) return false;
  }
  return true;
}

function fakeDb(
  opts: {
    run?: Partial<RunRow>;
    results?: ResultRow[];
    /** Mutate the world the instant the processor has taken its snapshot. */
    afterFindFirst?: (db: Db) => void;
  } = {},
): Db {
  const db: Db = {
    run: runRow(opts.run),
    results:
      opts.results ??
      ['r1', 'r2', 'r3'].map((id, i) => ({
        id,
        testId: `t${i + 1}`,
        shardIndex: null,
        status: 'SKIPPED',
        retriedAndPassed: false,
        durationMs: 0,
        test: testRow(`t${i + 1}`),
      })),
    runWrites: [],
    otherRuns: [
      runRow({ id: 'run2', status: 'RUNNING' }),
      runRow({ id: 'run3', status: 'QUEUED' }),
    ],
  };

  const runModel = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      if (!runMatches(db.run, args.where)) return null;
      const snapshot = {
        ...db.run,
        environment: { id: 'env1', baseUrl: 'https://staging.example.com' },
        project: { id: 'proj1', gateRules: [] },
        results: db.results,
      };
      opts.afterFindFirst?.(db);
      return snapshot;
    },
    findUnique: async () => ({ ...db.run }),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = [db.run, ...db.otherRuns].filter((r) => runMatches(r, args.where));
      for (const row of rows) Object.assign(row, args.data);
      db.runWrites.push({ op: 'updateMany', data: args.data, matched: rows.length });
      return { count: rows.length };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(db.run, args.data);
      db.runWrites.push({ op: 'update', data: args.data, matched: 1 });
      return { ...db.run };
    },
  };

  const resultModel = {
    findMany: async () =>
      db.results.map((r) => ({
        ...r,
        test: { name: r.test.name, priority: r.test.priority, quarantined: r.test.quarantined },
        verdict: null,
      })),
    groupBy: async () => {
      const byStatus = new Map<string, number>();
      for (const r of db.results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      return [...byStatus].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
    update: async (args: { where: { id: string }; data: { status?: string } }) => {
      const row = db.results.find((r) => r.id === args.where.id);
      if (row && args.data.status) row.status = args.data.status;
      return {};
    },
  };

  const tx = {
    testResult: resultModel,
    step: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    finding: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    artifact: { upsert: async () => ({}) },
  };

  h.prisma = {
    run: runModel,
    testResult: resultModel,
    organization: { findUniqueOrThrow: async () => ({ plan: 'TEAM' }) },
    // Fixture rows and the auth profile: absent, which is the common case and
    // keeps these tests about the lifecycle rather than the workspace.
    test: {
      findMany: async () => [],
      findUnique: async () => ({ consecutiveFailures: 0 }),
      update: async () => ({}),
    },
    integration: { findFirst: async () => null },
    authProfile: { findFirst: async () => null },
    visualBaseline: { findFirst: async () => null, upsert: async () => ({}) },
    runShard: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };

  return db;
}

const job = (over: Partial<ShardedRunJob> = {}): ShardedRunJob => ({
  orgId: ORG,
  runId: RUN,
  ...over,
});

const published = (type: string) => h.published.filter((e) => e.type === type);

beforeEach(() => {
  h.published = [];
  h.notified = [];
  h.triaged = [];
  h.executed = [];
  h.log = [];
  h.secretsThrows = null;
  h.afterExecute = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) Cancel before the job started
// ─────────────────────────────────────────────────────────────────────────────

describe('a run cancelled before its job was picked up', () => {
  it('executes nothing, and does not even reach the vault', async () => {
    // The normal case, not an exotic one: a busy pool is exactly when people
    // reach for Cancel, so the run is still QUEUED when they press it.
    const db = fakeDb({ run: { status: 'CANCELLED' } });
    const secrets = new Error('the vault should never have been opened');
    h.secretsThrows = secrets;

    await processRun(job());

    expect(h.executed).toEqual([]);
    // Nothing was written over the API's decision.
    expect(db.run.status).toBe('CANCELLED');
    expect(db.runWrites).toEqual([]);
    expect(published('run.started')).toEqual([]);
    // `secretsFor` throwing would have surfaced as an ERRORED run; the run is
    // untouched, so the processor bailed before any setup work at all.
    expect(db.run.errorMessage).toBeNull();
  });

  it('does not start a run that was cancelled while its setup was in flight', async () => {
    // The cancel lands after the processor has loaded the run and before it
    // writes RUNNING. The conditional start is the only thing standing between
    // the user pressing Cancel and a browser being driven at production.
    const db = fakeDb({
      run: { status: 'QUEUED' },
      afterFindFirst: (d) => {
        d.run.status = 'CANCELLED';
      },
    });

    await processRun(job());

    expect(h.executed).toEqual([]);
    expect(db.run.status).toBe('CANCELLED');
    // The start attempt happened and matched nothing. That is the fix: an
    // unconditional update here is what used to resurrect a cancelled run.
    expect(db.runWrites).toHaveLength(1);
    expect(db.runWrites[0]).toMatchObject({ op: 'updateMany', matched: 0 });
    expect(published('run.started')).toEqual([]);
    expect(h.log).toContain('info:run is no longer startable; not executing the suite');
  });

  it('refuses a job that does not say which run, rather than executing somebody else\'s', async () => {
    /*
     * The payload arrives through `as unknown as RunJob` on a BullMQ job, so
     * nothing type-checks it. Prisma reads an undefined `where` value as an
     * ABSENT FILTER, not an impossible one — so an unguarded
     * `findFirst({ where: { id: undefined, orgId: undefined } })` returns the
     * first Run in the table, belonging to whichever tenant sorts first. The
     * processor would then mark THAT run RUNNING and drive a browser through
     * another organisation's suite, against their environment, production
     * included.
     */
    const db = fakeDb({ run: { status: 'QUEUED' } });

    await expect(
      processRun({ orgId: undefined, runId: undefined } as unknown as ShardedRunJob),
    ).rejects.toThrow(/missing orgId or runId/i);

    expect(h.executed).toEqual([]);
    expect(db.runWrites).toEqual([]);
    expect(db.run.status).toBe('QUEUED');
  });

  it('still re-executes a job redelivered for a run already marked RUNNING', async () => {
    // The other half of the same conditional: BullMQ hands a stalled job back,
    // and matching only QUEUED would have it return quietly and leave the run
    // at RUNNING with no verdict, for good.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date('2026-08-01T00:00:00Z') } });

    await processRun(job());

    expect(h.executed).toEqual(['t1', 't2', 't3']);
    expect(db.run.status).toBe('PASSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) A throw before the test loop
// ─────────────────────────────────────────────────────────────────────────────

describe('a failure in the pre-loop setup', () => {
  it('finalises the run ERRORED instead of stranding it, and still notifies', async () => {
    // One rotated vault key stranded every run in an org this way: setup used to
    // sit outside the try, so anything it threw escaped the processor entirely.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    h.secretsThrows = new Error('no key version 2 for this org');

    await expect(processRun(job())).resolves.toBeUndefined();

    expect(h.executed).toEqual([]);
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toBe('no key version 2 for this org');
    // The clock stopped, the gate resolved, and the run reported.
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.run.gateResult).toEqual({ passed: true, evaluations: [] });
    // The notification is the Slack message and the PR comment. Its absence was
    // the part nobody could see from the cockpit.
    expect(h.notified).toEqual([
      { orgId: ORG, event: 'run.finished', payload: { runId: RUN, prNumber: 42 } },
    ]);
    expect(published('run.finished')).toHaveLength(1);
  });
});

describe('a run job that died before the processor could finalise anything', () => {
  it('is marked ERRORED from the failed handler, with counts and a notification', async () => {
    // Nothing else in the system looks at a permanently failed run job. Without
    // this the run sits at RUNNING forever with the cockpit clock still ticking.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date() } });
    db.results[0]!.status = 'PASSED';
    db.results[1]!.status = 'FAILED';

    const rescued = await failRunFromDeadJob({
      orgId: ORG,
      runId: RUN,
      errorMessage: 'job stalled more than maxStalledCount times',
    });

    expect(rescued).toBe(true);
    expect(db.run.status).toBe('ERRORED');
    expect(db.run.errorMessage).toBe('job stalled more than maxStalledCount times');
    // Counted off the result rows, because nothing in memory survived the job.
    expect(db.run.passedCount).toBe(1);
    expect(db.run.failedCount).toBe(1);
    expect(db.run.skippedCount).toBe(1);
    expect(h.notified).toHaveLength(1);
    expect(published('run.finished')).toHaveLength(1);
  });

  it('leaves a run that already reported exactly as it was', async () => {
    // A job failing AFTER the run reported is not a reason to rewrite what it
    // said — the claim is conditional on the run still being in flight.
    const db = fakeDb({ run: { status: 'PASSED', finishedAt: new Date(), passedCount: 3 } });

    const rescued = await failRunFromDeadJob({ orgId: ORG, runId: RUN, errorMessage: 'too late' });

    expect(rescued).toBe(false);
    expect(db.run.status).toBe('PASSED');
    expect(db.run.errorMessage).toBeNull();
    expect(h.notified).toEqual([]);
  });

  it('refuses a job whose payload carries no run id, rather than matching every run', async () => {
    /*
     * The rescue reads `orgId` and `runId` straight off `job.data`, and a job
     * shape that predates them (or a hand-enqueued one) leaves both undefined.
     * Prisma reads an undefined `where` value as "no filter", so the claim
     * would stop being scoped to one run and one org: `updateMany` would stamp
     * `finalizedAt` on EVERY queued or running run in the database, across
     * every tenant, and then finalise whichever row `findFirst` happened to
     * return. One malformed job would end every live run on the platform.
     */
    const db = fakeDb({ run: { status: 'RUNNING' } });

    const rescued = await failRunFromDeadJob({
      orgId: undefined as unknown as string,
      runId: undefined as unknown as string,
      errorMessage: 'unparseable job',
    });

    expect(rescued).toBe(false);
    expect(db.run.status).toBe('RUNNING');
    expect(db.run.finalizedAt).toBeNull();
    expect(db.otherRuns.map((r) => r.status)).toEqual(['RUNNING', 'QUEUED']);
    expect(db.otherRuns.every((r) => r.finalizedAt === null)).toBe(true);
    expect(h.notified).toEqual([]);
  });
});

describe("the worker's permanently-failed handler", () => {
  it('hands a dead run job to the rescue so the run stops being stuck', async () => {
    // The handler is the only listener that hears about a job which failed
    // before `processRun` could finalise anything — a throw in setup, or a job
    // BullMQ could not even hand to the processor.
    const db = fakeDb({ run: { status: 'RUNNING', startedAt: new Date() } });

    await import('../index.js');
    const runWorker = h.workers.find((w) => w.name === QUEUE_NAMES.run);
    expect(runWorker, 'the run queue must have a registered worker').toBeDefined();

    const failed = runWorker!.listeners.get('failed');
    expect(failed, "the run worker must listen for 'failed'").toBeDefined();

    (failed as unknown as (job: unknown, err: Error) => void)(
      {
        id: 'j1',
        name: QUEUE_NAMES.run,
        data: { orgId: ORG, runId: RUN },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error('Missing lock for job j1'),
    );

    // The rescue is fire-and-forget inside an event handler, so it settles a
    // tick later rather than being awaited.
    await vi.waitFor(() => expect(db.run.status).toBe('ERRORED'));
    expect(db.run.errorMessage).toBe('Missing lock for job j1');
    expect(h.notified).toHaveLength(1);
    expect(published('run.finished')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Cancel while the suite is running
// ─────────────────────────────────────────────────────────────────────────────

describe('a cancel that lands while the run is being finalised', () => {
  it('is not relabelled ERRORED by the failure path it raced', async () => {
    /*
     * The conditional START closed this at one layer; `finalizeRun`'s write
     * reopened it at the next. Setup throws (so the catch heads for ERRORED),
     * and the cancel lands in between. An unconditional
     * `run.update({ where: { id } })` would stamp ERRORED over CANCELLED, and
     * the cockpit — which already told the user "cancelled" — would flip to a
     * failure they did not cause.
     */
    const db = fakeDb({
      run: { status: 'QUEUED' },
      afterFindFirst: (d) => {
        // Cancelled after the snapshot, so the early bail does not catch it and
        // the conditional start is what stops execution.
        d.run.status = 'CANCELLED';
      },
    });
    h.secretsThrows = new Error('vault unavailable');

    await processRun(job());

    expect(db.run.status).toBe('CANCELLED');
    expect(db.run.errorMessage).toBeNull();
    // A terminal notification for a status the row does not have is the
    // reassuring lie this file exists to avoid.
    expect(h.notified.filter((n) => n.event === 'run.finished')).toEqual([]);
  });
});

describe('a run cancelled while its suite is executing', () => {
  it('stops between tests and still reports counts, a gate and a notification', async () => {
    const db = fakeDb({ run: { status: 'QUEUED' } });
    // The cancel lands while the first test is executing. The loop checks
    // between tests, so exactly one test runs and the rest are left at their
    // placeholder SKIPPED.
    h.afterExecute = (testId) => {
      if (testId === 't1') db.run.status = 'CANCELLED';
    };

    await processRun(job());

    expect(h.executed).toEqual(['t1']);
    expect(db.run.status).toBe('CANCELLED');

    // The summary the cockpit renders. This used to be blank forever: the bare
    // `return` skipped the counts, the gate and the notification alike.
    expect(db.run.passedCount).toBe(1);
    expect(db.run.skippedCount).toBe(2);
    expect(db.run.failedCount).toBe(0);
    expect(db.run.finishedAt).toBeInstanceOf(Date);
    expect(db.run.gateResult).toEqual({ passed: true, evaluations: [] });

    // And somebody downstream heard about it.
    expect(h.notified).toEqual([
      { orgId: ORG, event: 'run.finished', payload: { runId: RUN, prNumber: 42 } },
    ]);
    const finished = published('run.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toMatchObject({ status: 'CANCELLED', passed: 1, skipped: 2 });
  });

  it('counts the result rows rather than the tests this process happened to reach', async () => {
    // The in-memory counters describe only what ran here. On a cancel they are
    // not the run's counts, and reporting them as such under-counts the skips.
    const db = fakeDb({ run: { status: 'QUEUED' } });
    h.afterExecute = () => {
      db.run.status = 'CANCELLED';
    };

    await processRun(job());

    const total = db.run.passedCount + db.run.failedCount + db.run.flakyCount + db.run.skippedCount;
    expect(total).toBe(db.results.length);
  });
});
