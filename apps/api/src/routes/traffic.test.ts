/**
 * Tests for the third enumeration source: what real users actually did.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. ENUMERATION IS ACTUALLY PERSISTED. `/analyze` used to compute observed
 *      journeys, real frequencies and a coverage cross-reference and discard
 *      all three with the response. The assertions read the ROWS — the ingest,
 *      the journeys, the `CoverageItem` registry entries — and not the JSON,
 *      because a response that reports a write is not a write.
 *   2. PROVENANCE IS UNIONED AND `origin` IS DERIVED. A route the source
 *      already declared gains TRAFFIC beside SOURCE and becomes BOTH, and keeps
 *      its `file`. Overwriting the file with null would blind the editor link on
 *      the best-evidenced rows in the table, and setting `origin` by hand would
 *      let an item's two provenance fields disagree.
 *   3. EVERY CAP THAT BIT IS DISCLOSED AS A COUNT AND A REASON, and the one cap
 *      that cannot be counted exactly says so (`discardedIsExact: false`)
 *      instead of reporting 0. An undisclosed cap on an ingest makes a coverage
 *      percentage go UP.
 *   4. ABSENCE IS NEVER CONCLUDED FROM A SAMPLED SOURCE. The covered-and-cold
 *      bucket — "these tests are waste" — is WITHHELD unless the source
 *      affirmatively reported itself unsampled. Presence conclusions
 *      (uncovered-and-hot) are always allowed, because the journey was walked.
 *   5. `NEVER_SYNCED` IS NOT "THIS APP HAS NO TRAFFIC". A connector with no
 *      credential reports UNAVAILABLE and stays NEVER_SYNCED; nothing anywhere
 *      reports zero sessions for it.
 *   6. The existing request/response contracts still work — apps/web reads
 *      `journeys`, `totals`, `redaction` and the `/propose` shape.
 *
 * Harness: same shape as integrations.test.ts — a mocked prisma module with a
 * real AsyncLocalStorage tenant scope, real routers driven over a loopback
 * socket. NO NETWORK: the connector readers take an injected transport, and the
 * one test that exercises the real adapter stubs the global fetch.
 *
 * THE FAKE HONOURS `select`. Two defects survived a whole slice behind
 * select-blind fakes, so `project()` below returns only the selected keys and
 * the merge tests depend on it: a `select` that stopped asking for `sources`
 * would make the provenance union silently write `['TRAFFIC']` over
 * `['SOURCE','TRAFFIC']`, and a blind fake would pass.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting can care about it. The
// module itself is imported dynamically further down, after the mocks.
import type { TrafficTransport, TrafficTransportRequest } from './traffic.js';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  enqueued: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
    enqueued: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    // Deliberately absent, which is the deployment this environment is. The
    // generation branch is asserted to stay honest about it.
    ANTHROPIC_API_KEY: undefined,
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

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

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

vi.mock('../lib/audit.js', () => ({
  audit: async (input: unknown) => {
    h.audits.push(input as Row);
  },
}));

vi.mock('../lib/queues.js', () => ({
  enqueue: async (name: string, payload: unknown) => {
    h.enqueued.push({ name, payload });
    return 'job_1';
  },
}));

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'project',
  'test',
  'flowMap',
  'testPlan',
  'planItem',
  'trafficIngest',
  'observedJourney',
  'coverageItem',
  'integration',
] as const;
type ModelName = (typeof MODELS)[number];

function matchOne(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    const filter = cond as Row;
    if ('in' in filter) return (filter.in as unknown[]).includes(value);
    if ('notIn' in filter) return !(filter.notIn as unknown[]).includes(value);
    if ('not' in filter) {
      const inner = filter.not as Row;
      if (inner && typeof inner === 'object' && 'startsWith' in inner) {
        return typeof value === 'string' && !value.startsWith(inner.startsWith as string);
      }
      return value !== filter.not;
    }
    if ('startsWith' in filter) {
      return typeof value === 'string' && value.startsWith(filter.startsWith as string);
    }
    if ('gt' in filter) return (value as number) > (filter.gt as number);
    // Loud on purpose: a fake that shrugs at a filter it does not know passes
    // the tests whose whole point is that the filter is applied.
    throw new Error(`fake prisma: unsupported filter ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (!matchOne(row[key], cond)) return false;
  }
  return true;
}

/**
 * Honours `select`. A `select` that stopped asking for a field would make the
 * reader see `undefined`, which is what the provenance tests depend on.
 */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = row[key];
    else if (value && typeof value === 'object') {
      // A nested select on a relation we do not model: the tests that need one
      // seed it directly, so reaching here is a harness gap worth shouting at.
      out[key] = row[key] ?? null;
    }
  }
  return out;
}

function sortRows(list: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return list;
  const [key, direction] = Object.entries(orderBy)[0]!;
  return [...list].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    const cmp =
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : typeof left === 'number' && typeof right === 'number'
          ? left - right
          : typeof left === 'string' && typeof right === 'string'
            ? left.localeCompare(right)
            : 0;
    return direction === 'desc' ? -cmp : cmp;
  });
}

const DEFAULTS: Record<ModelName, Row> = {
  project: {},
  test: { disabledAt: null, filePath: null, spec: null, code: '' },
  flowMap: { version: 1 },
  testPlan: {},
  planItem: {},
  trafficIngest: {
    environmentId: null,
    integrationId: null,
    entriesSkipped: 0,
    journeysDroppedByCap: 0,
    capsThatBit: [],
    requestedBy: null,
    observedFrom: null,
    observedTo: null,
  },
  observedJourney: { ingestCount: 1, missingSteps: [] },
  coverageItem: {
    file: null,
    line: null,
    detector: null,
    meta: {},
    sources: null,
    exercisability: null,
    unexercisableReason: null,
    refusedByRule: null,
    exerciseDetail: null,
    environmentId: null,
    coordinates: null,
    status: 'UNCOVERED',
    matches: [],
    lastRunId: null,
    lastStatus: null,
    executed: false,
    mutationKilled: null,
    retiredAt: null,
  },
  integration: { projectId: null, config: {}, configEnc: null, enabled: true },
};

const CLOCK_BASE = new Date('2026-10-20T00:00:00.000Z').getTime();

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;
  let ticks = 0;

  const makeModel = (name: ModelName) => {
    const rows = () => tables[name];
    const find = (where: Row = {}, orderBy?: Row): Row[] =>
      sortRows(
        rows().filter((r) => matches(r, where)),
        orderBy,
      );

    const insert = (data: Row): Row => {
      const stamp = new Date(CLOCK_BASE + ticks++);
      const nested: Row = {};
      const scalars: Row = {};
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'create' in (value as Row)) nested[key] = value;
        else scalars[key] = value;
      }
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: stamp,
        updatedAt: stamp,
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        ...DEFAULTS[name],
        ...scalars,
      };
      rows().push(row);
      // `items: { create: [...] }` on a TestPlan — modelled because /propose
      // reads the created ids straight back out.
      for (const [key, value] of Object.entries(nested)) {
        const children = (value as Row).create as Row[];
        const childModel = key === 'items' ? 'planItem' : null;
        if (!childModel) throw new Error(`fake prisma: unmodelled nested create ${key}`);
        row[key] = children.map((child) =>
          (makeModel(childModel)).__insert({ ...child, testPlanId: row.id }),
        );
      }
      return row;
    };

    const applyUpdate = (row: Row, data: Row): void => {
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'increment' in value) {
          row[key] = (row[key] ?? 0) + (value as Row).increment;
          continue;
        }
        row[key] = value;
      }
      row.updatedAt = new Date(CLOCK_BASE + ticks++);
      row.lastSeenAt = row.updatedAt;
    };

    const model: Row = {
      __insert: insert,
      findUnique: async ({ where, select }: Row) => {
        const row = find(flatten(where))[0];
        return row ? project(row, select) : null;
      },
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const row = find(where ?? {}, orderBy)[0];
        return row ? project(row, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: Row = {}) => {
        const list = find(where ?? {}, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) =>
          project(r, select),
        );
      },
      count: async ({ where }: Row = {}) => find(where ?? {}).length,
      create: ({ data, select }: Row) => {
        const row = insert(data);
        return Promise.resolve(project(row, select));
      },
      update: ({ where, data, select }: Row) => {
        const row = find(flatten(where))[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        applyUpdate(row, data);
        return Promise.resolve(project(row, select));
      },
      upsert: ({ where, create, update, select }: Row) => {
        const row = find(flatten(where))[0];
        if (row) {
          applyUpdate(row, update);
          return Promise.resolve(project(row, select));
        }
        return Promise.resolve(project(insert(create), select));
      },
    };
    return model;
  };

  /** `{ projectId_key: { projectId, key } }` → `{ projectId, key }`. */
  const flatten = (where: Row): Row => {
    const out: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (value && typeof value === 'object' && !(value instanceof Date) && key.includes('_')) {
        Object.assign(out, value);
      } else out[key] = value;
    }
    return out;
  };

  const client: Record<string, unknown> = {
    // The ARRAY form: every write in this file passes a list of prepared
    // promises, so the fake resolves them. The callback form is not used here.
    $transaction: async (operations: unknown) => {
      if (!Array.isArray(operations)) {
        throw new Error('fake prisma: $transaction callback form is not used by these routes');
      }
      return Promise.all(operations as Promise<unknown>[]);
    },
  };
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const traffic = await import('./traffic.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/', traffic.trafficRouter);
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

/** Held before any global-fetch stubbing, or the harness intercepts itself. */
const realFetch = globalThis.fetch.bind(globalThis);

async function call(
  method: string,
  path: string,
  body?: unknown,
  contentType = 'application/json',
): Promise<{ status: number; body: Row; text: string }> {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': contentType },
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {}, text };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
  h.enqueued.length = 0;
  (db.client.project as Row).__insert({ id: 'proj_1', orgId: 'org_1', name: 'Shop' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function logLine(
  ip: string,
  hour: number,
  minute: number,
  method: string,
  path: string,
  status = 200,
): string {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${ip} - - [10/Oct/2026:${hh}:${mm}:00 +0000] "${method} ${path} HTTP/1.1" ${status} 1024 "-" "Mozilla/5.0 (X11)"`;
}

/**
 * Four sessions walk /products → /cart → POST /api/checkout; one walks
 * /settings/profile.
 *
 * `hour` shifts the whole window without touching the step sequences, so a
 * second upload describes the SAME journeys (the id is a hash of the steps)
 * observed LATER — which is the only way to test that `firstObservedAt` is not
 * moved forward by a re-ingest.
 */
function accessLog(hour = 13): string {
  const lines: string[] = [];
  for (const [index, ip] of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'].entries()) {
    lines.push(logLine(ip, hour, index * 2, 'GET', '/products'));
    lines.push(logLine(ip, hour, index * 2, 'GET', '/cart'));
    lines.push(logLine(ip, hour, index * 2, 'POST', '/api/checkout'));
  }
  lines.push(logLine('10.0.0.9', hour, 20, 'GET', '/settings/profile'));
  return lines.join('\n');
}

async function analyze(
  extra = '',
  hour = 13,
): Promise<{ status: number; body: Row; text: string }> {
  return call('POST', `/traffic/proj_1/analyze${extra}`, accessLog(hour), 'text/plain');
}

// ─── 1. Enumeration is persisted ─────────────────────────────────────────────

describe('POST /traffic/:projectId/analyze — persistence', () => {
  it('writes an ingest whose window comes from the entries and not from the clock', async () => {
    const { status, body } = await analyze();
    expect(status).toBe(200);

    expect(db.tables.trafficIngest).toHaveLength(1);
    const ingest = db.tables.trafficIngest[0]!;
    expect(ingest.format).toBe('ACCESS_LOG');
    expect(ingest.projectId).toBe('proj_1');
    expect(ingest.orgId).toBe('org_1');
    expect(ingest.entriesParsed).toBe(13);
    expect(ingest.sessions).toBe(5);
    // From the log lines, which describe 10 October — not `createdAt`.
    expect((ingest.observedFrom as Date).toISOString()).toBe('2026-10-10T13:00:00.000Z');
    expect((ingest.observedTo as Date).toISOString()).toBe('2026-10-10T13:20:00.000Z');
    expect(body.enumeration.ingestId).toBe(ingest.id);
  });

  it('stores the observed journeys with their real frequencies', async () => {
    await analyze();

    const journeys = db.tables.observedJourney;
    expect(journeys).toHaveLength(2);
    const hot = journeys.find((row) => row.sessionCount === 4)!;
    expect(hot.sessionShare).toBeCloseTo(0.8, 5);
    expect(hot.coverageStatus).toBe('UNCOVERED');
    expect(hot.projectId).toBe('proj_1');
    expect(hot.ingestId).toBe(db.tables.trafficIngest[0]!.id);
    expect((hot.steps as Row[]).map((step) => `${step.method} ${step.route}`)).toContain(
      'POST /api/checkout',
    );
    // An access log carries no timings. NULL and not 0 — 0 would read as a
    // journey that completes instantaneously, which nobody measured.
    expect(hot.medianDurationMs).toBeNull();
  });

  it('re-ingesting the same journey increments ingestCount and never moves firstObservedAt', async () => {
    await analyze();
    const first = db.tables.observedJourney.find((row) => row.sessionCount === 4)!;
    const firstObserved = (first.firstObservedAt as Date).toISOString();
    expect(first.ingestCount).toBe(1);

    // A LATER window describing the same step sequences. Without the shift the
    // two uploads carry identical timestamps and a reader that overwrote
    // `firstObservedAt` would be indistinguishable from one that did not.
    await analyze('', 15);
    expect(db.tables.observedJourney).toHaveLength(2);
    const again = db.tables.observedJourney.find((row) => row.sessionCount === 4)!;
    expect(again.ingestCount).toBe(2);
    expect(firstObserved).toBe('2026-10-10T13:00:00.000Z');
    // The earliest sighting is a fact about the journey. A later upload must not
    // make a journey look newer than it is.
    expect((again.firstObservedAt as Date).toISOString()).toBe(firstObserved);
    // …while the latest sighting does move, or the row would claim the journey
    // stopped being walked.
    expect((again.lastObservedAt as Date).toISOString()).toBe('2026-10-10T15:06:00.000Z');
    // The row now points at the newest ingest, so its numbers are traceable to
    // the caps they were computed under.
    expect(again.ingestId).toBe(db.tables.trafficIngest[1]!.id);
  });

  it('merges observed routes and endpoints into the CoverageItem registry', async () => {
    const { body } = await analyze();

    const keys = db.tables.coverageItem.map((row) => row.key).sort();
    expect(keys).toContain('ROUTE:/products');
    expect(keys).toContain('ROUTE:/cart');
    expect(keys).toContain('ROUTE:/settings/profile');
    // A non-GET is an operation as well as a page; a plain GET page is not.
    expect(keys).toContain('ENDPOINT:POST /api/checkout');
    expect(keys).not.toContain('ENDPOINT:GET /products');

    /*
     * `kind` is asserted on BOTH axes and not only the keys. The key and the
     * kind are two fields and `totalsForKind` divides by the kind, so a row
     * keyed `ENDPOINT:…` carrying `kind: 'ROUTE'` would inflate the route
     * denominator and empty the endpoint one with nothing on screen to show it.
     */
    const endpoint = db.tables.coverageItem.find(
      (row) => row.key === 'ENDPOINT:POST /api/checkout',
    )!;
    expect(endpoint.kind).toBe('ENDPOINT');
    expect(endpoint.label).toBe('POST /api/checkout');

    const route = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/products')!;
    expect(route.sources).toEqual(['TRAFFIC']);
    expect(route.origin).toBe('CRAWL_ONLY');
    expect(route.detector).toBe('traffic-ingest');
    expect(route.kind).toBe('ROUTE');
    expect(route.evidence).toMatch(/real session/);
    // A real user drove it, so our harness provably can.
    expect(route.exercisability).toBe('EXERCISABLE');
    // Traffic ADDS and never retires.
    expect(route.retiredAt).toBeNull();

    expect(body.enumeration.surfaceCreated).toBe(keys.length);
    expect(body.enumeration.surfaceUpdated).toBe(0);
  });

  it('keeps the existing analyze response contract that apps/web reads', async () => {
    const { body } = await analyze();
    expect(Array.isArray(body.journeys)).toBe(true);
    expect(body.totals).toMatchObject({ parsed: 13, sessions: 5 });
    expect(body.redaction.counts).toBeTypeOf('object');
    expect(body.format).toBe('ACCESS_LOG');
    expect(body.next.endpoint).toBe('/traffic/proj_1/propose');
  });

  it('records what it wrote in the audit log, and still no request content', async () => {
    await analyze();
    const entry = h.audits.find((row) => row.action === 'traffic.analyze')!;
    expect(entry.metadata.ingestId).toBe(db.tables.trafficIngest[0]!.id);
    expect(entry.metadata.journeysStored).toBe(2);
    expect(entry.metadata.surfaceMerged).toBeGreaterThan(0);
    // Counts only: no route, no path, no log line.
    expect(JSON.stringify(entry.metadata)).not.toContain('10.0.0.1');
    expect(JSON.stringify(entry.metadata)).not.toContain('/products');
  });
});

// ─── 2. Provenance is unioned; origin is derived ─────────────────────────────

describe('provenance union', () => {
  it('adds TRAFFIC beside an existing SOURCE declarer and derives origin BOTH', async () => {
    (db.client.coverageItem as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      key: 'ROUTE:/products',
      kind: 'ROUTE',
      label: '/products',
      origin: 'SOURCE_ONLY',
      evidence: 'app/products/page.tsx — directory path is the URL',
      file: 'app/products/page.tsx',
      line: 12,
      detector: 'next-app-router',
      sources: ['SOURCE'],
    });

    const { body } = await analyze();

    const route = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/products')!;
    expect(route.sources).toEqual(['SOURCE', 'TRAFFIC']);
    // Derived from the union, never set by hand.
    expect(route.origin).toBe('BOTH');
    // The source detector knows where the route is declared; traffic does not.
    // Overwriting these with null would blind the editor link on exactly the
    // rows with two declarers behind them.
    expect(route.file).toBe('app/products/page.tsx');
    expect(route.line).toBe(12);
    expect(route.detector).toBe('next-app-router');

    expect(body.enumeration.surfaceUpdated).toBe(1);
  });

  it('treats a row with no recorded declarer as unrecorded, not as an empty list', async () => {
    (db.client.coverageItem as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      key: 'ROUTE:/cart',
      kind: 'ROUTE',
      label: '/cart',
      origin: 'SOURCE_ONLY',
      evidence: 'written before the sources column existed',
      // `sources: null` — the pre-column state, which is NOT `[]`.
      sources: null,
    });

    await analyze();
    const cart = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/cart')!;
    expect(cart.sources).toEqual(['TRAFFIC']);
    expect(cart.origin).toBe('CRAWL_ONLY');
  });

  it('never retires a registry row it did not see', async () => {
    (db.client.coverageItem as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      key: 'ROUTE:/admin/billing',
      kind: 'ROUTE',
      label: '/admin/billing',
      origin: 'SOURCE_ONLY',
      evidence: 'declared in source, no traffic in this window',
      sources: ['SOURCE'],
    });

    await analyze();
    const admin = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/admin/billing')!;
    // Traffic's silence about a route is evidence of nothing. Retiring on it
    // would delete real surface and raise the percentage.
    expect(admin.retiredAt).toBeNull();
    expect(admin.sources).toEqual(['SOURCE']);
  });
});

// ─── 3. Caps are disclosed, exactly or as a floor ────────────────────────────

describe('cap disclosure', () => {
  it('names the suite-comparison cap with the exact number of tests not compared', async () => {
    for (let index = 0; index < 505; index += 1) {
      (db.client.test as Row).__insert({
        orgId: 'org_1',
        projectId: 'proj_1',
        name: `test ${index}`,
        code: '// nothing',
      });
    }

    const { body } = await analyze();
    const cap = (body.enumeration.capsThatBit as Row[]).find(
      (entry) => entry.cap === 'SUITE_COMPARISON',
    )!;
    expect(cap).toBeDefined();
    expect(cap.limit).toBe(500);
    expect(cap.discarded).toBe(5);
    expect(cap.discardedIsExact).toBe(true);
    expect(cap.reason).toMatch(/500 of this project’s 505 tests/);
    expect(cap.reason).toMatch(/upper bound/);

    // Stored on the row, so a later read of the journeys can find it.
    const stored = db.tables.trafficIngest[0]!.capsThatBit as Row[];
    expect(stored.map((entry) => entry.cap)).toContain('SUITE_COMPARISON');
  });

  it('reports the ranking cap as a floor, not as zero, because the ranker cannot count it', async () => {
    const { body } = await analyze('?maxJourneys=1');
    const cap = (body.enumeration.capsThatBit as Row[]).find(
      (entry) => entry.cap === 'JOURNEY_RANKING',
    )!;
    expect(cap).toBeDefined();
    expect(cap.limit).toBe(1);
    // A FLOOR. Reporting 0 would say the cap cost nothing; inventing a figure
    // would be worse.
    expect(cap.discarded).toBe(1);
    expect(cap.discardedIsExact).toBe(false);
    expect(cap.reason).toMatch(/at least one more/);
  });

  it('reports no caps when none bit, which is a measurement and not an omission', async () => {
    const { body } = await analyze();
    expect(body.enumeration.capsThatBit).toEqual([]);
    expect(db.tables.trafficIngest[0]!.capsThatBit).toEqual([]);
  });

  it('refuses to let an upload license an absence conclusion', async () => {
    const { body } = await analyze();
    // An uploaded file's sampling rate is unknown, and unknown is not 1.
    expect(body.enumeration.samplingRate).toBeNull();
    expect(body.enumeration.mayConcludeAbsence).toBe(false);
  });

  it('discloses the suite-comparison cap on /propose as well', async () => {
    for (let index = 0; index < 502; index += 1) {
      (db.client.test as Row).__insert({
        orgId: 'org_1',
        projectId: 'proj_1',
        name: `test ${index}`,
        code: '// nothing',
      });
    }
    (db.client.flowMap as Row).__insert({ orgId: 'org_1', projectId: 'proj_1', version: 3 });

    const analysis = await analyze();
    const journey = (analysis.body.journeys as Row[])[0]!;
    const { status, body } = await call('POST', '/traffic/proj_1/propose', {
      journeys: [journey],
      totalSessions: 5,
      source: 'ACCESS_LOG',
    });

    expect(status).toBe(202);
    expect(body.suiteComparison).toMatchObject({ compared: 500, total: 502, truncated: true });
    expect(body.suiteComparison.reason).toMatch(/may already be covered/);
  });
});

// ─── 4. The cross-reference, and the conclusion it refuses to draw ───────────

describe('GET /traffic/:projectId/cross-reference', () => {
  function seedJourney(partial: Row): void {
    (db.client.observedJourney as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      ingestId: 'ingest_seed',
      name: partial.journeyKey,
      feature: 'Shop',
      steps: [],
      requestCount: 10,
      errorRate: 0,
      medianDurationMs: null,
      matchedRatio: 1,
      firstObservedAt: new Date('2026-10-01T00:00:00.000Z'),
      lastObservedAt: new Date('2026-10-10T00:00:00.000Z'),
      ...partial,
    });
  }

  function seedIngest(partial: Row = {}): Row {
    return (db.client.trafficIngest as Row).__insert({
      id: 'ingest_seed',
      orgId: 'org_1',
      projectId: 'proj_1',
      format: 'ACCESS_LOG',
      entriesParsed: 100,
      sessions: 20,
      journeysStored: 3,
      observedFrom: new Date('2026-10-01T00:00:00.000Z'),
      observedTo: new Date('2026-10-10T00:00:00.000Z'),
      ...partial,
    });
  }

  it('says NEVER_INGESTED rather than returning empty buckets', async () => {
    const { status, body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(status).toBe(200);
    expect(body.state).toBe('NEVER_INGESTED');
    // Not `{}` and not a set of zeroes: "nothing was ever uploaded" and "your
    // users walk nothing" are opposite facts.
    expect(body.buckets).toBeNull();
    expect(body.reason).toMatch(/not a statement that your users walk nothing/);
  });

  it('buckets hot/cold against covered/uncovered and discloses the threshold', async () => {
    seedIngest();
    seedJourney({ journeyKey: 'hot-covered', sessionCount: 10, sessionShare: 0.5, coverageStatus: 'COVERED' });
    seedJourney({ journeyKey: 'hot-uncovered', sessionCount: 8, sessionShare: 0.4, coverageStatus: 'UNCOVERED' });
    seedJourney({ journeyKey: 'cold-covered', sessionCount: 1, sessionShare: 0.01, coverageStatus: 'COVERED' });

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.state).toBe('MEASURED');
    expect(body.hotThreshold).toBe(0.05);
    expect(body.buckets.COVERED_AND_HOT.count).toBe(1);
    expect(body.buckets.COVERED_AND_HOT.journeys[0].journeyKey).toBe('hot-covered');
    expect(body.buckets.UNCOVERED_AND_HOT.count).toBe(1);
    expect(body.buckets.UNCOVERED_AND_HOT.journeys[0].journeyKey).toBe('hot-uncovered');
    expect(body.buckets.COVERED_AND_COLD.count).toBe(1);
  });

  it('withholds covered-and-cold when the source never reported a sampling rate', async () => {
    seedIngest();
    seedJourney({ journeyKey: 'cold-covered', sessionCount: 1, sessionShare: 0.01, coverageStatus: 'COVERED' });

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    const cold = body.buckets.COVERED_AND_COLD;
    // The COUNT is still reported — hiding it would hide our own uncertainty —
    // but the named list, which is the part that says "delete these tests", is
    // withheld with a reason.
    expect(cold.count).toBe(1);
    expect(cold.journeys).toEqual([]);
    expect(cold.conclusive).toBe(false);
    expect(cold.withheld).toMatch(/did not report a sampling rate/);
    // And the presence conclusion is unaffected.
    expect(body.buckets.UNCOVERED_AND_HOT.conclusive).toBe(true);
  });

  it('withholds covered-and-cold for a sampled connector source', async () => {
    (db.client.integration as Row).__insert({
      id: 'int_rum',
      orgId: 'org_1',
      projectId: 'proj_1',
      kind: 'WEBHOOK',
      name: 'RUM',
      config: {
        traffic: { provider: 'DATADOG_RUM', site: 'datadoghq.com', applicationId: 'app', windowDays: 7, environmentId: null },
        trafficLastSync: {
          atIso: '2026-10-10T00:00:00.000Z',
          ingestId: 'ingest_seed',
          samplingRate: 0.1,
          journeysStored: 3,
          sessions: 20,
          windowFrom: '2026-10-01T00:00:00.000Z',
          windowTo: '2026-10-10T00:00:00.000Z',
        },
      },
    });
    seedIngest({ integrationId: 'int_rum' });
    seedJourney({ journeyKey: 'cold-covered', sessionCount: 1, sessionShare: 0.01, coverageStatus: 'COVERED' });

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.samplingRate).toBe(0.1);
    expect(body.buckets.COVERED_AND_COLD.conclusive).toBe(false);
    expect(body.buckets.COVERED_AND_COLD.withheld).toMatch(/sampling rate of 0\.1/);
    // The named list is the part that says "delete these tests", so it is the
    // part that is actually withheld — not merely flagged.
    expect(body.buckets.COVERED_AND_COLD.journeys).toEqual([]);
    expect(body.buckets.COVERED_AND_COLD.count).toBe(1);
  });

  it('names covered-and-cold when the source says it is unsampled', async () => {
    (db.client.integration as Row).__insert({
      id: 'int_drain',
      orgId: 'org_1',
      projectId: 'proj_1',
      kind: 'WEBHOOK',
      name: 'nginx drain',
      config: {
        traffic: { provider: 'CDN_LOG_DRAIN', endpointUrl: 'https://logs.example.test/window', windowDays: 7, environmentId: null },
        trafficLastSync: {
          atIso: '2026-10-10T00:00:00.000Z',
          ingestId: 'ingest_seed',
          samplingRate: 1,
          journeysStored: 3,
          sessions: 20,
          windowFrom: '2026-10-01T00:00:00.000Z',
          windowTo: '2026-10-10T00:00:00.000Z',
        },
      },
    });
    seedIngest({ integrationId: 'int_drain' });
    seedJourney({ journeyKey: 'cold-covered', sessionCount: 1, sessionShare: 0.01, coverageStatus: 'COVERED' });

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.samplingRate).toBe(1);
    expect(body.buckets.COVERED_AND_COLD.conclusive).toBe(true);
    expect(body.buckets.COVERED_AND_COLD.journeys[0].journeyKey).toBe('cold-covered');
    expect(body.buckets.COVERED_AND_COLD.withheld).toBeUndefined();
  });

  it('discloses its own read cap, so a bucket count is never a silent floor', async () => {
    seedIngest();
    // One more than the endpoint reads (50 rows × 3 buckets).
    for (let index = 0; index < 151; index += 1) {
      seedJourney({
        journeyKey: `j-${index}`,
        sessionCount: 200 - index,
        sessionShare: (200 - index) / 1000,
        coverageStatus: 'UNCOVERED',
      });
    }

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.journeysStored).toBe(151);
    expect(body.journeysRead).toBe(150);
    const cap = (body.capsThatBit as Row[]).find((entry) => entry.cap === 'JOURNEY_PERSISTENCE')!;
    // Without this, a project with 400 observed journeys would have three
    // bucket counts computed from the 150 hottest and report all three as
    // facts — an undisclosed cap on the numbers the priority list is built on.
    expect(cap).toBeDefined();
    expect(cap.limit).toBe(150);
    expect(cap.discarded).toBe(1);
    expect(cap.discardedIsExact).toBe(true);
    expect(cap.reason).toMatch(/every count below is a floor/);
    expect(cap.reason).toMatch(/hottest-first, so what is missing is the tail/);
  });

  it('reports no read cap when it read everything', async () => {
    seedIngest();
    seedJourney({ journeyKey: 'only', sessionCount: 5, sessionShare: 0.5, coverageStatus: 'COVERED' });
    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.journeysStored).toBe(1);
    expect(body.journeysRead).toBe(1);
    // A cap that did not bite is not a caveat.
    expect(body.capsThatBit).toEqual([]);
  });

  it('caveats the uncovered list when the suite comparison was truncated', async () => {
    seedIngest({
      capsThatBit: [
        {
          cap: 'SUITE_COMPARISON',
          limit: 500,
          bites: 1,
          discarded: 400,
          discardedIsExact: true,
          reason: 'Coverage was decided against 500 of this project’s 900 tests.',
        },
      ],
    });
    seedJourney({ journeyKey: 'hot-uncovered', sessionCount: 8, sessionShare: 0.4, coverageStatus: 'UNCOVERED' });

    const { body } = await call('GET', '/traffic/proj_1/cross-reference');
    expect(body.buckets.UNCOVERED_AND_HOT.caveat).toMatch(/upper bound/);
    expect(body.capsThatBit[0].cap).toBe('SUITE_COMPARISON');
  });
});

// ─── 5. Connectors ───────────────────────────────────────────────────────────

function seedConnector(partial: Row = {}): Row {
  return (db.client.integration as Row).__insert({
    id: 'int_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    kind: 'WEBHOOK',
    name: 'Production drain',
    config: {
      traffic: {
        provider: 'CDN_LOG_DRAIN',
        endpointUrl: 'https://logs.example.test/window',
        windowDays: 7,
        environmentId: null,
      },
      keyVersion: 1,
    },
    ...partial,
  });
}

describe('GET /traffic/:projectId/connectors', () => {
  it('reports NEVER_SYNCED, with nulls and not zeroes, for a connector that never ran', async () => {
    seedConnector();
    const { status, body } = await call('GET', '/traffic/proj_1/connectors');
    expect(status).toBe(200);

    const connector = body.connectors[0];
    expect(connector.provider).toBe('CDN_LOG_DRAIN');
    expect(connector.syncState).toBe('NEVER_SYNCED');
    expect(connector.syncStateDetail).toMatch(/not the same as an application with no traffic/);
    // A connector that has never run has not observed zero sessions.
    expect(connector.lastSessions).toBeNull();
    expect(connector.lastJourneysStored).toBeNull();
    expect(connector.lastSucceededAt).toBeNull();
    expect(connector.samplingRate).toBeNull();
    expect(connector.mayConcludeAbsence).toBe(false);
  });

  it('never returns a credential, only whether one exists', async () => {
    seedConnector({ configEnc: 'v1:deadbeefciphertext' });
    const { body, text } = await call('GET', '/traffic/proj_1/connectors');
    expect(body.connectors[0].hasCredential).toBe(true);
    expect(text).not.toContain('deadbeefciphertext');
  });

  it('ignores integrations that are not traffic connectors', async () => {
    (db.client.integration as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      kind: 'SLACK',
      name: 'Engineering',
      config: { host: 'hooks.slack.com' },
    });
    const { body } = await call('GET', '/traffic/proj_1/connectors');
    expect(body.connectors).toEqual([]);
    expect(body.note).toMatch(/No live-traffic connector is configured/);
  });

  it('skips a row whose kind names a provider but whose settings block is unreadable', async () => {
    /*
     * The forward-compatible path. `IntegrationKind` has no GA4 member yet —
     * see needsFromOtherFiles — so `providerOf` falls back to the config block
     * today and this row cannot occur. Once the enum lands it can, and a row
     * that names a provider with no readable settings must be SKIPPED rather
     * than listed with an undefined window: a connector whose `windowDays`
     * nobody can read has not got a window, and rendering one would be
     * inventing the measurement period.
     */
    (db.client.integration as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      kind: 'GA4',
      name: 'Half-configured analytics',
      config: { traffic: { provider: 'GA4' } },
    });
    const { body } = await call('GET', '/traffic/proj_1/connectors');
    expect(body.connectors).toEqual([]);
  });

  it('reports STALE_AFTER_FAILURE when a success was followed by a failure', async () => {
    seedConnector({
      config: {
        traffic: {
          provider: 'CDN_LOG_DRAIN',
          endpointUrl: 'https://logs.example.test/window',
          windowDays: 7,
          environmentId: null,
        },
        trafficLastSync: {
          atIso: '2026-10-01T00:00:00.000Z',
          ingestId: 'ingest_old',
          samplingRate: 1,
          journeysStored: 4,
          sessions: 40,
          windowFrom: '2026-09-24T00:00:00.000Z',
          windowTo: '2026-10-01T00:00:00.000Z',
        },
        trafficLastAttempt: {
          atIso: '2026-10-09T00:00:00.000Z',
          outcome: 'FAILED',
          detail: 'The log drain answered 503.',
        },
      },
    });

    const { body } = await call('GET', '/traffic/proj_1/connectors');
    const connector = body.connectors[0];
    expect(connector.syncState).toBe('STALE_AFTER_FAILURE');
    // BOTH facts survive: when it last worked, and that the newest try did not.
    expect(connector.lastSucceededAt).toBe('2026-10-01T00:00:00.000Z');
    expect(connector.lastAttempt.outcome).toBe('FAILED');
  });
});

describe('POST /traffic/:projectId/connectors/:integrationId/sync', () => {
  it('reports UNAVAILABLE — never "no traffic" — when no credential is stored', async () => {
    // A drain with no bearer token is still fetchable, so this test uses a
    // provider that cannot be asked at all without one.
    seedConnector({
      configEnc: null,
      config: {
        traffic: {
          provider: 'DATADOG_RUM',
          site: 'datadoghq.com',
          applicationId: 'app_1',
          windowDays: 7,
          environmentId: null,
        },
      },
    });

    const { status, body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(status).toBe(200);
    expect(body.synced).toBe(false);
    expect(body.outcome).toBe('UNAVAILABLE');
    expect(body.detail).toMatch(/Nothing is claimed about this application’s traffic/);
    // Nothing was observed, so nothing was written down as observed.
    expect(db.tables.trafficIngest).toHaveLength(0);
    expect(body.syncState).toBe('NEVER_SYNCED');
    expect(body.mayConcludeAbsence).toBe(false);

    // The attempt IS recorded: it distinguishes a half-configured connector
    // from a broken one, and both from one nobody ever tried.
    const row = db.tables.integration[0]!;
    expect(row.config.trafficLastAttempt.outcome).toBe('UNAVAILABLE');
    expect(row.config.trafficLastSync).toBeUndefined();
  });

  it('refuses an integration that carries no traffic settings block', async () => {
    (db.client.integration as Row).__insert({
      id: 'int_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      kind: 'SLACK',
      name: 'Engineering',
      config: {},
    });
    const { status, body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(status).toBe(422);
    expect(body.error.message).toMatch(/not a traffic connector/);
  });

  it('404s for another org’s integration', async () => {
    seedConnector({ orgId: 'org_other' });
    const { status } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(status).toBe(404);
  });

  it('syncs a log drain through the real adapter, stores the ingest and claims unsampled', async () => {
    seedConnector();
    const seen: Row[] = [];
    vi.stubGlobal('fetch', async (url: string, init: Row) => {
      seen.push({ url, method: init.method });
      return new Response(accessLog(), { status: 200 });
    });

    const { status, body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(status).toBe(200);
    expect(body.synced).toBe(true);
    expect(seen[0]!.url).toBe('https://logs.example.test/window');

    expect(db.tables.trafficIngest).toHaveLength(1);
    const ingest = db.tables.trafficIngest[0]!;
    expect(ingest.integrationId).toBe('int_1');
    expect(ingest.format).toBe('ACCESS_LOG');
    expect(ingest.sessions).toBe(5);
    expect(db.tables.observedJourney).toHaveLength(2);

    // The origin's own log is unsampled, so this one source CAN license an
    // absence conclusion — and says so rather than leaving it to be inferred.
    expect(body.samplingRate).toBe(1);
    expect(body.mayConcludeAbsence).toBe(true);
    expect(body.syncState).toBe('SYNCED');

    const row = db.tables.integration[0]!;
    expect(row.config.trafficLastSync.samplingRate).toBe(1);
    expect(row.config.trafficLastSync.ingestId).toBe(ingest.id);
    // Read-modify-write: the key version the credential needs survives.
    expect(row.config.keyVersion).toBe(1);
    expect(row.config.traffic.provider).toBe('CDN_LOG_DRAIN');
  });

  it('does not call deduplication a cap, and does call the provider’s own total one', async () => {
    seedConnector({
      configEnc: null,
      config: {
        traffic: {
          provider: 'GA4',
          propertyId: '123456',
          hostFilter: null,
          windowDays: 7,
          environmentId: null,
        },
      },
    });
    const sealed = await import('../lib/integrations.js');
    const envelope = sealed.sealToken('ga4-token', 'org_1', 'int_1');
    db.tables.integration[0]!.configEnc = envelope.ciphertext;
    db.tables.integration[0]!.config.keyVersion = envelope.keyVersion;

    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          rows: [
            { dimensionValues: [{ value: '/orders/1' }], metricValues: [{ value: '9' }] },
            { dimensionValues: [{ value: '/orders/2' }], metricValues: [{ value: '7' }] },
            { dimensionValues: [{ value: '/orders/3' }], metricValues: [{ value: '5' }] },
          ],
          rowCount: 10,
        }),
        { status: 200 },
      ),
    );

    const { body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(body.synced).toBe(true);
    // Three provider rows collapse to ONE canonical route. That is
    // deduplication, not a cap, and reporting it as a cap would teach a reader
    // to ignore every cap we disclose.
    expect(db.tables.coverageItem.map((row) => row.key)).toEqual(['ROUTE:/orders/:param']);
    const caps = body.capsThatBit as Row[];
    expect(caps).toHaveLength(1);
    // The one cap that DID bite: the request limit, measured against GA4's own
    // row total and not against the rows it sent back.
    expect(caps[0]!.discarded).toBe(7);
    expect(caps[0]!.reason).toMatch(/holds at least 7 more/);
  });

  it('records a provider failure as FAILED and writes no ingest', async () => {
    seedConnector();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));

    const { body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(body.synced).toBe(false);
    expect(body.outcome).toBe('FAILED');
    expect(body.detail).toMatch(/answered 503/);
    expect(db.tables.trafficIngest).toHaveLength(0);
    expect(db.tables.integration[0]!.config.trafficLastAttempt.outcome).toBe('FAILED');
  });

  it('treats an empty drain body as a failure, not as a window with no requests', async () => {
    seedConnector();
    vi.stubGlobal('fetch', async () => new Response('   ', { status: 200 }));

    const { body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(body.outcome).toBe('FAILED');
    expect(body.detail).toMatch(/not the same as a window with no requests/);
    expect(db.tables.trafficIngest).toHaveLength(0);
  });

  it('enumerates routes from a totals source and stores zero journeys with a reason', async () => {
    seedConnector({
      configEnc: null,
      config: {
        traffic: {
          provider: 'GA4',
          propertyId: '123456',
          hostFilter: null,
          windowDays: 7,
          environmentId: 'env_1',
        },
      },
    });
    // GA4 needs a credential, so this test gives the reader one by sealing
    // nothing and instead asserting the UNAVAILABLE path elsewhere; here the
    // reader is exercised directly below. This case proves the ROUTE_TOTALS
    // branch end to end through a stubbed token path.
    const sealed = await import('../lib/integrations.js');
    const envelope = sealed.sealToken('ga4-token', 'org_1', 'int_1');
    db.tables.integration[0]!.configEnc = envelope.ciphertext;
    db.tables.integration[0]!.config.keyVersion = envelope.keyVersion;

    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          rows: [
            { dimensionValues: [{ value: '/products' }], metricValues: [{ value: '900' }] },
            { dimensionValues: [{ value: '/users/alice@example.com' }], metricValues: [{ value: '4' }] },
          ],
        }),
        { status: 200 },
      ),
    );

    const { body } = await call('POST', '/traffic/proj_1/connectors/int_1/sync');
    expect(body.synced).toBe(true);
    const ingest = db.tables.trafficIngest[0]!;
    expect(ingest.format).toBe('GA4_ROUTE_TOTALS');
    // An honest zero: a totals source cannot report sessions as sequences.
    expect(ingest.sessions).toBe(0);
    expect(ingest.journeysStored).toBe(0);
    expect(db.tables.observedJourney).toHaveLength(0);
    expect(body.detail).toMatch(/cannot produce journeys/);

    const keys = db.tables.coverageItem.map((row) => row.key);
    expect(keys).toContain('ROUTE:/products');
    /*
     * A provider-supplied path goes through the same redaction an upload does.
     * `sanitisePath` classifies the segment as an email and replaces it, then
     * `canonicalRoute` flattens every placeholder to `:param` — which is the
     * registry's own key convention, so a route reached by a crawl, declared in
     * source and seen in GA4 all land on one row instead of three.
     */
    expect(keys.join('|')).not.toContain('alice@example.com');
    expect(keys).toContain('ROUTE:/users/:param');

    // GA4 reported no sampling metadata, so the rate stays null — never 1.
    expect(body.samplingRate).toBeNull();
    expect(body.mayConcludeAbsence).toBe(false);
    // Observed in a named environment, so a staging route cannot enter a
    // production denominator.
    expect(db.tables.coverageItem[0]!.environmentId).toBe('env_1');
  });
});

// ─── 6. The readers, with a fake transport (no network, no SDK) ──────────────

describe('connector readers', () => {
  const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' };

  function transportReturning(body: string, status = 200) {
    const calls: TrafficTransportRequest[] = [];
    return {
      calls,
      transport: {
        request: async (input: TrafficTransportRequest) => {
          calls.push(input);
          return { status, body };
        },
      } satisfies TrafficTransport,
    };
  }

  it('reads GA4’s own sampling arithmetic when it reports it', async () => {
    const { transport } = transportReturning(
      JSON.stringify({
        rows: [{ dimensionValues: [{ value: '/a' }], metricValues: [{ value: '5' }] }],
        samplingMetadatas: [{ samplesReadCount: 250, samplingSpaceSize: 1000 }],
      }),
    );
    const read = await traffic.readConnector(
      { provider: 'GA4', propertyId: '1', hostFilter: null, windowDays: 7, environmentId: null },
      { transport, credential: 'token', window },
    );
    expect(read.outcome).toBe('OK');
    expect(read.samplingRate).toBe(0.25);
    expect(traffic.mayConcludeAbsence(read.samplingRate)).toBe(false);
  });

  it('leaves GA4’s sampling rate null when the provider said nothing — never 1', async () => {
    const { transport } = transportReturning(JSON.stringify({ rows: [] }));
    const read = await traffic.readConnector(
      { provider: 'GA4', propertyId: '1', hostFilter: null, windowDays: 7, environmentId: null },
      { transport, credential: 'token', window },
    );
    expect(read.samplingRate).toBeNull();
    expect(traffic.mayConcludeAbsence(read.samplingRate)).toBe(false);
  });

  it('hands Sentry’s transaction over as a template and not as a raw path', async () => {
    const { transport } = transportReturning(
      JSON.stringify({
        data: [{ transaction: '/orders/:id', timestamp: '2026-10-02T10:00:00Z', trace: 't1' }],
        meta: { sample_rate: 0.01 },
      }),
    );
    const read = await traffic.readConnector(
      {
        provider: 'SENTRY_PERFORMANCE',
        organisation: 'acme',
        projectSlug: 'web',
        windowDays: 7,
        environmentId: null,
      },
      { transport, credential: 'token', window },
    );
    expect(read.outcome).toBe('OK');
    expect(read.samplingRate).toBe(0.01);
    const payload = read.payload!;
    expect(payload.shape).toBe('SESSIONED');
    const json = JSON.stringify(payload);
    // `http.route` and not `url.path`: the template must not go back through
    // the parameteriser that guesses templates from observed values.
    expect(json).toContain('http.route');
    expect(json).not.toContain('url.path');
  });

  it('reads GA4’s own row total and reports how many pages it never asked for', async () => {
    const { transport } = transportReturning(
      JSON.stringify({
        rows: [{ dimensionValues: [{ value: '/a' }], metricValues: [{ value: '5' }] }],
        rowCount: 4000,
      }),
    );
    const read = await traffic.readConnector(
      { provider: 'GA4', propertyId: '1', hostFilter: null, windowDays: 7, environmentId: null },
      { transport, credential: 'token', window },
    );
    const payload = read.payload!;
    expect(payload.shape).toBe('ROUTE_TOTALS');
    // The `limit` on the request is a cap WE applied, so the shortfall against
    // the provider's own total is ours to disclose.
    expect(payload.shape === 'ROUTE_TOTALS' && payload.truncatedBy).toBe(3999);
    expect(read.detail).toMatch(/at least 3999 more real pages exist/);
  });

  it('leaves GA4’s row total null when it did not report one — never 0', async () => {
    const { transport } = transportReturning(
      JSON.stringify({ rows: [{ dimensionValues: [{ value: '/a' }], metricValues: [{ value: '5' }] }] }),
    );
    const read = await traffic.readConnector(
      { provider: 'GA4', propertyId: '1', hostFilter: null, windowDays: 7, environmentId: null },
      { transport, credential: 'token', window },
    );
    const payload = read.payload!;
    // 0 would claim the answer was complete. The provider did not say.
    expect(payload.shape === 'ROUTE_TOTALS' && payload.truncatedBy).toBeNull();
    expect(read.detail).not.toMatch(/more real pages exist/);
  });

  it('turns a thrown transport into a FAILED read rather than a 500', async () => {
    const read = await traffic.readConnector(
      {
        provider: 'DATADOG_RUM',
        site: 'datadoghq.com',
        applicationId: 'a',
        windowDays: 7,
        environmentId: null,
      },
      {
        transport: {
          request: async () => {
            throw new Error('ECONNREFUSED');
          },
        },
        credential: 'key',
        window,
      },
    );
    expect(read.outcome).toBe('FAILED');
    expect(read.payload).toBeNull();
    expect(read.samplingRate).toBeNull();
    expect(read.detail).toMatch(/ECONNREFUSED/);
  });

  it('asks nothing at all when there is no credential, and says so', async () => {
    const { calls, transport } = transportReturning('{}');
    const read = await traffic.readConnector(
      {
        provider: 'DATADOG_RUM',
        site: 'datadoghq.com',
        applicationId: 'a',
        windowDays: 7,
        environmentId: null,
      },
      { transport, credential: null, window },
    );
    expect(read.outcome).toBe('UNAVAILABLE');
    expect(calls).toHaveLength(0);
    expect(read.detail).toMatch(/Nothing is claimed/);
  });

  it('only lets an affirmatively unsampled source conclude absence', () => {
    expect(traffic.mayConcludeAbsence(1)).toBe(true);
    expect(traffic.mayConcludeAbsence(0.99)).toBe(false);
    expect(traffic.mayConcludeAbsence(null)).toBe(false);
  });
});

// ─── 7. The two halves of the drift guard ────────────────────────────────────

describe('vocabulary parity', () => {
  it('pairs every connector provider with a config branch and a schema branch', () => {
    // The compiler enforces the presence record against the union; this
    // enforces the zod schema against the presence record. Eight GateRule
    // kinds shipped unsaveable because only one of the two existed.
    expect([...traffic.TRAFFIC_CONNECTOR_CONFIG_PROVIDERS].sort()).toEqual(
      [...traffic.TRAFFIC_CONNECTOR_PROVIDERS].sort(),
    );
    expect(traffic.connectorSchemaProviders().sort()).toEqual(
      [...traffic.TRAFFIC_CONNECTOR_PROVIDERS].sort(),
    );
  });

  it('labels every cap and every sync state, so none can be disclosed anonymously', () => {
    expect(Object.keys(traffic.TRAFFIC_CAP_LABELS).sort()).toEqual([...traffic.TRAFFIC_CAPS].sort());
    expect(Object.keys(traffic.CONNECTOR_SYNC_STATE_LABELS).sort()).toEqual(
      [...traffic.CONNECTOR_SYNC_STATES].sort(),
    );
    expect(Object.keys(traffic.CROSS_REFERENCE_BUCKET_LABELS).sort()).toEqual(
      [...traffic.CROSS_REFERENCE_BUCKETS].sort(),
    );
  });

  it('keeps NEVER_SYNCED distinguishable from a measured zero', () => {
    expect(traffic.CONNECTOR_SYNC_STATES).toContain('NEVER_SYNCED');
    expect(traffic.CONNECTOR_SYNC_STATE_LABELS.NEVER_SYNCED).toMatch(
      /not the same as an application with no traffic/,
    );
  });
});
