/**
 * Tests for the suites router — the endpoints that make `Suite` reachable at
 * all.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. Every endpoint is TENANT-SCOPED. Each takes ids straight off the URL or
 *      the body, and the router's only defence is that it queries through the
 *      scoped `prisma` client inside the request's tenant scope — which is
 *      invisible at the call site, because there is deliberately no `orgId` in
 *      any `where`. So the fake below applies the scope the way the real
 *      extension does, and every endpoint is driven from two orgs. Swap one
 *      query for `unscoped(...)` and exactly one test here fails.
 *
 *   2. Assignment is ALL OR NOTHING. A drop of forty files that assigns
 *      thirty-nine is worse than one that refuses: the suite then matches
 *      neither what the user dragged nor what they had before. So every
 *      rejection case asserts on the STORED rows, not just on the status code —
 *      the transaction must have rolled back, and a fake that cannot roll back
 *      would let a broken implementation pass, so this one really does.
 *
 *   3. Deleting a suite does not delete its tests, and does not silently delete
 *      automation. Both halves are asserted on the store: the tests are still
 *      there with `suiteId: null`, and a suite with a schedule or a monitor
 *      pointing at it is refused with everything left exactly as it was.
 *
 *   4. The test count on the list costs ONE query. It exists to label a row in
 *      a suite tree; a count per suite would work in every test that only
 *      checked the numbers and take a round trip per row in production. The
 *      fake therefore records every operation, and the count is asserted.
 *
 * Harness: same shape as projects.tree.test.ts — a mocked prisma module with a
 * real AsyncLocalStorage tenant scope, and the real router driven over a
 * loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** Every operation the router issued, as `model.operation`. */
  ops: string[];
  /**
   * Fires immediately before each `updateMany`, so a test can move a row out
   * from under a plan that was validated a moment earlier. That race is the
   * only way to reach the rollback INSIDE the transaction — every other
   * rejection is caught before it opens.
   */
  onWrite: (() => void) | null;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  ops: [],
  onWrite: null,
}));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
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
 * be restored before they ran and every org-isolation test below would pass for
 * a reason that has nothing to do with the router.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, key: string) => (h.prisma as Row)[key],
      },
    ),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

/*
 * Captured rather than discarded. "Every mutation audits" is a property of these
 * endpoints, and an assignment that records a count without recording WHICH
 * tests — and which suite each came out of — is not a record of anything, so the
 * payload is asserted on and not just its existence.
 */
vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
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
 * The filters these routes are allowed to use. Anything else throws rather than
 * being quietly ignored — a fake that shrugs at `disabledAt: null` would pass
 * the test that proves `disabledAt: null` is honoured, and a fake that shrugged
 * at `suiteId` would pass the compare-and-set test without any compare in it.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  project: new Set(['id', 'orgId', 'archivedAt']),
  suite: new Set(['id', 'orgId', 'projectId', 'name']),
  test: new Set(['id', 'orgId', 'projectId', 'suiteId', 'disabledAt']),
  schedule: new Set(['id', 'orgId', 'projectId', 'suiteId']),
  monitor: new Set(['id', 'orgId', 'projectId', 'suiteId']),
  ownershipRule: new Set(['id', 'orgId', 'projectId', 'suiteId']),
};

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
    if ('not' in c) return value !== c.not;
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: string, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause) =>
    Object.entries(clause).map(([key, dir]) => ({ key, dir: String(dir) })),
  );
  return [...rows].sort((a, b) => {
    for (const { key, dir } of keys) {
      const left = a[key] ?? '';
      const right = b[key] ?? '';
      if (left === right) continue;
      const cmp = String(left).localeCompare(String(right));
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

type ModelName = 'project' | 'suite' | 'test' | 'schedule' | 'monitor' | 'ownershipRule';

type Store = Record<ModelName, Row[]>;

const MODELS: ModelName[] = ['project', 'suite', 'test', 'schedule', 'monitor', 'ownershipRule'];

/**
 * A Prisma stand-in that enforces tenancy the way the extension does — merging
 * the ambient orgId into every filterable `where`, post-checking ownership on
 * the unique-selector operations — because that merge IS the security property
 * under test.
 *
 * `$transaction` really rolls back. Without that, an endpoint that wrote its
 * rows one at a time and threw halfway would pass every atomicity test here.
 */
function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const rows = () => store[name];
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      rows().filter((row) => matchesWhere(name, row, scopedWhere(where)));

    /** Same ownership rule the extension applies to `update` and `delete`. */
    const owned = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      const found = rows().find((row) => row.id === where.id);
      if (!found) throw new Error(`fake prisma: no ${name} ${String(where.id)}`);
      if (orgId && found.orgId !== orgId) throw new Error(`fake prisma: no ${name} found`);
      return found;
    };

    return {
      findMany: async ({ where, orderBy, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findMany`);
        return sortRows(select(where), orderBy).map((row) => project(row, sel));
      },

      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findFirst`);
        const found = sortRows(select(where), orderBy)[0];
        return found ? project(found, sel) : null;
      },

      count: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.count`);
        return select(where).length;
      },

      /*
       * A unique lookup cannot carry an extra filter, so — exactly like the real
       * extension — ownership is checked on the result and a row from another
       * org is reported as absent rather than refused.
       */
      findUnique: async ({ where = {}, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findUnique`);
        const orgId = h.currentOrg();
        const found = rows().find((row) => row.id === where.id);
        if (!found) return null;
        if (orgId && found.orgId !== orgId) return null;
        return project(found, sel);
      },

      create: async ({ data = {}, select: sel }: Row = {}) => {
        h.ops.push(`${name}.create`);
        const row = {
          id: `${name}_${rows().length + 1}_${Math.random().toString(36).slice(2, 6)}`,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data,
        };
        rows().push(row);
        return project(row, sel);
      },

      update: async ({ where = {}, data = {}, select: sel }: Row = {}) => {
        h.ops.push(`${name}.update`);
        const found = owned(where);
        Object.assign(found, data, { updatedAt: new Date('2026-02-02T00:00:00.000Z') });
        return project(found, sel);
      },

      delete: async ({ where = {}, select: sel }: Row = {}) => {
        h.ops.push(`${name}.delete`);
        const found = owned(where);
        store[name] = rows().filter((row) => row !== found);
        return project(found, sel);
      },

      updateMany: async ({ where, data = {} }: Row = {}) => {
        h.ops.push(`${name}.updateMany`);
        h.onWrite?.();
        const matched = select(where);
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },

      deleteMany: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.deleteMany`);
        const matched = select(where);
        store[name] = rows().filter((row) => !matched.includes(row));
        return { count: matched.length };
      },

      groupBy: async ({ by, where, _count }: Row = {}) => {
        h.ops.push(`${name}.groupBy`);
        const groups = new Map<string, Row>();
        for (const row of select(where)) {
          const key = (by as string[]).map((field) => String(row[field])).join(' ');
          let group = groups.get(key);
          if (!group) {
            group = {};
            for (const field of by as string[]) group[field] = row[field];
            if (_count) group._count = { _all: 0 };
            groups.set(key, group);
          }
          if (_count) group._count._all += 1;
        }
        return [...groups.values()];
      },
    };
  };

  const db: Row = {};
  for (const name of MODELS) db[name] = model(name);

  db.$transaction = async (arg: unknown) => {
    const snapshot = {} as Store;
    for (const name of MODELS) snapshot[name] = store[name].map((row) => ({ ...row }));
    try {
      return typeof arg === 'function'
        ? await (arg as (tx: Row) => Promise<unknown>)(db)
        : await Promise.all(arg as Promise<unknown>[]);
    } catch (err) {
      // The models close over `store`, so replacing the arrays is enough for
      // every later read — and the mutated objects are unreachable.
      for (const name of MODELS) store[name] = snapshot[name];
      throw err;
    }
  };

  return db;
}

// ─── Seeds ───────────────────────────────────────────────────────────────────

function seedProject(over: Row = {}): Row {
  return { id: 'proj_1', orgId: 'org_1', name: 'shop', archivedAt: null, ...over };
}

function seedSuite(over: Row = {}): Row {
  return {
    id: 'suite_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'Smoke',
    description: null,
    tagFilter: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

function seedTest(over: Row = {}): Row {
  return {
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'a test',
    filePath: 'tests/a.spec.ts',
    suiteId: null,
    disabledAt: null,
    ...over,
  };
}

let store: Store;

function install(seed: Partial<Store> = {}): void {
  store = {
    project: seed.project ?? [seedProject()],
    suite: seed.suite ?? [],
    test: seed.test ?? [],
    schedule: seed.schedule ?? [],
    monitor: seed.monitor ?? [],
    ownershipRule: seed.ownershipRule ?? [],
  };
  h.prisma = makeDb(store);
}

/** The stored assignment, for asserting that a rejected batch changed nothing. */
function assignments(): Array<[string, string | null]> {
  return store.test.map((row) => [row.id, (row.suiteId ?? null) as string | null]);
}

const suiteIds = (): string[] => store.suite.map((row) => row.id);

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { suitesRouter } = await import('./suites.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
// Mounted at the root, the way index.ts mounts it: the router declares its own
// full `/projects/:projectId/suites` paths.
app.use('/', suitesRouter);
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
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const asOrg = (orgId: string, role = 'MEMBER'): void => {
  h.actor = { userId: `user_of_${orgId}`, orgId, role, ip: null };
};

beforeEach(() => {
  asOrg('org_1');
  h.audits.length = 0;
  h.ops.length = 0;
  h.onWrite = null;
  install();
});

/** Runs `fn` before the next write only, then disarms itself. */
function onceBeforeNextWrite(fn: () => void): void {
  let fired = false;
  h.onWrite = () => {
    if (fired) return;
    fired = true;
    fn();
  };
}

// ─── The list ────────────────────────────────────────────────────────────────

describe('GET /projects/:projectId/suites', () => {
  it('lists a project’s suites with the number of live tests in each', async () => {
    install({
      suite: [
        seedSuite({ id: 'suite_a', name: 'Smoke' }),
        seedSuite({ id: 'suite_b', name: 'Checkout' }),
        seedSuite({ id: 'suite_c', name: 'Empty' }),
      ],
      test: [
        seedTest({ id: 't1', suiteId: 'suite_a' }),
        seedTest({ id: 't2', suiteId: 'suite_a' }),
        seedTest({ id: 't3', suiteId: 'suite_b' }),
        seedTest({ id: 't4', suiteId: null }),
      ],
    });

    const res = await call('GET', '/projects/proj_1/suites');
    expect(res.status).toBe(200);
    // Ordered by name, so the panel does not have to re-sort what it is given.
    expect(res.body.suites.map((suite: Row) => [suite.name, suite.testCount])).toEqual([
      ['Checkout', 1],
      ['Empty', 0],
      ['Smoke', 2],
    ]);
  });

  it('does not count a soft-deleted test — it is not going to run', async () => {
    install({
      suite: [seedSuite({ id: 'suite_a' })],
      test: [
        seedTest({ id: 't1', suiteId: 'suite_a' }),
        seedTest({ id: 't2', suiteId: 'suite_a', disabledAt: new Date('2026-01-02') }),
      ],
    });

    const res = await call('GET', '/projects/proj_1/suites');
    expect(res.body.suites[0].testCount).toBe(1);
  });

  it('counts every suite in ONE query, not one query per suite', async () => {
    install({
      suite: Array.from({ length: 12 }, (_, at) =>
        seedSuite({ id: `suite_${at}`, name: `Suite ${at}` }),
      ),
      test: Array.from({ length: 12 }, (_, at) => seedTest({ id: `t${at}`, suiteId: `suite_${at}` })),
    });

    await call('GET', '/projects/proj_1/suites');
    // One read for the suites, one groupBy for the counts, plus the project
    // lookup. An implementation that counted per suite would push twelve more.
    expect(h.ops.filter((op) => op.startsWith('test.'))).toEqual(['test.groupBy']);
  });

  it('shows another org nothing, even for a project id it somehow knows', async () => {
    install({
      project: [seedProject(), seedProject({ id: 'proj_2', orgId: 'org_2' })],
      suite: [seedSuite({ id: 'suite_a' })],
    });

    asOrg('org_2');
    const res = await call('GET', '/projects/proj_1/suites');
    // The project is invisible, so this is the same 404 as an id that never was.
    expect(res.status).toBe(404);
  });

  it('does not leak suites from a sibling project', async () => {
    install({
      project: [seedProject(), seedProject({ id: 'proj_2' })],
      suite: [
        seedSuite({ id: 'suite_a', projectId: 'proj_1', name: 'Mine' }),
        seedSuite({ id: 'suite_b', projectId: 'proj_2', name: 'Theirs' }),
      ],
    });

    const res = await call('GET', '/projects/proj_1/suites');
    expect(res.body.suites.map((suite: Row) => suite.name)).toEqual(['Mine']);
  });
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe('POST /projects/:projectId/suites', () => {
  it('creates one and audits what was made', async () => {
    const res = await call('POST', '/projects/proj_1/suites', {
      name: 'Checkout smoke',
      description: 'The paths that must never break',
    });

    expect(res.status).toBe(201);
    expect(res.body.suite).toMatchObject({
      name: 'Checkout smoke',
      description: 'The paths that must never break',
      testCount: 0,
    });
    expect(store.suite).toHaveLength(1);
    expect(store.suite[0]).toMatchObject({ orgId: 'org_1', projectId: 'proj_1' });
    expect(h.audits[0]).toMatchObject({
      action: 'suite.create',
      targetType: 'Suite',
      metadata: { name: 'Checkout smoke' },
    });
  });

  it('refuses a duplicate name and writes nothing', async () => {
    install({ suite: [seedSuite({ name: 'Smoke' })] });

    const res = await call('POST', '/projects/proj_1/suites', { name: 'Smoke' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already exists');
    expect(store.suite).toHaveLength(1);
  });

  it('lets a sibling project have a suite of the same name', async () => {
    install({
      project: [seedProject(), seedProject({ id: 'proj_2' })],
      suite: [seedSuite({ id: 'suite_a', projectId: 'proj_2', name: 'Smoke' })],
    });

    const res = await call('POST', '/projects/proj_1/suites', { name: 'Smoke' });
    expect(res.status).toBe(201);
    expect(store.suite).toHaveLength(2);
  });

  it('refuses a nameless suite', async () => {
    const res = await call('POST', '/projects/proj_1/suites', { name: '   ' });
    expect(res.status).toBe(400);
    expect(store.suite).toHaveLength(0);
  });

  it('caps how many suites one project may hold', async () => {
    install({
      suite: Array.from({ length: 200 }, (_, at) =>
        seedSuite({ id: `suite_${at}`, name: `Suite ${at}` }),
      ),
    });

    const res = await call('POST', '/projects/proj_1/suites', { name: 'One more' });
    expect(res.status).toBe(409);
    expect(store.suite).toHaveLength(200);
  });

  it('cannot create a suite inside another org’s project', async () => {
    install({ project: [seedProject({ id: 'proj_1', orgId: 'org_1' })] });

    asOrg('org_2');
    const res = await call('POST', '/projects/proj_1/suites', { name: 'Theirs' });
    expect(res.status).toBe(404);
    expect(store.suite).toHaveLength(0);
  });

  it('is refused for a VIEWER', async () => {
    asOrg('org_1', 'VIEWER');
    const res = await call('POST', '/projects/proj_1/suites', { name: 'Nope' });
    expect(res.status).toBe(403);
    expect(store.suite).toHaveLength(0);
  });
});

// ─── Rename and edit ─────────────────────────────────────────────────────────

describe('PATCH /projects/:projectId/suites/:suiteId', () => {
  it('renames, and records the name it had before', async () => {
    install({ suite: [seedSuite({ name: 'Smoke' })] });

    const res = await call('PATCH', '/projects/proj_1/suites/suite_1', { name: 'Smoke — EU' });
    expect(res.status).toBe(200);
    expect(store.suite[0]!.name).toBe('Smoke — EU');
    expect(h.audits[0]).toMatchObject({
      action: 'suite.update',
      metadata: { before: { name: 'Smoke' }, after: { name: 'Smoke — EU' } },
    });
  });

  it('clears a description when asked with null, which is not the same as omitting it', async () => {
    install({ suite: [seedSuite({ description: 'old' })] });

    await call('PATCH', '/projects/proj_1/suites/suite_1', { description: null });
    expect(store.suite[0]!.description).toBeNull();
  });

  it('refuses an empty body rather than writing a row that changes nothing', async () => {
    install({ suite: [seedSuite()] });

    const res = await call('PATCH', '/projects/proj_1/suites/suite_1', {});
    expect(res.status).toBe(400);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a name another suite in the project already has', async () => {
    install({
      suite: [seedSuite({ id: 'suite_1', name: 'Smoke' }), seedSuite({ id: 'suite_2', name: 'Checkout' })],
    });

    const res = await call('PATCH', '/projects/proj_1/suites/suite_1', { name: 'Checkout' });
    expect(res.status).toBe(409);
    expect(store.suite[0]!.name).toBe('Smoke');
  });

  it('lets a suite keep its own name — renaming to what it already is is not a clash', async () => {
    install({ suite: [seedSuite({ name: 'Smoke' })] });

    const res = await call('PATCH', '/projects/proj_1/suites/suite_1', {
      name: 'Smoke',
      description: 'now with words',
    });
    expect(res.status).toBe(200);
    expect(store.suite[0]!.description).toBe('now with words');
  });

  it('cannot rename another org’s suite', async () => {
    install({
      project: [seedProject(), seedProject({ id: 'proj_2', orgId: 'org_2' })],
      suite: [seedSuite({ id: 'suite_1', orgId: 'org_2', projectId: 'proj_2', name: 'Theirs' })],
    });

    asOrg('org_2');
    // Same suite, addressed through the OTHER org's project: the router's
    // projectId check is what refuses this one.
    const wrongProject = await call('PATCH', '/projects/proj_1/suites/suite_1', { name: 'x' });
    expect(wrongProject.status).toBe(404);

    asOrg('org_1');
    const wrongOrg = await call('PATCH', '/projects/proj_2/suites/suite_1', { name: 'x' });
    expect(wrongOrg.status).toBe(404);
    expect(store.suite[0]!.name).toBe('Theirs');
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /projects/:projectId/suites/:suiteId', () => {
  it('deletes the suite and UNASSIGNS its tests rather than deleting them', async () => {
    install({
      suite: [seedSuite()],
      test: [
        seedTest({ id: 't1', suiteId: 'suite_1' }),
        seedTest({ id: 't2', suiteId: 'suite_1' }),
        seedTest({ id: 't3', suiteId: null }),
      ],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, testsUnassigned: 2 });
    expect(store.suite).toHaveLength(0);
    // The files are still there. Deleting a suite is not deleting tests.
    expect(store.test).toHaveLength(3);
    expect(assignments()).toEqual([
      ['t1', null],
      ['t2', null],
      ['t3', null],
    ]);
    expect(h.audits[0]).toMatchObject({
      action: 'suite.delete',
      metadata: { name: 'Smoke', testsUnassigned: 2 },
    });
  });

  it('refuses while a schedule runs it, and changes nothing at all', async () => {
    install({
      suite: [seedSuite()],
      test: [seedTest({ id: 't1', suiteId: 'suite_1' })],
      schedule: [
        { id: 'sch_1', orgId: 'org_1', projectId: 'proj_1', suiteId: 'suite_1', name: 'Nightly' },
      ],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Nightly');
    expect(suiteIds()).toEqual(['suite_1']);
    // The tests keep their suite: a refusal that half-applied would be worse
    // than the cascade this refusal exists to prevent.
    expect(assignments()).toEqual([['t1', 'suite_1']]);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses while a monitor runs it', async () => {
    install({
      suite: [seedSuite()],
      monitor: [
        { id: 'mon_1', orgId: 'org_1', projectId: 'proj_1', suiteId: 'suite_1', name: 'Prod smoke' },
      ],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Prod smoke');
    expect(suiteIds()).toEqual(['suite_1']);
  });

  it('ignores a schedule that points at a DIFFERENT suite', async () => {
    install({
      suite: [seedSuite({ id: 'suite_1' }), seedSuite({ id: 'suite_2', name: 'Other' })],
      schedule: [
        { id: 'sch_1', orgId: 'org_1', projectId: 'proj_1', suiteId: 'suite_2', name: 'Nightly' },
      ],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(200);
    expect(suiteIds()).toEqual(['suite_2']);
  });

  it('removes the ownership rules that pointed at it, and names them in the audit', async () => {
    install({
      suite: [seedSuite()],
      ownershipRule: [
        {
          id: 'rule_1',
          orgId: 'org_1',
          projectId: 'proj_1',
          suiteId: 'suite_1',
          ownerUserId: 'user_9',
          ownerTeamId: null,
        },
        {
          id: 'rule_2',
          orgId: 'org_1',
          projectId: 'proj_1',
          suiteId: null,
          ownerUserId: 'user_8',
          ownerTeamId: null,
        },
      ],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(200);
    expect(res.body.ownershipRulesDeleted).toBe(1);
    expect(store.ownershipRule.map((rule) => rule.id)).toEqual(['rule_2']);
    expect(h.audits[0]!.metadata.ownershipRulesDeleted).toEqual([
      { id: 'rule_1', ownerUserId: 'user_9', ownerTeamId: null },
    ]);
  });

  it('cannot delete another org’s suite', async () => {
    install({
      project: [seedProject({ id: 'proj_1', orgId: 'org_2' })],
      suite: [seedSuite({ orgId: 'org_2' })],
      test: [seedTest({ id: 't1', orgId: 'org_2', suiteId: 'suite_1' })],
    });

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(404);
    expect(suiteIds()).toEqual(['suite_1']);
    expect(assignments()).toEqual([['t1', 'suite_1']]);
  });

  it('is refused for a VIEWER', async () => {
    install({ suite: [seedSuite()] });
    asOrg('org_1', 'VIEWER');

    const res = await call('DELETE', '/projects/proj_1/suites/suite_1');
    expect(res.status).toBe(403);
    expect(suiteIds()).toEqual(['suite_1']);
  });
});

// ─── Assign ──────────────────────────────────────────────────────────────────

describe('POST /projects/:projectId/suites/:suiteId/tests/assign', () => {
  const threeTests = () => [
    seedTest({ id: 't1', filePath: 'tests/a.spec.ts' }),
    seedTest({ id: 't2', filePath: 'tests/b.spec.ts' }),
    seedTest({ id: 't3', filePath: 'tests/c.spec.ts' }),
  ];

  it('assigns a batch in one go and records where each test came from', async () => {
    install({
      suite: [seedSuite({ id: 'suite_1', name: 'Smoke' }), seedSuite({ id: 'suite_2', name: 'Old' })],
      test: [
        seedTest({ id: 't1', suiteId: null }),
        seedTest({ id: 't2', suiteId: 'suite_2', filePath: 'tests/b.spec.ts' }),
      ],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 't2'],
    });

    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(2);
    expect(assignments()).toEqual([
      ['t1', 'suite_1'],
      ['t2', 'suite_1'],
    ]);
    // Where each one came from is the difference between an audit trail that can
    // answer "who took the payment tests out of the smoke suite" and one that
    // cannot.
    expect(h.audits[0]).toMatchObject({
      action: 'suite.assign-tests',
      targetId: 'suite_1',
      metadata: {
        tests: 2,
        assigned: [
          { id: 't1', from: null },
          { id: 't2', from: 'suite_2' },
        ],
      },
    });
  });

  it('treats a repeated id as one instruction rather than refusing the batch', async () => {
    install({ suite: [seedSuite()], test: [seedTest({ id: 't1' })] });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 't1'],
    });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(1);
    expect(assignments()).toEqual([['t1', 'suite_1']]);
  });

  it('assigns NOTHING when one id in the batch does not exist', async () => {
    install({ suite: [seedSuite()], test: threeTests() });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 'nope', 't3'],
    });
    expect(res.status).toBe(404);
    expect(assignments()).toEqual([
      ['t1', null],
      ['t2', null],
      ['t3', null],
    ]);
    expect(h.audits).toHaveLength(0);
  });

  it('assigns NOTHING when one id belongs to another org', async () => {
    install({
      project: [seedProject(), seedProject({ id: 'proj_2', orgId: 'org_2' })],
      suite: [seedSuite()],
      test: [
        seedTest({ id: 't1' }),
        seedTest({ id: 'theirs', orgId: 'org_2', projectId: 'proj_2', suiteId: null }),
      ],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 'theirs'],
    });
    // Indistinguishable from an id that never existed, and the legitimate half
    // of the batch is not applied either.
    expect(res.status).toBe(404);
    expect(assignments()).toEqual([
      ['t1', null],
      ['theirs', null],
    ]);
  });

  it('cannot assign into another org’s suite', async () => {
    install({
      project: [seedProject({ id: 'proj_1', orgId: 'org_2' })],
      suite: [seedSuite({ orgId: 'org_2' })],
      test: [seedTest({ id: 't1', orgId: 'org_2' })],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1'],
    });
    expect(res.status).toBe(404);
    expect(assignments()).toEqual([['t1', null]]);
  });

  it('refuses a test that is already in this suite, and applies none of the batch', async () => {
    install({
      suite: [seedSuite()],
      test: [seedTest({ id: 't1', suiteId: null }), seedTest({ id: 't2', suiteId: 'suite_1' })],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 't2'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already in');
    expect(assignments()).toEqual([
      ['t1', null],
      ['t2', 'suite_1'],
    ]);
  });

  it('refuses a deleted test rather than putting a file nobody can run in a suite', async () => {
    install({
      suite: [seedSuite()],
      test: [seedTest({ id: 't1' }), seedTest({ id: 't2', disabledAt: new Date('2026-01-02') })],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 't2'],
    });
    expect(res.status).toBe(409);
    expect(assignments()).toEqual([
      ['t1', null],
      ['t2', null],
    ]);
  });

  it('refuses a batch past the cap without writing any of it', async () => {
    install({
      suite: [seedSuite()],
      test: Array.from({ length: 201 }, (_, at) => seedTest({ id: `t${at}` })),
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: Array.from({ length: 201 }, (_, at) => `t${at}`),
    });
    expect(res.status).toBe(400);
    expect(store.test.every((row) => row.suiteId === null)).toBe(true);
  });

  it('refuses an empty batch', async () => {
    install({ suite: [seedSuite()] });
    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', { testIds: [] });
    expect(res.status).toBe(400);
  });

  it('rolls the whole batch back when a test changes suite mid-write', async () => {
    install({
      suite: [seedSuite({ id: 'suite_1' }), seedSuite({ id: 'suite_2', name: 'Other' })],
      test: [seedTest({ id: 't1' }), seedTest({ id: 't2' }), seedTest({ id: 't3' })],
    });

    /*
     * The plan was validated against three unassigned tests. Between that and
     * the write, someone else puts t3 into another suite — so the compare-and-set
     * on t3 matches nothing, and the two writes that already landed have to be
     * rolled back. Without the compare in the `where`, this test passes with two
     * tests silently moved.
     */
    onceBeforeNextWrite(() => {
      const t3 = store.test.find((row) => row.id === 't3');
      if (t3) t3.suiteId = 'suite_2';
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1', 't2', 't3'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('changed suite');
    /*
     * t1 and t2 had already been written when t3 failed, and they are back where
     * they started — that rollback is the property under test. t3 is not
     * asserted on: the interfering write lands inside this fake's transaction
     * window, so the rollback restores it too, which a real database would not
     * do to another transaction's row. Asserting it either way would be
     * asserting the fake.
     */
    expect(assignments().slice(0, 2)).toEqual([
      ['t1', null],
      ['t2', null],
    ]);
    expect(h.audits).toHaveLength(0);
  });

  it('is refused for a VIEWER', async () => {
    install({ suite: [seedSuite()], test: [seedTest({ id: 't1' })] });
    asOrg('org_1', 'VIEWER');

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/assign', {
      testIds: ['t1'],
    });
    expect(res.status).toBe(403);
    expect(assignments()).toEqual([['t1', null]]);
  });
});

// ─── Unassign ────────────────────────────────────────────────────────────────

describe('POST /projects/:projectId/suites/:suiteId/tests/unassign', () => {
  it('takes tests out of the suite without touching the tests themselves', async () => {
    install({
      suite: [seedSuite()],
      test: [
        seedTest({ id: 't1', suiteId: 'suite_1' }),
        seedTest({ id: 't2', suiteId: 'suite_1' }),
      ],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/unassign', {
      testIds: ['t1'],
    });
    expect(res.status).toBe(200);
    expect(res.body.unassigned).toBe(1);
    expect(store.test).toHaveLength(2);
    expect(assignments()).toEqual([
      ['t1', null],
      ['t2', 'suite_1'],
    ]);
    expect(h.audits[0]).toMatchObject({ action: 'suite.unassign-tests', targetId: 'suite_1' });
  });

  it('refuses a test that is in a DIFFERENT suite, and changes nothing', async () => {
    install({
      suite: [seedSuite({ id: 'suite_1' }), seedSuite({ id: 'suite_2', name: 'Other' })],
      test: [
        seedTest({ id: 't1', suiteId: 'suite_1' }),
        seedTest({ id: 't2', suiteId: 'suite_2' }),
      ],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/unassign', {
      testIds: ['t1', 't2'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('is not in');
    expect(assignments()).toEqual([
      ['t1', 'suite_1'],
      ['t2', 'suite_2'],
    ]);
  });

  it('refuses a test that is in no suite at all', async () => {
    install({ suite: [seedSuite()], test: [seedTest({ id: 't1', suiteId: null })] });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/unassign', {
      testIds: ['t1'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('is not in a suite');
  });

  it('cannot empty another org’s suite', async () => {
    install({
      project: [seedProject({ id: 'proj_1', orgId: 'org_2' })],
      suite: [seedSuite({ orgId: 'org_2' })],
      test: [seedTest({ id: 't1', orgId: 'org_2', suiteId: 'suite_1' })],
    });

    const res = await call('POST', '/projects/proj_1/suites/suite_1/tests/unassign', {
      testIds: ['t1'],
    });
    expect(res.status).toBe(404);
    expect(assignments()).toEqual([['t1', 'suite_1']]);
  });
});

describe('an archived project is not writable through its suites', () => {
  /*
   * Every mutating route guarded the SUITE's parentage; only list and create
   * guarded the project. So a project taken out of service stayed fully
   * writable through its suites — renames, deletes and assignments all landing,
   * every one audited as live work on something the rest of the product treats
   * as gone.
   */
  it.each([
    ['PATCH', '/projects/proj_1/suites/suite_1', { name: 'Renamed' } as unknown],
    ['DELETE', '/projects/proj_1/suites/suite_1', undefined],
    ['POST', '/projects/proj_1/suites/suite_1/tests/assign', { testIds: ['test_1'] }],
    ['POST', '/projects/proj_1/suites/suite_1/tests/unassign', { testIds: ['test_1'] }],
  ])('%s %s is a 404 once the project is archived', async (method, path, body) => {
    install({
      project: [seedProject({ archivedAt: new Date('2026-02-01T00:00:00.000Z') })],
      suite: [seedSuite()],
      test: [seedTest()],
    });

    const { status } = await call(method, path, body);

    expect(status).toBe(404);
    // And nothing was written on the way to the refusal.
    expect(h.audits).toHaveLength(0);
  });
});
