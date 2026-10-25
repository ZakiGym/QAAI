/**
 * Tests for the filing endpoints — "a failure reaches the person who can fix
 * it, once".
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. ONE TICKET PER CAUSE. This endpoint used to take a single `resultId`, so
 *      a broken shared dependency — one bug, forty failing tests — became forty
 *      tickets. Three fixtures below share a failure signature, and the
 *      assertions are on the COUNT OF PROVIDER CALLS, not on the response: a
 *      regression here is a customer's board filling up, and the only thing
 *      that notices it is a test that counts POSTs.
 *
 *   2. RE-FILING IS IDEMPOTENT, AND ACROSS RUNS. The guard is `TrackerIssue`'s
 *      cause key, not a flag on one row, so pressing the button for a second
 *      member of the same cause — or for the same cause breaking again in a
 *      later run — links to the ticket that already exists. A second occurrence
 *      of the forty-ticket morning is unforgivable, so this is tested from both
 *      directions.
 *
 *   3. THE ASSIGNMENT IS WRITTEN, AND AN UNOWNED FAILURE SAYS SO. Ownership
 *      resolved in two read paths before this and was never recorded anywhere.
 *      Every assertion about an owner is made on the STORED verdict row, and the
 *      unowned cases assert the STATE (`NO_MATCH`, `RULES_UNUSABLE`), because an
 *      unowned failure that looks owned is worse than one that is visibly
 *      unowned — nobody goes looking for the first kind.
 *
 *   4. A SPLIT CAUSE NAMES NOBODY. One cause owned by two teams has no true
 *      assignee; naming one of the two is how a ticket gets closed with half
 *      the problem fixed.
 *
 *   5. A COVERAGE TICKET CARRIES THE NAMES. "Coverage is 61%" is not a piece of
 *      work. The body must contain the surface labels and the files they are
 *      declared in, and the test asserts on the body text rather than on a
 *      count, because the named list IS the feature.
 *
 *   6. A FAILED PROVIDER CALL LEAVES NOTHING BEHIND. No TrackerIssue row, no
 *      link on a verdict. A recorded ticket that does not exist is worse than
 *      no ticket: the next press would find it and link to nothing.
 *
 * Harness: same shape as routes/surface.test.ts — a mocked prisma module with a
 * real AsyncLocalStorage tenant scope, and the real router over a loopback
 * socket. lib/issues.ts is only PARTIALLY mocked: `buildIssue`,
 * `parseIssueConfig` and the host validation are the real ones (so a config
 * that should be refused still is), and only `createIssue` — the one function
 * that would reach GitHub — is replaced.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
  /** Every issue handed to the provider. Length is the ticket count. */
  filed: Array<{ title: string; body: string }>;
  /**
   * Every EDIT handed to the provider. Separate from `filed` on purpose: a
   * rewrite that was counted as a filing would hide the forty-ticket defect
   * behind the fix for it.
   */
  edited: Array<{ key: string; title?: string; body?: string }>;
  /** Set to make the next provider call fail the way a provider does. */
  providerFails: null | { message: string; kind: 'CONFIG' | 'PROVIDER' };
  /** Set to make the next EDIT fail — a deleted ticket, a read-only token. */
  editFails: null | { message: string; kind: 'CONFIG' | 'PROVIDER' };
  /** What `attributedCoverage` returns. See the partial mock below. */
  coverage: Row | null;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  audits: [],
  filed: [],
  edited: [],
  providerFails: null,
  editFails: null,
  coverage: null,
}));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    API_PUBLIC_URL: 'https://api.qaai.test',
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

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

/** The vault. The route must never see a token it did not ask the vault for. */
vi.mock('../lib/integrations.js', () => ({
  openToken: (enc: string) => {
    if (enc !== 'sealed') throw new Error('wrong key version');
    return 'ghp_atokenthatmustneverbelogged';
  },
}));

/*
 * PARTIAL, on purpose. `buildIssue` composes the evidence this ticket is judged
 * on and `parseIssueConfig` carries the host refusals that keep a customer's
 * PAT on api.github.com — stubbing either would prove the router can file
 * something rather than the right thing, at the right place. Only the network
 * call is replaced.
 */
vi.mock('../lib/issues.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { IssueFilingError } = actual as { IssueFilingError: new (m: string, k?: string) => Error };
  return {
    ...actual,
    createIssue: async (
      _config: unknown,
      _token: string,
      issue: { title: string; body: string },
    ) => {
      if (h.providerFails) {
        throw new IssueFilingError(h.providerFails.message, h.providerFails.kind);
      }
      h.filed.push(issue);
      return {
        provider: 'GITHUB',
        url: `https://github.com/acme/storefront/issues/${h.filed.length}`,
        key: `acme/storefront#${h.filed.length}`,
      };
    },
    /*
     * The edit call, stubbed for the same reason `createIssue` is: it is the
     * one function that would reach api.github.com. Its own refusals — the
     * pinned host, the 3xx ban, the key parsing — are the real ones and belong
     * to lib/issues.ts; what this file proves is WHEN the route calls it and
     * what the response says afterwards.
     */
    updateIssue: async (
      _config: unknown,
      _token: string,
      key: string,
      patch: { title?: string; body?: string },
    ) => {
      if (h.editFails) {
        throw new IssueFilingError(h.editFails.message, h.editFails.kind);
      }
      h.edited.push({ key, ...patch });
    },
  };
});

/*
 * `attributedCoverage` is the surface router's, and it is exercised against the
 * real inventory in routes/surface.test.ts. Here the question is what the
 * TICKET says and whether it is filed once, so the attribution is supplied
 * directly. `loadOwnerDirectory` stays real — the owner names in the body come
 * out of the same two queries the dashboard makes.
 */
vi.mock('./surface.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    attributedCoverage: async () => {
      if (!h.coverage) throw new Error('test did not seed a coverage fixture');
      return h.coverage;
    },
  };
});

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
      if (!req.actor) return next(unauthorized());
      const rank = ROLE_RANK as Record<string, number>;
      if ((rank[req.actor.role] ?? -1) < (rank[minimum] ?? 0)) {
        return next(forbidden(`This action requires the ${minimum} role or higher`));
      }
      next();
    },
    requireScope: () => (_req: Row, _res: Row, next: Next) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

type ModelName =
  | 'project'
  | 'integration'
  | 'test'
  | 'testResult'
  | 'triageVerdict'
  | 'trackerIssue'
  | 'ownershipRule'
  | 'failureSignature'
  | 'user'
  | 'team';

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored — a fake that shrugged at `causeKey` would pass
 * every idempotence test in this file with no idempotence in the route.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  integration: new Set(['id', 'orgId', 'projectId', 'kind', 'enabled']),
  test: new Set(['id', 'orgId', 'projectId']),
  testResult: new Set(['id', 'orgId', 'runId', 'status']),
  triageVerdict: new Set(['id', 'orgId', 'testResultId', 'runId', 'clusterKey']),
  failureSignature: new Set(['id', 'orgId', 'projectId', 'clusterKey']),
  trackerIssue: new Set(['id', 'orgId', 'projectId', 'causeKey', 'subject']),
  ownershipRule: new Set(['id', 'orgId', 'projectId']),
  user: new Set(['id', 'email']),
  team: new Set(['id', 'orgId', 'slug']),
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>(['user']);

type Store = Record<ModelName, Row[]>;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (typeof cond === 'object' && cond !== null) {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: ModelName, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') {
      return (cond as Row[]).some((branch) => matchesWhere(model, row, branch));
    }
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

function projectRow(model: ModelName, row: Row, sel: Row | undefined, store: Store): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want === true) {
      out[key] = row[key] ?? null;
      continue;
    }
    // `run` and `test` are stored inline on the fixture: the route reads them
    // through nested selects and never filters on them.
    if ((key === 'run' || key === 'test') && model === 'testResult') {
      out[key] = row[key] ?? null;
      continue;
    }
    if (key === 'testResult' && model === 'triageVerdict') {
      const parent = store.testResult.find((row2) => row2.id === row.testResultId);
      out.testResult = parent
        ? projectRow('testResult', parent, (want as Row).select, store)
        : null;
      continue;
    }
    if (key === 'verdict' && model === 'testResult') {
      const verdict = store.triageVerdict.find((v) => v.testResultId === row.id);
      out.verdict = verdict
        ? projectRow('triageVerdict', verdict, (want as Row).select, store)
        : null;
      continue;
    }
    if (key === 'steps' && model === 'testResult') {
      const spec = want as Row;
      const steps = ((row.steps ?? []) as Row[]).filter((step) =>
        spec.where ? matchesCondition(step.status, spec.where.status) : true,
      );
      const sorted = sortRows(steps, spec.orderBy);
      const page = typeof spec.take === 'number' ? sorted.slice(0, spec.take) : sorted;
      out.steps = page.map((step) => {
        if (!spec.select) return { ...step };
        const picked: Row = {};
        for (const field of Object.keys(spec.select)) picked[field] = step[field] ?? null;
        return picked;
      });
      continue;
    }
    throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
  }
  return out;
}

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_${(sequence += 1)}`;
let clock = Date.UTC(2026, 0, 1);
const nextDate = (): Date => new Date((clock += 1000));

function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where)));

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        const found = store[name].find((row) => row.id === where.id);
        if (!found) return null;
        // Ownership checked on the RESULT, as the extension does: another org's
        // row is indistinguishable from a missing one.
        if (!global && found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel, store);
      },
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        const found = sortRows(select(where), orderBy)[0];
        return found ? projectRow(name, found, sel, store) : null;
      },
      findMany: async ({ where, orderBy, select: sel, take }: Row = {}) => {
        const rows = sortRows(select(where), orderBy);
        const page = typeof take === 'number' ? rows.slice(0, take) : rows;
        return page.map((row) => projectRow(name, row, sel, store));
      },
      create: async ({ data, select: sel }: Row) => {
        const orgId = global ? null : h.currentOrg();
        /*
         * The UNIQUE index is modelled, because it is the feature. Two
         * simultaneous files for one cause must produce one ticket, and a fake
         * that happily stored both would pass every idempotence test here.
         */
        if (name === 'trackerIssue') {
          const clash = store.trackerIssue.find(
            (row) => row.orgId === (data.orgId ?? orgId) && row.causeKey === data.causeKey,
          );
          if (clash) throw new Error('Unique constraint failed on (orgId, causeKey)');
        }
        const row: Row = {
          id: nextId(name),
          ...data,
          ...(orgId ? { orgId } : {}),
          createdAt: nextDate(),
          updatedAt: nextDate(),
        };
        store[name].push(row);
        return projectRow(name, row, sel, store);
      },
      update: async ({ where, data, select: sel }: Row) => {
        const found = store[name].find((row) => row.id === where.id);
        if (!found) throw new Error(`fake prisma: no ${name} to update`);
        if (!global && found.orgId !== h.currentOrg()) {
          throw new Error(`fake prisma: cross-tenant ${name}.update`);
        }
        Object.assign(found, data, { updatedAt: nextDate() });
        return projectRow(name, found, sel, store);
      },
      updateMany: async ({ where, data }: Row = {}) => {
        const rows = select(where);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    };
  };

  const db: Row = {
    $transaction: async (ops: unknown) => Promise.all(ops as Promise<unknown>[]),
  };
  for (const name of Object.keys(KNOWN_FILTERS) as ModelName[]) db[name] = model(name);
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
const RUN = 'run_1';

/** The one message three tests share. ECONNREFUSED is the classic one cause. */
const SHARED_ERROR =
  'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/login\nCall log:\n  - navigating to "http://localhost:5173/login"';

interface FailureFixture {
  id: string;
  testId: string;
  name: string;
  filePath: string;
  error?: string;
  /** A verdict row is created unless this is false. */
  verdict?: boolean;
  runId?: string;
  /** The cause the WORKER assigned. Null means it never named one. */
  clusterKey?: string | null;
}

function failure(fixture: FailureFixture): { result: Row; test: Row; verdict: Row | null } {
  const error = fixture.error ?? SHARED_ERROR;
  return {
    test: {
      id: fixture.testId,
      orgId: ORG,
      projectId: PROJECT,
      name: fixture.name,
      filePath: fixture.filePath,
      suiteId: null,
      feature: null,
      type: 'E2E',
      priority: 'P1',
    },
    result: {
      id: fixture.id,
      orgId: ORG,
      testId: fixture.testId,
      runId: fixture.runId ?? RUN,
      status: 'FAILED',
      durationMs: 1200,
      errorMessage: error,
      retriedAndPassed: false,
      videoKey: null,
      traceKey: null,
      network: [],
      createdAt: nextDate(),
      steps: [
        {
          index: 0,
          status: 'FAILED',
          title: 'open the login page',
          errorMessage: error,
          errorStack: `Error: ${error}\n    at tests/x.spec.ts:4:3`,
          selector: null,
          expected: null,
          actual: null,
        },
      ],
      test: { name: fixture.name, filePath: fixture.filePath, type: 'E2E', priority: 'P1' },
      run: {
        id: fixture.runId ?? RUN,
        projectId: PROJECT,
        commitSha: 'abcdef1234567',
        branch: 'main',
        prNumber: null,
        project: { name: 'Storefront' },
        environment: { name: 'staging', kind: 'STAGING', baseUrl: 'https://staging.acme.test' },
      },
    },
    verdict:
      fixture.verdict === false
        ? null
        : {
            id: `verdict_${fixture.id}`,
            orgId: ORG,
            testResultId: fixture.id,
            verdict: 'REAL_BUG',
            overriddenTo: null,
            reviewState: 'PENDING',
            confidence: 0.8,
            explanation: 'Nothing is answering at localhost:5173.',
            issueUrl: null,
            issueCauseKey: null,
            ownerState: null,
            /*
             * Denormalised off the result's run on the real row, and carried
             * here because the filing path reads the cause off the verdict when
             * the worker has named one. Left NULL by default so every test
             * that predates that still exercises the clusterer fallback.
             */
            runId: fixture.runId ?? RUN,
            clusterKey: fixture.clusterKey ?? null,
          },
  };
}

const THE_CAUSE: FailureFixture[] = [
  { id: 'res_a', testId: 't_a', name: 'login works', filePath: 'tests/auth/login.spec.ts' },
  { id: 'res_b', testId: 't_b', name: 'cart totals', filePath: 'tests/checkout/cart.spec.ts' },
  { id: 'res_c', testId: 't_c', name: 'search filters', filePath: 'tests/search/filter.spec.ts' },
];

function seed(failures: FailureFixture[] = THE_CAUSE): Store {
  const rows = failures.map(failure);
  return {
    project: [{ id: PROJECT, orgId: ORG, name: 'Storefront' }],
    integration: [
      {
        id: 'int_gh',
        orgId: ORG,
        projectId: null,
        kind: 'GITHUB',
        name: 'acme/storefront',
        config: { repo: 'acme/storefront', keyVersion: 1 },
        configEnc: 'sealed',
        enabled: true,
        createdAt: nextDate(),
      },
    ],
    test: rows.map((row) => row.test),
    testResult: rows.map((row) => row.result),
    triageVerdict: rows.map((row) => row.verdict).filter((row): row is Row => row !== null),
    trackerIssue: [],
    ownershipRule: [],
    failureSignature: [],
    user: [{ id: 'user_1', name: 'Dana Ruiz', email: 'dana@acme.test' }],
    team: [
      { id: 'team_payments', orgId: ORG, slug: 'payments', name: 'Payments' },
      { id: 'team_search', orgId: ORG, slug: 'search', name: 'Search' },
    ],
  };
}

const ownershipRule = (over: Row = {}): Row => ({
  id: nextId('rule'),
  orgId: ORG,
  projectId: PROJECT,
  position: 0,
  pathPattern: null,
  testId: null,
  suiteId: null,
  feature: null,
  ownerUserId: null,
  ownerTeamId: null,
  createdAt: nextDate(),
  ...over,
});

/** A coverage fixture in the shape `attributedCoverage` returns. */
function coverageFixture(): Row {
  const item = (over: Row): Row => ({
    entry: {
      item: {
        kind: 'ENDPOINT',
        key: 'ENDPOINT:POST /api/refunds',
        label: 'POST /api/refunds',
        file: 'app/api/refunds/route.ts',
        line: 12,
        origin: 'SOURCE_ONLY',
        evidence: 'app/api/refunds/route.ts exports POST',
        detector: 'nextRouteHandler',
        meta: {},
      },
      status: 'UNCOVERED',
      matches: [],
      verification: {
        lastRunId: null,
        lastStatus: null,
        executed: false,
        everPassed: false,
        mutationKilled: null,
      },
      ...(over.entry ?? {}),
    },
    feature: 'Payments',
    featureSource: 'CRAWL',
    owner: { kind: 'TEAM', teamId: 'team_payments' },
    ownerState: 'OWNED',
    ownerName: '@payments',
    ownerNote: 'app/api/refunds/route.ts matches app/api/**.',
    ...over,
  });

  return {
    items: [
      item({}),
      item({
        entry: {
          item: {
            kind: 'ROUTE',
            key: 'ROUTE:/admin/legacy',
            label: '/admin/legacy',
            file: 'app/admin/legacy/page.tsx',
            line: 1,
            origin: 'SOURCE_ONLY',
            evidence: 'app/admin/legacy/page.tsx — directory path is the URL',
            detector: 'nextAppRouter',
            meta: {},
          },
          status: 'UNCOVERED',
          matches: [],
          verification: {
            lastRunId: null,
            lastStatus: null,
            executed: false,
            everPassed: false,
            mutationKilled: null,
          },
        },
        feature: 'Admin',
        owner: null,
        ownerState: 'NO_MATCH',
        ownerName: null,
      }),
      // Covered, and a waived one: neither may ever appear in a ticket that
      // says "nothing has ever tested these".
      item({
        entry: {
          item: {
            kind: 'ROUTE',
            key: 'ROUTE:/orders',
            label: '/orders',
            file: 'app/orders/page.tsx',
            line: 1,
            origin: 'BOTH',
            evidence: 'app/orders/page.tsx — directory path is the URL',
            detector: 'nextAppRouter',
            meta: {},
          },
          status: 'COVERED',
          matches: [],
          verification: {
            lastRunId: 'run_1',
            lastStatus: 'PASSED',
            executed: true,
            everPassed: true,
            mutationKilled: null,
          },
        },
        feature: 'Orders',
      }),
    ],
    rollup: { byFeature: [], byOwner: [] },
    attribution: {
      items: 3,
      featureFromCrawl: 3,
      featureFromTests: 0,
      featureUnattributed: 0,
      ownedItems: 2,
      unownedItems: 1,
      rulesEvaluated: 1,
      rulesUnusable: [],
    },
    snapshot: { totals: { percent: 33.3, denominator: 3, covered: 1 } },
    unmeasuredKinds: ['ROLE_CELL'],
  };
}

let store: Store;

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { causeKeyFor, issuesRouter } = await import('./issues.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
// Mounted where index.ts mounts it.
app.use('/issues', issuesRouter);
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

async function post(path: string, body: unknown): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const verdictOf = (resultId: string): Row =>
  store.triageVerdict.find((row) => row.testResultId === resultId)!;

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null };
  h.audits.length = 0;
  h.filed.length = 0;
  h.edited.length = 0;
  h.providerFails = null;
  h.editFails = null;
  h.coverage = coverageFixture();
  store = seed();
  h.prisma = makeDb(store);
});

// ─── One ticket per cause ────────────────────────────────────────────────────

describe('POST /issues files one ticket per CAUSE', () => {
  it('turns three tests with one cause into one ticket that names all three', async () => {
    const { status, body } = await post('/issues', { resultId: 'res_a' });

    expect(status).toBe(201);
    // The number that matters. Three failures, one POST to GitHub.
    expect(h.filed).toHaveLength(1);
    expect(body.cause).toMatchObject({ grouped: true, affected: 3 });

    const issue = h.filed[0]!;
    // The title is about the cause, not about whichever test was clicked.
    expect(issue.title).toContain('3 tests failing');
    expect(issue.title).toMatch(/Nothing is answering at localhost/);
    for (const member of THE_CAUSE) {
      expect(issue.body).toContain(member.filePath);
      expect(issue.body).toContain(member.name);
    }
    // And it still carries one failure's evidence: a list of names with no
    // stack in it is not actionable either.
    expect(issue.body).toContain('ERR_CONNECTION_REFUSED');
    expect(issue.body).toContain('Affected tests (3)');

    // Every member's verdict points at the one ticket.
    for (const member of THE_CAUSE) {
      expect(verdictOf(member.id).issueUrl).toBe(body.url);
      expect(verdictOf(member.id).issueCauseKey).toBe(body.causeKey);
    }
    expect(body.persisted).toBe(3);
    expect(store.trackerIssue).toHaveLength(1);
    expect(store.trackerIssue[0]).toMatchObject({
      subject: 'FAILURE',
      affectedCount: 3,
      provider: 'GITHUB',
    });
  });

  it('files nothing a second time when another member of the cause is pressed', async () => {
    const first = await post('/issues', { resultId: 'res_a' });
    const second = await post('/issues', { resultId: 'res_b' });

    expect(second.status).toBe(200);
    expect(second.body.alreadyFiled).toBe(true);
    expect(second.body.url).toBe(first.body.url);
    // The assertion the forty-ticket morning is about.
    expect(h.filed).toHaveLength(1);
    expect(store.trackerIssue).toHaveLength(1);
  });

  it('links a LATER run of the same cause to the same ticket', async () => {
    const first = await post('/issues', { resultId: 'res_a' });

    // The same cause breaks again tomorrow, in a new run with a new result.
    const again = failure({
      id: 'res_d',
      testId: 't_a',
      name: 'login works',
      filePath: 'tests/auth/login.spec.ts',
      runId: 'run_2',
    });
    store.testResult.push(again.result);
    store.triageVerdict.push(again.verdict!);

    const second = await post('/issues', { resultId: 'res_d' });

    expect(second.status).toBe(200);
    expect(second.body.url).toBe(first.body.url);
    // The signature outlives the run, so nobody opens a second ticket about a
    // bug somebody is already fixing.
    expect(h.filed).toHaveLength(1);
    expect(second.body.linked).toBe(1);
    expect(verdictOf('res_d').issueUrl).toBe(first.body.url);
    expect(second.body.affected).toBe(4);

    /*
     * And the TICKET now says four. This used to report
     * `providerBodyRefreshed: false` and mean it: the board kept one ticket per
     * cause — the defect that mattered — while the ticket's body went on
     * listing the three tests known at filing time. Somebody reading it, not
     * finding their failing test, files a second one.
     */
    expect(second.body.providerBodyRefreshed).toBe(true);
    expect(second.body.providerBodyProblem).toBeNull();
    expect(h.edited).toHaveLength(1);
    expect(h.edited[0]!.key).toBe('acme/storefront#1');

    /*
     * And the rewrite names the cause's WHOLE membership, not tonight's.
     * `res_d` is a second failure of `t_a`, so the four recorded results are
     * three distinct tests — and composing the rewrite from this run's members
     * alone would have REPLACED a ticket listing three tests with one listing
     * the single test that failed tonight: a refresh that makes the ticket less
     * true than it was.
     */
    expect(h.edited[0]!.body).toContain('3 affected tests');
    for (const path of [
      'tests/auth/login.spec.ts',
      'tests/checkout/cart.spec.ts',
      'tests/search/filter.spec.ts',
    ]) {
      expect(h.edited[0]!.body).toContain(path);
    }
    // Results and tests are different numbers and both are reported.
    expect(second.body.affected).toBe(4);
    expect(second.body.affectedTests).toBe(3);
    // Still one ticket: an edit is not a filing.
    expect(h.filed).toHaveLength(1);
  });

  it('links a verdict that triage only wrote AFTER the ticket was filed', async () => {
    // The durable half of the guard, on its own. The first press linked the
    // verdicts that existed; this member's verdict appears afterwards (triage
    // was still in flight), so the stored link cannot protect it and only the
    // cause key can.
    store.triageVerdict = store.triageVerdict.filter((row) => row.testResultId !== 'res_c');
    const first = await post('/issues', { resultId: 'res_a' });
    expect(first.body.unassignable).toBe(1);

    store.triageVerdict.push(failure({ id: 'res_c', testId: 't_c', name: 'search filters', filePath: 'tests/search/filter.spec.ts' }).verdict!);

    const second = await post('/issues', { resultId: 'res_c' });

    expect(second.status).toBe(200);
    expect(h.filed).toHaveLength(1);
    expect(second.body.linked).toBe(1);
    expect(verdictOf('res_c').issueUrl).toBe(first.body.url);
  });

  it('keeps two different causes apart', async () => {
    store.test.push({
      id: 't_e',
      orgId: ORG,
      projectId: PROJECT,
      name: 'price renders',
      filePath: 'tests/checkout/price.spec.ts',
      suiteId: null,
      feature: null,
      type: 'E2E',
      priority: 'P1',
    });
    const other = failure({
      id: 'res_e',
      testId: 't_e',
      name: 'price renders',
      filePath: 'tests/checkout/price.spec.ts',
      error: 'Error: expect(received).toBe(expected)\n  Expected: 4\n  Received: 3',
    });
    store.testResult.push(other.result);
    store.triageVerdict.push(other.verdict!);

    await post('/issues', { resultId: 'res_a' });
    const second = await post('/issues', { resultId: 'res_e' });

    expect(second.status).toBe(201);
    expect(h.filed).toHaveLength(2);
    expect(store.trackerIssue).toHaveLength(2);
    expect(second.body.cause.affected).toBe(1);
  });

  it('refuses to group two failures that carry no signature at all', async () => {
    // Both scrub to nothing, so "they match" means only that neither said
    // anything. Grouping on that would assert a shared cause nobody observed —
    // the same mistake as filing forty tickets, pointing the other way.
    store = seed([
      { id: 'res_x', testId: 't_x', name: 'one', filePath: 'tests/a.spec.ts', error: 'nope 42' },
      { id: 'res_y', testId: 't_y', name: 'two', filePath: 'tests/b.spec.ts', error: 'nope 43' },
    ]);
    // No stack either: a stack carries an error CLASS, which is signal, and
    // with it these two would cluster legitimately.
    for (const row of store.testResult) (row.steps as Row[])[0]!.errorStack = null;
    h.prisma = makeDb(store);

    const first = await post('/issues', { resultId: 'res_x' });
    const second = await post('/issues', { resultId: 'res_y' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(h.filed).toHaveLength(2);
    expect(first.body.cause.grouped).toBe(false);
    expect(h.filed[0]!.body).toContain('no signature QAAI could group on');
  });

  it('still short-circuits on a result that already carries a link', async () => {
    verdictOf('res_a').issueUrl = 'https://github.com/acme/storefront/issues/99';
    verdictOf('res_a').issueCauseKey = 'cause_from_before';

    const { status, body } = await post('/issues', { resultId: 'res_a' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      url: 'https://github.com/acme/storefront/issues/99',
      provider: 'GITHUB',
      causeKey: 'cause_from_before',
      alreadyFiled: true,
    });
    expect(h.filed).toHaveLength(0);
  });

  /*
   * THE CAP MUST ADMIT IT BIT.
   *
   * `MAX_RUN_FAILURES_SCANNED` bounds how much of a run is read to find the
   * cause, and the response and the ticket body both promise to say when it
   * applied. The flag was computed from the failures that SURVIVED the
   * evidence filter, not from the rows the query returned — so a run past the
   * cap whose scanned page contained even one evidence-free result reported
   * `truncated: false` and filed a ticket whose membership was short with
   * nothing saying so. A cap you are told about is a cap; a cap you are not is
   * a wrong number.
   */
  it('still says the scan was capped when some scanned rows carried no evidence', async () => {
    const many: FailureFixture[] = [
      { id: 'res_a', testId: 't_a', name: 'login works', filePath: 'tests/auth/login.spec.ts' },
    ];
    // Exactly the cap, with a handful the evidence filter drops.
    for (let i = 1; i < 500; i += 1) {
      many.push({
        id: `res_bulk_${i}`,
        testId: `t_bulk_${i}`,
        name: `bulk ${i}`,
        filePath: `tests/bulk/${i}.spec.ts`,
      });
    }
    store = seed(many);
    // A handful of the scanned page carry no evidence at all — no message and
    // no failed step — which is the row the clusterer cannot use and the
    // filter therefore drops.
    for (const row of store.testResult) {
      if (/_bulk_(100|200|300|400)$/.test(String(row.id))) {
        row.errorMessage = null;
        row.steps = [];
      }
    }
    // ...and more beyond it, which is what makes the page a page.
    for (let i = 500; i < 520; i += 1) {
      const extra = failure({
        id: `res_tail_${i}`,
        testId: `t_tail_${i}`,
        name: `tail ${i}`,
        filePath: `tests/tail/${i}.spec.ts`,
      });
      store.test.push(extra.test);
      store.testResult.push(extra.result);
      store.triageVerdict.push(extra.verdict!);
    }
    h.prisma = makeDb(store);

    const { status, body } = await post('/issues', { resultId: 'res_a' });

    expect(status).toBe(201);
    expect(body.truncated).toBe(true);
    expect(h.filed[0]!.body).toContain('may be short');
  });

  it('refuses a result with no bug in it', async () => {
    store.testResult.find((row) => row.id === 'res_a')!.status = 'PASSED';
    const { status, body } = await post('/issues', { resultId: 'res_a' });
    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('passed');
    expect(h.filed).toHaveLength(0);
  });

  it('leaves NOTHING behind when the provider refuses', async () => {
    h.providerFails = { message: 'GitHub returned 404 — that repository does not exist', kind: 'PROVIDER' };

    const { status } = await post('/issues', { resultId: 'res_a' });

    expect(status).toBe(422);
    // A recorded ticket that does not exist is worse than no ticket: the next
    // press would find it and link forty failures to nothing.
    expect(store.trackerIssue).toHaveLength(0);
    expect(verdictOf('res_a').issueUrl).toBeNull();
    expect(h.audits.map((a) => a.action)).toContain('issue.file.failed');
  });
});

// ─── Routing ─────────────────────────────────────────────────────────────────

// ─── The idempotence key ─────────────────────────────────────────────────────

/**
 * `causeKeyFor` is the whole duplicate guard: it is what the UNIQUE index
 * compares, so what goes INTO the digest decides which failures share a
 * ticket. Every component was argued for and none was tested — removing
 * `projectId` or `subject` from the hash changed nothing any assertion
 * noticed, and each removal is a different way for one customer's board to
 * fill up.
 */
describe('causeKeyFor', () => {
  const SIGNATURE = 'class=TimeoutError msg=waiting for selector';

  it('separates two projects that break the same way', () => {
    /*
     * THE DEFECT WITHOUT `projectId`. Two projects in one org share an error —
     * they share a framework, a base image, a dependency — and one ticket then
     * covers both. They have different boards, different owners and different
     * release schedules, so the team that fixes it closes a ticket the other
     * team is still failing on, and the second team's next press finds the
     * closed ticket and links to it.
     */
    expect(causeKeyFor('FAILURE', 'proj_1', SIGNATURE)).not.toBe(
      causeKeyFor('FAILURE', 'proj_2', SIGNATURE),
    );
  });

  it('separates a failure from a coverage gap with the same identity', () => {
    /*
     * THE DEFECT WITHOUT `subject`. The two identities are different kinds of
     * string — a cluster signature and a gap filter — and nothing stops them
     * colliding. When they do, "nothing tests /api/refunds" and "the refund
     * test times out" become one ticket, and closing either closes both.
     */
    expect(causeKeyFor('FAILURE', 'proj_1', SIGNATURE)).not.toBe(
      causeKeyFor('COVERAGE_GAP', 'proj_1', SIGNATURE),
    );
  });

  it('is stable: the same three inputs always give the same key', () => {
    // The other half of the guard. A key that drifted — from a timestamp, a
    // random salt, a Map iteration order — would file a fresh ticket every
    // press, which is the forty-ticket morning with no cluster involved.
    expect(causeKeyFor('FAILURE', 'proj_1', SIGNATURE)).toBe(
      causeKeyFor('FAILURE', 'proj_1', SIGNATURE),
    );
  });

  it('separates two different causes in one project', () => {
    expect(causeKeyFor('FAILURE', 'proj_1', SIGNATURE)).not.toBe(
      causeKeyFor('FAILURE', 'proj_1', 'class=AssertionError msg=expected 2 got 3'),
    );
  });

  it('refuses a projectId that would be ambiguous against the identity', () => {
    /*
     * The digest joins on `|` and so cannot say where its fields end:
     * ('FAILURE', 'p', 'x|y') and ('FAILURE', 'p|x', 'y') hash to the same
     * string. Length-prefixing the fields would fix that and must never be
     * done — every TrackerIssue on every board is keyed over this exact
     * digest, so a new one would find none of them and the next press would
     * file a second ticket for every cause in the install.
     *
     * So the collision is made unreachable instead. Only the LAST field is
     * user-influenced, and a trailing field cannot be confused with anything
     * because nothing follows it; this asserts the guard that keeps the middle
     * field clean. No row has ever been keyed from a `|`-bearing project id, so
     * refusing one cannot orphan a ticket.
     */
    expect(() => causeKeyFor('FAILURE', 'proj_1|x', 'y')).toThrow(/ambiguous/);
    // The user-influenced field may hold anything at all, pipes included.
    expect(causeKeyFor('FAILURE', 'proj_1', 'x|y')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Reconciling with the worker's own cause ─────────────────────────────────

/**
 * The ticket's cause and the verdict's cause must be the same cause.
 *
 * Triage persists `clusterKey` on every verdict and a `FailureSignature` row
 * per cause, both from the same `signatureOf()` this endpoint's clusterer uses.
 * Re-clustering the run here produced a SECOND opinion about the same question,
 * and two opinions is how a ticket comes to cover a different set of tests than
 * the cause page the reviewer has open, with nothing to say which is right.
 */
describe('POST /issues reads the cause off the verdict when the worker named one', () => {
  /** The signature the clusterer produces for THE_CAUSE, discovered not guessed. */
  async function clustererSignature(): Promise<string> {
    const filed = await post('/issues', { resultId: 'res_a' });
    return String(filed.body.cause.signature);
  }

  it('groups by the stored clusterKey, not by re-reading the error messages', async () => {
    /*
     * The sharpest shape available: two failures whose error messages have
     * nothing in common, carrying the SAME clusterKey. The clusterer would put
     * them in different causes; the worker has already decided they are one.
     * The ticket must follow the worker, because the verdicts are attached to
     * the worker's answer and the cockpit links on it.
     */
    store = seed([
      { id: 'res_a', testId: 't_a', name: 'login works', filePath: 'tests/auth/login.spec.ts', clusterKey: 'abc123abc123' },
      {
        id: 'res_b',
        testId: 't_b',
        name: 'cart adds an item',
        filePath: 'tests/checkout/cart.spec.ts',
        error: 'expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3',
        clusterKey: 'abc123abc123',
      },
    ]);
    store.failureSignature.push({
      id: 'sig_1',
      orgId: ORG,
      projectId: PROJECT,
      clusterKey: 'abc123abc123',
      signature: 'class=ConnectionRefused msg=nothing is listening',
      label: 'The app is not reachable',
    });
    h.prisma = makeDb(store);

    const { status, body } = await post('/issues', { resultId: 'res_a' });

    expect(status).toBe(201);
    expect(body.cause).toMatchObject({
      source: 'VERDICT_CLUSTER',
      clusterKey: 'abc123abc123',
      grouped: true,
      affected: 2,
      // Read off FailureSignature, which is where the ticket's cause now
      // derives from — so the ticket and the cause page cannot disagree.
      signature: 'class=ConnectionRefused msg=nothing is listening',
      label: 'The app is not reachable',
    });
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]!.body).toContain('tests/auth/login.spec.ts');
    expect(h.filed[0]!.body).toContain('tests/checkout/cart.spec.ts');
    // And both verdicts carry the one link.
    expect(verdictOf('res_a').issueUrl).toBe(body.url);
    expect(verdictOf('res_b').issueUrl).toBe(body.url);
  });

  it('keys on the SIGNATURE, so a ticket filed before the cluster key existed is found', async () => {
    /*
     * The trap this avoids, and the reason the identity is still the signature
     * rather than the 12-character cluster key. Every `TrackerIssue` already on
     * a customer's board is keyed over the signature. Hashing the cluster key
     * instead would mint a brand-new causeKey for a cause that already HAS a
     * ticket, and the next press would open a second one — the forty-tickets
     * defect, reintroduced by the change meant to harden it.
     */
    const signature = await clustererSignature();
    expect(h.filed).toHaveLength(1);

    // The same cause breaks again, in a later run, and this time triage has
    // named it.
    const again = failure({
      id: 'res_d',
      testId: 't_a',
      name: 'login works',
      filePath: 'tests/auth/login.spec.ts',
      runId: 'run_2',
      clusterKey: 'abc123abc123',
    });
    store.testResult.push(again.result);
    store.triageVerdict.push(again.verdict!);
    store.failureSignature.push({
      id: 'sig_1',
      orgId: ORG,
      projectId: PROJECT,
      clusterKey: 'abc123abc123',
      signature,
      label: 'The app is not reachable',
    });

    const second = await post('/issues', { resultId: 'res_d' });

    expect(second.body.alreadyFiled).toBe(true);
    expect(second.body.causeKey).toBe(causeKeyFor('FAILURE', PROJECT, signature));
    // The whole point: no second ticket.
    expect(h.filed).toHaveLength(1);
    expect(store.trackerIssue).toHaveLength(1);
  });

  it('falls back to the clusterer when no FailureSignature row exists, and SAYS so', async () => {
    /*
     * A clusterKey with no signature row — pruned, or never written. There is
     * nothing to read, so the clusterer runs exactly as before. Which of the
     * two happened is reported, because "these forty tests are one cause" is a
     * claim and the reader is entitled to know who made it.
     */
    store = seed([
      { id: 'res_a', testId: 't_a', name: 'login works', filePath: 'tests/auth/login.spec.ts', clusterKey: 'abc123abc123' },
    ]);
    h.prisma = makeDb(store);

    const { body } = await post('/issues', { resultId: 'res_a' });

    expect(body.cause.source).toBe('RECLUSTERED');
    expect(body.cause.clusterKey).toBe('abc123abc123');
  });

  it('falls back to the clusterer when triage has not named a cause at all', async () => {
    const { body } = await post('/issues', { resultId: 'res_a' });

    expect(body.cause.source).toBe('RECLUSTERED');
    expect(body.cause.clusterKey).toBeNull();
  });
});

// ─── Re-filing rewrites the ticket, or says why it did not ──────────────────

describe('re-filing a cause rewrites its ticket', () => {
  /** Press once, then add a later failure of the same cause and press again. */
  async function pressTwice(): Promise<{ first: Row; second: Row }> {
    const first = await post('/issues', { resultId: 'res_a' });
    const again = failure({
      id: 'res_d',
      testId: 't_a',
      name: 'login works',
      filePath: 'tests/auth/login.spec.ts',
      runId: 'run_2',
    });
    store.testResult.push(again.result);
    store.triageVerdict.push(again.verdict!);
    const second = await post('/issues', { resultId: 'res_d' });
    return { first: first.body, second: second.body };
  }

  it('reports the refresh as FAILED, with a reason, when the provider refuses', async () => {
    /*
     * The field has to stay honest in both directions. A
     * `providerBodyRefreshed: true` nobody checked is the lie; a `false` with
     * no reason is the unhelpful truth. The linking still happened, so this is
     * a 200 with a stated failure rather than a 4xx that implies nothing
     * landed.
     */
    const first = await post('/issues', { resultId: 'res_a' });
    expect(first.status).toBe(201);

    h.editFails = {
      message: 'GitHub no longer has that issue (404) — it was deleted or moved.',
      kind: 'PROVIDER',
    };
    const again = failure({
      id: 'res_d',
      testId: 't_a',
      name: 'login works',
      filePath: 'tests/auth/login.spec.ts',
      runId: 'run_2',
    });
    store.testResult.push(again.result);
    store.triageVerdict.push(again.verdict!);

    const second = await post('/issues', { resultId: 'res_d' });

    expect(second.status).toBe(200);
    expect(second.body.providerBodyRefreshed).toBe(false);
    expect(second.body.providerBodyProblem).toContain('no longer has that issue');
    // The durable half still happened — that is why this is not an error.
    expect(second.body.linked).toBe(1);
    expect(verdictOf('res_d').issueUrl).toBe(second.body.url);
    // And QAAI's record of the ticket text is NOT updated, or this row would
    // disagree with the board.
    expect(store.trackerIssue[0]!.title).toBe(h.filed[0]!.title);
  });

  it('reports why it could not rewrite a ticket with no provider id recorded', async () => {
    await post('/issues', { resultId: 'res_a' });
    // An older ticket, filed before QAAI stored the provider's own identifier.
    store.trackerIssue[0]!.key = null;

    const again = failure({
      id: 'res_d',
      testId: 't_a',
      name: 'login works',
      filePath: 'tests/auth/login.spec.ts',
      runId: 'run_2',
    });
    store.testResult.push(again.result);
    store.triageVerdict.push(again.verdict!);

    const second = await post('/issues', { resultId: 'res_d' });

    expect(second.body.providerBodyRefreshed).toBe(false);
    expect(second.body.providerBodyProblem).toContain('no provider id recorded');
    expect(h.edited).toEqual([]);
  });

  it('counts the members with no verdict on the RE-PRESS, which is where it matters', async () => {
    /*
     * A re-press is exactly when triage has caught up, so this is the response
     * where `unassignable` decides whether pressing again would finish the job.
     * The create branch reported it and the already-filed branch did not.
     */
    store.triageVerdict = store.triageVerdict.filter((row) => row.testResultId !== 'res_c');

    const first = await post('/issues', { resultId: 'res_a' });
    expect(first.body.unassignable).toBe(1);

    // Pressed from the member whose verdict is MISSING, so the request reaches
    // the already-filed branch rather than the short-circuit on a verdict that
    // already carries the link.
    const second = await post('/issues', { resultId: 'res_c' });

    expect(second.body.alreadyFiled).toBe(true);
    expect(second.body.unassignable).toBe(1);
  });

  it('names the whole membership on a rewrite, not just the latest run', async () => {
    const { second } = await pressTwice();

    expect(second.providerBodyRefreshed).toBe(true);
    expect(second.affected).toBe(4);
    expect(second.affectedTests).toBe(3);
  });
});

describe('the failure is assigned when it is filed', () => {
  it('writes the owner onto every member, and says NO_MATCH on the one nobody owns', async () => {
    store.ownershipRule.push(
      ownershipRule({ pathPattern: 'tests/auth/**', ownerTeamId: 'team_payments' }),
      ownershipRule({ pathPattern: 'tests/checkout/**', ownerTeamId: 'team_payments' }),
    );

    const { body } = await post('/issues', { resultId: 'res_a' });

    expect(verdictOf('res_a')).toMatchObject({
      assigneeTeamId: 'team_payments',
      assigneeUserId: null,
      ownerState: 'OWNED',
    });
    expect(verdictOf('res_a').ownerNote).toContain('tests/auth/**');
    expect(verdictOf('res_a').assignedAt).toBeInstanceOf(Date);

    // The unowned member is VISIBLY unowned. This is the assertion that matters:
    // a null assignee with no state beside it reads as "nobody has looked".
    expect(verdictOf('res_c')).toMatchObject({
      assigneeTeamId: null,
      assigneeUserId: null,
      ownerState: 'NO_MATCH',
    });
    expect(verdictOf('res_c').ownerNote).toContain('tests/search/filter.spec.ts');

    // Unanimous among the owned ones, so the ticket carries that owner and says
    // how many were not covered by it.
    expect(body.owner).toMatchObject({ state: 'OWNED', name: '@payments' });
    expect(body.owner.note).toContain('2 of 3');
    expect(h.filed[0]!.body).toContain('**Owner:** @payments');
    expect(store.trackerIssue[0]).toMatchObject({
      ownerTeamId: 'team_payments',
      ownerState: 'OWNED',
    });
  });

  it('names nobody when the cause is split between two teams', async () => {
    store.ownershipRule.push(
      ownershipRule({ pathPattern: 'tests/auth/**', ownerTeamId: 'team_payments' }),
      ownershipRule({ pathPattern: 'tests/search/**', ownerTeamId: 'team_search' }),
    );

    const { body } = await post('/issues', { resultId: 'res_a' });

    expect(body.owner.state).toBe('SPLIT');
    expect(body.owner.name).toBeNull();
    expect(h.filed[0]!.body).toContain('**Owner:** not one person');
    expect(store.trackerIssue[0]).toMatchObject({
      ownerState: 'SPLIT',
      ownerTeamId: null,
      ownerUserId: null,
    });
    // Each member still gets its OWN owner — the ticket is split, the failures
    // are not.
    expect(verdictOf('res_a').assigneeTeamId).toBe('team_payments');
    expect(verdictOf('res_c').assigneeTeamId).toBe('team_search');
  });

  it('says RULES_UNUSABLE rather than NO_MATCH when a rule has stopped routing', async () => {
    // Stored when the validation was looser. From outside it is indistinguishable
    // from an unassigned suite, which is why the state exists.
    store.ownershipRule.push(
      ownershipRule({ pathPattern: 'tests/[a-z]/**', ownerTeamId: 'team_payments' }),
    );

    await post('/issues', { resultId: 'res_a' });

    expect(verdictOf('res_a').ownerState).toBe('RULES_UNUSABLE');
    expect(verdictOf('res_a').ownerNote).toMatch(/could not be evaluated/);
  });

  it('routes a member that an older filing had linked but never routed', async () => {
    // The two halves of the write are independent. This verdict already points
    // at a ticket (the old one-per-result path put it there) and has never been
    // routed, and a writer that skipped the whole row because of the link would
    // leave that failure unowned forever.
    verdictOf('res_b').issueUrl = 'https://github.com/acme/storefront/issues/7';
    store.ownershipRule.push(
      ownershipRule({ pathPattern: 'tests/**', ownerTeamId: 'team_payments' }),
    );

    await post('/issues', { resultId: 'res_a' });

    expect(verdictOf('res_b')).toMatchObject({
      assigneeTeamId: 'team_payments',
      ownerState: 'OWNED',
      // …and the link it already had is NOT re-pointed at the new ticket: that
      // would hide the one a human is already working in.
      issueUrl: 'https://github.com/acme/storefront/issues/7',
    });
  });

  it('leaves a verdict the run already routed alone, rather than re-stamping it', async () => {
    store.ownershipRule.push(
      ownershipRule({ pathPattern: 'tests/**', ownerTeamId: 'team_payments' }),
    );
    Object.assign(verdictOf('res_b'), {
      ownerState: 'NO_MATCH',
      ownerNote: 'written when the run finished',
      assigneeTeamId: null,
    });

    const { body } = await post('/issues', { resultId: 'res_a' });

    // The notify processor routes a run the moment it finishes, so most
    // verdicts already carry an owner by the time anybody files. Overwriting
    // that with an identical decision and a newer timestamp would turn
    // `assignedAt` into a record of button presses.
    expect(verdictOf('res_b').ownerNote).toBe('written when the run finished');
    expect(body.assigned).toBe(2);
    expect(body.persisted).toBe(3);
  });

  it('counts a member with no verdict row instead of claiming it was assigned', async () => {
    store.triageVerdict = store.triageVerdict.filter((row) => row.testResultId !== 'res_c');

    const { body } = await post('/issues', { resultId: 'res_a' });

    expect(body.cause.affected).toBe(3);
    expect(body.persisted).toBe(2);
    // Triage may still be in flight. Saying "assigned" about a failure with
    // nothing to carry an assignee is the reassuring lie.
    expect(body.unassignable).toBe(1);
  });
});

// ─── Coverage gaps ───────────────────────────────────────────────────────────

describe('POST /issues/coverage files the gap list as a piece of work', () => {
  it('names the surfaces and the files they are declared in', async () => {
    const { status, body } = await post('/issues/coverage', { projectId: PROJECT });

    expect(status).toBe(201);
    expect(h.filed).toHaveLength(1);
    const issue = h.filed[0]!;

    // The named list IS the ticket.
    expect(issue.body).toContain('POST /api/refunds');
    expect(issue.body).toContain('app/api/refunds/route.ts');
    expect(issue.body).toContain('exports POST');
    expect(issue.body).toContain('/admin/legacy');
    // The percentage is context, not the ask.
    expect(issue.body).toContain('33.3%');
    expect(issue.title).toContain('2 untested surfaces');

    // Covered surfaces are not gaps, and a ticket claiming otherwise is a lie
    // about the customer's own suite.
    expect(issue.body).not.toContain('/orders');

    expect(body.affected).toBe(2);
    expect(store.trackerIssue[0]).toMatchObject({
      subject: 'COVERAGE_GAP',
      affectedCount: 2,
      ownerState: 'OWNED',
      ownerTeamId: 'team_payments',
    });
    // Unmeasured axes are stated, never quietly scored.
    expect(issue.body).toContain('no extractor for');
  });

  it('is idempotent per filter, and refreshes the count instead of re-filing', async () => {
    const first = await post('/issues/coverage', { projectId: PROJECT });
    // One gap gets closed before the second press.
    h.coverage!.items = (h.coverage!.items as Row[]).slice(1);

    const second = await post('/issues/coverage', { projectId: PROJECT });

    expect(second.status).toBe(200);
    expect(second.body.url).toBe(first.body.url);
    expect(h.filed).toHaveLength(1);
    // The delta is the progress: one left now, two when it was filed.
    expect(second.body.affected).toBe(1);
    expect(second.body.affectedWhenFiled).toBe(2);
    expect(store.trackerIssue[0]!.affectedCount).toBe(1);
  });

  it('treats a different filter as a different piece of work', async () => {
    await post('/issues/coverage', { projectId: PROJECT, feature: 'Payments' });
    const second = await post('/issues/coverage', { projectId: PROJECT, feature: 'Admin' });

    expect(second.status).toBe(201);
    expect(h.filed).toHaveLength(2);
    expect(h.filed[0]!.title).toContain('Payments');
    expect(h.filed[1]!.title).toContain('Admin');
    // Admin's gap is owned by nobody, and the ticket says so rather than
    // borrowing the owner of the project's other gaps.
    expect(h.filed[1]!.body).toContain('**Owner:** nobody yet');
  });

  it('files only the owner asked for', async () => {
    const { body } = await post('/issues/coverage', {
      projectId: PROJECT,
      ownerTeamId: 'team_payments',
    });

    expect(body.affected).toBe(1);
    expect(h.filed[0]!.body).toContain('POST /api/refunds');
    expect(h.filed[0]!.body).not.toContain('/admin/legacy');
  });

  it('refuses to file a ticket about nothing', async () => {
    const { status, body } = await post('/issues/coverage', {
      projectId: PROJECT,
      feature: 'Nonexistent',
    });

    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('nothing to file');
    expect(h.filed).toHaveLength(0);
    expect(store.trackerIssue).toHaveLength(0);
  });

  it('refuses two opposite owner filters rather than guessing', async () => {
    const both = await post('/issues/coverage', {
      projectId: PROJECT,
      ownerUserId: 'user_1',
      ownerTeamId: 'team_payments',
    });
    expect(both.status).toBe(400);

    const contradiction = await post('/issues/coverage', {
      projectId: PROJECT,
      unowned: true,
      ownerTeamId: 'team_payments',
    });
    expect(contradiction.status).toBe(400);
  });

  it('404s a project in another org rather than filing its gaps', async () => {
    store.project.push({ id: 'proj_other', orgId: 'org_2', name: 'Someone else' });
    const { status } = await post('/issues/coverage', { projectId: 'proj_other' });
    expect(status).toBe(404);
    expect(h.filed).toHaveLength(0);
  });
});
