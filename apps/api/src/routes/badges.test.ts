/**
 * Tests for GET /badges — the shell's four counts.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. It is TENANT-SCOPED, in both directions and on all four numbers. The
 *      endpoint takes `projectId` straight off the query string and its only
 *      defence is that every count runs through the scoped `prisma` client —
 *      which is invisible at the call site, because there is deliberately no
 *      orgId in any `where`. The fake below applies the scope the way the real
 *      extension does, and every assertion is made from two orgs whose rows are
 *      interleaved. Swap one `count` for `unscoped(...)` and a test here fails;
 *      nothing else in the repo would notice.
 *
 *      The sharpest case is the one a plain "does it count?" test misses:
 *      asking for ANOTHER ORG'S projectId. That must come back as this org's
 *      zero, not as that org's number and not as an error that confirms the
 *      project exists.
 *
 *   2. Each count MATCHES THE LIST ENDPOINT IT REPLACES. A badge is only worth
 *      having if it agrees with the screen behind it, so the fixtures include
 *      exactly the rows each filter must reject — a PASSED run, a reviewed
 *      verdict, an approved heal — and the expected numbers are written out by
 *      hand rather than derived from the same filter the route uses. A test
 *      whose two sides both come from the code under test proves nothing.
 *
 *   3. It COUNTS rather than lists. That is the entire point of the endpoint:
 *      the sidebar used to pull twenty-five runs and a hundred verdicts to
 *      render two integers. The fake therefore offers NO `findMany` on
 *      TriageVerdict or HealProposal at all — an implementation that goes back
 *      to fetching rows throws instead of passing slowly.
 *
 * Harness: same shape as projects.tree.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  /** Every operation the router issued, as `model.operation`. */
  ops: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  ops: [],
}));

vi.mock('../env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_PUBLIC_URL: 'https://app.qaai.test' },
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

/*
 * The tenancy scope is real, not stubbed: the route's queries run in the async
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

vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

/**
 * The filters this route is allowed to use. Anything else throws rather than
 * being quietly ignored — a fake that shrugs at `state: 'PROPOSED'` would pass
 * the test that proves decided heals are excluded.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  run: new Set(['id', 'orgId', 'projectId', 'status']),
  triageVerdict: new Set(['id', 'orgId', 'reviewState']),
  healProposal: new Set(['id', 'orgId', 'state']),
  coverageSnapshot: new Set(['id', 'orgId', 'projectId']),
  /*
   * `scopeKey` is in here because the coverage badge reads the HEADLINE scope
   * and not whichever history row is newest: a per-feature row would carry that
   * feature's delta, and a badge showing one feature's change as the project's
   * is the shape of wrong answer nobody would catch from the number alone.
   */
  coverageHistory: new Set(['id', 'orgId', 'projectId', 'scopeKey']),
};

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return value !== c.not;
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: string, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === right) return 0;
    return (left < right ? -1 : 1) * (dir === 'desc' ? -1 : 1);
  });
}

interface Store {
  run: Row[];
  triageVerdict: Row[];
  healProposal: Row[];
  coverageSnapshot: Row[];
  coverageHistory: Row[];
}

/**
 * A Prisma stand-in that enforces tenancy the way the extension does — merging
 * the ambient orgId into every filterable `where` — because that merge IS the
 * security property under test.
 *
 * `findMany` is offered ONLY on Run, and never on the two models whose badges
 * are pure counts: the endpoint exists so those stop being list fetches, and a
 * regression to `findMany` must fail rather than pass.
 */
function makeDb(store: Store): Row {
  const model = (name: keyof Store, allowFindMany: boolean): Row => {
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where)));

    return {
      count: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.count`);
        return select(where).length;
      },
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        h.ops.push(`${name}.findFirst`);
        const found = sortRows(select(where), orderBy)[0];
        if (!found) return null;
        if (!sel) return { ...found };
        const out: Row = {};
        for (const [key, want] of Object.entries(sel)) if (want === true) out[key] = found[key];
        return out;
      },
      findMany: async ({ where }: Row = {}) => {
        h.ops.push(`${name}.findMany`);
        if (!allowFindMany) {
          throw new Error(`fake prisma: ${name}.findMany — this badge must be a count`);
        }
        return select(where).map((row) => ({ ...row }));
      },
    };
  };

  return {
    run: model('run', true),
    triageVerdict: model('triageVerdict', false),
    healProposal: model('healProposal', false),
    /*
     * `findMany: false` on both, for the same reason as the two above: the
     * coverage badge reads ONE snapshot and ONE history row, and a regression
     * to a list fetch must fail rather than pass. A badge that pulls thirty
     * snapshots to read one percentage is the defect this whole router exists
     * to remove.
     */
    coverageSnapshot: model('coverageSnapshot', false),
    coverageHistory: model('coverageHistory', false),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const at = (iso: string): Date => new Date(iso);

/**
 * Two orgs, interleaved, and inside org_1 two projects. Every row that must be
 * EXCLUDED by some filter is present: a PASSED run, a reviewed verdict, an
 * applied heal. Counted by hand:
 *
 *   org_1, no project scope : liveRuns 3 (r1 QUEUED, r2 RUNNING, r5 QUEUED)
 *   org_1, proj_a           : liveRuns 2 (r1, r2), newest is r3 at 03:00 PASSED
 *   org_1                   : verdicts 2 (v1, v3), heals 1 (h1)
 *   org_2                   : liveRuns 1 (r6), verdicts 1 (v4), heals 2 (h3, h4)
 */
const RUNS: Row[] = [
  { id: 'r1', orgId: 'org_1', projectId: 'proj_a', status: 'QUEUED', queuedAt: at('2026-01-01T01:00:00Z') },
  { id: 'r2', orgId: 'org_1', projectId: 'proj_a', status: 'RUNNING', queuedAt: at('2026-01-01T02:00:00Z') },
  { id: 'r3', orgId: 'org_1', projectId: 'proj_a', status: 'PASSED', queuedAt: at('2026-01-01T03:00:00Z') },
  { id: 'r4', orgId: 'org_1', projectId: 'proj_b', status: 'FAILED', queuedAt: at('2026-01-01T09:00:00Z') },
  { id: 'r5', orgId: 'org_1', projectId: 'proj_b', status: 'QUEUED', queuedAt: at('2026-01-01T04:00:00Z') },
  // Same project id as org_1's, on purpose: the scope must be the org, not the
  // string in the URL.
  { id: 'r6', orgId: 'org_2', projectId: 'proj_a', status: 'RUNNING', queuedAt: at('2026-01-01T23:00:00Z') },
  { id: 'r7', orgId: 'org_2', projectId: 'proj_a', status: 'ERRORED', queuedAt: at('2026-01-01T22:00:00Z') },
];

const VERDICTS: Row[] = [
  { id: 'v1', orgId: 'org_1', reviewState: 'PENDING' },
  { id: 'v2', orgId: 'org_1', reviewState: 'ACCEPTED' },
  { id: 'v3', orgId: 'org_1', reviewState: 'PENDING' },
  { id: 'v4', orgId: 'org_2', reviewState: 'PENDING' },
];

const HEALS: Row[] = [
  { id: 'h1', orgId: 'org_1', state: 'PROPOSED' },
  { id: 'h2', orgId: 'org_1', state: 'APPLIED' },
  { id: 'h3', orgId: 'org_2', state: 'PROPOSED' },
  { id: 'h4', orgId: 'org_2', state: 'PROPOSED' },
];

/**
 * Coverage fixtures, one project per state the badge has to be able to say.
 *
 *   proj_a : MEASURED, with a COMPARABLE delta
 *   proj_b : MEASURED, with an UNCOMPARABLE one (the crawl changed under it)
 *   proj_c : EMPTY_DENOMINATOR — measured, and nothing was enumerated to count
 *   proj_d : no rows at all → NOT_MEASURED
 */
const SNAPSHOTS: Row[] = [
  {
    id: 'snap_a_old',
    orgId: 'org_1',
    projectId: 'proj_a',
    percent: 55,
    denominator: 400,
    covered: 220,
    createdAt: at('2026-01-01T01:00:00Z'),
  },
  {
    id: 'snap_a',
    orgId: 'org_1',
    projectId: 'proj_a',
    percent: 61.4,
    denominator: 412,
    covered: 253,
    createdAt: at('2026-01-02T01:00:00Z'),
  },
  {
    id: 'snap_b',
    orgId: 'org_1',
    projectId: 'proj_b',
    percent: 48,
    denominator: 100,
    covered: 48,
    createdAt: at('2026-01-02T01:00:00Z'),
  },
  /*
   * MEASURED and EMPTY. `percent: null` with `denominator: 0` is a project the
   * enumerator reached nothing in — a crawl to fix, not a figure to improve —
   * and it is deliberately a different state from "nothing was ever measured".
   */
  {
    id: 'snap_c',
    orgId: 'org_1',
    projectId: 'proj_c',
    percent: null,
    denominator: 0,
    covered: 0,
    createdAt: at('2026-01-02T01:00:00Z'),
  },
];

const HISTORY: Row[] = [
  {
    id: 'hist_a',
    orgId: 'org_1',
    projectId: 'proj_a',
    scopeKey: 'HEADLINE',
    deltaPercent: 6.4,
    comparability: 'COMPARABLE',
    comparabilityDetail: 'the same crawl and the same denominator, so the change is real',
    createdAt: at('2026-01-02T01:00:00Z'),
  },
  /*
   * A row that CARRIES a delta and is NOT comparable. The most important
   * fixture in this file: the number is right there in the column, and the
   * badge must refuse to publish it — because the two snapshots were taken
   * against different crawls and measured different applications.
   */
  {
    id: 'hist_b',
    orgId: 'org_1',
    projectId: 'proj_b',
    scopeKey: 'HEADLINE',
    deltaPercent: -9,
    comparability: 'UNCOMPARABLE_CRAWL_CHANGED',
    comparabilityDetail: 'the crawl fingerprint changed between the two',
    createdAt: at('2026-01-02T01:00:00Z'),
  },
  /*
   * A per-FEATURE row for proj_a, NEWER than the headline one. The badge must
   * not pick it up: it would report the payments feature's change as the
   * project's, which nobody could catch from the number alone.
   */
  {
    id: 'hist_a_feature',
    orgId: 'org_1',
    projectId: 'proj_a',
    scopeKey: 'FEATURE=payments',
    deltaPercent: 40,
    comparability: 'COMPARABLE',
    comparabilityDetail: 'the payments feature only',
    createdAt: at('2026-01-03T01:00:00Z'),
  },
];

function install(): void {
  h.prisma = makeDb({
    run: RUNS.map((row) => ({ ...row })),
    triageVerdict: VERDICTS.map((row) => ({ ...row })),
    healProposal: HEALS.map((row) => ({ ...row })),
    coverageSnapshot: SNAPSHOTS.map((row) => ({ ...row })),
    coverageHistory: HISTORY.map((row) => ({ ...row })),
  });
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { badgesRouter } = await import('./badges.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/badges', badgesRouter);
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

const asOrg = (orgId: string): void => {
  h.actor = { userId: `user_of_${orgId}`, orgId, role: 'MEMBER', ip: null };
};

beforeEach(() => {
  asOrg('org_1');
  h.ops.length = 0;
  install();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /badges', () => {
  it('counts only rows the badge would show, org-wide', async () => {
    const { status, body } = await get('/badges');
    expect(status).toBe(200);
    // liveRuns excludes PASSED and FAILED; verdicts excludes ACCEPTED; heals
    // excludes APPLIED. All three exclusions are in the fixtures above.
    expect(body).toEqual({ liveRuns: 3, lastRunStatus: 'FAILED', verdicts: 2, heals: 1 });
  });

  it('scopes the run numbers to projectId, and only the run numbers', async () => {
    const { body } = await get('/badges?projectId=proj_a');
    expect(body.liveRuns).toBe(2);
    expect(body.lastRunStatus).toBe('PASSED');
    // Triage is an org-wide queue and has no project column; scoping the runs
    // must not quietly scope these too.
    expect(body.verdicts).toBe(2);
    expect(body.heals).toBe(1);
  });

  it("reports another org's numbers as this org's zero", async () => {
    // proj_a exists in BOTH orgs. Seen from org_2, org_1's five runs on it are
    // not fewer, not an error, and not a 404 that confirms the project — they
    // are simply not this caller's rows.
    asOrg('org_2');
    const { status, body } = await get('/badges?projectId=proj_b');
    expect(status).toBe(200);
    expect(body).toEqual({ liveRuns: 0, lastRunStatus: null, verdicts: 1, heals: 2 });
  });

  it('never lets one org see another org, on any of the four numbers', async () => {
    const first = (await get('/badges')).body;
    asOrg('org_2');
    const second = (await get('/badges')).body;

    expect(first).toEqual({ liveRuns: 3, lastRunStatus: 'FAILED', verdicts: 2, heals: 1 });
    expect(second).toEqual({ liveRuns: 1, lastRunStatus: 'RUNNING', verdicts: 1, heals: 2 });

    // Every number differs between the two orgs, so an unscoped query anywhere
    // in the handler shows up as one of them taking the other's value.
    expect(second.liveRuns).not.toBe(first.liveRuns);
    expect(second.verdicts).not.toBe(first.verdicts);
    expect(second.heals).not.toBe(first.heals);
  });

  it('takes lastRunStatus from the newest run, not the first row', async () => {
    // r4 is FAILED and newest; r1 is QUEUED and first in insertion order. The
    // old sidebar read runs[0] out of a list, which is the bug this replaces.
    const { body } = await get('/badges?projectId=proj_b');
    expect(body.lastRunStatus).toBe('FAILED');
  });

  it('ignores a repeated projectId rather than filtering on an array', async () => {
    // A query string is caller-controlled and `?projectId=a&projectId=b` parses
    // to an array under Express's default parser. Handing that straight to a
    // Prisma `where` is how a filter turns into something the caller shapes;
    // the route must treat anything that is not a string as absent, and answer
    // with the unscoped-by-project numbers rather than nothing at all.
    const { status, body } = await get('/badges?projectId=proj_a&projectId=proj_b');
    expect(status).toBe(200);
    expect(body).toEqual({ liveRuns: 3, lastRunStatus: 'FAILED', verdicts: 2, heals: 1 });
  });

  it('answers with counts, not with lists', async () => {
    await get('/badges');
    // Three counts and one single-row read. Any findMany on the triage models
    // would already have thrown inside the fake; this pins the shape of the
    // reads that remain.
    expect(h.ops.sort()).toEqual([
      'healProposal.count',
      'run.count',
      'run.findFirst',
      'triageVerdict.count',
    ]);
  });
});

// ─── The coverage badge ──────────────────────────────────────────────────────

/**
 * A badge that renders 0% for "not measured yet" is the product's own lie in an
 * image — and worse than the same lie on a screen, because an image has no room
 * for a caveat, a README outlives the conversation that produced it, and nobody
 * re-reads a badge they have already believed.
 *
 * So every case below asserts a BRANCH rather than a rounding: four states, and
 * `percent` is null in three of them.
 */
describe('GET /badges/coverage/:projectId', () => {
  beforeEach(() => {
    install();
    asOrg('org_1');
  });

  it('reports a measured project with its figure and its comparable delta', async () => {
    const { status, body } = await get('/badges/coverage/proj_a');

    expect(status).toBe(200);
    expect(body.state).toBe('MEASURED');
    expect(body.percent).toBe(61.4);
    expect(body.denominator).toBe(412);
    expect(body.covered).toBe(253);
    expect(body.deltaPercent).toBe(6.4);
    expect(body.comparability).toBe('COMPARABLE');
    // No reason to print, because the delta itself is the answer.
    expect(body.comparabilityDetail).toBeNull();
  });

  it('reads the HEADLINE history row, not whichever row is newest', async () => {
    /*
     * `hist_a_feature` is newer and says +40. Publishing it would report the
     * payments feature's change as the project's, which is a wrong answer
     * nobody could catch from the number alone.
     */
    const { body } = await get('/badges/coverage/proj_a');
    expect(body.deltaPercent).toBe(6.4);
    expect(body.deltaPercent).not.toBe(40);
  });

  it('REFUSES a delta across two crawl fingerprints, and says why instead', async () => {
    /*
     * The number is in the column. Subtracting two percentages always succeeds,
     * which is exactly why this has to be a refusal: the two snapshots measured
     * different applications, and "coverage fell 9 points" would be read as a
     * regression by everybody who saw it.
     */
    const { body } = await get('/badges/coverage/proj_b');

    expect(body.state).toBe('MEASURED');
    expect(body.percent).toBe(48);
    expect(body.deltaPercent).toBeNull();
    expect(body.comparability).toBe('UNCOMPARABLE_CRAWL_CHANGED');
    expect(String(body.comparabilityDetail)).toContain('crawl fingerprint changed');
  });

  it('says EMPTY_DENOMINATOR, with NO percentage, when nothing was enumerated', async () => {
    const { body } = await get('/badges/coverage/proj_c');

    expect(body.state).toBe('EMPTY_DENOMINATOR');
    // NOT 0, and not 100. The remedy is a crawl, and the label says so.
    expect(body.percent).toBeNull();
    expect(body.label).toBe('nothing to measure');
    expect(String(body.why)).toContain('no percentage');
  });

  it('says NOT_MEASURED, with NO percentage, for a project nothing has measured', async () => {
    const { body } = await get('/badges/coverage/proj_d');

    expect(body.state).toBe('NOT_MEASURED');
    expect(body.percent).toBeNull();
    expect(body.denominator).toBeNull();
    expect(body.label).toBe('not measured');
    // The sentence a renderer shows instead of a figure, and it names the trap.
    expect(String(body.why)).toContain('NOT 0%');
  });

  it('never returns a numeric percentage in any state but MEASURED', async () => {
    /*
     * The property, asserted over every state rather than per case: there is
     * deliberately no field on this payload a renderer could `?? 0` its way out
     * of, because the one that ships is the one that does.
     */
    for (const project of ['proj_c', 'proj_d']) {
      const { body } = await get(`/badges/coverage/${project}`);
      expect(body.state, project).not.toBe('MEASURED');
      expect(body.percent, project).toBeNull();
    }
  });

  it('is scoped to the org, so another tenant\u2019s project reads NOT_MEASURED', async () => {
    /*
     * `proj_a` exists in org_1 and the id is in the URL. From org_2 the scoped
     * client counts org_2's rows — of which there are none — so this comes back
     * as NOT_MEASURED rather than as another tenant's coverage, and the
     * endpoint is not an existence oracle for other people's projects.
     */
    asOrg('org_2');
    const { body } = await get('/badges/coverage/proj_a');

    expect(body.state).toBe('NOT_MEASURED');
    expect(body.percent).toBeNull();
  });

  it('reads one snapshot and one history row, never a list', async () => {
    await get('/badges/coverage/proj_a');
    // `findMany: false` on both delegates would have thrown; this asserts the
    // positive side — the reads that happened are the two single-row ones.
    expect(h.ops).toContain('coverageSnapshot.findFirst');
    expect(h.ops).toContain('coverageHistory.findFirst');
  });
});
