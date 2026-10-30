/**
 * Tests for the suite-health door, over HTTP.
 *
 * `SuiteHealthSnapshot` had no writer: the route COMPUTED a suite-health
 * reading on every request and threw it away, so "is this suite getting worse?"
 * — the premise of the whole lens — had no answer, and the model was a schema
 * entry for a feature that did not exist. These tests are about the writer and
 * the trend read, and almost all of them are about the same thing: WHAT GETS
 * WRITTEN WHEN WE DID NOT MEASURE SOMETHING.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A NULL NEVER BECOMES A 0, AND A 0 IS NEVER THROWN AWAY. This is the
 *      whole table. `weakAssertionCount: 0` means we scanned every test and
 *      found none — the BEST possible result — and writing it for a scan that
 *      never ran is the most flattering lie this product could tell about
 *      itself. So a project with three clean tests stores four measured zeroes,
 *      and a project with no tests at all stores four NULLs beside a measured
 *      `testCount: 0`. Asserted on the stored row, not on the response.
 *
 *   2. THE FIVE COLUMNS THIS DOOR CANNOT FILL ARE NULL, FOREVER, AND SAY SO.
 *      `passRatePercent`, `medianDurationMs` and `p95DurationMs` need a run and
 *      this is a source-only scan, so they are NULL beside a NULL `runId`;
 *      `obsoleteCount` is NULL because nothing in the product measures it. A
 *      `score` of 0 that the analyser itself calls "0 by default, not by
 *      evidence" is stored as NULL.
 *
 *   3. THE MAX_TESTS CAP LANDS IN `caveats` WITH THE SHORTFALL, so the snapshot
 *      can say "at least N more existed" — and an uncapped scan writes an EMPTY
 *      caveat list, which is the positive claim that nothing was truncated.
 *      Both halves, because either alone is worthless.
 *
 *   4. AN IDENTICAL RE-SCAN WRITES NOTHING AND KEEPS THE FIRST `createdAt`.
 *      That timestamp is "since when has it been like this", which is most of
 *      what a rot chart is for. The converse too: one changed byte of test
 *      source is a new fingerprint and a new row, and a `spec` whose KEYS were
 *      reordered is not.
 *
 *   5. AN UNKNOWN FILTER VALUE IS A 400 THAT NAMES THE VALID VALUES, filters
 *      apply BEFORE the cap, the cap is disclosed as a count AND a reason, and
 *      a NULL measurement stays null on the way out.
 *
 *   6. EVERY ROUTE CHECKS ITS SCOPE AND THE WRITE CHECKS ITS ROLE, with
 *      cross-tenant answering 404 and never 403.
 *
 *   7. NO CUSTOMER SOURCE TEXT REACHES AN AUDIT ROW. The caveats are a COUNT in
 *      the audit metadata, because one of them is about test source that could
 *      not be parsed.
 *
 *   8. THE EVIDENCE KEYS THE WRITER READS ARE PINNED. Four counts are read out
 *      of `component.evidence` by name, and a rename in
 *      packages/agent/src/suite-health.ts would silently turn four columns
 *      NULL. Test 1 is what makes that rename go red instead.
 *
 * Harness: the same shape as routes/manual-cases.test.ts — a mocked prisma
 * module with a real AsyncLocalStorage tenant scope, a select-honouring
 * in-memory store, an auth mock that is a reimplementation of
 * middleware/auth.ts rather than a pass-through, and the real router driven
 * over a loopback socket. The ANALYSER IS REAL: nothing here fakes
 * `analyzeSuiteHealth`, because the thing under test is the mapping from what
 * it genuinely produces onto what gets stored, and a fake would let that
 * mapping agree with itself.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
  ops: string[];
  logs: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  audits: [],
  ops: [],
  logs: [],
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

/*
 * CAPTURED, not discarded. "No test source reaches a log line" is a property of
 * this endpoint — the analyser holds every test's code in memory — and a logger
 * mock that threw its arguments away would make that assertion vacuous,
 * including for the error middleware, which logs what a handler threw.
 */
vi.mock('../lib/logger.js', () => {
  const safeString = (value: unknown): string => {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      h.logs.push(`${level} ${args.map((arg) => safeString(arg)).join(' ')}`);
    };
  return {
    logger: {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
    },
    currentRequestId: () => 'req_test',
    setRequestActor: () => {},
    runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
    registerRequestSecrets: () => {},
  };
});

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

/*
 * Captured rather than counted. "No test name, no source line and no caveat
 * sentence reaches the audit log" is a property of this endpoint, so the
 * payloads are asserted on.
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
 * route whose scope check is simply missing passes every test in the file —
 * and this repo has shipped routes with no scope check before.
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

type ModelName = 'project' | 'test' | 'flowMap' | 'suiteHealthSnapshot';

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored: a fake that shrugged at `disabledAt: null` would
 * pass every scope test below against a router that graded disabled tests, and
 * one that shrugged at `fingerprint` would make the de-duplication untestable.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  test: new Set(['id', 'orgId', 'projectId', 'disabledAt', 'filePath']),
  flowMap: new Set(['orgId', 'projectId']),
  suiteHealthSnapshot: new Set(['id', 'orgId', 'projectId', 'fingerprint', 'commitSha', 'runId']),
};

type Store = Record<ModelName, Row[]>;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    // `filePath: { not: { startsWith: FIXTURE_PREFIX } }` — the fixture filter.
    if ('startsWith' in c) return typeof value === 'string' && value.startsWith(c.startsWith);
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
 * router would read `row.fingerprint` from a result it never asked for, the test
 * would pass, and production would read `undefined` — which for THIS router
 * means a de-duplication that never matches and one snapshot row per poll,
 * forever. Two defects survived a whole slice behind fakes that shrugged at
 * `select`, so this one throws on an unsupported select and returns ONLY what
 * was asked for.
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
 * A monotonic write clock, so `createdAt` MOVES on every insert.
 *
 * This is what makes "an identical re-scan writes nothing and keeps the first
 * `createdAt`" provable rather than asserted: a row whose `createdAt` is
 * unchanged was not re-inserted, and a fake that stamped a constant would let a
 * stray second create through unnoticed.
 */
let writeClock = 0;
function nextWriteAt(): Date {
  writeClock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, writeClock));
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
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where)));

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        h.ops.push(`${name}.findUnique`);
        const found = store[name].find((row) => row.id === where.id);
        if (!found) return null;
        if (found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel);
      },
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findFirst`);
        const rows = sortRows(select(where), orderBy);
        const first = rows[0];
        return first ? projectRow(name, first, sel) : null;
      },
      findMany: async ({ where, orderBy, select: sel, take, skip }: Row = {}) => {
        h.ops.push(`${name}.findMany`);
        const rows = sortRows(select(where), orderBy);
        const from = typeof skip === 'number' ? skip : 0;
        const page = typeof take === 'number' ? rows.slice(from, from + take) : rows.slice(from);
        return page.map((row) => projectRow(name, row, sel));
      },
      count: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.count`);
        return select(where).length;
      },
      create: async ({ data, select: sel }: Row) => {
        h.ops.push(`${name}.create`);
        const orgId = h.currentOrg();
        /*
         * Nothing is defaulted here on purpose. Prisma would default only
         * `caveats` (to `[]`) and `createdAt`; every measurement column is
         * nullable with NO default, so a column the router forgot to pass must
         * read back as null and never as 0 — which is exactly what the
         * `?? null` in `projectRow` reproduces.
         */
        const row: Row = {
          id: nextId(name),
          ...data,
          ...(orgId ? { orgId } : {}),
          createdAt: nextWriteAt(),
        };
        store[name].push(row);
        return projectRow(name, row, sel);
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

/** A readable Playwright test with a real assertion. */
function playwright(i: number): string {
  return (
    `import { test, expect } from '@playwright/test';\n` +
    `test('thing ${i}', async ({ page }) => {\n` +
    `  await page.goto('/thing/${i}');\n` +
    `  await page.getByRole('button', { name: 'Go${i}' }).click();\n` +
    `  await expect(page.getByTestId('result-${i}')).toHaveText('ok ${i}');\n` +
    `});\n`
  );
}

/**
 * A test the duplicate scan cannot compare: one route token and nothing else,
 * where the analyser needs three behaviour tokens before two tests can be
 * meaningfully compared. One of these makes `duplicateScanComplete` false — an
 * INELIGIBLE test was never compared, and reporting a clean duplicate scan over
 * a comparison that barely ran is the defect that flag exists to prevent.
 */
const THIN_TEST =
  `import { test } from '@playwright/test';\n` +
  `test('thin', async ({ page }) => {\n` +
  `  await page.goto('/thin');\n` +
  `});\n`;

function testRow(i: number, over: Row = {}): Row {
  return {
    id: `test_${String(i).padStart(5, '0')}`,
    orgId: ORG,
    projectId: PROJECT,
    name: `checks thing ${i}`,
    filePath: `tests/thing${i}.spec.ts`,
    type: 'E2E',
    priority: 'NORMAL',
    feature: `feature${i}`,
    tags: [],
    code: playwright(i),
    spec: null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
    disabledAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    ...over,
  };
}

let store: Store;

function seed(tests: Row[] = []): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else' },
    ],
    test: tests,
    flowMap: [],
    suiteHealthSnapshot: [],
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { suiteHealthRouter } = await import('./suite-health.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json({ limit: '4mb' }));
// Mounted exactly as index.ts mounts it; the router declares relative paths.
app.use('/suite-health', suiteHealthRouter);
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

beforeEach(() => {
  store = seed([testRow(1), testRow(2), testRow(3)]);
  h.prisma = makeDb(store);
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null };
  h.audits = [];
  h.ops = [];
  h.logs = [];
});

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Row; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {}, text };
}

const get = (path: string) => call('GET', path);
const post = (path: string, body?: unknown) => call('POST', path, body);

/** The one stored row, for assertions that must not read the response. */
const onlyRow = (): Row => {
  expect(store.suiteHealthSnapshot).toHaveLength(1);
  return store.suiteHealthSnapshot[0]!;
};

// ─── 1. A null never becomes a 0, and a 0 is never thrown away ───────────────

describe('what gets written when we did not measure something', () => {
  it('stores the MEASURED zeroes for a clean suite', async () => {
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const row = onlyRow();
    /*
     * All four are ZERO and not null: the scan read every test and found no
     * quarantine, no flake, no weak assertion and no duplicate. That is the
     * best possible result and the one a trend has to be able to show.
     *
     * This is also the pin on the evidence keys the writer reads by name
     * (`evidence.quarantined`, `.testsAtOrAbove5Percent`, `.testsWithFindings`,
     * `.duplicatedTests`): rename one in packages/agent/src/suite-health.ts and
     * that column goes null, and this assertion is what turns that silent
     * change into a red test.
     */
    expect(row.quarantinedCount).toBe(0);
    expect(row.flakyCount).toBe(0);
    expect(row.weakAssertionCount).toBe(0);
    expect(row.duplicateCount).toBe(0);
    expect(row.testCount).toBe(3);
    // A real composite, because components were available.
    expect(typeof row.score).toBe('number');
    expect(row.score).toBeGreaterThan(0);
  });

  it('counts a quarantined and a flaky test rather than reporting a clean suite', async () => {
    store.test = [testRow(1, { quarantined: true }), testRow(2, { flakeRate: 12 }), testRow(3)];
    await post(`/suite-health/${PROJECT}/snapshots`);
    const row = onlyRow();
    expect(row.quarantinedCount).toBe(1);
    expect(row.flakyCount).toBe(1);
  });

  it('counts the members of a near-duplicate cluster', async () => {
    // Two tests whose behaviour is the same; the third is distinct.
    store.test = [testRow(1), testRow(2, { code: playwright(1) }), testRow(3)];
    await post(`/suite-health/${PROJECT}/snapshots`);
    expect(onlyRow().duplicateCount).toBe(2);
  });

  /**
   * THE CENTRAL CASE. An empty project measures `testCount: 0` — a real
   * reading, "this project has no runnable tests" — and measures NOTHING else,
   * because every component of the analysis reports itself unavailable. A
   * writer that defaulted those four counts to 0 would store the best possible
   * suite-health reading for a project with no tests in it.
   */
  it('stores NULL, not 0, for every count a scan with nothing to scan did not make', async () => {
    store.test = [];
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(res.status).toBe(201);

    const row = onlyRow();
    expect(row.testCount).toBe(0);
    expect(row.quarantinedCount).toBeNull();
    expect(row.flakyCount).toBeNull();
    expect(row.weakAssertionCount).toBeNull();
    expect(row.duplicateCount).toBeNull();
    /*
     * And the score. `analyzeSuiteHealth` returns 0 here and says so itself —
     * its `formula` reads "the score is 0 by default, not by evidence" — so
     * storing that 0 would put a suite with no value whatsoever in the trend
     * where "we did not score it" belongs.
     */
    expect(row.score).toBeNull();
    expect(res.body.unmeasured.score).toContain('by default rather than by evidence');
  });

  it('stores NULL for duplicateCount when the duplicate scan did not complete, with a caveat', async () => {
    // One test the scan could not compare at all, so the duplicate scan reports
    // itself incomplete — and an incomplete scan finds FEWER duplicates, which
    // would RAISE the score.
    store.test = [testRow(1), testRow(2), testRow(3, { code: THIN_TEST })];
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    const row = onlyRow();

    expect(row.duplicateCount).toBeNull();
    // Measured in the same breath, so the null above is specific and not a
    // writer that gave up on the whole row.
    expect(row.quarantinedCount).toBe(0);
    expect(row.caveats.join('\n')).toContain('near-duplicate scan did not complete');
    expect(res.body.snapshot.data.duplicateCount).toBeNull();
  });

  /**
   * The five this door can never fill. Each one is NULL with a stated reason in
   * the response, because a NULL alone does not say whether it is "not yet" or
   * "never from here" — and a reader charting `passRatePercent` off a
   * source-only scan is charting nothing.
   */
  it('reports the source-only columns as NULL with a reason, and sets no runId', async () => {
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    const row = onlyRow();

    expect(row.runId).toBeNull();
    expect(row.passRatePercent).toBeNull();
    expect(row.medianDurationMs).toBeNull();
    expect(row.p95DurationMs).toBeNull();
    expect(row.obsoleteCount).toBeNull();

    expect(res.body.unmeasured.passRatePercent).toContain('no run was read');
    expect(res.body.unmeasured.medianDurationMs).toContain('no run was read');
    expect(res.body.unmeasured.p95DurationMs).toContain('no run was read');
    expect(res.body.unmeasured.obsoleteCount).toContain('nothing in this product measures');
    // A real score was computed here, so it is NOT in `unmeasured`.
    expect(res.body.unmeasured.score).toBeUndefined();
  });

  /**
   * `runId` is the one body field `.strict()` exists to refuse. Accepting and
   * ignoring it would store a row claiming the pass rate and the durations came
   * from that run, which is the model's own doc comment made false by its
   * writer.
   */
  it('refuses a runId in the body rather than accepting and ignoring it', async () => {
    const res = await post(`/suite-health/${PROJECT}/snapshots`, { runId: 'run_abc' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('runId');
    expect(store.suiteHealthSnapshot).toHaveLength(0);
  });
});

// ─── 2. Caveats: the cap, and the positive claim ─────────────────────────────

describe('caveats', () => {
  it('writes an EMPTY caveat list when nothing was truncated', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    /*
     * The positive claim, and the reason `caveats` is the ONLY defaulted column
     * on this table: an empty list says "nothing was cut and everything
     * parsed", which is verifiable, whereas an empty COUNT would be a claim
     * about the customer's suite.
     */
    expect(onlyRow().caveats).toEqual([]);
  });

  it('names the MAX_TESTS cap and the shortfall when it bites', async () => {
    // One past the cap, which is the only interesting number.
    store.test = Array.from({ length: 2001 }, (_, i) => testRow(i));
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(res.status).toBe(201);

    const row = onlyRow();
    const caveat = row.caveats.find((c: string) => c.includes('scan cap'));
    expect(caveat, 'the cap bit and said nothing').toBeDefined();
    // The count AND the reason, so the snapshot can say "at least N more existed".
    expect(caveat).toContain('2000-test scan cap');
    expect(caveat).toContain('oldest 2000 of 2001');
    expect(caveat).toContain('at least 1 more');
    // The measurement is of what was SCANNED, and the caveat is what makes that
    // readable as a cap rather than as a suite that stopped growing.
    expect(row.testCount).toBe(2000);
  }, 20_000);
});

// ─── 3. The fingerprint and the de-duplication ───────────────────────────────

describe('a repeat scan of an unchanged suite', () => {
  it('writes no second row and keeps the first createdAt', async () => {
    const first = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(first.status).toBe(201);
    const firstRow = onlyRow();

    h.ops = [];
    const second = await post(`/suite-health/${PROJECT}/snapshots`);

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.reason).toContain('FIRST observed');
    // No second create reached the database at all.
    expect(h.ops.filter((op) => op === 'suiteHealthSnapshot.create')).toEqual([]);
    expect(store.suiteHealthSnapshot).toHaveLength(1);
    // The same row, with its original timestamp: that timestamp is "since when
    // has it been like this", and re-stamping it erases the plateau.
    expect(second.body.snapshot.id).toBe(firstRow.id);
    expect(second.body.snapshot.createdAtIso).toBe(firstRow.createdAt.toISOString());
    /*
     * And the proof there is no clock in the fingerprint: the fake's write
     * clock advanced between the two calls, so a `Date.now()` anywhere in the
     * material would have produced a second row.
     */
    expect(second.body.snapshot.fingerprint).toBe(firstRow.fingerprint);
  });

  it('writes a new row when one byte of test source changes', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    const before = onlyRow().fingerprint;

    store.test[0]!.code = `${store.test[0]!.code}// one more line\n`;
    const res = await post(`/suite-health/${PROJECT}/snapshots`);

    expect(res.status).toBe(201);
    expect(store.suiteHealthSnapshot).toHaveLength(2);
    expect(res.body.snapshot.fingerprint).not.toBe(before);
  });

  it('writes a new row when the suite GROWS past the cap but the scanned rows do not change', async () => {
    store.test = Array.from({ length: 2001 }, (_, i) => testRow(i));
    await post(`/suite-health/${PROJECT}/snapshots`);
    const before = onlyRow().fingerprint;

    /*
     * A 2002nd test, newer than every other, so the oldest 2000 that get
     * scanned are byte-identical. Without `testsMatching` in the fingerprint
     * this would de-duplicate and the trend would never show a suite growing
     * once it crossed the cap.
     */
    store.test.push(testRow(5000));
    const res = await post(`/suite-health/${PROJECT}/snapshots`);

    expect(res.status).toBe(201);
    expect(res.body.snapshot.fingerprint).not.toBe(before);
  }, 30_000);

  /**
   * `spec` is a Json column and `JSON.stringify` preserves insertion order, so
   * the same value read back with its keys in a different order would hash
   * differently and mint a snapshot for a suite nobody touched. The fingerprint
   * has to be a function of the VALUE.
   */
  it('is not fooled by a spec whose keys came back in a different order', async () => {
    store.test = [
      testRow(1, { spec: { steps: ['a', 'b'], route: '/x', nested: { p: 1, q: 2 } } }),
      testRow(2),
      testRow(3),
    ];
    await post(`/suite-health/${PROJECT}/snapshots`);
    const before = onlyRow().fingerprint;

    store.test[0]!.spec = { nested: { q: 2, p: 1 }, route: '/x', steps: ['a', 'b'] };
    const res = await post(`/suite-health/${PROJECT}/snapshots`);

    expect(res.body.created).toBe(false);
    expect(res.body.snapshot.fingerprint).toBe(before);
    expect(store.suiteHealthSnapshot).toHaveLength(1);
  });

  it('does not confuse two projects in one org whose suites are identical', async () => {
    const SIBLING = 'proj_3';
    store.project.push({ id: SIBLING, orgId: ORG, name: 'Storefront (fork)' });
    // Byte-identical tests, a different project. A fingerprint that left the
    // project id out would de-duplicate one project's reading onto the other's.
    store.test.push(...[1, 2, 3].map((i) => testRow(i, { id: `sib_${i}`, projectId: SIBLING })));

    const mine = await post(`/suite-health/${PROJECT}/snapshots`);
    const theirs = await post(`/suite-health/${SIBLING}/snapshots`);

    expect(mine.body.created).toBe(true);
    expect(theirs.body.created).toBe(true);
    expect(theirs.body.snapshot.fingerprint).not.toBe(mine.body.snapshot.fingerprint);
    expect(store.suiteHealthSnapshot).toHaveLength(2);

    // The column is `String` and the schema bounds it at 200; a version prefix
    // plus a sha256 is 71, and the bound is what keeps it an index key.
    for (const row of store.suiteHealthSnapshot) {
      expect(row.fingerprint.startsWith('shsnap1:')).toBe(true);
      expect(row.fingerprint.length).toBeLessThanOrEqual(200);
    }

    // And one project's history does not show the other's point.
    const history = await get(`/suite-health/${PROJECT}/history`);
    expect(history.body.total).toBe(1);
  });

  it('distinguishes a scan taken with different analysis options', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    const before = onlyRow().fingerprint;
    const res = await post(`/suite-health/${PROJECT}/snapshots`, { minSimilarity: 0.95 });
    expect(res.body.snapshot.fingerprint).not.toBe(before);
  });
});

// ─── 4. The trend read ───────────────────────────────────────────────────────

describe('GET /suite-health/:projectId/history', () => {
  async function threeSnapshots(): Promise<void> {
    await post(`/suite-health/${PROJECT}/snapshots`, { commitSha: 'aaaaaaa' });
    store.test[0]!.code = `${store.test[0]!.code}// b\n`;
    await post(`/suite-health/${PROJECT}/snapshots`, { commitSha: 'bbbbbbb' });
    store.test[0]!.code = `${store.test[0]!.code}// c\n`;
    await post(`/suite-health/${PROJECT}/snapshots`, { commitSha: 'ccccccc' });
  }

  it('returns the trend newest first, with NULL measurements still null', async () => {
    await threeSnapshots();
    const res = await get(`/suite-health/${PROJECT}/history`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.snapshots.map((s: Row) => s.commitSha)).toEqual([
      'ccccccc',
      'bbbbbbb',
      'aaaaaaa',
    ]);
    for (const snapshot of res.body.snapshots) {
      // Not coalesced on the way out. The entire value of a stored reading is
      // that "we did not measure it" survived being written down.
      expect(snapshot.data.passRatePercent).toBeNull();
      expect(snapshot.data.obsoleteCount).toBeNull();
      expect(snapshot.runId).toBeNull();
      expect(snapshot.data.testCount).toBe(3);
    }
    expect(res.body.truncated).toBe(false);
    expect(res.body.truncatedBy).toBe(0);
    expect(res.body.truncatedReason).toBeNull();
  });

  it('applies the commitSha filter BEFORE the cap and counts total under it', async () => {
    await threeSnapshots();
    const res = await get(`/suite-health/${PROJECT}/history?commitSha=bbbbbbb&limit=1`);
    expect(res.body.total).toBe(1);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].commitSha).toBe('bbbbbbb');
    // A short page means the list is exhausted, never that the filter ran after
    // the cap.
    expect(res.body.truncated).toBe(false);
    expect(res.body.filters.commitSha).toBe('bbbbbbb');
  });

  it('discloses the cap as a COUNT and a REASON when it bites', async () => {
    await threeSnapshots();
    const res = await get(`/suite-health/${PROJECT}/history?limit=1`);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.total).toBe(3);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedBy).toBe(2);
    expect(res.body.truncatedReason).toContain('At least 2 more snapshot(s)');
    expect(res.body.truncatedReason).toContain('page size is 1');
  });

  it('pages with offset without losing the disclosure', async () => {
    await threeSnapshots();
    const res = await get(`/suite-health/${PROJECT}/history?limit=2&offset=2`);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.offset).toBe(2);
    expect(res.body.truncated).toBe(false);
  });

  /**
   * AN UNKNOWN FILTER VALUE IS A 400 THAT NAMES THE VALID VALUES. `?source=RUNS`
   * answering `[]` would read as "this suite has never been measured that way",
   * which is a claim about the customer's history manufactured out of a typo.
   */
  it('refuses an unknown source and names the valid values', async () => {
    await threeSnapshots();
    const res = await get(`/suite-health/${PROJECT}/history?source=RUNS`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Unknown source: RUNS');
    expect(res.text).toContain('RUN, SOURCE_ONLY');
  });

  it('filters to source-only readings, and finds none that came from a run', async () => {
    await threeSnapshots();
    const sourceOnly = await get(`/suite-health/${PROJECT}/history?source=SOURCE_ONLY`);
    expect(sourceOnly.body.total).toBe(3);

    // Every reading this door writes is source-only, so RUN is genuinely empty
    // — and the empty answer is a measured fact, not a filter that ran late.
    const fromRun = await get(`/suite-health/${PROJECT}/history?source=RUN`);
    expect(fromRun.body.total).toBe(0);
    expect(fromRun.body.snapshots).toEqual([]);

    // Naming both filters nothing, and the response says so.
    const both = await get(`/suite-health/${PROJECT}/history?source=RUN,SOURCE_ONLY`);
    expect(both.body.total).toBe(3);
    expect(both.body.filters.source).toEqual(['RUN', 'SOURCE_ONLY']);
  });

  it('refuses a page size above the cap rather than clamping it in silence', async () => {
    const res = await get(`/suite-health/${PROJECT}/history?limit=5000`);
    expect(res.status).toBe(400);
  });

  it('answers an empty history as empty, not as an error', async () => {
    const res = await get(`/suite-health/${PROJECT}/history`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.snapshots).toEqual([]);
    expect(res.body.caps.pageMax).toBe(200);
  });

  /**
   * A stored caveat list that cannot be read as sentences must NOT come back as
   * `[]`: that is the positive claim that nothing was truncated, manufactured
   * out of our own failed parse.
   */
  it('reports an unreadable stored caveat list as unreadable, not as empty', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    store.suiteHealthSnapshot[0]!.caveats = { nope: true };

    const res = await get(`/suite-health/${PROJECT}/history`);
    expect(res.body.snapshots[0].caveats).toHaveLength(1);
    expect(res.body.snapshots[0].caveats[0]).toContain('could not be read as sentences');
  });
});

// ─── 5. The live read still works, and is the same producer ──────────────────

describe('GET /suite-health/:projectId', () => {
  it('rejects an out-of-range query with a 400 that names the field', async () => {
    const res = await get(`/suite-health/${PROJECT}?minSimilarity=2`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('minSimilarity');
  });

  it('still answers the decomposed score', async () => {
    const res = await get(`/suite-health/${PROJECT}`);
    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(PROJECT);
    expect(typeof res.body.score).toBe('number');
    expect(res.body.components.length).toBeGreaterThan(0);
    expect(res.body.limits.partial).toBe(false);
    expect(res.body.limits.maxTests).toBe(2000);
    expect(res.body.limits.scope).toBe('enabled, non-fixture tests; quarantined tests included');
  });

  it('says the report covers only part of the suite when the cap bites', async () => {
    store.test = Array.from({ length: 2001 }, (_, i) => testRow(i));
    const res = await get(`/suite-health/${PROJECT}`);
    expect(res.body.limits.partial).toBe(true);
    expect(res.body.limits.testsAnalyzed).toBe(2000);
    expect(res.body.limits.testsMatching).toBe(2001);
    expect(res.body.limits.note).toContain('2001 runnable tests');
  }, 20_000);

  it('grades the same rows the snapshot stores', async () => {
    const read = await get(`/suite-health/${PROJECT}`);
    const written = await post(`/suite-health/${PROJECT}/snapshots`);
    // One producer, so the stored point IS the number the customer was shown.
    expect(written.body.snapshot.data.score).toBe(read.body.score);
    expect(written.body.snapshot.data.testCount).toBe(read.body.totals.tests);
  });

  it('excludes disabled rows and fixtures from the candidate set', async () => {
    store.test = [
      testRow(1),
      testRow(2),
      testRow(3),
      testRow(4, { disabledAt: new Date() }),
      testRow(5, { filePath: 'fixtures/helpers.ts' }),
    ];
    await post(`/suite-health/${PROJECT}/snapshots`);
    // Three, not five. A team that could raise its score by disabling the
    // failing tests would raise it by disabling the failing tests.
    expect(onlyRow().testCount).toBe(3);
  });

  it('explains one test without claiming NO_NEGATIVE_PATH from a single row', async () => {
    const res = await get(`/suite-health/${PROJECT}/tests/test_00001`);
    expect(res.status).toBe(200);
    expect(res.body.testId).toBe('test_00001');
    expect(res.body.behavior).toBeDefined();
    expect(res.body.weakAssertions.every((f: Row) => f.kind !== 'NO_NEGATIVE_PATH')).toBe(true);
  });
});

// ─── 6. Scope, role and tenancy ──────────────────────────────────────────────

// ─── GET /suite-health/:projectId/drift ──────────────────────────────────────

/*
 * THE DOOR ONTO packages/agent/src/drift.ts, which was 765 lines whose only
 * importer was the package barrel plus its own test file — correct code
 * reachable by no request at all.
 *
 * These drive the mounted router over a real socket, which is the thing worth
 * proving: `check-wiring`'s ratchet is satisfied by a barrel export and a
 * colocated test, so "it has tests" was never evidence that anything could ask
 * the question.
 */
describe('GET /suite-health/:projectId/drift', () => {
  /** A crawl graph in the shape `crawlIndex` reads. */
  const crawl = (
    route: string,
    affordances: Array<{ role: 'ROLE'; name: string }>,
    version = 7,
  ): Row => ({
    id: `fm_${version}`,
    orgId: ORG,
    projectId: PROJECT,
    version,
    graph: {
      projectId: PROJECT,
      baseUrl: 'https://app.test',
      version,
      exploredAt: '2026-02-01T00:00:00Z',
      // An OBJECT with a `state`, which is what `crawlIndex` reads
      // (`flowMap?.acceptance?.state`). A bare string reads as null — and the
      // null is honest, which is why the test fixture has to be the real shape.
      acceptance: { state: 'ACCEPTED', reasons: [] },
      nodes: [
        {
          id: `n-${route}`,
          route,
          url: `https://app.test${route}`,
          title: route,
          stateKey: 'default',
          requiresRoles: [],
          behindAuth: false,
          forms: [],
          affordances: affordances.map((item) => ({
            label: item.name,
            kind: 'button',
            /*
             * `SELECTOR_STRATEGIES` is UPPERCASE ('ROLE'), and a lower-case
             * `'role'` makes `locatorExpression` produce something
             * `locatorParts` cannot compare — so every locator reads GONE and
             * the test would pass for the wrong reason. The real shape, with
             * `confidence`, is what the crawler writes.
             */
            selector: { strategy: item.role, value: 'button', name: item.name, confidence: 0.9 },
          })),
          screenshotKey: null,
          a11yViolationCount: 0,
        },
      ],
      edges: [],
      journeys: [],
    },
  });

  it('answers NOT MEASURED when nothing has ever crawled, rather than a clean report', async () => {
    // `crawlVersion: null` is the whole assertion: every count is zero, and a
    // reader who took those zeroes for "nothing drifted" would be reading an
    // unmeasured answer as a clean one.
    const res = await get(`/suite-health/${PROJECT}/drift`);

    expect(res.status).toBe(200);
    expect(res.body.crawlVersion).toBeNull();
    expect(res.body.testsThatWillFail).toBe(0);
    expect(res.body.caveats.join(' ')).toMatch(/crawl/i);
  });

  it('names the renamed control and hands back the expression to paste', async () => {
    /*
     * `Go1` was relabelled `Go 1 now`. Same role, same route, one candidate —
     * which is the only shape `driftReport` will propose a rewrite for.
     */
    store.test = [testRow(1)];
    store.flowMap = [crawl('/thing/1', [{ role: 'ROLE' as const, name: 'Go 1 now' }])];

    const res = await get(`/suite-health/${PROJECT}/drift`);

    expect(res.status).toBe(200);
    expect(res.body.crawlVersion).toBe(7);
    expect(res.body.crawlAcceptance).toBe('ACCEPTED');
    expect(res.body.testsThatWillFail).toBe(1);
    expect(res.body.deterministicallyRepairable).toBe(1);
    const finding = (res.body.tests as Row[])[0]!.findings[0] as Row;
    expect(finding.state).toBe('NAME_CHANGED');
    // THE PAYOFF: a replacement expression, escaped by `locatorExpression`, for
    // a one-word rename that would otherwise cost a nightly run and a triage.
    expect(finding.proposal).toContain('Go 1 now');
    expect(res.body.counts.NAME_CHANGED).toBe(1);
  });

  it('proposes NOTHING when two candidates survive, and says which refusal bit', async () => {
    /*
     * A CONFIDENT WRONG REWRITE IS WORSE THAN A FAILING RUN. A failing run
     * costs a CI cycle and tells the truth; a locator pointed at the wrong
     * element passes while asserting nothing about the thing it was written for,
     * and nobody looks at it again.
     */
    store.test = [testRow(1)];
    store.flowMap = [
      crawl('/thing/1', [
        { role: 'ROLE' as const, name: 'Go 1 now' },
        { role: 'ROLE' as const, name: 'Go 1 later' },
      ]),
    ];

    const res = await get(`/suite-health/${PROJECT}/drift`);

    const finding = (res.body.tests as Row[])[0]!.findings[0] as Row;
    expect(finding.proposal).toBeNull();
    expect(finding.refusal).toBe('AMBIGUOUS_CANDIDATES');
    expect(res.body.deterministicallyRepairable).toBe(0);
    // The candidates are still SHOWN, so a reviewer can finish by hand what
    // QAAI would not guess at.
    expect((finding.candidates as string[]).length).toBe(2);
  });

  it('discloses the test cap, so a floor cannot read as "nothing else drifted"', async () => {
    const { MAX_TESTS } = { MAX_TESTS: 2000 };
    expect(MAX_TESTS).toBe(2000);
    store.test = [testRow(1)];
    store.flowMap = [crawl('/thing/1', [])];

    const res = await get(`/suite-health/${PROJECT}/drift`);

    // Not partial here: one test, one page.
    expect(res.body.limits).toMatchObject({
      partial: false,
      testsCompared: 1,
      testsMatching: 1,
      note: null,
    });
    expect(res.body.limits.testScanLimit).toBe(2000);
    expect(res.body.limits.warningLimit).toBeGreaterThan(0);
  });

  it('404s for another org project, like every other read on this router', async () => {
    const res = await get(`/suite-health/${OTHER_ORG_PROJECT}/drift`);
    expect(res.status).toBe(404);
  });

  it('refuses a bad query by PATH, never by quoting the value', async () => {
    const res = await get(
      `/suite-health/${PROJECT}/drift?minSimilarity=IGNORE+THE+PLAN+ABOVE`,
    );

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('IGNORE THE PLAN ABOVE');
    expect(res.body.error.details.paths).toContain('minSimilarity');
  });
});

describe('every route checks its scope, the write checks its role', () => {
  const paths = (p: string) =>
    [
      ['GET', `/suite-health/${p}`],
      ['GET', `/suite-health/${p}/history`],
      ['GET', `/suite-health/${p}/tests/test_00001`],
    ] as const;

  it('answers 404 for another org’s project, never 403', async () => {
    for (const [method, path] of paths(OTHER_ORG_PROJECT)) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const write = await post(`/suite-health/${OTHER_ORG_PROJECT}/snapshots`);
    // A 403 here would confirm the project exists. It must not.
    expect(write.status).toBe(404);
    expect(store.suiteHealthSnapshot).toHaveLength(0);
  });

  it('refuses a read without tests:read', async () => {
    h.actor = { ...h.actor, scopes: ['tests:write'] };
    for (const [method, path] of paths(PROJECT)) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.text).toContain('tests:read');
    }
  });

  it('refuses the write without tests:write', async () => {
    h.actor = { ...h.actor, scopes: ['tests:read'] };
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(res.status).toBe(403);
    expect(res.text).toContain('tests:write');
    expect(store.suiteHealthSnapshot).toHaveLength(0);
  });

  it('refuses the write below the MEMBER role', async () => {
    h.actor = { ...h.actor, role: 'VIEWER' };
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    expect(res.status).toBe(403);
    expect(store.suiteHealthSnapshot).toHaveLength(0);
  });

  it('404s an unknown project rather than storing a snapshot of nothing', async () => {
    const res = await post(`/suite-health/proj_missing/snapshots`);
    expect(res.status).toBe(404);
    expect(store.suiteHealthSnapshot).toHaveLength(0);
  });
});

// ─── 7. The audit row, and what must not be in it ────────────────────────────

describe('the write is audited and discloses nothing it should not', () => {
  it('reports all ten measurements on the way out, present even when null', async () => {
    const res = await post(`/suite-health/${PROJECT}/snapshots`);
    /*
     * The ten columns, by name. A column dropped from `SNAPSHOT_SELECT` reads
     * back as `undefined` and JSON omits the key entirely, so a reader charting
     * it would see "the field does not exist" rather than "it was not
     * measured" — and those are different claims. `toHaveProperty` passes on an
     * explicit null and fails on a missing key, which is the distinction.
     */
    for (const field of [
      'testCount',
      'quarantinedCount',
      'flakyCount',
      'weakAssertionCount',
      'duplicateCount',
      'obsoleteCount',
      'passRatePercent',
      'medianDurationMs',
      'p95DurationMs',
      'score',
    ]) {
      expect(res.body.snapshot.data, field).toHaveProperty(field);
    }
    expect(Object.keys(res.body.snapshot.data)).toHaveLength(10);
    // And the row's own identity, which a trend read needs to page and diff.
    expect(res.body.snapshot.id).toBe(onlyRow().id);
    expect(res.body.snapshot.projectId).toBe(PROJECT);
    expect(res.body.snapshot.createdAtIso).toMatch(/^2026-/);
    expect(res.body.snapshot.caveats).toEqual([]);
  });

  it('audits a created snapshot with counts and never with source text', async () => {
    store.test = [testRow(1), testRow(2)];
    await post(`/suite-health/${PROJECT}/snapshots`, { commitSha: 'deadbee' });

    expect(h.audits).toHaveLength(1);
    const entry = h.audits[0]!;
    expect(entry.action).toBe('suiteHealth.snapshot');
    expect(entry.targetType).toBe('SuiteHealthSnapshot');
    expect(entry.targetId).toBe(onlyRow().id);
    expect(entry.metadata.created).toBe(true);
    expect(entry.metadata.fingerprint).toBe(onlyRow().fingerprint);
    // A COUNT, not the sentences: one of them is about test source that could
    // not be parsed, and the audit log is not where that belongs.
    expect(typeof entry.metadata.caveats).toBe('number');

    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('@playwright/test');
    expect(serialised).not.toContain('getByTestId');
    expect(serialised).not.toContain('near-duplicate scan');
  });

  it('audits a de-duplicated scan too, because "already on file" is not "no scan ran"', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    h.audits = [];
    await post(`/suite-health/${PROJECT}/snapshots`);

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.metadata.created).toBe(false);
    expect(h.audits[0]!.targetId).toBe(onlyRow().id);
  });

  it('puts no test source in a log line, on the happy path or any other', async () => {
    await post(`/suite-health/${PROJECT}/snapshots`);
    await get(`/suite-health/${PROJECT}/history`);
    const logged = h.logs.join('\n');
    expect(logged).not.toContain('@playwright/test');
    expect(logged).not.toContain('getByTestId');
  });
});
