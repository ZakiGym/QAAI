/**
 * `POST /coverage/:projectId/propose` — THE HUMAN DOOR INTO THE CLOSURE LOOP.
 *
 * ── The defect these tests exist for ────────────────────────────────────────
 *
 * This endpoint already knew which plan item was minted for which gap: it mints
 * the row ids itself and returns `mapping: [{ gapId, planItemId }]` in the HTTP
 * response. That mapping existed for the length of one request and was then
 * thrown away. So QAAI could never afterwards say "this gap is closed by this
 * test" — and, much worse, could never notice that it is NOT: a gap whose test
 * was written, bound and passed, and which the next analysis reports again, was
 * indistinguishable from a gap nobody had ever looked at.
 *
 * The closure campaign writes all of this on every tick, so the AUTOPILOT's
 * proposals were auditable and a human's were not. The loop the product is sold
 * on had memory for one of its two doors.
 *
 * Harness: the same shape as projects.quarantine.test.ts — a mocked prisma
 * module with a REAL AsyncLocalStorage tenant scope, and the real router driven
 * over a loopback socket. The coverage ANALYSIS is real, deliberately: it calls
 * no model, and a stubbed report would make the thing under test unobservable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  enqueued: Row[];
  /** Mutated per test: the deployment with and without a model key. */
  env: Row;
  /** Set to make the ledger write throw, so a failure cannot pass unnoticed. */
  closureThrows: Error | null;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  enqueued: [],
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    ANTHROPIC_API_KEY: '',
  },
  closureThrows: null,
}));

vi.mock('../env.js', () => ({ env: h.env, isProd: false }));

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
    prisma: new Proxy({}, { get: (_t, key: string) => (h.prisma as Row)[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({
  enqueue: async (queue: string, payload: Row) => {
    h.enqueued.push({ queue, payload });
    return 'job_1';
  },
}));

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

// ─── The crawl this report is computed from ──────────────────────────────────

/**
 * A three-page crawl with no tests over it, which is the shape that produces
 * gaps without needing a model, a database or a browser.
 *
 * Deliberately small: the gap VOCABULARY is packages/agent's own suite to pin,
 * and what matters here is that a real report comes out, that the ids in it are
 * stable, and that proposing one writes the provenance down.
 */
function crawl(): Row {
  const node = (id: string, route: string, over: Row = {}): Row => ({
    id,
    route,
    url: `https://shop.test${route}`,
    title: route,
    stateKey: 'default',
    requiresRoles: [],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
    ...over,
  });

  return {
    projectId: 'proj_1',
    environmentId: 'env_1',
    version: 4,
    baseUrl: 'https://shop.test',
    exploredAt: '2026-10-01T00:00:00.000Z',
    truncatedReason: null,
    nodes: [
      node('n-home', '/', {
        affordances: [
          {
            label: 'Shop now',
            selector: { strategy: 'ROLE', value: 'link', name: 'Shop now', confidence: 0.9 },
            kind: 'link',
          },
        ],
      }),
      node('n-cart', '/cart', {
        affordances: [
          {
            label: 'Check out',
            selector: { strategy: 'ROLE', value: 'button', name: 'Check out', confidence: 0.9 },
            kind: 'button',
          },
        ],
      }),
      node('n-checkout', '/checkout', {
        forms: [
          {
            id: 'form-Payment',
            name: 'Payment',
            selector: { strategy: 'CSS', value: 'form', confidence: 0.7 },
            submit: {
              strategy: 'ROLE',
              value: 'button',
              name: 'Place order',
              confidence: 0.9,
            },
            fields: [
              {
                name: 'card_number',
                label: 'Card number',
                inputType: 'text',
                required: true,
                selector: {
                  strategy: 'LABEL',
                  value: 'Card number',
                  name: 'Card number',
                  confidence: 0.9,
                },
                semantic: 'credit_card',
              },
            ],
          },
        ],
        affordances: [
          {
            label: 'Place order',
            selector: { strategy: 'ROLE', value: 'button', name: 'Place order', confidence: 0.9 },
            kind: 'button',
          },
        ],
      }),
    ],
    edges: [
      { id: 'e1', from: 'n-home', to: 'n-cart', action: 'click "Shop now"', selector: null },
      { id: 'e2', from: 'n-cart', to: 'n-checkout', action: 'click "Check out"', selector: null },
    ],
    journeys: [
      {
        id: 'j-buy',
        name: 'Buy something',
        description: 'Home, cart, pay',
        edgeIds: ['e1', 'e2'],
        priority: 'CRITICAL_PATH',
        roles: [],
      },
    ],
    features: [
      { name: 'Checkout', nodeIds: ['n-cart', 'n-checkout'] },
      { name: 'Marketing', nodeIds: ['n-home'] },
    ],
  };
}

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

interface Store {
  project: Row[];
  test: Row[];
  flowMap: Row[];
  authProfile: Row[];
  /** `TestPlan` rows this request created, with their nested items. */
  plans: Row[];
  /** The closure ledger, keyed `projectId|gapId` — the unique the upsert uses. */
  closures: Map<string, Row>;
}

let store: Store;

function install(over: Partial<Store> = {}): void {
  store = {
    project: [{ id: 'proj_1', orgId: 'org_1' }],
    test: [],
    flowMap: [
      {
        id: 'fm_1',
        orgId: 'org_1',
        projectId: 'proj_1',
        version: 4,
        environmentId: 'env_1',
        graph: crawl(),
      },
    ],
    authProfile: [],
    plans: [],
    closures: new Map(),
    ...over,
  };

  h.prisma = {
    project: {
      findUnique: async (args: Row = {}) => {
        const orgId = h.currentOrg();
        const found = store.project.find((row) => row.id === args.where?.id);
        if (!found) return null;
        if (orgId && found.orgId !== orgId) return null;
        return { id: found.id };
      },
    },
    test: { findMany: async () => store.test.map((row) => ({ ...row })) },
    flowMap: { findFirst: async () => ({ ...store.flowMap[0] }) },
    authProfile: { findMany: async () => store.authProfile.map((row) => ({ ...row })) },
    testPlan: {
      create: async (args: Row) => {
        const items = (args.data.items?.create ?? []) as Row[];
        const plan = { id: `plan_${store.plans.length + 1}`, ...args.data, items };
        store.plans.push(plan);
        /*
         * The `include` the route asks for, honoured — it reads `plan.items`
         * back onto the response, so a fake that returned no items would make
         * every assertion about the response vacuous.
         */
        return {
          ...plan,
          items: items.map((item) => ({
            id: item.id,
            title: item.title,
            priority: item.priority,
            testType: item.testType,
          })),
        };
      },
    },
    gapClosure: {
      upsert: async (args: Row) => {
        if (h.closureThrows) throw h.closureThrows;
        const { projectId, gapId } = args.where.projectId_gapId as {
          projectId: string;
          gapId: string;
        };
        const key = `${projectId}|${gapId}`;
        const existing = store.closures.get(key);
        if (existing) {
          /*
           * Prisma's upsert semantics, faithfully: the UPDATE branch, and only
           * the keys it names. A fake that replaced the row would hide the one
           * property this upsert exists for — a gap seen before keeps its
           * history and its `reopenCount`.
           */
          Object.assign(existing, args.update);
          return { ...existing };
        }
        const row = { id: `gc_${store.closures.size + 1}`, ...args.create };
        store.closures.set(key, row);
        return { ...row };
      },
    },
  };
}

/** The items of the LATEST plan this request created. */
const planItems = (): Row[] => (store.plans[store.plans.length - 1]?.items ?? []) as Row[];
const closure = (gapId: string, projectId = 'proj_1'): Row | undefined =>
  store.closures.get(`${projectId}|${gapId}`);

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { coverageRouter } = await import('./coverage.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/coverage', coverageRouter);
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

/** The report, so a test can take real gap ids rather than invent them. */
async function report(): Promise<{ gaps: Row[]; fingerprint: string }> {
  const { status, body } = await call('GET', '/coverage/proj_1');
  expect(status).toBe(200);
  return { gaps: body.gaps as Row[], fingerprint: String(body.fingerprint) };
}

const propose = (gapIds: string[], fingerprint?: string) =>
  call('POST', '/coverage/proj_1/propose', { gapIds, ...(fingerprint ? { fingerprint } : {}) });

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits.length = 0;
  h.enqueued.length = 0;
  h.env.ANTHROPIC_API_KEY = '';
  h.closureThrows = null;
  install();
});

// ─── (a) The provenance the request used to throw away ───────────────────────

describe('a human proposing tests for gaps', () => {
  it('writes the gap id and kind onto every plan item it mints', async () => {
    const { gaps } = await report();
    expect(gaps.length).toBeGreaterThan(0);
    const chosen = gaps.slice(0, 2);

    const { status } = await propose(chosen.map((gap) => String(gap.id)));

    expect(status).toBe(200);
    expect(planItems()).toHaveLength(chosen.length);
    for (const gap of chosen) {
      const item = planItems().find((row) => row.gapId === gap.id);
      /*
       * The column, not the response. The mapping was already in the response
       * and that is exactly what made the defect invisible: the answer existed
       * for one request and then nowhere.
       */
      expect(item).toBeDefined();
      // `gapId` is a hash of (kind, subject) and tells a human nothing, so the
      // kind rides beside it.
      expect(item!.gapKind).toBe(gap.kind);
    }
  });

  it('records a PROPOSED row in the closure ledger for each gap', async () => {
    const { gaps } = await report();
    const chosen = String(gaps[0]!.id);

    const { status, body } = await propose([chosen]);

    expect(status).toBe(200);
    const row = closure(chosen);
    expect(row).toBeDefined();
    expect(row!.state).toBe('PROPOSED');
    expect(row!.gapKind).toBe(gaps[0]!.kind);
    expect(row!.gapTitle).toBe(gaps[0]!.title);
    // The plan item is named, so the ledger can later ask whether its test
    // landed and whether the gap actually closed.
    expect(row!.planItemId).toBe(planItems()[0]!.id);
    expect(row!.proposedAt).toBeInstanceOf(Date);
    expect(row!.lastCheckedAt).toBeInstanceOf(Date);
    /*
     * `campaignId` is what keeps the two doors apart: the column is documented
     * as "the campaign that last worked on it. Null for a gap recorded by a
     * human clicking propose rather than by the autopilot."
     */
    expect(row!.campaignId ?? null).toBeNull();
    // And the caller is told how much of the memory landed.
    expect(body.closureLedger).toEqual({ recorded: 1, failed: 0 });
  });

  it('keeps a gap’s history when the same gap is proposed again', async () => {
    /*
     * The upsert is keyed on (projectId, gapId). A gap seen before keeps its
     * `reopenCount` and its `testId`: minting a second row would reset exactly
     * the counter that says "your generator keeps producing a test that does
     * not close this", and clearing `testId` would forget the test that was
     * written for it last time.
     */
    const { gaps } = await report();
    const chosen = String(gaps[0]!.id);

    await propose([chosen]);
    const first = closure(chosen)!;
    first.reopenCount = 3;
    first.testId = 'test_from_last_time';

    await propose([chosen]);

    const again = closure(chosen)!;
    expect(store.closures.size).toBe(1);
    expect(again.reopenCount).toBe(3);
    expect(again.testId).toBe('test_from_last_time');
    expect(again.state).toBe('PROPOSED');
    expect(String(again.why)).toMatch(/Re-proposed by hand/);
    // The NEW plan item, because this is a new proposal for the same gap.
    expect(again.planItemId).toBe(planItems()[0]!.id);
  });

  it('counts a ledger write it could not make, rather than swallowing it', async () => {
    /*
     * The plan is the deliverable and it is already written by the time the
     * ledger is touched: the gaps, the steps read off the crawl and the
     * assertions are complete and worth having. So a failure here costs the
     * MEMORY and not the work — and it is REPORTED, because a ledger that
     * quietly missed three rows is a ledger that will later report three gaps
     * nobody ever proposed anything for.
     */
    const { gaps } = await report();
    h.closureThrows = new Error('the ledger is unavailable');

    const { status, body } = await propose([String(gaps[0]!.id)]);

    expect(status).toBe(200);
    expect(body.testPlanId).toBeDefined();
    expect(body.closureLedger).toEqual({ recorded: 0, failed: 1 });
    // And the audit row carries it, so somebody can find out later why the gap
    // has no history.
    expect(h.audits[0]!.metadata).toMatchObject({ closuresRecorded: 0, closuresFailed: 1 });
  });

  it('still records the provenance on the queued path, with a model key set', async () => {
    h.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { gaps } = await report();
    const chosen = String(gaps[0]!.id);

    const { status, body } = await propose([chosen]);

    expect(status).toBe(202);
    expect(h.enqueued).toHaveLength(1);
    // The two halves that must not depend on each other: generation is queued,
    // AND the provenance is on the item and in the ledger either way.
    expect(planItems()[0]!.gapId).toBe(chosen);
    expect(closure(chosen)!.state).toBe('PROPOSED');
    expect(body.closureLedger).toEqual({ recorded: 1, failed: 0 });
    expect(h.audits[0]!.metadata).toMatchObject({ closuresRecorded: 1, queued: true });
  });

  it('writes nothing at all for a request it refused', async () => {
    /*
     * A stale selection is a conflict, not a plan. The gaps were probably
     * closed by a test somebody has since added, and minting plan items for
     * them would hand the Generator work the suite has already done.
     */
    const { status } = await propose(['gap_that_is_not_in_the_report']);

    expect(status).toBe(409);
    expect(store.plans).toEqual([]);
    expect(store.closures.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('refuses a selection taken from a stale report', async () => {
    const { gaps } = await report();

    const { status } = await propose([String(gaps[0]!.id)], 'a-fingerprint-from-ten-minutes-ago');

    expect(status).toBe(409);
    expect(store.closures.size).toBe(0);
  });

  it('accepts the fingerprint from the report it was read off', async () => {
    const { gaps, fingerprint } = await report();

    const { status } = await propose([String(gaps[0]!.id)], fingerprint);

    expect(status).toBe(200);
    expect(store.closures.size).toBe(1);
  });

  it('mints one item per gap when the same id arrives twice', async () => {
    // A "select all" over a list that showed the same finding twice. Honouring
    // both would hand the Generator the same work twice.
    const { gaps } = await report();
    const chosen = String(gaps[0]!.id);

    await propose([chosen, chosen]);

    expect(planItems()).toHaveLength(1);
    expect(store.closures.size).toBe(1);
  });
});
