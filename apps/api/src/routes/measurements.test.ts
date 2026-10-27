/**
 * Tests for the measurement read doors, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A NULL READING STAYS NULL. `TestMetricSample.value` is nullable because
 *      "we tried and could not measure it" is not zero, and for every metric
 *      this product collects the two are opposite signals. There is a fixture
 *      here with a REAL 0 beside a real null under the same metric name, so a
 *      response that coalesced the null would become indistinguishable from the
 *      honest row — and `coalescing null to 0 is caught` is the test that goes
 *      red when it does.
 *
 *   2. A CELL NOBODY REPORTED IS NOT A CELL. Five reported cells over 3 x 2 x
 *      2 x 2 x 2 dimension values; the product is 48 and the response must
 *      never contain it. `unreportedCells` is null with a reason.
 *
 *   3. AN UNKNOWN FILTER IS A 400 THAT NAMES THE VALID VALUES. `?status=ERROR`
 *      answering `[]` reads as "no cell in this project failed", which inverts
 *      the signal the caller asked for. Same for an unknown metric name, which
 *      gets an empty series WITH an explicit statement rather than a 0 point.
 *
 *   4. CROSS-TENANT IS A 404 AND A SIBLING PROJECT IS INVISIBLE.
 *      `TestResultVariant` has no projectId, so the only thing between this
 *      endpoint and another project's cells INSIDE THE SAME ORG is a relation
 *      filter — which is why there is a fixture in the same org whose cells
 *      must never appear.
 *
 *   5. EVERY CAP IS DISCLOSED AS A COUNT AND A REASON.
 *
 *   6. EVERY ROUTE CHECKS ITS SCOPE. The auth mock is a faithful
 *      reimplementation of middleware/auth.ts rather than a pass-through, so a
 *      handler missing `requireScope` fails here — this repo has shipped routes
 *      with no scope check before.
 *
 * Harness: the same shape as routes/api-surface.test.ts — a mocked prisma
 * module with a real AsyncLocalStorage tenant scope, a SELECT-HONOURING
 * in-memory store, and the real router driven over a loopback socket. Nothing
 * here opens a socket to anything but its own server and nothing reaches a real
 * database.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  ops: string[];
  /** When true, the two measurement delegates raise Prisma's "no such table". */
  schemaMissing: boolean;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  ops: [],
  schemaMissing: false,
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
 * NOT a pass-through. `requireScope` carries the real semantics from
 * middleware/auth.ts, because against a mock that always calls next() a route
 * whose scope check is simply missing passes every test in the file.
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

type ModelName = 'project' | 'test' | 'testResult' | 'testResultVariant' | 'testMetricSample';

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored: a fake that shrugged at `variantId: null` would
 * pass the scope tests with no scope filter in the router.
 *
 * Relation field names (`testResult`, `test`, `variant`) are deliberately NOT
 * in here — they are resolved in {@link RELATIONS}, so a relation filter on a
 * model with no declared relation throws instead of matching everything.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  test: new Set(['id', 'orgId', 'projectId']),
  testResult: new Set(['id', 'orgId', 'runId', 'testId']),
  testResultVariant: new Set([
    'id',
    'orgId',
    'runId',
    'testId',
    'testResultId',
    'browser',
    'viewport',
    'locale',
    'role',
    'environment',
    'status',
    'notRunKind',
    'createdAt',
  ]),
  testMetricSample: new Set([
    'id',
    'orgId',
    'projectId',
    'runId',
    'testId',
    'testResultId',
    'variantId',
    'variantKey',
    'name',
    'value',
    'unit',
    'direction',
    'createdAt',
  ]),
};

/**
 * Relation filters the fake resolves, and the reason each one has to exist.
 *
 * `TestResultVariant` has an orgId and NO projectId, so
 * `where: { testResult: { test: { projectId } } }` is the ONLY thing between
 * the matrix read and a sibling project's cells inside the same org. A fake
 * that ignored the key would return every variant in the org and the isolation
 * test below would pass against a router that had no such filter — the same
 * class of false pass as a select-blind fake. The chain is two levels deep
 * because `TestResult` has no projectId either, so the resolution is recursive.
 *
 * Modelled the way the real client behaves: the tenancy extension merges
 * `orgId` into the TOP-LEVEL where only, so the nested side is matched without
 * org scoping and the two boundaries are tested separately.
 */
const RELATIONS: Partial<Record<ModelName, Array<{ field: string; to: ModelName; fk: string }>>> = {
  testResultVariant: [{ field: 'testResult', to: 'testResult', fk: 'testResultId' }],
  testResult: [{ field: 'test', to: 'test', fk: 'testId' }],
  testMetricSample: [{ field: 'variant', to: 'testResultVariant', fk: 'variantId' }],
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>([]);

type Store = Record<ModelName, Row[]>;

let store: Store;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    /* `gte`/`lte` together are one window, so both have to hold. */
    if ('gte' in c || 'lte' in c) {
      const at = value instanceof Date ? value.getTime() : Number(value);
      if ('gte' in c && at < (c.gte as Date).getTime()) return false;
      if ('lte' in c && at > (c.lte as Date).getTime()) return false;
      return true;
    }
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

/**
 * Rows of `model` matching `where`, resolving relation filters recursively.
 *
 * No org scoping here: this is the NESTED matcher, and the real extension does
 * not scope nested sides. The top-level scoping happens in `makeDb`.
 */
function rowsMatching(model: ModelName, where: Row): Row[] {
  const scalars: Row = {};
  const relationSets: Array<{ fk: string; allowed: Set<string> }> = [];

  for (const [key, cond] of Object.entries(where)) {
    const relation = (RELATIONS[model] ?? []).find((rel) => rel.field === key);
    if (relation) {
      relationSets.push({
        fk: relation.fk,
        allowed: new Set(rowsMatching(relation.to, cond as Row).map((parent) => String(parent.id))),
      });
      continue;
    }
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    scalars[key] = cond;
  }

  return store[model].filter(
    (row) =>
      Object.entries(scalars).every(([key, cond]) => matchesCondition(row[key] ?? null, cond)) &&
      relationSets.every(({ fk, allowed }) => {
        const fkValue = row[fk] ?? null;
        /*
         * A relation filter on a NULL foreign key matches nothing, which is
         * Prisma's own behaviour and the behaviour the metrics `scope=CELL`
         * path depends on: a whole-test reading belongs to no cell, so a cell
         * dimension filter must not reach it.
         */
        if (fkValue === null) return false;
        return allowed.has(String(fkValue));
      }),
  );
}

/**
 * `orderBy`, in either form Prisma accepts: an array of single-key objects, or
 * one object with several keys. Both are flattened to the same clause list in
 * declaration order, because `groupBy` takes the second and `findMany` the
 * first and the fake must not silently sort by only the first key of either.
 */
function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((clause) =>
    Object.entries(clause),
  );
  return [...rows].sort((a, b) => {
    for (const [key, dir] of clauses) {
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
 * router would read `row.retriedAndPassed` off a result it never asked for, the
 * test would pass, and production would read `undefined`. Two defects survived
 * a whole slice behind fakes that shrugged at `select`.
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

/**
 * Prisma's "the table does not exist in the current database".
 *
 * A plain object with a `code`, not an instance of
 * `PrismaClientKnownRequestError`: the router duck-types the code precisely so
 * that this guard is reachable from a test whose Prisma client is a mock. A
 * guard no test can reach is a guard that is not there.
 */
class FakeP2021 extends Error {
  readonly code = 'P2021';
  constructor(table: string) {
    super(`The table \`public.${table}\` does not exist in the current database.`);
  }
}

/** The two models whose migration the `schemaMissing` flag pretends is unapplied. */
const MEASUREMENT_MODELS = new Set<ModelName>(['testResultVariant', 'testMetricSample']);

const PRISMA_TABLE: Record<string, string> = {
  testResultVariant: 'TestResultVariant',
  testMetricSample: 'TestMetricSample',
};

/**
 * A Prisma stand-in that enforces tenancy the way lib/prisma.ts does: merging
 * the ambient orgId into filterable `where`s and POST-FILTERING the unique
 * lookups, which cannot take an extra filter. That post-filter is the only
 * thing between `projectOr404` and another org's project, so it is modelled
 * rather than assumed.
 */
function makeDb(): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const guard = (): void => {
      if (h.schemaMissing && MEASUREMENT_MODELS.has(name)) {
        throw new FakeP2021(PRISMA_TABLE[name] ?? name);
      }
    };
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] => rowsMatching(name, scopedWhere(where));

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        guard();
        h.ops.push(`${name}.findUnique`);
        const found = store[name].find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        );
        if (!found) return null;
        if (!global && found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel);
      },
      findMany: async ({ where, orderBy, select: sel, take, skip }: Row = {}) => {
        guard();
        h.ops.push(`${name}.findMany`);
        const rows = sortRows(select(where), orderBy);
        const from = typeof skip === 'number' ? skip : 0;
        const page = typeof take === 'number' ? rows.slice(from, from + take) : rows.slice(from);
        return page.map((row) => projectRow(name, row, sel));
      },
      count: async ({ where }: Row = {}) => {
        guard();
        h.ops.push(`${name}.count`);
        return select(where).length;
      },
      /**
       * `groupBy`, with `_count` modelled the way the real one behaves: `_all`
       * counts the rows in the group and `_count: { <column>: true }` counts the
       * rows whose column is NOT NULL.
       *
       * That second half is load-bearing for /metrics/names, which reads
       * `measured` straight out of `_count.value`. A fake that counted every
       * row for both keys would make `measured` equal `readings` always, and
       * the test proving an unavailable reading is not a measured one would
       * pass against a router that had the arithmetic backwards.
       */
      groupBy: async ({ by, where, _count, orderBy, take, skip }: Row) => {
        guard();
        h.ops.push(`${name}.groupBy(${(by as string[]).join(',')})`);
        const rows = select(where);
        const buckets = new Map<string, Row[]>();
        for (const row of rows) {
          const key = JSON.stringify((by as string[]).map((field) => row[field] ?? null));
          const bucket = buckets.get(key) ?? [];
          bucket.push(row);
          buckets.set(key, bucket);
        }
        let out = [...buckets.values()].map((bucket) => {
          const first = bucket[0]!;
          const entry: Row = {};
          for (const field of by as string[]) entry[field] = first[field] ?? null;
          if (_count) {
            const counts: Row = {};
            for (const [key, want] of Object.entries(_count as Row)) {
              if (want !== true) throw new Error(`fake prisma: unsupported _count.${key}`);
              counts[key] =
                key === '_all'
                  ? bucket.length
                  : bucket.filter((row) => (row[key] ?? null) !== null).length;
            }
            entry._count = counts;
          }
          return entry;
        });
        out = sortRows(out, orderBy);
        const from = typeof skip === 'number' ? skip : 0;
        return typeof take === 'number' ? out.slice(from, from + take) : out.slice(from);
      },
    };
  };

  const db: Row = {};
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
 * check from a project check: a matrix read scoped only by `orgId` passes every
 * cross-org test in this file and still answers with this project's cells.
 */
const SIBLING_PROJECT = 'proj_3';

const TEST_A = 'test_a';
const TEST_B = 'test_b';
const TEST_SIB = 'test_sib';
const RUN_1 = 'run_1';
const RUN_2 = 'run_2';

const T0 = new Date('2026-10-20T00:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** '<unvaried>' and '<anonymous>', spelled here exactly as the schema spells them. */
const UNVARIED_VALUE = '<unvaried>';
const ANONYMOUS = '<anonymous>';

function variant(overrides: Row): Row {
  return {
    orgId: ORG,
    testResultId: 'tr_a1',
    runId: RUN_1,
    testId: TEST_A,
    browser: 'chromium',
    viewport: '1280x720',
    locale: 'en-US',
    role: ANONYMOUS,
    environment: 'env_1',
    status: 'PASSED',
    durationMs: 100,
    errorMessage: null,
    retriedAndPassed: false,
    notRunKind: null,
    createdAt: at(0),
    ...overrides,
  };
}

function sample(overrides: Row): Row {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId: RUN_1,
    testId: TEST_A,
    testResultId: 'tr_a1',
    variantId: null,
    variantKey: UNVARIED_VALUE,
    name: 'lcp',
    value: 1200,
    unavailableReason: null,
    unit: 'MILLISECONDS',
    direction: 'LOWER_IS_BETTER',
    createdAt: at(0),
    ...overrides,
  };
}

function seed(): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else' },
      { id: SIBLING_PROJECT, orgId: ORG, name: 'Another of ours' },
    ],
    test: [
      {
        id: TEST_A,
        orgId: ORG,
        projectId: PROJECT,
        name: 'checkout works',
        filePath: 'e2e/checkout.spec.ts',
      },
      {
        id: TEST_B,
        orgId: ORG,
        projectId: PROJECT,
        name: 'login works',
        filePath: 'e2e/login.spec.ts',
      },
      {
        id: TEST_SIB,
        orgId: ORG,
        projectId: SIBLING_PROJECT,
        name: 'sibling',
        filePath: 'e2e/sib.spec.ts',
      },
    ],
    testResult: [
      { id: 'tr_a1', orgId: ORG, runId: RUN_1, testId: TEST_A },
      { id: 'tr_b1', orgId: ORG, runId: RUN_1, testId: TEST_B },
      { id: 'tr_a2', orgId: ORG, runId: RUN_2, testId: TEST_A },
      { id: 'tr_sib', orgId: ORG, runId: 'run_9', testId: TEST_SIB },
    ],
    /*
     * FIVE reported cells across two tests, spanning 3 browsers, 2 viewports,
     * 2 locales, 2 roles and 2 environments. 3 x 2 x 2 x 2 x 2 is 48, so the
     * product of the dimension counts is ten times the number of cells anybody
     * ran — which is what makes "never multiply these" testable rather than
     * rhetorical.
     */
    testResultVariant: [
      { id: 'v1', ...variant({}) },
      {
        id: 'v2',
        ...variant({
          browser: 'webkit',
          status: 'FAILED',
          errorMessage: 'expected 2 items in cart, found 1',
          durationMs: 420,
        }),
      },
      {
        id: 'v3',
        ...variant({
          browser: 'firefox',
          locale: 'de-DE',
          role: UNVARIED_VALUE,
          status: 'SKIPPED',
          /* Ran and measured nothing, for a stated reason. NOT the same as absent. */
          notRunKind: 'BLOCKED_BY_ENV',
          durationMs: 0,
        }),
      },
      {
        id: 'v4',
        ...variant({
          viewport: 'iphone-14',
          status: 'PASSED',
          /* §5 — a retry that passes is not a pass. */
          retriedAndPassed: true,
        }),
      },
      {
        id: 'v5',
        ...variant({
          testResultId: 'tr_b1',
          testId: TEST_B,
          role: UNVARIED_VALUE,
          environment: UNVARIED_VALUE,
        }),
      },
      /* The sibling project's cell. It must never appear under PROJECT. */
      {
        id: 'v_sib',
        ...variant({
          testResultId: 'tr_sib',
          testId: TEST_SIB,
          runId: 'run_9',
          status: 'FAILED',
          errorMessage: 'another project entirely',
        }),
      },
    ],
    testMetricSample: [
      /* A measured LCP, in a cell. */
      {
        id: 'm1',
        ...sample({
          variantId: 'v1',
          variantKey: 'chromium|1280x720|en-US|<anonymous>|env_1',
          value: 1200,
          createdAt: at(1),
        }),
      },
      /*
       * THE FIXTURE THIS WHOLE FILE TURNS ON: an UNAVAILABLE reading beside a
       * real 0 under the same name. Coalescing the null to 0 makes these two
       * rows indistinguishable in the response, which is the lie the nullable
       * column exists to prevent.
       */
      {
        id: 'm2',
        ...sample({
          variantId: 'v2',
          variantKey: 'webkit|1280x720|en-US|<anonymous>|env_1',
          value: null,
          unavailableReason: 'the trace carried no LCP entry for this navigation',
          createdAt: at(2),
        }),
      },
      /* A real zero: the page painted instantly. Measured, and the best result. */
      { id: 'm3', ...sample({ value: 0, createdAt: at(3) }) },
      {
        id: 'm4',
        ...sample({
          name: 'visual_diff_ratio',
          value: 0,
          unit: 'RATIO',
          createdAt: at(4),
        }),
      },
      /* One name, two units — a series that must not be plotted on one axis. */
      { id: 'm5', ...sample({ name: 'http_req_duration_p95', value: 90, createdAt: at(5) }) },
      {
        id: 'm6',
        ...sample({ name: 'http_req_duration_p95', value: 1.2, unit: 'SECONDS', createdAt: at(6) }),
      },
      /* Seven readings of one name, so a limit of 3 makes a cap bite. */
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `m_inp_${index}`,
        ...sample({
          name: 'inp',
          value: 50 + index,
          runId: index < 4 ? RUN_1 : RUN_2,
          createdAt: at(10 + index),
        }),
      })),
      /* The sibling project's reading. It must never appear under PROJECT. */
      {
        id: 'm_sib',
        ...sample({
          projectId: SIBLING_PROJECT,
          testId: TEST_SIB,
          testResultId: 'tr_sib',
          value: 9999,
        }),
      },
    ],
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { measurementsRouter } = await import('./measurements.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
/* Prefix-mounted exactly as index.ts mounts it: the router declares bare paths. */
app.use('/measurements', measurementsRouter);
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

function asActor(overrides: Partial<Hoisted['actor']> = {}): void {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null, ...overrides };
}

beforeEach(() => {
  store = seed();
  h.prisma = makeDb();
  h.ops = [];
  h.schemaMissing = false;
  asActor();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── The matrix ──────────────────────────────────────────────────────────────

describe('GET /measurements/:projectId/matrix', () => {
  it('groups the reported cells by test and names each test', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/matrix`);
    expect(status).toBe(200);

    expect(body.cells.total).toBe(5);
    expect(body.cells.onPage).toBe(5);
    expect(body.tests.map((group: Row) => group.testId)).toEqual([TEST_A, TEST_B]);

    const a = body.tests.find((group: Row) => group.testId === TEST_A);
    expect(a.name).toBe('checkout works');
    expect(a.filePath).toBe('e2e/checkout.spec.ts');
    expect(a.cellsOnPage).toBe(4);
    expect(a.cutByPageBoundary).toBe(false);
  });

  it('carries retriedAndPassed beside the status rather than folding it in', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);
    const a = body.tests.find((group: Row) => group.testId === TEST_A);
    const retried = a.cells.find((cell: Row) => cell.viewport === 'iphone-14');

    /* The status is still PASSED and the flag is still true. Both, separately. */
    expect(retried.status).toBe('PASSED');
    expect(retried.retriedAndPassed).toBe(true);
    expect(body.reporting.retriedAndPassedRule).toMatch(/not a pass/);
  });

  it('leaves notRunKind null where it is null and reports it where it is set', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);
    const a = body.tests.find((group: Row) => group.testId === TEST_A);

    const skipped = a.cells.find((cell: Row) => cell.status === 'SKIPPED');
    expect(skipped.notRunKind).toBe('BLOCKED_BY_ENV');

    const passed = a.cells.find((cell: Row) => cell.status === 'PASSED');
    /*
     * NULL IS A FIFTH STATE AND IT IS NOT NOT_RUN. `toBeNull` and not a
     * falsy check: coalescing it to the string 'NOT_RUN' would put a claim in
     * the response that no runner made.
     */
    expect(passed.notRunKind).toBeNull();
  });

  it('distinguishes a skipped cell from one nobody reported', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);

    /* The skipped cell is present with a status. */
    const statuses = body.tests.flatMap((group: Row) =>
      group.cells.map((cell: Row) => cell.status),
    );
    expect(statuses).toContain('SKIPPED');

    /* And the ones nobody ran are absent, counted as unknown rather than 0. */
    expect(body.reporting.unreportedCells).toBeNull();
    expect(body.reporting.unreportedCellsWhy).toMatch(/unknown rather than 0/);
    expect(body.reporting.skippedIsNotUnreported).toMatch(/never reported/);
  });

  it('counts dimension values per dimension and never multiplies them', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);

    expect(body.dimensions.browser.values.map((v: Row) => v.value)).toEqual([
      'chromium',
      'firefox',
      'webkit',
    ]);
    expect(body.dimensions.browser.values.find((v: Row) => v.value === 'chromium').cells).toBe(3);
    expect(body.dimensions.viewport.distinctValuesListed).toBe(2);
    expect(body.dimensions.locale.distinctValuesListed).toBe(2);
    expect(body.dimensions.role.distinctValuesListed).toBe(2);
    expect(body.dimensions.environment.distinctValuesListed).toBe(2);

    /*
     * 3 x 2 x 2 x 2 x 2 = 48, and five cells were reported. The product must
     * appear nowhere in the response — as a number or as a total — because it
     * is a denominator nobody measured.
     */
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('48');
    expect(body.cells.total).toBe(5);
    expect(body.reporting.dimensionProductIsNotADenominator).toMatch(/must not be multiplied/);
  });

  it('counts dimensions over the whole filtered set and not over the page', async () => {
    /*
     * Two cells on the page, three browsers in the project. A dimension count
     * folded out of the page would say 1 here, and a reader comparing it with
     * `cells.onPage` would conclude the suite runs one browser.
     */
    const { body } = await get(`/measurements/${PROJECT}/matrix?limit=2`);
    expect(body.cells.onPage).toBe(2);
    expect(body.dimensions.browser.distinctValuesListed).toBe(3);
    expect(body.reporting.dimensionScope).toMatch(/not the cells on this page/);
  });

  it('flags the <unvaried> sentinel and leaves <anonymous> unflagged', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);

    const unvariedRole = body.dimensions.role.values.find((v: Row) => v.value === UNVARIED_VALUE);
    expect(unvariedRole.unvaried).toBe(true);

    /*
     * '<anonymous>' means "ran as a logged-out visitor" — a real answer about
     * the application — so it must NOT be flagged as a dimension nobody varied.
     */
    const anonymous = body.dimensions.role.values.find((v: Row) => v.value === ANONYMOUS);
    expect(anonymous.unvaried).toBe(false);
  });

  it('discloses the dimension-value cap when a project has more values than it lists', async () => {
    /*
     * 101 locales under one test result — legal, because a cell's identity is
     * all five dimensions — so the 100-value ceiling bites. Without this
     * fixture the cap is code no test reaches, and a cap nobody can see is a
     * cap somebody will mistake for the whole set.
     */
    for (let index = 0; index < 101; index += 1) {
      store.testResultVariant.push({
        id: `v_loc_${index}`,
        ...variant({ locale: `xx-${String(index).padStart(3, '0')}` }),
      });
    }

    const { body } = await get(`/measurements/${PROJECT}/matrix?limit=1`);
    expect(body.dimensions.locale.truncated).toBe(true);
    expect(body.dimensions.locale.distinctValuesListed).toBe(100);
    expect(body.dimensions.locale.limit).toBe(100);
    expect(body.dimensions.locale.truncatedReason).toMatch(/at least 1 more exists/);

    /* The dimensions that did NOT hit the cap still say so. */
    expect(body.dimensions.browser.truncated).toBe(false);
    expect(body.dimensions.browser.truncatedReason).toBeNull();
  });

  it('400s an unknown status filter and names the valid statuses', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/matrix?status=ERROR`);

    /*
     * NOT a 200 carrying []. "No cell in this project failed" is the opposite
     * of the truth and the most dangerous answer this endpoint has.
     */
    expect(status).toBe(400);
    expect(body.error?.message ?? body.message).toMatch(/Unknown status: ERROR/);
    for (const valid of ['PASSED', 'FAILED', 'SKIPPED', 'FLAKY', 'TIMED_OUT']) {
      expect(body.error?.message ?? body.message).toContain(valid);
    }
  });

  it('accepts a known status filter and applies it before the cap', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/matrix?status=failed&limit=1`);
    expect(status).toBe(200);
    expect(body.cells.total).toBe(1);
    expect(body.tests[0].cells[0].status).toBe('FAILED');
  });

  it('400s an unknown filter NAME instead of ignoring it', async () => {
    /*
     * A misspelt filter name that is quietly dropped reads as "no filter was
     * applied", and the caller gets a wider answer than the one they asked
     * about with nothing to tell them.
     */
    const { status } = await get(`/measurements/${PROJECT}/matrix?statuss=FAILED`);
    expect(status).toBe(400);
  });

  it('never returns a sibling project’s cells', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);
    const testIds = body.tests.map((group: Row) => group.testId);
    expect(testIds).not.toContain(TEST_SIB);
    expect(JSON.stringify(body)).not.toContain('another project entirely');

    /* And the sibling project answers with its own cell and nothing else. */
    const sibling = await get(`/measurements/${SIBLING_PROJECT}/matrix`);
    expect(sibling.body.tests.map((group: Row) => group.testId)).toEqual([TEST_SIB]);
  });

  it('404s a project in another org', async () => {
    const { status, body } = await get(`/measurements/${OTHER_ORG_PROJECT}/matrix`);
    /* 404 and never 403: a 403 would confirm the id exists somewhere. */
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('another project entirely');
  });

  it('discloses the cap as a count and a reason, and names the cut group', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix?limit=2`);

    expect(body.cells.onPage).toBe(2);
    expect(body.cells.total).toBe(5);
    expect(body.cells.truncated).toBe(true);
    expect(body.cells.truncatedBy).toBe(3);
    expect(body.cells.truncatedReason).toMatch(/at least 3 more existed/);

    /* TEST_A has four cells and two are on this page, so the group was cut. */
    expect(body.tests[0].testId).toBe(TEST_A);
    expect(body.tests[0].cutByPageBoundary).toBe(true);
  });

  it('does not claim a cut group when the page ends on a group boundary', async () => {
    /* TEST_A's four cells sort first, so limit=4 ends exactly at its boundary. */
    const { body } = await get(`/measurements/${PROJECT}/matrix?limit=4`);
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0].testId).toBe(TEST_A);
    expect(body.tests[0].cellsOnPage).toBe(4);
    expect(body.tests[0].cutByPageBoundary).toBe(false);
    expect(body.cells.truncatedBy).toBe(1);
  });

  it('marks a group cut by the LEADING edge of a page', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix?limit=2&offset=2`);
    expect(body.tests[0].testId).toBe(TEST_A);
    /* Cells 0 and 1 of TEST_A are on the previous page. */
    expect(body.tests[0].cutByPageBoundary).toBe(true);
  });

  it('reports no cap when nothing was hidden', async () => {
    const { body } = await get(`/measurements/${PROJECT}/matrix`);
    expect(body.cells.truncated).toBe(false);
    expect(body.cells.truncatedBy).toBe(0);
    expect(body.cells.truncatedReason).toBeNull();
    /* Every cap is returned whole, including the ones that did not bite. */
    expect(body.caps.matrixCellsMax).toBeGreaterThan(0);
  });

  it('answers 503 and not an empty matrix when the table is not migrated', async () => {
    h.schemaMissing = true;
    const { status, body } = await get(`/measurements/${PROJECT}/matrix`);

    /*
     * A 200 carrying no cells would say "this suite has been run in no
     * browser", which is a measured claim about the customer manufactured out
     * of our own un-applied migration.
     */
    expect(status).toBe(503);
    expect(body.error?.code ?? body.code).toBe('MEASUREMENT_SCHEMA_UNAVAILABLE');
    expect(JSON.stringify(body)).toContain('TestResultVariant');
    expect(body.cells).toBeUndefined();
  });

  it('requires the tests:read scope', async () => {
    asActor({ scopes: ['tests:write'] });
    const { status } = await get(`/measurements/${PROJECT}/matrix`);
    expect(status).toBe(403);
  });
});

// ─── The trend ───────────────────────────────────────────────────────────────

describe('GET /measurements/:projectId/metrics', () => {
  it('returns the series oldest-first with its unit and direction', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    expect(status).toBe(200);
    expect(body.name).toBe('lcp');
    expect(body.unit).toBe('MILLISECONDS');
    expect(body.direction).toBe('LOWER_IS_BETTER');
    expect(body.points.map((point: Row) => point.value)).toEqual([1200, null, 0]);
    expect(body.filters.order).toBe('OLDEST_FIRST');
  });

  it('keeps a null reading null and carries its reason', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    const unavailable = body.points.find((point: Row) => point.measured === false);

    expect(unavailable.value).toBeNull();
    expect(unavailable.unavailableReason).toBe(
      'the trace carried no LCP entry for this navigation',
    );
  });

  it('coalescing null to 0 is caught: a real 0 and an unavailable reading stay distinct', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);

    /*
     * THE MUTATION TARGET. Two rows under one name: one measured 0 (the page
     * painted instantly, the best possible result) and one that could not be
     * measured. `value ?? 0` anywhere in the response path makes these two
     * identical, so the assertions below are written to fail on exactly that.
     */
    const zero = body.points.find((point: Row) => point.value === 0);
    expect(zero).toBeDefined();
    expect(zero.measured).toBe(true);
    expect(zero.unavailableReason).toBeNull();

    const nulls = body.points.filter((point: Row) => point.value === null);
    expect(nulls).toHaveLength(1);
    expect(nulls[0].measured).toBe(false);
    expect(nulls[0].unavailableReason).toBeTruthy();

    /* Exactly one point is a zero. Coalescing would make it two. */
    expect(body.points.filter((point: Row) => point.value === 0)).toHaveLength(1);
  });

  it('counts measured and unavailable separately and adds them nowhere', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);

    expect(body.counts.measured).toBe(2);
    expect(body.counts.unavailable).toBe(1);
    expect(body.counts.readings).toBe(3);

    /*
     * The three are three counts, not a ratio. No percentage of any kind is
     * computed from them — there is no field whose value is 2/3 of anything.
     */
    expect(body.counts.noPercentage).toMatch(/two counts and this endpoint does not divide them/);
    expect(Object.keys(body.counts)).not.toContain('measuredPercent');
    expect(Object.keys(body.counts)).not.toContain('percent');
    expect(JSON.stringify(body)).not.toContain('66.6');
  });

  it('answers an unknown name with an empty series and an explicit statement', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/metrics?name=lpc`);

    expect(status).toBe(200);
    /* No point at all — and in particular no 0-valued one. */
    expect(body.points).toEqual([]);
    expect(body.counts.readings).toBe(0);
    expect(body.counts.measured).toBe(0);
    expect(body.counts.unavailable).toBe(0);

    /* THE STATEMENT. An empty list on its own reads as "this metric is flat". */
    expect(body.empty).not.toBeNull();
    expect(body.empty.why).toContain('"lpc"');
    expect(body.empty.statement).toMatch(/absence of a measurement, not a measurement of zero/);
    expect(body.empty.statement).toMatch(/metrics\/names/);
  });

  it('reports no empty statement when the series has readings', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    /* The statement is a claim about an absence; present on a non-empty series
     * it would be a contradiction a caller could render. */
    expect(body.empty).toBeNull();
  });

  it('400s a name that is not an identifier', async () => {
    const { status } = await get(
      `/measurements/${PROJECT}/metrics?name=${encodeURIComponent('Largest Contentful Paint')}`,
    );
    /* The name is the key a trend GROUPs on; a sentence cannot be grouped on. */
    expect(status).toBe(400);
  });

  it('400s a missing name rather than plotting every metric on one axis', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/metrics`);
    expect(status).toBe(400);
    expect(body.error?.message ?? body.message).toMatch(/`name` is required/);
  });

  it('refuses a series whose readings disagree about the unit', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=http_req_duration_p95`);

    /*
     * One name, MILLISECONDS and SECONDS. A chart that puts 90 and 1.2 on one
     * axis draws a 75x improvement where nothing changed, so the series has no
     * unit and says why.
     */
    expect(body.unit).toBeNull();
    expect(body.unitConflict).toMatch(/MILLISECONDS/);
    expect(body.unitConflict).toMatch(/SECONDS/);
    expect(body.unitsSeen).toHaveLength(2);
    /* Each point still carries its own unit, so nothing is lost. */
    expect(body.points.map((point: Row) => point.unit)).toEqual(['MILLISECONDS', 'SECONDS']);
  });

  it('refuses a unit the shared vocabulary does not know', async () => {
    /*
     * MetricUnit is declared twice — a Postgres enum and `METRIC_UNITS` — and
     * `check:enums` exists because the two drift. A unit only the database
     * knows would render as a bare number beside numbers that have units, which
     * is precisely the misreading METRIC_UNITS' own comment warns about, so the
     * series reports no unit and names the stranger.
     */
    store.testMetricSample.push({
      id: 'm_odd',
      ...sample({ name: 'odd_metric', value: 7, unit: 'FURLONGS', createdAt: at(30) }),
    });

    const { body } = await get(`/measurements/${PROJECT}/metrics?name=odd_metric`);
    expect(body.unit).toBeNull();
    expect(body.unrecognisedUnits).toEqual(['FURLONGS']);
    /* The reading itself is not dropped — it is a measurement, just unrenderable. */
    expect(body.points).toHaveLength(1);
    expect(body.points[0].value).toBe(7);
    expect(body.counts.measured).toBe(1);
  });

  it('reports no unrecognised unit for a series the vocabulary covers', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    expect(body.unrecognisedUnits).toEqual([]);
    expect(body.unit).toBe('MILLISECONDS');
  });

  it('discloses the cap as a count and a reason on a long series', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=inp&limit=3`);

    expect(body.points).toHaveLength(3);
    expect(body.counts.readings).toBe(7);
    expect(body.page.truncated).toBe(true);
    expect(body.page.truncatedBy).toBe(4);
    expect(body.page.truncatedReason).toMatch(/at least 4 more existed/);
    expect(body.page.truncatedReason).toMatch(/limit 3/);
  });

  it('pages forward without losing or repeating a point', async () => {
    const first = await get(`/measurements/${PROJECT}/metrics?name=inp&limit=3`);
    const second = await get(`/measurements/${PROJECT}/metrics?name=inp&limit=3&offset=3`);
    const third = await get(`/measurements/${PROJECT}/metrics?name=inp&limit=3&offset=6`);

    const values = [...first.body.points, ...second.body.points, ...third.body.points].map(
      (point: Row) => point.value,
    );
    expect(values).toEqual([50, 51, 52, 53, 54, 55, 56]);
    expect(third.body.page.truncated).toBe(false);
    expect(third.body.page.truncatedReason).toBeNull();
  });

  it('orders newest-first on request', async () => {
    const { body } = await get(
      `/measurements/${PROJECT}/metrics?name=inp&order=NEWEST_FIRST&limit=2`,
    );
    expect(body.points.map((point: Row) => point.value)).toEqual([56, 55]);
  });

  it('filters by run, by test and by window', async () => {
    const byRun = await get(`/measurements/${PROJECT}/metrics?name=inp&runId=${RUN_2}`);
    expect(byRun.body.counts.readings).toBe(3);

    const byTest = await get(`/measurements/${PROJECT}/metrics?name=lcp&testId=${TEST_B}`);
    expect(byTest.body.counts.readings).toBe(0);
    expect(byTest.body.empty).not.toBeNull();

    const inWindow = await get(
      `/measurements/${PROJECT}/metrics?name=inp&since=${at(12).toISOString()}&until=${at(14).toISOString()}`,
    );
    expect(inWindow.body.points.map((point: Row) => point.value)).toEqual([52, 53, 54]);
  });

  it('400s an inside-out window rather than answering "never measured"', async () => {
    const { status, body } = await get(
      `/measurements/${PROJECT}/metrics?name=inp&since=${at(20).toISOString()}&until=${at(10).toISOString()}`,
    );
    expect(status).toBe(400);
    expect(body.error?.message ?? body.message).toMatch(/inside out/);
  });

  it('filters to one cell through the variant’s own columns', async () => {
    const cell = await get(`/measurements/${PROJECT}/metrics?name=lcp&browser=webkit`);
    expect(cell.body.points).toHaveLength(1);
    expect(cell.body.points[0].value).toBeNull();
    /* The stored key is echoed, never parsed or recomposed here. */
    expect(cell.body.points[0].variantKey).toBe('webkit|1280x720|en-US|<anonymous>|env_1');
    expect(cell.body.points[0].variantId).toBe('v2');
  });

  it('separates whole-test readings from cell readings', async () => {
    const whole = await get(`/measurements/${PROJECT}/metrics?name=lcp&scope=WHOLE_TEST`);
    expect(whole.body.points).toHaveLength(1);
    expect(whole.body.points[0].variantId).toBeNull();
    expect(whole.body.points[0].variantKey).toBe(UNVARIED_VALUE);

    const cells = await get(`/measurements/${PROJECT}/metrics?name=lcp&scope=CELL`);
    expect(cells.body.points.map((point: Row) => point.variantId)).toEqual(['v1', 'v2']);
  });

  it('400s a cell filter combined with scope=WHOLE_TEST', async () => {
    const { status, body } = await get(
      `/measurements/${PROJECT}/metrics?name=lcp&scope=WHOLE_TEST&browser=webkit`,
    );
    /*
     * The two together match nothing, and answering [] would say "lcp has never
     * been measured in webkit" to a caller who asked a contradictory question.
     */
    expect(status).toBe(400);
    expect(body.error?.message ?? body.message).toMatch(/match no reading at all/);
  });

  it('never returns a sibling project’s readings', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    expect(body.points.map((point: Row) => point.value)).not.toContain(9999);
  });

  it('404s a project in another org', async () => {
    const { status } = await get(`/measurements/${OTHER_ORG_PROJECT}/metrics?name=lcp`);
    expect(status).toBe(404);
  });

  it('answers 503 and not an empty series when the table is not migrated', async () => {
    h.schemaMissing = true;
    const { status, body } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    expect(status).toBe(503);
    expect(body.points).toBeUndefined();
    expect(JSON.stringify(body)).toContain('TestMetricSample');
  });

  it('requires the tests:read scope', async () => {
    asActor({ scopes: ['tests:write'] });
    const { status } = await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    expect(status).toBe(403);
  });
});

// ─── The name list ───────────────────────────────────────────────────────────

describe('GET /measurements/:projectId/metrics/names', () => {
  it('lists the names with their measured and unavailable counts', async () => {
    const { status, body } = await get(`/measurements/${PROJECT}/metrics/names`);
    expect(status).toBe(200);

    expect(body.names.map((entry: Row) => entry.name)).toEqual([
      'http_req_duration_p95',
      'inp',
      'lcp',
      'visual_diff_ratio',
    ]);

    const lcp = body.names.find((entry: Row) => entry.name === 'lcp');
    expect(lcp.readings).toBe(3);
    expect(lcp.measured).toBe(2);
    /* The unavailable reading is not a measured one. */
    expect(lcp.unavailable).toBe(1);
  });

  it('shows a name recorded in two units as two units', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics/names`);
    const p95 = body.names.find((entry: Row) => entry.name === 'http_req_duration_p95');

    expect(p95.units.map((unit: Row) => unit.unit)).toEqual(['MILLISECONDS', 'SECONDS']);
    expect(p95.readings).toBe(2);
  });

  it('never lists a sibling project’s names', async () => {
    const { body } = await get(`/measurements/${SIBLING_PROJECT}/metrics/names`);
    expect(body.names).toHaveLength(1);
    expect(body.names[0].readings).toBe(1);

    const ours = await get(`/measurements/${PROJECT}/metrics/names`);
    const lcp = ours.body.names.find((entry: Row) => entry.name === 'lcp');
    /* 3 of ours, and the sibling's fourth reading is not folded in. */
    expect(lcp.readings).toBe(3);
  });

  it('discloses the group cap and names the entry it cut', async () => {
    /*
     * limit=1 cuts BETWEEN http_req_duration_p95's two unit groups, which is
     * the case that matters: the name is on the page, its second unit is not,
     * and its `readings` here is therefore 1 out of 2. A response that reported
     * that number without saying it was cut would understate the series a
     * reader is about to chart.
     */
    const { body } = await get(`/measurements/${PROJECT}/metrics/names?limit=1`);

    expect(body.page.groupsOnPage).toBe(1);
    expect(body.page.truncated).toBe(true);
    expect(body.page.truncatedReason).toMatch(/at least 1 more existed/);
    expect(body.page.truncatedReason).toMatch(/offset=1/);

    expect(body.names[0].name).toBe('http_req_duration_p95');
    expect(body.names[0].cutByPageBoundary).toBe(true);
    expect(body.names[0].readings).toBe(1);
  });

  it('does not flag a cut when the cap stops exactly after a name\u2019s last group', async () => {
    /*
     * limit=2 takes BOTH of http_req_duration_p95's unit groups, so the name is
     * complete even though the list is truncated. A `cutByPageBoundary` that
     * simply mirrored `truncated` would be wrong here, and wrong in the
     * direction that makes a correct number look untrustworthy.
     */
    const { body } = await get(`/measurements/${PROJECT}/metrics/names?limit=2`);
    expect(body.page.truncated).toBe(true);
    expect(body.names).toHaveLength(1);
    expect(body.names[0].readings).toBe(2);
    expect(body.names[0].cutByPageBoundary).toBe(false);
  });

  it('does not claim a cut entry when the cap falls on a name boundary', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics/names?limit=3`);
    expect(body.page.truncated).toBe(true);
    const p95 = body.names.find((entry: Row) => entry.name === 'http_req_duration_p95');
    /* Both of its unit groups are on this page. */
    expect(p95.readings).toBe(2);
    expect(p95.cutByPageBoundary).toBe(false);
    /* `inp` is last and the next group is a different name, so it is intact. */
    expect(body.names.at(-1).name).toBe('inp');
    expect(body.names.at(-1).cutByPageBoundary).toBe(false);
  });

  it('claims no total it did not count', async () => {
    const { body } = await get(`/measurements/${PROJECT}/metrics/names?limit=2`);
    /* A total would cost a second scan; `truncated` plus the reason is the
     * disclosure, and null is the honest value for a number nobody counted. */
    expect(body.page.total).toBeNull();
  });

  it('400s an unknown filter NAME instead of ignoring it', async () => {
    const { status } = await get(`/measurements/${PROJECT}/metrics/names?name=lcp`);
    /* `name` is not a filter here — the list IS the names. */
    expect(status).toBe(400);
  });

  it('404s a project in another org', async () => {
    const { status } = await get(`/measurements/${OTHER_ORG_PROJECT}/metrics/names`);
    expect(status).toBe(404);
  });

  it('answers 503 and not an empty list when the table is not migrated', async () => {
    h.schemaMissing = true;
    const { status, body } = await get(`/measurements/${PROJECT}/metrics/names`);
    expect(status).toBe(503);
    expect(body.names).toBeUndefined();
  });

  it('requires the tests:read scope', async () => {
    asActor({ scopes: ['tests:write'] });
    const { status } = await get(`/measurements/${PROJECT}/metrics/names`);
    expect(status).toBe(403);
  });
});

// ─── The queries themselves ──────────────────────────────────────────────────

describe('the queries the indexes were written for', () => {
  it('scopes the matrix through the relation and not by orgId alone', async () => {
    await get(`/measurements/${PROJECT}/matrix`);
    /*
     * The fake throws on an unsupported filter, so this assertion is really
     * "the read happened at all" — the isolation is proven by the sibling test
     * above. What is checked here is that the dimension counts are five
     * separate groupBys over the same filtered set rather than a fold of the
     * page.
     */
    expect(h.ops.filter((op) => op.startsWith('testResultVariant.groupBy'))).toHaveLength(5);
    expect(h.ops).toContain('testResultVariant.count');
  });

  it('reads the trend with three separate counts', async () => {
    h.ops = [];
    await get(`/measurements/${PROJECT}/metrics?name=lcp`);
    /* readings, measured, unavailable — queried, never derived from each other. */
    expect(h.ops.filter((op) => op === 'testMetricSample.count')).toHaveLength(3);
  });
});
