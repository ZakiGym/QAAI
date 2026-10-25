/**
 * Tests for the API-document ingest door, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. NO INGEST IS A 501, NEVER AN EMPTY SUCCESS. With no parser wired, a 200
 *      carrying `operations: []` says "your document declares nothing" — a
 *      measured claim about the customer's application manufactured out of our
 *      own missing dependency. Same for a document this build cannot decode:
 *      YAML is a 422 and not an empty read.
 *
 *   2. A RE-UPLOAD DOES NOT DELETE. An operation missing from a new version of
 *      a document is marked, listed and KEPT IN THE DENOMINATOR. Retiring it
 *      would mean a document uploaded against the wrong project raises the
 *      coverage percentage, which is the defect this whole slice exists to end.
 *      Asserted on the stored rows, not on the response.
 *
 *   3. IDEMPOTENCE IS PER OPERATION. The identical document twice creates
 *      nothing, changes no fact, and reports every operation UNCHANGED. An
 *      operation another declarer wrote is REDECLARED and never CHANGED —
 *      "the source has been edited" is unprovable against a document that has
 *      no previous version here.
 *
 *   4. EVERY CAP IS DISCLOSED AS A COUNT AND A REASON. The operation cap, the
 *      byte cap and the reconciliation scan. A capped reconciliation reports
 *      `declaredNotInRegistry: null` and a floor — never a partial count in the
 *      field a dashboard would print.
 *
 *   5. AN UNKNOWN FILTER IS A 400 THAT NAMES THE VALID VALUES. `?auth=NON`
 *      answering `[]` reads as "no operation is declared public", which is the
 *      opposite of the truth.
 *
 *   6. EVERY ROUTE CHECKS ITS SCOPE AND ITS ROLE, AND CROSS-TENANT IS A 404.
 *      The auth mock is a faithful reimplementation of middleware/auth.ts
 *      rather than a pass-through, so a handler missing `requireScope` fails
 *      here — this repo has shipped routes with no scope check before.
 *
 *   7. A URL INGEST CANNOT BE POINTED AT THE METADATA SERVICE. The resolver is
 *      injected and the fetch is asserted never to have been called.
 *
 * Harness: the same shape as routes/surface.test.ts — a mocked prisma module
 * with a real AsyncLocalStorage tenant scope, a select-honouring in-memory
 * store, and the real router driven over a loopback socket. The ingest and the
 * fetch are injected through `configureApiSurfaceIo`, so no test here opens a
 * socket to anything but its own server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
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

/**
 * @qaai/agent, REAL except for one export that is deliberately missing.
 *
 * ── WHY THIS MOCK EXISTS AT ALL ─────────────────────────────────────────────
 *
 * The ingest door answers 501 when @qaai/agent exports no `ingestApiDocument`,
 * and that export has since LANDED — so the branch became unreachable from
 * this harness and the test for it started failing against a router that is
 * correct. Deleting the test would delete the one thing standing between a
 * missing parser and a 200 carrying `operations: []`, which is a measured
 * claim about a customer's application manufactured out of our own missing
 * dependency.
 *
 * ── WHY IT SPREADS THE REAL MODULE ──────────────────────────────────────────
 *
 * Because a partial mock that replaced the prober would be worse than no test:
 * every probe test below drives the REAL `probeApiOperations` through a fake
 * transport, which is the only way the row it writes is the row the prober
 * actually produces. So exactly one export is removed, and everything else —
 * `endpointIdentity`, `probeApiOperations`, `verificationAfterProbe`,
 * `SAFE_PROBE_METHODS` — is the genuine article. The tests that need an ingest
 * inject their own through `configureApiSurfaceIo`, which takes precedence
 * over this lookup, so removing it changes nothing for them.
 */
vi.mock('@qaai/agent', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, ingestApiDocument: undefined };
});

/*
 * Captured rather than discarded. "The document body never reaches the audit
 * log" is a property of this endpoint — a specification is the customer's
 * confidential material — so the payloads are asserted on, not just counted.
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
 * NOT a pass-through. `requireScope` and `requireRole` carry the real semantics
 * from middleware/auth.ts, because against a mock that always calls next() a
 * route whose scope check is simply missing passes every test in the file.
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

type ModelName =
  | 'project'
  | 'user'
  | 'environment'
  | 'apiOperation'
  | 'apiOperationProbe'
  | 'coverageItem';

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored: a fake that shrugged at `retiredAt: null` would
 * pass the retirement tests with no retirement check in the router.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  user: new Set(['id', 'email']),
  environment: new Set(['id', 'orgId', 'projectId']),
  apiOperation: new Set([
    'id',
    'orgId',
    'projectId',
    'method',
    'pathTemplate',
    'sourceDocument',
    'authDeclaration',
    'verification',
    'retiredAt',
  ]),
  /*
   * `operation` is NOT in here on purpose — it is a RELATION filter and is
   * resolved in `select` below. Leaving it out means a relation filter on a
   * model with no declared relation throws instead of matching everything.
   */
  apiOperationProbe: new Set(['id', 'orgId', 'operationId', 'environmentId', 'answered']),
  coverageItem: new Set(['id', 'orgId', 'projectId', 'key', 'kind', 'status', 'retiredAt']),
};

/**
 * Relation filters the fake resolves, by model.
 *
 * `ApiOperationProbe` has an `orgId` and no `projectId`, so
 * `where: { operation: { projectId } }` is the ONLY thing between the history
 * read and another project's observations inside the same org. A fake that
 * ignored the key would return every probe in the org and the isolation test
 * below would pass against a router that had no such filter — which is the
 * same class of false pass as a select-blind fake.
 *
 * Modelled the way the real client behaves: the tenancy extension merges
 * `orgId` into the TOP-LEVEL where only, so the nested side is matched without
 * org scoping and the two boundaries are tested separately.
 */
const RELATIONS: Partial<Record<ModelName, { field: string; to: ModelName; fk: string }>> = {
  apiOperationProbe: { field: 'operation', to: 'apiOperation', fk: 'operationId' },
};

/**
 * Column defaults the database would apply, PER MODEL.
 *
 * Not one shared set: stamping `verification: 'DECLARED'` onto an
 * `ApiOperationProbe` row would let a read select a column that table does not
 * have and get an answer back.
 *
 * `ApiOperationProbe.observedAt` is `@default(now())` in the schema and is
 * deliberately NOT defaulted here. The probe door must write it from the
 * injected clock, and a default in the fake would hide a router that forgot —
 * the row would simply carry a plausible time nobody chose.
 */
const CREATE_DEFAULTS: Record<ModelName, Row> = {
  project: {},
  user: {},
  environment: {},
  apiOperation: {
    retiredAt: null,
    verification: 'DECLARED',
    notProbedReason: null,
    lastProbedAt: null,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
  },
  apiOperationProbe: {},
  coverageItem: {},
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>(['user']);

type Store = Record<ModelName, Row[]>;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: ModelName, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

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

/**
 * `select` is HONOURED, and that is not a convenience.
 *
 * A select-blind fake makes deleting a field from a query undetectable: the
 * router would read `row.retiredAt` from a result it never asked for, the test
 * would pass, and production would read `undefined`. Two defects survived a
 * whole slice behind fakes that shrugged at `select`.
 */
function projectRow(model: ModelName, row: Row, sel: Row | undefined): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want !== true) throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
    out[key] = row[key] ?? null;
  }
  return out;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

/**
 * `Prisma.DbNull` is a SENTINEL, not a value, and the real client turns it into
 * SQL NULL — which reads back as `null`.
 *
 * Modelled here rather than stored verbatim, and the reason is a bug this test
 * caught on its first run: with the sentinel stored as-is, the router's
 * canonical hash of a freshly written row never matched the hash of the same
 * operation on re-upload, so the idempotence test failed against a router that
 * is correct. A fake that is wrong in the DIRECTION of a false failure is
 * recoverable; one that is wrong in the direction of a false pass is how two
 * defects survive a slice.
 */
function unwrapJsonSentinels(data: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(data)) {
    const name = value?.constructor?.name;
    out[key] = name === 'DbNull' || name === 'JsonNull' || name === 'AnyNull' ? null : value;
  }
  return out;
}

/**
 * A Prisma stand-in that enforces tenancy the way lib/prisma.ts does: merging
 * the ambient orgId into filterable `where`s, stamping it onto creates, and
 * POST-FILTERING the unique lookups, which cannot take an extra filter. That
 * post-filter is the only thing between `projectOr404` and another org's
 * project, so it is modelled rather than assumed.
 */
function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const relation = RELATIONS[name];
    const select = (where: Row = {}): Row[] => {
      const filter = scopedWhere(where);
      let allowedFk: Set<string> | null = null;
      if (relation && filter[relation.field] !== undefined) {
        const nested = filter[relation.field] as Row;
        delete filter[relation.field];
        allowedFk = new Set(
          store[relation.to]
            .filter((parent) => matchesWhere(relation.to, parent, nested))
            .map((parent) => String(parent.id)),
        );
      }
      return store[name].filter(
        (row) =>
          matchesWhere(name, row, filter) &&
          (allowedFk === null || allowedFk.has(String(row[relation!.fk]))),
      );
    };
    /** The unique selector, compound or not, matched literally. */
    const unique = (where: Row): Row =>
      (where.projectId_method_pathTemplate ?? where) as Row;
    const bySelector = (where: Row): Row | undefined =>
      store[name].find((row) =>
        Object.entries(unique(where)).every(([key, value]) => row[key] === value),
      );

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        h.ops.push(`${name}.findUnique`);
        const found = bySelector(where);
        if (!found) return null;
        if (!global && found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel);
      },
      findMany: async ({ where, orderBy, select: sel, take, skip }: Row = {}) => {
        h.ops.push(`${name}.findMany`);
        const rows = sortRows(select(where), orderBy);
        const from = typeof skip === 'number' ? skip : 0;
        const page =
          typeof take === 'number' ? rows.slice(from, from + take) : rows.slice(from);
        return page.map((row) => projectRow(name, row, sel));
      },
      count: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.count`);
        return select(where).length;
      },
      create: async ({ data, select: sel }: Row) => {
        h.ops.push(`${name}.create`);
        const orgId = global ? null : h.currentOrg();
        const row: Row = {
          id: nextId(name),
          ...CREATE_DEFAULTS[name],
          ...unwrapJsonSentinels(data),
          ...(orgId ? { orgId } : {}),
        };
        store[name].push(row);
        return projectRow(name, row, sel);
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
        Object.assign(found, unwrapJsonSentinels(data));
        return projectRow(name, found, sel);
      },
    };
  };

  const db: Row = {
    /*
     * The ARRAY form, which is what the probe door uses: probe rows and the
     * operation updates land together or not at all. The callback form throws
     * rather than being quietly supported — a delegate reached through a `tx`
     * argument would be a different object from these, and a fake that handed
     * back the top-level one would make an untransacted write look transacted.
     */
    $transaction: async (operations: unknown) => {
      if (!Array.isArray(operations)) {
        throw new Error('fake prisma: $transaction callback form is not used by these routes');
      }
      /*
       * RECORDED, because an in-memory fake cannot roll anything back: this
       * implementation IS `Promise.all`, so swapping the router's
       * `$transaction` for a `Promise.all` is invisible unless the CALL is
       * observable. The op log is what lets a test say "these writes went
       * through one transaction" rather than only "they happened".
       */
      h.ops.push(`$transaction(${operations.length})`);
      return Promise.all(operations as Promise<unknown>[]);
    },
  };
  for (const name of Object.keys(KNOWN_FILTERS) as ModelName[]) db[name] = model(name);
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
/** Belongs to another org, so a 404 on it can only come from tenancy. */
const OTHER_ORG_PROJECT = 'proj_2';
/**
 * The SAME org, a different project. The one fixture that can tell a tenancy
 * check from a project check: a probe read scoped only by `orgId` passes every
 * cross-org test in this file and still answers with this project's rows.
 */
const SIBLING_PROJECT = 'proj_3';
const DOC = 'https://api.example.test/openapi.json';

const ENV = 'env_1';
/** An environment of the sibling project — probing through it must 404. */
const ENV_SIBLING = 'env_2';
/** An environment whose base URL points at the cloud metadata service. */
const ENV_METADATA = 'env_3';
/** An environment whose base URL column is blank: NO base URL, not a base URL of ''. */
const ENV_BLANK = 'env_4';
const BASE_URL = 'https://staging.example.test';

function seed(): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else' },
      { id: SIBLING_PROJECT, orgId: ORG, name: 'Another of ours' },
    ],
    user: [{ id: 'user_1', email: 'qa@example.test' }],
    environment: [
      {
        id: ENV,
        orgId: ORG,
        projectId: PROJECT,
        name: 'staging',
        kind: 'STAGING',
        baseUrl: BASE_URL,
        // Null means this environment never chose a policy, so the build's
        // default applies and `defaulted: true` is reported.
        crawlPolicy: null,
      },
      {
        id: ENV_SIBLING,
        orgId: ORG,
        projectId: SIBLING_PROJECT,
        name: 'staging',
        kind: 'STAGING',
        baseUrl: BASE_URL,
        crawlPolicy: null,
      },
      {
        id: ENV_METADATA,
        orgId: ORG,
        projectId: PROJECT,
        name: 'misconfigured',
        kind: 'STAGING',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
        crawlPolicy: null,
      },
      {
        id: ENV_BLANK,
        orgId: ORG,
        projectId: PROJECT,
        name: 'not set up yet',
        kind: 'STAGING',
        baseUrl: '   ',
        crawlPolicy: null,
      },
    ],
    apiOperation: [],
    apiOperationProbe: [],
    coverageItem: [],
  };
}

/** One operation in the shape `apiOperationSchema` accepts. */
function operation(overrides: Row = {}): Row {
  return {
    method: 'POST',
    pathTemplate: '/orders',
    operationId: 'createOrder',
    sourceDocument: DOC,
    authDeclaration: 'REQUIRED',
    parameters: [],
    requestShape: null,
    responseShapes: null,
    evidence: 'openapi.json — paths./orders.post',
    ...overrides,
  };
}

let store: Store;

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { apiSurfaceRouter, configureApiSurfaceIo } = await import('./api-surface.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json({ limit: '24mb' }));
// Mounted at the root, as index.ts does for surfaceRouter: the router declares
// its own paths.
app.use(apiSurfaceRouter);
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
const post = (path: string, body?: unknown) => call('POST', path, body);

function asActor(overrides: Partial<Hoisted['actor']> = {}): void {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null, ...overrides };
}

/**
 * An ingest that returns exactly what it is told to, so the router's diffing is
 * what is under test rather than somebody else's parser.
 */
let restoreIo: ReturnType<typeof configureApiSurfaceIo> | null = null;
let fetchCalls: string[] = [];

/**
 * Configure the I/O, remembering only the PRISTINE settings to restore.
 *
 * The guard is load-bearing: a test that wires an ingest and then a probe
 * transport would otherwise hand `afterEach` the state after the first call,
 * and restoring that leaves a fake wired into the next test — which would make
 * "no transport is a 501" pass or fail depending on the order the tests ran in.
 */
function wireIo(next: Parameters<typeof configureApiSurfaceIo>[0]): void {
  const previous = configureApiSurfaceIo(next);
  if (restoreIo === null) restoreIo = previous;
}

function wireIngest(operations: Row[], extra: Row = {}): void {
  wireIo({
    ingest: () => ({
      kind: 'OPENAPI_3',
      version: '3.0.3',
      operations,
      gaps: [],
      caps: [],
      caveats: [],
      ...extra,
    }),
    fetchDocument: async (url: string) => {
      fetchCalls.push(url);
      return {
        status: 200,
        text: JSON.stringify({ openapi: '3.0.3' }),
        bytes: 22,
        contentType: 'application/json',
      };
    },
    // Every host resolves to one public address unless a test says otherwise.
    lookup: async () => [{ address: '93.184.216.34' }],
  });
}

const DOCUMENT = JSON.stringify({ openapi: '3.0.3', paths: {} });

// ─── The probe harness ───────────────────────────────────────────────────────

interface ProbeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}
interface ProbeResponse {
  status: number | null;
  headers: Record<string, string>;
  error: string | null;
}

/**
 * Every request the prober issued, in order. The assertion that matters most
 * in this file is the EMPTY one: a refused host, an unsafe verb or a missing
 * base URL must leave this list untouched.
 */
let sent: ProbeRequest[] = [];

/** A fixed instant, so `observedAt` is an assertable value and not "about now". */
const PROBED_AT = '2026-10-24T09:00:00.000Z';

/**
 * A frozen clock whose `sleep` resolves at once.
 *
 * Frozen is not a convenience here, it is the test: the prober charges its rate
 * limit against this clock, so a frozen one makes the limit bite on every
 * request after the first — which is how "the rate limit is disclosed as a
 * delay and never as a discard" is provable without waiting a second per probe.
 */
const frozenClock = { now: () => Date.parse(PROBED_AT), sleep: async () => {} };

/** The one secret in this file. Nothing may ever echo it back. */
const CREDENTIAL_VALUE = 'Bearer qaai-test-not-a-real-token-5f3a';

function wireProbe(
  respond: (request: ProbeRequest) => ProbeResponse,
  extra: Parameters<typeof configureApiSurfaceIo>[0] = {},
): void {
  wireIo({
    probeTransport: {
      send: async (request: ProbeRequest) => {
        sent.push({ ...request, headers: { ...request.headers } });
        return respond(request);
      },
    },
    probeClock: frozenClock,
    // Every host resolves to one public address unless a test says otherwise.
    lookup: async () => [{ address: '93.184.216.34' }],
    ...extra,
  });
}

/** The commonest answer: it exists, it is routed, and the verb is fine. */
const answers200 = (): ProbeResponse => ({ status: 200, headers: {}, error: null });

let seeded = 0;

/**
 * An operation row written straight into the store.
 *
 * The ingest cannot mint a row whose `verification` is already CONFIRMED — it
 * only ever writes DECLARED — and the probe door's most important behaviour is
 * what it does to a row that IS confirmed.
 */
function seedOperation(overrides: Row = {}): Row {
  seeded += 1;
  const row: Row = {
    id: `op_seed_${seeded}`,
    orgId: ORG,
    projectId: PROJECT,
    method: 'GET',
    pathTemplate: `/seed/${seeded}`,
    operationId: null,
    sourceDocument: DOC,
    evidence: 'seeded by the test',
    authDeclaration: 'REQUIRED',
    parameters: [],
    requestShape: null,
    responseShapes: null,
    verification: 'DECLARED',
    notProbedReason: null,
    lastProbedAt: null,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    retiredAt: null,
    ...overrides,
  };
  store.apiOperation.push(row);
  return row;
}

const probe = (body: Row = { environmentId: ENV }) => post(`/api-surface/${PROJECT}/probe`, body);

beforeEach(() => {
  asActor();
  h.audits.length = 0;
  h.ops.length = 0;
  fetchCalls = [];
  sent = [];
  seeded = 0;
  store = seed();
  h.prisma = makeDb(store);
});

afterEach(() => {
  // Restoring matters: a fake ingest leaking into the next test would make the
  // "no ingest is a 501" test pass for the wrong reason.
  if (restoreIo) configureApiSurfaceIo(restoreIo);
  restoreIo = null;
});

// ─── 1. Absence of a capability is never an empty answer ────────────────────

describe('POST /api-surface/:projectId — when it cannot read', () => {
  it('501s and names the export rather than reporting an empty document', async () => {
    const { status, body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    expect(status).toBe(501);
    expect(String(body.error?.message ?? body.message)).toContain('ingestApiDocument');
    // The lie this refuses: `operations: []` with a 200.
    expect(store.apiOperation).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('422s on a document this build cannot decode, and reads nothing', async () => {
    wireIngest([operation()]);
    const { status, body } = await post(`/api-surface/${PROJECT}`, {
      document: 'openapi: 3.0.3\npaths:\n  /orders:\n    post: {}\n',
    });

    expect(status).toBe(422);
    expect(String(body.error?.message ?? body.message)).toContain('not JSON');
    // "We could not read it" and "it declares nothing" are opposite facts.
    expect(store.apiOperation).toHaveLength(0);
  });

  it('refuses a document past the byte cap instead of truncating it', async () => {
    wireIngest([operation()]);
    const huge = `{"openapi":"3.0.3","pad":"${'x'.repeat(8_000_001)}"}`;
    const { status, body } = await post(`/api-surface/${PROJECT}`, { document: huge });

    expect(status).toBe(400);
    const message = String(body.error?.message ?? body.message);
    expect(message).toContain('8000000');
    expect(message).toContain('refused rather than truncated');
    expect(store.apiOperation).toHaveLength(0);
  });
});

// ─── 2. Ingest, diff, and what a re-upload does ────────────────────────────

describe('POST /api-surface/:projectId — the diff', () => {
  it('stores what the document declares, with its provenance', async () => {
    wireIngest([operation(), operation({ method: 'GET', pathTemplate: '/orders/{id}' })]);
    const { status, body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    expect(status).toBe(201);
    expect(body.totals.new).toBe(2);
    expect(body.totals.stored).toBe(2);
    expect(store.apiOperation).toHaveLength(2);
    const created = store.apiOperation.find((row) => row.pathTemplate === '/orders')!;
    expect(created.sourceDocument).toBe('inline upload');
    expect(created.authDeclaration).toBe('REQUIRED');
    expect(created.verification).toBe('DECLARED');
    // The registry key is built with the shared helpers, so six writers cannot
    // disagree about the string byte for byte.
    expect((body.changes as Row[])[0]?.key).toBe('ENDPOINT:POST /orders');
  });

  it('is idempotent: the same document twice creates nothing and changes no fact', async () => {
    wireIngest([operation()]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    const first = { ...store.apiOperation[0] };

    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    expect(body.totals.unchanged).toBe(1);
    expect(body.totals.new).toBe(0);
    expect(store.apiOperation).toHaveLength(1);
    const after = store.apiOperation[0]!;
    // Every field but `lastSeenAt` is byte-identical. `lastSeenAt` moving is
    // the point: "this document still declares it" is a different fact from
    // "nobody has looked since March".
    for (const field of [
      'method',
      'pathTemplate',
      'operationId',
      'authDeclaration',
      'evidence',
      'sourceDocument',
      'verification',
      'retiredAt',
    ]) {
      expect(after[field]).toEqual(first[field]);
    }
  });

  it('reports a genuinely edited operation as CHANGED and stores the new facts', async () => {
    wireIngest([operation()]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });

    configureApiSurfaceIo({
      ingest: () => ({
        kind: 'OPENAPI_3',
        version: '3.0.3',
        operations: [operation({ authDeclaration: 'NONE' })],
        caps: [],
        caveats: [],
      }),
    });
    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    expect(body.totals.changed).toBe(1);
    expect(body.totals.unchanged).toBe(0);
    expect(store.apiOperation[0]!.authDeclaration).toBe('NONE');
  });

  it('calls a row another declarer wrote REDECLARED, not CHANGED', async () => {
    // A source detector got there first: same identity, no document read.
    store.apiOperation.push({
      id: 'op_source',
      orgId: ORG,
      projectId: PROJECT,
      method: 'POST',
      pathTemplate: '/orders',
      operationId: null,
      sourceDocument: 'nextRouteHandler',
      evidence: 'app/api/orders/route.ts exports POST',
      authDeclaration: 'NOT_READ',
      parameters: [],
      requestShape: null,
      responseShapes: null,
      verification: 'DECLARED',
      notProbedReason: null,
      lastProbedAt: null,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      retiredAt: null,
    });

    wireIngest([operation()]);
    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    expect(body.totals.redeclared).toBe(1);
    expect(body.totals.changed).toBe(0);
    const detail = (body.changes as Row[])[0]?.detail as string;
    expect(detail).toContain('nextRouteHandler');
    expect(detail).toContain('unprovable');
    // The document's facts are adopted — NOT_READ was our silence, not a claim.
    expect(store.apiOperation[0]!.authDeclaration).toBe('REQUIRED');
  });

  it('marks an operation the document dropped, and does NOT retire it', async () => {
    wireIngest([operation(), operation({ method: 'GET', pathTemplate: '/orders/{id}' })]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    expect(store.apiOperation).toHaveLength(2);

    configureApiSurfaceIo({
      ingest: () => ({
        kind: 'OPENAPI_3',
        version: '3.0.3',
        operations: [operation()],
        caps: [],
        caveats: [],
      }),
    });
    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    expect(body.totals.absentFromDocument).toBe(1);
    expect(body.removed.total).toBe(1);
    expect(body.removed.items[0].pathTemplate).toBe('/orders/{id}');
    expect(body.removed.items[0].requiresDecision).toBe(true);
    expect(String(body.removed.rule)).toContain('shrink the denominator');

    // THE assertion: the row is still there, still in the denominator, and its
    // evidence says why a human should look at it.
    const dropped = store.apiOperation.find((row) => row.pathTemplate === '/orders/{id}')!;
    expect(dropped.retiredAt).toBeNull();
    expect(dropped.evidence).toContain('ABSENT FROM ITS DOCUMENT');
    expect(store.apiOperation).toHaveLength(2);
  });

  it('does not stack the absence mark when the document stays wrong', async () => {
    wireIngest([operation(), operation({ method: 'GET', pathTemplate: '/orders/{id}' })]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });

    configureApiSurfaceIo({
      ingest: () => ({
        kind: 'OPENAPI_3',
        version: '3.0.3',
        operations: [operation()],
        caps: [],
        caveats: [],
      }),
    });
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    const once = store.apiOperation.find((row) => row.pathTemplate === '/orders/{id}')!.evidence;
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    const twice = store.apiOperation.find((row) => row.pathTemplate === '/orders/{id}')!.evidence;

    // Re-marked, not appended to. A row re-imported weekly for a year would
    // otherwise carry 52 marks and `evidence` would stop being a sentence.
    expect(twice).toBe(once);
    expect(twice.match(/ABSENT FROM ITS DOCUMENT/g)).toHaveLength(1);
    // The mark carries a DATE and not a timestamp, which is what makes the
    // line above deterministic: with a millisecond in it, two imports in the
    // same second produced two different strings and this test passed or
    // failed on timing.
    expect(twice).toMatch(/as of \d{4}-\d{2}-\d{2}:/);

    // And the third import wrote nothing at all for that row: the mark was
    // already correct, so there was no new fact to store.
    const updatesBefore = h.ops.filter((op) => op === 'apiOperation.update').length;
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    const updatesAfter = h.ops.filter((op) => op === 'apiOperation.update').length;
    // One update, for the operation that IS still declared (its lastSeenAt).
    expect(updatesAfter - updatesBefore).toBe(1);
  });

  it('clears the absence mark when the document declares the operation again', async () => {
    wireIngest([operation(), operation({ method: 'GET', pathTemplate: '/orders/{id}' })]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });

    // The document loses an operation…
    const shrunk = configureApiSurfaceIo({
      ingest: () => ({
        kind: 'OPENAPI_3',
        version: '3.0.3',
        operations: [operation()],
        caps: [],
        caveats: [],
      }),
    });
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    expect(
      store.apiOperation.find((row) => row.pathTemplate === '/orders/{id}')!.evidence,
    ).toContain('ABSENT FROM ITS DOCUMENT');

    // …and then gets it back.
    configureApiSurfaceIo({ ingest: shrunk.ingest });
    wireIngest([operation(), operation({ method: 'GET', pathTemplate: '/orders/{id}' })]);
    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    /*
     * `evidence` is not in the canonical hash, so this operation hashes
     * UNCHANGED — and without clearing the mark the row would say "ABSENT FROM
     * ITS DOCUMENT" for ever while the document declared it. A stale mark is a
     * false fact on a dashboard that nothing a customer does can remove.
     */
    const back = store.apiOperation.find((row) => row.pathTemplate === '/orders/{id}')!;
    expect(back.evidence).not.toContain('ABSENT FROM ITS DOCUMENT');
    expect(body.totals.absenceMarksCleared).toBe(1);
    expect(
      (body.changes as Row[]).find((entry) => entry.pathTemplate === '/orders/{id}')?.detail,
    ).toContain('declares it again');
  });

  it('reinstates a retired operation the document declares again, and says so', async () => {
    wireIngest([operation()]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
    await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason: 'The gateway spec was exported from the wrong environment.',
    });
    expect(store.apiOperation[0]!.retiredAt).not.toBeNull();

    const { body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      sourceDocument: DOC,
    });

    expect(body.totals.reinstated).toBe(1);
    expect(store.apiOperation[0]!.retiredAt).toBeNull();
    // A denominator that grew needs a line in the response, or nobody can find
    // out why the number moved.
    expect((body.changes as Row[])[0]?.change).toBe('REINSTATED');
  });

  it('counts and names an operation the ingest produced in a shape we refuse', async () => {
    wireIngest([operation(), { method: 'POST', pathTemplate: 'orders-without-a-slash' }]);
    const { body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    expect(body.totals.rejected).toBe(1);
    expect(body.rejections).toHaveLength(1);
    // Counted and named, never silently dropped: a quietly smaller import is a
    // quietly smaller denominator.
    expect(store.apiOperation).toHaveLength(1);
  });

  it('dryRun diffs without writing', async () => {
    wireIngest([operation()]);
    const { status, body } = await post(`/api-surface/${PROJECT}`, {
      document: DOCUMENT,
      dryRun: true,
    });

    expect(status).toBe(200);
    expect(body.applied).toBe(false);
    expect(body.totals.new).toBe(1);
    expect(store.apiOperation).toHaveLength(0);
  });

  it('never writes the document body to the audit log', async () => {
    wireIngest([operation()]);
    // A marker that could only have come from the uploaded bytes. The
    // document's REFERENCE belongs in the audit; its CONTENT does not — a
    // specification is the customer's confidential material.
    await post(`/api-surface/${PROJECT}`, {
      document: JSON.stringify({ openapi: '3.0.3', 'x-note': 'SHIBBOLETH-9134' }),
      sourceDocument: DOC,
    });

    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits[0])).not.toContain('SHIBBOLETH');
    expect(h.audits[0]!.metadata.sourceDocument).toBe(DOC);
    expect(h.audits[0]!.metadata.documentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── 3. Caps ────────────────────────────────────────────────────────────────

describe('POST /api-surface/:projectId — cap disclosure', () => {
  it('reports the operation cap as a count and a reason when it bites', async () => {
    const many = Array.from({ length: 5_002 }, (_, index) =>
      operation({ pathTemplate: `/thing/${index}` }),
    );
    wireIngest(many);
    const { body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    const hit = (body.capsThatBit as Row[]).find((entry) => entry.cap === 'operations');
    expect(hit).toMatchObject({ cap: 'operations', limit: 5_000, droppedAtLeast: 2 });
    expect(String(body.capRule)).toContain('hid at least 2');
    expect(store.apiOperation).toHaveLength(5_000);
  });

  it('carries the whole cap table even when nothing bit', async () => {
    wireIngest([operation()]);
    const { body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    expect(body.capsThatBit).toEqual([]);
    expect(body.caps.operations).toBe(5_000);
    expect(body.caps.documentBytes).toBe(8_000_000);
    // "No cap bit" is a different and much better fact than an empty list
    // because nobody looked.
    expect(String(body.capRule)).toContain('no cap bit');
  });

  it("passes the ingest's own cap bites through as counts, using `discarded`", async () => {
    wireIngest([operation()], {
      caps: [
        {
          cap: 'OPERATION_BUDGET',
          limit: 5_000,
          bites: 1,
          discarded: 900,
          reason: 'the operation budget was spent',
        },
      ],
    });
    const { body } = await post(`/api-surface/${PROJECT}`, { document: DOCUMENT });

    // `discarded` and never `bites`: "the budget hid at least 1" when it
    // discarded 900 is a disclosed cap with an invented size.
    expect(body.capsThatBit).toEqual([
      { cap: 'OPERATION_BUDGET', limit: 5_000, droppedAtLeast: 900 },
    ]);
  });
});

// ─── 4. The URL door ────────────────────────────────────────────────────────

describe('POST /api-surface/:projectId — fetching by URL', () => {
  it('refuses a private address and never opens a connection', async () => {
    wireIngest([operation()]);
    const { status, body } = await post(`/api-surface/${PROJECT}`, {
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('169.254.169.254');
    expect(fetchCalls).toEqual([]);
    expect(store.apiOperation).toHaveLength(0);
  });

  it('refuses a name that resolves anywhere private', async () => {
    wireIngest([operation()]);
    configureApiSurfaceIo({
      // One routable address and one link-local one is not a misconfiguration,
      // it is the attack written down.
      lookup: async () => [{ address: '93.184.216.34' }, { address: '169.254.169.254' }],
    });
    const { status } = await post(`/api-surface/${PROJECT}`, { url: DOC });

    expect(status).toBe(400);
    expect(fetchCalls).toEqual([]);
  });

  it('fetches, ingests, and labels the operations with the URL', async () => {
    wireIngest([operation()]);
    const { status, body } = await post(`/api-surface/${PROJECT}`, { url: DOC });

    expect(status).toBe(201);
    expect(fetchCalls).toEqual([DOC]);
    expect(body.sourceDocument).toBe(DOC);
    expect(store.apiOperation[0]!.sourceDocument).toBe(DOC);
  });

  it('turns a non-2xx into a 400 that names the status, and reads nothing', async () => {
    wireIngest([operation()]);
    configureApiSurfaceIo({
      fetchDocument: async (url: string) => {
        fetchCalls.push(url);
        return { status: 403, text: 'nope', bytes: 4, contentType: 'text/plain' };
      },
    });
    const { status, body } = await post(`/api-surface/${PROJECT}`, { url: DOC });

    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('403');
    expect(store.apiOperation).toHaveLength(0);
  });

  it('refuses a body with no document and a body with both', async () => {
    wireIngest([operation()]);
    expect((await post(`/api-surface/${PROJECT}`, {})).status).toBe(400);
    expect((await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, url: DOC })).status).toBe(
      400,
    );
  });
});

// ─── 5. Retiring, on purpose ────────────────────────────────────────────────

describe('POST /api-surface/:projectId/retire', () => {
  beforeEach(async () => {
    wireIngest([operation()]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
  });

  it('retires with a reason, clears the absence mark, and audits', async () => {
    const reason = 'Decommissioned in the 2026-03 release; confirmed with the platform team.';
    const { status, body } = await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason,
    });

    expect(status).toBe(200);
    expect(body.key).toBe('ENDPOINT:POST /orders');
    const row = store.apiOperation[0]!;
    expect(row.retiredAt).not.toBeNull();
    expect(row.evidence).toContain(reason);
    // A row that said both "not retired, decide about this" and "retired" is a
    // row nobody can act on.
    expect(row.evidence).not.toContain('ABSENT FROM ITS DOCUMENT');
    expect(h.audits.at(-1)!.action).toBe('apiSurface.retire');
  });

  it('refuses a shrug for a reason, and writes nothing', async () => {
    const { status } = await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason: 'old',
    });

    expect(status).toBe(400);
    expect(store.apiOperation[0]!.retiredAt).toBeNull();
  });

  it('404s on an operation that is not in the inventory', async () => {
    const { status } = await post(`/api-surface/${PROJECT}/retire`, {
      method: 'DELETE',
      pathTemplate: '/orders/{id}',
      reason: 'This endpoint has never existed anywhere.',
    });

    expect(status).toBe(404);
  });

  it('refuses retiring twice', async () => {
    const reason = 'Decommissioned in the 2026-03 release, confirmed with the platform team.';
    await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason,
    });
    const { status } = await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason,
    });

    expect(status).toBe(400);
  });
});

// ─── 6. The read ────────────────────────────────────────────────────────────

describe('GET /api-surface/:projectId', () => {
  beforeEach(async () => {
    wireIngest([
      operation(),
      operation({ method: 'GET', pathTemplate: '/orders/{id}', authDeclaration: 'NONE' }),
      operation({ method: 'DELETE', pathTemplate: '/orders/{id}', authDeclaration: 'UNSTATED' }),
    ]);
    await post(`/api-surface/${PROJECT}`, { document: DOCUMENT, sourceDocument: DOC });
  });

  it('400s on an unknown filter value and names the valid ones', async () => {
    const auth = await get(`/api-surface/${PROJECT}?auth=NON`);
    expect(auth.status).toBe(400);
    const message = String(auth.body.error?.message ?? auth.body.message);
    expect(message).toContain('NON');
    expect(message).toContain('UNSTATED');

    const verification = await get(`/api-surface/${PROJECT}?verification=CONFIRMEDD`);
    expect(verification.status).toBe(400);
    const method = await get(`/api-surface/${PROJECT}?method=POSTT`);
    expect(method.status).toBe(400);
  });

  it('filters by declared auth, which is a claim about the DOCUMENT', async () => {
    const { body } = await get(`/api-surface/${PROJECT}?auth=NONE,UNSTATED`);

    expect((body.operations as Row[]).map((entry) => entry.method).sort()).toEqual([
      'DELETE',
      'GET',
    ]);
    // UNSTATED and NONE are different facts; a filter that merged them would
    // put "the document is silent" into the negative-auth generator's input.
    const unstated = (body.operations as Row[]).find((entry) => entry.method === 'DELETE')!;
    expect(unstated.authDeclaration).toBe('UNSTATED');
  });

  it('reports the full total even when the page is smaller, and says it truncated', async () => {
    const { body } = await get(`/api-surface/${PROJECT}?limit=2`);

    expect((body.operations as Row[])).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.truncated).toBe(true);
    expect(body.limit).toBe(2);
  });

  it('excludes retired rows by default and can be asked for them', async () => {
    await post(`/api-surface/${PROJECT}/retire`, {
      method: 'POST',
      pathTemplate: '/orders',
      reason: 'Decommissioned in the 2026-03 release; platform team confirmed.',
    });

    expect((await get(`/api-surface/${PROJECT}`)).body.total).toBe(2);
    expect((await get(`/api-surface/${PROJECT}?retired=INCLUDE`)).body.total).toBe(3);
    const only = await get(`/api-surface/${PROJECT}?retired=ONLY`);
    expect(only.body.total).toBe(1);
    expect((only.body.operations as Row[])[0]?.retiredAtIso).not.toBeNull();
  });

  it('reads the registry without guessing an origin for a row that recorded none', async () => {
    store.coverageItem.push(
      {
        id: 'item_1',
        orgId: ORG,
        projectId: PROJECT,
        kind: 'ENDPOINT',
        key: 'ENDPOINT:POST /orders',
        status: 'COVERED',
        sources: ['CRAWL', 'SOURCE'],
        retiredAt: null,
      },
      {
        id: 'item_2',
        orgId: ORG,
        projectId: PROJECT,
        kind: 'ENDPOINT',
        key: 'ENDPOINT:GET /orders/:param',
        status: 'UNCOVERED',
        // A row written before the `sources` column existed.
        sources: null,
        retiredAt: null,
      },
    );

    const { body } = await get(`/api-surface/${PROJECT}`);
    const rows = body.operations as Row[];
    const covered = rows.find((entry) => entry.key === 'ENDPOINT:POST /orders')!;
    expect(covered.registry).toMatchObject({
      inRegistry: true,
      status: 'COVERED',
      origin: 'BOTH',
    });

    /*
     * `/orders/{id}` canonicalises to `/orders/:param` through the SAME
     * `canonicalRoute` every other writer uses — which is the point of building
     * the key with the shared helpers. The document's own spelling survives on
     * `pathTemplate` for a human to match against.
     */
    const legacy = rows.find((entry) => entry.key === 'ENDPOINT:GET /orders/:param')!;
    // Null, not a guess. Defaulting to BOTH would be the flattering answer and
    // SOURCE_ONLY the alarming one; both would be invented.
    expect(legacy.registry.inRegistry).toBe(true);
    expect(legacy.registry.origin).toBeNull();

    const absent = rows.find((entry) => entry.key === 'ENDPOINT:DELETE /orders/:param')!;
    expect(absent.registry).toMatchObject({ inRegistry: false, status: null, origin: null });
  });

  it('counts the declared operations the registry has never seen', async () => {
    store.coverageItem.push({
      id: 'item_1',
      orgId: ORG,
      projectId: PROJECT,
      kind: 'ENDPOINT',
      key: 'ENDPOINT:POST /orders',
      status: 'COVERED',
      sources: ['CRAWL'],
      retiredAt: null,
    });

    const { body } = await get(`/api-surface/${PROJECT}`);

    // THE sentence: three declared, one in the registry, two nothing has ever
    // reached.
    expect(body.reconciliation).toMatchObject({
      declaredOperations: 3,
      registryEndpointItems: 1,
      registryCovered: 1,
      declaredNotInRegistry: 2,
      atLeastDeclaredNotInRegistry: null,
      scanTruncated: false,
    });
    expect(String(body.reconciliation.rule)).toContain('2 of 3');
  });

  it('reports a capped reconciliation as a FLOOR and nulls the exact count', async () => {
    // 10,001 declared operations: one past the scan limit.
    for (let index = 0; index < 10_001; index += 1) {
      store.apiOperation.push({
        id: `op_bulk_${index}`,
        orgId: ORG,
        projectId: PROJECT,
        method: 'GET',
        pathTemplate: `/bulk/${index}`,
        operationId: null,
        sourceDocument: DOC,
        evidence: 'bulk',
        authDeclaration: 'REQUIRED',
        parameters: [],
        requestShape: null,
        responseShapes: null,
        verification: 'DECLARED',
        notProbedReason: null,
        lastProbedAt: null,
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
        retiredAt: null,
      });
    }

    const { body } = await get(`/api-surface/${PROJECT}?limit=1`);

    expect(body.reconciliation.scanTruncated).toBe(true);
    // Null and not a partial count. An undisclosed cap here makes the number
    // smaller, and smaller is the direction that flatters us.
    expect(body.reconciliation.declaredNotInRegistry).toBeNull();
    expect(body.reconciliation.atLeastDeclaredNotInRegistry).toBe(10_000);
    expect(String(body.reconciliation.rule)).toContain('at least');
  });

  it('filters to the registry gaps on request, and `false` does not filter', async () => {
    store.coverageItem.push({
      id: 'item_1',
      orgId: ORG,
      projectId: PROJECT,
      kind: 'ENDPOINT',
      key: 'ENDPOINT:POST /orders',
      status: 'COVERED',
      sources: ['CRAWL'],
      retiredAt: null,
    });

    expect((await get(`/api-surface/${PROJECT}?notInRegistry=true`)).body.operations).toHaveLength(
      2,
    );
    // `z.coerce.boolean()` would read "false" as true and silently show only
    // the gaps.
    expect((await get(`/api-surface/${PROJECT}?notInRegistry=false`)).body.operations).toHaveLength(
      3,
    );
  });

  it('says on every read why the two inventories are still two', async () => {
    const { body } = await get(`/api-surface/${PROJECT}`);
    expect(String(body.reconciliation.note)).toContain('computeCoverage');
  });
});

// ─── 8. The probe writer ────────────────────────────────────────────────────

describe('POST /api-surface/:projectId/probe — when it cannot ask', () => {
  it('501s and names the transport rather than reporting an empty observation', async () => {
    seedOperation({ pathTemplate: '/orders' });
    const { status, body } = await probe();

    expect(status).toBe(501);
    expect(String(body.error?.message ?? body.message)).toContain('probe transport');
    // The lie this refuses: a 200 saying "0 probes, nothing disagrees".
    expect(store.apiOperationProbe).toHaveLength(0);
    expect(store.apiOperation[0]!.verification).toBe('DECLARED');
    expect(h.audits).toHaveLength(0);
  });

  it('with no base URL every operation is NOT_PROBED / NO_BASE_URL and nothing is issued', async () => {
    const declared = seedOperation({ pathTemplate: '/orders' });
    const confirmed = seedOperation({ pathTemplate: '/invoices', verification: 'CONFIRMED' });
    wireProbe(answers200);

    // No environment at all, and then an environment whose column is blank:
    // both are "there is nowhere to send a request", not "it answered nothing".
    for (const body of [{}, { environmentId: ENV_BLANK }]) {
      const response = await post(`/api-surface/${PROJECT}/probe`, body);

      expect(response.status).toBe(200);
      expect(response.body.baseUrl).toBeNull();
      expect(response.body.verdicts.notProbedByReason.NO_BASE_URL).toBe(2);
      expect(String(JSON.stringify(response.body.caveats))).toContain('configuration gap');
    }

    expect(sent).toEqual([]);
    expect(store.apiOperationProbe).toHaveLength(0);
    const after = store.apiOperation.find((row) => row.id === declared.id)!;
    expect(after.verification).toBe('NOT_PROBED');
    expect(after.notProbedReason).toBe('NO_BASE_URL');
    // Nothing was probed, so nothing may claim a probe happened.
    expect(after.lastProbedAt).toBeNull();
    /*
     * And a run that could not ask anything must not UNDO what an earlier
     * probe proved: NOT_PROBED may not displace a standing CONFIRMED.
     */
    const standing = store.apiOperation.find((row) => row.id === confirmed.id)!;
    expect(standing.verification).toBe('CONFIRMED');
    expect(standing.notProbedReason).toBeNull();
  });

  it('refuses a base URL that does not classify as public, and never calls the transport', async () => {
    seedOperation({ pathTemplate: '/orders' });
    wireProbe(answers200);

    const literal = await post(`/api-surface/${PROJECT}/probe`, { environmentId: ENV_METADATA });
    expect(literal.status).toBe(400);
    expect(String(literal.body.error?.message ?? literal.body.message)).toContain(
      '169.254.169.254',
    );

    // A name that resolves to one routable address AND one link-local one is
    // not a misconfiguration, it is the attack written down.
    configureApiSurfaceIo({
      lookup: async () => [{ address: '93.184.216.34' }, { address: '169.254.169.254' }],
    });
    const byName = await probe();
    expect(byName.status).toBe(400);

    expect(sent).toEqual([]);
    expect(store.apiOperationProbe).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("404s on another project's environment, so an observation is filed where it happened", async () => {
    seedOperation({ pathTemplate: '/orders' });
    wireProbe(answers200);

    const { status } = await post(`/api-surface/${PROJECT}/probe`, {
      environmentId: ENV_SIBLING,
    });

    expect(status).toBe(404);
    expect(sent).toEqual([]);
  });

  it('400s on an unknown filter value and names the valid ones', async () => {
    wireProbe(answers200);
    const { status, body } = await post(`/api-surface/${PROJECT}/probe`, {
      environmentId: ENV,
      auth: 'NON',
    });

    expect(status).toBe(400);
    const message = String(body.error?.message ?? body.message);
    expect(message).toContain('NON');
    expect(message).toContain('UNSTATED');
    expect(sent).toEqual([]);
  });
});

describe('POST /api-surface/:projectId/probe — the row it writes', () => {
  /** GET answers, OPTIONS does not route. One probed operation, two rows. */
  const routed = (request: ProbeRequest): ProbeResponse =>
    request.method === 'OPTIONS'
      ? { status: 404, headers: {}, error: null }
      : { status: 200, headers: {}, error: null };

  it('writes the fact field for field, with the clock’s time and the request’s environment', async () => {
    const row = seedOperation({ pathTemplate: '/orders', authDeclaration: 'NONE' });
    wireProbe(routed);

    const { status, body } = await probe();

    expect(status).toBe(200);
    expect(body.probes).toMatchObject({ written: 2, unattributed: 0 });
    const declaredProbe = store.apiOperationProbe.find((probeRow) => probeRow.status === 200)!;
    expect(declaredProbe).toMatchObject({
      orgId: ORG,
      operationId: row.id,
      // A BARE column: the observation records the place it happened in.
      environmentId: ENV,
      status: 200,
      verbAllowed: true,
      authRequiredInFact: null,
      answered: true,
    });
    expect(String(declaredProbe.detail)).toContain('answered 200');
    // From the INJECTED clock. `new Date()` inline would make this unassertable
    // and would drift from the clock the prober charged its rate limit against.
    expect((declaredProbe.observedAt as Date).toISOString()).toBe(PROBED_AT);
    expect(body.observedAtIso).toBe(PROBED_AT);

    const after = store.apiOperation.find((entry) => entry.id === row.id)!;
    expect(after.verification).toBe('CONFIRMED');
    expect(after.notProbedReason).toBeNull();
    expect((after.lastProbedAt as Date).toISOString()).toBe(PROBED_AT);

    /*
     * Two probe rows and one operation update, in ONE transaction. A
     * `lastProbedAt` with no probe row behind it is a timestamp for evidence
     * that does not exist, and a probe row whose operation still says "never
     * probed" is the same inconsistency the other way round.
     */
    expect(h.ops.filter((op) => op.startsWith('$transaction'))).toEqual(['$transaction(3)']);
  });

  it('stores answered:false and status:null when nothing answered — never a status of 0', async () => {
    const row = seedOperation({ pathTemplate: '/orders', authDeclaration: 'NONE' });
    wireProbe(() => ({
      status: null,
      headers: {},
      error: 'connect ECONNREFUSED 93.184.216.34:443',
    }));

    const { body } = await probe();

    expect(store.apiOperationProbe).toHaveLength(1);
    const written = store.apiOperationProbe[0]!;
    expect(written.answered).toBe(false);
    expect(written.status).toBeNull();
    // THE defect this table was shaped to prevent: a null that became a 0.
    expect(written.status).not.toBe(0);
    expect(written.verbAllowed).toBeNull();
    expect(written.authRequiredInFact).toBeNull();
    expect(String(written.detail)).toContain('ECONNREFUSED');

    const after = store.apiOperation.find((entry) => entry.id === row.id)!;
    // UNKNOWN, not absent.
    expect(after.verification).toBe('NO_ANSWER');
    expect(body.verdicts.counts).toMatchObject({ NO_ANSWER: 1, CONFIRMED: 0 });
  });

  it('keeps a standing CONFIRMED when a probe gets a 404', async () => {
    /*
     * ── THE MOST EXPENSIVE BUG THIS DOOR COULD HAVE ────────────────────────
     *
     * A 404 produces the verdict DECLARED, meaning "this probe did not
     * confirm". Assigning it would downgrade an operation an earlier probe
     * genuinely confirmed, and the customer would watch confirmed operations
     * flicker back to declared every time staging had a bad minute. Take
     * `verificationAfterProbe` out of the write path and this test goes red.
     */
    const row = seedOperation({
      pathTemplate: '/orders',
      authDeclaration: 'NONE',
      verification: 'CONFIRMED',
    });
    wireProbe(() => ({ status: 404, headers: {}, error: null }));

    const { body } = await probe();

    const after = store.apiOperation.find((entry) => entry.id === row.id)!;
    expect(after.verification).toBe('CONFIRMED');
    expect(body.verdicts.keptConfirmed).toBe(1);
    expect(String(JSON.stringify(body.verdicts.changes))).toContain('keeps CONFIRMED');
    // The evidence is not lost: the probe row says what was actually seen, and
    // a 404 settles nothing about the verb.
    const written = store.apiOperationProbe[0]!;
    expect(written.status).toBe(404);
    expect(written.verbAllowed).toBeNull();
    expect(String(JSON.stringify(body.findings.items))).toContain('DECLARED_BUT_NOT_ROUTED');
    // Reported and NOT persisted — ApiOperationProbe has no finding column.
    expect(body.findings.stored).toBe(false);
  });

  it('clears notProbedReason when the verification moves off NOT_PROBED', async () => {
    const row = seedOperation({
      pathTemplate: '/orders',
      authDeclaration: 'NONE',
      verification: 'NOT_PROBED',
      notProbedReason: 'NO_BASE_URL',
    });
    /*
     * The other way the stored verification and the verdict disagree, and the
     * one a mutation run caught this test missing: the VERDICT is NOT_PROBED
     * with a reason (an unsafe verb was refused) and the stored verification
     * stays CONFIRMED, so the reason must be dropped rather than written. A
     * confirmed row carrying "the verb is destructive, so we did not look" is
     * a false sentence beside a fact that contradicts it.
     */
    const standing = seedOperation({
      method: 'DELETE',
      pathTemplate: '/orders/{id}',
      verification: 'CONFIRMED',
      notProbedReason: 'BUDGET_SPENT',
    });
    wireProbe(routed);

    const { body } = await probe();

    const after = store.apiOperation.find((entry) => entry.id === row.id)!;
    expect(after.verification).toBe('CONFIRMED');
    expect(after.notProbedReason).toBeNull();

    const kept = store.apiOperation.find((entry) => entry.id === standing.id)!;
    expect(kept.verification).toBe('CONFIRMED');
    expect(kept.notProbedReason).toBeNull();
    expect(body.verdicts.notProbedByReason.UNSAFE_VERB).toBe(1);
  });

  it('applies the operation filter before the target cap, and leaves the rest untouched', async () => {
    seedOperation({ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' });
    const untouched = seedOperation({ method: 'DELETE', pathTemplate: '/orders/{id}' });
    wireProbe(routed);

    const { body } = await probe({ environmentId: ENV, method: 'GET' });

    expect(body.targets).toMatchObject({ selected: 1, matchingFilter: 1, truncated: false });
    expect(body.targets.filters.method).toEqual(['GET']);
    // Not selected is not the same as refused: no verdict was reached about it
    // at all, so its row must say exactly what it said before.
    const after = store.apiOperation.find((entry) => entry.id === untouched.id)!;
    expect(after.verification).toBe('DECLARED');
    expect(after.notProbedReason).toBeNull();
    expect(body.refused.total).toBe(0);
  });
});

describe('POST /api-surface/:projectId/probe — the two-key rule', () => {
  const unsafe = (extra: Row) => post(`/api-surface/${PROJECT}/probe`, extra);

  /** An environment whose stored policy says this place is disposable. */
  function allowDestructiveEnvironment(): void {
    store.environment.push({
      id: 'env_destructive',
      orgId: ORG,
      projectId: PROJECT,
      name: 'throwaway',
      kind: 'STAGING',
      baseUrl: BASE_URL,
      crawlPolicy: { allowDestructive: true },
    });
  }

  it('refuses an unsafe verb with neither key, and RECORDS the refusal with its rule', async () => {
    const row = seedOperation({ method: 'DELETE', pathTemplate: '/orders/{id}' });
    wireProbe(answers200);

    const { body } = await probe();

    expect(sent).toEqual([]);
    expect(store.apiOperationProbe).toHaveLength(0);
    expect(body.refused.total).toBe(1);
    expect(body.refused.items[0]).toMatchObject({
      kind: 'UNSAFE_METHOD',
      route: '/orders/{id}',
    });
    expect(String(body.refused.items[0].rule)).toContain('read-only by default');
    // Grouped by the rule that decided, which is how a panel renders it.
    expect(body.refused.byRule[0]).toMatchObject({ kind: 'UNSAFE_METHOD', count: 1 });
    /*
     * A REFUSED surface and a surface that does not exist must never be
     * recorded the same way: this one is NOT_PROBED with a reason a customer
     * can act on, not DECLARED and not absent.
     */
    const after = store.apiOperation.find((entry) => entry.id === row.id)!;
    expect(after.verification).toBe('NOT_PROBED');
    expect(after.notProbedReason).toBe('UNSAFE_VERB');
    expect(body.verdicts.notProbedByReason.UNSAFE_VERB).toBe(1);
    expect(body.safety.safeMethods).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('refuses it with allowUnsafeVerbs ALONE, and says both keys are required', async () => {
    seedOperation({ method: 'DELETE', pathTemplate: '/orders/{id}' });
    wireProbe(answers200);

    const { body } = await unsafe({ environmentId: ENV, allowUnsafeVerbs: true });

    expect(sent).toEqual([]);
    expect(body.refused.total).toBe(1);
    expect(String(body.refused.items[0].rule)).toContain('both are required');
    expect(body.safety).toMatchObject({ allowUnsafeVerbs: true, allowDestructive: false });
  });

  it('refuses it with policy.allowDestructive ALONE', async () => {
    seedOperation({ method: 'DELETE', pathTemplate: '/orders/{id}' });
    allowDestructiveEnvironment();
    wireProbe(answers200);

    const { body } = await unsafe({ environmentId: 'env_destructive' });

    expect(sent).toEqual([]);
    expect(body.refused.total).toBe(1);
    expect(String(body.refused.items[0].rule)).toContain('read-only by default');
    expect(body.safety).toMatchObject({ allowUnsafeVerbs: false, allowDestructive: true });
    // "This environment is disposable" and "send a DELETE at it" are
    // different claims by different people.
    expect(String(body.safety.rule)).toContain('neither implies the other');
  });

  it('issues it only when BOTH keys are turned', async () => {
    seedOperation({ method: 'DELETE', pathTemplate: '/orders/{id}' });
    allowDestructiveEnvironment();
    wireProbe(() => ({ status: 405, headers: { allow: 'GET, HEAD' }, error: null }));

    const { body } = await unsafe({ environmentId: 'env_destructive', allowUnsafeVerbs: true });

    expect(sent.map((request) => request.method)).toEqual(['DELETE']);
    expect(body.refused.total).toBe(0);
    const written = store.apiOperationProbe[0]!;
    expect(written.status).toBe(405);
    // Only a 405 or an Allow header settles the verb, and this is both.
    expect(written.verbAllowed).toBe(false);
    expect(String(JSON.stringify(body.findings.items))).toContain('DECLARED_VERB_REFUSED');
  });
});

describe('POST /api-surface/:projectId/probe — the credential', () => {
  /** Public per the document; 401 anonymously; accepted with the credential. */
  function wireCredentialled(): void {
    wireProbe(
      (request) => {
        const authorized = Object.values(request.headers).includes(CREDENTIAL_VALUE);
        if (request.url.endsWith('/refuses-everybody')) {
          return { status: 401, headers: {}, error: null };
        }
        return { status: authorized ? 200 : 401, headers: {}, error: null };
      },
      {
        probeCredential: { headers: { authorization: CREDENTIAL_VALUE }, label: 'staging token' },
      },
    );
  }

  it('never writes a credential value to a row, a response or the audit log', async () => {
    seedOperation({ method: 'GET', pathTemplate: '/public', authDeclaration: 'NONE' });
    wireCredentialled();

    const { status, body } = await probe();

    expect(status).toBe(200);
    // The second half WAS sent — otherwise `authRequiredInFact` could only
    // ever be null and this test would pass for the wrong reason.
    expect(sent.some((request) => Object.values(request.headers).includes(CREDENTIAL_VALUE))).toBe(
      true,
    );
    const everythingWeEmitted = [
      JSON.stringify(body),
      JSON.stringify(h.audits),
      JSON.stringify(store.apiOperationProbe),
      JSON.stringify(store.apiOperation),
    ].join('\n');
    expect(everythingWeEmitted).not.toContain(CREDENTIAL_VALUE);
    expect(everythingWeEmitted).not.toContain('qaai-test-not-a-real-token');
    // The LABEL is not the value, and it is what makes the evidence sentence
    // name which credential was accepted.
    expect(JSON.stringify(store.apiOperationProbe)).toContain('staging token');
    expect(body.credential).toMatchObject({ wired: true, label: 'staging token' });
  });

  it('establishes authRequiredInFact only when both halves were sent', async () => {
    const determined = seedOperation({
      method: 'GET',
      pathTemplate: '/public',
      authDeclaration: 'NONE',
    });
    const undetermined = seedOperation({
      method: 'GET',
      pathTemplate: '/refuses-everybody',
      authDeclaration: 'NONE',
    });
    wireCredentialled();

    await probe();

    const determinedRows = store.apiOperationProbe.filter(
      (row) => row.operationId === determined.id,
    );
    expect(determinedRows.some((row) => row.authRequiredInFact === true)).toBe(true);
    /*
     * The operation that refused the credential too may be 401-ing everybody,
     * including us. Null — undetermined — and never `true` from half the
     * evidence, which is how a document and a broken application come to
     * agree on paper.
     */
    const undeterminedRows = store.apiOperationProbe.filter(
      (row) => row.operationId === undetermined.id,
    );
    expect(undeterminedRows).not.toHaveLength(0);
    for (const row of undeterminedRows) expect(row.authRequiredInFact).toBeNull();
  });

  it('audits the host and not the base URL, and never which credential it was', async () => {
    seedOperation({ method: 'GET', pathTemplate: '/public', authDeclaration: 'NONE' });
    wireCredentialled();

    await probe();

    expect(h.audits).toHaveLength(1);
    const entry = h.audits[0]!;
    expect(entry.action).toBe('apiSurface.probe');
    expect(entry.metadata).toMatchObject({
      // The HOST: a base URL can carry a query string, and a token in a query
      // string written to the audit log is a credential in a log line.
      baseUrlHost: 'staging.example.test',
      environmentId: ENV,
      credentialWired: true,
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('staging token');
  });
});

describe('POST /api-surface/:projectId/probe — cap disclosure', () => {
  it('reports the rate limit as a delay with a discard of zero', async () => {
    seedOperation({ method: 'GET', pathTemplate: '/one', authDeclaration: 'NONE' });
    seedOperation({ method: 'GET', pathTemplate: '/two', authDeclaration: 'NONE' });
    wireProbe((request) =>
      request.method === 'OPTIONS'
        ? { status: 404, headers: {}, error: null }
        : { status: 200, headers: {}, error: null },
    );

    const { body } = await probe();

    // Four requests, three of them after the first: 100ms apiece on a frozen
    // clock. A cap that costs wall clock and discards nothing.
    expect(sent).toHaveLength(4);
    expect(body.probeCaps.rateLimitWaitMs).toBe(300);
    expect(body.probeCaps.followUpsStoppedByBudget).toBe(0);
    const rate = (body.probeCaps.unexpressible as Row[]).find(
      (bite) => bite.cap === 'PROBE_RATE',
    )!;
    expect(rate.discarded).toBe(0);
    expect(String(rate.reason)).toContain('300ms');
    /*
     * The shared vocabulary has no member for a probe rate, so this bite is
     * UNEXPRESSIBLE rather than mapped — and it is printed instead of dropped.
     * A cap with no home is still a cap that bit.
     */
    expect(body.probeCaps.bites).toEqual([]);
  });

  it('discloses the target cap and the probe budget as counts and reasons', async () => {
    for (let index = 0; index < 502; index += 1) {
      seedOperation({ method: 'GET', pathTemplate: `/bulk/${index}`, authDeclaration: 'NONE' });
    }
    // Nothing answers, so each operation costs exactly one request and the
    // prober issues no follow-ups — which makes the budget arithmetic exact.
    wireProbe(() => ({ status: null, headers: {}, error: 'timeout' }));

    const { body } = await probe();

    const targets = (body.capsThatBit as Row[]).find((bite) => bite.cap === 'probeTargets')!;
    expect(targets).toMatchObject({ cap: 'probeTargets', limit: 500, droppedAtLeast: 2 });
    expect(String(body.capRule)).toContain('hid at least 2');
    expect(body.targets).toMatchObject({ selected: 500, matchingFilter: 502, truncated: true });

    // The prober's own budget bit after 200 requests, and the 300 operations
    // it never reached are NOT_PROBED with a reason rather than missing.
    expect(sent).toHaveLength(200);
    const budget = (body.probeCaps.unexpressible as Row[]).find(
      (bite) => bite.cap === 'PROBE_BUDGET',
    )!;
    expect(budget).toMatchObject({ limit: 200, discarded: 300 });
    expect(body.verdicts.notProbedByReason.BUDGET_SPENT).toBe(300);
    expect(body.verdicts.counts.NO_ANSWER).toBe(200);
    expect(body.verdicts.notProbedWithUnknownReason).toBe(0);
    /*
     * Five hundred verdicts changed something and all five hundred are
     * listed: the change list's own limit is not smaller than the target cap,
     * so it cannot truncate silently. The day somebody raises `probeTargets`
     * this assertion is what says the list started being cut.
     */
    expect(body.verdicts.changesTotal).toBe(500);
    expect(body.verdicts.changes).toHaveLength(500);
    expect(body.verdicts.changesTruncated).toBe(false);
    expect((body.capsThatBit as Row[]).map((bite) => bite.cap)).not.toContain('changesListed');
  });

  it('answers a measured zero when no declared operation matches, and says so', async () => {
    wireProbe(answers200);

    const { status, body } = await probe();

    expect(status).toBe(200);
    expect(body.targets).toMatchObject({ selected: 0, matchingFilter: 0 });
    expect(sent).toEqual([]);
    expect(String(JSON.stringify(body.caveats))).toContain('nothing was probed');
  });
});

// ─── 9. The read: what we believe beside what we saw ────────────────────────

describe('GET /api-surface/:projectId — the newest probe', () => {
  let routedRow: Row;
  let notRoutedRow: Row;

  beforeEach(async () => {
    routedRow = seedOperation({ method: 'GET', pathTemplate: '/routed', authDeclaration: 'NONE' });
    notRoutedRow = seedOperation({
      method: 'GET',
      pathTemplate: '/notrouted',
      authDeclaration: 'NONE',
    });
    wireProbe((request) =>
      request.url.endsWith('/notrouted') || request.method === 'OPTIONS'
        ? { status: 404, headers: {}, error: null }
        : { status: 200, headers: {}, error: null },
    );
    await probe();
  });

  it('carries the newest probe per operation, with every null left as a null', async () => {
    // Seeded AFTER the run, so nothing has ever probed it.
    seedOperation({ method: 'GET', pathTemplate: '/never', authDeclaration: 'NONE' });

    const { body } = await get(`/api-surface/${PROJECT}`);
    const rows = body.operations as Row[];

    const routed = rows.find((row) => row.pathTemplate === '/routed')!;
    expect(routed.probeState).toBe('OBSERVED');
    expect(routed.newestProbe).toMatchObject({
      status: 200,
      answered: true,
      verbAllowed: true,
      observedAtIso: PROBED_AT,
      environmentId: ENV,
    });
    // Present and null, not absent: no credential was wired, so whether
    // authentication is required IN FACT was never determined.
    expect(Object.keys(routed.newestProbe as Row)).toContain('authRequiredInFact');
    expect((routed.newestProbe as Row).authRequiredInFact).toBeNull();
    // One run, two rows (the declared request and the undeclared verb), one
    // observation — disclosed rather than silently collapsed.
    expect(routed.probesInNewestObservation).toBe(2);
    expect(routed.verification).toBe('CONFIRMED');

    const notRouted = rows.find((row) => row.pathTemplate === '/notrouted')!;
    expect((notRouted.newestProbe as Row).status).toBe(404);
    // A 404 says nothing about the verb. Null, never false.
    expect((notRouted.newestProbe as Row).verbAllowed).toBeNull();
    expect(notRouted.verification).toBe('DECLARED');

    const never = rows.find((row) => row.pathTemplate === '/never')!;
    expect(never.probeState).toBe('NEVER_PROBED');
    expect(never.newestProbe).toBeNull();
    expect(never.probesInNewestObservation).toBe(0);
    // The window was complete, so NEVER_PROBED means exactly that.
    expect(body.probeWindow).toMatchObject({ truncated: false, rowsPerOperation: 8 });
    expect(String(body.probeWindow.rule)).toContain('NEVER_PROBED on this page means exactly');
  });

  it('reports NOT_READ rather than NEVER_PROBED when its own read cap bites', async () => {
    /*
     * Two operations on the page means a window of 2 × 8 + 1 = 17 rows, and
     * they are read grouped by operation id. Twenty rows on the FIRST id
     * therefore spend the whole window before the second id is reached — which
     * is exactly the crowding the grouped order makes survivable: every
     * operation that was reached still has its newest rows, and the one that
     * was not is reported NOT_READ.
     *
     * `routedRow` (op_seed_1) sorts before `notRoutedRow` (op_seed_2), so the
     * padding lands on the one that is read.
     */
    expect(routedRow.id < notRoutedRow.id).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      store.apiOperationProbe.push({
        id: `probe_pad_${index}`,
        orgId: ORG,
        operationId: routedRow.id,
        environmentId: ENV,
        status: 200,
        verbAllowed: true,
        authRequiredInFact: null,
        answered: true,
        detail: 'padding',
        // Older than the run above, so the fold still reports the real probe.
        observedAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
      });
    }

    const { body } = await get(`/api-surface/${PROJECT}`);
    const rows = body.operations as Row[];

    expect(body.probeWindow.truncated).toBe(true);
    expect(String(body.probeWindow.rule)).toContain('NOT_READ');

    const crowdedOut = rows.find((row) => row.pathTemplate === '/notrouted')!;
    /*
     * THE LIE THIS AVOIDS: `newestProbe: null` with `probeState:
     * NEVER_PROBED` on an operation that was probed four lines ago. "We did
     * not look" and "nothing has ever looked" are different facts with
     * different remedies, and only one of them is about the application.
     */
    expect(crowdedOut.probeState).toBe('NOT_READ');
    expect(crowdedOut.newestProbe).toBeNull();
    // And it HAS been probed, which is what makes NEVER_PROBED a lie here.
    expect(
      store.apiOperationProbe.filter((row) => row.operationId === notRoutedRow.id),
    ).toHaveLength(1);

    const read = rows.find((row) => row.pathTemplate === '/routed')!;
    expect(read.probeState).toBe('OBSERVED');
    // Its newest rows came first, so the fold is still the real observation
    // and not one of the twenty older padding rows.
    expect((read.newestProbe as Row).observedAtIso).toBe(PROBED_AT);
  });
});

// ─── 10. The probe history ──────────────────────────────────────────────────

describe('GET /api-surface/:projectId/probes', () => {
  let routedRow: Row;

  beforeEach(async () => {
    routedRow = seedOperation({ method: 'GET', pathTemplate: '/routed', authDeclaration: 'NONE' });
    seedOperation({ method: 'GET', pathTemplate: '/notrouted', authDeclaration: 'NONE' });
    wireProbe((request) =>
      request.url.endsWith('/notrouted') || request.method === 'OPTIONS'
        ? { status: 404, headers: {}, error: null }
        : { status: 200, headers: {}, error: null },
    );
    await probe();
  });

  it('reads the history newest first with the operation each probe is about', async () => {
    const { status, body } = await get(`/api-surface/${PROJECT}/probes`);

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    const rows = body.probes as Row[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.observedAtIso).toBe(PROBED_AT);
    const routed = rows.find((row) => row.operationId === routedRow.id)!;
    expect(routed).toMatchObject({
      key: 'ENDPOINT:GET /routed',
      method: 'GET',
      pathTemplate: '/routed',
      // What the document declared, beside what the application did.
      authDeclaration: 'NONE',
    });
    expect(String(body.rule)).toContain('never a 0');
  });

  it('applies the filter before the cap, so a short page is not an exhausted list', async () => {
    const filtered = await get(`/api-surface/${PROJECT}/probes?operationId=${routedRow.id}`);
    expect(filtered.body.total).toBe(2);
    for (const row of filtered.body.probes as Row[]) {
      expect(row.operationId).toBe(routedRow.id);
    }

    const capped = await get(
      `/api-surface/${PROJECT}/probes?operationId=${routedRow.id}&limit=1`,
    );
    expect(capped.body.probes).toHaveLength(1);
    // Two matched and one was returned: the cap ran after the filter.
    expect(capped.body.total).toBe(2);
    expect(capped.body.truncated).toBe(true);
  });

  it('filters by environment and by whether anything answered, without coercing "false"', async () => {
    expect((await get(`/api-surface/${PROJECT}/probes?environmentId=${ENV}`)).body.total).toBe(3);
    expect((await get(`/api-surface/${PROJECT}/probes?environmentId=env_other`)).body.total).toBe(
      0,
    );
    // `z.coerce.boolean()` reads the string "false" as true, which would
    // answer this question with its own opposite.
    expect((await get(`/api-surface/${PROJECT}/probes?answered=false`)).body.total).toBe(0);
    expect((await get(`/api-surface/${PROJECT}/probes?answered=true`)).body.total).toBe(3);
    expect((await get(`/api-surface/${PROJECT}/probes?answered=maybe`)).status).toBe(400);
  });

  it('404s on an operation id this project does not hold, rather than answering []', async () => {
    /*
     * The same org, a different project, with its own probe row. An empty page
     * would read as "nothing has ever probed that operation" — a measured
     * claim about an application, made out of a typo.
     */
    store.apiOperation.push({
      id: 'op_sibling',
      orgId: ORG,
      projectId: SIBLING_PROJECT,
      method: 'GET',
      pathTemplate: '/theirs',
      operationId: null,
      sourceDocument: DOC,
      evidence: 'theirs',
      authDeclaration: 'NONE',
      parameters: [],
      requestShape: null,
      responseShapes: null,
      verification: 'CONFIRMED',
      notProbedReason: null,
      lastProbedAt: null,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      retiredAt: null,
    });
    store.apiOperationProbe.push({
      id: 'probe_sibling',
      orgId: ORG,
      operationId: 'op_sibling',
      environmentId: ENV_SIBLING,
      status: 200,
      verbAllowed: true,
      authRequiredInFact: null,
      answered: true,
      detail: 'theirs',
      observedAt: new Date(PROBED_AT),
    });

    const unknown = await get(`/api-surface/${PROJECT}/probes?operationId=op_sibling`);
    expect(unknown.status).toBe(404);
    expect((await get(`/api-surface/${PROJECT}/probes?operationId=nope`)).status).toBe(404);

    // And the sibling's probe is not in this project's history either: the
    // relation filter is the only thing that keeps it out.
    const mine = await get(`/api-surface/${PROJECT}/probes`);
    expect(mine.body.total).toBe(3);
    expect((mine.body.probes as Row[]).map((row) => row.id)).not.toContain('probe_sibling');
  });
});

// ─── 11. The disagreement, which is why this table exists ───────────────────

describe('GET /api-surface/:projectId/auth-disagreements', () => {
  beforeEach(async () => {
    // Declared public, and the application requires a credential: the
    // disagreement a customer acts on the same day.
    seedOperation({ method: 'GET', pathTemplate: '/public', authDeclaration: 'NONE' });
    // Declared public, refuses everybody including us: UNDETERMINED.
    seedOperation({
      method: 'GET',
      pathTemplate: '/refuses-everybody',
      authDeclaration: 'NONE',
    });
    wireProbe(
      (request) => {
        const authorized = Object.values(request.headers).includes(CREDENTIAL_VALUE);
        if (request.url.endsWith('/refuses-everybody')) {
          return { status: 401, headers: {}, error: null };
        }
        return { status: authorized ? 200 : 401, headers: {}, error: null };
      },
      {
        probeCredential: { headers: { authorization: CREDENTIAL_VALUE }, label: 'staging token' },
      },
    );
    await probe();
    // Seeded after the run: the document took a position and nothing probed it.
    seedOperation({ method: 'GET', pathTemplate: '/unprobed', authDeclaration: 'OPTIONAL' });
    // The document is SILENT, so there is nothing to disagree with.
    seedOperation({ method: 'GET', pathTemplate: '/silent', authDeclaration: 'UNSTATED' });
  });

  it('counts "cannot judge" separately from "disagree" and refuses to add them', async () => {
    const { status, body } = await get(`/api-surface/${PROJECT}/auth-disagreements`);

    expect(status).toBe(200);
    expect(body.total).toBe(1);
    const found = (body.disagreements as Row[])[0]!;
    expect(found).toMatchObject({
      key: 'ENDPOINT:GET /public',
      authDeclaration: 'NONE',
      authRequiredInFact: true,
      kind: 'DECLARED_PUBLIC_BUT_REQUIRED',
      observedAtIso: PROBED_AT,
    });
    expect(String(found.evidence)).toContain('required in fact');
    expect(String(found.evidence)).toContain(PROBED_AT);

    expect(body.counts).toMatchObject({
      disagree: 1,
      agree: 0,
      // TWO operations we could not judge, for two different reasons, and
      // NEITHER of them is a defect in the customer's application.
      cannotJudge: 2,
      cannotJudgeBreakdown: { probedButUndetermined: 1, neverProbed: 1, notRead: 0 },
      // The document said nothing. Its own number.
      documentTookNoPosition: 1,
      operationsWithAPosition: 3,
      scanTruncated: false,
    });
    expect(String(body.rule)).toContain('MUST NOT be added');
    // The half that cannot fire yet, said plainly rather than read as "clean".
    expect(body.coverage.cannotReportYet).toEqual(['DECLARED_PRIVATE_BUT_OPEN']);
    expect(String(body.coverage.note)).toContain('not evidence that nothing is open');
  });

  it('nulls the exact counts when its own scan cap bites, and reports floors', async () => {
    /*
     * The scan stops at 1,000 operations that took a position, so every count
     * below becomes a FLOOR. A partial count in the field a dashboard prints
     * is how a capped scan turns into a reassuring number.
     */
    for (let index = 0; index < 1_000; index += 1) {
      seedOperation({
        method: 'GET',
        pathTemplate: `/more/${index}`,
        authDeclaration: 'REQUIRED',
      });
    }

    const { body } = await get(`/api-surface/${PROJECT}/auth-disagreements`);

    expect(body.counts.scanTruncated).toBe(true);
    expect(body.counts.disagree).toBeNull();
    expect(body.counts.cannotJudge).toBeNull();
    expect(body.counts.agree).toBeNull();
    expect(body.counts.atLeastCannotJudge).toBeGreaterThan(0);
    expect(body.counts.operationsWithAPosition).toBe(1_003);
    expect(body.counts.operationsScanned).toBe(1_000);
  });
});

// ─── 7. Auth and tenancy ────────────────────────────────────────────────────

describe('scope, role and tenancy', () => {
  const routes: Array<[string, string, unknown, string]> = [
    ['GET', `/api-surface/${PROJECT}`, undefined, 'tests:read'],
    ['GET', `/api-surface/${PROJECT}/probes`, undefined, 'tests:read'],
    ['GET', `/api-surface/${PROJECT}/auth-disagreements`, undefined, 'tests:read'],
    ['POST', `/api-surface/${PROJECT}`, { document: '{}' }, 'tests:write'],
    [
      'POST',
      `/api-surface/${PROJECT}/retire`,
      { method: 'POST', pathTemplate: '/orders', reason: 'A reason long enough to be real.' },
      'tests:write',
    ],
    ['POST', `/api-surface/${PROJECT}/probe`, { environmentId: ENV }, 'tests:write'],
  ];

  it('refuses an API key that is missing the scope', async () => {
    wireIngest([operation()]);
    for (const [method, path, body, scope] of routes) {
      asActor({ scopes: ['runs:write'] });
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path} must require ${scope}`).toBe(403);
    }
  });

  it('refuses a VIEWER on the write routes', async () => {
    wireIngest([operation()]);
    // Selected by what they are rather than by their position in the list: a
    // `slice(1)` stopped covering the write routes the moment a second read
    // route was added above, and the test would have gone on passing.
    const writes = routes.filter(([, , , scope]) => scope === 'tests:write');
    expect(writes).toHaveLength(3);
    for (const [method, path, body] of writes) {
      asActor({ role: 'VIEWER' });
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path} must require MEMBER`).toBe(403);
    }
  });

  it("404s on another org's project on every route", async () => {
    wireIngest([operation()]);
    for (const [method, path, body] of routes) {
      const response = await call(
        method,
        path.replace(PROJECT, OTHER_ORG_PROJECT),
        body,
      );
      expect(response.status, `${method} ${path} must not reach another org`).toBe(404);
    }
    expect(store.apiOperation).toHaveLength(0);
  });
});
