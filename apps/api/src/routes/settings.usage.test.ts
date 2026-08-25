/**
 * Tests for GET /settings/usage, which now aggregates in the database instead
 * of loading every AgentCall row of the window and adding the columns up in
 * JavaScript.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. THE NUMBERS DID NOT CHANGE. This is a rewrite of arithmetic that people
 *      reconcile against an invoice, so every expected value below is written
 *      out by hand from the fixture rows — not computed by summing the same
 *      fixtures with the same expressions the route uses, which would prove
 *      only that a loop can be run twice. The three places the old loop had an
 *      opinion are each pinned by their own case: cache reads are folded into
 *      inputTokens, `failures` counts rows with an error rather than counting
 *      rows, and the list comes back most expensive first.
 *
 *   2. IT IS TENANT-SCOPED. `groupBy` is a different Prisma operation from
 *      `findMany`, and it is scoped by the same extension only because it is on
 *      that extension's FILTERABLE list — a fact nothing else in the repo
 *      tests. Both aggregates are driven from two orgs whose calls interleave,
 *      and every number differs between them, so a query that escaped the scope
 *      shows up as one org reporting the other's spend.
 *
 *   3. IT AGGREGATES RATHER THAN LOADING. That is the entire point: a 30-day
 *      window on a busy org is hundreds of thousands of rows. The fake offers
 *      no `findMany` on AgentCall at all, so a regression to loading rows
 *      throws instead of passing slowly.
 *
 *   4. THE WINDOW IS HONOURED, and its cap. `days` comes off the query string;
 *      rows outside it must not be counted, and 365 must clamp to 90.
 *
 * Harness: same shape as projects.tree.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  ops: string[];
  /** The `where` of every groupBy the route issued, for the window assertions. */
  wheres: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'OWNER', ip: null },
  ops: [],
  wheres: [],
}));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    QAAI_MONTHLY_TOKEN_BUDGET: 5_000_000,
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

/* nodemailer opens a transport at import time; nothing here sends mail. */
vi.mock('../lib/mail.js', () => ({
  inviteMail: () => ({ subject: '', text: '' }),
  mailDriver: () => 'console',
  sendMail: async () => ({ driver: 'console' as const }),
}));

vi.mock('../lib/audit.js', () => ({
  audit: async () => {},
  auditRowsToCsv: () => '',
}));

/*
 * The tenancy scope is real, not stubbed: the route's queries run in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and the org-isolation test would pass for a
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

vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const KNOWN_FILTERS = new Set(['orgId', 'createdAt', 'error']);

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('gte' in c) return (value as Date).getTime() >= (c.gte as Date).getTime();
    // `{ not: null }` is how "this call failed" is spelled, and getting it
    // backwards would count every SUCCESSFUL call as a failure.
    if ('not' in c) return (value ?? null) !== (c.not ?? null);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS.has(key)) throw new Error(`fake prisma: unsupported filter ${key}`);
    return matchesCondition(row[key] ?? null, cond);
  });
}

interface Store {
  agentCall: Row[];
  usageRecord: Row[];
}

function makeDb(store: Store): Row {
  const scopedWhere = (where: Row = {}): Row => {
    const orgId = h.currentOrg();
    return orgId ? { ...where, orgId } : { ...where };
  };

  return {
    agentCall: {
      findMany: async () => {
        throw new Error('fake prisma: agentCall.findMany — usage must aggregate in the database');
      },
      /**
       * A real groupBy: it partitions the SCOPED rows and returns only the
       * aggregates that were asked for. Returning every aggregate regardless
       * would let a route that summed the wrong column pass.
       */
      groupBy: async ({ by, where, _count, _sum }: Row = {}) => {
        h.ops.push('agentCall.groupBy');
        h.wheres.push(scopedWhere(where));
        const rows = store.agentCall.filter((row) => matchesWhere(row, scopedWhere(where)));
        const groups = new Map<string, Row>();
        for (const row of rows) {
          const key = (by as string[]).map((field) => String(row[field])).join(' ');
          let group = groups.get(key);
          if (!group) {
            group = {};
            for (const field of by as string[]) group[field] = row[field];
            if (_count) group._count = { _all: 0 };
            if (_sum) group._sum = Object.fromEntries(Object.keys(_sum).map((f) => [f, 0]));
            groups.set(key, group);
          }
          if (_count) group._count._all += 1;
          for (const field of Object.keys((_sum ?? {}) as Row)) {
            group._sum[field] += row[field] as number;
          }
        }
        /*
         * Deliberately the WRONG order: cheapest first. Prisma's groupBy makes
         * no promise about row order, so the route has to sort — and a fake
         * that happened to hand back the order the route wants would let a
         * route that never sorted pass.
         */
        return [...groups.values()].sort(
          (a, b) => ((a._sum?.costCents ?? 0) as number) - ((b._sum?.costCents ?? 0) as number),
        );
      },
    },
    usageRecord: {
      findUnique: async ({ where = {} }: Row = {}) => {
        h.ops.push('usageRecord.findUnique');
        const key = where.orgId_metric_period as Row | undefined;
        if (!key) throw new Error('fake prisma: usageRecord.findUnique needs the compound key');
        const found = store.usageRecord.find(
          (row) =>
            row.orgId === key.orgId &&
            row.metric === key.metric &&
            row.period.getTime() === (key.period as Date).getTime(),
        );
        if (!found) return null;
        const orgId = h.currentOrg();
        if (orgId && found.orgId !== orgId) return null;
        return { ...found };
      },
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000 - 60_000);

function call(over: Row): Row {
  return {
    orgId: 'org_1',
    agent: 'TRIAGE',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costCents: 0,
    error: null,
    createdAt: daysAgo(1),
    ...over,
  };
}

/**
 * Hand-counted, so the expectations below do not come from the code:
 *
 *   org_1, 30-day window
 *     TRIAGE   3 calls · input 100+7 + 200+0 + 50+3 = 360 · output 12 · 7.5c · 1 failure
 *     HEALER   1 call  · input 1000+0             · output 90 · 41.25c · 0 failures
 *     (EXPLORER's only call is 40 days old, and org_2's calls are not org_1's)
 *   org_1 totals: 4 calls, 48.75c
 *
 *   org_2, 30-day window
 *     CHAT     2 calls · input 5+5 = 10 · output 2 · 3c · 2 failures
 *   org_2 totals: 2 calls, 3c
 */
const CALLS: Row[] = [
  call({ agent: 'TRIAGE', inputTokens: 100, cacheReadTokens: 7, outputTokens: 5, costCents: 2.5 }),
  call({ agent: 'TRIAGE', inputTokens: 200, outputTokens: 4, costCents: 2.5, error: 'overloaded' }),
  call({ agent: 'TRIAGE', inputTokens: 50, cacheReadTokens: 3, outputTokens: 3, costCents: 2.5 }),
  call({ agent: 'HEALER', inputTokens: 1000, outputTokens: 90, costCents: 41.25 }),
  // Outside every window this test asks for.
  call({ agent: 'EXPLORER', inputTokens: 9_999, outputTokens: 9_999, costCents: 999, createdAt: daysAgo(40) }),
  call({ orgId: 'org_2', agent: 'CHAT', inputTokens: 5, outputTokens: 1, costCents: 1.5, error: 'timeout' }),
  call({ orgId: 'org_2', agent: 'CHAT', inputTokens: 5, outputTokens: 1, costCents: 1.5, error: 'timeout' }),
];

const PERIOD = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
);

const USAGE_RECORDS: Row[] = [
  { orgId: 'org_1', metric: 'agent_tokens', period: PERIOD, quantity: 1_234n },
  { orgId: 'org_2', metric: 'agent_tokens', period: PERIOD, quantity: 99n },
];

function install(): void {
  h.prisma = makeDb({
    agentCall: CALLS.map((row) => ({ ...row })),
    usageRecord: USAGE_RECORDS.map((row) => ({ ...row })),
  });
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { settingsRouter } = await import('./settings.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/settings', settingsRouter);
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

async function get(path: string): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const asOrg = (orgId: string): void => {
  h.actor = { userId: `user_of_${orgId}`, orgId, role: 'OWNER', ip: null };
};

beforeEach(() => {
  asOrg('org_1');
  h.ops.length = 0;
  h.wheres.length = 0;
  install();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /settings/usage', () => {
  it('reports the same sums the per-row loop produced', async () => {
    const { status, body } = await get('/settings/usage');
    expect(status).toBe(200);
    expect(body.days).toBe(30);
    expect(body.byAgent).toEqual([
      // Most expensive first, and HEALER is second in the fixtures — so this
      // also pins that the route sorts rather than trusting groupBy's order.
      { agent: 'HEALER', calls: 1, inputTokens: 1000, outputTokens: 90, costCents: 41.25, failures: 0 },
      // 360, not 350: cache reads are tokens the org was billed for, and the
      // loop this replaced folded them into inputTokens.
      { agent: 'TRIAGE', calls: 3, inputTokens: 360, outputTokens: 12, costCents: 7.5, failures: 1 },
    ]);
    expect(body.totalCalls).toBe(4);
    expect(body.totalCostCents).toBe(48.75);
    expect(body.monthlyTokenBudget).toBe(5_000_000);
    expect(body.tokensThisMonth).toBe(1234);
  });

  it('counts failures, not calls', async () => {
    // TRIAGE has three calls and one error; a `_count` on the wrong query, or a
    // `not: null` read backwards, gives 3 or 2 here.
    const { body } = await get('/settings/usage');
    const triage = (body.byAgent as Row[]).find((row) => row.agent === 'TRIAGE');
    expect(triage).toBeDefined();
    expect(triage!.calls).toBe(3);
    expect(triage!.failures).toBe(1);
  });

  it('never shows one org the spend of another', async () => {
    const first = (await get('/settings/usage')).body;
    asOrg('org_2');
    const second = (await get('/settings/usage')).body;

    expect(first.byAgent.map((row: Row) => row.agent)).toEqual(['HEALER', 'TRIAGE']);
    expect(second.byAgent).toEqual([
      { agent: 'CHAT', calls: 2, inputTokens: 10, outputTokens: 2, costCents: 3, failures: 2 },
    ]);
    expect(second.totalCalls).toBe(2);
    expect(second.totalCostCents).toBe(3);
    expect(second.tokensThisMonth).toBe(99);

    // org_2's agents, calls, cost and month-to-date all differ from org_1's, so
    // an aggregate that escaped the tenant scope cannot come out looking right.
    expect(second.totalCostCents).not.toBe(first.totalCostCents);
  });

  it('excludes rows outside the window, and clamps the window at 90 days', async () => {
    // The EXPLORER call is 40 days old: inside 90, outside 30.
    const narrow = (await get('/settings/usage?days=30')).body;
    expect(narrow.byAgent.map((row: Row) => row.agent)).toEqual(['HEALER', 'TRIAGE']);

    const wide = (await get('/settings/usage?days=365')).body;
    expect(wide.days).toBe(90);
    expect(wide.byAgent.map((row: Row) => row.agent)).toEqual(['EXPLORER', 'HEALER', 'TRIAGE']);
    expect(wide.totalCalls).toBe(5);
  });

  it('asks both aggregates for the same window', async () => {
    // Two queries with two different `since` values would make `failures`
    // describe a different span from `calls` — a discrepancy nobody would ever
    // reproduce from the UI. 14 days, so a hard-coded 7 or 30 in either query
    // shows up rather than coinciding with what was asked for.
    const before = Date.now();
    await get('/settings/usage?days=14');
    const sinces = h.wheres.map((where) => (where.createdAt.gte as Date).getTime());
    expect(sinces).toHaveLength(2);
    expect(new Set(sinces).size).toBe(1);
    // And it is the window the caller asked for, not some other constant.
    expect(sinces[0]!).toBeGreaterThanOrEqual(before - 14 * 86_400_000 - 5_000);
    expect(sinces[0]!).toBeLessThanOrEqual(Date.now() - 14 * 86_400_000 + 5_000);
  });

  it('aggregates in the database rather than loading the window', async () => {
    await get('/settings/usage');
    // agentCall.findMany would already have thrown inside the fake; this pins
    // that the two groupBys are the whole cost, and that no third query
    // recomputes the totals from a different set of rows.
    expect(h.ops).toEqual(['agentCall.groupBy', 'agentCall.groupBy', 'usageRecord.findUnique']);
  });

  it('reports zeros for an org with no calls at all', async () => {
    asOrg('org_3');
    const { status, body } = await get('/settings/usage');
    expect(status).toBe(200);
    expect(body.byAgent).toEqual([]);
    expect(body.totalCalls).toBe(0);
    expect(body.totalCostCents).toBe(0);
    expect(body.tokensThisMonth).toBe(0);
  });
});
