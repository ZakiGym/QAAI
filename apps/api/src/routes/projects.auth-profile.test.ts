/**
 * Binding a role to a test, over the wire.
 *
 * `Test.authProfileId` is a foreign key, so the database already refuses an id
 * that does not exist and nulls the column when the profile is deleted. Neither
 * of those is what this file is about. The two properties a foreign key CANNOT
 * express are:
 *
 *   1. AN AUTH PROFILE BELONGS TO A PROJECT, NOT TO AN ORG. A profile hangs off
 *      an Environment, an Environment off a Project, and two projects in the
 *      same organisation have separate environments with separate sessions. The
 *      tenant-scoped client closes the org boundary and is blind to this one, so
 *      project A's test can be bound to project B's profile with every
 *      constraint in the schema satisfied — and the result is a suite running
 *      against one deployment with a session minted against another, which
 *      fails by SUCCEEDING. The API has to refuse it, and refuse it by name:
 *      silently dropping the binding to null would tell the caller the save
 *      worked and leave the test running as nobody.
 *
 *   2. THE INTENT SURVIVES THE BINDING. `authProfileRequired` is a separate
 *      column precisely so that deleting a profile (which nulls the id) leaves
 *      evidence that a role was asked for. Every write path here has to set it
 *      when a profile is named, or the orphan state is unreachable and the
 *      coverage report can never say "this test needs a role and is running
 *      anonymously".
 *
 * There is also one check that is not about a request at all: the hand-written
 * migration has to declare what schema.prisma declares. `prisma migrate dev` is
 * not run in this repo, so nothing but a test compares the two, and a migration
 * that disagrees with the schema is a deployment that comes up with a column
 * the code expects to be absent, or absent a column the code writes to.
 *
 * Harness: the same shape as projects.tree.test.ts — a mocked prisma module
 * with a real AsyncLocalStorage tenant scope, and the real router driven over a
 * loopback socket.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
}));

vi.mock('../env.js', () => ({
  env: {
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
 * Real scope, not a stubbed variable: the route's queries run in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and the isolation tests below would pass for a
 * reason that has nothing to do with the router.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => (h.prisma as Row)[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

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

interface Store {
  project: Row[];
  environment: Row[];
  authProfile: Row[];
  suite: Row[];
  test: Row[];
  testVersion: Row[];
  testResult: Row[];
}

let store: Store;
let nextId = 0;

/**
 * Enough of Prisma to drive these four handlers, and no more. The one piece
 * that is NOT simplified is the `environment: { projectId }` relation filter on
 * authProfile.findFirst — that filter IS the property under test, so the fake
 * resolves it through the environment rows rather than accepting it and
 * shrugging, which would let a router that dropped the join pass.
 */
function makeDb(): Row {
  const orgOf = () => h.currentOrg();

  const scoped = (name: keyof Store, where: Row = {}): Row[] => {
    const orgId = orgOf();
    return store[name].filter((row) => {
      if (orgId && row.orgId !== orgId) return false;
      return Object.entries(where).every(([key, cond]) => {
        if (key === 'environment') {
          const env = store.environment.find((e) => e.id === row.environmentId);
          if (!env) return false;
          return Object.entries(cond as Row).every(([k, v]) => env[k] === v);
        }
        if (cond === null) return (row[key] ?? null) === null;
        if (cond && typeof cond === 'object' && 'not' in (cond as Row)) {
          const not = (cond as Row).not;
          if (not && typeof not === 'object' && 'startsWith' in (not as Row)) {
            return !String(row[key] ?? '').startsWith(String((not as Row).startsWith));
          }
          return row[key] !== not;
        }
        return row[key] === cond;
      });
    });
  };

  const pick = (row: Row, select?: Row, include?: Row): Row => {
    const out: Row = select ? {} : { ...row };
    for (const [key, want] of Object.entries(select ?? {})) {
      if (want === true) out[key] = row[key] ?? null;
      else if (key === 'authProfile') out[key] = joinProfile(row, want as Row);
    }
    for (const [key, want] of Object.entries(include ?? {})) {
      if (key === 'authProfile') out[key] = joinProfile(row, want as Row);
    }
    return out;
  };

  const joinProfile = (row: Row, want: Row): Row | null => {
    const profile = store.authProfile.find((p) => p.id === row.authProfileId);
    if (!profile) return null;
    const sel = (want.select ?? {}) as Row;
    const out: Row = {};
    for (const key of Object.keys(sel)) out[key] = profile[key];
    return out;
  };

  const model = (name: keyof Store): Row => ({
    findMany: async ({ where, select, include }: Row = {}) =>
      scoped(name, where).map((row) => pick(row, select, include)),
    findFirst: async ({ where, select, include }: Row = {}) => {
      const found = scoped(name, where)[0];
      return found ? pick(found, select, include) : null;
    },
    // A unique lookup carries no extra filter, so — like the real extension —
    // ownership is post-checked and a row from another org reads as absent.
    findUnique: async ({ where = {}, select, include }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) return null;
      const orgId = orgOf();
      if (orgId && found.orgId !== orgId) return null;
      return pick(found, select, include);
    },
    create: async ({ data = {}, select, include }: Row = {}) => {
      const { versions, ...scalars } = data as Row;
      const row: Row = { id: `${name}_${++nextId}`, ...scalars };
      store[name].push(row);
      if (versions?.create) store.testVersion.push({ ...(versions.create as Row), testId: row.id });
      return pick(row, select, include);
    },
    update: async ({ where = {}, data = {}, select, include }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) throw new Error(`fake prisma: no ${name} ${String(where.id)}`);
      const { versions, ...scalars } = data as Row;
      Object.assign(found, scalars);
      if (versions?.create) store.testVersion.push({ ...(versions.create as Row), testId: found.id });
      return pick(found, select, include);
    },
    upsert: async ({ create = {}, select }: Row = {}) => {
      const existing = store[name][0];
      if (existing) return pick(existing, select);
      const row: Row = { id: `${name}_${++nextId}`, ...(create as Row) };
      store[name].push(row);
      return pick(row, select);
    },
  });

  return {
    project: model('project'),
    environment: model('environment'),
    authProfile: model('authProfile'),
    suite: model('suite'),
    test: model('test'),
    testVersion: model('testVersion'),
    // The list route colours each row with that test's last result in ONE
    // aggregate. Offering groupBy and nothing per-row keeps that true: an N+1
    // implementation throws here instead of passing slowly.
    testResult: { groupBy: async () => [] },
  };
}

function seedTest(over: Row = {}): Row {
  return {
    id: 'test_a',
    orgId: 'org_1',
    projectId: 'proj_a',
    suiteId: null,
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
    code: 'await page.goto("/");',
    spec: null,
    disabledAt: null,
    authProfileId: null,
    authProfileRequired: false,
    ...over,
  };
}

/**
 * Two projects in ONE org, each with its own environment and its own auth
 * profile. The second project is the whole point: the tenant scope cannot tell
 * these two profiles apart, so if the router does not join through Environment,
 * `prof_b` binds to a test in `proj_a` and every assertion about isolation here
 * is the only thing standing in the way.
 */
function install(tests: Row[] = [seedTest()]): void {
  nextId = 0;
  store = {
    project: [
      { id: 'proj_a', orgId: 'org_1', name: 'A' },
      { id: 'proj_b', orgId: 'org_1', name: 'B' },
    ],
    environment: [
      { id: 'env_a', orgId: 'org_1', projectId: 'proj_a', name: 'staging' },
      { id: 'env_b', orgId: 'org_1', projectId: 'proj_b', name: 'staging' },
    ],
    authProfile: [
      { id: 'prof_a', orgId: 'org_1', environmentId: 'env_a', name: 'Admin', kind: 'FORM_LOGIN' },
      { id: 'prof_b', orgId: 'org_1', environmentId: 'env_b', name: 'Admin', kind: 'FORM_LOGIN' },
      // Another org's profile, to prove the ordinary tenant scope still bites.
      { id: 'prof_x', orgId: 'org_2', environmentId: 'env_x', name: 'Admin', kind: 'FORM_LOGIN' },
    ],
    suite: [],
    test: tests,
    testVersion: [],
    testResult: [],
  };
  h.prisma = makeDb();
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

const NEW_TEST = {
  name: 'admin can invite',
  code: "await page.goto('/admin/users');",
  filePath: 'tests/admin-invite.spec.ts',
};

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits = [];
  install();
});

// ─── Round trip ──────────────────────────────────────────────────────────────

describe('a test carrying an auth profile round-trips through the API', () => {
  it('stores the binding on create and reads it back with the role name', async () => {
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_a',
    });
    expect(created.status).toBe(201);
    expect(created.body.test.authProfileId).toBe('prof_a');

    const detail = await call('GET', `/projects/proj_a/tests/${created.body.test.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.test.authProfileId).toBe('prof_a');
    // The id is not a name, and a tree that shows ids cannot be read.
    expect(detail.body.test.authProfile).toEqual({ id: 'prof_a', name: 'Admin' });
  });

  it('shows the role on the LIST, so two roles in one suite are tellable apart', async () => {
    install([
      seedTest({ id: 'test_anon', name: 'anonymous', filePath: 'tests/anon.spec.ts' }),
      seedTest({
        id: 'test_admin',
        name: 'as admin',
        filePath: 'tests/admin.spec.ts',
        authProfileId: 'prof_a',
        authProfileRequired: true,
      }),
    ]);

    const listed = await call('GET', '/projects/proj_a/tests');
    const byId = new Map<string, Row>(listed.body.tests.map((t: Row) => [t.id, t]));
    expect(byId.get('test_anon')!.authProfileId).toBeNull();
    expect(byId.get('test_admin')!.authProfileId).toBe('prof_a');
    expect(byId.get('test_admin')!.authProfile).toEqual({ id: 'prof_a', name: 'Admin' });
  });

  it('treats naming a profile as declaring the test needs one', async () => {
    // The pair is what makes a deleted profile visible later: the FK nulls the
    // id and leaves this true, which is a state nothing else can produce.
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_a',
    });
    expect(store.test.find((t) => t.id === created.body.test.id)!.authProfileRequired).toBe(true);
  });

  it('defaults to anonymous when no profile is named, rather than inventing one', async () => {
    const created = await call('POST', '/projects/proj_a/tests', NEW_TEST);
    expect(created.status).toBe(201);
    expect(created.body.test.authProfileId).toBeNull();
    expect(created.body.test.authProfileRequired).toBe(false);
  });

  it('re-binds and clears through PUT, and tells the two apart from "not mentioned"', async () => {
    install([seedTest({ authProfileId: 'prof_a', authProfileRequired: true })]);

    // A client that predates the field sends neither key; the binding stands.
    const untouched = await call('PUT', '/projects/proj_a/tests/test_a', { code: 'changed();' });
    expect(untouched.status).toBe(200);
    expect(store.test[0]!.authProfileId).toBe('prof_a');

    // An explicit null clears the binding and LEAVES the requirement, so the
    // coverage report can still say this test asked for a role.
    const cleared = await call('PUT', '/projects/proj_a/tests/test_a', {
      code: 'changed twice();',
      authProfileId: null,
    });
    expect(cleared.status).toBe(200);
    expect(store.test[0]!.authProfileId).toBeNull();
    expect(store.test[0]!.authProfileRequired).toBe(true);
  });

  it('records a re-binding in the audit log', async () => {
    await call('PUT', '/projects/proj_a/tests/test_a', {
      code: 'signed in now();',
      authProfileId: 'prof_a',
    });
    const entry = h.audits.find((a) => a.action === 'test.update');
    expect(entry?.metadata.authProfileId).toBe('prof_a');
  });

  it('carries the role onto a duplicate', async () => {
    install([seedTest({ authProfileId: 'prof_a', authProfileRequired: true })]);
    const copy = await call('POST', '/projects/proj_a/tests/test_a/duplicate');
    expect(copy.status).toBe(201);
    // A copy of an admin test that runs anonymously would reach a login page
    // instead of the feature, and the diff against the original would not say why.
    expect(copy.body.test.authProfileId).toBe('prof_a');
    expect(copy.body.test.authProfileRequired).toBe(true);
  });
});

// ─── Data isolation ──────────────────────────────────────────────────────────

describe('a profile from outside the project is refused, not dropped', () => {
  it('rejects a sibling project’s profile with a 400 that names the problem', async () => {
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_b',
    });

    expect(created.status).toBe(400);
    expect(created.body.error.message).toContain('prof_b');
    expect(created.body.error.message).toMatch(/does not belong to this project/i);
    // Refused, not half-applied: no test row, and no "Hand-written" suite left
    // behind for a test that was never created.
    expect(store.test).toHaveLength(1);
    expect(store.suite).toHaveLength(0);
  });

  it('rejects it on PUT too, and does not write the code either', async () => {
    const put = await call('PUT', '/projects/proj_a/tests/test_a', {
      code: 'this must not land();',
      authProfileId: 'prof_b',
    });

    expect(put.status).toBe(400);
    expect(put.body.error.message).toContain('prof_b');
    expect(store.test[0]!.code).toBe('await page.goto("/");');
    expect(store.test[0]!.authProfileId).toBeNull();
  });

  it('never silently nulls the binding instead of refusing', async () => {
    // The failure mode this replaces: a 201 whose test runs as nobody. The
    // caller is told the save worked and the role it asked for is nowhere.
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_b',
    });
    expect(created.status).not.toBe(201);
    expect(store.test.some((t) => t.filePath === NEW_TEST.filePath)).toBe(false);
  });

  it('rejects another org’s profile, so the tenant scope is still load-bearing', async () => {
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_x',
    });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toContain('prof_x');
  });

  it('rejects an id that does not exist at all', async () => {
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_nope',
    });
    expect(created.status).toBe(400);
  });

  it('keeps the existing role check: a VIEWER cannot bind a role', async () => {
    h.actor = { userId: 'user_v', orgId: 'org_1', role: 'VIEWER', ip: null };
    const created = await call('POST', '/projects/proj_a/tests', {
      ...NEW_TEST,
      authProfileId: 'prof_a',
    });
    expect(created.status).toBe(403);
  });
});

// ─── Schema and migration agree ──────────────────────────────────────────────

/**
 * `prisma migrate dev` is not run in this repo — migrations are hand-written —
 * so nothing but this compares the two declarations. A migration that disagrees
 * with the schema is a deployment that comes up either missing a column the
 * code writes to, or holding one the code believes is absent, and neither shows
 * up until a query runs in production.
 */
describe('the migration declares what the Prisma schema declares', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
  const schema = read('prisma/schema.prisma');
  const migration = read('prisma/migrations/20261023010000_test_auth_profile/migration.sql');

  const testModel = (): string => {
    const block = /\nmodel Test \{([\s\S]*?)\n\}/.exec(schema);
    expect(block, 'schema.prisma declares no model Test').toBeTruthy();
    return block![1]!;
  };

  it('adds both columns the schema adds, with the schema’s nullability', () => {
    expect(testModel()).toMatch(/^\s*authProfileId\s+String\?\s*$/m);
    expect(testModel()).toMatch(/^\s*authProfileRequired\s+Boolean\s+@default\(false\)\s*$/m);

    expect(migration).toMatch(/ADD COLUMN\s+"authProfileId" TEXT\s*,/);
    // NOT NULL with a constant default: nullable here would let a row exist
    // that neither declares nor denies that it needs a role.
    expect(migration).toMatch(
      /ADD COLUMN\s+"authProfileRequired" BOOLEAN NOT NULL DEFAULT false;/,
    );
  });

  it('creates the index the schema declares', () => {
    expect(testModel()).toMatch(/@@index\(\[authProfileId\]\)/);
    expect(migration).toContain('CREATE INDEX "Test_authProfileId_idx" ON "Test"("authProfileId")');
  });

  it('declares the foreign key with SetNull, the behaviour the schema relies on', () => {
    // Not cosmetic. Cascade would delete the customer's tests with the profile;
    // Restrict would make the profile undeletable. SetNull is the choice the
    // whole authProfileRequired design is built on top of, so the two
    // declarations disagreeing would quietly change what deletion does.
    expect(testModel()).toMatch(
      /authProfile\s+AuthProfile\?\s+@relation\(fields: \[authProfileId\], references: \[id\], onDelete: SetNull\)/,
    );
    expect(migration).toContain(
      'ALTER TABLE "Test" ADD CONSTRAINT "Test_authProfileId_fkey" FOREIGN KEY ("authProfileId") REFERENCES "AuthProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
  });

  it('adds nothing else to any other table', () => {
    // The migration's own claim about itself, kept true: anything beyond these
    // two columns on Test belongs in its own migration with its own argument.
    const altered = [...migration.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(['Test']));
    expect(migration).not.toMatch(/\bDROP\b/);
  });
});
