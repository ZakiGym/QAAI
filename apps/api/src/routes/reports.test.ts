/**
 * Tests for `GET /runs/:runId/report`, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *  1. EVERY REPORTER IN THE REGISTRY IS REACHABLE, AND THE PROOF IS A LOOP OVER
 *     `REPORTER_NAMES`. This is the durable half of the file. The registry sat
 *     with no caller at all for five reporters; a test that named junit, allure
 *     and sarif by hand would let the sixth one ship unreachable in exactly the
 *     same way. The loop also RECORDS which names it exercised and asserts the
 *     set equals `REPORTER_NAMES`, so a loop that silently iterated nothing
 *     cannot pass. It is the same pattern as the registry parity test in
 *     packages/runner/src/reporters/index.test.ts, one layer out.
 *
 *  2. A QUARANTINED FAILURE IS NEITHER A PASS NOR A PLAIN SKIP. Asserted in two
 *     formats' own vocabulary — JUnit's `<skipped message="QUARANTINED FAILURE
 *     …">` and Allure's `muted` plus the `quarantined` tag — because a mapping
 *     that files it as FAILED turns a dashboard red over a failure nobody can
 *     merge against, and one that files it as a pass is how a team learns in
 *     production that nothing has been tested for a month. The EXPIRED
 *     quarantine is here too: it suppresses nothing, and the only thing between
 *     this route and treating every expired quarantine as still in force is the
 *     `quarantineExpiresAt` column being in the `select`.
 *
 *  3. A MISSING MEASUREMENT IS ABSENT, NEVER ZERO. `TestResult.durationMs` is
 *     `Int @default(0)`, so a test that never executed arrives as a confident
 *     zero. The skipped fixture has `durationMs: 0` and `createdAt: null`, and
 *     the document must carry NO `time=` attribute and NO Allure `start`/`stop`
 *     for it — while the passed fixture must still carry its real `time`, so a
 *     mapping that dropped every duration cannot pass either.
 *
 *  4. CROSS-TENANT IS A 404 AND NEVER A 403. Two doors are proven separately:
 *     the run's own tenancy post-filter, and `projectOr404` on the run's
 *     project.
 *
 *  5. AN UNKNOWN FORMAT IS A 400 THAT NAMES THE VALID FORMATS, from
 *     `REPORTER_NAMES`. A 404 would read as "this run has no report" and an
 *     empty 200 would read as "nothing was found" — both are claims about the
 *     run made out of a caller's typo.
 *
 *  6. A DOCUMENT THIS ROUTE CANNOT SERVE AS BYTES IS A 501, NOT AN EMPTY 200.
 *     Driven through an injected fake registry, because no reporter of the five
 *     renders zero files — which is precisely why that branch is otherwise
 *     unreachable from a test.
 *
 *  7. THE SCOPE CHECK IS THERE. The auth mock is a faithful reimplementation of
 *     middleware/auth.ts rather than a pass-through, so a handler missing
 *     `requireScope` fails here — this repo has shipped routes with no scope
 *     check before.
 *
 * Harness: the same shape as routes/measurements.test.ts — a mocked prisma
 * module with a real AsyncLocalStorage tenant scope, a SELECT-HONOURING
 * in-memory store, and the real router driven over a loopback socket. Nothing
 * here opens a socket to anything but its own server, nothing reaches a real
 * database, and no reporter is reimplemented: the expected bytes come from the
 * registry itself where the shape is not the thing under test.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { QUARANTINE_NOTE, REPORTER_NAMES, resolveReporter } from '@qaai/runner';
import type { ReporterDocument, RunReport } from '@qaai/runner';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  ops: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
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

/*
 * The tenancy scope is real, not stubbed: every query runs in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and the isolation tests below would pass for a
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

/*
 * NOT a pass-through. `requireScope` carries the real semantics from
 * middleware/auth.ts, because against a mock that always calls next() a route
 * whose scope check is simply missing passes every test in the file.
 */
vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  const { forbidden, unauthorized } = await import('../lib/errors.js');

  type Next = (err?: unknown) => void;
  return {
    requireAuth: (req: Row, _res: Row, next: Next) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
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

type ModelName = 'project' | 'environment' | 'test' | 'testResult' | 'run';

/**
 * The SCALAR columns the fake will project. Anything else in a `select` throws
 * rather than being quietly answered with undefined: a fake that shrugged would
 * make a typo in the router's select read as a null the mapping then dropped.
 */
const SCALARS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId', 'name']),
  environment: new Set(['id', 'orgId', 'name']),
  test: new Set([
    'id',
    'orgId',
    'projectId',
    'name',
    'filePath',
    'quarantined',
    'quarantineExpiresAt',
  ]),
  testResult: new Set([
    'id',
    'orgId',
    'runId',
    'testId',
    'status',
    'durationMs',
    'errorMessage',
    'createdAt',
  ]),
  run: new Set([
    'id',
    'orgId',
    'projectId',
    'environmentId',
    'status',
    'commitSha',
    'branch',
    'startedAt',
    'finishedAt',
    'totalCount',
    'passedCount',
    'failedCount',
    'flakyCount',
    'skippedCount',
    'quarantinedFailedCount',
  ]),
};

/**
 * Relations the fake resolves, and how.
 *
 * `fk` is the column holding the OTHER row's id: on the owning row for a
 * to-one, on the CHILD row for a to-many. Declared rather than inferred so a
 * nested select naming a relation this model does not have throws instead of
 * matching everything.
 */
interface Relation {
  to: ModelName;
  kind: 'one' | 'many';
  fk: string;
}

const RELATIONS: Record<ModelName, Record<string, Relation>> = {
  project: {},
  environment: {},
  test: {},
  testResult: { test: { to: 'test', kind: 'one', fk: 'testId' } },
  run: {
    environment: { to: 'environment', kind: 'one', fk: 'environmentId' },
    results: { to: 'testResult', kind: 'many', fk: 'runId' },
  },
};

type Store = Record<ModelName, Row[]>;

let store: Store;

/**
 * `select` is HONOURED, including nested relation selects, and that is not a
 * convenience.
 *
 * A select-blind fake makes deleting a field from a query undetectable: the
 * router would read `test.quarantineExpiresAt` off a row it never asked for,
 * every test here would pass, and production would read `undefined` — which
 * `quarantineSuppresses` honours as "never expires", so every expired
 * quarantine in the install would start suppressing again. Two defects survived
 * a whole slice behind fakes that shrugged at `select`, so unselected keys are
 * ABSENT from the projection here, exactly as Prisma leaves them.
 */
function projectRow(model: ModelName, row: Row, sel: Row | undefined): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    const relation = RELATIONS[model][key];
    if (relation) {
      if (!want || typeof want !== 'object' || !('select' in want)) {
        throw new Error(`fake prisma: ${model}.${key} is a relation and needs a nested select`);
      }
      const nested = (want as Row).select as Row;
      if (relation.kind === 'one') {
        const target = store[relation.to].find((other) => other.id === row[relation.fk]);
        out[key] = target ? projectRow(relation.to, target, nested) : null;
      } else {
        out[key] = store[relation.to]
          .filter((child) => child[relation.fk] === row.id)
          .map((child) => projectRow(relation.to, child, nested));
      }
      continue;
    }
    if (want !== true) throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
    if (!SCALARS[model].has(key)) throw new Error(`fake prisma: no column ${model}.${key}`);
    out[key] = row[key] ?? null;
  }
  return out;
}

/**
 * A Prisma stand-in that enforces tenancy the way lib/prisma.ts does: it
 * POST-FILTERS the unique lookups, which cannot take an extra filter. That
 * post-filter is the only thing between this route and another org's run, so it
 * is modelled rather than assumed.
 */
function makeDb(): Row {
  const model = (name: ModelName): Row => ({
    findUnique: async ({ where, select: sel }: Row) => {
      h.ops.push(`${name}.findUnique`);
      const found = store[name].find((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      );
      if (!found) return null;
      if (found.orgId !== h.currentOrg()) return null;
      return projectRow(name, found, sel);
    },
  });

  const db: Row = {};
  for (const name of Object.keys(SCALARS) as ModelName[]) db[name] = model(name);
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
/** Belongs to another org, so a 404 on its run can only come from tenancy. */
const OTHER_ORG_PROJECT = 'proj_2';

const ENVIRONMENT = 'env_1';
const RUN = 'run_1';
/** Another org's run. */
const OTHER_ORG_RUN = 'run_2';
/** This org's run whose project row is GONE — the `projectOr404` door. */
const ORPHANED_RUN = 'run_3';
/** QUEUED, so the document is partial and has to say so. */
const RUNNING_RUN = 'run_4';

/*
 * Far future and far past so the quarantine fixtures do not need a mocked
 * clock: the route asks `quarantineSuppresses` against the real `new Date()`,
 * which is the shipped path.
 */
const NEVER_EXPIRES = new Date('2099-01-01T00:00:00.000Z');
const LONG_EXPIRED = new Date('2000-01-01T00:00:00.000Z');

const RESULT_AT = new Date('2026-10-20T00:01:00.000Z');

/** The five test names, used by name in the assertions below. */
const PASSED_TEST = 'checkout works';
const FAILED_TEST = 'cart totals C1234';
const QUARANTINED_TEST = 'flaky login C4321';
const EXPIRED_QUARANTINE_TEST = 'expired quarantine C5555';
/** `durationMs: 0` and `createdAt: null` — the "no timing at all" fixture. */
const UNTIMED_SKIP_TEST = 'skipped on purpose';

function seed(): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else' },
    ],
    environment: [
      { id: ENVIRONMENT, orgId: ORG, name: 'staging' },
      { id: 'env_2', orgId: 'org_2', name: 'theirs' },
    ],
    test: [
      {
        id: 't_pass',
        orgId: ORG,
        projectId: PROJECT,
        name: PASSED_TEST,
        filePath: 'e2e/checkout.spec.ts',
        quarantined: false,
        quarantineExpiresAt: null,
      },
      {
        id: 't_fail',
        orgId: ORG,
        projectId: PROJECT,
        name: FAILED_TEST,
        filePath: 'e2e/cart.spec.ts',
        quarantined: false,
        quarantineExpiresAt: null,
      },
      /* Quarantined and NOT expired: its failure is suppressed. */
      {
        id: 't_quar',
        orgId: ORG,
        projectId: PROJECT,
        name: QUARANTINED_TEST,
        filePath: 'e2e/login.spec.ts',
        quarantined: true,
        quarantineExpiresAt: NEVER_EXPIRES,
      },
      /*
       * Quarantined and EXPIRED. It gates again, and the row still says what
       * was suppressed and why — see `quarantineSuppresses` in
       * packages/runner/src/gates.ts. The only thing stopping this from reading
       * as suppressed is `quarantineExpiresAt` being selected.
       */
      {
        id: 't_expired',
        orgId: ORG,
        projectId: PROJECT,
        name: EXPIRED_QUARANTINE_TEST,
        filePath: 'e2e/login.spec.ts',
        quarantined: true,
        quarantineExpiresAt: LONG_EXPIRED,
      },
      {
        id: 't_skip',
        orgId: ORG,
        projectId: PROJECT,
        name: UNTIMED_SKIP_TEST,
        filePath: null,
        quarantined: false,
        quarantineExpiresAt: null,
      },
      { id: 't_other', orgId: 'org_2', projectId: OTHER_ORG_PROJECT, name: 'theirs', filePath: null, quarantined: false, quarantineExpiresAt: null },
    ],
    testResult: [
      {
        id: 'tr_pass',
        orgId: ORG,
        runId: RUN,
        testId: 't_pass',
        status: 'PASSED',
        durationMs: 120,
        errorMessage: null,
        createdAt: RESULT_AT,
      },
      {
        id: 'tr_fail',
        orgId: ORG,
        runId: RUN,
        testId: 't_fail',
        status: 'FAILED',
        durationMs: 420,
        errorMessage: 'expected 2 items in cart, found 1',
        createdAt: RESULT_AT,
      },
      {
        id: 'tr_quar',
        orgId: ORG,
        runId: RUN,
        testId: 't_quar',
        status: 'FAILED',
        durationMs: 90,
        errorMessage: 'login timed out',
        createdAt: RESULT_AT,
      },
      {
        id: 'tr_expired',
        orgId: ORG,
        runId: RUN,
        testId: 't_expired',
        status: 'FAILED',
        durationMs: 50,
        errorMessage: 'still broken',
        createdAt: RESULT_AT,
      },
      /*
       * THE FIXTURE THE TIMING SECTION TURNS ON. `durationMs` is a non-nullable
       * `Int @default(0)`, so a test that never executed arrives as 0, and
       * `createdAt` is null here so no stamp can stand in for the measurement
       * either. Both halves have to be dropped or the document invents a
       * duration nobody measured.
       */
      {
        id: 'tr_skip',
        orgId: ORG,
        runId: RUN,
        testId: 't_skip',
        status: 'SKIPPED',
        durationMs: 0,
        errorMessage: null,
        createdAt: null,
      },
      /* The running run's single recorded result so far. */
      {
        id: 'tr_running',
        orgId: ORG,
        runId: RUNNING_RUN,
        testId: 't_pass',
        status: 'PASSED',
        durationMs: 77,
        errorMessage: null,
        createdAt: RESULT_AT,
      },
      {
        id: 'tr_other',
        orgId: 'org_2',
        runId: OTHER_ORG_RUN,
        testId: 't_other',
        status: 'FAILED',
        durationMs: 1,
        errorMessage: 'another org entirely',
        createdAt: RESULT_AT,
      },
    ],
    run: [
      {
        id: RUN,
        orgId: ORG,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        status: 'FAILED',
        commitSha: 'abc123def456',
        branch: 'main',
        startedAt: new Date('2026-10-20T00:00:00.000Z'),
        finishedAt: new Date('2026-10-20T00:05:00.000Z'),
        totalCount: 5,
        passedCount: 1,
        failedCount: 2,
        flakyCount: 0,
        skippedCount: 1,
        quarantinedFailedCount: 1,
      },
      {
        id: OTHER_ORG_RUN,
        orgId: 'org_2',
        projectId: OTHER_ORG_PROJECT,
        environmentId: 'env_2',
        status: 'FAILED',
        commitSha: null,
        branch: null,
        startedAt: null,
        finishedAt: null,
        totalCount: 1,
        passedCount: 0,
        failedCount: 1,
        flakyCount: 0,
        skippedCount: 0,
        quarantinedFailedCount: 0,
      },
      /* Our org, and `projectId` points at nothing. */
      {
        id: ORPHANED_RUN,
        orgId: ORG,
        projectId: 'proj_gone',
        environmentId: ENVIRONMENT,
        status: 'PASSED',
        commitSha: null,
        branch: null,
        startedAt: null,
        finishedAt: null,
        totalCount: 0,
        passedCount: 0,
        failedCount: 0,
        flakyCount: 0,
        skippedCount: 0,
        quarantinedFailedCount: 0,
      },
      {
        id: RUNNING_RUN,
        orgId: ORG,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        status: 'RUNNING',
        commitSha: null,
        branch: null,
        startedAt: new Date('2026-10-20T01:00:00.000Z'),
        finishedAt: null,
        totalCount: 5,
        passedCount: 1,
        failedCount: 0,
        flakyCount: 0,
        skippedCount: 0,
        quarantinedFailedCount: 0,
      },
    ],
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { reportsRouter, reportHandler, runReportFrom } = await import('./reports.js');
const { requireAuth } = await import('../middleware/auth.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
/* Prefix-mounted exactly as index.ts must mount it: the router declares bare paths. */
app.use('/runs', reportsRouter);
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * A second app for the fake-registry cases.
 *
 * `requireAuth` is the mocked one, so the tenant scope is established exactly
 * as it is on the real router — without it every query would run unscoped and
 * these tests would 404 for a reason that has nothing to do with the registry.
 */
let fakeRegistry: import('./reports.js').ReportRegistry;
const fakeApp = express();
fakeApp.get('/runs/:runId/report', requireAuth as never, (req, res, next) => {
  void reportHandler(fakeRegistry)(req, res).catch(next);
});
fakeApp.use(notFoundHandler);
fakeApp.use(errorHandler);

let baseUrl = '';
let fakeUrl = '';
let server: import('node:http').Server;
let fakeServer: import('node:http').Server;

beforeAll(async () => {
  server = app.listen(0);
  fakeServer = fakeApp.listen(0);
  await Promise.all([
    new Promise<void>((resolve) => server.once('listening', resolve)),
    new Promise<void>((resolve) => fakeServer.once('listening', resolve)),
  ]);
  baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  fakeUrl = `http://127.0.0.1:${(fakeServer.address() as import('node:net').AddressInfo).port}`;
});

afterAll(
  async () =>
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => fakeServer.close(() => resolve())),
    ]),
);

interface Raw {
  status: number;
  headers: Headers;
  bytes: Buffer;
  text: string;
}

async function raw(path: string, from = baseUrl): Promise<Raw> {
  const res = await fetch(`${from}${path}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString('utf8') };
}

async function json(path: string, from = baseUrl): Promise<{ status: number; body: Row }> {
  const res = await raw(path, from);
  return { status: res.status, body: res.text ? (JSON.parse(res.text) as Row) : {} };
}

/** The media type without the charset express appends to a text body. */
function mediaType(res: Raw): string {
  return (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
}

function asActor(overrides: Partial<Hoisted['actor']> = {}): void {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null, ...overrides };
}

/** A registry whose render is whatever the test needs it to be. */
function registryReturning(
  document: ReporterDocument | null,
  descriptor: { directory: boolean; name?: string } = { directory: false },
): import('./reports.js').ReportRegistry {
  const name = descriptor.name ?? 'fake';
  return {
    names: [name],
    resolve: (asked) =>
      asked === name
        ? { name, description: 'a reporter made for this test', defaultOut: 'fake.out', directory: descriptor.directory }
        : null,
    render: () => document,
  };
}

beforeEach(() => {
  store = seed();
  h.prisma = makeDb();
  h.ops = [];
  asActor();
  fakeRegistry = registryReturning({ files: [], warnings: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Every reporter in the registry is reachable ─────────────────────────────

describe('GET /runs/:runId/report — registry reachability', () => {
  /*
   * THE DURABLE HALF. A loop over the constant, not a list of names: the
   * registry had no caller at all for five reporters, and a hand-written list
   * would let the sixth ship unreachable the same way.
   */
  it('serves every name in REPORTER_NAMES', async () => {
    const exercised: string[] = [];

    for (const name of REPORTER_NAMES) {
      const reporter = resolveReporter(name);
      expect(reporter, `${name} must resolve in the registry`).not.toBeNull();

      const res = await raw(`/runs/${RUN}/report?format=${encodeURIComponent(name)}`);
      expect(res.status, `${name} must be served, got ${res.status}: ${res.text.slice(0, 300)}`).toBe(200);
      expect(res.bytes.byteLength, `${name} served an empty body`).toBeGreaterThan(0);
      expect(res.headers.get('x-qaai-report-format')).toBe(name);
      expect(res.headers.get('x-qaai-report-kind')).toBe(
        reporter!.directory ? 'directory-zip' : 'file',
      );
      /*
       * A directory is one body only as an archive; a file is served AS ITSELF,
       * with the content type the reporter put on it. The expected value for
       * the file case comes from the manifest rather than from a hand-written
       * table, so a sixth reporter with a new media type needs no edit here —
       * and the two halves of the route have to agree about the same document.
       */
      const { body: manifest } = await json(
        `/runs/${RUN}/report?format=${encodeURIComponent(name)}&meta=1`,
      );
      expect(mediaType(res), `${name} served the wrong media type`).toBe(
        reporter!.directory ? 'application/zip' : manifest.files[0].contentType,
      );
      expect(mediaType(res)).not.toBe('');
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="${reporter!.defaultOut}${reporter!.directory ? '.zip' : ''}"`,
      );
      exercised.push(name);
    }

    /* A loop that iterated nothing must not pass. */
    expect([...exercised].sort()).toEqual([...REPORTER_NAMES].sort());
    expect(exercised.length).toBeGreaterThan(0);
  });

  it('offers the registry list on every success, so a new reporter needs no second edit', async () => {
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    expect(res.headers.get('x-qaai-report-formats')).toBe([...REPORTER_NAMES].join(', '));
  });

  it('names a directory reporter from the descriptor, not from its name', async () => {
    /* allure's output is a tree; the body is a real zip a zip reader can open. */
    const res = await raw(`/runs/${RUN}/report?format=allure`);
    expect(res.status).toBe(200);
    expect(mediaType(res)).toBe('application/zip');
    expect(res.headers.get('content-length')).toBe(String(res.bytes.byteLength));

    const zip = await JSZip.loadAsync(res.bytes);
    const paths = Object.keys(zip.files).sort();
    expect(paths).toContain('environment.properties');
    expect(paths.filter((p) => p.endsWith('-result.json'))).toHaveLength(5);
  });

  it('produces byte-identical archives for an unchanged run', async () => {
    /* lib/zip.ts stamps a fixed date on every entry; two downloads must diff clean. */
    const first = await raw(`/runs/${RUN}/report?format=allure`);
    const second = await raw(`/runs/${RUN}/report?format=allure`);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });
});

// ─── An unknown format is a 400 that names the valid formats ─────────────────

describe('format validation', () => {
  it('400s an unknown format and names every valid one', async () => {
    const { status, body } = await json(`/runs/${RUN}/report?format=junitt`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    for (const name of REPORTER_NAMES) expect(body.error.message).toContain(name);
    expect(body.error.details.formats).toEqual([...REPORTER_NAMES]);
    expect(body.error.details.requested).toBe('junitt');
  });

  it('400s a missing format rather than guessing which document a build will parse', async () => {
    const { status, body } = await json(`/runs/${RUN}/report`);
    expect(status).toBe(400);
    expect(body.error.details.formats).toEqual([...REPORTER_NAMES]);
  });

  it('accepts whitespace and case, because the registry resolves that way', async () => {
    const res = await raw(`/runs/${RUN}/report?format=${encodeURIComponent('  JUnit ')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-qaai-report-format')).toBe('junit');
  });

  it('400s a repeated format key instead of silently taking one', async () => {
    const { status } = await json(`/runs/${RUN}/report?format=junit&format=sarif`);
    expect(status).toBe(400);
  });

  it('400s a meta value that is neither true nor false', async () => {
    const { status, body } = await json(`/runs/${RUN}/report?format=junit&meta=maybe`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('meta');
  });

  it('400s a testRailRunId that is not a positive integer', async () => {
    const { status, body } = await json(`/runs/${RUN}/report?format=testrail&testRailRunId=0`);
    expect(status).toBe(400);
    expect(body.error.message).toContain('testRailRunId');
  });
});

// ─── A quarantined failure is neither a pass nor a plain skip ────────────────

describe('a quarantined failure', () => {
  it('renders as JUnit <skipped> carrying QUARANTINE_NOTE, never as <failure>', async () => {
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    expect(res.status).toBe(200);

    const line = res.text.split('\n').find((l) => l.includes(QUARANTINED_TEST));
    expect(line, 'the quarantined test must be in the document at all').toBeDefined();
    /*
     * Both halves matter. `<skipped message=…>` is the only element JUnit has
     * that means "do not fail the build on this"; the MESSAGE is what stops it
     * being indistinguishable from a deliberate skip.
     */
    expect(line).toContain('<skipped message="');
    expect(line).not.toContain('<failure');
    expect(line).toContain(QUARANTINE_NOTE);
    /* Verbatim — the note is transcribed from the shipped junit.xml route. */
    expect(line).toContain(`${QUARANTINE_NOTE} login timed out`);
  });

  it('renders as Allure muted with a findable tag, and status failed rather than skipped', async () => {
    const res = await raw(`/runs/${RUN}/report?format=allure`);
    const zip = await JSZip.loadAsync(res.bytes);

    const results: Row[] = [];
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!path.endsWith('-result.json')) continue;
      results.push(JSON.parse(await entry.async('string')) as Row);
    }
    const quarantined = results.find((r) => r.name === QUARANTINED_TEST);
    expect(quarantined, 'the quarantined test must be in the pack').toBeDefined();

    expect(quarantined!.statusDetails?.muted).toBe(true);
    expect(String(quarantined!.statusDetails?.message)).toContain(QUARANTINE_NOTE);
    /* Not `skipped`: a suppression is not a decision nobody wanted the answer. */
    expect(quarantined!.status).toBe('failed');
    expect(quarantined!.labels).toEqual(
      expect.arrayContaining([{ name: 'tag', value: 'quarantined' }]),
    );
  });

  it('counts the suppression at run level from the run\'s own column', async () => {
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    expect(res.text).toContain('<property name="qaai.quarantinedFailures" value="1"/>');
    expect(res.text).toContain(
      '<property name="qaai.quarantinedFailuresInThisDocument" value="1"/>',
    );
  });

  it('does NOT suppress an EXPIRED quarantine — it gates again', async () => {
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    const line = res.text.split('\n').find((l) => l.includes(EXPIRED_QUARANTINE_TEST));
    expect(line).toBeDefined();
    expect(line).toContain('<failure message="still broken"/>');
    expect(line).not.toContain(QUARANTINE_NOTE);
  });

  it('leaves a quarantined test that PASSED as a pass', () => {
    /*
     * At the mapping, because no fixture result can be both passed and failed.
     * Rewriting a pass would stamp "QUARANTINED FAILURE" on a test that did not
     * fail — the same lie pointing the other way.
     */
    const report = runReportFrom({
      id: RUN,
      status: 'PASSED',
      commitSha: null,
      branch: null,
      startedAt: null,
      finishedAt: null,
      totalCount: 2,
      passedCount: 1,
      failedCount: 0,
      flakyCount: 0,
      skippedCount: 1,
      quarantinedFailedCount: 0,
      environment: null,
      results: [
        {
          status: 'PASSED',
          durationMs: 10,
          errorMessage: null,
          createdAt: null,
          test: { id: 'a', name: 'a', filePath: null, quarantined: true, quarantineExpiresAt: null },
        },
        {
          status: 'SKIPPED',
          durationMs: 0,
          errorMessage: null,
          createdAt: null,
          test: { id: 'b', name: 'b', filePath: null, quarantined: true, quarantineExpiresAt: null },
        },
      ],
    });
    expect(report.tests.map((t) => t.status)).toEqual(['passed', 'skipped']);
  });

  it('treats a status this build has never heard of as a failure, never a pass', () => {
    const report = runReportFrom({
      id: RUN,
      status: 'FAILED',
      commitSha: null,
      branch: null,
      startedAt: null,
      finishedAt: null,
      totalCount: 1,
      passedCount: 0,
      failedCount: 1,
      flakyCount: 0,
      skippedCount: 0,
      quarantinedFailedCount: 0,
      environment: null,
      results: [
        {
          status: 'SOMETHING_NEW',
          durationMs: 5,
          errorMessage: null,
          createdAt: null,
          test: { id: 'a', name: 'a', filePath: null, quarantined: false, quarantineExpiresAt: null },
        },
      ],
    });
    expect(report.tests[0]!.status).toBe('failed');
  });
});

// ─── A missing measurement is absent, never zero ─────────────────────────────

describe('timing', () => {
  it('writes NO time attribute for a result the run never timed', async () => {
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    const line = res.text.split('\n').find((l) => l.includes(UNTIMED_SKIP_TEST));
    expect(line).toBeDefined();
    /* The exact bytes: a skip with no timing, and no fabricated 0.000 anywhere. */
    expect(line!.trim()).toBe(`<testcase name="${UNTIMED_SKIP_TEST}"><skipped/></testcase>`);
    expect(line).not.toContain('time=');
    expect(res.text).not.toContain('time="0.000"');
  });

  it('still carries the timing the run DID record', async () => {
    /* So a mapping that dropped every duration cannot pass the test above. */
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    const line = res.text.split('\n').find((l) => l.includes(PASSED_TEST));
    expect(line).toContain('time="0.120"');
  });

  it('writes no Allure start or stop for a result with no timing and no stamp', async () => {
    const res = await raw(`/runs/${RUN}/report?format=allure`);
    const zip = await JSZip.loadAsync(res.bytes);

    let untimed: Row | undefined;
    let timed: Row | undefined;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!path.endsWith('-result.json')) continue;
      const result = JSON.parse(await entry.async('string')) as Row;
      if (result.name === UNTIMED_SKIP_TEST) untimed = result;
      if (result.name === PASSED_TEST) timed = result;
    }

    expect(untimed).toBeDefined();
    /* ABSENT keys, not zeroes: `0` would be 1 January 1970 on every dashboard. */
    expect('start' in untimed!).toBe(false);
    expect('stop' in untimed!).toBe(false);

    /* And the measured one keeps both, derived from createdAt and the duration. */
    expect(timed!.stop).toBe(RESULT_AT.getTime());
    expect(timed!.start).toBe(RESULT_AT.getTime() - 120);
  });

  it('reports the untimed result as a warning rather than a silent omission', async () => {
    const { body } = await json(`/runs/${RUN}/report?format=junit&meta=1`);
    expect(body.warnings.join('\n')).toContain('carry no timing');
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    expect(res.headers.get('x-qaai-report-warnings')).toBe('1');
  });
});

// ─── Cross-tenant is a 404, through both doors ───────────────────────────────

describe('tenancy', () => {
  it('404s another org\'s run and never 403s it', async () => {
    const { status, body } = await json(`/runs/${OTHER_ORG_RUN}/report?format=junit`);
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Run not found');
  });

  it('404s another org\'s run on the manifest path too', async () => {
    const { status } = await json(`/runs/${OTHER_ORG_RUN}/report?format=junit&meta=1`);
    expect(status).toBe(404);
  });

  it('404s through projectOr404 when the run\'s project is gone', async () => {
    /*
     * The second door, proven separately: the run itself reads fine for this
     * org, so a 404 here can only come from the project check — which is what
     * stops a document being attributed to nothing.
     */
    const { status, body } = await json(`/runs/${ORPHANED_RUN}/report?format=junit`);
    expect(status).toBe(404);
    expect(body.error.message).toBe('Project not found');
    expect(h.ops).toContain('project.findUnique');
  });

  it('404s a run that does not exist at all, indistinguishably', async () => {
    const { status, body } = await json('/runs/run_nope/report?format=junit');
    expect(status).toBe(404);
    expect(body.error.message).toBe('Run not found');
  });
});

// ─── The scope check is there ────────────────────────────────────────────────

describe('auth', () => {
  it('403s a key without runs:read and names the scope', async () => {
    asActor({ scopes: ['tests:read'] });
    const { status, body } = await json(`/runs/${RUN}/report?format=junit`);
    expect(status).toBe(403);
    expect(body.error.message).toContain('runs:read');
  });

  it('serves a key that has exactly runs:read', async () => {
    asActor({ scopes: ['runs:read'] });
    const { status } = await raw(`/runs/${RUN}/report?format=junit`);
    expect(status).toBe(200);
  });

  it('403s rather than 401s, which is only possible because requireAuth ran first', async () => {
    /*
     * The ordering, said as a test: `requireScope` answers 401 when there is no
     * actor at all. A 403 naming the scope therefore proves `requireAuth`
     * executed on this route — which matters because the router deliberately
     * has no router-level `requireAuth`; see the test below.
     */
    asActor({ scopes: ['nothing:useful'] });
    const { status } = await json(`/runs/${RUN}/report?format=junit`);
    expect(status).toBe(403);
  });

  it('runs NO middleware for a path it does not declare', async () => {
    /*
     * `/runs` already has `runsRouter`, which does `runsRouter.use(requireAuth)`.
     * Two routers on one prefix means whatever this one does not match falls
     * through it — so a router-level `requireAuth` HERE would authenticate
     * every other `/runs/...` request a second time, on the busiest prefix in
     * the API. The sentinel sees no `req.actor`, which is the proof: adding
     * `reportsRouter.use(requireAuth)` back makes this go red.
     */
    const sentinelApp = express();
    sentinelApp.use('/runs', reportsRouter);
    sentinelApp.get('/runs/:runId/something-else', (req, res) => {
      res.json({ reached: true, actor: (req as Row).actor ?? null });
    });
    sentinelApp.use(notFoundHandler);
    sentinelApp.use(errorHandler);

    const sentinel = sentinelApp.listen(0);
    await new Promise<void>((resolve) => sentinel.once('listening', resolve));
    const at = `http://127.0.0.1:${(sentinel.address() as import('node:net').AddressInfo).port}`;
    try {
      const { status, body } = await json(`/runs/${RUN}/something-else`, at);
      expect(status).toBe(200);
      expect(body).toEqual({ reached: true, actor: null });
    } finally {
      await new Promise<void>((resolve) => sentinel.close(() => resolve()));
    }
  });
});

// ─── The manifest ────────────────────────────────────────────────────────────

describe('&meta=1 — the manifest', () => {
  it('describes a single-file document and measures its real byte length', async () => {
    const { status, body } = await json(`/runs/${RUN}/report?format=junit&meta=1`);
    expect(status).toBe(200);
    expect(body.format).toBe('junit');
    expect(body.kind).toBe('file');
    expect(body.bodyFilename).toBe('junit.xml');
    expect(body.bodyContentType).toBe('application/xml');
    expect(body.files).toHaveLength(1);
    expect(body.formats).toEqual([...REPORTER_NAMES]);

    /* `bytes` is the size of the download, not the string length. */
    const bytes = await raw(`/runs/${RUN}/report?format=junit`);
    expect(body.files[0].bytes).toBe(bytes.bytes.byteLength);
  });

  it('lists every file of a directory document', async () => {
    const { body } = await json(`/runs/${RUN}/report?format=allure&meta=1`);
    expect(body.kind).toBe('directory');
    expect(body.bodyFilename).toBe('allure-results.zip');
    expect(body.bodyContentType).toBe('application/zip');
    expect(body.files.map((f: Row) => f.path)).toContain('environment.properties');
    expect(body.files.length).toBe(7);
  });

  it('says the run is complete only when the run is actually over', async () => {
    const finished = await json(`/runs/${RUN}/report?format=junit&meta=1`);
    expect(finished.body.run).toEqual({ id: RUN, status: 'FAILED', complete: true });

    const running = await json(`/runs/${RUNNING_RUN}/report?format=junit&meta=1`);
    expect(running.body.run).toEqual({ id: RUNNING_RUN, status: 'RUNNING', complete: false });

    const bytes = await raw(`/runs/${RUNNING_RUN}/report?format=junit`);
    expect(bytes.headers.get('x-qaai-report-run-complete')).toBe('false');
  });

  it('reports no upload for testrail without a run id, and says why in a warning', async () => {
    const { body } = await json(`/runs/${RUN}/report?format=testrail&meta=1`);
    expect(body.upload).toBeNull();
    expect(body.warnings.join('\n')).toContain('No TestRail run id');
  });

  it('discloses the testrail upload as NOT PERFORMED when a run id is given', async () => {
    const { body } = await json(`/runs/${RUN}/report?format=testrail&testRailRunId=77&meta=1`);
    expect(body.upload.service).toBe('testrail');
    expect(body.upload.method).toBe('POST');
    expect(body.upload.path).toContain('77');
    /* The one field that stops "we described a request" reading as "we sent it". */
    expect(body.upload.performed).toBe(false);
    expect(body.upload.note).toContain('performs no upload');

    const bytes = await raw(`/runs/${RUN}/report?format=testrail&testRailRunId=77`);
    expect(bytes.headers.get('x-qaai-report-upload-performed')).toBe('false');
    /* And the payload itself is still served — the format renders a real file. */
    expect(mediaType(bytes)).toBe('application/json');
    expect(JSON.parse(bytes.text).results.length).toBeGreaterThan(0);
  });
});

// ─── A document that cannot be served as bytes is a 501 ──────────────────────

describe('a document this route cannot serve', () => {
  it('501s a reporter that rendered no file at all, rather than an empty 200', async () => {
    fakeRegistry = registryReturning({
      files: [],
      warnings: ['nothing was supplied, so nothing was rendered'],
    });
    const { status, body } = await json('/runs/run_1/report?format=fake', fakeUrl);
    expect(status).toBe(501);
    expect(body.error.code).toBe('REPORT_DOCUMENT_UNSERVABLE');
    expect(body.error.message).toContain('rendered no file');
    expect(body.error.details).toEqual({ format: 'fake', files: 0, directory: false });
  });

  it('501s an empty directory document too', async () => {
    fakeRegistry = registryReturning({ files: [], warnings: [] }, { directory: true });
    const { status, body } = await json('/runs/run_1/report?format=fake', fakeUrl);
    expect(status).toBe(501);
    /* An empty zip is as much a claim of "no findings" as an empty .sarif. */
    expect(body.error.details.directory).toBe(true);
  });

  it('501s a single-file reporter that rendered several files, instead of dropping some', async () => {
    fakeRegistry = registryReturning({
      files: [
        { path: 'a.json', contents: '{"a":1}', contentType: 'application/json' },
        { path: 'b.json', contents: '{"b":2}', contentType: 'application/json' },
      ],
      warnings: [],
    });
    const { status, body } = await json('/runs/run_1/report?format=fake', fakeUrl);
    expect(status).toBe(501);
    expect(body.error.message).toContain('rendered 2 files');
    expect(body.error.details.files).toBe(2);
  });

  it('501s a name the registry lists and then renders nothing for', async () => {
    fakeRegistry = registryReturning(null);
    const { status, body } = await json('/runs/run_1/report?format=fake', fakeUrl);
    expect(status).toBe(501);
    expect(body.error.code).toBe('REPORT_DOCUMENT_UNSERVABLE');
  });

  it('answers the MANIFEST for an unservable document, with the reason named', async () => {
    /*
     * The manifest is not a document and cannot be mistaken for one, so
     * `files: []` beside the warnings is the honest answer where a 200 body
     * would have been a lie.
     */
    fakeRegistry = registryReturning({
      files: [],
      warnings: ['no coverage snapshot was supplied'],
    });
    const { status, body } = await json('/runs/run_1/report?format=fake&meta=1', fakeUrl);
    expect(status).toBe(200);
    expect(body.files).toEqual([]);
    expect(body.warnings).toEqual(['no coverage snapshot was supplied']);
    expect(body.unservableAsBody.code).toBe('REPORT_DOCUMENT_UNSERVABLE');
    expect(body.unservableAsBody.reason).toContain('rendered no file');
    expect(body.bodyContentType).toBeNull();
  });

  it('serves the ordinary single-file case through the same seam', async () => {
    /* So the 501s above are the refusals and not the whole behaviour. */
    fakeRegistry = registryReturning({
      files: [{ path: 'fake.out', contents: 'hello', contentType: 'text/plain' }],
      warnings: [],
    });
    const res = await raw('/runs/run_1/report?format=fake', fakeUrl);
    expect(res.status).toBe(200);
    expect(res.text).toBe('hello');
    expect(mediaType(res)).toBe('text/plain');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="fake.out"');
  });
});

// ─── Headers the document itself cannot carry ────────────────────────────────

describe('response headers', () => {
  it('sets the per-format disclosures and refuses to be cached or sniffed', async () => {
    const res = await raw(`/runs/${RUN}/report?format=sarif`);
    expect(res.status).toBe(200);
    expect(mediaType(res)).toBe('application/sarif+json');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="qaai.sarif"');
    expect(res.headers.get('x-qaai-report-files')).toBe('1');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('carries the run id and the configured app link into the document', async () => {
    /*
     * Allure's one link. `WEB_PUBLIC_URL` is this deployment's own configured
     * web address, so the link is real rather than guessed from the API's.
     */
    const res = await raw(`/runs/${RUN}/report?format=allure`);
    const zip = await JSZip.loadAsync(res.bytes);
    const properties = await zip.file('environment.properties')!.async('string');
    expect(properties).toContain(`qaai.run=${RUN}`);
    expect(properties).toContain('environment=staging');
    expect(properties).toContain('branch=main');

    const first = Object.keys(zip.files).find((p) => p.endsWith('-result.json'))!;
    const result = JSON.parse(await zip.file(first)!.async('string')) as Row;
    expect(result.links).toEqual([
      { name: 'Run in QAAI', url: `https://app.qaai.test/runs/${RUN}`, type: 'custom' },
    ]);
  });

  it('keeps the JUnit suite name that every customer CI already parses', async () => {
    /*
     * A BYTES CONTRACT, not a cosmetic default. `GET /runs/:runId/junit.xml`
     * has always written `name="qaai"`; setting `report.name` from the project
     * or the environment would change bytes somebody else's build reads.
     */
    const res = await raw(`/runs/${RUN}/report?format=junit`);
    expect(res.text).toContain('<testsuite name="qaai" tests="5" failures="2" skipped="1">');
  });
});

// ─── The mapping's own totals ────────────────────────────────────────────────

describe('runReportFrom', () => {
  const row = (overrides: Partial<Parameters<typeof runReportFrom>[0]> = {}) => ({
    id: RUN,
    status: 'FAILED',
    commitSha: 'abc',
    branch: 'main',
    startedAt: new Date('2026-10-20T00:00:00.000Z'),
    finishedAt: new Date('2026-10-20T00:05:00.000Z'),
    totalCount: 5,
    passedCount: 1,
    failedCount: 2,
    flakyCount: 0,
    skippedCount: 1,
    quarantinedFailedCount: 1,
    environment: { name: 'staging' },
    results: [],
    ...overrides,
  });

  it('carries the run\'s OWN counters, which are the truth for a sharded run', () => {
    const report = runReportFrom(row());
    expect(report.totals).toEqual({
      tests: 5,
      passed: 1,
      failed: 2,
      skipped: 1,
      flaky: 0,
      quarantinedFailed: 1,
    });
  });

  it('never sets a suite name, so suiteNameOf keeps answering qaai', () => {
    const report: RunReport = runReportFrom(row());
    expect(report.name).toBeUndefined();
  });

  it('omits what the run does not have rather than defaulting it', () => {
    const report = runReportFrom(
      row({ commitSha: null, branch: null, startedAt: null, finishedAt: null, environment: null }),
    );
    expect('commitSha' in report).toBe(false);
    expect('branch' in report).toBe(false);
    expect('startedAt' in report).toBe(false);
    expect('finishedAt' in report).toBe(false);
    expect('environment' in report).toBe(false);
    expect('url' in report).toBe(false);
  });

  it('survives a result whose test row has gone, without inventing a name', () => {
    const report = runReportFrom(
      row({
        results: [
          { status: 'FAILED', durationMs: 7, errorMessage: 'boom', createdAt: null, test: null },
        ],
      }),
    );
    expect(report.tests[0]!.name).toBe('(unnamed test)');
    expect(report.tests[0]!.status).toBe('failed');
  });

  it('drops a duration that is not a real measurement', () => {
    const report = runReportFrom(
      row({
        results: [
          {
            status: 'FAILED',
            durationMs: -1,
            errorMessage: null,
            createdAt: null,
            test: { id: 'a', name: 'a', filePath: null, quarantined: false, quarantineExpiresAt: null },
          },
        ],
      }),
    );
    expect('durationMs' in report.tests[0]!).toBe(false);
  });
});
