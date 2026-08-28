/**
 * Tests for the four endpoints the editor's file tree needs from the project
 * router: the last-result column on the tests list, batch move, batch delete,
 * and the folder scope on search.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. Every one of them is TENANT-SCOPED. Each takes ids straight off the URL
 *      or the body, and the router's only defence is that it queries through
 *      the scoped `prisma` client inside the request's tenant scope — which is
 *      invisible at the call site, because there is deliberately no `orgId` in
 *      any `where`. So the fake below applies the scope the way the real
 *      extension does, and every endpoint is driven from two orgs. Swap one
 *      query for `unscoped(...)` and exactly one test here fails; nothing else
 *      in the repo would notice.
 *
 *   2. The batch operations are ALL OR NOTHING. A batch that half-applies is
 *      worse than one that refuses: the tree then matches neither what the user
 *      dragged nor what they had before. So every rejection case asserts on the
 *      stored rows, not just on the status code — the transaction must have
 *      rolled back, and a fake that cannot roll back would let a broken
 *      implementation pass, so this one does.
 *
 *   3. The last-result column costs ONE query. It exists to colour a row in a
 *      thousand-file tree; a `findFirst` per row would work in every test that
 *      only checked the values and take a thousand round trips in production.
 *      The fake therefore offers no per-row read on TestResult at all — an N+1
 *      implementation throws rather than passing slowly.
 *
 *   4. The search scope is not a pattern. `tests/.*` and `%` are folder names
 *      that do not exist, not wildcards, for the same reason the query itself
 *      is matched with `indexOf`: nothing a caller types becomes something a
 *      regex engine or a LIKE has to interpret.
 *
 * Harness: same shape as projects.search.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
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
   * Fires immediately before each `updateMany`, so a test can change a row out
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
    // hashToken() is an HMAC keyed on this; without it every token
    // digest throws. A fixed value keeps the digests stable across runs.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
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
 * endpoints, and a batch that records a count without recording WHICH files is
 * not a record of anything — so the audit payload is asserted on, not just its
 * existence.
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
 * The filters these routes are allowed to use. Anything else throws rather than
 * being quietly ignored — a fake that shrugs at `disabledAt: null` would pass
 * the test that proves `disabledAt: null` is honoured.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  test: new Set(['id', 'orgId', 'projectId', 'filePath', 'disabledAt']),
  testResult: new Set(['id', 'orgId', 'testId', 'status', 'createdAt']),
};

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
    if ('not' in c) return value !== c.not;
    if ('startsWith' in c) {
      // Deliberately a literal `String.startsWith`, never a RegExp and never a
      // LIKE: this is the assertion that a scope of `%` or `.*` selects the
      // files whose path literally begins with those characters, which is none.
      return typeof value === 'string' && value.startsWith(String(c.startsWith));
    }
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

interface Store {
  test: Row[];
  testResult: Row[];
}

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
  const model = (name: keyof Store): Row => {
    const rows = () => store[name];
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      rows().filter((row) => matchesWhere(name, row, scopedWhere(where)));

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

      update: async ({ where = {}, data = {}, select: sel }: Row = {}) => {
        h.ops.push(`${name}.update`);
        const orgId = h.currentOrg();
        const found = rows().find((row) => row.id === where.id);
        if (!found) throw new Error(`fake prisma: no ${name} ${String(where.id)}`);
        if (orgId && found.orgId !== orgId) throw new Error(`fake prisma: no ${name} found`);
        Object.assign(found, data);
        return project(found, sel);
      },

      updateMany: async ({ where, data = {} }: Row = {}) => {
        h.ops.push(`${name}.updateMany`);
        h.onWrite?.();
        const matched = select(where);
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },

      groupBy: async ({ by, where, _max }: Row = {}) => {
        h.ops.push(`${name}.groupBy`);
        const groups = new Map<string, Row>();
        for (const row of select(where)) {
          const key = (by as string[]).map((field) => String(row[field])).join(' ');
          let group = groups.get(key);
          if (!group) {
            group = {};
            for (const field of by as string[]) group[field] = row[field];
            if (_max) group._max = {};
            groups.set(key, group);
          }
          for (const field of Object.keys((_max ?? {}) as Row)) {
            const value = row[field];
            if (group._max[field] === undefined || value > group._max[field]) {
              group._max[field] = value;
            }
          }
        }
        return [...groups.values()];
      },
    };
  };

  const db: Row = { test: model('test'), testResult: model('testResult') };

  db.$transaction = async (arg: unknown) => {
    const snapshot: Store = {
      test: store.test.map((row) => ({ ...row })),
      testResult: store.testResult.map((row) => ({ ...row })),
    };
    try {
      return typeof arg === 'function'
        ? await (arg as (tx: Row) => Promise<unknown>)(db)
        : await Promise.all(arg as Promise<unknown>[]);
    } catch (err) {
      store.test = snapshot.test;
      store.testResult = snapshot.testResult;
      // The models close over `store`, so replacing the arrays is enough for
      // every later read — and the mutated objects are unreachable.
      throw err;
    }
  };

  return db;
}

/** A test row in the shape the routes select. Defaults are the common case. */
function seedTest(over: Row = {}): Row {
  return {
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'a test',
    type: 'E2E',
    feature: null,
    priority: 'IMPORTANT',
    filePath: 'tests/a.spec.ts',
    tags: [],
    quarantined: false,
    flakeRate: 0,
    lastRunAt: null,
    reviewFlags: [],
    suiteId: null,
    code: 'await page.goto("/");',
    spec: null,
    disabledAt: null,
    ...over,
  };
}

function seedResult(over: Row = {}): Row {
  return {
    id: `res_${Math.random().toString(36).slice(2)}`,
    orgId: 'org_1',
    testId: 'test_1',
    status: 'PASSED',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

let store: Store = { test: [], testResult: [] };

function install(tests: Row[] = [], results: Row[] = []): void {
  store = { test: tests, testResult: results };
  h.prisma = makeDb(store);
}

/** The stored rows, for asserting that a rejected batch changed nothing. */
function paths(): Array<[string, string]> {
  return store.test.map((row) => [row.id, row.filePath]);
}

function deletedIds(): string[] {
  return store.test.filter((row) => row.disabledAt).map((row) => row.id);
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { projectsRouter } = await import('./projects.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);
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

// ─── (a) The last result on the tests list ───────────────────────────────────

describe('GET /:projectId/tests — lastStatus', () => {
  /**
   * Deliberately out of chronological order in the array, and with more than
   * one result per test, so an implementation that took the first row it saw or
   * trusted insertion order fails.
   */
  const results = [
    seedResult({ testId: 'test_a', status: 'PASSED', createdAt: new Date('2026-03-01') }),
    seedResult({ testId: 'test_b', status: 'PASSED', createdAt: new Date('2026-05-01') }),
    seedResult({ testId: 'test_a', status: 'FAILED', createdAt: new Date('2026-04-01') }),
    seedResult({ testId: 'test_b', status: 'FAILED', createdAt: new Date('2026-02-01') }),
    seedResult({ testId: 'test_a', status: 'FLAKY', createdAt: new Date('2026-01-01') }),
    seedResult({ testId: 'test_c', status: 'TIMED_OUT', createdAt: new Date('2026-06-01') }),
  ];

  const tests = [
    seedTest({ id: 'test_a', name: 'a', filePath: 'tests/a.spec.ts' }),
    seedTest({ id: 'test_b', name: 'b', filePath: 'tests/b.spec.ts' }),
    seedTest({ id: 'test_c', name: 'c', filePath: 'tests/c.spec.ts' }),
    seedTest({ id: 'test_d', name: 'd', filePath: 'tests/d.spec.ts' }),
  ];

  it('reports the newest result per test, and null for a test that never ran', async () => {
    install(tests, results);

    const { status, body } = await call('GET', '/projects/proj_1/tests');
    expect(status).toBe(200);

    expect(Object.fromEntries((body.tests as Row[]).map((t) => [t.id, t.lastStatus]))).toEqual({
      test_a: 'FAILED', // 2026-04, not the older PASSED or the oldest FLAKY
      test_b: 'PASSED', // 2026-05, not the older FAILED
      test_c: 'TIMED_OUT',
      test_d: null, // never ran — a real state, distinct from SKIPPED
    });
  });

  it('asks once for the whole list rather than once per test', async () => {
    install(tests, results);
    await call('GET', '/projects/proj_1/tests');

    // One grouped read for four tests. The count is the assertion: with a
    // `findFirst` per row this is four, and with more tests it is worse.
    expect(h.ops.filter((op) => op.startsWith('testResult.'))).toEqual(['testResult.groupBy']);
  });

  it('asks nothing at all when the project has no tests', async () => {
    install([], results);
    const { body } = await call('GET', '/projects/proj_1/tests');
    expect(body.tests).toEqual([]);
    // `testId: { in: [] }` is a round trip that reads the table to return
    // nothing, and a brand-new project is the common case.
    expect(h.ops.filter((op) => op.startsWith('testResult.'))).toEqual([]);
  });

  it('sends a status string, not the result row', async () => {
    install([seedTest({ id: 'test_a' })], [seedResult({ testId: 'test_a', status: 'FAILED' })]);
    const { body } = await call('GET', '/projects/proj_1/tests');
    const [test] = body.tests as Row[];
    expect(test!.lastStatus).toBe('FAILED');
    // Nothing of the result row itself: no error text, no trace key, no id.
    expect(Object.keys(test!)).not.toContain('lastResult');
    expect(JSON.stringify(body)).not.toContain('res_');
  });

  it('breaks a tie the same way every time, worst status first', async () => {
    const sameInstant = new Date('2026-07-01T12:00:00.000Z');
    install(
      [seedTest({ id: 'test_a' })],
      [
        seedResult({ testId: 'test_a', status: 'PASSED', createdAt: sameInstant }),
        seedResult({ testId: 'test_a', status: 'FAILED', createdAt: sameInstant }),
      ],
    );

    // Twice, because "deterministic" is the claim — a Map iteration order that
    // happened to favour PASSED once would be a rendering that changes on reload.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { body } = await call('GET', '/projects/proj_1/tests');
      expect((body.tests as Row[])[0]!.lastStatus).toBe('FAILED');
    }
  });

  it('never reads another org’s tests or another org’s results', async () => {
    install(
      [
        seedTest({ id: 'test_ours', orgId: 'org_1', filePath: 'tests/ours.spec.ts' }),
        // Same projectId — the attack is a leaked project id, not a leaked org.
        seedTest({ id: 'test_theirs', orgId: 'org_2', filePath: 'tests/theirs.spec.ts' }),
      ],
      [
        seedResult({ orgId: 'org_1', testId: 'test_ours', status: 'PASSED' }),
        seedResult({ orgId: 'org_2', testId: 'test_theirs', status: 'FAILED' }),
        /*
         * A result row for OUR test carrying ANOTHER org's id. Contrived as
         * data, but it is precisely the row that distinguishes a scoped groupBy
         * from an unscoped one: wrap the aggregate in `unscoped(...)` and this
         * newer FAILED becomes our test's colour.
         */
        seedResult({
          orgId: 'org_2',
          testId: 'test_ours',
          status: 'FAILED',
          createdAt: new Date('2030-01-01'),
        }),
      ],
    );

    const mine = await call('GET', '/projects/proj_1/tests');
    expect((mine.body.tests as Row[]).map((t) => [t.id, t.lastStatus])).toEqual([
      ['test_ours', 'PASSED'],
    ]);

    asOrg('org_2');
    const theirs = await call('GET', '/projects/proj_1/tests');
    expect((theirs.body.tests as Row[]).map((t) => [t.id, t.lastStatus])).toEqual([
      ['test_theirs', 'FAILED'],
    ]);
  });
});

// ─── (c) Search scoped to a folder ───────────────────────────────────────────

describe('GET /:projectId/search — the path scope', () => {
  const files = [
    seedTest({ id: 't_login', filePath: 'tests/auth/login.spec.ts', code: 'await needle();' }),
    seedTest({ id: 't_logout', filePath: 'tests/auth/logout.spec.ts', code: 'await needle();' }),
    // The trap: a sibling folder whose name starts with the scope's name. A raw
    // prefix match on the string, with no folder boundary, would include it.
    seedTest({ id: 't_rbac', filePath: 'tests/authz/rbac.spec.ts', code: 'await needle();' }),
    seedTest({ id: 't_cart', filePath: 'tests/cart.spec.ts', code: 'await needle();' }),
    // A file whose whole path IS the scope, for the "search this one file" case.
    seedTest({ id: 't_bare', filePath: 'tests/auth', code: 'await needle();' }),
  ];

  async function search(q: string, path?: string): Promise<{ status: number; body: Row }> {
    const params = new URLSearchParams({ q });
    if (path !== undefined) params.set('path', path);
    return call('GET', `/projects/proj_1/search?${params.toString()}`);
  }

  const cases: Array<{ name: string; path: string | undefined; expect: string[] }> = [
    { name: 'no scope searches the project', path: undefined, expect: [] },
    { name: 'a folder', path: 'tests/auth', expect: ['t_bare', 't_login', 't_logout'] },
    {
      name: 'a trailing slash is the same folder',
      path: 'tests/auth/',
      expect: ['t_bare', 't_login', 't_logout'],
    },
    {
      name: 'a leading slash is normalised away',
      path: '/tests/auth',
      expect: ['t_bare', 't_login', 't_logout'],
    },
    {
      name: 'backslashes are normalised',
      path: 'tests\\auth',
      expect: ['t_bare', 't_login', 't_logout'],
    },
    {
      name: 'dot segments are normalised',
      path: './tests/./auth',
      expect: ['t_bare', 't_login', 't_logout'],
    },
    { name: 'the sibling folder is its own scope', path: 'tests/authz', expect: ['t_rbac'] },
    {
      name: 'an exact file path scopes to that file',
      path: 'tests/cart.spec.ts',
      expect: ['t_cart'],
    },
    { name: 'a folder with nothing in it finds nothing', path: 'tests/billing', expect: [] },
    // Not patterns. Both are legal folder NAMES that no file lives under.
    { name: 'a regex is a folder name, not a pattern', path: 'tests/.*', expect: [] },
    { name: 'a LIKE wildcard is a folder name, not a wildcard', path: '%', expect: [] },
    { name: 'an underscore is not a single-character wildcard', path: '_ests/auth', expect: [] },
  ];

  it.each(cases)('$name', async ({ path, expect: wanted }) => {
    install(files);
    const { status, body } = await search('needle', path);
    expect(status).toBe(200);

    const found = (body.files as Row[]).map((file) => file.testId).sort();
    if (path === undefined) {
      // The unscoped case: everything, which is the baseline the rest narrow.
      expect(found).toEqual(['t_bare', 't_cart', 't_login', 't_logout', 't_rbac']);
    } else {
      expect(found).toEqual(wanted);
    }
  });

  it('counts only what is in scope', async () => {
    install(files);
    const { body } = await search('needle', 'tests/auth');
    expect(body.totalMatches).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it('echoes the scope it applied, and only when it applied one', async () => {
    install(files);

    expect((await search('needle', 'tests/auth')).body.scope).toBe('tests/auth');
    // Normalised in the echo too, so the panel labels the folder it searched.
    expect((await search('needle', '/tests/auth/')).body.scope).toBe('tests/auth');

    // No scope, and a scope that normalises to the project root, are the same
    // request — and the response keeps exactly the shape it had before `path`
    // existed, because every caller that predates it reads that shape.
    for (const path of [undefined, '', '/', '.', './']) {
      const { body } = await search('needle', path);
      expect(body.scope).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(['files', 'query', 'totalMatches', 'truncated']);
    }
  });

  it('keeps the blank-query short circuit, scoped or not', async () => {
    install(files);

    const bare = await search('   ');
    expect(bare.body).toEqual({ query: '', files: [], totalMatches: 0, truncated: false });

    const scoped = await search('   ', 'tests/auth');
    expect(scoped.body).toEqual({
      query: '',
      scope: 'tests/auth',
      files: [],
      totalMatches: 0,
      truncated: false,
    });

    // Neither one scanned anything.
    expect(h.ops.filter((op) => op.startsWith('test.'))).toEqual([]);
  });

  it('refuses a scope longer than a path can be', async () => {
    install(files);
    const { status, body } = await search('needle', `tests/${'a'.repeat(300)}`);
    expect(status).toBe(400);
    expect(body.error!.code).toBe('BAD_REQUEST');
  });

  it('never returns another org’s file from inside the same folder', async () => {
    install([
      seedTest({
        id: 't_ours',
        orgId: 'org_1',
        filePath: 'tests/auth/ours.spec.ts',
        code: 'needle',
      }),
      seedTest({
        id: 't_theirs',
        orgId: 'org_2',
        filePath: 'tests/auth/theirs.spec.ts',
        code: 'needle',
      }),
    ]);

    const mine = await search('needle', 'tests/auth');
    expect((mine.body.files as Row[]).map((f) => f.testId)).toEqual(['t_ours']);
    expect(JSON.stringify(mine.body)).not.toContain('theirs');

    asOrg('org_3');
    const stranger = await search('needle', 'tests/auth');
    expect(stranger.body.files).toEqual([]);
  });
});

// ─── (b) Batch move ──────────────────────────────────────────────────────────

const MOVE_URL = '/projects/proj_1/tests/batch/move';
const DELETE_URL = '/projects/proj_1/tests/batch/delete';

/** Three ordinary files in one folder — the thing a multi-select drags. */
function threeFiles(): Row[] {
  return [
    seedTest({ id: 't1', name: 'one', filePath: 'tests/one.spec.ts' }),
    seedTest({ id: 't2', name: 'two', filePath: 'tests/two.spec.ts' }),
    seedTest({ id: 't3', name: 'three', filePath: 'tests/three.spec.ts' }),
  ];
}

describe('POST /:projectId/tests/batch/move', () => {
  it('moves every file in one go and audits which ones', async () => {
    install(threeFiles());

    const { status, body } = await call('POST', MOVE_URL, {
      moves: [
        { testId: 't1', filePath: 'suites/smoke/one.spec.ts' },
        { testId: 't2', filePath: 'suites/smoke/two.spec.ts' },
        { testId: 't3', filePath: 'suites/smoke/three.spec.ts' },
      ],
    });

    expect(status).toBe(200);
    expect(body.moved).toBe(3);
    expect(paths()).toEqual([
      ['t1', 'suites/smoke/one.spec.ts'],
      ['t2', 'suites/smoke/two.spec.ts'],
      ['t3', 'suites/smoke/three.spec.ts'],
    ]);

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'tests.batch-move',
      targetType: 'Project',
      targetId: 'proj_1',
      metadata: {
        files: 3,
        moves: [
          { from: 'tests/one.spec.ts', to: 'suites/smoke/one.spec.ts' },
          { from: 'tests/two.spec.ts', to: 'suites/smoke/two.spec.ts' },
          { from: 'tests/three.spec.ts', to: 'suites/smoke/three.spec.ts' },
        ],
      },
    });
  });

  it('normalises destinations and renames when asked', async () => {
    install(threeFiles());
    // Backslashes and `.` segments are normalised. A LEADING slash is not — the
    // shared `relativeFilePath` refuses it outright, and this route parses
    // through that same schema rather than a looser one of its own.
    const { status, body } = await call('POST', MOVE_URL, {
      moves: [{ testId: 't1', filePath: 'suites\\smoke/./one.spec.ts', name: 'renamed' }],
    });
    expect(status).toBe(200);
    expect(body.tests).toEqual([
      { id: 't1', name: 'renamed', filePath: 'suites/smoke/one.spec.ts' },
    ]);
  });

  it('lets two files swap paths', async () => {
    install(threeFiles());
    const { status } = await call('POST', MOVE_URL, {
      moves: [
        { testId: 't1', filePath: 'tests/two.spec.ts' },
        { testId: 't2', filePath: 'tests/one.spec.ts' },
      ],
    });
    // Both destinations are occupied at the start and free at the end. A
    // one-at-a-time implementation cannot do this at all.
    expect(status).toBe(200);
    expect(paths()).toEqual([
      ['t1', 'tests/two.spec.ts'],
      ['t2', 'tests/one.spec.ts'],
      ['t3', 'tests/three.spec.ts'],
    ]);
  });

  it('accepts a move that changes nothing', async () => {
    install(threeFiles());
    const { status } = await call('POST', MOVE_URL, {
      moves: [{ testId: 't1', filePath: 'tests/one.spec.ts' }],
    });
    expect(status).toBe(200);
    expect(paths()[0]).toEqual(['t1', 'tests/one.spec.ts']);
  });

  /**
   * The reason this endpoint exists. Each case puts ONE bad move in a batch of
   * three and asserts that none of the other two was written — the status code
   * alone would be satisfied by an implementation that moved two files and then
   * gave up.
   */
  const rejections: Array<{ name: string; moves: Row[]; status: number; code: string }> = [
    {
      name: 'a destination already occupied by a live file',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: 'tests/three.spec.ts' },
      ],
      status: 409,
      code: 'CONFLICT',
    },
    {
      name: 'two files sent to the same destination',
      moves: [
        { testId: 't1', filePath: 'suites/same.spec.ts' },
        { testId: 't2', filePath: 'suites/same.spec.ts' },
      ],
      status: 409,
      code: 'CONFLICT',
    },
    {
      name: 'a runnable test moved into fixtures/',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: 'fixtures/two.spec.ts' },
      ],
      status: 400,
      code: 'BAD_REQUEST',
    },
    {
      // Passes the schema (relative, no `..`) and normalises away to nothing,
      // which is the branch `A file needs a name` exists for.
      name: 'a destination that normalises to nothing',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: '.' },
      ],
      status: 400,
      code: 'BAD_REQUEST',
    },
    {
      name: 'an absolute destination',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: '/etc/two.spec.ts' },
      ],
      status: 400,
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'the same file twice',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't1', filePath: 'suites/other.spec.ts' },
      ],
      status: 400,
      code: 'BAD_REQUEST',
    },
    {
      name: 'a file that does not exist',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't_nope', filePath: 'suites/nope.spec.ts' },
      ],
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      name: 'a traversing path',
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: '../../etc/passwd' },
      ],
      status: 400,
      code: 'VALIDATION_FAILED',
    },
  ];

  it.each(rejections)('rolls the whole batch back: $name', async ({ moves, status, code }) => {
    install(threeFiles());
    const before = paths();

    const res = await call('POST', MOVE_URL, { moves });
    expect(res.status).toBe(status);
    expect(res.body.error!.code).toBe(code);
    expect(paths()).toEqual(before);
    // A batch that did nothing must not claim in the log that it did something.
    expect(h.audits).toEqual([]);
  });

  /*
   * The rollback INSIDE the transaction. Every other rejection above is caught
   * before the transaction opens, so this is the only case that proves the
   * writes themselves are undone rather than merely never attempted — and the
   * only one that exercises the compare-and-set on the old path.
   *
   * The interference is staged before the FIRST write, so by the time the
   * second move is attempted its source has moved and the plan is stale. An
   * implementation that updated by id alone would happily overwrite it.
   */
  it('undoes the writes it already made when a row moves underneath it', async () => {
    install(threeFiles());
    onceBeforeNextWrite(() => {
      store.test.find((row) => row.id === 't2')!.filePath = 'tests/moved-by-someone-else.spec.ts';
    });

    const { status, body } = await call('POST', MOVE_URL, {
      moves: [
        { testId: 't1', filePath: 'suites/one.spec.ts' },
        { testId: 't2', filePath: 'suites/two.spec.ts' },
      ],
    });

    expect(status).toBe(409);
    expect(body.error!.message).toContain('nothing was moved');
    // t1's write really was issued — and really was rolled back.
    expect(h.ops.filter((op) => op === 'test.updateMany')).toHaveLength(2);
    expect(store.test.find((row) => row.id === 't1')!.filePath).toBe('tests/one.spec.ts');
    expect(h.audits).toEqual([]);
  });

  it('refuses another org’s file, and moves none of the batch', async () => {
    install([
      seedTest({ id: 't_ours', orgId: 'org_1', filePath: 'tests/ours.spec.ts' }),
      seedTest({ id: 't_theirs', orgId: 'org_2', filePath: 'tests/theirs.spec.ts' }),
    ]);
    const before = paths();

    const { status, body } = await call('POST', MOVE_URL, {
      moves: [
        { testId: 't_ours', filePath: 'suites/ours.spec.ts' },
        { testId: 't_theirs', filePath: 'suites/theirs.spec.ts' },
      ],
    });

    // 404, not 403: confirming the id exists but belongs to someone else is an
    // existence oracle (lib/errors.ts).
    expect(status).toBe(404);
    expect(body.error!.code).toBe('NOT_FOUND');
    expect(paths()).toEqual(before);
  });

  it('refuses a file from another project in the same org', async () => {
    install([
      seedTest({ id: 't_here', filePath: 'tests/here.spec.ts' }),
      seedTest({ id: 't_elsewhere', projectId: 'proj_2', filePath: 'tests/elsewhere.spec.ts' }),
    ]);
    const before = paths();

    const { status } = await call('POST', MOVE_URL, {
      moves: [{ testId: 't_elsewhere', filePath: 'tests/moved.spec.ts' }],
    });
    expect(status).toBe(404);
    expect(paths()).toEqual(before);
  });

  const caps: Array<{ name: string; count: number; status: number }> = [
    { name: 'accepts a full batch of 200', count: 200, status: 200 },
    { name: 'refuses 201', count: 201, status: 400 },
  ];

  it.each(caps)('$name', async ({ count, status }) => {
    install(
      Array.from({ length: count }, (_, i) =>
        seedTest({ id: `t${i}`, filePath: `tests/f${i}.spec.ts` }),
      ),
    );
    const moves = Array.from({ length: count }, (_, i) => ({
      testId: `t${i}`,
      filePath: `moved/f${i}.spec.ts`,
    }));

    const res = await call('POST', MOVE_URL, { moves });
    expect(res.status).toBe(status);
    expect(
      store.test.every((row) => row.filePath.startsWith(status === 200 ? 'moved/' : 'tests/')),
    ).toBe(true);
  });

  it('refuses an empty batch', async () => {
    install(threeFiles());
    const { status, body } = await call('POST', MOVE_URL, { moves: [] });
    expect(status).toBe(400);
    expect(body.error!.code).toBe('VALIDATION_FAILED');
  });

  it('needs MEMBER', async () => {
    install(threeFiles());
    asOrg('org_1', 'VIEWER');
    const { status } = await call('POST', MOVE_URL, {
      moves: [{ testId: 't1', filePath: 'suites/one.spec.ts' }],
    });
    expect(status).toBe(403);
    expect(paths()[0]).toEqual(['t1', 'tests/one.spec.ts']);
  });
});

// ─── (b) Batch delete ────────────────────────────────────────────────────────

describe('POST /:projectId/tests/batch/delete', () => {
  it('soft-deletes every file and audits which ones', async () => {
    install(threeFiles());

    const { status, body } = await call('POST', DELETE_URL, { testIds: ['t1', 't3'] });
    expect(status).toBe(200);
    expect(body.deleted).toBe(2);
    expect(deletedIds()).toEqual(['t1', 't3']);

    // Soft: the rows are still there, carrying their history.
    expect(store.test).toHaveLength(3);
    expect(h.audits[0]).toMatchObject({
      action: 'tests.batch-delete',
      targetType: 'Project',
      targetId: 'proj_1',
      metadata: {
        files: 2,
        tests: [
          { id: 't1', filePath: 'tests/one.spec.ts' },
          { id: 't3', filePath: 'tests/three.spec.ts' },
        ],
      },
    });
  });

  it('treats a repeated id as one instruction', async () => {
    install(threeFiles());
    const { status, body } = await call('POST', DELETE_URL, { testIds: ['t1', 't1', 't1'] });
    expect(status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(deletedIds()).toEqual(['t1']);
  });

  const rejections: Array<{
    name: string;
    rows?: Row[];
    testIds: string[];
    status: number;
    code: string;
  }> = [
    {
      name: 'a file that is already deleted',
      rows: [
        seedTest({ id: 't1', filePath: 'tests/one.spec.ts' }),
        seedTest({ id: 't2', filePath: 'tests/two.spec.ts', disabledAt: new Date('2026-01-01') }),
      ],
      testIds: ['t1', 't2'],
      status: 409,
      code: 'CONFLICT',
    },
    {
      name: 'a file that does not exist',
      testIds: ['t1', 't_nope'],
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      name: 'another org’s file',
      rows: [
        seedTest({ id: 't1', filePath: 'tests/one.spec.ts' }),
        seedTest({ id: 't_theirs', orgId: 'org_2', filePath: 'tests/theirs.spec.ts' }),
      ],
      testIds: ['t1', 't_theirs'],
      status: 404,
      code: 'NOT_FOUND',
    },
    {
      name: 'a file from another project',
      rows: [
        seedTest({ id: 't1', filePath: 'tests/one.spec.ts' }),
        seedTest({ id: 't_other', projectId: 'proj_2', filePath: 'tests/other.spec.ts' }),
      ],
      testIds: ['t1', 't_other'],
      status: 404,
      code: 'NOT_FOUND',
    },
    { name: 'an empty batch', testIds: [], status: 400, code: 'VALIDATION_FAILED' },
  ];

  it.each(rejections)('deletes nothing when the batch contains $name', async (input) => {
    install(input.rows ?? threeFiles());

    const res = await call('POST', DELETE_URL, { testIds: input.testIds });
    expect(res.status).toBe(input.status);
    expect(res.body.error!.code).toBe(input.code);

    // Whatever was already deleted before stays deleted; nothing new is.
    const expectedStillDeleted = (input.rows ?? []).filter((r) => r.disabledAt).map((r) => r.id);
    expect(deletedIds()).toEqual(expectedStillDeleted);
    expect(h.audits).toEqual([]);
  });

  /*
   * The rollback inside the transaction, as for the batch move. The count check
   * after the `updateMany` is what turns "someone else deleted one of these a
   * millisecond ago" into a refusal instead of a partial delete.
   *
   * The fake rolls the interference back along with our own write, which a real
   * concurrent transaction would not — so the assertion is about OUR file, t1,
   * which must not be deleted.
   */
  it('deletes nothing when a file disappears underneath it', async () => {
    install(threeFiles());
    onceBeforeNextWrite(() => {
      store.test.find((row) => row.id === 't2')!.disabledAt = new Date('2026-01-01');
    });

    const { status, body } = await call('POST', DELETE_URL, { testIds: ['t1', 't2'] });

    expect(status).toBe(409);
    expect(body.error!.message).toContain('nothing was deleted');
    expect(deletedIds()).not.toContain('t1');
    expect(h.audits).toEqual([]);
  });

  it.each([
    { name: 'accepts a full batch of 200', count: 200, status: 200 },
    { name: 'refuses 201', count: 201, status: 400 },
  ])('$name', async ({ count, status }) => {
    install(
      Array.from({ length: count }, (_, i) =>
        seedTest({ id: `t${i}`, filePath: `tests/f${i}.spec.ts` }),
      ),
    );
    const testIds = Array.from({ length: count }, (_, i) => `t${i}`);

    const res = await call('POST', DELETE_URL, { testIds });
    expect(res.status).toBe(status);
    expect(deletedIds()).toHaveLength(status === 200 ? count : 0);
  });

  it('needs MEMBER', async () => {
    install(threeFiles());
    asOrg('org_1', 'VIEWER');
    const { status } = await call('POST', DELETE_URL, { testIds: ['t1'] });
    expect(status).toBe(403);
    expect(deletedIds()).toEqual([]);
  });
});

// ─── The single-file move, now sharing the batch's validator ─────────────────

/**
 * PATCH .../path was rewritten to plan its move through the same function the
 * batch uses, so that the path rules cannot mean one thing for one file and
 * another for forty. These are the regression tests for that rewrite: every
 * behaviour the single-file route had before must still hold.
 */
describe('PATCH /:projectId/tests/:testId/path after the refactor', () => {
  const url = (testId: string) => `/projects/proj_1/tests/${testId}/path`;

  it('moves and renames one file, and audits it as test.move', async () => {
    install(threeFiles());
    const { status, body } = await call('PATCH', url('t1'), {
      filePath: 'suites/one.spec.ts',
      name: 'renamed',
    });
    expect(status).toBe(200);
    expect(body.test).toEqual({ id: 't1', name: 'renamed', filePath: 'suites/one.spec.ts' });
    expect(h.audits[0]).toMatchObject({
      action: 'test.move',
      targetType: 'Test',
      targetId: 't1',
      metadata: { from: 'tests/one.spec.ts', to: 'suites/one.spec.ts' },
    });
  });

  const rejections: Array<{ name: string; testId: string; filePath: string; status: number }> = [
    { name: 'a collision', testId: 't1', filePath: 'tests/two.spec.ts', status: 409 },
    { name: 'the fixtures boundary', testId: 't1', filePath: 'fixtures/one.spec.ts', status: 400 },
    { name: 'a path that normalises away', testId: 't1', filePath: '.', status: 400 },
    { name: 'an absolute path', testId: 't1', filePath: '/etc/passwd', status: 400 },
    { name: 'traversal', testId: 't1', filePath: '../secrets', status: 400 },
    { name: 'an unknown test', testId: 't_nope', filePath: 'suites/x.spec.ts', status: 404 },
  ];

  it.each(rejections)('still refuses $name', async ({ testId, filePath, status }) => {
    install(threeFiles());
    const before = paths();
    const res = await call('PATCH', url(testId), { filePath });
    expect(res.status).toBe(status);
    expect(paths()).toEqual(before);
  });

  it('still refuses another org’s file with a 404', async () => {
    install([seedTest({ id: 't_theirs', orgId: 'org_2', filePath: 'tests/theirs.spec.ts' })]);
    const { status } = await call('PATCH', url('t_theirs'), { filePath: 'suites/x.spec.ts' });
    expect(status).toBe(404);
    expect(paths()).toEqual([['t_theirs', 'tests/theirs.spec.ts']]);
  });

  it('still allows a fixture to move within fixtures/', async () => {
    // The boundary is about RUNNABLE code, not about the folder alone: a .json
    // data file has always been allowed to live there.
    install([seedTest({ id: 't_fix', filePath: 'fixtures/users.json', code: '' })]);
    const { status } = await call('PATCH', url('t_fix'), { filePath: 'fixtures/people.json' });
    expect(status).toBe(200);
    expect(paths()).toEqual([['t_fix', 'fixtures/people.json']]);
  });

  it('still skips the collision check for a move that changes nothing', async () => {
    /*
     * Two live rows on one path is a state the schema permits (there is no
     * unique index on filePath) and that a restore or an import can produce.
     * Re-PATCHing one of them to the path it already has never checked for a
     * clash, and must not start: the refactor would otherwise turn a no-op into
     * a 409 that the caller cannot act on.
     */
    install([
      seedTest({ id: 't_a', filePath: 'tests/dupe.spec.ts' }),
      seedTest({ id: 't_b', filePath: 'tests/dupe.spec.ts' }),
    ]);
    const { status } = await call('PATCH', url('t_a'), { filePath: 'tests/dupe.spec.ts' });
    expect(status).toBe(200);
  });
});
