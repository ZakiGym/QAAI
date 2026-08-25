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
 * Harness: same shape as projects.search.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
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
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
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

function table(rows: Row[]) {
  const scope = (where: Row = {}): Row => {
    const orgId = h.currentOrg();
    return orgId ? { ...where, orgId } : { ...where };
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
    findUnique: async ({ where, select }: Row) => {
      const row = rows.find((candidate) => candidate.id === where.id);
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
      const orgId = h.currentOrg();
      const row = { id: `row_${rows.length + 1}`, ...data, ...(orgId ? { orgId } : {}) };
      rows.push(row);
      return project(row, select);
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

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Row }> {
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

function install(seed: { runners?: Row[]; environments?: Row[]; jobs?: Row[] }): void {
  h.db = {
    runner: table(seed.runners ?? []),
    environment: table(seed.environments ?? []),
    runnerJob: table(seed.jobs ?? []),
    run: table([]),
    testResult: table([]),
  };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
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
  it('refuses to repoint another org\'s environment, and leaves the row alone', async () => {
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
        { id: 'job_1', orgId: 'org_2', pool: 'secret-pool', status: 'QUEUED', queuedAt: new Date() },
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
