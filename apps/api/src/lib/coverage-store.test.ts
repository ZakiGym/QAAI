/**
 * Tests for the coverage store — the layer that decides whether a coverage
 * number can be DEFENDED or merely printed.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A DISAPPEARING DENOMINATOR IS VISIBLE. When the extractor stops finding
 *      a route the row must be retired, not deleted, and re-seeing it must
 *      un-retire the SAME row. Deleting instead would make "your coverage went
 *      up 4 points because we stopped seeing 30 of your routes" indistinguish-
 *      able from a real improvement, and minting a new row on re-sighting would
 *      reset `firstSeenAt` and erase the history that makes the difference
 *      arguable. Both halves are asserted on the stored rows, including the
 *      row id and `firstSeenAt`, because a test that only counts rows passes
 *      for a delete-and-recreate implementation.
 *
 *   2. A READ NEVER WRITES. `persist: false` is what lets GET /surface compute
 *      a live number without filling the trend with duplicates and making a CI
 *      gate's delta meaningless. The fake records every operation it is asked
 *      for, so this is asserted as "no write operation was issued at all"
 *      rather than as "the tables happen to look empty".
 *
 *   3. A SNAPSHOT CARRIES ITS INPUTS. The commit, the analysis id, the flow-map
 *      version, the test count, the run and every caveat. A percentage without
 *      its inputs cannot be defended in a meeting, so the persisted row is read
 *      back and each field checked against the fixture that produced it.
 *
 *   4. AN EXPIRED WAIVER IS NOT A WAIVER. A waiver shrinks the denominator; one
 *      that has lapsed and still excludes its item is a number that stays
 *      flattered because nobody revisited a decision. Asserted in both
 *      directions from the same fixture — live waiver out, expired waiver back
 *      in — because only the pair proves the expiry filter is what did it.
 *
 *   5. NOTHING TO DIVIDE IS NULL, NOT ZERO. A project with no analysis and no
 *      crawl must produce `percent: null` plus caveats saying why, and must not
 *      throw. 0% would be a claim about the customer's application made out of
 *      our own silence.
 *
 * Harness: same shape as routes/badges.test.ts and routes/suites.test.ts — the
 * prisma module is mocked with a REAL AsyncLocalStorage tenant scope applied
 * the way the extension in lib/prisma.ts applies it, and the store is driven
 * directly. The scope is real rather than stubbed because `computeCoverage`
 * issues its five loads inside `Promise.all`, and a plain variable would be
 * restored before they ran.
 *
 * Deliberately NOT mocked: @qaai/agent. The inventory and the division are the
 * arithmetic this file exists to persist, and a test that stubs them proves the
 * store can store a number rather than that it stores the right one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  /** Every operation the store issued, as `model.operation`. */
  ops: string[];
}

const h = vi.hoisted((): Hoisted => ({ prisma: {}, currentOrg: () => null, ops: [] }));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    // routes/coverage.ts is imported for `toCoverageInputs` and reads this in a
    // handler none of these tests reach.
    ANTHROPIC_API_KEY: null,
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  },
  isProd: false,
}));

vi.mock('./logger.js', () => ({
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

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('./queues.js', () => ({ enqueue: async () => {} }));

/*
 * The tenancy scope is real. `computeCoverage` runs its loads in a Promise.all
 * and its writes in chunked transactions, all in the async continuation of
 * `withTenant`, so a stubbed scope would restore before any of them ran and
 * every org filter below would hold for a reason unrelated to the store.
 */
vi.mock('./prisma.js', async () => {
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

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

/**
 * The filters the store is allowed to use. Anything else throws rather than
 * being quietly ignored — a fake that shrugged at `retiredAt: null` would pass
 * the retirement test without retiring anything, and one that shrugged at the
 * waiver `OR` would pass the expiry test with no expiry check in it.
 */
type ModelName =
  | 'codebaseSnapshot'
  | 'flowMap'
  | 'test'
  | 'testResult'
  | 'coverageItem'
  | 'coverageWaiver'
  | 'coverageSnapshot'
  | 'componentItem'
  | 'componentState';

const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  codebaseSnapshot: new Set(['id', 'orgId', 'projectId']),
  flowMap: new Set(['id', 'orgId', 'projectId', 'version']),
  test: new Set(['id', 'orgId', 'projectId', 'disabledAt', 'filePath']),
  testResult: new Set(['id', 'orgId', 'testId', 'runId', 'status', 'test']),
  coverageItem: new Set([
    'id',
    'orgId',
    'projectId',
    'key',
    'status',
    'retiredAt',
    // The declarer list. `loadObservedItems` filters on it with
    // `{ not: Prisma.DbNull }`, and a fake that shrugged at this filter would
    // feed source-declared rows back into the union as though another declarer
    // had named them.
    'sources',
  ]),
  coverageWaiver: new Set(['id', 'orgId', 'projectId', 'itemId', 'expiresAt']),
  coverageSnapshot: new Set(['id', 'orgId', 'projectId']),
  componentItem: new Set(['id', 'orgId', 'projectId', 'modulePath', 'exportName', 'retiredAt']),
  componentState: new Set(['id', 'orgId', 'componentId', 'kind', 'retiredAt', 'component']),
};

interface Store {
  codebaseSnapshot: Row[];
  flowMap: Row[];
  test: Row[];
  testResult: Row[];
  coverageItem: Row[];
  coverageWaiver: Row[];
  coverageSnapshot: Row[];
  componentItem: Row[];
  componentState: Row[];
}

function matchesCondition(value: unknown, cond: unknown): boolean {
  // `Prisma.DbNull` is a sentinel OBJECT, not null, and it means SQL NULL —
  // which for a `Json?` column is a different stored value from JSON `null`.
  // Resolved here rather than in `matchesWhere` so `{ not: Prisma.DbNull }`
  // composes through the `not` branch below like any other condition.
  if (cond === Prisma.DbNull) return (value ?? null) === null;
  if (cond === Prisma.JsonNull) return value === null;
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    if ('gt' in c) return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
    if ('startsWith' in c) return typeof value === 'string' && value.startsWith(c.startsWith);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: ModelName, row: Row, where: Row, store: Store): boolean {
  return Object.entries(where).every(([key, cond]) => {
    // `OR` is not a column; loadWaivers uses it for "no expiry, or not yet past".
    if (key === 'OR') {
      return (cond as Row[]).some((branch) => matchesWhere(model, row, branch, store));
    }
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    // `testResult.where.test` is a relation filter: resolve the parent and
    // apply the sub-where to it, the way the real query's join does.
    if (key === 'test' && model === 'testResult') {
      const parent = store.test.find((candidate) => candidate.id === row.testId);
      return parent ? matchesWhere('test', parent, cond as Row, store) : false;
    }
    // Same shape: `componentState.where.component.projectId`, which is how the
    // dangling-key read scopes states to a project without a projectId column.
    if (key === 'component' && model === 'componentState') {
      const parent = store.componentItem.find((candidate) => candidate.id === row.componentId);
      return parent ? matchesWhere('componentItem', parent, cond as Row, store) : false;
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((a, b) => {
    const left = a[key] instanceof Date ? a[key].getTime() : a[key];
    const right = b[key] instanceof Date ? b[key].getTime() : b[key];
    if (left === right) return 0;
    return (left < right ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  });
}

/** Applies a Prisma `select`, including the two relations the store reads. */
function projectRow(model: ModelName, row: Row, sel: Row | undefined, store: Store): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want === true) {
      out[key] = row[key] ?? null;
      continue;
    }
    if (key === 'item' && model === 'coverageWaiver') {
      const item = store.coverageItem.find((candidate) => candidate.id === row.itemId);
      out.item = item ? projectRow('coverageItem', item, (want as Row).select, store) : null;
      continue;
    }
    // `componentItem.select.states` is a to-many relation read: the component
    // inventory is counted from STORAGE rather than from the analysis it was
    // built from, so this projection is what the counts are derived through.
    if (key === 'states' && model === 'componentItem') {
      out.states = store.componentState
        .filter((candidate) => candidate.componentId === row.id && !candidate.retiredAt)
        .map((candidate) => projectRow('componentState', candidate, (want as Row).select, store));
      continue;
    }
    if (key === 'waiver' && model === 'coverageItem') {
      const waiver = store.coverageWaiver.find((candidate) => candidate.itemId === row.id);
      out.waiver = waiver
        ? projectRow('coverageWaiver', waiver, (want as Row).select, store)
        : null;
      continue;
    }
    throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
  }
  return out;
}

/**
 * Monotonic ids and timestamps.
 *
 * `createdAt` advances a full second per write rather than using the real clock:
 * the trend is ordered by it, and two snapshots written in the same millisecond
 * would make the newest-first assertion depend on insertion order, which is
 * exactly the thing the assertion is supposed to be independent of.
 */
let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}
let clock = Date.UTC(2026, 0, 1);
function nextDate(): Date {
  clock += 1000;
  return new Date(clock);
}

/**
 * A Prisma stand-in that enforces tenancy the way the extension does — merging
 * the ambient orgId into every filterable `where`, stamping it onto creates,
 * and stamping it only onto the CREATE side of an upsert, because that is what
 * lib/prisma.ts actually does and the difference is load-bearing for the
 * un-retirement path.
 */
function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where), store));

    return {
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findFirst`);
        const found = sortRows(select(where), orderBy)[0];
        return found ? projectRow(name, found, sel, store) : null;
      },
      findMany: async ({ where, orderBy, select: sel, take }: Row = {}) => {
        h.ops.push(`${name}.findMany`);
        const rows = sortRows(select(where), orderBy);
        const page = typeof take === 'number' ? rows.slice(0, take) : rows;
        return page.map((row) => projectRow(name, row, sel, store));
      },
      /**
       * `where` here is the compound unique `{ projectId_key: { … } }`, matched
       * literally rather than through the filter machinery — Prisma's unique
       * selector is not a filter and the real extension leaves it alone.
       */
      upsert: async ({ where, create, update, select: sel }: Row) => {
        h.ops.push(`${name}.upsert`);
        const unique = (where.projectId_key ??
          where.projectId_modulePath_exportName ??
          where.componentId_kind ??
          where) as Row;
        const found = store[name].find((row) =>
          Object.entries(unique).every(([key, value]) => row[key] === value),
        );
        if (found) {
          Object.assign(found, update, { lastSeenAt: nextDate() });
          return projectRow(name, found, sel, store);
        }
        const orgId = h.currentOrg();
        const row: Row = {
          id: nextId(name),
          ...unique,
          ...create,
          ...(orgId ? { orgId } : {}),
          firstSeenAt: nextDate(),
          lastSeenAt: nextDate(),
          createdAt: nextDate(),
        };
        store[name].push(row);
        return projectRow(name, row, sel, store);
      },
      updateMany: async ({ where, data }: Row = {}) => {
        h.ops.push(`${name}.updateMany`);
        const rows = select(where);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      create: async ({ data, select: sel }: Row) => {
        h.ops.push(`${name}.create`);
        const orgId = h.currentOrg();
        const row: Row = {
          id: nextId(name),
          ...data,
          ...(orgId ? { orgId } : {}),
          createdAt: nextDate(),
        };
        store[name].push(row);
        return projectRow(name, row, sel, store);
      },
    };
  };

  return {
    codebaseSnapshot: model('codebaseSnapshot'),
    flowMap: model('flowMap'),
    test: model('test'),
    testResult: model('testResult'),
    coverageItem: model('coverageItem'),
    coverageWaiver: model('coverageWaiver'),
    coverageSnapshot: model('coverageSnapshot'),
    componentItem: model('componentItem'),
    componentState: model('componentState'),
    /*
     * The store calls `$transaction` with an ARRAY of operations. Prisma's are
     * lazy and only run when the transaction opens; the fake's have already
     * run by the time the array is built, so awaiting them all is the closest
     * honest equivalent. No test here depends on rollback.
     */
    $transaction: async (ops: unknown) => Promise.all(ops as Promise<unknown>[]),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';

interface AnalysisShape {
  routes?: Array<{ route: string; file: string }>;
  endpoints?: Array<{ method: string; path: string; file: string }>;
  forms?: Array<{ id: string; fields: string[]; submitLabel?: string | null }>;
  authSurfaces?: Array<{ kind: string; path: string; file: string }>;
  filesWithContent?: number;
  detectors?: Row[];
  /**
   * OPTIONAL, and the optionality is the test. An analysis without the key
   * predates the component reader; one with `[]` ran it and found none. The
   * fixture keeps them apart by only writing the key when it is given.
   */
  components?: Row[];
}

/**
 * A CodebaseAnalysis as the Json column actually holds one.
 *
 * Written out rather than produced by `analyseCodebase`: the point of these
 * tests is what the store does with an inventory, and deriving the fixture from
 * the extractor would make every assertion here depend on the extractor's
 * heuristics changing.
 */
function analysisJson(shape: AnalysisShape): Row {
  return {
    routes: (shape.routes ?? []).map((route) => ({
      route: route.route,
      detector: 'nextAppRouter',
      file: route.file,
      evidence: `${route.file} — directory path is the URL`,
      dynamic: route.route.includes(':'),
    })),
    endpoints: (shape.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      detector: 'nextRouteHandler',
      file: endpoint.file,
      evidence: `${endpoint.file} exports ${endpoint.method}`,
      dynamic: false,
    })),
    forms: (shape.forms ?? []).map((form) => ({
      id: form.id,
      name: form.id,
      action: null,
      method: null,
      file: form.id.split('#')[0],
      submitLabel: form.submitLabel ?? null,
      fields: form.fields.map((name) => ({
        name,
        label: name,
        inputType: 'text',
        required: true,
        semantic: 'OTHER',
      })),
    })),
    authSurfaces: (shape.authSurfaces ?? []).map((surface) => ({
      kind: surface.kind,
      path: surface.path,
      from: 'route',
      file: surface.file,
      evidence: `${surface.file} declares a ${surface.kind.toLowerCase()} surface`,
    })),
    frameworks: [],
    detectors: shape.detectors ?? [],
    ...(shape.components === undefined ? {} : { components: shape.components }),
    coverage: {
      filesGiven: 8,
      filesAnalysed: 8,
      filesWithContent: shape.filesWithContent ?? 8,
      filesIgnored: 0,
      filesTruncated: 0,
      truncated: false,
    },
    notes: [],
    warnings: [],
  };
}

/** A flow map whose nodes carry no forms, so the form-axis caveat stays out. */
function flowMapJson(routes: string[], truncatedReason: string | null = null): Row {
  return {
    projectId: PROJECT,
    environmentId: 'env_1',
    version: 3,
    baseUrl: 'https://app.example.test',
    nodes: routes.map((route, index) => ({
      id: `node_${index}`,
      route,
      url: `https://app.example.test${route}`,
      title: route,
      stateKey: 'default',
      requiresRoles: [],
      behindAuth: false,
      forms: [],
      affordances: [],
      screenshotKey: null,
      a11yViolationCount: 0,
    })),
    edges: [],
    journeys: [],
    features: [],
    exploredAt: '2026-01-01T00:00:00.000Z',
    truncatedReason,
  };
}

/**
 * The baseline project: two routes, one endpoint, one form, one auth surface,
 * and a crawl that reached only `/orders`.
 *
 * One test (`t1`) navigates to `/orders` with a plain string literal — plain on
 * purpose, because a template or a variable would trip the opaque-navigation
 * rule and move every unmatched ROUTE to UNKNOWN, which is a different test.
 */
function seed(overrides: Partial<Store> = {}): Store {
  const store: Store = {
    codebaseSnapshot: [
      {
        id: 'snap_a',
        orgId: ORG,
        projectId: PROJECT,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        analysis: analysisJson({
          routes: [
            { route: '/orders', file: 'app/orders/page.tsx' },
            { route: '/admin/legacy', file: 'app/admin/legacy/page.tsx' },
          ],
          endpoints: [{ method: 'POST', path: '/api/refunds', file: 'app/api/refunds/route.ts' }],
          forms: [
            {
              id: 'app/signup/page.tsx#0',
              fields: ['emailAddress', 'password'],
              submitLabel: 'Create account',
            },
          ],
          authSurfaces: [{ kind: 'LOGIN', path: '/login', file: 'app/login/page.tsx' }],
        }),
      },
    ],
    flowMap: [
      {
        id: 'fm_a',
        orgId: ORG,
        projectId: PROJECT,
        version: 3,
        graph: flowMapJson(['/orders']),
      },
    ],
    test: [
      {
        id: 't1',
        orgId: ORG,
        projectId: PROJECT,
        name: 'orders list loads',
        filePath: 'tests/orders.spec.ts',
        code: "await page.goto('/orders');\nawait expect(heading).toBeVisible();",
        spec: null,
        tags: [],
        feature: 'Orders',
        priority: 'P1',
        type: 'E2E',
        disabledAt: null,
      },
    ],
    testResult: [],
    coverageItem: [],
    coverageWaiver: [],
    coverageSnapshot: [],
    componentItem: [],
    componentState: [],
    ...overrides,
  };
  return store;
}

let store: Store;

function install(next: Store): void {
  store = next;
  h.prisma = makeDb(store);
}

const { computeCoverage, latestSnapshot, mayRetireItems, snapshotTrend } = await import(
  './coverage-store.js'
);
const { withTenant } = await import('./prisma.js');

/** Every call runs inside a tenant scope, the way a request does. */
const compute = (options: Partial<Parameters<typeof computeCoverage>[0]> = {}) =>
  withTenant(ORG, () => computeCoverage({ orgId: ORG, projectId: PROJECT, ...options }));

const itemByKey = (key: string): Row | undefined =>
  store.coverageItem.find((row) => row.key === key);

const WRITE_OPS = ['upsert', 'create', 'update', 'updateMany', 'delete', 'deleteMany'];
const writesIssued = (): string[] =>
  h.ops.filter((op) => WRITE_OPS.includes(op.split('.')[1] ?? ''));

beforeEach(() => {
  h.ops.length = 0;
  install(seed());
});

// ─── Retirement ──────────────────────────────────────────────────────────────

describe('computeCoverage — the inventory rows', () => {
  it('writes one row per item, with the file and evidence that make it auditable', async () => {
    await compute({ persist: true });

    // Two routes, one endpoint, one form, one auth surface.
    expect(store.coverageItem).toHaveLength(5);
    const legacy = itemByKey('ROUTE:/admin/legacy')!;
    expect(legacy.file).toBe('app/admin/legacy/page.tsx');
    expect(legacy.evidence).toContain('app/admin/legacy/page.tsx');
    expect(legacy.origin).toBe('SOURCE_ONLY');
    expect(legacy.status).toBe('UNCOVERED');
    expect(legacy.retiredAt).toBeNull();

    // `/orders` was declared AND crawled, and its test passed nothing yet, so
    // it is matched but unexecuted. Both facts are on the row.
    const orders = itemByKey('ROUTE:/orders')!;
    expect(orders.origin).toBe('BOTH');
    expect(orders.status).toBe('ASSERTED_NOT_RUN');
    expect(orders.executed).toBe(false);
  });

  it('retires an item the extractor stops finding, rather than deleting it', async () => {
    await compute({ persist: true });
    const before = itemByKey('ROUTE:/admin/legacy')!;

    // The route is gone from the source read. A denominator that shrinks
    // silently is indistinguishable from one that improved.
    store.codebaseSnapshot[0]!.analysis = analysisJson({
      routes: [{ route: '/orders', file: 'app/orders/page.tsx' }],
      endpoints: [{ method: 'POST', path: '/api/refunds', file: 'app/api/refunds/route.ts' }],
      forms: [
        {
          id: 'app/signup/page.tsx#0',
          fields: ['emailAddress', 'password'],
          submitLabel: 'Create account',
        },
      ],
      authSurfaces: [{ kind: 'LOGIN', path: '/login', file: 'app/login/page.tsx' }],
    });
    await compute({ persist: true });

    // Still five rows: nothing was deleted.
    expect(store.coverageItem).toHaveLength(5);
    const after = itemByKey('ROUTE:/admin/legacy')!;
    expect(after.id).toBe(before.id);
    expect(after.retiredAt).toBeInstanceOf(Date);
    // And only that one. A retirement sweep that caught the survivors would
    // retire the whole inventory on every run.
    expect(
      store.coverageItem.filter((row) => row.retiredAt !== null).map((row) => row.key),
    ).toEqual(['ROUTE:/admin/legacy']);
  });

  it('un-retires the SAME row when the item comes back, keeping firstSeenAt', async () => {
    await compute({ persist: true });
    const original = itemByKey('ROUTE:/admin/legacy')!;
    const originalId = original.id;
    const originalFirstSeen = original.firstSeenAt;

    store.codebaseSnapshot[0]!.analysis = analysisJson({
      routes: [{ route: '/orders', file: 'app/orders/page.tsx' }],
    });
    await compute({ persist: true });
    expect(itemByKey('ROUTE:/admin/legacy')!.retiredAt).toBeInstanceOf(Date);

    // The route came back. It is the same route: a new row would reset its
    // history and lose the fact that it was ever missing.
    store.codebaseSnapshot[0]!.analysis = analysisJson({
      routes: [
        { route: '/orders', file: 'app/orders/page.tsx' },
        { route: '/admin/legacy', file: 'app/admin/legacy/page.tsx' },
      ],
    });
    await compute({ persist: true });

    const rows = store.coverageItem.filter((row) => row.key === 'ROUTE:/admin/legacy');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(originalId);
    expect(rows[0]!.firstSeenAt).toBe(originalFirstSeen);
    expect(rows[0]!.retiredAt).toBeNull();
  });
});

// ─── The snapshot and its inputs ─────────────────────────────────────────────

describe('computeCoverage — the snapshot', () => {
  it('records the inputs the number was computed from', async () => {
    const result = await compute({
      persist: true,
      commitSha: 'abc1234def',
      runId: 'run_42',
    });

    expect(store.coverageSnapshot).toHaveLength(1);
    const row = store.coverageSnapshot[0]!;
    expect(row.commitSha).toBe('abc1234def');
    expect(row.runId).toBe('run_42');
    // The analysis the denominator came from, and the crawl version — not
    // "latest", which is unresolvable months later.
    expect(row.analysisId).toBe('snap_a');
    expect(row.flowMapVersion).toBe(3);
    expect(row.testCount).toBe(1);
    expect(row.fingerprint).toBe(result.snapshot.fingerprint);
    expect(row.orgId).toBe(ORG);

    // The returned snapshot says the same thing, and carries the row's id so a
    // caller can point at the measurement it just made.
    expect(result.snapshotId).toBe(row.id);
    expect(result.snapshot.id).toBe(row.id);
    expect(result.snapshot.inputs).toEqual({
      analysisId: 'snap_a',
      flowMapVersion: 3,
      testCount: 1,
      runId: 'run_42',
    });
  });

  it('stores the caveats beside the figure they qualify', async () => {
    const result = await compute({ persist: true });

    // One item is covered-by-assertion-only and nothing has run a mutation
    // suite, so the measurement has something a reader must know first.
    expect(result.snapshot.caveats.length).toBeGreaterThan(0);
    expect(store.coverageSnapshot[0]!.caveats).toEqual(result.snapshot.caveats);
    expect(result.snapshot.caveats.join(' ')).toMatch(/never been run/i);
  });

  it('propagates a truncated crawl into the caveats rather than the number', async () => {
    store.flowMap[0]!.graph = flowMapJson(['/orders'], 'page budget of 60 reached');
    const result = await compute({ persist: false });

    expect(result.snapshot.caveats.join(' ')).toContain('page budget of 60 reached');
    // The percentage itself is unchanged by the caveat; the caveat is what
    // tells the reader the reachable set is a lower bound.
    expect(result.snapshot.totals.percent).toBe(0);
  });

  it('counts the declared-but-never-reached and reached-but-never-declared split', async () => {
    // The crawl reached a route the source never declared.
    store.flowMap[0]!.graph = flowMapJson(['/orders', '/promo/spring']);
    const result = await compute({ persist: true });

    // Four source-only items; one crawl-only; `/orders` is both.
    expect(result.snapshot.totals.declaredNeverReached).toBe(4);
    expect(result.snapshot.totals.reachedNeverDeclared).toBe(1);
    expect(store.coverageSnapshot[0]!.reachedNeverDeclared).toBe(1);
    // Reported, not suppressed: it is evidence about our own extractor.
    expect(result.snapshot.caveats.join(' ')).toMatch(/never found in the source/i);
  });

  it('names the axes it does not measure, instead of scoring them zero', async () => {
    const result = await compute({ persist: false });

    // Eight declared axes have no extractor. "0% of your component states are
    // covered" would be a lie about the customer's app.
    expect(result.unmeasuredKinds).toEqual([
      'ROLE_CELL',
      'COMPONENT_STATE',
      'FLAG_COMBINATION',
      'BACKGROUND_JOB',
      'NOTIFICATION',
      'ERROR_STATE',
      'DEVICE_LOCALE',
      'DATA_VARIANT',
    ]);
    for (const kind of result.unmeasuredKinds) {
      expect(result.snapshot.totals.byKind.find((totals) => totals.kind === kind)).toBeUndefined();
    }
    expect(result.snapshot.totals.byKind.every((totals) => totals.measured)).toBe(true);
  });
});

// ─── persist: false ──────────────────────────────────────────────────────────

describe('computeCoverage — persist: false', () => {
  it('computes a full answer and writes nothing at all', async () => {
    const result = await compute({ persist: false });

    expect(result.entries).toHaveLength(5);
    expect(result.snapshot.totals.denominator).toBe(5);

    // Asserted as "no write was ISSUED", not as "the tables look empty": a
    // write that failed silently would satisfy the weaker check.
    expect(writesIssued()).toEqual([]);
    expect(store.coverageItem).toEqual([]);
    expect(store.coverageSnapshot).toEqual([]);
    expect(result.snapshotId).toBeNull();
    // Nothing was stored, so there is no id to claim one. Null rather than the
    // empty string, which looks like an id and passes a truthiness check.
    expect(result.snapshot.id).toBeNull();
  });

  it('leaves an existing trend untouched, so a GET cannot dilute a gate delta', async () => {
    await compute({ persist: true });
    const stored = store.coverageSnapshot.map((row) => row.id);

    await compute({ persist: false });
    await compute({ persist: false });

    expect(store.coverageSnapshot.map((row) => row.id)).toEqual(stored);
  });
});

// ─── Waivers ─────────────────────────────────────────────────────────────────

describe('computeCoverage — waivers', () => {
  const WAIVED_KEY = 'ENDPOINT:POST /api/refunds';

  /** Seeds the item row a waiver has to hang off, then the waiver itself. */
  function seedWaiver(expiresAt: Date | null): void {
    store.coverageItem.push({
      id: 'item_seeded',
      orgId: ORG,
      projectId: PROJECT,
      key: WAIVED_KEY,
      kind: 'ENDPOINT',
      label: 'POST /api/refunds',
      status: 'WAIVED',
      retiredAt: null,
    });
    store.coverageWaiver.push({
      id: 'waiver_1',
      orgId: ORG,
      projectId: PROJECT,
      itemId: 'item_seeded',
      reason: 'Third-party sandbox refuses test refunds; covered by contract tests.',
      byUserId: 'user_1',
      byEmail: 'qa@example.test',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt,
    });
  }

  it('excludes a live waiver from the denominator, with its reason attached', async () => {
    seedWaiver(new Date(Date.now() + 86_400_000));
    const result = await compute({ persist: false });

    const entry = result.entries.find((candidate) => candidate.item.key === WAIVED_KEY)!;
    expect(entry.status).toBe('WAIVED');
    expect(entry.waiver?.reason).toContain('contract tests');
    // Out of the denominator, and visible as an exclusion next to the number.
    expect(result.snapshot.totals.waived).toBe(1);
    expect(result.snapshot.totals.denominator).toBe(4);
    expect(result.uncovered.map((candidate) => candidate.item.key)).not.toContain(WAIVED_KEY);
  });

  it('puts an EXPIRED waiver back in the denominator', async () => {
    // Yesterday. A waiver that keeps excluding after it lapses is a number
    // that stays flattered because nobody revisited a decision.
    seedWaiver(new Date(Date.now() - 86_400_000));
    const result = await compute({ persist: false });

    const entry = result.entries.find((candidate) => candidate.item.key === WAIVED_KEY)!;
    expect(entry.status).toBe('UNCOVERED');
    expect(entry.waiver).toBeUndefined();
    expect(result.snapshot.totals.waived).toBe(0);
    expect(result.snapshot.totals.denominator).toBe(5);
    expect(result.uncovered.map((candidate) => candidate.item.key)).toContain(WAIVED_KEY);
  });

  it('keeps a waiver with no expiry, because some exclusions are permanent', async () => {
    seedWaiver(null);
    const result = await compute({ persist: false });

    expect(result.entries.find((candidate) => candidate.item.key === WAIVED_KEY)!.status).toBe(
      'WAIVED',
    );
  });
});

// ─── Executions ──────────────────────────────────────────────────────────────

describe('loadExecutions — written is not run', () => {
  /** A result row for `t1`, which is matched to ROUTE:/orders. */
  function result(id: string, status: string, iso: string, runId: string): Row {
    return {
      id,
      orgId: ORG,
      testId: 't1',
      runId,
      status,
      createdAt: new Date(iso),
    };
  }

  it('a matched test that has never run is ASSERTED_NOT_RUN, not COVERED', async () => {
    const computed = await compute({ persist: false });

    const orders = computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!;
    expect(orders.matches).toHaveLength(1);
    expect(orders.verification.executed).toBe(false);
    expect(orders.status).toBe('ASSERTED_NOT_RUN');
    // And it is not in the numerator. A string in a spec file proves a test was
    // written, not that it runs or asserts anything.
    expect(computed.snapshot.totals.covered).toBe(0);
    expect(computed.snapshot.totals.assertedNotRun).toBe(1);
  });

  it('a matched test that ran and passed is COVERED', async () => {
    store.testResult.push(result('r1', 'PASSED', '2026-02-01T00:00:00Z', 'run_1'));
    const computed = await compute({ persist: false });

    const orders = computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!;
    expect(orders.status).toBe('COVERED');
    expect(orders.verification).toMatchObject({
      executed: true,
      lastRunId: 'run_1',
      lastStatus: 'PASSED',
    });
    expect(computed.snapshot.totals.covered).toBe(1);
    // 1 of 5 measured items, one decimal place.
    expect(computed.snapshot.totals.percent).toBe(20);
  });

  it('a test that PASSED earlier and FAILS now still counts as executed', async () => {
    // Newest first is FAILED; a pass exists in recent history.
    store.testResult.push(
      result('r_new', 'FAILED', '2026-03-01T00:00:00Z', 'run_new'),
      result('r_old', 'PASSED', '2026-02-01T00:00:00Z', 'run_old'),
    );
    const computed = await compute({ persist: false });

    const orders = computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!;
    /*
     * This half is deliberate and right. "Covered" asks whether a test exists
     * and has been shown to execute, and a currently-red test is a FOUND BUG
     * reported elsewhere — calling its route untested would send a team to
     * write a second test for the thing their first test is already failing on.
     */
    expect(orders.verification.executed).toBe(true);
    expect(orders.status).toBe('COVERED');
  });

  it('reports the OLDER passing run as the last run — pinned, and wrong', async () => {
    store.testResult.push(
      result('r_new', 'FAILED', '2026-03-01T00:00:00Z', 'run_new'),
      result('r_old', 'PASSED', '2026-02-01T00:00:00Z', 'run_old'),
    );
    const computed = await compute({ persist: false });
    const orders = computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!;

    /*
     * PINNING A DEFECT, NOT BLESSING ONE.
     *
     * FIXED. This test pinned the defect; it now pins the fix.
     *
     * `loadExecutions` used to collapse a test's history into one fact whose
     * status it "upgraded" to PASSED, overwriting the run id with the older
     * passing run's — so a surface whose only test was currently red read as
     * "last run: run_old, PASSED". Confidently wrong in the direction that
     * flatters us, which is the exact failure mode this feature's header warns
     * about.
     *
     * The shape limitation behind it is gone too: TestExecutionFact now carries
     * `atIso` so "the latest run" is answerable by date across several matched
     * tests, and `everPassed` so "has ever passed" has somewhere to live that
     * is not the status slot.
     */
    expect(orders.verification.lastRunId).toBe('run_new');
    expect(orders.verification.lastStatus).toBe('FAILED');
    // The older pass is still reported — as its own field.
    expect(orders.verification.everPassed).toBe(true);
  });

  /**
   * Changed deliberately, and the mislabel this test reported is gone.
   *
   * It asserted that a test which has only ever failed is not covered, and
   * noted that the status it landed on was ASSERTED_NOT_RUN — whose label reads
   * "a test exists but has never run", untrue of a test that runs on every
   * build and fails.
   *
   * The resolution is that a failing test IS coverage. It is covered AND
   * failing, and those are two facts. Coverage asks whether a test exists and
   * runs; whether it passes is the run report's job. Calling it uncovered
   * printed "no test has ever asserted anything about this" about a surface
   * with a test asserting something and finding a bug — and ASSERTED_NOT_RUN
   * now means literally never run, so its label is true again.
   */
  it('counts a test that has only ever failed as covered, and keeps the failure visible', async () => {
    store.testResult.push(result('r1', 'FAILED', '2026-02-01T00:00:00Z', 'run_1'));
    const computed = await compute({ persist: false });

    const orders = computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!;
    expect(orders.verification.executed).toBe(true);
    expect(orders.verification.everPassed).toBe(false);
    expect(orders.verification.lastStatus).toBe('FAILED');
    expect(orders.status).toBe('COVERED');
  });

  it('ignores results belonging to another project', async () => {
    store.test.push({
      id: 't_other',
      orgId: ORG,
      projectId: 'proj_other',
      name: 'someone else',
      filePath: 'tests/other.spec.ts',
      code: "await page.goto('/orders');",
      spec: null,
      tags: [],
      feature: null,
      priority: 'P2',
      type: 'E2E',
      disabledAt: null,
    });
    store.testResult.push({
      id: 'r_other',
      orgId: ORG,
      testId: 't_other',
      runId: 'run_other',
      status: 'PASSED',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const computed = await compute({ persist: false });
    // Another project's passing run must not mark this project's route covered.
    expect(computed.entries.find((entry) => entry.item.key === 'ROUTE:/orders')!.status).toBe(
      'ASSERTED_NOT_RUN',
    );
    expect(computed.snapshot.inputs.testCount).toBe(1);
  });

  it('counts neither disabled tests nor fixtures as coverage', async () => {
    store.test.push(
      {
        id: 't_disabled',
        orgId: ORG,
        projectId: PROJECT,
        name: 'disabled',
        filePath: 'tests/legacy.spec.ts',
        code: "await page.goto('/admin/legacy');",
        spec: null,
        tags: [],
        feature: null,
        priority: 'P2',
        type: 'E2E',
        disabledAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 't_fixture',
        orgId: ORG,
        projectId: PROJECT,
        name: 'fixture',
        filePath: 'fixtures/seed.ts',
        code: "await page.goto('/admin/legacy');",
        spec: null,
        tags: [],
        feature: null,
        priority: 'P2',
        type: 'E2E',
        disabledAt: null,
      },
    );

    const computed = await compute({ persist: false });
    // A spec that never executes is not coverage of /admin/legacy.
    expect(computed.entries.find((entry) => entry.item.key === 'ROUTE:/admin/legacy')!.status).toBe(
      'UNCOVERED',
    );
    expect(computed.snapshot.inputs.testCount).toBe(1);
  });
});

// ─── Nothing to divide ───────────────────────────────────────────────────────

describe('computeCoverage — nothing to measure', () => {
  it('returns a null percentage and caveats, not a zero and not a throw', async () => {
    install(seed({ codebaseSnapshot: [], flowMap: [], test: [] }));
    const result = await compute({ persist: true });

    // Null, never 0 and never 100. There is nothing to divide.
    expect(result.snapshot.totals.percent).toBeNull();
    expect(result.snapshot.totals.denominator).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.snapshot.inputs).toEqual({
      analysisId: null,
      flowMapVersion: null,
      testCount: 0,
      runId: null,
    });

    const caveats = result.snapshot.caveats.join(' ');
    expect(caveats).toMatch(/No source analysis has run/i);
    expect(caveats).toMatch(/Nothing has crawled/i);
    expect(caveats).toMatch(/no tests/i);

    // And the null survives the round trip to storage rather than becoming 0.
    expect(store.coverageSnapshot[0]!.percent).toBeNull();
  });

  it('records the analysis id but ignores an unreadable analysis payload', async () => {
    // The Json column was written by an older shape. Reading it defensively
    // must degrade to a crawl-only denominator, not crash the report.
    store.codebaseSnapshot[0]!.analysis = { version: 1, files: ['app/page.tsx'] };
    const result = await compute({ persist: true });

    expect(result.snapshot.inputs.analysisId).toBe('snap_a');
    // Only the crawled route survives, and it says where it came from.
    expect(result.entries.map((entry) => entry.item.key)).toEqual(['ROUTE:/orders']);
    expect(result.entries[0]!.item.origin).toBe('CRAWL_ONLY');
    expect(result.snapshot.caveats.join(' ')).toMatch(/No source analysis has run/i);
  });

  it('survives an unreadable flow map by falling back to the source', async () => {
    store.flowMap[0]!.graph = { notAGraph: true };
    const result = await compute({ persist: false });

    expect(result.entries).toHaveLength(5);
    expect(result.entries.every((entry) => entry.item.origin === 'SOURCE_ONLY')).toBe(true);
    expect(result.snapshot.caveats.join(' ')).toMatch(/Nothing has crawled/i);
    // The row's version is still unknown, which is a fact and not a zero.
    expect(result.snapshot.inputs.flowMapVersion).toBe(3);
  });
});

// ─── Reading back ────────────────────────────────────────────────────────────

describe('snapshotTrend and latestSnapshot', () => {
  it('returns stored snapshots newest first, honouring the limit', async () => {
    await compute({ persist: true, commitSha: 'commit_one' });
    await compute({ persist: true, commitSha: 'commit_two' });
    await compute({ persist: true, commitSha: 'commit_three' });

    const trend = await withTenant(ORG, () => snapshotTrend(PROJECT, 2));
    expect(trend.map((row) => row.commitSha)).toEqual(['commit_three', 'commit_two']);
    // The fields a gate's delta needs, on the row rather than recomputed.
    expect(trend[0]).toMatchObject({ denominator: 5, covered: 0, percent: 0 });
    expect(Array.isArray(trend[0]!.caveats)).toBe(true);
  });

  it('returns null rather than a zeroed row when nothing has been measured', async () => {
    expect(await withTenant(ORG, () => latestSnapshot(PROJECT))).toBeNull();

    await compute({ persist: true, commitSha: 'commit_one' });
    const latest = await withTenant(ORG, () => latestSnapshot(PROJECT));
    expect(latest?.commitSha).toBe('commit_one');
  });

  it('never returns another org’s snapshots', async () => {
    await compute({ persist: true, commitSha: 'ours' });
    store.coverageSnapshot.push({
      id: 'snapshot_theirs',
      orgId: 'org_2',
      projectId: PROJECT,
      commitSha: 'theirs',
      percent: 99,
      denominator: 1,
      covered: 1,
      createdAt: nextDate(),
      caveats: [],
      byKind: [],
    });

    const trend = await withTenant(ORG, () => snapshotTrend(PROJECT, 30));
    // Same projectId on purpose: the scope is the org, not the id in the call.
    expect(trend.map((row) => row.commitSha)).toEqual(['ours']);
  });
});

// ─── The eight-declarer union, as the store assembles it ─────────────────────

/**
 * What this file adds to the inventory's own tests.
 *
 * `buildSurfaceInventory` is tested in packages/agent over hand-built inputs.
 * The three things only this layer can get wrong are:
 *
 *   1. THE RETIREMENT SWEEP. It says "every item this computation did not see
 *      is gone". Traffic ingest and recorded sessions write `CoverageItem` rows
 *      this computation cannot derive, so a sweep over a two-declarer union
 *      would retire them and the percentage would RISE with nothing tested.
 *   2. THE PROVENANCE COLUMNS. The upsert wrote `origin` and not `sources`, so
 *      a row's stored origin and the origin derivable from its declarers
 *      disagreed and only one of them reached a screen.
 *   3. THE PARTICIPATION REPORT. An unreadable `CodebaseSnapshot` used to come
 *      back as the same `null` as no snapshot at all, which is the difference
 *      between a hole and a choice.
 */

/** One stored registry row, as a declarer this computation cannot derive wrote it. */
function observedRow(over: Partial<Row> = {}): Row {
  return {
    id: 'ci_traffic',
    orgId: ORG,
    projectId: PROJECT,
    kind: 'ROUTE',
    key: 'ROUTE:/checkout',
    label: '/checkout',
    file: null,
    line: null,
    origin: 'CRAWL_ONLY',
    evidence: '1,400 real sessions walked it',
    detector: 'traffic-ingest',
    meta: {},
    sources: ['TRAFFIC'],
    status: 'UNCOVERED',
    matches: [],
    retiredAt: null,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('computeCoverage — declarers this computation does not derive', () => {
  it('does NOT retire a traffic-declared row that no source or crawl knows about', async () => {
    install(seed({ coverageItem: [observedRow()] }));
    await compute({ persist: true });

    const checkout = itemByKey('ROUTE:/checkout')!;
    expect(checkout).toBeDefined();
    // The defect this replaces: the sweep retired it, the item left the
    // denominator, and the coverage percentage rose with nothing tested.
    expect(checkout.retiredAt).toBeNull();
    expect(checkout.sources).toEqual(['TRAFFIC']);
  });

  it('unions a traffic declarer onto a route the source also declares, and re-derives origin', async () => {
    install(seed({ coverageItem: [observedRow({ key: 'ROUTE:/orders', label: '/orders' })] }));
    await compute({ persist: true });

    const orders = itemByKey('ROUTE:/orders')!;
    expect([...(orders.sources as string[])].sort()).toEqual(['CRAWL', 'SOURCE', 'TRAFFIC']);
    // Derived from the union, not copied from the stored row's own guess.
    expect(orders.origin).toBe('BOTH');
    // And the source side still owns the file, which is what makes it clickable.
    expect(orders.file).toBe('app/orders/page.tsx');
  });

  it('writes the declarer list, so the next recompute does not re-derive a narrower one', async () => {
    await compute({ persist: true });

    const legacy = itemByKey('ROUTE:/admin/legacy')!;
    expect(legacy.sources).toEqual(['SOURCE']);
    expect(legacy.origin).toBe('SOURCE_ONLY');
    const orders = itemByKey('ROUTE:/orders')!;
    expect([...(orders.sources as string[])].sort()).toEqual(['CRAWL', 'SOURCE']);
    expect(orders.origin).toBe('BOTH');
  });

  it('does not feed a source-only stored row back into its own union', async () => {
    // A stored row whose only declarer is one this computation derives itself.
    // Re-feeding it would keep a route alive for ever after the repo stopped
    // declaring it, which makes our own extraction unfalsifiable.
    install(
      seed({
        coverageItem: [
          observedRow({ key: 'ROUTE:/deleted', label: '/deleted', sources: ['SOURCE'] }),
        ],
      }),
    );
    const result = await compute({ persist: true });

    expect(result.inventory!.complete).toBe(true);
    expect(itemByKey('ROUTE:/deleted')!.retiredAt).not.toBeNull();
  });

  it('reports every declarer that was asked, and what each one gave', async () => {
    install(seed({ coverageItem: [observedRow()] }));
    const result = await compute({ persist: true });

    const by = new Map(result.inventory!.participation.map((entry) => [entry.source, entry]));
    expect(by.get('SOURCE')!.participation).toBe('LOADED');
    expect(by.get('SOURCE')!.detail).toMatch(/snap_a: 2 route\(s\)/);
    expect(by.get('CRAWL')!.participation).toBe('LOADED');
    expect(by.get('CRAWL')!.detail).toMatch(/flow map v3: 1 node\(s\)/);
    expect(by.get('TRAFFIC')!.participation).toBe('LOADED');
    expect(by.get('TRAFFIC')!.itemsDeclared).toBe(1);
    // A declarer with no rows: NOT_CONFIGURED, with the detail saying out loud
    // that this computation cannot tell that from "ran and failed".
    expect(by.get('OPENAPI')!.participation).toBe('NOT_CONFIGURED');
    expect(by.get('OPENAPI')!.itemsDeclared).toBeNull();
    expect(by.get('OPENAPI')!.detail).toMatch(/cannot tell "never set up" from "ran and failed"/);
  });

  it('calls an unreadable analysis FAILED, not absent, and refuses to retire', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_bad',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-02T00:00:00Z'),
            analysis: { nonsense: true },
          },
        ],
        coverageItem: [observedRow({ key: 'ROUTE:/admin/legacy', label: '/admin/legacy' })],
      }),
    );
    const result = await compute({ persist: true });

    const source = result.inventory!.participation.find((entry) => entry.source === 'SOURCE')!;
    expect(source.participation).toBe('FAILED');
    expect(source.detail).toMatch(/snap_bad exists but its stored analysis/);
    expect(result.inventory!.complete).toBe(false);
    // THE WHOLE POINT. Every route that analysis declared is now missing from
    // the union, and sweeping would retire all of them and raise the number.
    expect(itemByKey('ROUTE:/admin/legacy')!.retiredAt).toBeNull();
    expect(result.snapshot.caveats.join(' ')).toMatch(/every surface it declared is missing/);
  });

  it('calls a missing analysis NOT_CONFIGURED, which is a choice and not a hole', async () => {
    install(seed({ codebaseSnapshot: [] }));
    const result = await compute({ persist: true });

    const source = result.inventory!.participation.find((entry) => entry.source === 'SOURCE')!;
    expect(source.participation).toBe('NOT_CONFIGURED');
    expect(source.detail).toMatch(/the repository was never ingested/);
  });

  it('keeps a refused surface in the stored inventory, with its rule and remedy', async () => {
    install(
      seed({
        flowMap: [
          {
            id: 'fm_b',
            orgId: ORG,
            projectId: PROJECT,
            version: 4,
            graph: {
              ...flowMapJson(['/orders']),
              excluded: [
                {
                  url: 'https://app.example.test/logout',
                  route: '/logout',
                  kind: 'SESSION_ENDING',
                  rule: 'session-ending:logout',
                  discoveredFrom: null,
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    const logout = itemByKey('ROUTE:/logout')!;
    expect(logout).toBeDefined();
    expect(logout.exercisability).toBe('UNEXERCISABLE');
    expect(logout.unexercisableReason).toBe('SESSION_ENDING');
    expect(logout.refusedByRule).toBe('session-ending:logout');
    expect(logout.exerciseDetail).toMatch(/would end the session/);
    expect(result.inventory!.heldOut.unexercisable).toBe(1);
    // In the inventory, out of the division. A destructive flow dropped instead
    // would raise the percentage.
    expect(result.snapshot.totals.unexercisable).toBe(1);
  });

  it('leaves exercisability NULL for an item nobody classified', async () => {
    await compute({ persist: true });

    // The source-declared majority. Null read as REFUSED would drop them from
    // the denominator and the percentage would jump on the day of the deploy.
    expect(itemByKey('ROUTE:/admin/legacy')!.exercisability).toBeNull();
    expect(itemByKey('ENDPOINT:POST /api/refunds')!.exercisability).toBeNull();
  });

  it('runs the reverse direction against the whole union', async () => {
    install(
      seed({
        test: [
          {
            id: 't_ghost',
            orgId: ORG,
            projectId: PROJECT,
            name: 'reaches an area nothing enumerated',
            filePath: 'tests/ghost.spec.ts',
            code: "await page.goto('/admin/reports');",
            spec: null,
            tags: [],
            feature: null,
            priority: 'P1',
            type: 'E2E',
            disabledAt: null,
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    expect(result.inventory!.reverse.measured).toBe(true);
    expect(result.inventory!.reverse.declaredSetUnderstatedByAtLeast).toBe(1);
    expect(result.inventory!.reverse.unenumerated[0]!.route).toBe('/admin/reports');
    expect(result.snapshot.caveats.join(' ')).toMatch(/upper bound/);
  });
});

describe('the retirement gate', () => {
  /*
   * The most dangerous boolean in the file, both arms.
   *
   * The `observedTruncated` arm cannot be reached through `computeCoverage`
   * without MAX_OBSERVED_ITEMS + 1 stored rows, which is why the gate is a
   * function: an untestable arm of a destructive decision is how a sweep ends
   * up retiring live surfaces and nobody finds out until the percentage jumps.
   */
  it('permits a sweep only over a complete union with a complete registry read', () => {
    expect(mayRetireItems({ unionComplete: true, readTruncated: false })).toBe(true);
  });

  it('refuses when a declarer failed, because its surfaces are missing and not gone', () => {
    expect(mayRetireItems({ unionComplete: false, readTruncated: false })).toBe(false);
  });

  it('refuses when completeness was never accounted for, because NULL is not permission', () => {
    expect(mayRetireItems({ unionComplete: null, readTruncated: false })).toBe(false);
  });

  it('refuses when the registry read was capped, however complete the union looked', () => {
    expect(mayRetireItems({ unionComplete: true, readTruncated: true })).toBe(false);
  });
});

describe('computeCoverage — retirement over a partial union', () => {
  /** The pair that proves the gate: retired when complete, kept when not. */
  const withStaleSourceRow = (analysis: Row) =>
    seed({
      codebaseSnapshot: [
        {
          id: 'snap_gate',
          orgId: ORG,
          projectId: PROJECT,
          createdAt: new Date('2026-01-02T00:00:00Z'),
          analysis,
        },
      ],
      coverageItem: [
        observedRow({
          id: 'ci_stale',
          // A route NEITHER the analysis nor the crawl declares, so it is
          // absent from `seenKeys` and the sweep is the only thing that
          // decides its fate.
          key: 'ROUTE:/retired-area',
          label: '/retired-area',
          // Declared by the repo alone, so `loadObservedItems` deliberately
          // does NOT feed it back — which is exactly what puts it at risk of
          // being retired by a pass that could not read the repo.
          sources: ['SOURCE'],
        }),
      ],
    });

  it('retires a stale source-declared row when the union is complete', async () => {
    install(
      withStaleSourceRow(analysisJson({ routes: [{ route: '/other', file: 'app/other/page.tsx' }] })),
    );
    const result = await compute({ persist: true });

    expect(result.inventory!.complete).toBe(true);
    expect(store.coverageItem.find((row) => row.id === 'ci_stale')!.retiredAt).not.toBeNull();
  });

  it('does NOT retire it when the source read failed, because the row may still be live', async () => {
    install(withStaleSourceRow({ nothing: 'readable' }));
    const result = await compute({ persist: true });

    expect(result.inventory!.complete).toBe(false);
    /*
     * THE CATASTROPHE THIS PREVENTS. The analysis failed, so every route it
     * declared is absent from the union — not retired, ABSENT. A sweep would
     * mark them all gone, the denominator would collapse to the crawl's
     * routes, and the coverage percentage would rise sharply with nothing
     * tested and nothing on screen explaining why.
     */
    expect(store.coverageItem.find((row) => row.id === 'ci_stale')!.retiredAt).toBeNull();
    expect(writesIssued()).not.toContain('coverageItem.updateMany');
  });
});

// ─── The component inventory ─────────────────────────────────────────────────

const componentJson = (over: Partial<Row> = {}): Row => ({
  modulePath: 'src/components/OrderTable.tsx',
  exportName: 'OrderTable',
  kind: 'COMPONENT',
  propsSummary: '{ orders: Order[] }',
  hasCatalogueEntry: null,
  catalogueRef: null,
  evidence: 'src/components/OrderTable.tsx exports OrderTable',
  line: 12,
  states: [
    { kind: 'DEFAULT', source: 'SOURCE', evidence: 'renders the table' },
    { kind: 'LOADING', source: 'SOURCE', evidence: 'renders <Spinner/> when `isLoading`' },
  ],
  ...over,
});

describe('computeCoverage — the component inventory', () => {
  it('stores components and their states, and counts the non-happy-path ones', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_c',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [componentJson()] }),
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    expect(store.componentItem).toHaveLength(1);
    expect(store.componentItem[0]!.modulePath).toBe('src/components/OrderTable.tsx');
    expect(store.componentState).toHaveLength(2);
    expect(result.components!.measured).toBe(true);
    expect(result.components!.own).toBe(1);
    expect(result.components!.states).toBe(2);
    expect(result.components!.nonHappyPathStates).toBe(1);
  });

  it('writes nothing, and says nothing is known, for an analysis with no component reader', async () => {
    // The baseline fixture omits the key entirely: this snapshot predates the
    // reader. `[]` would report "this project has no components" about a
    // project nobody looked at — and would retire the whole stored inventory.
    install(seed({ componentItem: [{ id: 'ci_old', orgId: ORG, projectId: PROJECT, modulePath: 'a', exportName: 'b', retiredAt: null }] }));
    const result = await compute({ persist: true });

    expect(result.components!.measured).toBe(false);
    expect(result.components!.own).toBeNull();
    expect(result.components!.states).toBeNull();
    expect(store.componentItem[0]!.retiredAt).toBeNull();
    expect(result.snapshot.caveats.join(' ')).toMatch(/predates the component reader/);
  });

  it('reports 0 as a measurement when the reader ran and found none', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_d',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [] }),
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    expect(result.components!.measured).toBe(true);
    expect(result.components!.own).toBe(0);
    expect(result.components!.states).toBe(0);
  });

  it('keeps hasCatalogueEntry NULL rather than claiming no story exists', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_e',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [componentJson()] }),
          },
        ],
      }),
    );
    await compute({ persist: true });

    expect(store.componentItem[0]!.hasCatalogueEntry).toBeNull();
  });

  it('counts a PAGE apart, because its route is already in the denominator', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_f',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({
              components: [
                componentJson(),
                componentJson({
                  modulePath: 'app/orders/page.tsx',
                  exportName: 'default',
                  kind: 'PAGE',
                  states: [],
                }),
              ],
            }),
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    // Two rows stored; one on its own axis. Adding the PAGE to a denominator
    // that already holds /orders would count one surface twice.
    expect(store.componentItem).toHaveLength(2);
    expect(result.components!.own).toBe(1);
    expect(result.components!.onAnotherAxis).toBe(1);
  });

  it('reports a state whose registry key has no row, rather than hiding it', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_g',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [componentJson()] }),
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    // Nothing mints COMPONENT_STATE registry rows yet, so every key dangles.
    // Counted in our own data rather than left to be discovered by a customer.
    expect(result.components!.danglingRegistryKeys).toBe(2);
    expect(store.componentState[0]!.coverageItemKey).toBe(
      'COMPONENT_STATE:src/components/OrderTable.tsx#OrderTable:DEFAULT',
    );
    expect(result.snapshot.caveats.join(' ')).toMatch(/dangling reference in our own data/);
  });

  it('retires a component the reader stopped finding, keeping the row', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_h',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [] }),
          },
        ],
        componentItem: [
          {
            id: 'ci_gone',
            orgId: ORG,
            projectId: PROJECT,
            modulePath: 'src/Old.tsx',
            exportName: 'Old',
            kind: 'COMPONENT',
            evidence: 'was there once',
            retiredAt: null,
          },
        ],
      }),
    );
    await compute({ persist: true });

    const gone = store.componentItem.find((row) => row.id === 'ci_gone')!;
    expect(gone).toBeDefined();
    expect(gone.retiredAt).not.toBeNull();
  });

  it('does not retire past its own cap, which would retire what the cap hid', async () => {
    /*
     * The component sweep goes through the same gate as the registry sweep, so
     * its truncated arm is the one `mayRetireItems` unit-tests above. This is
     * the integration proof that the gate is actually CALLED here: 5,001
     * components is one past MAX_COMPONENTS, so the read is a floor and the
     * stale row must survive.
     */
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_cap',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({
              components: Array.from({ length: 5001 }, (_unused, index) =>
                componentJson({
                  modulePath: `src/C${index}.tsx`,
                  exportName: `C${index}`,
                  states: [],
                }),
              ),
            }),
          },
        ],
        componentItem: [
          {
            id: 'ci_past_cap',
            orgId: ORG,
            projectId: PROJECT,
            modulePath: 'src/C9999.tsx',
            exportName: 'C9999',
            kind: 'COMPONENT',
            evidence: 'stored before, and past this run’s cap',
            retiredAt: null,
          },
        ],
      }),
    );
    const result = await compute({ persist: true });

    expect(result.components!.truncated).toBe(true);
    expect(result.snapshot.caveats.join(' ')).toMatch(/at least 1 more exist/);
    expect(store.componentItem.find((row) => row.id === 'ci_past_cap')!.retiredAt).toBeNull();
  });

  it('counts without writing on a dry run, and says the dangling count is unknown', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_i',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            analysis: analysisJson({ components: [componentJson()] }),
          },
        ],
      }),
    );
    const result = await compute({ persist: false });

    expect(store.componentItem).toHaveLength(0);
    expect(result.components!.own).toBe(1);
    // Null, not 0: we did not look, so we do not know.
    expect(result.components!.danglingRegistryKeys).toBeNull();
    expect(writesIssued()).toEqual([]);
  });
});

// ─── The product's own sentence ──────────────────────────────────────────────

/**
 * "SOURCE declare N routes; CRAWL reached M of them."
 *
 * `reconcileSurface` assembled that sentence and the arithmetic under it from
 * the day it landed, and nothing called it — correct code, tested, documented,
 * reachable from nothing but its own test. These assert the call site, not the
 * function: that the union's two sides reach it per axis, that the headline
 * comes out, and that a verb survives the projection onto the ENDPOINT axis.
 */
describe('computeCoverage — the reconciliation headline', () => {
  it('produces one report per axis, each naming its own axis', async () => {
    const result = await compute({ persist: true });

    expect(result.reconciliation!.map((report) => report.axis)).toEqual(['ROUTE', 'ENDPOINT']);
  });

  it('states the declared count, the reach and the percentage', async () => {
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    // Two routes declared by the repo; the crawl reached one of them.
    expect(routes.crawlRecall.declared).toBe(2);
    expect(routes.crawlRecall.reached).toBe(1);
    expect(routes.crawlRecall.percent).toBe(50);
    expect(routes.headline).toMatch(/SOURCE declare 2 route\(s\)/);
    expect(routes.headline).toMatch(/CRAWL reached 1 of them \(50%\)/);
    // And the sentence lands beside the number it describes.
    expect(result.snapshot.caveats.join(' ')).toMatch(/ROUTE: SOURCE declare 2 route\(s\)/);
  });

  it('refuses a reach rather than printing 0% when nothing observed', async () => {
    install(seed({ flowMap: [] }));
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    // 0% reached would be a measurement. "Nothing observed any of them" is the
    // fact.
    expect(routes.headline).toMatch(/nothing observed any of them/);
    expect(routes.headline).toMatch(/not 0% reached/);
  });

  it('splits the verb off the path on the ENDPOINT axis, rather than guessing one', async () => {
    const result = await compute({ persist: true });
    const endpoints = result.reconciliation!.find((report) => report.axis === 'ENDPOINT')!;

    expect(endpoints.crawlRecall.declared).toBe(1);
    // The row's identity keeps the method, which it could only do if the
    // projection passed `method` separately — handing over `"POST /api/refunds"`
    // as one spelling would make `normaliseEntry` parse a verb out of a path.
    expect(endpoints.rows.map((row) => row.identity)).toEqual(['POST /api/refunds']);
  });

  it('carries the declarer set through, so a traffic-only route is REACHED_BUT_NEVER_DECLARED', async () => {
    install(seed({ coverageItem: [observedRow()] }));
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    const traffic = routes.participation.find((entry) => entry.source === 'TRAFFIC')!;
    expect(traffic.counted).toBe(true);
    expect(traffic.side).toBe('REACHED');
    const checkout = routes.rows.find((row) => row.identity === '/checkout')!;
    expect(checkout.state).toBe('REACHED_BUT_NEVER_DECLARED');
  });

  it('is marked incomplete when a declarer failed, so "reconciled" is not claimed', async () => {
    install(
      seed({
        codebaseSnapshot: [
          {
            id: 'snap_bad2',
            orgId: ORG,
            projectId: PROJECT,
            createdAt: new Date('2026-01-02T00:00:00Z'),
            analysis: { unreadable: true },
          },
        ],
      }),
    );
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    expect(routes.complete).toBe(false);
    const source = routes.participation.find((entry) => entry.source === 'SOURCE')!;
    expect(source.counted).toBe(false);
    expect(source.notCountedBecause).not.toBeNull();
  });
});

describe('computeCoverage — the environment gate on the reconciliation', () => {
  it('excludes an observed item from another environment rather than merging it', async () => {
    install(
      seed({
        coverageItem: [
          observedRow({
            key: 'ROUTE:/staging-only',
            label: '/staging-only',
            // The baseline flow map is env_1. This row was observed elsewhere.
            environmentId: 'env_staging',
          }),
        ],
      }),
    );
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    /*
     * A staging observation merged into a production reconciliation turns
     * staging-only surfaces into uncovered production gaps — the defect
     * `selectFlowMap` exists to prevent for flow maps, applied to the sets they
     * feed. It stays in the INVENTORY (it is a real surface somewhere) and out
     * of THIS comparison.
     */
    expect(routes.rows.some((row) => row.identity === '/staging-only')).toBe(false);
    expect(itemByKey('ROUTE:/staging-only')).toBeDefined();
    expect(result.snapshot.caveats.join(' ')).toMatch(
      /1 observed item was recorded in a different environment/,
    );
  });

  it('keeps an observed item whose environment matches', async () => {
    install(seed({ coverageItem: [observedRow({ environmentId: 'env_1' })] }));
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    expect(routes.rows.some((row) => row.identity === '/checkout')).toBe(true);
    expect(result.snapshot.caveats.join(' ')).not.toMatch(/different environment/);
  });

  it('keeps an item that states no environment, because that is not a wrong one', async () => {
    install(seed({ coverageItem: [observedRow({ environmentId: null })] }));
    const result = await compute({ persist: true });
    const routes = result.reconciliation!.find((report) => report.axis === 'ROUTE')!;

    expect(routes.rows.some((row) => row.identity === '/checkout')).toBe(true);
  });
});
