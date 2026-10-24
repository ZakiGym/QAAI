/**
 * `POST /projects/:projectId/tests/:testId/quarantine` — THE OTHER DOOR.
 *
 * Quarantine has two writers. The automatic one
 * (apps/worker/src/processors/flake.ts) went through the budget, stamped an
 * expiry and asked `quarantineSuppresses` whether a suppression was already in
 * force. This endpoint — the switch a person flips on the flaky-tests screen —
 * did none of those things, and a brake only one of two doors respects is not a
 * brake: a team refused automatically could quarantine the same test from the
 * screen, and the fortieth quarantine nobody was allowed to take came through
 * here instead. It now shares `checkQuarantineBudget` and
 * `quarantineExpiryFrom` with the worker, and returns the budget on the
 * response.
 *
 * **Nothing tested it.** That is the condition every defect in this register
 * lived in, so what follows is deliberately about the properties a careless
 * edit would break rather than about the happy path:
 *
 *  1. The budget is ENFORCED here, not just computed. A refusal is a 409 whose
 *     message names the two things that clear it.
 *  2. An expiry is STAMPED. A quarantine with no end date is a deletion nobody
 *     signed, and the auto-quarantine stamping one while this door did not is
 *     how half a suite ends up permanently suppressed by hand.
 *  3. Re-deciding a suppression already IN FORCE is never refused — refusing
 *     would hide the state rather than change it — while renewing an EXPIRED
 *     one IS charged, or an over-budget project renews forever.
 *  4. The denominator and the numerator are counted the way the budget means
 *     them: expired quarantines are not in force and must not be charged, or
 *     the budget tightens on its own and refuses a quarantine the suite had
 *     room for.
 *  5. Un-quarantining clears the flag AND the expiry. A stale expiry on an
 *     un-quarantined test is a row that contradicts itself.
 *  6. It is TENANT-SCOPED like its neighbours. It takes both ids straight off
 *     the URL and the router's only defence is that it queries through the
 *     scoped client inside the request's tenant scope — invisible at the call
 *     site, because there is deliberately no `orgId` in any `where`.
 *
 * Harness: the same shape as projects.tree.test.ts — a mocked prisma module
 * with a REAL AsyncLocalStorage tenant scope, and the real router driven over a
 * loopback socket. The scope is real because the route's queries run in the
 * async continuation of `withTenant(orgId, () => next())`; a plain variable
 * would be restored before they ran and the isolation test below would pass for
 * a reason that has nothing to do with the router.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUARANTINE_BUDGET_FLOOR,
  QUARANTINE_MAX_DAYS,
  quarantineBudget,
} from '@qaai/runner';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** Every operation the router issued, as `model.operation`, with its args. */
  ops: Array<{ op: string; args: Row }>;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  ops: [],
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
 * Captured, not discarded. Switching a signal off is the kind of act that has
 * to leave a record of WHO and HOW MUCH OF THE SUITE, and an audit row that
 * logs the name and not the budget is not a record of the decision.
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
 * The filters this route is allowed to use, per model. Anything else throws
 * rather than being quietly ignored: a fake that shrugged at
 * `quarantineExpiresAt: { gt: now }` would pass the test that proves an expired
 * quarantine is not charged to the budget, which is the whole point of that
 * arm of the query.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  test: new Set(['id', 'orgId', 'projectId', 'disabledAt', 'quarantined', 'OR']),
  project: new Set(['id', 'orgId']),
};

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return value !== c.not;
    /*
     * The expiry arm, and it is modelled rather than waved through. `gt` on a
     * Date is how "still in force" is asked in SQL, and a fake that answered
     * true for a quarantine that ran out last week would make the budget look
     * right while it over-charged every project with an old quarantine in it.
     */
    if ('gt' in c) {
      return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
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
    // `OR: [{ quarantineExpiresAt: null }, { quarantineExpiresAt: { gt: now } }]`
    // — "never expires, or has not yet". Prisma's OR is a real disjunction and
    // the fake treats it as one.
    if (key === 'OR') {
      return (cond as Row[]).some((branch) =>
        Object.entries(branch).every(([field, c]) => matchesCondition(row[field] ?? null, c)),
      );
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

interface Store {
  test: Row[];
  project: Row[];
}

/**
 * A Prisma stand-in that enforces tenancy the way the extension does — merging
 * the ambient orgId into every filterable `where`, and post-checking ownership
 * on the unique-selector operations, because that merge IS the security
 * property under test.
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
      /*
       * A unique lookup cannot carry an extra filter, so — exactly like the
       * real extension — ownership is checked on the RESULT and a row from
       * another org is reported as absent rather than refused. The API must not
       * become an existence oracle.
       */
      findUnique: async (args: Row = {}) => {
        h.ops.push({ op: `${name}.findUnique`, args });
        const orgId = h.currentOrg();
        const found = rows().find((row) => row.id === args.where?.id);
        if (!found) return null;
        if (orgId && found.orgId !== orgId) return null;
        return project(found, args.select);
      },

      count: async (args: Row = {}) => {
        h.ops.push({ op: `${name}.count`, args });
        return select(args.where).length;
      },

      update: async (args: Row = {}) => {
        h.ops.push({ op: `${name}.update`, args });
        const orgId = h.currentOrg();
        const found = rows().find((row) => row.id === args.where?.id);
        if (!found) throw new Error(`fake prisma: no ${name} ${String(args.where?.id)}`);
        if (orgId && found.orgId !== orgId) throw new Error(`fake prisma: no ${name} found`);
        Object.assign(found, args.data);
        return project(found, args.select);
      },
    };
  };

  return { test: model('test'), project: model('project') };
}

const DAY = 86_400_000;
const NOW = Date.now();

/** A `Test` row in the shape this route selects. Live and un-quarantined by default. */
function seedTest(over: Row = {}): Row {
  return {
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'checkout completes',
    quarantined: false,
    quarantinedAt: null,
    quarantineExpiresAt: null,
    disabledAt: null,
    ...over,
  };
}

/**
 * `n` more tests in the project, all distinct.
 *
 * The id prefix is a parameter and not a constant because several fixtures call
 * this twice — once for the quarantined neighbours and once for the plain ones
 * — and two batches sharing ids would be a fixture that contradicts a unique
 * key. The counts would still come out right, which is exactly what makes it
 * worth not doing.
 */
let fillerBatch = 0;
function filler(n: number, over: Row = {}): Row[] {
  const prefix = `filler${(fillerBatch += 1)}`;
  return Array.from({ length: n }, (_, i) =>
    seedTest({ id: `${prefix}_${i}`, name: `${prefix} ${i}`, ...over }),
  );
}

function seedProject(over: Row = {}): Row {
  return { id: 'proj_1', orgId: 'org_1', quarantineBudgetPercent: null, ...over };
}

let store: Store = { test: [], project: [] };

function install(tests: Row[] = [], projects: Row[] = [seedProject()]): void {
  store = { test: tests, project: projects };
  h.prisma = makeDb(store);
}

const storedTest = (id = 'test_1'): Row => store.test.find((row) => row.id === id)!;

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

const quarantine = (
  body?: unknown,
  ids: { projectId?: string; testId?: string } = {},
): Promise<{ status: number; body: Row }> =>
  call(
    'POST',
    `/projects/${ids.projectId ?? 'proj_1'}/tests/${ids.testId ?? 'test_1'}/quarantine`,
    body ?? {},
  );

const asOrg = (orgId: string, role = 'MEMBER'): void => {
  h.actor = { userId: `user_of_${orgId}`, orgId, role, ip: null };
};

beforeEach(() => {
  asOrg('org_1');
  h.audits.length = 0;
  h.ops.length = 0;
  install();
});

// ─── (a) Inside the budget ───────────────────────────────────────────────────

describe('a quarantine the suite has room for', () => {
  it('goes through, and comes back with an expiry and the budget', async () => {
    install([seedTest(), ...filler(99)]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.test.quarantined).toBe(true);

    /*
     * The expiry is the whole difference between a quarantine and a deletion
     * nobody signed, so it is asserted as a DATE rather than as "truthy": a
     * null that serialised to the string "null" would satisfy a looser check.
     */
    const expiresAt = Date.parse(String(body.test.quarantineExpiresAt));
    expect(Number.isFinite(expiresAt)).toBe(true);
    expect(expiresAt).toBeGreaterThan(NOW + (QUARANTINE_MAX_DAYS - 1) * DAY);
    expect(expiresAt).toBeLessThan(NOW + (QUARANTINE_MAX_DAYS + 1) * DAY);
    // Stored, not only echoed.
    expect(storedTest().quarantineExpiresAt).toBeInstanceOf(Date);
    expect(storedTest().quarantinedAt).toBeInstanceOf(Date);

    /*
     * The budget rides the response. The person who just switched a signal off
     * is the one who needs to know how much of the suite is now switched off —
     * telling them later, or only in a log, is telling nobody.
     */
    expect(body.budget).toMatchObject({ allowed: true, limit: 5, percent: 5 });
    expect(body.budget.nearLimit).toBe(false);
  });

  it('records who did it and how much of the suite is now suppressed', async () => {
    install([seedTest(), ...filler(99)]);
    await quarantine();

    const entry = h.audits.at(-1)!;
    expect(entry.action).toBe('test.quarantine');
    expect(entry.targetId).toBe('test_1');
    expect(entry.metadata).toMatchObject({
      name: 'checkout completes',
      quarantineLimit: 5,
      nearLimit: false,
    });
    // The expiry is in the record too: a row that says what was suppressed and
    // until when is the difference between auditable and merely logged.
    expect(typeof entry.metadata.expiresAt).toBe('string');
  });

  it('warns while it still allows, so the refusal is not the first anybody hears', async () => {
    // Four in force out of a cap of five: allowed, and the next one or two are
    // not going to be.
    install([
      seedTest(),
      ...filler(4, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...filler(95),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.budget.allowed).toBe(true);
    expect(body.budget.nearLimit).toBe(true);
    expect(body.budget.reason).toMatch(/next one or two will be refused/);
  });
});

// ─── (b) The refusal ─────────────────────────────────────────────────────────

describe('a quarantine that would take the suite over its budget', () => {
  it('is refused with a 409 that names what to do instead', async () => {
    // Cap is 5 on a 100-test suite; five are already in force.
    install([
      seedTest(),
      ...filler(5, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...filler(94),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(409);
    /*
     * A refusal with no instruction is a wall, and a wall gets routed around by
     * somebody setting the budget to 100. The message has to name both exits.
     */
    expect(body.error.message).toMatch(/Fix one of the quarantined tests or delete it/);
    expect(body.error.message).toMatch(/quarantineBudgetPercent/);

    // And it did not half-apply: the test is untouched.
    expect(storedTest().quarantined).toBe(false);
    expect(storedTest().quarantineExpiresAt).toBeNull();
    // No audit row for an act that did not happen.
    expect(h.audits).toEqual([]);
  });

  it('still gives the smallest suite two, because a hatch that never opens is no hatch', async () => {
    /*
     * 5% of a 10-test suite is half a test, and a budget that refuses the FIRST
     * quarantine means the escape hatch does not exist — at which point a team
     * deletes the test instead, which is strictly worse. The floor's price is
     * stated out loud in gates.ts: a small suite can reach a high percentage.
     */
    install([seedTest(), ...filler(9)]);
    expect(quarantineBudget({ totalTests: 10 }).allowed).toBe(QUARANTINE_BUDGET_FLOOR);

    const first = await quarantine();
    expect(first.status).toBe(200);
    expect(first.body.budget.limit).toBe(QUARANTINE_BUDGET_FLOOR);

    // The second is the floor; the third is refused.
    install([
      seedTest(),
      ...filler(2, { quarantined: true, quarantineExpiresAt: new Date(NOW + DAY) }),
      ...filler(7),
    ]);
    expect((await quarantine()).status).toBe(409);
  });

  it('honours a project that raised its own cap on purpose and in writing', async () => {
    install(
      [
        seedTest(),
        ...filler(5, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
        ...filler(94),
      ],
      [seedProject({ quarantineBudgetPercent: 20 })],
    );

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.budget).toMatchObject({ limit: 20, percent: 20 });
  });
});

// ─── (c) Re-deciding, and renewing ───────────────────────────────────────────

describe('re-deciding a quarantine that is already in force', () => {
  it('is never refused, even with the suite over its cap', async () => {
    /*
     * The suppression exists either way. Refusing here would only stop the
     * audit row and the reason being updated — it would hide the state rather
     * than change it. The budget guards switching a NEW signal off.
     */
    install([
      seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...filler(8, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...filler(91),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.budget.allowed).toBe(true);
    expect(body.budget.reason).toMatch(/Already quarantined/);
    // It is NOT charged: the eight others are the count, and this one is the
    // ninth suppression that already existed.
    expect(body.budget.current).toBe(8);
  });

  it('refreshes the expiry, so re-deciding is a decision and not a no-op', async () => {
    const nearlyOver = new Date(NOW + 60_000);
    install([seedTest({ quarantined: true, quarantineExpiresAt: nearlyOver }), ...filler(99)]);

    await quarantine();
    expect(storedTest().quarantineExpiresAt!.getTime()).toBeGreaterThan(nearlyOver.getTime());
  });
});

describe('renewing a quarantine that has run out', () => {
  it('is charged to the budget, or an over-budget project renews forever', async () => {
    /*
     * The flag is still TRUE — expiry deliberately does not clear it, so the
     * reason survives — and the expiry is yesterday, so the test has been
     * gating again. Quarantining it is therefore a NEW suppression being taken
     * out, and the cap applies. Treating it as a re-decision would hand every
     * over-budget project a permanent loophole: let one lapse, renew it, repeat.
     */
    install([
      seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW - DAY) }),
      ...filler(5, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...filler(94),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/already quarantined/);
    expect(storedTest().quarantineExpiresAt!.getTime()).toBeLessThan(NOW);
  });

  it('goes through when the suite has room, and gets a fresh expiry', async () => {
    install([seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW - DAY) }), ...filler(99)]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    // Charged, so `alreadyQuarantined` was false and the reason is the new-grant
    // one rather than the re-decision one.
    expect(body.budget.reason).not.toMatch(/Already quarantined/);
    expect(storedTest().quarantineExpiresAt!.getTime()).toBeGreaterThan(NOW);
  });
});

// ─── (d) The count the budget is measured against ────────────────────────────

describe('what counts toward the budget', () => {
  it('leaves expired quarantines out, or the budget tightens on its own', async () => {
    /*
     * Four in force and four that ran out. Charging the expired ones would put
     * the project at eight of a cap of five and refuse a quarantine the suite
     * genuinely had room for — a budget that gets stricter while nobody does
     * anything, which is how a brake becomes a wall.
     */
    install([
      seedTest(),
      ...filler(4, { quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }),
      ...Array.from({ length: 4 }, (_, i) =>
        seedTest({
          id: `expired_${i}`,
          quarantined: true,
          quarantineExpiresAt: new Date(NOW - DAY),
        }),
      ),
      ...filler(91),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.budget.current).toBe(4);
  });

  it('honours a quarantine with no expiry at all, because those predate the rule', async () => {
    // Null expiry is honoured — back-filling one onto rows a customer never
    // agreed to would turn thousands of suppressed failures red in one deploy.
    install([
      seedTest(),
      ...filler(5, { quarantined: true, quarantineExpiresAt: null }),
      ...filler(94),
    ]);

    expect((await quarantine()).status).toBe(409);
  });

  it('counts live tests as the denominator, not deleted ones', async () => {
    /*
     * `disabledAt` is a soft delete. Counting deleted tests would inflate the
     * denominator and hand a project a budget for a suite it no longer has.
     */
    install([
      seedTest(),
      ...filler(2, { quarantined: true, quarantineExpiresAt: new Date(NOW + DAY) }),
      ...filler(20),
      ...filler(900, { disabledAt: new Date(NOW - 10 * DAY) }),
    ]);

    /*
     * 23 live tests → floor(23 × 5%) = 1, raised to the floor of 2, and two are
     * already in force — so this is refused. Counting the 900 deleted rows
     * would make the cap 46 and let it through, which is a project holding a
     * budget for a suite it no longer has.
     */
    const { status, body } = await quarantine();
    expect(status).toBe(409);
    expect(body.error.message).toContain(`cap of ${QUARANTINE_BUDGET_FLOOR}`);
    expect(body.error.message).toContain('2 of 23 test(s)');
    expect(storedTest().quarantined).toBe(false);
  });

  it('does not count the test being decided as one of its own neighbours', async () => {
    /*
     * `id: { not: test.id }` in the count. Without it a test already in force
     * would be counted once in `current` and once more by `+1`, so the budget
     * would refuse a re-decision at the cap — the exact case rule 3 above says
     * is never refused.
     */
    install([seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW + DAY) }), ...filler(9)]);

    const { body } = await quarantine();
    expect(body.budget.current).toBe(0);
  });
});

// ─── (e) Letting a test gate again ───────────────────────────────────────────

describe('un-quarantining', () => {
  it('clears the flag AND the expiry, and does not consult the budget', async () => {
    install([seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW + 5 * DAY) }), ...filler(99)]);

    const { status, body } = await quarantine({ quarantined: false });
    expect(status).toBe(200);
    expect(body.test.quarantined).toBe(false);
    /*
     * A stale expiry on an un-quarantined test is a row that contradicts
     * itself, and the next reader has to decide which half to believe.
     */
    expect(body.test.quarantineExpiresAt).toBeNull();
    expect(storedTest().quarantineExpiresAt).toBeNull();
    expect(storedTest().quarantinedAt).toBeNull();

    // Switching a signal back ON is never rationed, so there is no budget on
    // the response and nothing was counted.
    expect(body.budget).toBeNull();
    expect(h.ops.filter((o) => o.op === 'test.count')).toEqual([]);
    expect(h.audits.at(-1)!.action).toBe('test.unquarantine');
  });

  it('works even on a project that is over its cap', async () => {
    install([
      seedTest({ quarantined: true, quarantineExpiresAt: new Date(NOW + DAY) }),
      ...filler(9, { quarantined: true, quarantineExpiresAt: new Date(NOW + DAY) }),
      ...filler(90),
    ]);

    expect((await quarantine({ quarantined: false })).status).toBe(200);
    expect(storedTest().quarantined).toBe(false);
  });

  it('reads anything that is not the string "false" as quarantine', async () => {
    // `String(req.body?.quarantined ?? 'true') !== 'false'`: the default is to
    // quarantine, which is what the button on the screen means.
    install([seedTest(), ...filler(99)]);
    expect((await quarantine({})).body.test.quarantined).toBe(true);

    install([seedTest({ quarantined: true }), ...filler(99)]);
    expect((await quarantine({ quarantined: 'false' })).body.test.quarantined).toBe(false);
  });
});

// ─── (f) Tenancy, and the two ids off the URL ────────────────────────────────

describe('org isolation', () => {
  it('cannot quarantine another org’s test, and says "not found" rather than "no"', async () => {
    install([seedTest({ orgId: 'org_2', projectId: 'proj_1' }), ...filler(99)]);
    asOrg('org_1');

    const { status, body } = await quarantine();
    // 404, not 403: "does not exist" and "exists but not yours" must be
    // indistinguishable or the API becomes an existence oracle.
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(storedTest().quarantined).toBe(false);
    expect(h.audits).toEqual([]);
  });

  it('refuses a test that belongs to a different project in the same org', async () => {
    /*
     * Both ids come off the URL and only one of them is a database key, so the
     * project id is checked against the row. Without that check, a member of an
     * org could quarantine any test in it through any project's URL — which
     * would also mean the budget was measured against the wrong suite.
     */
    install([seedTest({ projectId: 'proj_other' }), ...filler(99)]);

    expect((await quarantine()).status).toBe(404);
    expect(storedTest().quarantined).toBe(false);
  });

  it('measures the budget inside the caller’s own tenant scope', async () => {
    /*
     * There is deliberately no `orgId` in any `where` in the route; the scoped
     * client injects it. If a query here were switched to `unscoped(...)`, the
     * count would include the other org's quarantines and this project would be
     * refused for somebody else's suppressions. Nothing else in the repo would
     * notice.
     */
    install([
      seedTest(),
      ...filler(9),
      ...Array.from({ length: 50 }, (_, i) =>
        seedTest({
          id: `theirs_${i}`,
          orgId: 'org_2',
          quarantined: true,
          quarantineExpiresAt: new Date(NOW + 5 * DAY),
        }),
      ),
    ]);

    const { status, body } = await quarantine();
    expect(status).toBe(200);
    expect(body.budget.current).toBe(0);
    // The denominator is this org's ten, not the sixty rows in the table.
    expect(body.budget.limit).toBe(QUARANTINE_BUDGET_FLOOR);
  });

  it('needs more than a viewer to switch a signal off', async () => {
    install([seedTest(), ...filler(99)]);
    asOrg('org_1', 'VIEWER');

    expect((await quarantine()).status).toBe(403);
    expect(storedTest().quarantined).toBe(false);
  });
});
