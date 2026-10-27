/**
 * Tests for the pool half of /runners — the two endpoints that let an
 * organisation point an environment at its own machines and then find out
 * whether anything is listening there.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. Both endpoints are TENANT-SCOPED, and the write one especially. It takes
 *      an environment id straight off the URL and changes WHERE THAT
 *      ENVIRONMENT'S TESTS EXECUTE — the failure mode is one customer
 *      redirecting another customer's suite, secrets and all, onto machines
 *      they control. The route's only defence is that it queries through the
 *      scoped `prisma` client inside the request's tenant scope, and that is
 *      invisible at the call site: there is no `orgId` in the `where` to
 *      review. So the fake below applies the scope exactly as the extension
 *      does, and the tests drive the same request from two orgs. Swap `prisma`
 *      for `unscoped(...)` in either route and these fail; nothing else would
 *      notice.
 *
 *   2. A pool nothing serves is REFUSED at the moment it is chosen. Accepting
 *      it and letting a run discover it fifteen minutes later is the exact
 *      failure this whole change exists to remove, and a typo is by far its
 *      most common cause. Clearing the pool is always allowed, because moving
 *      back to QAAI's workers can never strand anything.
 *
 *   3. The pool name is TRIMMED on both sides. `Environment.runnerPool` and
 *      `Runner.pools` are compared with `===`, so `"eu "` registered against
 *      `"eu"` pointed at is a queue that never drains and no error anywhere.
 *
 *   4. `GET /pools` sees a pool that only an ENVIRONMENT names. That is the
 *      configuration behind "I registered a runner and nothing happens", and a
 *      view built from the runner table alone cannot show it.
 *
 *   5. THE MEASUREMENT WRITER on POST /agent/jobs/:jobId/results. `TestResultVariant`
 *      and `TestMetricSample` are the two tables that say WHERE a test passed and
 *      WHAT it measured, and both were shipped with no writer at all — correct
 *      schema, correct validators, nothing persisting a row. The suite below is
 *      mostly about the four ways a writer for them lies: a dimension left to a
 *      database default (which counts the default cell once per run), a
 *      `notRunKind` defaulted to NOT_RUN (a claim nothing produced), a null
 *      reading stored as 0 (a blind spot reported as the best possible result),
 *      and a reading whose cell was not reported being filed against the whole
 *      test (one browser's number becoming the test's). Plus the one property
 *      that makes a redelivered batch safe, which is that these writes REPLACE.
 *
 * Harness: same shape as projects.search.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /**
   * Every write the fake saw, in order, as `model.operation`.
   *
   * An in-memory fake cannot roll anything back, so "these rows were replaced
   * rather than appended" is only observable as an ORDER: the delete has to
   * appear before the insert, and both have to appear inside the one
   * transaction. Without the log, swapping `deleteMany` for nothing at all
   * passes every count assertion on a first delivery.
   */
  ops: string[];
  /** How many times the callback form of `$transaction` was entered. */
  transactions: number;
}

const h = vi.hoisted((): Hoisted => ({
  db: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
  audits: [],
  ops: [],
  transactions: 0,
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

/*
 * The tenancy scope is real, not stubbed: the route's queries run in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and the org-isolation tests would pass for a
 * reason that has nothing to do with the routes.
 */
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

/* Both open a connection at import time and neither is reached by these routes. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));
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

/**
 * A tiny table that applies the tenant filter exactly as the extension does —
 * merging the ambient orgId into `where` for the filterable operations, and
 * post-checking ownership on the unique ones. That merge IS the security
 * property under test, so it is modelled rather than assumed.
 *
 * An unrecognised filter throws. A fake that shrugged at `revokedAt: null`
 * would happily pass the test that proves revoked runners are excluded.
 */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (cond && typeof cond === 'object' && 'in' in cond) {
      return (cond.in as unknown[]).includes(value);
    }
    if (cond && typeof cond === 'object') {
      throw new Error(`fake prisma: unsupported condition on ${key}`);
    }
    return value === cond;
  });
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function table(name: string, rows: Row[]) {
  const scope = (where: Row = {}): Row => {
    const orgId = h.currentOrg();
    return orgId ? { ...where, orgId } : { ...where };
  };

  /** What the tenancy extension stamps onto a create. Scope wins, as it does. */
  const stamp = (data: Row): Row => {
    const orgId = h.currentOrg();
    return { id: `${name}_${rows.length + 1}`, ...data, ...(orgId ? { orgId } : {}) };
  };

  return {
    rows,
    findMany: async ({ where = {}, select, orderBy }: Row = {}) => {
      const found = rows.filter((row) => matches(row, scope(where)));
      if (orderBy) {
        const [key] = Object.keys(orderBy);
        found.sort((a, b) => String(a[key!] ?? '').localeCompare(String(b[key!] ?? '')));
      }
      return found.map((row) => project(row, select));
    },
    findFirst: async ({ where = {}, select }: Row = {}) => {
      const row = rows.find((candidate) => matches(candidate, scope(where)));
      return row ? project(row, select) : null;
    },
    findUnique: async ({ where, select }: Row) => {
      /*
       * EVERY key in `where`, not just `id`. The agent half of this router
       * authenticates by `tokenHash`, so a fake that only understood `id` would
       * answer null and every agent test would be a 401 — passing for a reason
       * that has nothing to do with the route.
       */
      const row = rows.find((candidate) => matches(candidate, where));
      // The extension checks ownership on the RESULT, because a unique lookup
      // cannot take an extra filter. Another org's row reads as not found.
      const orgId = h.currentOrg();
      if (!row || (orgId && row.orgId !== orgId)) return null;
      return project(row, select);
    },
    update: async ({ where, data, select }: Row) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      const orgId = h.currentOrg();
      if (!row || (orgId && row.orgId !== orgId)) {
        throw Object.assign(new Error('record not found'), { code: 'P2025' });
      }
      Object.assign(row, data);
      return project(row, select);
    },
    updateMany: async ({ where = {}, data }: Row = {}) => {
      const found = rows.filter((row) => matches(row, scope(where)));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    create: async ({ data, select }: Row) => {
      const row = stamp(data);
      rows.push(row);
      return project(row, select);
    },
    deleteMany: async ({ where = {} }: Row = {}) => {
      h.ops.push(`${name}.deleteMany`);
      const kept = rows.filter((row) => !matches(row, scope(where)));
      const removed = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count: removed };
    },
    createMany: async ({ data }: Row = {}) => {
      h.ops.push(`${name}.createMany`);
      const list = (Array.isArray(data) ? data : [data]) as Row[];
      for (const entry of list) rows.push(stamp(entry));
      return { count: list.length };
    },
    /*
     * `createManyAndReturn`, and it HONOURS `select` for the same reason every
     * other read here does: the results route maps a reading onto its cell by
     * the id this returns, so a fake that answered with the whole row would
     * make deleting `id: true` from the route's select invisible — and the
     * route would then file every per-cell reading against the whole test.
     */
    createManyAndReturn: async ({ data, select }: Row = {}) => {
      h.ops.push(`${name}.createManyAndReturn`);
      const list = (Array.isArray(data) ? data : [data]) as Row[];
      return list.map((entry) => {
        const row = stamp(entry);
        rows.push(row);
        return project(row, select);
      });
    },
    groupBy: async ({ by, where = {}, _count }: Row) => {
      const found = rows.filter((row) => matches(row, scope(where)));
      const buckets = new Map<string, Row>();
      for (const row of found) {
        const key = (by as string[]).map((field) => String(row[field])).join(' ');
        const bucket = buckets.get(key) ?? {
          ...Object.fromEntries((by as string[]).map((field) => [field, row[field] ?? null])),
          _count: { _all: 0 },
        };
        bucket._count._all += 1;
        buckets.set(key, bucket);
      }
      void _count;
      return [...buckets.values()];
    },
    // `reapExpiredLeases` compares a column against another column.
    fields: { maxAttempts: Symbol('maxAttempts') },
  };
}

const NOW = Date.now();
const fresh = () => new Date(NOW - 5_000);

function seedRunner(over: Row): Row {
  return {
    id: `runner_${over.name}`,
    orgId: 'org_1',
    name: over.name,
    tokenPrefix: 'qaai_rt_aaaaaaaa',
    pools: [],
    capabilities: { browsers: ['chromium'], toolchains: ['node', 'k6'] },
    agentVersion: '1.0.0',
    platform: 'linux-x64',
    lastSeenAt: fresh(),
    lastClaimAt: null,
    tokenRotatedAt: null,
    revokedAt: null,
    createdAt: new Date(NOW - 86_400_000),
    ...over,
  };
}

function seedEnvironment(over: Row): Row {
  return {
    id: `env_${over.name}`,
    orgId: 'org_1',
    projectId: 'proj_1',
    name: over.name,
    kind: 'STAGING',
    baseUrl: 'https://staging.example.test',
    runnerPool: null,
    ...over,
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { runnersRouter } = await import('./runners.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/runners', runnersRouter);
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

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const setPool = (environmentId: string, runnerPool: string | null) =>
  call(`/runners/pools/environments/${environmentId}`, {
    method: 'PUT',
    body: JSON.stringify({ runnerPool }),
  });

function install(seed: {
  runners?: Row[];
  environments?: Row[];
  jobs?: Row[];
  runs?: Row[];
  results?: Row[];
}): void {
  const tables = {
    runner: table('runner', seed.runners ?? []),
    environment: table('environment', seed.environments ?? []),
    runnerJob: table('job', seed.jobs ?? []),
    run: table('run', seed.runs ?? []),
    testResult: table('result', seed.results ?? []),
    step: table('step', []),
    finding: table('finding', []),
    testResultVariant: table('variant', []),
    testMetricSample: table('reading', []),
  };

  h.db = {
    ...tables,
    /*
     * The CALLBACK form, which the results route uses — and the callback is
     * handed an object that is NOT the top-level client.
     *
     * That distinction is the whole value of modelling it: a delegate added to
     * the top level instead of to `tx` changes nothing about what the route can
     * reach through its `tx` argument, and the failure surfaces later as an
     * unrelated TypeError inside a transaction. Here it surfaces immediately.
     * The tables themselves are shared, because an in-memory fake has no
     * rollback and the rows are what the assertions read.
     */
    $transaction: async (fn: unknown) => {
      if (typeof fn !== 'function') {
        throw new Error('fake prisma: the array form of $transaction is not used by these routes');
      }
      h.transactions += 1;
      return (fn as (tx: Record<string, unknown>) => Promise<unknown>)({ ...tables });
    },
  };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
  h.ops.length = 0;
  h.transactions = 0;
  install({});
});

// ─── Org scoping ─────────────────────────────────────────────────────────────

describe('org scoping', () => {
  /*
   * The attack: the caller holds an environment id that is not theirs — leaked
   * in a screenshot, a support thread, or guessed — and the route's `where`
   * names only that id. Redirecting another tenant's suite onto machines you
   * control also redirects that environment's decrypted secrets, which the
   * assignment hands to whichever agent claims the job.
   */
  it("refuses to repoint another org's environment, and leaves the row alone", async () => {
    install({
      runners: [seedRunner({ name: 'mine', orgId: 'org_1', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'theirs', orgId: 'org_2' })],
    });

    const { status, body } = await setPool('env_theirs', 'eu');

    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    const theirs = (h.db.environment as ReturnType<typeof table>).rows[0]!;
    expect(theirs.runnerPool).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it('lets the owning org repoint the very same environment', async () => {
    install({
      runners: [seedRunner({ name: 'theirs', orgId: 'org_2', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'theirs', orgId: 'org_2' })],
    });
    h.actor = { userId: 'user_2', orgId: 'org_2', role: 'ADMIN', ip: null };

    const { status, body } = await setPool('env_theirs', 'eu');

    expect(status).toBe(200);
    expect(body.environment.runnerPool).toBe('eu');
  });

  /*
   * The read side. `GET /pools` returns runner names, environment names and
   * queue depths — an inventory of another customer's internal hosts.
   */
  it('shows an org only its own pools, runners and environments', async () => {
    install({
      runners: [
        seedRunner({ name: 'mine', orgId: 'org_1', pools: ['eu'] }),
        seedRunner({ name: 'theirs', orgId: 'org_2', pools: ['secret-pool'] }),
      ],
      environments: [
        seedEnvironment({ name: 'mine', orgId: 'org_1', runnerPool: 'eu' }),
        seedEnvironment({ name: 'theirs', orgId: 'org_2', runnerPool: 'secret-pool' }),
      ],
      jobs: [
        {
          id: 'job_1',
          orgId: 'org_2',
          pool: 'secret-pool',
          status: 'QUEUED',
          queuedAt: new Date(),
        },
      ],
    });

    const { body } = await call('/runners/pools');

    expect(body.pools.map((p: Row) => p.pool)).toEqual(['eu']);
    expect(body.knownPools).toEqual(['eu']);
    expect(JSON.stringify(body)).not.toContain('secret-pool');
    expect(JSON.stringify(body)).not.toContain('env_theirs');
  });
});

// ─── GET /runners/pools ──────────────────────────────────────────────────────

describe('GET /runners/pools', () => {
  /*
   * The configuration behind every "I registered a runner and nothing happens"
   * report: an environment points at a pool, the org's runner serves a
   * different one, and a view built from the runner table alone shows a healthy
   * fleet and no sign of the problem at all.
   */
  it('surfaces a pool that only an environment names', async () => {
    install({
      runners: [seedRunner({ name: 'us-01', orgId: 'org_1', pools: ['us'] })],
      environments: [seedEnvironment({ name: 'staging', runnerPool: 'eu' })],
    });

    const { body } = await call('/runners/pools');
    const eu = body.pools.find((p: Row) => p.pool === 'eu');

    expect(eu).toBeDefined();
    expect(eu.ready).toBe(false);
    expect(eu.runners).toEqual([]);
    expect(eu.environments.map((e: Row) => e.name)).toEqual(['staging']);
    expect(eu.note).toContain('No runner serves the "eu" pool');
  });

  it('counts the queue per pool from the grouped rows', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging', runnerPool: 'eu' })],
      jobs: [
        { id: 'j1', orgId: 'org_1', pool: 'eu', status: 'QUEUED' },
        { id: 'j2', orgId: 'org_1', pool: 'eu', status: 'QUEUED' },
        { id: 'j3', orgId: 'org_1', pool: 'eu', status: 'RUNNING' },
        // Terminal jobs are not backlog and must not be counted as waiting.
        { id: 'j4', orgId: 'org_1', pool: 'eu', status: 'COMPLETED' },
        { id: 'j5', orgId: 'org_1', pool: 'eu', status: 'SKIPPED' },
      ],
    });

    const { body } = await call('/runners/pools');
    const eu = body.pools.find((p: Row) => p.pool === 'eu');

    expect(eu.queued).toBe(2);
    expect(eu.inFlight).toBe(1);
  });

  /*
   * `knownPools` is what the environment editor offers, so a revoked runner's
   * pool must not be in it — offering it would hand somebody a choice that is
   * refused the moment they save it.
   */
  it('offers only pools a live runner answers to', async () => {
    install({
      runners: [
        seedRunner({ name: 'eu-01', pools: ['eu'] }),
        seedRunner({ name: 'gone', pools: ['decommissioned'], revokedAt: new Date() }),
        seedRunner({ name: 'both', pools: ['gpu', 'eu'] }),
      ],
    });

    const { body } = await call('/runners/pools');
    expect(body.knownPools).toEqual(['eu', 'gpu']);
  });
});

// ─── PUT /runners/pools/environments/:environmentId ──────────────────────────

describe('choosing a pool', () => {
  it('refuses a pool nothing serves, and names the ones that exist', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging' })],
    });

    const { status, body } = await setPool('env_staging', 'eu-staging');

    expect(status).toBe(400);
    expect(body.error.message).toContain('"eu-staging"');
    expect(body.error.message).toContain('Pools your runners serve: eu');
    // And nothing was written — a refusal that half-applies is worse than none.
    expect((h.db.environment as ReturnType<typeof table>).rows[0]!.runnerPool).toBeNull();
  });

  it('tells an org with no runners at all to register one', async () => {
    install({ environments: [seedEnvironment({ name: 'staging' })] });

    const { status, body } = await setPool('env_staging', 'eu');

    expect(status).toBe(400);
    expect(body.error.message).toContain('Register a runner in Settings → Runners first.');
  });

  /*
   * A runner that names no pools serves every pool in its org, so pointing an
   * environment at a name nothing has literally been registered under is still
   * correct here — refusing it would break the one-agent-one-pool deployment
   * that `servesPool` exists to support.
   */
  it('accepts any pool when a runner names none', async () => {
    install({
      runners: [seedRunner({ name: 'any', pools: [] })],
      environments: [seedEnvironment({ name: 'staging' })],
    });

    const { status, body } = await setPool('env_staging', 'whatever');
    expect(status).toBe(200);
    expect(body.environment.runnerPool).toBe('whatever');
  });

  /*
   * The footgun the shared `runnerPoolName` closes. `Environment.runnerPool` is
   * compared with `Runner.pools` using `===`; a trailing space here is a queue
   * that never drains, with no error on any screen.
   */
  it('trims the pool name on the way in', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging' })],
    });

    const { status, body } = await setPool('env_staging', '  eu  ');
    expect(status).toBe(200);
    expect(body.environment.runnerPool).toBe('eu');
  });

  it('trims pool names when a runner is registered, so both sides agree', async () => {
    install({ runners: [] });
    const { status, body } = await call('/runners', {
      method: 'POST',
      body: JSON.stringify({ name: 'eu-01', pools: [' eu ', 'gpu'] }),
    });
    expect(status).toBe(201);
    expect(body.runner.pools).toEqual(['eu', 'gpu']);
  });

  /*
   * Clearing is unconditional. Moving back onto QAAI's workers cannot strand
   * anything, and an org whose last runner was decommissioned must be able to
   * get its suite running again without first registering one.
   */
  it('always allows clearing the pool, even with no runners left', async () => {
    install({ environments: [seedEnvironment({ name: 'staging', runnerPool: 'eu' })] });

    const { status, body } = await setPool('env_staging', null);
    expect(status).toBe(200);
    expect(body.environment.runnerPool).toBeNull();
  });

  it('records both sides of the change in the audit log', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging', runnerPool: 'us' })],
    });

    await setPool('env_staging', 'eu');

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'environment.runner-pool',
      targetType: 'Environment',
      targetId: 'env_staging',
      // "Who moved staging off the on-prem pool" is unanswerable from the new
      // value alone, and it is the question that actually gets asked.
      metadata: { name: 'staging', from: 'us', to: 'eu' },
    });
  });

  it('is closed to viewers', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging' })],
    });
    h.actor = { userId: 'user_1', orgId: 'org_1', role: 'VIEWER', ip: null };

    const { status } = await setPool('env_staging', 'eu');
    expect(status).toBe(403);
    expect((h.db.environment as ReturnType<typeof table>).rows[0]!.runnerPool).toBeNull();
  });

  it('404s an environment that does not exist', async () => {
    install({ runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })] });
    const { status } = await setPool('env_nope', 'eu');
    expect(status).toBe(404);
  });

  it('rejects an empty pool name rather than silently meaning "cloud"', async () => {
    install({
      runners: [seedRunner({ name: 'eu-01', pools: ['eu'] })],
      environments: [seedEnvironment({ name: 'staging' })],
    });

    const { status } = await setPool('env_staging', '   ');
    expect(status).toBe(400);
    expect((h.db.environment as ReturnType<typeof table>).rows[0]!.runnerPool).toBeNull();
  });
});

// ─── POST /runners/agent/jobs/:jobId/results — the measurement writer ────────

/*
 * Everything below drives the ON-PREM AGENT door. The cloud worker's half of
 * the same writer lives in apps/worker/src/processors/run.ts and is covered by
 * its own file; both call ONE builder out of packages/shared, and the last test
 * here is what stops either of them growing a local copy of it.
 */

const { hashToken } = await import('../lib/crypto.js');

/** A token shaped the way `looksLikeRunnerToken` requires. */
const AGENT_TOKEN = `qaai_rt_${'a'.repeat(32)}`;
const LEASE = 'lease_abc';

const rowsOf = (model: string): Row[] => (h.db[model] as { rows: Row[] }).rows;

function seedAgentWorld(over: { results?: Row[]; runs?: Row[]; job?: Row } = {}): void {
  install({
    runners: [seedRunner({ name: 'agent-01', orgId: 'org_1', tokenHash: hashToken(AGENT_TOKEN) })],
    jobs: [
      {
        id: 'job_1',
        orgId: 'org_1',
        runId: 'run_1',
        shardIndex: null,
        status: 'RUNNING',
        leaseId: LEASE,
        leaseExpiresAt: new Date(Date.now() + 600_000),
        attempt: 1,
        maxAttempts: 3,
        ...(over.job ?? {}),
      },
    ],
    runs: over.runs ?? [{ id: 'run_1', orgId: 'org_1', projectId: 'proj_1' }],
    results: over.results ?? [
      {
        id: 'res_1',
        orgId: 'org_1',
        runId: 'run_1',
        testId: 't1',
        shardIndex: null,
        status: 'SKIPPED',
      },
    ],
  });
}

const postResults = (body: Row) =>
  call('/runners/agent/jobs/job_1/results', {
    method: 'POST',
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'x-qaai-lease': LEASE },
    body: JSON.stringify(body),
  });

const execution = (over: Row = {}): Row => ({
  testId: 't1',
  status: 'PASSED',
  durationMs: 3_600,
  steps: [],
  findings: [],
  network: [],
  console: [],
  ...over,
});

const CHROMIUM = {
  browser: 'chromium',
  viewport: '1280x720',
  locale: 'en-US',
  // A REAL ANSWER, not a missing one: this cell ran as a logged-out visitor.
  role: '<anonymous>',
  environment: 'env_1',
};
const WEBKIT = { ...CHROMIUM, browser: 'webkit' };

/** The key format the reads have to agree with. See `variantKeyOf`. */
const keyOf = (cell: typeof CHROMIUM): string =>
  JSON.stringify([cell.browser, cell.viewport, cell.locale, cell.role, cell.environment]);

/**
 * ONE batch, used by this file and mirrored verbatim in the worker's own test.
 *
 * It carries, on purpose: a cell that passed and a cell that failed for the
 * same test (the sentence `TestResult.status` cannot say), the same metric name
 * measured in one cell and UNMEASURED in the other, and a whole-test reading
 * whose value is 0 — a pixel-perfect visual diff, which is the best possible
 * result and the exact number a writer that confuses null with zero destroys.
 */
const MATRIX_BATCH = {
  results: [
    execution({
      status: 'FAILED',
      variants: [
        {
          key: CHROMIUM,
          status: 'PASSED',
          durationMs: 1_200,
          metrics: [
            { name: 'lcp', value: 812.5, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' },
          ],
        },
        {
          key: WEBKIT,
          status: 'FAILED',
          durationMs: 2_400,
          errorMessage: 'expected the cart badge to read 1',
          metrics: [
            {
              name: 'lcp',
              value: null,
              unavailableReason: 'the trace carried no paint entry',
              unit: 'MILLISECONDS',
              direction: 'LOWER_IS_BETTER',
            },
          ],
        },
      ],
      metrics: [
        { name: 'visual_diff_ratio', value: 0, unit: 'RATIO', direction: 'LOWER_IS_BETTER' },
      ],
    }),
  ],
};

describe('the matrix writer', () => {
  it('writes one cell per reported cell, with all five dimensions explicit', async () => {
    seedAgentWorld();

    const { status, body } = await postResults(MATRIX_BATCH);

    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: 1, dropped: 0, cells: 2, readings: 3 });

    const cells = rowsOf('testResultVariant');
    expect(cells).toHaveLength(2);
    /*
     * EVERY DIMENSION ASSERTED BY NAME. They are NOT NULL with no database
     * default, so a writer that omitted one would not fail — it would write the
     * column the database filled in, and the six-column unique index would then
     * treat every run's default cell as the same row. Dropping any one of these
     * five keys from the route's write object turns this assertion red.
     */
    expect(cells[0]).toMatchObject({
      browser: 'chromium',
      viewport: '1280x720',
      locale: 'en-US',
      role: '<anonymous>',
      environment: 'env_1',
      status: 'PASSED',
      durationMs: 1_200,
      errorMessage: null,
      retriedAndPassed: false,
      notRunKind: null,
    });
    expect(cells[1]).toMatchObject({
      browser: 'webkit',
      viewport: '1280x720',
      locale: 'en-US',
      role: '<anonymous>',
      environment: 'env_1',
      status: 'FAILED',
      errorMessage: 'expected the cart badge to read 1',
    });
    for (const cell of cells) {
      for (const dimension of ['browser', 'viewport', 'locale', 'role', 'environment']) {
        expect(cell[dimension], `${dimension} was left to the database`).toEqual(
          expect.any(String),
        );
      }
    }
  });

  it('keeps the per-cell verdicts beside the roll-up instead of reconciling them', async () => {
    seedAgentWorld();
    await postResults(MATRIX_BATCH);

    // The roll-up still says FAILED, untouched. "Where did it pass?" is the
    // cells' question and "did it pass?" is the result's, and overwriting
    // either with the other is how a matrix becomes one wrong answer.
    expect(rowsOf('testResult')[0]!.status).toBe('FAILED');
    expect(rowsOf('testResultVariant').map((cell) => cell.status)).toEqual(['PASSED', 'FAILED']);
  });

  it('copies runId and testId from the parent row, never from the body', async () => {
    seedAgentWorld({
      runs: [
        { id: 'run_1', orgId: 'org_1', projectId: 'proj_1' },
        { id: 'run_2', orgId: 'org_1', projectId: 'proj_2' },
      ],
      results: [
        {
          id: 'res_1',
          orgId: 'org_1',
          runId: 'run_1',
          testId: 't1',
          shardIndex: null,
          status: 'SKIPPED',
        },
        // The same test under ANOTHER run. A write that took its run from the
        // payload would land here, on a run this lease does not hold.
        {
          id: 'res_other',
          orgId: 'org_1',
          runId: 'run_2',
          testId: 't1',
          shardIndex: null,
          status: 'PASSED',
        },
      ],
    });

    const { status } = await postResults({
      results: [
        {
          ...execution({ runId: 'run_2', testResultId: 'res_other', projectId: 'proj_2' }),
          variants: [{ key: CHROMIUM, status: 'PASSED', durationMs: 10 }],
          metrics: [{ name: 'lcp', value: 1, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' }],
        },
      ],
    });

    expect(status).toBe(200);
    const cell = rowsOf('testResultVariant')[0]!;
    expect(cell).toMatchObject({ runId: 'run_1', testId: 't1', testResultId: 'res_1' });
    // And the reading's project came from the RUN, not from the body either.
    expect(rowsOf('testMetricSample')[0]).toMatchObject({
      runId: 'run_1',
      testId: 't1',
      projectId: 'proj_1',
    });
    expect(rowsOf('testResult').find((row) => row.id === 'res_other')!.status).toBe('PASSED');
  });

  it('stores notRunKind as null when absent, and the kind plus its sentence when given', async () => {
    seedAgentWorld();

    await postResults({
      results: [
        execution({
          variants: [
            { key: CHROMIUM, status: 'PASSED', durationMs: 10 },
            {
              key: WEBKIT,
              status: 'SKIPPED',
              durationMs: 0,
              notRun: { kind: 'UNSUPPORTED', why: 'this image has no WebKit build' },
            },
          ],
        }),
      ],
    });

    const [chromium, webkit] = rowsOf('testResultVariant');
    /*
     * NULL, AND NULL IS A FIFTH STATE THAT IS NOT NOT_RUN. The cell ran; the
     * producer simply made no claim about why it measured nothing, because
     * there is nothing to claim. A default of NOT_RUN here would put a sentence
     * in the database that no plugin ever said.
     */
    expect(chromium!.notRunKind).toBeNull();
    expect(webkit!.notRunKind).toBe('UNSUPPORTED');
    // The `why` has no column of its own, so it goes where the parent result's
    // does — tagged, so `parseNotRun` can read the kind back off it.
    expect(webkit!.errorMessage).toBe('[UNSUPPORTED] this image has no WebKit build');
  });

  it('refuses a cell that both failed and declared why nothing ran', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          variants: [
            {
              key: CHROMIUM,
              status: 'SKIPPED',
              durationMs: 0,
              errorMessage: 'the assertion failed',
              notRun: { kind: 'UNSUPPORTED', why: 'no WebKit build' },
            },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('one message column');
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });

  it('refuses a cell with nothing varied, rather than duplicating the roll-up', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          // Every dimension left to its sentinel: the model's own rule is that
          // an unvaried execution writes NO rows here, because one all-sentinel
          // row makes it indistinguishable from a deliberate one-cell matrix.
          variants: [{ key: {}, status: 'PASSED', durationMs: 10 }],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('none of the five dimensions varied');
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });

  it('refuses the same cell twice instead of keeping whichever landed last', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          variants: [
            { key: CHROMIUM, status: 'PASSED', durationMs: 10 },
            { key: CHROMIUM, status: 'FAILED', durationMs: 20 },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('twice');
    expect(body.error.message).toContain('chromium');
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });
});

describe('the reading writer', () => {
  it('writes a whole-test reading with a null variantId and the <unvaried> key', async () => {
    seedAgentWorld();
    await postResults(MATRIX_BATCH);

    const readings = rowsOf('testMetricSample');
    const whole = readings.find((row) => row.name === 'visual_diff_ratio')!;
    /*
     * BOTH HALVES, ALWAYS. `variantId` is the join and `variantKey` is the
     * identity, and the unique index is over the KEY: a unique over the
     * nullable id would treat every whole-test reading as distinct — every NULL
     * is distinct in PostgreSQL — and the same metric would be inserted once
     * per run for ever. Dropping the sentinel write turns this red.
     */
    expect(whole.variantId).toBeNull();
    expect(whole.variantKey).toBe('<unvaried>');
    // 0 IS A MEASUREMENT: a pixel-perfect visual diff. Not null, not absent.
    expect(whole.value).toBe(0);
    expect(whole.unavailableReason).toBeNull();
  });

  it('attaches a cell reading to the cell that reported it', async () => {
    seedAgentWorld();
    await postResults(MATRIX_BATCH);

    const cells = rowsOf('testResultVariant');
    const readings = rowsOf('testMetricSample').filter((row) => row.name === 'lcp');
    expect(readings).toHaveLength(2);

    const chromium = cells.find((cell) => cell.browser === 'chromium')!;
    const webkit = cells.find((cell) => cell.browser === 'webkit')!;
    const measured = readings.find((row) => row.variantKey === keyOf(CHROMIUM))!;
    const unmeasured = readings.find((row) => row.variantKey === keyOf(WEBKIT))!;

    expect(measured.variantId).toBe(chromium.id);
    expect(measured.value).toBe(812.5);
    expect(measured.unavailableReason).toBeNull();

    /*
     * THE SAME METRIC, UNMEASURED IN THE OTHER CELL. Null with a reason, never
     * 0 — an LCP of 0 ms is a page that painted instantly, which is the best
     * result there is, and writing it here would report a blind spot as one.
     */
    expect(unmeasured.variantId).toBe(webkit.id);
    expect(unmeasured.value).toBeNull();
    expect(unmeasured.unavailableReason).toBe('the trace carried no paint entry');
    expect(unmeasured.unit).toBe('MILLISECONDS');
    expect(unmeasured.direction).toBe('LOWER_IS_BETTER');
  });

  it('refuses a reading with no value and no reason', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          metrics: [
            { name: 'lcp', value: null, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(JSON.stringify(body.error.details)).toContain('read as zero');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });

  it('refuses a reading that has both a value and an unavailability reason', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          metrics: [
            {
              name: 'lcp',
              value: 4.2,
              unavailableReason: 'the trace carried no paint entry',
              unit: 'MILLISECONDS',
              direction: 'LOWER_IS_BETTER',
            },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(JSON.stringify(body.error.details)).toContain('cannot both have a value');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });

  it('refuses a reading whose cell this batch did not report, and names the cell', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          variants: [{ key: CHROMIUM, status: 'PASSED', durationMs: 10 }],
          metrics: [
            {
              name: 'lcp',
              value: 900,
              unit: 'MILLISECONDS',
              direction: 'LOWER_IS_BETTER',
              variant: WEBKIT,
            },
          ],
        }),
      ],
    });

    /*
     * The alternative is writing it with `variantId: null`, which would
     * reattribute a WebKit measurement to the whole test — a per-cell number
     * silently becoming a per-test claim.
     */
    expect(status).toBe(400);
    expect(body.error.message).toContain('which this batch did not report');
    expect(body.error.message).toContain('webkit');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });

  it('refuses a nested reading that names a cell other than its own', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          variants: [
            {
              key: CHROMIUM,
              status: 'PASSED',
              durationMs: 10,
              metrics: [
                {
                  name: 'lcp',
                  value: 900,
                  unit: 'MILLISECONDS',
                  direction: 'LOWER_IS_BETTER',
                  variant: WEBKIT,
                },
              ],
            },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('nested under the cell');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });

  it('refuses one metric reported twice for the same cell', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          metrics: [
            { name: 'lcp', value: 1, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' },
            { name: 'lcp', value: 2, unit: 'MILLISECONDS', direction: 'LOWER_IS_BETTER' },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    expect(body.error.message).toContain('twice for the cell');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });
});

describe('redelivery and bounds', () => {
  it('leaves exactly one row per cell and per reading when a batch is redelivered', async () => {
    seedAgentWorld();

    await postResults(MATRIX_BATCH);
    const { status } = await postResults(MATRIX_BATCH);

    expect(status).toBe(200);
    /*
     * REPLACE, NOT APPEND. The agent retries a failed POST without thinking
     * about it — that idempotency is the only way "never let a reporting
     * problem lose a run" works from inside a network we cannot see — so a
     * second delivery must not double a cell, and must not be refused by
     * `TestResultVariant_cell_key` either.
     */
    expect(rowsOf('testResultVariant')).toHaveLength(2);
    expect(rowsOf('testMetricSample')).toHaveLength(3);
  });

  it('deletes before it inserts, inside the one transaction the steps use', async () => {
    seedAgentWorld();
    await postResults(MATRIX_BATCH);

    expect(h.transactions).toBe(1);
    /*
     * The ORDER, and the readings' delete FIRST. A whole-test reading has
     * `variantId: null` and therefore nothing to cascade from, so a
     * variant-only delete would leave last attempt's number beside this
     * attempt's cells. Replacing either `deleteMany` with nothing passes every
     * count assertion on a first delivery and only fails on the second, so the
     * order is asserted directly.
     */
    expect(h.ops).toEqual([
      'step.deleteMany',
      'finding.deleteMany',
      'reading.deleteMany',
      'variant.deleteMany',
      'variant.createManyAndReturn',
      'reading.createMany',
    ]);
  });

  it('clears a matrix a later delivery no longer reports', async () => {
    seedAgentWorld();
    await postResults(MATRIX_BATCH);
    expect(rowsOf('testResultVariant')).toHaveLength(2);

    // The same test, reported without a matrix. The cells must GO, not linger:
    // a stale cell is evidence outliving the run that produced it.
    const { status } = await postResults({ results: [execution()] });

    expect(status).toBe(200);
    expect(rowsOf('testResultVariant')).toHaveLength(0);
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });

  it('refuses more cells than the bound, and says what the bound is', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          variants: Array.from({ length: 201 }, (_unused, index) => ({
            key: { ...CHROMIUM, locale: `en-${index}` },
            status: 'PASSED',
            durationMs: 1,
          })),
        }),
      ],
    });

    expect(status).toBe(400);
    // The BOUND, named. A truncated cell list is a matrix with holes, and a
    // hole reads as "this cell was not varied".
    expect(JSON.stringify(body.error.details)).toContain('at most 200 matrix cells');
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });

  it('refuses more readings than the bound, counting every cell together', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          // Thirteen cells at the schema's own forty readings each is 520, and
          // the per-cell cap cannot see the total. This is the bound that can.
          variants: Array.from({ length: 13 }, (_unused, cell) => ({
            key: { ...CHROMIUM, locale: `en-${cell}` },
            status: 'PASSED',
            durationMs: 1,
            metrics: Array.from({ length: 40 }, (_also, index) => ({
              name: `m${index}`,
              value: index,
              unit: 'COUNT',
              direction: 'LOWER_IS_BETTER',
            })),
          })),
        }),
      ],
    });

    expect(status).toBe(400);
    // The COUNT and the BOUND, both, so the reporter can say how far over it
    // was rather than only that it was over.
    expect(body.error.message).toContain('reported 520 readings');
    expect(body.error.message).toContain('at most 500 per test');
    expect(rowsOf('testMetricSample')).toHaveLength(0);
  });

  it('writes nothing at all when a later result in the batch is refused', async () => {
    seedAgentWorld({
      results: [
        {
          id: 'res_1',
          orgId: 'org_1',
          runId: 'run_1',
          testId: 't1',
          shardIndex: null,
          status: 'SKIPPED',
        },
        {
          id: 'res_2',
          orgId: 'org_1',
          runId: 'run_1',
          testId: 't2',
          shardIndex: null,
          status: 'SKIPPED',
        },
      ],
    });

    const { status } = await postResults({
      results: [
        execution({ variants: [{ key: CHROMIUM, status: 'PASSED', durationMs: 10 }] }),
        execution({
          testId: 't2',
          variants: [
            { key: CHROMIUM, status: 'PASSED', durationMs: 1 },
            { key: CHROMIUM, status: 'FAILED', durationMs: 2 },
          ],
        }),
      ],
    });

    expect(status).toBe(400);
    // A refusal that half-applies is worse than none: the first result's own
    // verdict must not land under a 400 the agent will retry the batch for.
    expect(rowsOf('testResultVariant')).toHaveLength(0);
    expect(rowsOf('testResult').map((row) => row.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(h.transactions).toBe(0);
  });

  it('drops a result for a test outside the slice without writing its matrix', async () => {
    seedAgentWorld();

    const { status, body } = await postResults({
      results: [
        execution({
          testId: 'gone',
          variants: [{ key: CHROMIUM, status: 'PASSED', durationMs: 10 }],
        }),
      ],
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: 0, dropped: 1, cells: 0, readings: 0 });
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });

  it('404s when the run behind the lease has been deleted', async () => {
    seedAgentWorld({ runs: [] });

    const { status, body } = await postResults(MATRIX_BATCH);

    // Never an empty success: without the run there is no project to file a
    // reading under, and a 200 would report a measurement that was not stored.
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(rowsOf('testResultVariant')).toHaveLength(0);
  });
});

describe('the two ingest paths', () => {
  function source(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
  }

  const DOORS = [
    ['the agent route', './runners.ts'],
    ['the cloud worker', '../../../worker/src/processors/run.ts'],
  ] as const;

  /*
   * THE PIN. There are two result-ingest doors and a customer's matrix must not
   * depend on which runner they happen to use, so the row builder is ONE module
   * — packages/shared/src/measurement-rows.ts — that both of them import.
   *
   * For one slice it was instead the same block of source copied into both
   * files, held together by a test that read them off disk and compared bytes.
   * That pin is gone because the duplication is gone, and this is what replaced
   * it: the builder cannot be re-declared locally without going red. A second
   * copy is how two halves of one contract come to disagree, and the compiler
   * will not notice — a local `planMeasurements` would shadow the import and
   * typecheck perfectly.
   */
  it.each(DOORS)('builds %s rows with the shared builder, not a local copy', (_door, file) => {
    const text = source(file);
    expect(text).toMatch(/\bplanMeasurements\b/);
    expect(text).toContain("from '@qaai/shared'");
    // A local declaration of any of the three would mean a second builder.
    expect(text).not.toMatch(/^(?:export )?function planMeasurements\b/m);
    expect(text).not.toMatch(/^(?:export )?function variantKeyOf\b/m);
    expect(text).not.toMatch(/^(?:export )?interface VariantRow\b/m);
  });
});
