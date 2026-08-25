/**
 * Tests for the dispatch branch in POST /runs — where a run physically executes.
 *
 * The bug this closes is not a crash. Nothing in the codebase ever wrote
 * `Environment.runnerPool` onto a run, so no RunnerJob was ever created, and an
 * enterprise's registered agent long-polled forever against an empty queue
 * while every one of its runs quietly executed on QAAI's own workers — against
 * an environment its own screen said was unreachable from the internet. Every
 * part of that failure is silent, which is why the assertions below are mostly
 * about what did NOT happen.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. EXACTLY ONE dispatch path owns a run. An on-prem run must not also be
 *      enqueued, and a cloud run must not also get RunnerJobs — either mistake
 *      executes the suite twice against one environment, with two sets of
 *      results racing to finalise a single run. `Run.runnerPool` is the record
 *      of which, and both directions are asserted.
 *
 *   2. The environment lookup is TENANT-SCOPED. It takes an environment id off
 *      the request body and the run it creates carries that environment's
 *      secrets to whoever executes it. The route's only defence is the scoped
 *      client inside the request's tenant scope — invisible at the call site,
 *      because there is no `orgId` in the `where` — so the fake applies the
 *      scope the way the extension does and the test drives one request from
 *      the wrong org.
 *
 *   3. A run sent to a pool with nothing listening SAYS SO. Queued against a
 *      dead pool is indistinguishable from a slow run for the fifteen minutes
 *      the sweep waits, and that silence is the whole reason the feature felt
 *      broken. The warning has to reach both the caller and the screen.
 *
 *   4. The run is still created through `startRun`, so it is still metered. An
 *      on-prem run costs the same browser somewhere; a dispatch path that
 *      skipped the toll would put the billing screen back to under-reporting.
 *
 * Harness: same shape as projects.search.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket, and the real `startRun` and `createRunnerJobs` underneath.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Enqueued {
  queue: string;
  payload: Row;
  options: Row | undefined;
}

interface Hoisted {
  db: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  enqueued: Enqueued[];
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
    enqueued: [],
    audits: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
  },
  isProd: false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/** The cloud path's only observable effect, recorded rather than performed. */
vi.mock('../lib/queues.js', () => ({
  enqueue: async (queue: string, payload: Row, options?: Row) => {
    h.enqueued.push({ queue, payload, options });
    return options?.jobId ?? 'job_1';
  },
}));

vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));
vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
}));

vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole:
      (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
        if (ROLE_RANK[req.actor.role as keyof typeof ROLE_RANK] < ROLE_RANK[minimum]) {
          res.status(403).json({ error: { code: 'FORBIDDEN', message: `Requires ${minimum}` } });
          return;
        }
        next();
      },
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

interface Store {
  environments: Row[];
  tests: Row[];
  runners: Row[];
  runs: Row[];
  results: Row[];
  runnerJobs: Row[];
  usage: Row[];
  org: Row;
}

let store: Store;

/**
 * The tenant filter, applied the way the extension applies it.
 *
 * `findUnique` cannot take an extra filter, so the extension checks ownership
 * on the RESULT and returns null for another org's row. That behaviour is what
 * stands between a leaked environment id and another customer's secrets, so it
 * is modelled here rather than assumed.
 */
function ownedByCaller(row: Row | undefined): Row | null {
  const orgId = h.currentOrg();
  if (!row) return null;
  return orgId && row.orgId !== orgId ? null : row;
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function makeDb(): Record<string, unknown> {
  return {
    environment: {
      findUnique: async ({ where, select }: Row) => {
        const row = ownedByCaller(store.environments.find((e) => e.id === where.id));
        return row ? project(row, select) : null;
      },
    },

    test: {
      findMany: async ({ where = {}, select }: Row = {}) => {
        const orgId = h.currentOrg();
        const found = store.tests.filter((test) => {
          if (orgId && test.orgId !== orgId) return false;
          if (where.projectId && test.projectId !== where.projectId) return false;
          if (where.disabledAt === null && test.disabledAt != null) return false;
          if (where.id?.in && !where.id.in.includes(test.id)) return false;
          if (where.suiteId && test.suiteId !== where.suiteId) return false;
          // `filePath: { not: { startsWith: 'fixtures/' } }` — fixtures hold no
          // runnable code and must never be queued as tests.
          const prefix = where.filePath?.not?.startsWith;
          if (prefix && String(test.filePath).startsWith(prefix)) return false;
          return true;
        });
        return found.map((row) => project(row, select));
      },
    },

    testResult: {
      // Only reached by the sharding packer's timing lookup.
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    testVersion: { findMany: async () => [] },
    flowMap: { findFirst: async () => null },

    runner: {
      findMany: async ({ where = {}, select }: Row = {}) => {
        const orgId = h.currentOrg();
        return store.runners
          .filter((r) => !orgId || r.orgId === orgId)
          .filter((r) => (where.revokedAt === null ? r.revokedAt === null : true))
          .map((row) => project(row, select));
      },
    },

    runnerJob: {
      createMany: async ({ data, skipDuplicates }: Row) => {
        const orgId = h.currentOrg();
        let count = 0;
        for (const row of data as Row[]) {
          if (skipDuplicates && store.runnerJobs.some((j) => j.dedupeKey === row.dedupeKey)) {
            continue;
          }
          store.runnerJobs.push({
            id: `job_${store.runnerJobs.length + 1}`,
            status: 'QUEUED',
            errorMessage: null,
            ...row,
            ...(orgId ? { orgId } : {}),
          });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const orgId = h.currentOrg();
        const found = store.runnerJobs.filter(
          (job) =>
            (!orgId || job.orgId === orgId) &&
            (where.runId === undefined || job.runId === where.runId) &&
            (where.status === undefined || job.status === where.status),
        );
        for (const job of found) Object.assign(job, data);
        return { count: found.length };
      },
    },

    run: {
      create: async ({ data }: Row) => {
        const orgId = h.currentOrg();
        const { results, shards, ...rest } = data as Row;
        const run = {
          id: `run_${store.runs.length + 1}`,
          status: 'QUEUED',
          queuedAt: new Date(),
          ...rest,
          ...(orgId ? { orgId } : {}),
        };
        store.runs.push(run);
        for (const result of results?.create ?? []) store.results.push({ ...result, runId: run.id });
        void shards;
        return run;
      },
    },

    // The toll `startRun` takes. Present so the real function runs, rather than
    // being mocked away — the metering assertion below is only worth anything
    // if the code under test is the code that meters.
    subscription: { findUnique: async () => null },
    organization: {
      findUnique: async ({ select }: Row) => project(store.org, select),
    },
    usageRecord: {
      findUnique: async () => store.usage[0] ?? null,
      upsert: async ({ create, update }: Row) => {
        const existing = store.usage[0];
        if (existing) {
          existing.quantity += BigInt(update.quantity?.increment ?? 0);
          return existing;
        }
        store.usage.push({ ...create });
        return store.usage[0];
      },
    },
  };
}

// ─── Seeds ───────────────────────────────────────────────────────────────────

const NOW = Date.now();

function seed(over: Partial<Store> = {}): void {
  store = {
    environments: [
      {
        id: 'env_1',
        orgId: 'org_1',
        projectId: 'proj_1',
        name: 'staging',
        baseUrl: 'https://staging.example.test',
        updatedAt: new Date(NOW - 86_400_000),
        runnerPool: null,
      },
    ],
    tests: [
      {
        id: 'test_1',
        orgId: 'org_1',
        projectId: 'proj_1',
        name: 'login',
        type: 'E2E',
        filePath: 'tests/login.spec.ts',
        disabledAt: null,
        suiteId: null,
      },
    ],
    runners: [],
    runs: [],
    results: [],
    runnerJobs: [],
    usage: [],
    org: { id: 'org_1', plan: 'ENTERPRISE' },
    ...over,
  };
  h.db = makeDb();
}

function runner(over: Row): Row {
  return {
    id: `runner_${over.name}`,
    orgId: 'org_1',
    name: over.name,
    pools: [],
    capabilities: { browsers: ['chromium'], toolchains: ['node', 'k6'] },
    lastSeenAt: new Date(NOW - 5_000),
    revokedAt: null,
    ...over,
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { runsRouter } = await import('./runs.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/runs', runsRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let baseUrl = '';
let server: import('node:http').Server;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function startRunRequest(body: Row = {}): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environmentId: 'env_1', ...body }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.enqueued.length = 0;
  h.audits.length = 0;
  seed();
});

// ─── One path or the other, never both ───────────────────────────────────────

describe('the cloud path is unchanged', () => {
  it('enqueues, creates no runner job, and leaves runnerPool null', async () => {
    const { status, body } = await startRunRequest();

    expect(status).toBe(202);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.payload).toMatchObject({ orgId: 'org_1', runId: body.run.id });
    expect(h.enqueued[0]!.options?.jobId).toBe(`run-${body.run.id}`);

    // The half that used to be the whole story, and must stay that way for
    // every org that has not bought on-prem execution.
    expect(store.runnerJobs).toEqual([]);
    expect(store.runs[0]!.runnerPool).toBeNull();

    expect(body.jobId).toBeDefined();
    expect(body.dispatch).toBeUndefined();
  });
});

describe('the on-prem path', () => {
  beforeEach(() => {
    seed();
    store.environments[0]!.runnerPool = 'eu';
    store.runners.push(runner({ name: 'eu-01', pools: ['eu'] }));
  });

  /*
   * The original bug, stated as a test: nothing wrote `runnerPool`, so no
   * RunnerJob existed, so a registered agent polled forever and the run
   * executed on QAAI's workers instead.
   */
  it('creates a runner job and enqueues nothing at all', async () => {
    const { status, body } = await startRunRequest();

    expect(status).toBe(202);
    expect(h.enqueued).toEqual([]);
    expect(store.runs[0]!.runnerPool).toBe('eu');

    expect(store.runnerJobs).toHaveLength(1);
    expect(store.runnerJobs[0]).toMatchObject({
      runId: body.run.id,
      orgId: 'org_1',
      pool: 'eu',
      // Null, not 0 — the same convention `TestResult.shardIndex` uses for
      // "the whole run", and what `buildAssignment` reads to select every test.
      shardIndex: null,
      dedupeKey: `${body.run.id}:all`,
      status: 'QUEUED',
    });

    expect(body.dispatch).toMatchObject({ target: 'on-prem', pool: 'eu', jobs: 1 });
    // No queue job exists, so reporting an id that names one would be a lie.
    expect(body.jobId).toBeUndefined();
  });

  it('derives what a runner must have from the tests in the slice', async () => {
    store.tests.push({
      id: 'test_2',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'peak traffic',
      type: 'LOAD',
      filePath: 'tests/load.spec.ts',
      disabledAt: null,
      suiteId: null,
    });

    await startRunRequest();

    const requirements = store.runnerJobs[0]!.requirements as Row;
    expect(requirements.browsers).toEqual(['chromium']);
    // Named exactly as it appears on PATH, so the agent's probe and this
    // requirement are the same string.
    expect(requirements.toolchains).toEqual(['k6']);
    expect([...(requirements.testTypes as string[])].sort()).toEqual(['E2E', 'LOAD']);
  });

  it('creates one job per shard, and still enqueues nothing', async () => {
    for (let i = 2; i <= 4; i += 1) {
      store.tests.push({
        id: `test_${i}`,
        orgId: 'org_1',
        projectId: 'proj_1',
        name: `t${i}`,
        type: 'E2E',
        filePath: `tests/t${i}.spec.ts`,
        disabledAt: null,
        suiteId: null,
      });
    }

    const { body } = await startRunRequest({ shards: 3 });

    expect(h.enqueued).toEqual([]);
    expect(store.runnerJobs).toHaveLength(3);
    expect(store.runnerJobs.map((j) => j.shardIndex).sort()).toEqual([0, 1, 2]);
    expect(store.runnerJobs.map((j) => j.dedupeKey).sort()).toEqual([
      `${body.run.id}:0`,
      `${body.run.id}:1`,
      `${body.run.id}:2`,
    ]);
  });

  /*
   * A run still costs a browser somewhere. Metering is what `GET /billing`
   * reads back, and a dispatch path that quietly skipped `startRun` would put
   * the usage screen back to under-reporting exactly the runs a CI product
   * makes most of.
   */
  it('is still metered, because it is still created through startRun', async () => {
    await startRunRequest();
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({ orgId: 'org_1', metric: 'runs', quantity: 1n });
  });

  it('records where the run went in the audit log', async () => {
    await startRunRequest();
    expect(h.audits[0]!.metadata).toMatchObject({
      dispatch: { target: 'on-prem', pool: 'eu', jobs: 1 },
    });
  });
});

// ─── Saying so when nothing is listening ─────────────────────────────────────

describe('a pool nothing is listening to', () => {
  beforeEach(() => {
    seed();
    store.environments[0]!.runnerPool = 'eu';
  });

  /*
   * The failure mode this change exists to remove. A run queued against a pool
   * with no runner looks EXACTLY like a run executing slowly — same QUEUED
   * status, same empty results — for the fifteen minutes the sweep waits before
   * it will say anything at all.
   */
  it('warns the caller, naming the pool and the fix', async () => {
    const { status, body } = await startRunRequest();

    // Still created, still queued: an agent that starts thirty seconds later
    // picks this up normally, and refusing would turn a restart into a failed
    // build.
    expect(status).toBe(202);
    expect(store.runnerJobs).toHaveLength(1);

    expect(body.dispatch.warning).toContain('no runner is registered');
    expect(body.dispatch.warning).toContain('Settings → Runners');
    expect(body.dispatch.runnersOnline).toBe(0);
  });

  it('names the pool when the fleet is healthy but serves somewhere else', async () => {
    store.runners.push(runner({ name: 'us-01', pools: ['us'] }));

    const { body } = await startRunRequest();

    expect(body.dispatch.warning).toContain('"eu"');
    expect(body.dispatch.warning).toContain('Add "eu" to the pools of an existing runner');
  });

  /*
   * The 202 reaches whoever made the request. The person who goes looking is on
   * Settings → Runners, where a job's `errorMessage` is the row — so the reason
   * is written there too, or a scheduled run's warning reaches nobody at all.
   */
  it('writes the reason onto the queued job, where the screen will find it', async () => {
    const { body } = await startRunRequest();
    expect(store.runnerJobs[0]!.errorMessage).toBe(body.dispatch.warning);
  });

  it('says nothing when the pool can take the work', async () => {
    store.runners.push(runner({ name: 'eu-01', pools: ['eu'] }));

    const { body } = await startRunRequest();

    expect(body.dispatch.warning).toBeNull();
    expect(body.dispatch.runnersOnline).toBe(1);
    // A clean queue row: no reason where there is no problem.
    expect(store.runnerJobs[0]!.errorMessage).toBeNull();
  });

  it('warns about a runner that is registered for the pool but silent', async () => {
    store.runners.push(
      runner({ name: 'eu-01', pools: ['eu'], lastSeenAt: new Date(NOW - 10 * 60_000) }),
    );

    const { body } = await startRunRequest();

    expect(body.dispatch.warning).toContain('has checked in within the last minute');
    expect(body.dispatch.warning).toContain('eu-01');
  });
});

// ─── Org scoping ─────────────────────────────────────────────────────────────

describe('org scoping', () => {
  /*
   * The attack: a caller holds an environment id that is not theirs. A run
   * against it would hand that environment's decrypted secrets to whichever
   * agent claims the job — which, if the environment names a pool, is a machine
   * in someone else's network.
   */
  it('cannot start a run against another org\'s environment', async () => {
    seed();
    store.environments[0]!.orgId = 'org_2';
    store.environments[0]!.runnerPool = 'eu';
    store.runners.push(runner({ name: 'eu-01', orgId: 'org_2', pools: ['eu'] }));

    const { status, body } = await startRunRequest();

    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(store.runs).toEqual([]);
    expect(store.runnerJobs).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  /*
   * Readiness is judged against the caller's own fleet. Another org's healthy
   * runners must not silence the warning — a warning that can be suppressed by
   * a stranger's infrastructure is worse than none.
   */
  it('judges the pool against this org\'s runners only', async () => {
    seed();
    store.environments[0]!.runnerPool = 'eu';
    store.runners.push(runner({ name: 'theirs', orgId: 'org_2', pools: ['eu'] }));

    const { body } = await startRunRequest();

    expect(body.dispatch.runnersOnline).toBe(0);
    expect(body.dispatch.warning).toContain('no runner is registered');
  });
});
