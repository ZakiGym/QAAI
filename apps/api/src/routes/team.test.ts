/**
 * The read that makes the assignment columns worth writing (§8).
 *
 * `TriageVerdict.assigneeUserId` / `assigneeTeamId` / `ownerState` are written
 * the moment a run goes red — by the notify processor, and again by the filing
 * endpoint — and until `GET /team/triage` existed nothing could ask the obvious
 * question back: which of these are mine? An assignment nobody can query is a
 * column, not a feature.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. THE FILTER IS THE ANSWER. A queue that quietly returns somebody else's
 *      failures alongside yours is worse than no queue: the whole point is to
 *      be able to trust that what is listed is yours.
 *   2. THE FIFTH STATE IS ASKABLE. `ownerState` is a nullable column whose NULL
 *      means "nothing has tried to route this yet" — not NO_RULES (we looked,
 *      the table is empty) and not NO_MATCH (we looked, nothing matched).
 *      Without the `UNROUTED` sentinel the rows nothing has routed cannot be
 *      found at all, and they are precisely the ones nobody is going to pick up.
 *   3. A MISSPELLED FILTER IS A 400, NOT AN EMPTY LIST. "You have nothing
 *      assigned" is the reassuring answer, and it must not be the answer to
 *      "you spelled the filter wrongly".
 *   4. THE PAGE SAYS IT IS A PAGE. `total` and `truncated` beside the rows,
 *      because for this question the number of items IS the answer.
 *
 * It also pins the two shared helpers this file stopped re-implementing: the
 * ownership-rule `select` (a copy that loses `position` inverts CODEOWNERS'
 * last-match-wins precedence while looking correct) and `ownerLabel` (a team
 * that is `@payments` in the digest and `Payments` here reads as two owners).
 *
 * Harness: the same shape as routes/issues.test.ts — a mocked Prisma module
 * with a real AsyncLocalStorage tenant scope, and the real router over a
 * loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_dana', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  audits: [],
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

type ModelName = 'project' | 'test' | 'testResult' | 'triageVerdict' | 'ownershipRule' | 'user' | 'team';

/**
 * The filters these endpoints are allowed to use. Anything else throws rather
 * than being quietly ignored: a fake that shrugged at `assigneeUserId` would
 * pass every filter test in this file with no filter in the route.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  test: new Set(['id', 'orgId', 'projectId']),
  testResult: new Set(['id', 'orgId', 'runId', 'status']),
  triageVerdict: new Set([
    'id',
    'orgId',
    'testResultId',
    'assigneeUserId',
    'assigneeTeamId',
    'ownerState',
    'testResult',
  ]),
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

function matchesWhere(model: ModelName, row: Row, where: Row, store: Store): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') {
      return (cond as Row[]).some((branch) => matchesWhere(model, row, branch, store));
    }
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    /*
     * The relation hop the project filter uses: TriageVerdict has no
     * projectId, so narrowing to one project goes through the result's run.
     * Modelled rather than shrugged at, since a fake that ignored it would
     * report another project's queue as yours.
     */
    if (key === 'testResult' && model === 'triageVerdict') {
      const result = store.testResult.find((candidate) => candidate.id === row.testResultId);
      if (!result) return false;
      const spec = cond as Row;
      if (spec.run) {
        return Object.entries(spec.run as Row).every(([field, want]) =>
          matchesCondition((result.run as Row | undefined)?.[field] ?? null, want),
        );
      }
      return true;
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
    if (key === 'testResult' && model === 'triageVerdict') {
      const result = store.testResult.find((candidate) => candidate.id === row.testResultId);
      out.testResult = result
        ? projectRow('testResult', result, (want as Row).select, store)
        : null;
      continue;
    }
    // `run` and `test` are stored inline on the fixture; the route reads them
    // through nested selects and never filters on their fields here.
    if ((key === 'run' || key === 'test') && model === 'testResult') {
      out[key] = row[key] ?? null;
      continue;
    }
    throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
  }
  return out;
}

function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where), store));

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        const found = store[name].find((row) => row.id === where.id);
        if (!found) return null;
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
      count: async ({ where }: Row = {}) => select(where).length,
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
const OTHER_PROJECT = 'proj_2';

interface VerdictFixture {
  id: string;
  testId: string;
  name: string;
  filePath: string;
  assigneeUserId?: string | null;
  assigneeTeamId?: string | null;
  /** Deliberately `undefined` for "nothing has tried to route this yet". */
  ownerState?: string | null;
  projectId?: string;
  orgId?: string;
}

let clock = Date.UTC(2026, 0, 1);
const nextDate = (): Date => new Date((clock += 1000));

function seed(verdicts: VerdictFixture[]): Store {
  const store: Store = {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_PROJECT, orgId: ORG, name: 'Admin' },
    ],
    test: [],
    testResult: [],
    triageVerdict: [],
    ownershipRule: [],
    user: [
      { id: 'user_dana', name: 'Dana Klein', email: 'dana@acme.test' },
      { id: 'user_sam', name: null, email: 'sam@acme.test' },
    ],
    team: [
      { id: 'team_payments', orgId: ORG, name: 'Payments', slug: 'payments' },
      { id: 'team_qa', orgId: ORG, name: 'QA', slug: 'qa' },
    ],
  };

  for (const fixture of verdicts) {
    const orgId = fixture.orgId ?? ORG;
    const projectId = fixture.projectId ?? PROJECT;
    store.test.push({
      id: fixture.testId,
      orgId,
      projectId,
      name: fixture.name,
      filePath: fixture.filePath,
      suiteId: null,
      feature: null,
    });
    store.testResult.push({
      id: `res_${fixture.id}`,
      orgId,
      runId: `run_${projectId}`,
      testId: fixture.testId,
      status: 'FAILED',
      test: { id: fixture.testId, name: fixture.name, filePath: fixture.filePath },
      run: {
        id: `run_${projectId}`,
        projectId,
        branch: 'main',
        finishedAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    store.triageVerdict.push({
      id: fixture.id,
      orgId,
      testResultId: `res_${fixture.id}`,
      verdict: 'REAL_BUG',
      overriddenTo: null,
      confidence: 0.8,
      reviewState: 'PENDING',
      assigneeUserId: fixture.assigneeUserId ?? null,
      assigneeTeamId: fixture.assigneeTeamId ?? null,
      ownerState: fixture.ownerState ?? null,
      ownerNote: 'because a rule said so',
      ownerRuleId: null,
      assignedAt: fixture.ownerState ? new Date('2026-02-01T00:00:00Z') : null,
      issueUrl: null,
      createdAt: nextDate(),
    });
  }

  return store;
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { teamRouter } = await import('./team.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
// Mounted where index.ts mounts it.
app.use('/team', teamRouter);
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

beforeEach(() => {
  h.actor = { userId: 'user_dana', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null };
  h.audits.length = 0;
});

/** Three failures: one Dana's, one the payments team's, one nothing has routed. */
const QUEUE: VerdictFixture[] = [
  {
    id: 'tv_dana',
    testId: 't1',
    name: 'checkout applies a promo code',
    filePath: 'specs/checkout.spec.ts',
    assigneeUserId: 'user_dana',
    ownerState: 'OWNED',
  },
  {
    id: 'tv_payments',
    testId: 't2',
    name: 'refund posts to the ledger',
    filePath: 'specs/refunds.spec.ts',
    assigneeTeamId: 'team_payments',
    ownerState: 'OWNED',
  },
  {
    id: 'tv_unrouted',
    testId: 't3',
    name: 'cart badge updates',
    filePath: 'specs/cart.spec.ts',
  },
];

const ids = (body: Row): string[] => (body.verdicts as Row[]).map((row) => row.id);

describe('GET /team/triage', () => {
  it('lists only the verdicts assigned to one user', async () => {
    h.prisma = makeDb(seed(QUEUE));

    const { status, body } = await get('/team/triage?assigneeUserId=user_dana');

    expect(status).toBe(200);
    expect(ids(body)).toEqual(['tv_dana']);
    expect(body.filter).toMatchObject({ assigneeUserId: 'user_dana', assigneeTeamId: null });
  });

  it('lists only the verdicts assigned to one team', async () => {
    h.prisma = makeDb(seed(QUEUE));

    const { body } = await get('/team/triage?assigneeTeamId=team_payments');

    expect(ids(body)).toEqual(['tv_payments']);
  });

  it('refuses a user AND a team — they are opposite filters', async () => {
    h.prisma = makeDb(seed(QUEUE));

    const { status, body } = await get(
      '/team/triage?assigneeUserId=user_dana&assigneeTeamId=team_payments',
    );

    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('not both');
  });

  it('finds the rows nothing has routed, via UNROUTED — the state NULL means', async () => {
    /*
     * The fifth state, and the only one a caller could not previously ask
     * about. `ownerState IS NULL` is "nothing has tried to route this verdict
     * yet" — not NO_RULES (we looked and the table is empty) and not NO_MATCH
     * (we looked and nothing matched). Those rows are exactly the ones nobody
     * is going to pick up, and without the sentinel there is no query that
     * returns them.
     */
    h.prisma = makeDb(seed(QUEUE));

    const { body } = await get('/team/triage?ownerState=UNROUTED');

    expect(ids(body)).toEqual(['tv_unrouted']);
    expect((body.verdicts as Row[])[0]!.ownerState).toBeNull();
  });

  it('does not confuse UNROUTED with NO_RULES or NO_MATCH', async () => {
    h.prisma = makeDb(
      seed([
        ...QUEUE,
        {
          id: 'tv_no_rules',
          testId: 't4',
          name: 'search returns results',
          filePath: 'specs/search.spec.ts',
          ownerState: 'NO_RULES',
        },
        {
          id: 'tv_no_match',
          testId: 't5',
          name: 'login rejects a bad password',
          filePath: 'specs/login.spec.ts',
          ownerState: 'NO_MATCH',
        },
      ]),
    );

    expect(ids((await get('/team/triage?ownerState=UNROUTED')).body)).toEqual(['tv_unrouted']);
    expect(ids((await get('/team/triage?ownerState=NO_RULES')).body)).toEqual(['tv_no_rules']);
    expect(ids((await get('/team/triage?ownerState=NO_MATCH')).body)).toEqual(['tv_no_match']);
  });

  it('finds RULES_UNUSABLE, the state that means routing has silently stopped', async () => {
    h.prisma = makeDb(
      seed([
        ...QUEUE,
        {
          id: 'tv_broken',
          testId: 't6',
          name: 'admin page loads',
          filePath: 'specs/admin.spec.ts',
          ownerState: 'RULES_UNUSABLE',
        },
      ]),
    );

    const { body } = await get('/team/triage?ownerState=RULES_UNUSABLE');

    expect(ids(body)).toEqual(['tv_broken']);
    // The reason sentence comes with it, or the state looks like NO_MATCH.
    expect((body.verdicts as Row[])[0]!.ownerNote).toBe('because a rule said so');
  });

  it('400s on an ownerState it does not know, rather than returning nothing', async () => {
    /*
     * The reassuring lie this avoids: an empty list reads as "you have nothing
     * assigned", and that must not be what a typo produces. Same rule the
     * surface report's filters follow.
     */
    h.prisma = makeDb(seed(QUEUE));

    const { status, body } = await get('/team/triage?ownerState=MINE');

    expect(status).toBe(400);
    expect(String(body.error?.message ?? body.message)).toContain('OWNED');
  });

  it('narrows to one project through the run, without leaking the other one', async () => {
    h.prisma = makeDb(
      seed([
        ...QUEUE,
        {
          id: 'tv_other_project',
          testId: 't7',
          name: 'admin invites a user',
          filePath: 'specs/invites.spec.ts',
          assigneeUserId: 'user_dana',
          ownerState: 'OWNED',
          projectId: OTHER_PROJECT,
        },
      ]),
    );

    const mine = await get('/team/triage?assigneeUserId=user_dana');
    expect(ids(mine.body).sort()).toEqual(['tv_dana', 'tv_other_project']);

    const scoped = await get(`/team/triage?assigneeUserId=user_dana&projectId=${PROJECT}`);
    expect(ids(scoped.body)).toEqual(['tv_dana']);
  });

  it('says the list is a page, and how big the queue really is', async () => {
    /*
     * For this question the COUNT is the answer — "am I three failures behind
     * or four hundred?" — so a silently truncated list answers it wrongly.
     */
    h.prisma = makeDb(
      seed(
        Array.from({ length: 5 }, (_, index) => ({
          id: `tv_${index}`,
          testId: `t_${index}`,
          name: `test ${index}`,
          filePath: `specs/${index}.spec.ts`,
          assigneeUserId: 'user_dana',
          ownerState: 'OWNED',
        })),
      ),
    );

    const { body } = await get('/team/triage?assigneeUserId=user_dana&limit=2');

    expect(body.returned).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.total).toBe(5);
    expect(body.truncated).toBe(true);
  });

  it('does not claim truncation when the whole queue fits', async () => {
    h.prisma = makeDb(seed(QUEUE));

    const { body } = await get('/team/triage?assigneeUserId=user_dana');

    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it('is scoped to the caller’s org', async () => {
    h.prisma = makeDb(
      seed([
        {
          id: 'tv_elsewhere',
          testId: 't9',
          name: 'another org’s failure',
          filePath: 'specs/elsewhere.spec.ts',
          assigneeUserId: 'user_dana',
          ownerState: 'OWNED',
          orgId: 'org_2',
        },
      ]),
    );

    const { body } = await get('/team/triage?assigneeUserId=user_dana');

    expect(body.verdicts).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('is above VIEWER, like every other read on this router', async () => {
    h.prisma = makeDb(seed(QUEUE));
    h.actor = { ...h.actor, role: 'VIEWER' };

    expect((await get('/team/triage?assigneeUserId=user_dana')).status).toBe(403);
  });
});

// ─── GET /team/ownership/resolve — one select, one spelling ──────────────────

describe('GET /team/ownership/resolve', () => {
  const rule = (over: Row = {}): Row => ({
    id: `rule_${over.position ?? 0}`,
    orgId: ORG,
    projectId: PROJECT,
    position: 0,
    pathPattern: null,
    testId: null,
    suiteId: null,
    feature: null,
    ownerUserId: null,
    ownerTeamId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  function withRules(rules: Row[]): Store {
    const store = seed(QUEUE);
    store.ownershipRule.push(...rules);
    return store;
  }

  it('labels a team the way the digest and the ticket label it', async () => {
    // One spelling, in one place. `@payments` here and `Payments` in a ticket
    // reads as two different owners to the person skimming both.
    h.prisma = makeDb(
      withRules([rule({ pathPattern: 'specs/**', ownerTeamId: 'team_payments' })]),
    );

    const { status, body } = await get(`/team/ownership/resolve?projectId=${PROJECT}&testIds=t1`);

    expect(status).toBe(200);
    expect((body.tests as Row[])[0]!.owner).toMatchObject({
      kind: 'TEAM',
      id: 'team_payments',
      label: '@payments',
    });
  });

  it('falls back to a user’s email when they have no name', async () => {
    h.prisma = makeDb(withRules([rule({ pathPattern: 'specs/**', ownerUserId: 'user_sam' })]));

    const { body } = await get(`/team/ownership/resolve?projectId=${PROJECT}&testIds=t1`);

    expect((body.tests as Row[])[0]!.owner.label).toBe('sam@acme.test');
  });

  it('says "a deleted team" rather than rendering nothing', async () => {
    // Should be unreachable — deleting a team cascades its rules away — and it
    // says something true if it ever is reached.
    h.prisma = makeDb(withRules([rule({ pathPattern: 'specs/**', ownerTeamId: 'team_gone' })]));

    const { body } = await get(`/team/ownership/resolve?projectId=${PROJECT}&testIds=t1`);

    expect((body.tests as Row[])[0]!.owner.label).toBe('a deleted team');
  });

  it('asks for `position` — the field a hand-copied select loses silently', async () => {
    /*
     * A select that forgets `position` does not fail. Every rule comes back
     * with position 0, the sort becomes a no-op, and last-match-wins inverts
     * into first-match-wins — which routes a whole suite to the catch-all rule
     * while looking perfectly correct. Asserted on the QUERY because that is
     * where the loss happens; the precedence it protects is pinned in
     * lib/ownership.test.ts.
     */
    const queries: Row[] = [];
    const store = withRules([]);
    h.prisma = makeDb(store);
    const real = (h.prisma as Row).ownershipRule.findMany;
    (h.prisma as Row).ownershipRule = {
      findMany: async (args: Row) => {
        queries.push(args);
        return real(args);
      },
    };

    await get(`/team/ownership/resolve?projectId=${PROJECT}&testIds=t1`);

    expect(queries[0]!.select).toMatchObject({
      id: true,
      position: true,
      pathPattern: true,
      testId: true,
      suiteId: true,
      feature: true,
      ownerUserId: true,
      ownerTeamId: true,
    });
  });
});
