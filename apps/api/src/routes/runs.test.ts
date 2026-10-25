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

const h = vi.hoisted((): Hoisted => ({
  db: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  enqueued: [],
  audits: [],
}));

vi.mock('../env.js', () => ({
  env: {
    // hashToken() is an HMAC keyed on this; without it every token
    // digest throws. A fixed value keeps the digests stable across runs.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
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
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
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
    requireRole: (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
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
      findMany: async ({ where = {}, select }: Row = {}) => {
        // The sharding packer's timing lookup, which has no rows to find here.
        if (where.durationMs?.gt !== undefined) return [];
        // The result-cache lookup, which asks for passes from previous runs.
        if (where.status === 'PASSED') return [];
        return store.results
          .filter((row) => !where.runId || row.runId === where.runId)
          .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
          .map((row) => ({
            ...project(row, select),
            // `select: { test: { select: … } }` — joined loosely, because what
            // these tests are about is WHICH tests get re-run, not Prisma's
            // projection.
            ...(select?.test
              ? {
                  test:
                    store.tests.find((test) => test.id === row.testId) ?? {
                      id: row.testId,
                      name: row.testId,
                      disabledAt: null,
                      filePath: `specs/${row.testId}.spec.ts`,
                      quarantined: false,
                      quarantineExpiresAt: null,
                    },
                }
              : {}),
          }));
      },
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
      /*
       * The GET routes. `include` is honoured loosely — enough to assemble the
       * relations the two readers below actually walk — because the point of
       * these tests is the NUMBERS the routes compute, not Prisma's shape.
       */
      findUnique: async ({ where }: Row) => {
        const run = ownedByCaller(store.runs.find((r) => r.id === where.id));
        if (!run) return null;
        return {
          ...run,
          environment: {
            name: 'staging',
            kind: 'STAGING',
            baseUrl: 'https://staging.example.test',
          },
          shards: [],
          results: store.results
            .filter((r) => r.runId === run.id)
            .map((r) => ({
              ...r,
              steps: [],
              findings: [],
              verdict: null,
              test: store.tests.find((t) => t.id === r.testId) ?? {
                id: r.testId,
                name: r.testId,
                quarantined: false,
                quarantineExpiresAt: null,
              },
            })),
        };
      },
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
        for (const result of results?.create ?? [])
          store.results.push({ ...result, runId: run.id });
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
  it("cannot start a run against another org's environment", async () => {
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
  it("judges the pool against this org's runners only", async () => {
    seed();
    store.environments[0]!.runnerPool = 'eu';
    store.runners.push(runner({ name: 'theirs', orgId: 'org_2', pools: ['eu'] }));

    const { body } = await startRunRequest();

    expect(body.dispatch.runnersOnline).toBe(0);
    expect(body.dispatch.warning).toContain('no runner is registered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quarantine: the two readers the defect reached the outside world through.
//
// `GET /runs/:runId` is the CLI's only source for "did this run pass" — the CLI
// ships zero dependencies and cannot import the rule — and `junit.xml` is the
// one output parsed by builds nobody here controls. Both used to report a
// quarantined test's failure as a plain failure, so a run the quality gate had
// already cleared went red in the CLI's exit code and in every CI's own test
// report.
// ─────────────────────────────────────────────────────────────────────────────

/** A finished run with results, in whatever shape a test needs. */
function seedFinishedRun(
  over: {
    status?: string;
    passedCount?: number;
    failedCount?: number;
    flakyCount?: number;
    skippedCount?: number;
    quarantinedFailedCount?: number;
    gateResult?: unknown;
    results?: Row[];
    tests?: Row[];
    totalCount?: number;
    runnerPool?: string | null;
    baseUrlOverride?: string | null;
  } = {},
): string {
  if (over.tests) store.tests = over.tests;
  store.runs.push({
    id: 'run_fin',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    status: over.status ?? 'PASSED',
    totalCount: over.totalCount ?? 10,
    // Columns POST /runs/:runId/rerun-failures copies onto the re-run. Present
    // and null rather than absent, because "the previous run had no commit" and
    // "the fake forgot the column" must not look the same.
    suiteId: null,
    commitSha: null,
    branch: null,
    prNumber: null,
    baseUrlOverride: over.baseUrlOverride ?? null,
    runnerPool: over.runnerPool ?? null,
    failFast: false,
    stopRequestedAt: null,
    stopReason: null,
    passedCount: over.passedCount ?? 9,
    failedCount: over.failedCount ?? 0,
    flakyCount: over.flakyCount ?? 0,
    skippedCount: over.skippedCount ?? 0,
    quarantinedFailedCount: over.quarantinedFailedCount ?? 0,
    gateResult: over.gateResult ?? { passed: true, evaluations: [] },
    errorMessage: null,
    queuedAt: new Date(NOW),
  });
  for (const result of over.results ?? []) store.results.push({ runId: 'run_fin', ...result });
  return 'run_fin';
}

async function getRun(runId: string): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}/runs/${runId}`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

async function getJunit(runId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/runs/${runId}/junit.xml`);
  return res.text();
}

describe('GET /runs/:runId — the verdict the CLI reads', () => {
  it('reports PASSED for a run whose only failures were quarantined', async () => {
    // THE DEFECT, at the boundary the CLI consumes.
    const id = seedFinishedRun({ quarantinedFailedCount: 3 });
    const { body } = await getRun(id);

    expect(body.run.verdict).toMatchObject({ passed: true, status: 'PASSED' });
  });

  it('still reports the suppressed failures, so no consumer can print a clean green', async () => {
    const id = seedFinishedRun({ quarantinedFailedCount: 3 });
    const { body } = await getRun(id);

    expect(body.run.verdict.suppressedFailures).toBe(3);
    expect(body.run.verdict.reason).toContain('quarantined');
    expect(body.run.verdict.reason).toContain('still failing');
  });

  it('reports FAILED when a failure actually gates', async () => {
    const id = seedFinishedRun({ status: 'FAILED', failedCount: 1 });
    const { body } = await getRun(id);

    expect(body.run.verdict).toMatchObject({ passed: false, status: 'FAILED' });
  });

  it('reports FAILED when the gate blocked with every test green', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      gateResult: { passed: false, evaluations: [{ action: 'BLOCK', detail: 'budget' }] },
    });
    const { body } = await getRun(id);

    expect(body.run.verdict.passed).toBe(false);
  });

  it('gives a run still in flight no verdict at all rather than a passing one', async () => {
    const id = seedFinishedRun({ status: 'RUNNING', gateResult: null });
    const { body } = await getRun(id);

    expect(body.run.verdict.passed).toBe(false);
    expect(body.run.verdict.reason).toContain('has not finished');
  });

  it('never reports a cancelled run as a pass', async () => {
    const id = seedFinishedRun({ status: 'CANCELLED' });
    const { body } = await getRun(id);

    expect(body.run.verdict).toMatchObject({ passed: false, status: 'CANCELLED' });
  });

  it('carries the expiry alongside the flag, so a surface cannot mislabel a gating test', async () => {
    const id = seedFinishedRun({
      tests: [
        {
          id: 'test_1',
          orgId: 'org_1',
          projectId: 'proj_1',
          name: 'login',
          quarantined: true,
          quarantineExpiresAt: new Date(NOW - 86_400_000),
        },
      ],
      results: [
        { id: 'res_1', testId: 'test_1', status: 'FAILED', durationMs: 10, errorMessage: 'boom' },
      ],
    });
    const { body } = await getRun(id);

    expect(body.run.results[0].test.quarantineExpiresAt).toBeDefined();
  });
});

describe('GET /runs/:runId/junit.xml — a suppressed failure must not go red in a CI', () => {
  const quarantinedTest = {
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'flaky upload',
    quarantined: true,
    quarantineExpiresAt: new Date(NOW + 86_400_000),
  };

  function seedOneQuarantinedFailure(): string {
    return seedFinishedRun({
      quarantinedFailedCount: 1,
      tests: [quarantinedTest],
      results: [
        {
          id: 'res_1',
          testId: 'test_1',
          status: 'FAILED',
          durationMs: 1_500,
          errorMessage: 'upload timed out',
        },
      ],
    });
  }

  it('emits no <failure> element for it', async () => {
    const xml = await getJunit(seedOneQuarantinedFailure());
    expect(xml).not.toContain('<failure');
  });

  it('and the testsuite agrees — failures="0"', async () => {
    const xml = await getJunit(seedOneQuarantinedFailure());
    expect(xml).toContain('failures="0"');
  });

  it('is DISTINGUISHABLE from a deliberate skip, not just quiet', async () => {
    // `<skipped/>` with no message would be the same defect in a kinder word.
    const xml = await getJunit(seedOneQuarantinedFailure());
    expect(xml).toContain('QUARANTINED FAILURE');
    expect(xml).toContain('it ran, and it failed');
    expect(xml).toContain('upload timed out');
  });

  it('counts the suppressed failures as a property any parser can read', async () => {
    const xml = await getJunit(seedOneQuarantinedFailure());
    expect(xml).toContain('<property name="qaai.quarantinedFailures" value="1"/>');
    expect(xml).toContain('<property name="qaai.quarantinedFailuresInThisDocument" value="1"/>');
  });

  it('leaves a deliberate skip as a bare <skipped/> with nothing added', async () => {
    const id = seedFinishedRun({
      skippedCount: 1,
      tests: [
        {
          id: 'test_1',
          orgId: 'org_1',
          projectId: 'proj_1',
          name: 'unsupported',
          quarantined: false,
          quarantineExpiresAt: null,
        },
      ],
      results: [
        { id: 'res_1', testId: 'test_1', status: 'SKIPPED', durationMs: 0, errorMessage: null },
      ],
    });
    const xml = await getJunit(id);
    expect(xml).toContain('<skipped/>');
    expect(xml).not.toContain('QUARANTINED');
  });

  it('still emits <failure> for a test whose quarantine EXPIRED', async () => {
    // An expired quarantine gates again, and the XML has to agree.
    const id = seedFinishedRun({
      status: 'FAILED',
      failedCount: 1,
      tests: [{ ...quarantinedTest, quarantineExpiresAt: new Date(NOW - 86_400_000) }],
      results: [
        { id: 'res_1', testId: 'test_1', status: 'FAILED', durationMs: 10, errorMessage: 'boom' },
      ],
    });
    const xml = await getJunit(id);
    expect(xml).toContain('<failure');
    expect(xml).toContain('failures="1"');
  });

  it('still emits <failure> for an unquarantined failure', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      failedCount: 1,
      tests: [
        {
          id: 'test_1',
          orgId: 'org_1',
          projectId: 'proj_1',
          name: 'pay',
          quarantined: false,
          quarantineExpiresAt: null,
        },
      ],
      results: [
        { id: 'res_1', testId: 'test_1', status: 'FAILED', durationMs: 10, errorMessage: 'boom' },
      ],
    });
    const xml = await getJunit(id);
    expect(xml).toContain('<failure message="boom"/>');
  });

  it('escapes the quarantine message, so an error cannot break the document', async () => {
    const id = seedFinishedRun({
      quarantinedFailedCount: 1,
      tests: [quarantinedTest],
      results: [
        {
          id: 'res_1',
          testId: 'test_1',
          status: 'FAILED',
          durationMs: 10,
          errorMessage: '</skipped><failure message="injected"/>',
        },
      ],
    });
    const xml = await getJunit(id);
    expect(xml).not.toContain('<failure message="injected"/>');
    expect(xml).toContain('&lt;/skipped&gt;');
  });
});

// ─── Fail-fast: the flag is now RECORDED ─────────────────────────────────────

/**
 * THE DEFECT, VERBATIM: "Enforce fail-fast and the stop request in the worker —
 * the column, the migration, the endpoint and the user-facing promise all
 * exist; the consumer does not, so a stop request is ignored."
 *
 * The consumer could never have existed. `Run.failFast` defaulted to false on
 * every row ever created, because this endpoint accepted the flag, built a
 * report about it, and did not write it — so a worker polling the column would
 * have found every run in the install asking to run to the end. The promise was
 * broken one step earlier than anybody was looking.
 */
describe('POST /runs writes the fail-fast flag onto the run', () => {
  it('records it, so something can poll it', async () => {
    const { status, body } = await startRunRequest({ failFast: true });

    expect(status).toBe(202);
    expect(store.runs[0]!.failFast).toBe(true);
    expect(body.failFast).toMatchObject({ requested: true, recorded: true });
  });

  it('still says `enforced: false`, because the run loop does not read it yet', async () => {
    const { body } = await startRunRequest({ failFast: true });

    /*
     * The two halves, kept apart. Writing the column and claiming the run stops
     * early would be the same lie as before in a nicer costume: the
     * between-tests poll in apps/worker/src/processors/run.ts reads `status`
     * and `finalizedAt` and not `stopRequestedAt`.
     */
    expect(body.failFast.enforced).toBe(false);
    expect(body.failFast.stopChannel).toBe('Run.stopRequestedAt');
    expect(body.failFast.note).toContain('does not yet READ stopRequestedAt');
  });

  it('leaves the column false, and the field absent, when nobody asked', async () => {
    const { body } = await startRunRequest();
    expect(store.runs[0]!.failFast).toBe(false);
    expect(body.failFast).toBeUndefined();
  });
});

// ─── POST /runs/:runId/rerun-failures ────────────────────────────────────────

/**
 * THE DEFECT, VERBATIM: "Re-run only the failures of a previous run — every
 * re-run path re-executes the whole suite, which makes the loop unusable on a
 * 5,000-test suite."
 *
 * The cases below are in order of how expensive the mistake would be, and the
 * first one is the whole reason this endpoint needs tests at all: a re-run that
 * EXECUTES NOTHING and reports PASSED is the worst answer available here, and
 * it is the answer the obvious implementation gives when every failing test has
 * since been deleted, disabled or moved under `fixtures/`.
 */
async function rerunFailures(
  runId: string,
  body: Row = {},
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}/runs/${runId}/rerun-failures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const testRow = (over: Row): Row => ({
  orgId: 'org_1',
  projectId: 'proj_1',
  type: 'E2E',
  disabledAt: null,
  suiteId: null,
  quarantined: false,
  quarantineExpiresAt: null,
  filePath: `specs/${over.id}.spec.ts`,
  name: over.id,
  ...over,
});

describe('re-running only the failures', () => {
  it('queues a run of the failures alone, and reports what it did not run', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      failedCount: 2,
      totalCount: 4,
      tests: [
        testRow({ id: 'test_ok' }),
        testRow({ id: 'test_bad' }),
        testRow({ id: 'test_slow' }),
        testRow({ id: 'test_skip' }),
      ],
      results: [
        { testId: 'test_ok', status: 'PASSED', retriedAndPassed: false, createdAt: 1 },
        { testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 2 },
        { testId: 'test_slow', status: 'TIMED_OUT', retriedAndPassed: false, createdAt: 3 },
        { testId: 'test_skip', status: 'SKIPPED', retriedAndPassed: false, createdAt: 4 },
      ],
    });

    const { status, body } = await rerunFailures(id);

    expect(status).toBe(202);
    expect(body.reran).toBe(2);
    expect(body.ofTotal).toBe(4);

    // Two placeholder results, for the two failures. Not four.
    const rerunRun = store.runs.find((run) => run.id !== id)!;
    expect(rerunRun.totalCount).toBe(2);
    const placeholders = store.results.filter((row) => row.runId === rerunRun.id);
    expect(placeholders.map((row) => row.testId).sort()).toEqual(['test_bad', 'test_slow']);

    // Queued once, on the NEW run id, so a double-clicked button cannot
    // execute the same slice twice.
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.options?.jobId).toBe(`run-${rerunRun.id}`);
  });

  it('copies the base URL override, so the re-run hits the same application', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      baseUrlOverride: 'https://pr-412.preview.example.test',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    await rerunFailures(id);

    /*
     * A preview-deploy run's failures belong to the preview URL. Re-running
     * them against the environment's default would be re-running them against
     * a different application, and a green result from that is worse than no
     * result at all.
     */
    const rerunRun = store.runs.find((run) => run.id !== id)!;
    expect(rerunRun.baseUrlOverride).toBe('https://pr-412.preview.example.test');
  });

  it('keeps an on-prem run on-prem, and enqueues nothing', async () => {
    store.environments[0]!.runnerPool = 'eu';
    store.runners.push(runner({ name: 'eu-01', pools: ['eu'] }));
    const id = seedFinishedRun({
      status: 'FAILED',
      runnerPool: 'eu',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { body } = await rerunFailures(id);

    /*
     * One dispatch path or the other, never both — a re-run that quietly moved
     * an enterprise's work onto QAAI's own workers would be the exact bug the
     * dispatch branch exists to prevent, arriving through a new door.
     */
    expect(h.enqueued).toEqual([]);
    expect(body.dispatch).toMatchObject({ target: 'on-prem', pool: 'eu' });
    const rerunRun = store.runs.find((run) => run.id !== id)!;
    expect(rerunRun.runnerPool).toBe('eu');
    expect(store.runnerJobs).toHaveLength(1);
  });

  it('is triggered MANUAL even when the original was a monitor check', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });
    store.runs[0]!.trigger = 'MONITOR';

    await rerunFailures(id);

    // Labelling it MONITOR would corrupt the monitor's failure streak with a
    // run nobody scheduled.
    expect(store.runs.find((run) => run.id !== id)!.trigger).toBe('MANUAL');
  });

  it('excludes a test that has since been disabled, by name', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 2,
      tests: [
        testRow({ id: 'test_bad' }),
        testRow({ id: 'test_off', name: 'retired check', disabledAt: new Date(NOW) }),
      ],
      results: [
        { testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 },
        { testId: 'test_off', status: 'FAILED', retriedAndPassed: false, createdAt: 2 },
      ],
    });

    const { body } = await rerunFailures(id);

    expect(body.reran).toBe(1);
    expect(body.excluded).toHaveLength(1);
    expect(body.excluded[0]).toMatchObject({ testId: 'test_off', name: 'retired check' });
    expect(body.excluded[0].why).toContain('disabled');
    // And it is genuinely not queued — every other selection path in this file
    // excludes a disabled test, so this must not be the one place it runs.
    const rerunRun = store.runs.find((run) => run.id !== id)!;
    expect(store.results.filter((row) => row.runId === rerunRun.id)).toHaveLength(1);
  });

  it('excludes a test that has moved under fixtures/, which holds no runnable code', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 2,
      tests: [
        testRow({ id: 'test_bad' }),
        testRow({ id: 'test_data', filePath: 'fixtures/users.json' }),
      ],
      results: [
        { testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 },
        { testId: 'test_data', status: 'FAILED', retriedAndPassed: false, createdAt: 2 },
      ],
    });

    const { body } = await rerunFailures(id);
    expect(body.reran).toBe(1);
    expect(body.excluded[0].why).toContain('fixtures/');
  });

  it('counts results that no longer exist rather than reporting fewer failures', async () => {
    /*
     * A TEST THAT NO LONGER EXISTS. `TestResult.test` is `onDelete: Cascade`,
     * so deleting a Test takes its results with it — the failure cannot be
     * re-run because the evidence of it is gone too. The ONLY trace left is the
     * count the run recorded when it started, and without this arithmetic a run
     * of 500 whose results were pruned reads as a run with one failure.
     */
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 500,
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { body } = await rerunFailures(id);

    expect(body.reran).toBe(1);
    expect(body.ofResults).toBe(1);
    expect(body.ofTotal).toBe(500);
    expect(body.vanishedResults).toBe(499);
  });

  it('skips a failure that passed on retry, and says so rather than dropping it', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 2,
      tests: [testRow({ id: 'test_bad' }), testRow({ id: 'test_flake' })],
      results: [
        { testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 },
        { testId: 'test_flake', status: 'FAILED', retriedAndPassed: true, createdAt: 2 },
      ],
    });

    const { body } = await rerunFailures(id);
    expect(body.reran).toBe(1);
    expect(body.retriedAndPassedSkipped).toBe(1);

    // And the caller who wanted them can have them.
    h.enqueued.length = 0;
    const second = await rerunFailures(id, { includeFlaky: true });
    expect(second.body.reran).toBe(2);
    expect(second.body.retriedAndPassedSkipped).toBe(0);
  });

  it('re-runs a quarantined failure but says it cannot turn the run red', async () => {
    const id = seedFinishedRun({
      status: 'PASSED',
      quarantinedFailedCount: 1,
      totalCount: 1,
      tests: [
        testRow({
          id: 'test_q',
          quarantined: true,
          quarantineExpiresAt: new Date(NOW + 86_400_000),
        }),
      ],
      results: [{ testId: 'test_q', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { body } = await rerunFailures(id);

    // It runs — the test is not broken-by-decree, its failure is just not
    // allowed to gate — and a caller reading `reran: 1` deserves to know that.
    expect(body.reran).toBe(1);
    expect(body.quarantinedIncluded).toBe(1);
  });

  it('refuses a run that is still going, rather than re-running a partial answer', async () => {
    const id = seedFinishedRun({
      status: 'RUNNING',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { status, body } = await rerunFailures(id);
    expect(status).toBe(400);
    expect(body.error.message).toContain('still running');
    expect(h.enqueued).toEqual([]);
  });

  it('refuses rather than queueing an empty run when every failure is gone', async () => {
    /*
     * THE WORST AVAILABLE ANSWER, refused. A run that executes nothing
     * finalises PASSED, and a green re-run of a red build is a lie that looks
     * exactly like a fix.
     */
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 2,
      tests: [testRow({ id: 'test_off', disabledAt: new Date(NOW) })],
      results: [{ testId: 'test_off', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { status, body } = await rerunFailures(id);

    expect(status).toBe(409);
    expect(body.error.message).toContain('can no longer run');
    expect(body.error.details.excluded).toHaveLength(1);
    expect(body.error.details.vanishedResults).toBe(1);
    expect(h.enqueued).toEqual([]);
    expect(store.runs).toHaveLength(1);
  });

  it('says "nothing failed" differently from "nothing can be re-run"', async () => {
    const id = seedFinishedRun({
      status: 'PASSED',
      totalCount: 1,
      tests: [testRow({ id: 'test_ok' })],
      results: [{ testId: 'test_ok', status: 'PASSED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { status, body } = await rerunFailures(id);
    // 422, not 409: the request was coherent and there is nothing to retry.
    expect(status).toBe(422);
    expect(body.error.message).toContain('no failures');
  });

  it('404s on a run that does not exist, and on another org’s run', async () => {
    expect((await rerunFailures('run_nope')).status).toBe(404);

    const id = seedFinishedRun({
      status: 'FAILED',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });
    h.actor = { userId: 'user_9', orgId: 'org_other', role: 'MEMBER', ip: null };
    expect((await rerunFailures(id)).status).toBe(404);
  });

  it('meters the re-run, because it costs the same browser', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    await rerunFailures(id);

    // Through `startRun` like every other run-creating path. Six of the seven
    // used to forget, which is why that function exists.
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]!.quantity).toBe(1n);
  });

  it('records that the re-run was a SUBSET in the audit row', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      totalCount: 500,
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    await rerunFailures(id);

    // Six months later this row is the only thing that still remembers a run
    // of 1 was deliberate rather than a catastrophically shrunken suite.
    const entry = h.audits.find((row) => row.action === 'run.rerun-failures');
    expect(entry?.metadata).toMatchObject({
      ofRun: id,
      reran: 1,
      ofResults: 1,
      vanishedResults: 499,
    });
  });

  it('arms fail-fast on the re-run when asked', async () => {
    const id = seedFinishedRun({
      status: 'FAILED',
      tests: [testRow({ id: 'test_bad' })],
      results: [{ testId: 'test_bad', status: 'FAILED', retriedAndPassed: false, createdAt: 1 }],
    });

    const { body } = await rerunFailures(id, { failFast: true });
    expect(store.runs.find((run) => run.id !== id)!.failFast).toBe(true);
    expect(body.failFast).toMatchObject({ recorded: true, enforced: false });
  });
});
