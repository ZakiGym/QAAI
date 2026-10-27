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
  /**
   * `TestResult` rows. The report joins them so a test that never ran, one
   * that always fails and one that is quarantined stop closing a gap
   * identically — so a fake with no results is the "nobody has ever run this
   * suite" case and has to be a real, seedable one rather than an omission.
   */
  testResult: Row[];
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
    testResult: [],
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
    test: {
      /*
       * HONOURS `select`, like every other delegate in this fake.
       *
       * The route reads Test twice with two different selects — the full
       * coverage set, and `{id, quarantined, quarantineExpiresAt}` for the
       * quarantine join — and a select-blind fake would make deleting
       * `quarantineExpiresAt` from the second query undetectable, which is
       * exactly the class of defect that survived a whole slice here before.
       */
      findMany: async (args: Row = {}) =>
        store.test
          .filter((row) => (args.where?.quarantined === true ? row.quarantined === true : true))
          .map((row) => pick(row, args.select as Record<string, true> | undefined)),
      aggregate: async () => ({
        _count: { id: store.test.length },
        _max: {
          updatedAt: store.test.reduce<Date | null>((newest, row) => {
            const at = row.updatedAt as Date | undefined;
            if (!at) return newest;
            return newest === null || at > newest ? at : newest;
          }, null),
        },
      }),
    },
    testResult: {
      findMany: async (args: Row = {}) =>
        [...store.testResult]
          // The route depends on newest-first: the FIRST sighting of a test is
          // taken as its latest result, so a fake that ignored `orderBy` would
          // let an older row win and the assertion would pass for the wrong
          // reason.
          .sort((left, right) =>
            String(right.createdAt?.toISOString?.() ?? '').localeCompare(
              String(left.createdAt?.toISOString?.() ?? ''),
            ),
          )
          .map((row) => pick(row, args.select as Record<string, true> | undefined)),
      count: async () => store.testResult.length,
    },
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

/**
 * `select`, honoured. Returns the whole row when no select is given, exactly as
 * Prisma does, and ONLY the named keys when one is.
 *
 * A fake that ignores `select` makes dropping a field from a query undetectable
 * — the handler reads `row.retriedAndPassed`, the fake hands back every column
 * it holds, and a select that no longer asks for it passes anyway. Two defects
 * survived a whole slice in this repo behind select-blind fakes.
 */
function pick(row: Row, select: Record<string, true> | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) {
    if (select[key] === true) out[key] = row[key];
  }
  return out;
}

/** The items of the LATEST plan this request created. */
const planItems = (): Row[] => (store.plans[store.plans.length - 1]?.items ?? []) as Row[];
const closure = (gapId: string, projectId = 'proj_1'): Row | undefined =>
  store.closures.get(`${projectId}|${gapId}`);

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { coverageRouter, resetCoverageCache } = await import('./coverage.js');
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
  /*
   * The report cache is module-level and keyed on the project's INPUTS, so two
   * tests that seed the same shape would have the second served the first's
   * report — and the suite would pass or fail depending on the order vitest
   * happened to run them in. Clearing it is what makes every test below a
   * statement about its own fixture.
   */
  resetCoverageCache();
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

// ─── (c) The page, cut AFTER the filters ─────────────────────────────────────

/**
 * Register item 8. `limit` was passed straight into `analyzeCoverage`, which
 * sliced the ranked list BEFORE this handler applied `kind` and `minScore`. A
 * project with 800 untested controls could never name more than 300 of them,
 * and a filtered list was wrong as well as short: a reader asking for
 * UNSUBMITTED_FORM got whichever forms fell inside the top 300 by score, with
 * no indication that any others existed.
 */
describe('paging the uncovered list', () => {
  const get = (query = '') => call('GET', `/coverage/proj_1${query}`);

  it('reports the filtered count, not the length of the page', async () => {
    const all = await get();
    const total = (all.body.totals as Row).gaps as number;
    expect(total).toBeGreaterThan(2);

    const paged = await get('?limit=2');
    expect((paged.body.gaps as Row[]).length).toBe(2);
    // `matched` is the whole filtered list; `gaps.length` is the window.
    expect((paged.body.page as Row).matched).toBe(total);
    expect((paged.body.page as Row).returned).toBe(2);
    expect((paged.body.page as Row).hasMore).toBe(true);
  });

  it('applies the kind filter BEFORE the page, so the filtered list is complete', async () => {
    const all = await get('?limit=1');
    const firstKind = String(((all.body.gaps as Row[])[0] ?? {}).kind);

    const filtered = await get(`?kind=${firstKind}&limit=1`);
    const matched = (filtered.body.page as Row).matched as number;
    const everyOfThatKind = ((await get()).body.gaps as Row[]).filter(
      (gap) => gap.kind === firstKind,
    ).length;
    // The count the caller is told is the count of gaps OF THAT KIND, which is
    // only true if the filter ran before the slice.
    expect(matched).toBe(everyOfThatKind);
  });

  it('walks the whole list with nextCursor, and says when it has ended', async () => {
    const total = ((await get()).body.totals as Row).gaps as number;
    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded by `total + 1` so a cursor that never advances fails the test
    // rather than hanging it.
    for (let page = 0; page <= total; page += 1) {
      const { status, body } = await get(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(status).toBe(200);
      for (const gap of body.gaps as Row[]) seen.push(String(gap.id));
      cursor = ((body.page as Row).nextCursor as string | null) ?? null;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('refuses a cursor that is not in the current filtered list', async () => {
    const { status, body } = await get('?cursor=gap_that_never_existed');
    // NOT an empty page: an unknown cursor means the report moved under the
    // caller, and `[]` reads exactly like "you have reached the end".
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toMatch(/cursor/i);
  });

  it('says in the payload that the filters run before the page', async () => {
    const { body } = await get();
    expect(String((body.page as Row).rule)).toContain('BEFORE this page is cut');
  });

  it('builds proposals for the page only, not for every gap in the project', async () => {
    const { body } = await get('?limit=1&proposals=true');
    const gaps = body.gaps as Row[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toHaveProperty('proposal');
  });
});

// ─── (d) The number's age, always on the response ───────────────────────────

describe('the cached report says how old it is', () => {
  it('reports a miss on the first read and a hit on the second', async () => {
    const first = await call('GET', '/coverage/proj_1');
    expect((first.body.cache as Row).hit).toBe(false);
    expect((first.body.cache as Row).ageMs).toBe(0);

    const second = await call('GET', '/coverage/proj_1');
    expect((second.body.cache as Row).hit).toBe(true);
    expect(String((second.body.cache as Row).computedAtIso)).toMatch(/^\d{4}-/);
  });

  it('recomputes when a test lands, without waiting for a TTL', async () => {
    await call('GET', '/coverage/proj_1');
    // The entry is keyed on the project's INPUTS, not on a clock: a team that
    // writes a test must see the number move, which is the only thing this
    // screen is for.
    store.test.push({
      id: 'tst_new',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'new',
      filePath: 'specs/new.spec.ts',
      code: null,
      spec: null,
      tags: [],
      feature: null,
      priority: 'IMPORTANT',
      type: 'E2E',
      authProfileId: null,
      authProfileRequired: false,
      disabledAt: null,
      updatedAt: new Date(),
    });
    const after = await call('GET', '/coverage/proj_1');
    expect((after.body.cache as Row).hit).toBe(false);
    expect(String((after.body.cache as Row).why)).toContain('inputs that have since changed');
  });

  it('recomputes on ?cache=false, and says that is why', async () => {
    await call('GET', '/coverage/proj_1');
    const forced = await call('GET', '/coverage/proj_1?cache=false');
    expect((forced.body.cache as Row).hit).toBe(false);
    expect(String((forced.body.cache as Row).why)).toContain('?cache=false');
  });

  it('names the inputs that invalidate it, so the age is interpretable', async () => {
    const { body } = await call('GET', '/coverage/proj_1');
    expect(String((body.cache as Row).keyedOn)).toContain('TestResult count');
  });
});

// ─── (e) The quarantine join, end to end through the route ──────────────────

describe('the report joins TestResult, so three screens stop disagreeing', () => {
  /** A test that covers `/products`, with a result and an optional quarantine. */
  function seedCoveringTest(over: Row = {}): void {
    store.test.push({
      id: 'tst_cov',
      orgId: 'org_1',
      projectId: 'proj_1',
      name: 'cart',
      filePath: 'specs/cart.spec.ts',
      code: `await page.goto('/cart');`,
      spec: null,
      tags: [],
      feature: null,
      priority: 'IMPORTANT',
      type: 'E2E',
      authProfileId: null,
      authProfileRequired: false,
      disabledAt: null,
      updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      quarantined: false,
      quarantineExpiresAt: null,
      ...over,
    });
    store.testResult.push({
      id: 'res_1',
      orgId: 'org_1',
      testId: 'tst_cov',
      runId: 'run_1',
      status: 'PASSED',
      retriedAndPassed: false,
      createdAt: new Date('2026-10-03T00:00:00.000Z'),
    });
  }

  const gapRoutes = (body: Row): string[] =>
    (body.gaps as Row[]).filter((gap) => gap.kind === 'UNVISITED_ROUTE').map((gap) => String(gap.route));

  it('closes the gap for a live test that ran', async () => {
    seedCoveringTest();
    const { body } = await call('GET', '/coverage/proj_1?limit=300');
    expect(gapRoutes(body)).not.toContain('/cart');
  });

  it('leaves the gap open when that same test is quarantined', async () => {
    seedCoveringTest({ quarantined: true });
    const { body } = await call('GET', '/coverage/proj_1?limit=300');
    // The result is suppressed from every gate rule, so coverage attributed to
    // it is coverage nothing will ever check.
    expect(gapRoutes(body)).toContain('/cart');
    expect((body.ledger as Row).coveredOnlyByQuarantined).toBe(1);
  });

  it('closes it again once the quarantine has EXPIRED, because an expired one gates', async () => {
    seedCoveringTest({
      quarantined: true,
      quarantineExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const { body } = await call('GET', '/coverage/proj_1?limit=300');
    expect(gapRoutes(body)).not.toContain('/cart');
  });

  it('names the covering test on the ledger row', async () => {
    seedCoveringTest();
    const { body } = await call('GET', '/coverage/proj_1?limit=300');
    const row = (body.ledger as Row).items as Row[];
    const products = row.find((item) => item.key === 'ROUTE:/cart');
    expect(products?.testIds).toEqual(['tst_cov']);
    expect((products?.execution as Row).lastStatus).toBe('PASSED');
  });
});

// ─── (f) Provenance: null is not an empty aggregate ─────────────────────────

describe('the provenance aggregate', () => {
  it('answers NULL rather than zeroes when the table cannot be read', async () => {
    // This fake holds no `testCoverageEdge` delegate, which is the same state
    // as a deployment where the migration has not been applied. "We cannot
    // answer" must not render as "this project has no evidence behind its
    // number", which is the opposite of the truth.
    const { body } = await call('GET', '/coverage/proj_1');
    expect(body.provenance).toBeNull();
  });
});

// ─── (g) The mount, and the parser ordering it depends on ───────────────────

/**
 * ── WHY THIS LIVES IN THIS FILE ─────────────────────────────────────────────
 *
 * `apps/api/src/index.ts` has no test anywhere in this repo: every router test
 * builds its own express app, so nothing proves a router is mounted and a
 * mutation that deletes `app.use(codeCoverageRouter)` is caught only by
 * `npx tsx scripts/check-wiring.ts` — a gate, not a test. I own index.ts's
 * mounting this round and not an index test, so the assertion goes here, with
 * the reason, rather than nowhere.
 *
 * It reads the SOURCE. That is the same mechanism `apps/api/scripts/
 * check-enums.ts` uses, and it is the only one available: importing index.ts
 * starts a server, a Redis connection and a metrics registry.
 */
describe('the code-coverage router is mounted, and its body limit is reachable', () => {
  const indexSource = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    return readFile(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
  };

  it('mounts it at the root, because the router declares its own full paths', async () => {
    const source = await indexSource();
    expect(source).toContain("import { codeCoverageRouter } from './routes/code-coverage.js';");
    // No prefix: a prefix here would serve `/code-coverage/:projectId` at
    // `/code-coverage/code-coverage/:projectId`.
    expect(source).toContain('app.use(codeCoverageRouter);');
    expect(source).not.toContain("app.use('/code-coverage', codeCoverageRouter)");
  });

  it('puts the 16mb parser BEFORE the global 2mb one, or the limit is unreachable', async () => {
    const source = await indexSource();
    const scoped = source.indexOf("app.use('/code-coverage', express.json({ limit: '16mb' }))");
    const global = source.indexOf("app.use(express.json({ limit: '2mb' }))");
    expect(scoped).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(-1);
    /*
     * body-parser SKIPS once `req._body` is set, so a router-level parser
     * mounted after the global one can never raise the limit. Get this order
     * wrong and `CODE_COVERAGE_CAPS.payloadBytes` (16MB) is an allowance
     * nobody can use while the door advertises eight times its real ceiling —
     * a cap that bit without being disclosed, in the one place a customer's
     * real `coverage-final.json` lands.
     */
    expect(scoped).toBeLessThan(global);
  });
});

describe('the kind filter’s vocabulary comes from GAP_KINDS', () => {
  it('accepts every kind the analysis can emit, including the destructive class', async () => {
    const { GAP_KINDS } = await import('@qaai/agent');
    for (const kind of GAP_KINDS) {
      const { status, body } = await call('GET', `/coverage/proj_1?kind=${kind}`);
      // A hand-written copy of this list had already drifted:
      // UNEXERCISABLE_SURFACE was in GAP_KINDS and not in the filter's set, so
      // filtering for the one class whose members are selected FOR being
      // destructive answered 400 "unknown gap kind" against a report that can
      // contain them.
      expect({ kind, status }).toEqual({ kind, status: 200 });
      expect(body.page).toBeDefined();
    }
  });

  it('still refuses a name that is in no vocabulary at all', async () => {
    const { status, body } = await call('GET', '/coverage/proj_1?kind=NOT_A_KIND');
    // A typo'd filter that silently returned nothing reads exactly like "you
    // have no gaps of that kind", which is the one wrong answer this endpoint
    // can give.
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('NOT_A_KIND');
  });
});
