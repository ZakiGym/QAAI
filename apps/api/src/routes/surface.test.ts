/**
 * Tests for the surface router — the dark-surface report, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. AN UNKNOWN FILTER IS A 400, NEVER AN EMPTY LIST. `?kind=ENDPOINTS` (one
 *      letter wrong) answering `items: []` reads on screen as "you have no
 *      uncovered endpoints", which is the opposite of the truth and the single
 *      most dangerous response this endpoint could give. Both `kind` and
 *      `status` are checked, and the message must name the valid values, since
 *      a 400 that does not is just a different dead end.
 *
 *   2. EVERY ROUTE CHECKS ITS SCOPE AND ITS ROLE. The auth mock below is a
 *      faithful reimplementation of middleware/auth.ts rather than the
 *      pass-through the other route tests use, specifically so that a handler
 *      missing `requireScope` FAILS here — this repo has shipped routes with no
 *      scope check before, and a pass-through mock is exactly what let that
 *      through. Reads need `tests:read`, writes need `tests:write` and MEMBER.
 *
 *   3. CROSS-TENANT IS A 404, NOT ANOTHER ORG'S DATA. Every endpoint takes a
 *      projectId straight off the URL and its only defence is the scoped prisma
 *      client, which is invisible at the call site because there is deliberately
 *      no orgId in any `where`. The fake applies the scope the way the
 *      extension in lib/prisma.ts does — including the post-filter on
 *      `findUnique`, which cannot take an extra filter — and all five endpoints
 *      are driven at a project belonging to another org.
 *
 *   4. A READ DOES NOT WRITE. GET recomputes live; only POST /recompute mints a
 *      snapshot. Minting one per dashboard open would fill the trend with
 *      duplicates and make a CI gate's delta meaningless, so this is asserted
 *      as "no snapshot row exists after N GETs" and as `lastStored: null`.
 *
 *   5. THE PAGE IS NOT THE TOTAL. `total` is the full count whatever the page
 *      holds, and `truncated` says so. A report that says "3 uncovered routes"
 *      while holding back 40 is quiet truncation, which is how a number stops
 *      being trustworthy.
 *
 *   6. A WAIVER CANNOT BE SLIPPED IN. It needs a real reason, a future expiry,
 *      a well-formed key and an item that actually exists — and every rejection
 *      is asserted on the STORED rows, not just the status code, because a 400
 *      that wrote the row anyway is worse than a 200.
 *
 * Harness: same shape as routes/badges.test.ts and routes/suites.test.ts — a
 * mocked prisma module with a real AsyncLocalStorage tenant scope, and the real
 * router driven over a loopback socket. @qaai/agent is deliberately NOT mocked:
 * the inventory and the division are what the endpoint serves, and stubbing
 * them would prove the router can serve a number rather than the right one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
  /** Every operation the router issued, as `model.operation`. */
  ops: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  audits: [],
  ops: [],
}));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    // coverage.ts is imported for `toCoverageInputs` and reads this in a
    // handler the surface router never reaches.
    ANTHROPIC_API_KEY: null,
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
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

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

/*
 * Captured rather than discarded. "Every mutation audits" is a property of
 * these endpoints — a waiver removes an item from the denominator, and an
 * exclusion with no record of who made it is the failure mode the waiver table
 * exists to avoid — so the payloads are asserted on and not just their count.
 */
vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

/*
 * The tenancy scope is real, not stubbed: every query runs in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and every org-isolation test below would pass for
 * a reason that has nothing to do with the router.
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

/*
 * NOT a pass-through, unlike the other route tests.
 *
 * `requireScope` and `requireRole` are reimplemented with the real semantics
 * from middleware/auth.ts — a wildcard scope satisfies everything, an API key
 * actor holds only what it was granted, roles compare by rank, and a refusal
 * goes to the error handler as a 403. That is the whole point: this repo has
 * shipped routes whose scope check was simply missing, and against a mock that
 * always calls next() such a route passes every test in the file.
 */
vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  const { forbidden, unauthorized } = await import('../lib/errors.js');

  type Next = (err?: unknown) => void;
  return {
    requireAuth: (req: Row, _res: Row, next: Next) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: (minimum: string) => (req: Row, _res: Row, next: Next) => {
      if (!req.actor) {
        next(unauthorized());
        return;
      }
      const rank = ROLE_RANK as Record<string, number>;
      if ((rank[req.actor.role] ?? -1) < (rank[minimum] ?? 0)) {
        next(forbidden(`This action requires the ${minimum} role or higher`));
        return;
      }
      next();
    },
    requireScope: (scope: string) => (req: Row, _res: Row, next: Next) => {
      if (!req.actor) {
        next(unauthorized());
        return;
      }
      const scopes: string[] = req.actor.scopes ?? [];
      if (!scopes.includes('*') && !scopes.includes(scope)) {
        next(forbidden(`This API key is missing the "${scope}" scope`));
        return;
      }
      next();
    },
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored — a fake that shrugged at `retiredAt: null` would
 * pass the retirement sweep with no sweep in it, and one that shrugged at the
 * waiver `OR` would pass an expiry test with no expiry check.
 */
type ModelName =
  | 'project'
  | 'user'
  | 'team'
  | 'ownershipRule'
  | 'trackerIssue'
  | 'codebaseSnapshot'
  | 'flowMap'
  | 'test'
  | 'testResult'
  | 'coverageItem'
  | 'coverageWaiver'
  | 'coverageSnapshot'
  /*
   * ── THE TABLES THE DIMENSION PASS TOUCHES ────────────────────────────────
   *
   * `componentItem` / `componentState` are READ for the COMPONENT and
   * COMPONENT_STATE cells; the five `coverage*` tables below are the write
   * paths this round added. Real delegates rather than stubs, because the
   * properties that matter — a cell retired rather than deleted, a sweep
   * scoped by cell kind so another producer's rows survive, a rollup upsert
   * idempotent on its scope key — are only observable against a fake that
   * holds the rows.
   */
  | 'componentItem'
  | 'componentState'
  | 'testCoverageEdge'
  | 'coverageFormField'
  | 'coverageItemState'
  | 'coverageTypeObligation'
  | 'coverageRollup'
  | 'coverageHistory';

const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId', 'archivedAt']),
  user: new Set(['id', 'email']),
  team: new Set(['id', 'orgId', 'slug']),
  ownershipRule: new Set(['id', 'orgId', 'projectId']),
  trackerIssue: new Set(['id', 'orgId', 'projectId', 'subject', 'causeKey']),
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
  testCoverageEdge: new Set(['id', 'orgId', 'projectId', 'itemId', 'testId', 'source', 'retiredAt']),
  coverageFormField: new Set(['id', 'orgId', 'projectId', 'itemId', 'fieldKey', 'kind', 'retiredAt']),
  /*
   * `kind` is the load-bearing entry. `CoverageItemState` has more than one
   * producer — the field pass writes COMPONENT_* cells and the page-state
   * adapter writes PAGE_*, ERROR_* and DATA_* into the same table — so the
   * retirement sweep is scoped to the kinds it produced, and a fake that
   * shrugged at the filter would make deleting that scope undetectable.
   */
  coverageItemState: new Set(['id', 'orgId', 'projectId', 'itemId', 'stateKey', 'kind', 'retiredAt']),
  coverageTypeObligation: new Set(['id', 'orgId', 'projectId', 'itemId', 'testType', 'retiredAt']),
  coverageRollup: new Set(['id', 'orgId', 'projectId', 'snapshotId', 'scopeKey', 'dimension']),
  coverageHistory: new Set(['id', 'orgId', 'projectId', 'snapshotId', 'scopeKey']),
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>(['user']);

type Store = Record<ModelName, Row[]>;

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
    if (key === 'test' && model === 'testResult') {
      const parent = store.test.find((candidate) => candidate.id === row.testId);
      return parent ? matchesWhere('test', parent, cond as Row, store) : false;
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

/**
 * Ordering, including the ARRAY form (`[{ position: 'asc' }, { createdAt: 'asc' }]`)
 * the ownership-rule query uses. A fake that read only the first clause of an
 * array — or read the array as an object — would order rules by insertion and
 * pass the last-match-wins test with no precedence in the resolver.
 */
function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, dir] = Object.entries(clause)[0] as [string, string];
      const left = a[key] instanceof Date ? a[key].getTime() : a[key];
      const right = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (left === right) continue;
      return (left < right ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

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

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}
/**
 * Timestamps advance a second per write rather than using the real clock: the
 * trend is ordered by `createdAt`, and two snapshots written in the same
 * millisecond would make the newest-first assertion depend on insertion order,
 * which is the thing that assertion is supposed to be independent of.
 */
let clock = Date.UTC(2026, 0, 1);
function nextDate(): Date {
  clock += 1000;
  return new Date(clock);
}

/**
 * A Prisma stand-in that enforces tenancy the way lib/prisma.ts does: merging
 * the ambient orgId into filterable `where`s, stamping it onto creates and onto
 * the create side of an upsert, and POST-FILTERING the unique lookups, which
 * cannot take an extra filter. That post-filter is the only thing standing
 * between `projectOr404` and another org's project, so it is modelled rather
 * than assumed.
 */
function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where), store));
    /** The unique selector, compound or not, matched literally. */
    const unique = (where: Row): Row => (where.projectId_key ?? where) as Row;
    const bySelector = (where: Row): Row | undefined =>
      store[name].find((row) =>
        Object.entries(unique(where)).every(([key, value]) => row[key] === value),
      );

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        h.ops.push(`${name}.findUnique`);
        const found = bySelector(where);
        if (!found) return null;
        // Ownership is checked on the RESULT, exactly as the extension does,
        // and a mismatch is indistinguishable from "not found".
        if (!global && found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel, store);
      },
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
      upsert: async ({ where, create, update, select: sel }: Row) => {
        h.ops.push(`${name}.upsert`);
        const found = bySelector(where);
        if (found) {
          Object.assign(found, update, { lastSeenAt: nextDate() });
          return projectRow(name, found, sel, store);
        }
        const orgId = global ? null : h.currentOrg();
        const row: Row = {
          id: nextId(name),
          ...unique(where),
          ...create,
          ...(orgId ? { orgId } : {}),
          firstSeenAt: nextDate(),
          lastSeenAt: nextDate(),
          createdAt: nextDate(),
        };
        store[name].push(row);
        return projectRow(name, row, sel, store);
      },
      update: async ({ where, data, select: sel }: Row) => {
        h.ops.push(`${name}.update`);
        const found = bySelector(where);
        // The extension pre-flights ownership and throws on a miss rather than
        // writing through a leaked id from another org.
        if (!found) throw new Error(`fake prisma: no ${name} to update`);
        if (!global && found.orgId !== h.currentOrg()) {
          throw new Error(`fake prisma: cross-tenant ${name}.update`);
        }
        Object.assign(found, data);
        return projectRow(name, found, sel, store);
      },
      updateMany: async ({ where, data }: Row = {}) => {
        h.ops.push(`${name}.updateMany`);
        const rows = select(where);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      // Used by ensureInventory to decide whether the inventory has ever been
      // materialised. Absent here, the waiver endpoints 500 instead of 201.
      count: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.count`);
        return select(where).length;
      },
      /**
       * `groupBy`, in the one shape the store uses: `by: ['kind']` with
       * `_count: { _all: true }`.
       *
       * A real grouping and not a stub, because the per-dimension stored-cell
       * counts are derived from the CELL KIND through `CELL_KIND_DIMENSION` —
       * one vocabulary, one mapping — and a fake returning a flat total would
       * make a kind filed on the wrong axis invisible. Filtered like every
       * other read, so `retiredAt: null` is applied and a retired cell is not
       * counted as live.
       */
      groupBy: async ({ by, where }: Row = {}) => {
        h.ops.push(`${name}.groupBy`);
        const keys = (by ?? []) as string[];
        const buckets = new Map<string, { row: Row; count: number }>();
        for (const row of select(where)) {
          const identity = keys.map((key) => String(row[key])).join('\u0000');
          const existing = buckets.get(identity);
          if (existing) {
            existing.count += 1;
            continue;
          }
          buckets.set(identity, {
            row: Object.fromEntries(keys.map((key) => [key, row[key]])),
            count: 1,
          });
        }
        return [...buckets.values()].map((bucket) => ({
          ...bucket.row,
          _count: { _all: bucket.count },
        }));
      },
      delete: async ({ where }: Row) => {
        h.ops.push(`${name}.delete`);
        const found = bySelector(where);
        if (!found) throw new Error(`fake prisma: no ${name} to delete`);
        if (!global && found.orgId !== h.currentOrg()) {
          throw new Error(`fake prisma: cross-tenant ${name}.delete`);
        }
        store[name].splice(store[name].indexOf(found), 1);
        return { ...found };
      },
      create: async ({ data, select: sel }: Row) => {
        h.ops.push(`${name}.create`);
        const orgId = global ? null : h.currentOrg();
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

  const db: Row = {
    // The store calls `$transaction` with an ARRAY of already-issued fake
    // operations; awaiting them all is the closest honest equivalent to
    // Prisma's lazy promises. No test here depends on rollback.
    $transaction: async (ops: unknown) => Promise.all(ops as Promise<unknown>[]),
  };
  for (const name of Object.keys(KNOWN_FILTERS) as ModelName[]) db[name] = model(name);
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
/** Same org, so a 404 on it can only come from tenancy. */
const OTHER_ORG_PROJECT = 'proj_2';

/** A CodebaseAnalysis as the Json column holds one. */
function analysisJson(): Row {
  const route = (path: string, file: string) => ({
    route: path,
    detector: 'nextAppRouter',
    file,
    evidence: `${file} — directory path is the URL`,
    dynamic: path.includes(':'),
  });
  return {
    routes: [
      route('/orders', 'app/orders/page.tsx'),
      route('/admin/legacy', 'app/admin/legacy/page.tsx'),
    ],
    endpoints: [
      {
        method: 'POST',
        path: '/api/refunds',
        detector: 'nextRouteHandler',
        file: 'app/api/refunds/route.ts',
        evidence: 'app/api/refunds/route.ts exports POST',
        dynamic: false,
      },
    ],
    forms: [
      {
        id: 'app/signup/page.tsx#0',
        name: 'signup',
        action: null,
        method: null,
        file: 'app/signup/page.tsx',
        submitLabel: 'Create account',
        fields: ['emailAddress', 'password'].map((name) => ({
          name,
          label: name,
          inputType: 'text',
          required: true,
          semantic: 'OTHER',
        })),
      },
    ],
    authSurfaces: [
      {
        kind: 'LOGIN',
        path: '/login',
        from: 'route',
        file: 'app/login/page.tsx',
        evidence: 'app/login/page.tsx declares a login surface',
      },
    ],
    frameworks: [],
    detectors: [],
    coverage: {
      filesGiven: 8,
      filesAnalysed: 8,
      filesWithContent: 8,
      filesIgnored: 0,
      filesTruncated: 0,
      truncated: false,
    },
    notes: [],
    warnings: [],
  };
}

/**
 * Nodes carry no forms, so the form-axis caveat stays out of the fixture.
 *
 * `features` is the Explorer's own grouping of crawled states, and it is what
 * the rollups attribute a surface to. Empty by default, so every test that
 * predates the rollups describes a project whose features are unknown.
 */
function flowMapJson(routes: string[], features: Row[] = []): Row {
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
    features,
    exploredAt: '2026-01-01T00:00:00.000Z',
    truncatedReason: null,
  };
}

/**
 * Five surface items, one of them covered.
 *
 * `t1` navigates to `/orders` with a plain string literal and nothing else —
 * plain because a template or a variable would trip the opaque-navigation rule
 * and move every unmatched ROUTE to UNKNOWN, and nothing else because a mention
 * of `password` or `/api/refunds` in the code would match the form or the
 * endpoint heuristically. It has a PASSED result, so `/orders` is COVERED and
 * the other four are UNCOVERED, worst-first:
 *
 *   AUTH_SURFACE:LOGIN@/login          weight 0
 *   ENDPOINT:POST /api/refunds         weight 1
 *   ROUTE:/admin/legacy                weight 2
 *   FORM:app/signup/page.tsx#0         weight 3
 */
const UNCOVERED_IN_RANK_ORDER = [
  'AUTH_SURFACE:LOGIN@/login',
  'ENDPOINT:POST /api/refunds',
  'ROUTE:/admin/legacy',
  'FORM:app/signup/page.tsx#0',
];

function seed(): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront', archivedAt: null },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else', archivedAt: null },
    ],
    user: [
      { id: 'user_1', name: null, email: 'qa@example.test' },
      { id: 'user_dana', name: 'Dana Ruiz', email: 'dana@example.test' },
    ],
    codebaseSnapshot: [
      {
        id: 'snap_a',
        orgId: ORG,
        projectId: PROJECT,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        analysis: analysisJson(),
      },
    ],
    flowMap: [
      { id: 'fm_a', orgId: ORG, projectId: PROJECT, version: 3, graph: flowMapJson(['/orders']) },
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
    testResult: [
      {
        id: 'res_1',
        orgId: ORG,
        testId: 't1',
        runId: 'run_1',
        status: 'PASSED',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    ],
    team: [
      { id: 'team_payments', orgId: ORG, slug: 'payments', name: 'Payments' },
      { id: 'team_search', orgId: ORG, slug: 'search', name: 'Search' },
    ],
    ownershipRule: [],
    trackerIssue: [],
    coverageItem: [],
    coverageWaiver: [],
    coverageSnapshot: [],
    /*
     * The component inventory and the five dimension tables, all EMPTY.
     *
     * Empty is the honest starting state and it is an assertion in its own
     * right: with no component rows the COMPONENT and COMPONENT_STATE axes
     * measure nothing and report NULL rather than 0%, and with no
     * `typeObligationPolicy` on the project row the TEST_TYPE axis owes
     * nothing. A fixture that pre-filled either would make this suite pass
     * against a denominator the customer never configured.
     */
    componentItem: [],
    componentState: [],
    testCoverageEdge: [],
    coverageFormField: [],
    coverageItemState: [],
    coverageTypeObligation: [],
    coverageRollup: [],
    coverageHistory: [],
  };
}

let store: Store;

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { surfaceRouter } = await import('./surface.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
// Mounted at the root, as index.ts does: the router declares its own paths.
app.use(surfaceRouter);
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

const get = (path: string) => call('GET', path);

/** The actor for the next request. Defaults to a session MEMBER (all scopes). */
function asActor(overrides: Partial<Hoisted['actor']> = {}): void {
  h.actor = {
    userId: 'user_1',
    orgId: ORG,
    role: 'MEMBER',
    scopes: ['*'],
    ip: null,
    ...overrides,
  };
}

const keysOf = (body: Row): string[] => (body.items as Row[]).map((entry) => entry.item.key);

const GOOD_REASON = 'Sandbox refuses test refunds; covered by contract tests instead.';

beforeEach(() => {
  asActor();
  h.audits.length = 0;
  h.ops.length = 0;
  store = seed();
  h.prisma = makeDb(store);
});

// ─── GET /surface/:projectId ─────────────────────────────────────────────────

describe('GET /surface/:projectId', () => {
  it('defaults to UNCOVERED, worst first, with the named list as the body', async () => {
    const { status, body } = await get(`/surface/${PROJECT}`);

    expect(status).toBe(200);
    expect(keysOf(body)).toEqual(UNCOVERED_IN_RANK_ORDER);
    expect(body.total).toBe(4);
    expect(body.truncated).toBe(false);
    // The list is the product, so each row carries the file it was declared in.
    const legacy = (body.items as Row[]).find((entry) => entry.item.key === 'ROUTE:/admin/legacy')!;
    expect(legacy.item.file).toBe('app/admin/legacy/page.tsx');
    expect(legacy.item.evidence).toContain('app/admin/legacy/page.tsx');
    expect(legacy.status).toBe('UNCOVERED');
  });

  it('reports the full total even when the page is smaller, and says it truncated', async () => {
    const first = await get(`/surface/${PROJECT}?limit=2`);
    expect(keysOf(first.body)).toEqual(UNCOVERED_IN_RANK_ORDER.slice(0, 2));
    // The page is 2; the truth is 4. A report that says "2" here is the quiet
    // truncation that makes a number untrustworthy.
    expect(first.body.total).toBe(4);
    expect(first.body.limit).toBe(2);
    expect(first.body.offset).toBe(0);
    expect(first.body.truncated).toBe(true);
    expect(first.body.snapshot.totals.uncovered).toBe(4);

    const last = await get(`/surface/${PROJECT}?limit=2&offset=2`);
    expect(keysOf(last.body)).toEqual(UNCOVERED_IN_RANK_ORDER.slice(2));
    expect(last.body.total).toBe(4);
    expect(last.body.truncated).toBe(false);
  });

  it('filters by status, and COVERED is separate from ASSERTED_NOT_RUN', async () => {
    const covered = await get(`/surface/${PROJECT}?status=COVERED`);
    expect(keysOf(covered.body)).toEqual(['ROUTE:/orders']);
    expect(covered.body.snapshot.totals.covered).toBe(1);

    // The same test, with its result removed: it still exists, so the item is
    // not uncovered — but it has not been shown to run, so it is not covered.
    store.testResult.length = 0;
    const asserted = await get(`/surface/${PROJECT}?status=ASSERTED_NOT_RUN`);
    expect(keysOf(asserted.body)).toEqual(['ROUTE:/orders']);
    expect(asserted.body.snapshot.totals.covered).toBe(0);
    expect(asserted.body.snapshot.totals.assertedNotRun).toBe(1);
    expect((await get(`/surface/${PROJECT}?status=COVERED`)).body.total).toBe(0);
  });

  it('filters by kind and by origin, case-insensitively on the enum', async () => {
    const endpoints = await get(`/surface/${PROJECT}?kind=endpoint,auth_surface`);
    expect(keysOf(endpoints.body)).toEqual(UNCOVERED_IN_RANK_ORDER.slice(0, 2));

    // SOURCE_ONLY is the set no runtime-only tool can see at all.
    const declaredOnly = await get(`/surface/${PROJECT}?origin=SOURCE_ONLY`);
    expect(keysOf(declaredOnly.body)).toEqual(UNCOVERED_IN_RANK_ORDER);
    const crawled = await get(`/surface/${PROJECT}?origin=BOTH`);
    // `/orders` is the only item both declared and crawled, and it is covered.
    expect(crawled.body.total).toBe(0);
  });

  it('refuses an unknown kind with a 400 naming the valid values', async () => {
    // One letter wrong. An empty list here reads as "you have no uncovered
    // endpoints", which is the opposite of the truth.
    const { status, body } = await get(`/surface/${PROJECT}?kind=ENDPOINTS`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('ENDPOINTS');
    expect(body.error.message).toContain('ENDPOINT');
    expect(body.error.message).toContain('AUTH_SURFACE');
  });

  it('refuses an unknown status with a 400 naming the valid values', async () => {
    const { status, body } = await get(`/surface/${PROJECT}?status=MISSING`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('MISSING');
    expect(body.error.message).toContain('ASSERTED_NOT_RUN');
    expect(body.error.message).toContain('WAIVED');
  });

  it('refuses a limit outside the documented range rather than clamping it', async () => {
    expect((await get(`/surface/${PROJECT}?limit=0`)).status).toBe(400);
    expect((await get(`/surface/${PROJECT}?limit=1001`)).status).toBe(400);
    expect((await get(`/surface/${PROJECT}?offset=-1`)).status).toBe(400);
    expect((await get(`/surface/${PROJECT}?limit=1000`)).status).toBe(200);
  });

  it('does not mint a snapshot, however many times it is read', async () => {
    await get(`/surface/${PROJECT}`);
    await get(`/surface/${PROJECT}`);
    const { body } = await get(`/surface/${PROJECT}`);

    // A snapshot is a claim about a point in time; one per dashboard open would
    // fill the trend with duplicates and make a gate's delta meaningless.
    expect(store.coverageSnapshot).toEqual([]);
    expect(store.coverageItem).toEqual([]);
    // Null, not the empty string: a value that looks like an id silently
    // passes any truthiness check a consumer forgets to write.
    expect(body.snapshot.id).toBeNull();
    expect(body.lastStored).toBeNull();
    expect(h.ops.filter((op) => op.endsWith('.create'))).toEqual([]);
  });

  it('names the unmeasured axes and puts the caveats beside the figure', async () => {
    const { body } = await get(`/surface/${PROJECT}`);

    // Eight axes have no extractor. Naming them is a fact about our product;
    // scoring them 0% would be a lie about the customer's application.
    expect(body.unmeasuredKinds).toEqual([
      'ROLE_CELL',
      'COMPONENT_STATE',
      'FLAG_COMBINATION',
      'BACKGROUND_JOB',
      'NOTIFICATION',
      'ERROR_STATE',
      'DEVICE_LOCALE',
      'DATA_VARIANT',
    ]);
    expect((body.snapshot.totals.byKind as Row[]).map((totals) => totals.kind)).toEqual([
      'ROUTE',
      'ENDPOINT',
      'FORM',
      'AUTH_SURFACE',
    ]);
    // In the response body next to the number, not behind a tooltip.
    expect(body.snapshot.caveats.length).toBeGreaterThan(0);
    expect((body.snapshot.caveats as string[]).join(' ')).toMatch(/mutation/i);
  });

  it('reports UNKNOWN as its own state and keeps it out of the gap list', async () => {
    // A test that navigates to a URL built at run time. Static analysis cannot
    // see where it went, so an unmatched route becomes "cannot tell" — it might
    // be the only coverage /admin/legacy has.
    store.test.push({
      id: 't2',
      orgId: ORG,
      projectId: PROJECT,
      name: 'deep link',
      filePath: 'tests/deep.spec.ts',
      code: 'await page.goto(targetUrl);',
      spec: null,
      tags: [],
      feature: null,
      priority: 'P2',
      type: 'E2E',
      disabledAt: null,
    });

    const { body } = await get(`/surface/${PROJECT}`);
    // The routes dropped out of the gap list; the endpoint, form and auth
    // surface did not, because a runtime URL says nothing about those.
    expect(keysOf(body)).toEqual([
      'AUTH_SURFACE:LOGIN@/login',
      'ENDPOINT:POST /api/refunds',
      'FORM:app/signup/page.tsx#0',
    ]);
    expect(body.snapshot.totals.unknown).toBe(1);
    // Still in the denominator: a hole in OUR knowledge must not raise the
    // percentage every time our extractor gets worse.
    expect(body.snapshot.totals.denominator).toBe(5);
    expect((body.snapshot.caveats as string[]).join(' ')).toMatch(/cannot read/i);

    const unknown = await get(`/surface/${PROJECT}?status=UNKNOWN`);
    expect(keysOf(unknown.body)).toEqual(['ROUTE:/admin/legacy']);
  });

  it('reports a null percentage, not a zero, when there is nothing to divide', async () => {
    store.codebaseSnapshot.length = 0;
    store.flowMap.length = 0;
    store.test.length = 0;

    const { status, body } = await get(`/surface/${PROJECT}`);
    expect(status).toBe(200);
    expect(body.snapshot.totals.percent).toBeNull();
    expect(body.snapshot.totals.denominator).toBe(0);
    expect(body.items).toEqual([]);
    expect((body.snapshot.caveats as string[]).join(' ')).toMatch(/No source analysis/i);
  });

  it('requires the tests:read scope', async () => {
    // A write-only API key must not be able to read the report.
    asActor({ scopes: ['tests:write'] });
    const { status, body } = await get(`/surface/${PROJECT}`);
    expect(status).toBe(403);
    expect(body.error.message).toContain('tests:read');
  });

  it('answers 404 for a project in another org, never that org’s data', async () => {
    const { status, body } = await get(`/surface/${OTHER_ORG_PROJECT}`);
    expect(status).toBe(404);
    // Indistinguishable from a project that does not exist: the API must not be
    // an existence oracle.
    expect(body.error.code).toBe('NOT_FOUND');
    expect((await get('/surface/proj_nope')).status).toBe(404);
  });
});

// ─── GET /surface/:projectId/trend ───────────────────────────────────────────

describe('GET /surface/:projectId/trend', () => {
  it('returns stored snapshots newest first, honouring the limit', async () => {
    await call('POST', `/surface/${PROJECT}/recompute`, { commitSha: 'commit_one' });
    await call('POST', `/surface/${PROJECT}/recompute`, { commitSha: 'commit_two' });

    const { status, body } = await get(`/surface/${PROJECT}/trend`);
    expect(status).toBe(200);
    expect((body.snapshots as Row[]).map((row) => row.commitSha)).toEqual([
      'commit_two',
      'commit_one',
    ]);

    const capped = await get(`/surface/${PROJECT}/trend?limit=1`);
    expect((capped.body.snapshots as Row[]).map((row) => row.commitSha)).toEqual(['commit_two']);
  });

  it('is empty rather than absent before anything has been measured', async () => {
    const { status, body } = await get(`/surface/${PROJECT}/trend`);
    expect(status).toBe(200);
    expect(body).toEqual({ projectId: PROJECT, snapshots: [] });
  });

  it('requires tests:read and is a 404 across tenants', async () => {
    expect((await get(`/surface/${OTHER_ORG_PROJECT}/trend`)).status).toBe(404);
    asActor({ scopes: ['tests:write'] });
    expect((await get(`/surface/${PROJECT}/trend`)).status).toBe(403);
  });
});

// ─── POST /surface/:projectId/recompute ──────────────────────────────────────

describe('POST /surface/:projectId/recompute', () => {
  it('persists a snapshot and returns 201 with its id', async () => {
    const { status, body } = await call('POST', `/surface/${PROJECT}/recompute`, {
      commitSha: 'abc1234',
      runId: 'run_1',
    });

    expect(status).toBe(201);
    expect(store.coverageSnapshot).toHaveLength(1);
    expect(body.snapshotId).toBe(store.coverageSnapshot[0]!.id);
    expect(body.snapshot.id).toBe(body.snapshotId);
    expect(body.snapshot.inputs).toEqual({
      analysisId: 'snap_a',
      flowMapVersion: 3,
      testCount: 1,
      runId: 'run_1',
    });
    // The inventory is addressable now, which is what makes a waiver possible.
    expect(store.coverageItem).toHaveLength(5);
    expect(body.unmeasuredKinds).toHaveLength(8);

    // And it is on the record, with the number it produced.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'coverage.recompute',
      targetType: 'Project',
      targetId: PROJECT,
      metadata: { snapshotId: body.snapshotId, percent: 20, denominator: 5 },
    });
  });

  it('is what makes lastStored non-null on a subsequent read', async () => {
    expect((await get(`/surface/${PROJECT}`)).body.lastStored).toBeNull();
    const created = await call('POST', `/surface/${PROJECT}/recompute`, {});

    const { body } = await get(`/surface/${PROJECT}`);
    // So a caller can see whether the live number differs from the one a gate
    // last acted on.
    expect(body.lastStored.id).toBe(created.body.snapshotId);
    expect(body.lastStored.percent).toBe(20);
  });

  it('accepts an empty body but refuses a commitSha too short to be one', async () => {
    expect((await call('POST', `/surface/${PROJECT}/recompute`)).status).toBe(201);
    const { status, body } = await call('POST', `/surface/${PROJECT}/recompute`, {
      commitSha: 'abc',
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('requires MEMBER and tests:write, and writes nothing when refused', async () => {
    asActor({ role: 'VIEWER' });
    expect((await call('POST', `/surface/${PROJECT}/recompute`, {})).status).toBe(403);

    asActor({ scopes: ['tests:read'] });
    const refused = await call('POST', `/surface/${PROJECT}/recompute`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('tests:write');

    expect(store.coverageSnapshot).toEqual([]);
    expect(store.coverageItem).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('is a 404 across tenants, and does not write into the other org', async () => {
    const { status } = await call('POST', `/surface/${OTHER_ORG_PROJECT}/recompute`, {});
    expect(status).toBe(404);
    expect(store.coverageSnapshot).toEqual([]);
    expect(store.coverageItem).toEqual([]);
  });
});

// ─── POST /surface/:projectId/waivers ────────────────────────────────────────

describe('POST /surface/:projectId/waivers', () => {
  const KEY = 'ROUTE:/admin/legacy';

  /** A waiver can only name an item that exists, so the inventory is stored first. */
  async function withInventory(): Promise<void> {
    await call('POST', `/surface/${PROJECT}/recompute`, {});
    h.audits.length = 0;
  }

  it('records the decision, its owner and its expiry, and excludes the item', async () => {
    await withInventory();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

    const { status, body } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: GOOD_REASON,
      expiresAt,
    });

    expect(status).toBe(201);
    expect(body.key).toBe(KEY);
    expect(body.label).toBe('/admin/legacy');
    expect(store.coverageWaiver).toHaveLength(1);
    const waiver = store.coverageWaiver[0]!;
    expect(waiver.reason).toBe(GOOD_REASON);
    // A waiver with no readable owner is a silent exclusion.
    expect(waiver.byUserId).toBe('user_1');
    expect(waiver.byEmail).toBe('qa@example.test');
    expect(waiver.expiresAt).toBeInstanceOf(Date);

    // The item's own row does not wait for the next computation.
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('WAIVED');

    // And the next read leaves it out of the denominator, with the exclusion
    // visible beside the number rather than silently applied.
    const report = await get(`/surface/${PROJECT}`);
    expect(keysOf(report.body)).not.toContain(KEY);
    expect(report.body.snapshot.totals.waived).toBe(1);
    expect(report.body.snapshot.totals.denominator).toBe(4);
    const waived = await get(`/surface/${PROJECT}?status=WAIVED`);
    expect((waived.body.items as Row[])[0]!.waiver.reason).toBe(GOOD_REASON);

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'coverage.waiver.create',
      targetType: 'CoverageItem',
      metadata: { key: KEY, reason: GOOD_REASON },
    });
  });

  it('refuses a reason too short to be one, and writes nothing', async () => {
    await withInventory();
    const { status, body } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: 'legacy',
    });

    // A waiver with no stated reason is indistinguishable from a number being
    // gamed, so nine characters is not a reason.
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(store.coverageWaiver).toEqual([]);
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('UNCOVERED');
    expect(h.audits).toEqual([]);
  });

  it('refuses an expiry that has already passed, and writes nothing', async () => {
    await withInventory();
    const { status, body } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: GOOD_REASON,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/already expired/i);
    expect(store.coverageWaiver).toEqual([]);
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('UNCOVERED');
  });

  it('refuses a string that is not a surface key, before touching the project', async () => {
    await withInventory();
    const { status, body } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: 'NOPE:/admin/legacy',
      reason: GOOD_REASON,
    });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/not a surface key/i);
    expect(store.coverageWaiver).toEqual([]);
  });

  it('refuses a key that is not in the inventory with a 404, not a created row', async () => {
    await withInventory();
    const { status, body } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: 'ROUTE:/does/not/exist',
      reason: GOOD_REASON,
    });

    // An exclusion for an item nobody can see is worse than a refusal.
    expect(status).toBe(404);
    expect(body.error.message).toMatch(/recompute/i);
    expect(store.coverageWaiver).toEqual([]);
  });

  /**
   * Changed deliberately. This asserted a 404 before anything had been
   * measured, which was the committed behaviour and a dead end: a GET never
   * persists, so on a project nobody had explicitly recomputed there were no
   * rows at all, and every gap the screen legitimately showed was impossible to
   * waive with a 404 that read like a bug.
   *
   * A write endpoint materialising the inventory it needs is the fix that does
   * not make reads start writing. The refusal that matters — a key that is not
   * in the application's surface at all — is still a 404, and is asserted by
   * the test above this one.
   */
  it('materialises the inventory on first waive rather than dead-ending', async () => {
    const { status } = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: GOOD_REASON,
    });
    expect(status).toBe(201);
    expect(store.coverageWaiver).toHaveLength(1);
    // The rows now exist, so the item is addressable from here on.
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('WAIVED');
  });

  it('updates the existing waiver rather than duplicating it', async () => {
    await withInventory();
    await call('POST', `/surface/${PROJECT}/waivers`, { key: KEY, reason: GOOD_REASON });
    const first = store.coverageWaiver[0]!.id;

    const second = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: 'Revised: the legacy admin screen is being deleted in Q2.',
    });

    expect(second.status).toBe(201);
    expect(store.coverageWaiver).toHaveLength(1);
    expect(store.coverageWaiver[0]!.id).toBe(first);
    expect(store.coverageWaiver[0]!.reason).toMatch(/deleted in Q2/);
  });

  it('requires MEMBER and tests:write, and writes nothing when refused', async () => {
    await withInventory();

    asActor({ role: 'VIEWER' });
    expect(
      (await call('POST', `/surface/${PROJECT}/waivers`, { key: KEY, reason: GOOD_REASON })).status,
    ).toBe(403);

    asActor({ scopes: ['tests:read'] });
    const refused = await call('POST', `/surface/${PROJECT}/waivers`, {
      key: KEY,
      reason: GOOD_REASON,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('tests:write');

    expect(store.coverageWaiver).toEqual([]);
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('UNCOVERED');
  });

  it('is a 404 across tenants, even for a key that exists in this org', async () => {
    await withInventory();
    const { status } = await call('POST', `/surface/${OTHER_ORG_PROJECT}/waivers`, {
      key: KEY,
      reason: GOOD_REASON,
    });
    expect(status).toBe(404);
    expect(store.coverageWaiver).toEqual([]);
  });
});

// ─── DELETE /surface/:projectId/waivers/:key ─────────────────────────────────

describe('DELETE /surface/:projectId/waivers/:key', () => {
  const KEY = 'ROUTE:/admin/legacy';

  /** Stores the inventory, then waives `key`. */
  async function waive(key: string): Promise<void> {
    await call('POST', `/surface/${PROJECT}/recompute`, {});
    await call('POST', `/surface/${PROJECT}/waivers`, { key, reason: GOOD_REASON });
    h.audits.length = 0;
  }

  it('withdraws the waiver and puts the item back as UNCOVERED', async () => {
    await waive(KEY);
    const { status, body } = await call(
      'DELETE',
      `/surface/${PROJECT}/waivers/${encodeURIComponent(KEY)}`,
    );

    expect(status).toBe(204);
    expect(body).toEqual({});
    expect(store.coverageWaiver).toEqual([]);
    // Leaving it WAIVED would keep it excluded with no waiver row behind it.
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('UNCOVERED');

    const report = await get(`/surface/${PROJECT}`);
    expect(keysOf(report.body)).toEqual(UNCOVERED_IN_RANK_ORDER);
    expect(report.body.snapshot.totals.waived).toBe(0);
    expect(report.body.snapshot.totals.denominator).toBe(5);

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'coverage.waiver.delete',
      targetType: 'CoverageItem',
      metadata: { key: KEY },
    });
  });

  it('handles a key whose own text contains a colon, slashes and a space', async () => {
    // `ENDPOINT:POST /api/refunds` encodes to three escapes. A router that
    // mishandled them would 404 on every endpoint waiver ever withdrawn.
    const endpointKey = 'ENDPOINT:POST /api/refunds';
    await waive(endpointKey);

    const { status } = await call(
      'DELETE',
      `/surface/${PROJECT}/waivers/${encodeURIComponent(endpointKey)}`,
    );
    expect(status).toBe(204);
    expect(store.coverageWaiver).toEqual([]);
    expect(store.coverageItem.find((row) => row.key === endpointKey)!.status).toBe('UNCOVERED');
  });

  it('is a 404 when there is no waiver to withdraw', async () => {
    await call('POST', `/surface/${PROJECT}/recompute`, {});
    const existing = await call('DELETE', `/surface/${PROJECT}/waivers/${encodeURIComponent(KEY)}`);
    expect(existing.status).toBe(404);
    expect(existing.body.error.message).toMatch(/waiver/i);

    // And the same for a key that is not in the inventory at all.
    const absent = await call(
      'DELETE',
      `/surface/${PROJECT}/waivers/${encodeURIComponent('ROUTE:/does/not/exist')}`,
    );
    expect(absent.status).toBe(404);
  });

  it('requires MEMBER and tests:write, and leaves the waiver in place', async () => {
    await waive(KEY);
    const path = `/surface/${PROJECT}/waivers/${encodeURIComponent(KEY)}`;

    asActor({ role: 'VIEWER' });
    expect((await call('DELETE', path)).status).toBe(403);

    asActor({ scopes: ['tests:read'] });
    const refused = await call('DELETE', path);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('tests:write');

    expect(store.coverageWaiver).toHaveLength(1);
    expect(store.coverageItem.find((row) => row.key === KEY)!.status).toBe('WAIVED');
  });

  it('is a 404 across tenants, and leaves this org’s waiver untouched', async () => {
    await waive(KEY);
    const { status } = await call(
      'DELETE',
      `/surface/${OTHER_ORG_PROJECT}/waivers/${encodeURIComponent(KEY)}`,
    );
    expect(status).toBe(404);
    expect(store.coverageWaiver).toHaveLength(1);
  });
});

// ─── GET /surface/:projectId/rollups ─────────────────────────────────────────

/**
 * The cut the product is argued about in.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A GROUP'S NUMBER IS THE GROUP'S NUMBER. The denominator of a feature
 *      includes its GAPS, or "Payments is at 31%" becomes "Payments is at
 *      100% of the parts of Payments we happen to have tested" — a number that
 *      flatters the vendor on exactly the surface the customer is worried
 *      about.
 *   2. AN ITEM NOBODY CAN ATTRIBUTE IS ITS OWN BUCKET, never folded into
 *      another group and never scored. Same for an item nobody owns.
 *   3. THE OWNER COMES FROM THE ONE RESOLVER. A rule written for tests routes
 *      gaps too, with the same precedence — because a team that said
 *      `app/checkout/** → @payments` has already said who owns checkout.
 *   4. A ZERO DENOMINATOR IS NULL, NOT 100%. A group whose only item is waived
 *      has nothing to divide by, and either number would be a claim made out
 *      of our own silence.
 */
describe('GET /surface/:projectId/rollups', () => {
  const rule = (over: Row = {}): Row => ({
    id: `rule_${store.ownershipRule.length + 1}`,
    orgId: ORG,
    projectId: PROJECT,
    position: store.ownershipRule.length,
    pathPattern: null,
    testId: null,
    suiteId: null,
    feature: null,
    ownerUserId: null,
    ownerTeamId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  /** The crawl grouped `/orders` under "Orders"; nothing else is grouped. */
  function withCrawlFeature(): void {
    store.flowMap[0]!.graph = flowMapJson(['/orders'], [{ name: 'Orders', nodeIds: ['node_0'] }]);
  }

  const featureGroup = (body: Row, label: string): Row =>
    (body.byFeature as Row[]).find((group) => group.label === label)!;
  const ownerGroup = (body: Row, label: string): Row =>
    (body.byOwner as Row[]).find((group) => group.label === label)!;

  it('cuts the same denominator by feature, gaps included', async () => {
    withCrawlFeature();
    const { status, body } = await get(`/surface/${PROJECT}/rollups`);

    expect(status).toBe(200);
    const orders = featureGroup(body, 'Orders');
    expect(orders.totals).toMatchObject({ denominator: 1, covered: 1, uncovered: 0, percent: 100 });
    expect(orders.sources).toEqual(['CRAWL']);
    expect(orders.attributed).toBe(true);

    // The other four items are not in the crawl's grouping and have no matched
    // test, so no feature can be claimed for them — and they are counted as
    // exactly that rather than attributed to the nearest-looking group.
    const unknown = featureGroup(body, 'No feature attributed');
    expect(unknown.attributed).toBe(false);
    expect(unknown.totals).toMatchObject({ denominator: 4, covered: 0, uncovered: 4, percent: 0 });
    // The honest bucket sorts last whatever its size: it is a statement about
    // our knowledge, not a work item.
    expect((body.byFeature as Row[]).at(-1)!.label).toBe('No feature attributed');

    expect(body.attribution).toMatchObject({
      items: 5,
      featureFromCrawl: 1,
      featureFromTests: 0,
      featureUnattributed: 4,
    });
    // The headline the cut is a cut OF stays on the response.
    expect(body.snapshot.totals.denominator).toBe(5);
  });

  it('falls back to the feature the matched tests agree on, and says which source it used', async () => {
    // No crawl grouping at all: `/orders` is covered by t1, whose feature is
    // "Orders", so the attribution comes from the test instead.
    const { body } = await get(`/surface/${PROJECT}/rollups`);

    const orders = featureGroup(body, 'Orders');
    expect(orders.sources).toEqual(['TESTS']);
    expect(orders.totals.covered).toBe(1);
    expect(body.attribution).toMatchObject({ featureFromCrawl: 0, featureFromTests: 1 });
  });

  it('attributes nothing when two matched tests disagree about the feature', async () => {
    // Two tests cover `/orders` and file it under different features. Picking
    // one would move a whole group's percentage on the strength of a coin toss,
    // so neither wins and the item is counted as unattributed.
    store.test.push({
      id: 't2',
      orgId: ORG,
      projectId: PROJECT,
      name: 'orders list paginates',
      filePath: 'tests/orders-page.spec.ts',
      code: "await page.goto('/orders');\nawait expect(next).toBeVisible();",
      spec: null,
      tags: [],
      feature: 'Order management',
      priority: 'P1',
      type: 'E2E',
      disabledAt: null,
    });

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    expect((body.byFeature as Row[]).map((group) => group.label)).not.toContain('Orders');
    expect((body.byFeature as Row[]).map((group) => group.label)).not.toContain('Order management');
    const unknown = featureGroup(body, 'No feature attributed');
    expect(unknown.totals).toMatchObject({ denominator: 5, covered: 1 });
    expect(body.attribution).toMatchObject({ featureFromTests: 0, featureUnattributed: 5 });
  });

  it('routes a gap to its owner with the same rules that route a failure', async () => {
    store.ownershipRule.push(
      rule({ pathPattern: 'app/api/**', ownerTeamId: 'team_payments' }),
      rule({ pathPattern: 'app/admin/**', ownerUserId: 'user_dana' }),
    );

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    const payments = ownerGroup(body, '@payments');
    // `POST /api/refunds` is declared in app/api/refunds/route.ts.
    expect(payments.totals).toMatchObject({ denominator: 1, uncovered: 1, covered: 0, percent: 0 });
    expect(payments.attributed).toBe(true);

    const dana = ownerGroup(body, 'Dana Ruiz');
    expect(dana.totals).toMatchObject({ denominator: 1, uncovered: 1 });

    // Everything else is visibly unowned rather than quietly attributed.
    const nobody = ownerGroup(body, 'Nobody owns this');
    expect(nobody.attributed).toBe(false);
    expect(nobody.totals.denominator).toBe(3);
    expect(body.attribution).toMatchObject({
      ownedItems: 2,
      unownedItems: 3,
      rulesEvaluated: 2,
      rulesUnusable: [],
    });
  });

  it('crosses the two axes, which is the sentence the feature exists for', async () => {
    withCrawlFeature();
    store.ownershipRule.push(rule({ pathPattern: 'app/orders/**', ownerTeamId: 'team_payments' }));

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    const orders = featureGroup(body, 'Orders');
    expect(orders.owners).toEqual([
      { key: 'TEAM:team_payments', label: '@payments', totals: expect.objectContaining({ percent: 100 }) },
    ]);
  });

  it('matches a FEATURE rule through the feature it just attributed', async () => {
    withCrawlFeature();
    store.ownershipRule.push(rule({ feature: 'orders', ownerTeamId: 'team_search' }));

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    // The rule names a feature, the item's feature came from the crawl, and the
    // two meet case-insensitively — the same comparison the test-side resolver
    // makes.
    expect(ownerGroup(body, '@search').totals.covered).toBe(1);
  });

  it('reports a rule it could not evaluate instead of reporting everything unowned', async () => {
    store.ownershipRule.push(rule({ pathPattern: 'app/[a-z]/**', ownerTeamId: 'team_payments' }));

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    // Routing has silently STOPPED, and from the outside that is identical to a
    // project nobody has assigned. This field is the only thing that says so.
    expect(body.attribution.rulesUnusable).toHaveLength(1);
    expect(body.attribution.ownedItems).toBe(0);
  });

  it('answers null, not 100%, for a group with nothing left to divide by', async () => {
    store.ownershipRule.push(rule({ pathPattern: 'app/api/**', ownerTeamId: 'team_payments' }));
    await call('POST', `/surface/${PROJECT}/recompute`, {});
    await call('POST', `/surface/${PROJECT}/waivers`, {
      key: 'ENDPOINT:POST /api/refunds',
      reason: GOOD_REASON,
    });

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    const payments = ownerGroup(body, '@payments');
    expect(payments.totals).toMatchObject({ denominator: 0, covered: 0, waived: 1 });
    // Not 0 and not 100: @payments owns one surface and the team has said, on
    // the record, that it is not worth testing.
    expect(payments.totals.percent).toBeNull();
  });

  it('narrows to one axis when asked, and never invents the other', async () => {
    const feature = await get(`/surface/${PROJECT}/rollups?by=feature`);
    expect(feature.body.byFeature).toBeDefined();
    expect(feature.body.byOwner).toBeUndefined();

    const owner = await get(`/surface/${PROJECT}/rollups?by=owner`);
    expect(owner.body.byOwner).toBeDefined();
    expect(owner.body.byFeature).toBeUndefined();

    const bad = await get(`/surface/${PROJECT}/rollups?by=team`);
    // An unknown value must not silently become the default: a caller asking
    // for a cut they named wrongly gets told, not handed a different one.
    expect(bad.status).toBe(400);
  });

  it('says which gaps are already on somebody’s board', async () => {
    store.trackerIssue.push(
      {
        id: 'ti_1',
        orgId: ORG,
        projectId: PROJECT,
        subject: 'COVERAGE_GAP',
        causeKey: 'abc',
        cause: 'feature=Payments kinds=* owner=*',
        provider: 'GITHUB',
        url: 'https://github.com/acme/storefront/issues/4',
        key: 'acme/storefront#4',
        title: '[QAAI] 1 untested surface in Payments — @payments',
        ownerState: 'OWNED',
        affectedCount: 1,
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      },
      {
        id: 'ti_2',
        orgId: ORG,
        projectId: PROJECT,
        subject: 'FAILURE',
        causeKey: 'def',
        cause: 'class=TimeoutError',
        provider: 'GITHUB',
        url: 'https://github.com/acme/storefront/issues/5',
        key: 'acme/storefront#5',
        title: 'something else',
        ownerState: 'OWNED',
        affectedCount: 3,
        updatedAt: new Date('2026-02-02T00:00:00Z'),
      },
    );

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    // Only the coverage tickets: a failure's ticket is not an answer to "has
    // this gap been reported?", and offering to file one twice is the
    // forty-tickets defect wearing different clothes.
    expect((body.filed as Row[]).map((row) => row.causeKey)).toEqual(['abc']);
  });

  it('reports how many coverage tickets exist when the list is only a page of them', async () => {
    /*
     * The cap is the point. `filed` is what the cockpit reads to decide whether
     * a group's "file this" button has already been pressed, so a project past
     * the limit was being told, flatly, that tickets it filed do not exist —
     * and the button then offers to file a second ticket for a gap already on
     * the board. `filedTruncated` is the flag that makes that impossible to
     * miss; `filedTotal` is the number itself.
     */
    for (let index = 0; index < 101; index += 1) {
      store.trackerIssue.push({
        id: `ti_${index}`,
        orgId: ORG,
        projectId: PROJECT,
        subject: 'COVERAGE_GAP',
        causeKey: `cause_${index}`,
        cause: `feature=F${index} kinds=* owner=*`,
        provider: 'GITHUB',
        url: `https://github.com/acme/storefront/issues/${index}`,
        key: `acme/storefront#${index}`,
        title: `[QAAI] untested surface ${index}`,
        ownerState: 'NO_RULES',
        affectedCount: 1,
        updatedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)),
      });
    }

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    expect((body.filed as Row[]).length).toBe(100);
    expect(body.filedLimit).toBe(100);
    expect(body.filedTotal).toBe(101);
    expect(body.filedTruncated).toBe(true);
  });

  it('does not claim truncation when the whole set fits', async () => {
    store.trackerIssue.push({
      id: 'ti_only',
      orgId: ORG,
      projectId: PROJECT,
      subject: 'COVERAGE_GAP',
      causeKey: 'abc',
      cause: 'feature=* kinds=* owner=*',
      provider: 'GITHUB',
      url: 'https://github.com/acme/storefront/issues/9',
      key: 'acme/storefront#9',
      title: '[QAAI] 1 untested surface',
      ownerState: 'NO_RULES',
      affectedCount: 1,
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    });

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    expect(body.filedTotal).toBe(1);
    expect(body.filedTruncated).toBe(false);
  });

  it('treats a whitespace-only feature as no feature at all', async () => {
    /*
     * `Test.feature` is free text, and a row holding `'   '` used to survive as
     * `''`: truthy going into the "did any test name a feature?" check and
     * falsy everywhere after it. The item therefore came out with
     * `feature: ''` and `featureSource: null` — contradicting
     * `AttributedItem`'s own documented invariant — and `rollUpCoverage`
     * labelled the no-feature bucket with an empty string and marked it
     * ATTRIBUTED, so a blank name in one test row turned the "we do not know"
     * count into a named feature nobody can look up.
     */
    store.test[0]!.feature = '   ';

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    const labels = (body.byFeature as Row[]).map((group) => group.label);
    expect(labels).not.toContain('');
    expect(labels).toContain('No feature attributed');

    const unknown = featureGroup(body, 'No feature attributed');
    expect(unknown.attributed).toBe(false);
    // All five items, the blank-featured one included, are unattributed.
    expect(unknown.totals).toMatchObject({ denominator: 5, covered: 1 });
    expect(body.attribution).toMatchObject({
      featureFromCrawl: 0,
      featureFromTests: 0,
      featureUnattributed: 5,
    });
  });

  it('treats a crawl feature group with a blank name as no grouping', async () => {
    // Same rule on the crawl side: a group whose name is whitespace has not
    // attributed its nodes, and must not out-rank the test-derived name.
    store.flowMap[0]!.graph = flowMapJson(['/orders'], [{ name: '  ', nodeIds: ['node_0'] }]);

    const { body } = await get(`/surface/${PROJECT}/rollups`);

    expect((body.byFeature as Row[]).map((group) => group.label)).not.toContain('  ');
    // The test-derived name wins instead, because the crawl named nothing.
    expect(featureGroup(body, 'Orders').sources).toEqual(['TESTS']);
    expect(body.attribution).toMatchObject({ featureFromCrawl: 0, featureFromTests: 1 });
  });

  it('requires tests:read and is a 404 across tenants', async () => {
    expect((await get(`/surface/${OTHER_ORG_PROJECT}/rollups`)).status).toBe(404);
    asActor({ scopes: ['tests:write'] });
    expect((await get(`/surface/${PROJECT}/rollups`)).status).toBe(403);
  });

  it('does not write a snapshot — a cut is a read, like the report it cuts', async () => {
    await get(`/surface/${PROJECT}/rollups`);
    await get(`/surface/${PROJECT}/rollups`);
    expect(store.coverageSnapshot).toEqual([]);
  });
});
