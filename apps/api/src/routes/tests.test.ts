/**
 * Tests for the retirement apply and revert endpoints.
 *
 * ── WHY THESE EXIST, AND WHY THEY ARE REQUESTS AND NOT FUNCTION CALLS ───────
 *
 * The obsolescence machinery was built over three rounds and connected to
 * nobody: `ObsoleteTestSignal` rows were written on every crawl, a sweep in the
 * worker expired `RetirementProposal` rows nothing inserted, and
 * `Test.disabledAt` — the one column a retirement exists to set — had no writer
 * at all. So every test below drives an HTTP REQUEST through the mounted
 * router. A call graph is not evidence that a surface is reachable; a 200 from
 * a port is.
 *
 * ── WHAT IS BEING PROTECTED ─────────────────────────────────────────────────
 *
 * A retirement DISABLES A HUMAN'S TEST. That makes it the sharpest version of
 * "never destroy human work", and four properties carry the whole promise:
 *
 *   1. IT IS REVERSIBLE, AND EXACTLY. `disabledVersion` is written in the same
 *      transaction as `disabledAt`; without it the revert would have to guess
 *      which version came before, and restoring the wrong code destroys the
 *      work by a different route than deleting it.
 *   2. THE SURFACES GO BACK TO UNCOVERED AND THE DENOMINATOR DOES NOT MOVE. A
 *      retirement that raised the coverage percentage would make "delete the
 *      failing tests" the fastest way to hit a target.
 *   3. THE TWO STATUSES IT MAY NOT TOUCH STAY UNTOUCHED. A WAIVED item is
 *      outside the denominator — flipping it would GROW the denominator and
 *      overrule a signed human decision. An UNKNOWN item is neither covered
 *      nor a gap, and minting a gap out of it is a claim static extraction
 *      cannot support.
 *   4. IT NEEDS AN ADMIN, and the suppression constructor is asked here —
 *      because this is the only point in the path where a named human exists.
 *
 * NO DATABASE AND NO NETWORK. An in-memory Prisma stand-in behind
 * `vi.mock('../lib/prisma.js')`, the same pattern record.test.ts uses, and it
 * HONOURS `select` — the apply path reads `Test.code` and `CoverageItem.status`
 * through one, and a select-blind fake would make deleting either undetectable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    actor: { userId: 'user_admin', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
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

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = ['test', 'testVersion', 'retirementProposal', 'coverageItem'] as const;
type ModelName = (typeof MODELS)[number];

function matchOne(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    const filter = cond as Row;
    if ('in' in filter) return (filter.in as unknown[]).includes(value);
    if ('not' in filter) return !matchOne(value, filter.not);
    throw new Error(`fake prisma: unsupported filter ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => matchOne(row[key], cond));
}

/**
 * HONOURS `select`. Load-bearing twice over: the apply path writes the test's
 * OWN code into the retirement version (so deleting `code` from that select
 * would write `undefined` as the code a revert restores), and it reads
 * `CoverageItem.status` to decide which surfaces it may not touch.
 */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) if (value === true) out[key] = row[key];
  return out;
}

/** `orderBy` on a scalar, single clause or array. `findFirst` depends on it. */
function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      for (const [key, direction] of Object.entries(clause)) {
        const a = left[key];
        const b = right[key];
        if (a === b) continue;
        if (a == null) return 1;
        if (b == null) return -1;
        return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      }
    }
    return 0;
  });
}

const DEFAULTS: Record<ModelName, Row> = {
  test: { disabledAt: null, quarantined: false, suiteId: null, feature: null },
  testVersion: { authorId: null, message: null },
  retirementProposal: {
    state: 'PROPOSED',
    ownerUserId: null,
    ownerTeamId: null,
    ownerState: 'NO_RULES',
    ownerProvenance: 'NONE',
    signalIds: [],
    surfacesReturnedToUncovered: [],
    surfacesStillCovered: [],
    surfacesReopened: false,
    healProposalId: null,
    decidedBy: null,
    decidedAt: null,
    appliedAt: null,
    appliedBy: null,
    disabledVersion: null,
    revertedAt: null,
    revertedBy: null,
  },
  coverageItem: { status: 'COVERED' },
};

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;

  /** `{ testId_version: { ... } }` and friends, flattened into a plain where. */
  const flatten = (where: Row): Row => {
    const out: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (value && typeof value === 'object' && key.includes('_')) Object.assign(out, value);
      else out[key] = value;
    }
    return out;
  };

  const makeModel = (name: ModelName) => {
    const rows = () => tables[name];
    const insert = (data: Row): Row => {
      const row: Row = { id: `${name}_${++ids}`, ...DEFAULTS[name], ...data };
      rows().push(row);
      return row;
    };
    return {
      __insert: insert,
      create: async ({ data, select }: Row) => project(insert(data), select),
      findUnique: async ({ where, select }: Row) => {
        const row = rows().find((r) => matches(r, flatten(where)));
        return row ? project(row, select) : null;
      },
      findFirst: async ({ where = {}, orderBy, select }: Row = {}) => {
        const found = sortRows(
          rows().filter((r) => matches(r, flatten(where))),
          orderBy,
        );
        return found[0] ? project(found[0], select) : null;
      },
      findMany: async ({ where = {}, orderBy, take, select }: Row = {}) => {
        const found = sortRows(
          rows().filter((r) => matches(r, flatten(where))),
          orderBy,
        );
        return found.slice(0, take ?? found.length).map((r) => project(r, select));
      },
      update: async ({ where, data, select }: Row) => {
        const row = rows().find((r) => matches(r, flatten(where)));
        if (!row) throw new Error(`fake prisma: no ${name} to update`);
        Object.assign(row, data);
        return project(row, select);
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const found = rows().filter((r) => matches(r, flatten(where)));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
    } as Row;
  };

  const client: Record<string, unknown> = {
    /*
     * The callback form, handed THIS SAME client, so a row written inside is
     * visible afterwards. The fake does NOT roll back, and that is stated
     * rather than implied: no test here asserts that a failed apply left
     * nothing behind, because this fake could not prove it. What it CAN prove
     * is that all four writes happen on the success path, which is the half a
     * reviewer would otherwise take on trust.
     */
    $transaction: async (operations: unknown) => {
      if (typeof operations === 'function') {
        return (operations as (tx: unknown) => Promise<unknown>)(client);
      }
      return Promise.all(operations as Promise<unknown>[]);
    },
  };
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const tests = await import('./tests.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/tests', tests.testsRouter);
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
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

let db: ReturnType<typeof makeDb>;

const CODE = "test('checkout pays', async ({ page }) => { await page.goto('/checkout'); });";
const FUTURE = new Date(Date.now() + 5 * 86_400_000);

function seed(over: { proposal?: Row; test?: Row; items?: Row[]; versions?: Row[] } = {}): void {
  (db.client.test as Row).__insert({
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'checkout pays',
    filePath: 'tests/checkout.spec.ts',
    code: CODE,
    ...over.test,
  });
  (db.client.testVersion as Row).__insert({
    id: 'ver_1',
    orgId: 'org_1',
    testId: 'test_1',
    version: 1,
    code: CODE,
    source: 'HUMAN',
    authorId: 'user_author',
  });
  for (const version of over.versions ?? []) (db.client.testVersion as Row).__insert(version);
  (db.client.retirementProposal as Row).__insert({
    id: 'ret_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    testId: 'test_1',
    reason: 'Obsolete: ROUTE_GONE confirmed by at least 2 accepted crawls.',
    expiresAt: FUTURE,
    surfacesReturnedToUncovered: ['item_a'],
    surfacesStillCovered: ['item_b'],
    denominatorNote: 'Retiring this test returns 1 surface to UNCOVERED.',
    ...over.proposal,
  });
  for (const item of over.items ?? [{ id: 'item_a', orgId: 'org_1', status: 'COVERED' }]) {
    (db.client.coverageItem as Row).__insert(item);
  }
}

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_admin', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
});

// ─── 1. The apply path ───────────────────────────────────────────────────────

describe('POST /tests/:testId/retirements/:proposalId/apply', () => {
  it('disables the test, writes the version, records its number and re-opens the surface — in one request', async () => {
    seed();

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    expect(status).toBe(200);
    expect(body.applied).toBe(true);

    // 1. The test stops running.
    expect(db.tables.test[0]!.disabledAt).toBeInstanceOf(Date);

    /*
     * 2. The version, with the code UNCHANGED. A retirement disables a test; it
     * does not rewrite one. If this were anything other than the code as it
     * stood, the revert would restore the wrong thing — which is destroying
     * human work by a different route than deleting it.
     */
    const written = db.tables.testVersion.find((row) => row.version === 2)!;
    expect(written.code).toBe(CODE);
    expect(written.source).toBe('RETIREMENT');
    expect(written.authorId).toBe('user_admin');

    /*
     * 3. The version NUMBER on the proposal. Without it an applied retirement
     * cannot be undone except by guessing, and a retirement that cannot be
     * undone is a deletion.
     */
    const proposal = db.tables.retirementProposal[0]!;
    expect(proposal.state).toBe('APPLIED');
    expect(proposal.disabledVersion).toBe(2);
    expect(proposal.appliedBy).toBe('user_admin');
    expect(proposal.surfacesReopened).toBe(true);

    // 4. The surface goes back to UNCOVERED.
    expect(db.tables.coverageItem[0]!.status).toBe('UNCOVERED');
    expect(body.surfaces.reopened).toEqual(['item_a']);
  });

  it('does not touch the surfaces another live test still covers', async () => {
    seed({
      items: [
        { id: 'item_a', orgId: 'org_1', status: 'COVERED' },
        { id: 'item_b', orgId: 'org_1', status: 'COVERED' },
      ],
    });

    await call('POST', '/tests/test_1/retirements/ret_1/apply');

    /*
     * `item_b` is in `surfacesStillCovered`, not in `surfacesReturnedToUncovered`
     * — another live test reaches it. Re-opening it would make the coverage
     * number fall FURTHER than the truth, which is a lie in the alarming
     * direction and exactly as disqualifying as one in the flattering direction.
     */
    expect(db.tables.coverageItem.find((row) => row.id === 'item_b')!.status).toBe('COVERED');
  });

  it('REFUSES to re-open a WAIVED surface, because that would GROW the denominator', async () => {
    seed({ items: [{ id: 'item_a', orgId: 'org_1', status: 'WAIVED' }] });

    const { body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    /*
     * A WAIVED item is the ONE status outside the coverage denominator, so
     * flipping it to UNCOVERED pushes it back IN — and does so by overruling a
     * decision a human made and signed. Rule 11 does not permit a retirement to
     * do that, and the hold is NAMED rather than silently skipped: a count that
     * quietly excluded it would be a cap applied without being disclosed.
     */
    expect(db.tables.coverageItem[0]!.status).toBe('WAIVED');
    expect(body.surfaces.held).toEqual([{ itemId: 'item_a', hold: 'WAIVED' }]);
    expect(body.surfaces.reopened).toEqual([]);
    // The arithmetic closes: everything claimed is either re-opened or held.
    expect(body.surfaces.accountedFor).toBe(1);
  });

  it('REFUSES to mint a gap out of an UNKNOWN surface', async () => {
    seed({ items: [{ id: 'item_a', orgId: 'org_1', status: 'UNKNOWN' }] });

    const { body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    // UNKNOWN is never counted as covered and never counted as a gap. Flipping
    // it would claim a gap static extraction could not read.
    expect(db.tables.coverageItem[0]!.status).toBe('UNKNOWN');
    expect(body.surfaces.held).toEqual([{ itemId: 'item_a', hold: 'UNKNOWN' }]);
  });

  it('accounts for a surface that has since been deleted rather than losing it', async () => {
    seed({ items: [] });

    const { body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    expect(body.surfaces.held).toEqual([{ itemId: 'item_a', hold: 'MISSING' }]);
    expect(body.surfaces.accountedFor).toBe(1);
  });

  it('names every held surface in the AUDIT LOG, not only in the response', async () => {
    seed({ items: [{ id: 'item_a', orgId: 'org_1', status: 'WAIVED' }] });

    await call('POST', '/tests/test_1/retirements/ret_1/apply');

    /*
     * A retirement whose surfaces stayed covered has to be reconstructable from
     * the audit log months later. The response is read once; the log is what
     * somebody has when a customer disputes the number.
     */
    const entry = h.audits.find((row) => row.action === 'test.retirement.apply')!;
    expect(entry.metadata.surfacesHeld).toEqual([{ itemId: 'item_a', hold: 'WAIVED' }]);
    expect(entry.metadata.surfacesReopened).toBe(0);
    expect(entry.metadata.disabledVersion).toBe(2);
    expect(entry.targetId).toBe('test_1');
  });

  it('is idempotent: a retried request writes no second version', async () => {
    seed();

    await call('POST', '/tests/test_1/retirements/ret_1/apply');
    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    /*
     * Not a 409. The caller asked for this test to be retired and it is; a
     * double-click or a lost response must not mint a second `TestVersion` —
     * which would also move `disabledVersion` off the version that actually
     * disabled the test and make the revert restore the wrong code.
     */
    expect(status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(db.tables.testVersion.filter((row) => row.source === 'RETIREMENT')).toHaveLength(1);
    expect(db.tables.retirementProposal[0]!.disabledVersion).toBe(2);
  });

  it('needs an ADMIN', async () => {
    seed();
    h.actor = { userId: 'user_member', orgId: 'org_1', role: 'MEMBER', ip: null };

    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    expect(status).toBe(403);
    expect(db.tables.test[0]!.disabledAt).toBeNull();
  });

  it('refuses a proposal whose review window has passed', async () => {
    seed({ proposal: { expiresAt: new Date(Date.now() - 1_000) } });

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    /*
     * Enforced at the READ and not only by the sweep that moves the row to
     * EXPIRED. A sweep that WERE the enforcement point would be a window in
     * which stale evidence could still disable a test — the one rule the
     * suppression keystone marks as impossible-to-get-wrong.
     */
    expect(status).toBe(409);
    expect(body.error.message).toContain('review window');
    expect(db.tables.test[0]!.disabledAt).toBeNull();
  });

  it('refuses to apply over a REJECTED decision', async () => {
    seed({ proposal: { state: 'REJECTED' } });

    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    expect(status).toBe(409);
    expect(db.tables.test[0]!.disabledAt).toBeNull();
  });

  it('refuses when the path and the proposal name different tests', async () => {
    seed({ proposal: { testId: 'test_other' } });

    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    // Preferring either silently would disable a test the caller did not name.
    expect(status).toBe(404);
    expect(db.tables.test[0]!.disabledAt).toBeNull();
  });

  it('refuses a test that is already disabled', async () => {
    seed({ test: { disabledAt: new Date('2026-10-01T00:00:00.000Z') } });

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/apply');

    // A version written now would not be the one a revert needs.
    expect(status).toBe(409);
    expect(body.error.message).toContain('already disabled');
  });

  it('numbers the version after the newest, not after the one it read first', async () => {
    seed({
      versions: [
        { id: 'ver_2', orgId: 'org_1', testId: 'test_1', version: 2, code: CODE, source: 'HEALER' },
        { id: 'ver_3', orgId: 'org_1', testId: 'test_1', version: 3, code: CODE, source: 'HUMAN' },
      ],
    });

    await call('POST', '/tests/test_1/retirements/ret_1/apply');

    // `@@unique([testId, version])` — a version number that collided would
    // throw in production and leave the test disabled with nothing to revert to.
    expect(db.tables.retirementProposal[0]!.disabledVersion).toBe(4);
  });
});

// ─── 2. The revert path ──────────────────────────────────────────────────────

describe('POST /tests/:testId/retirements/:proposalId/revert', () => {
  async function applied(over: Parameters<typeof seed>[0] = {}): Promise<void> {
    seed(over);
    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/apply');
    expect(status).toBe(200);
  }

  it('re-enables the test from the exact version the apply recorded', async () => {
    await applied();

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    expect(status).toBe(200);
    expect(db.tables.test[0]!.disabledAt).toBeNull();
    expect(db.tables.test[0]!.code).toBe(CODE);
    // From `disabledVersion`, not from "whatever came before the newest".
    expect(body.restoredFromVersion).toBe(2);
    expect(db.tables.retirementProposal[0]!.state).toBe('REVERTED');
    expect(db.tables.retirementProposal[0]!.revertedBy).toBe('user_admin');
  });

  it('writes a NEW version instead of rewriting the history', async () => {
    await applied();

    await call('POST', '/tests/test_1/retirements/ret_1/revert');

    /*
     * The history is the audit trail. Rolling it back to make the revert tidy
     * would destroy the record of the retirement having happened, which is
     * exactly what "we retired this and put it back" has to stay answerable
     * from.
     */
    const versions = db.tables.testVersion.map((row) => row.version).sort();
    expect(versions).toEqual([1, 2, 3]);
    expect(db.tables.testVersion.find((row) => row.version === 3)!.message).toContain(
      'restored version 2',
    );
  });

  it('re-closes the surface to ASSERTED_NOT_RUN and NOT to COVERED', async () => {
    await applied();
    expect(db.tables.coverageItem[0]!.status).toBe('UNCOVERED');

    const { body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    /*
     * COVERED in this product means a matched test was OBSERVED to run. The
     * test exists again and no run has executed it since, so writing COVERED
     * here would manufacture an observation — and a revert would then RAISE the
     * coverage percentage on no evidence at all. The note says so out loud,
     * because a reviewer who reverts and watches the number not move will
     * otherwise assume the revert failed.
     */
    expect(db.tables.coverageItem[0]!.status).toBe('ASSERTED_NOT_RUN');
    expect(body.surfacesReclosed).toBe(1);
    expect(body.coverageNote).toContain('ASSERTED_NOT_RUN');
    expect(body.coverageNote).toContain('not now');
  });

  it('leaves a surface somebody has since WAIVED alone', async () => {
    await applied();
    db.tables.coverageItem[0]!.status = 'WAIVED';

    const { body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    // A decision made AFTER the retirement is not this revert's business.
    expect(db.tables.coverageItem[0]!.status).toBe('WAIVED');
    expect(body.surfacesReclosed).toBe(0);
  });

  it('refuses to guess when no disabled version was recorded', async () => {
    seed({ proposal: { state: 'APPLIED', disabledVersion: null } });

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    /*
     * The alternative is picking "the version before the newest", which is a
     * guess about the customer's code — and restoring the wrong version
     * destroys their work by a different route than deleting it.
     */
    expect(status).toBe(409);
    expect(body.error.message).toContain('not knowable');
  });

  it('refuses when the recorded version has gone from the history', async () => {
    seed({ proposal: { state: 'APPLIED', disabledVersion: 99 } });

    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    expect(status).toBe(409);
    expect(body.error.message).toContain('cannot be exact');
  });

  it('refuses to revert a proposal that was never applied', async () => {
    seed();

    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    expect(status).toBe(409);
  });

  it('is idempotent', async () => {
    await applied();

    await call('POST', '/tests/test_1/retirements/ret_1/revert');
    const { status, body } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    expect(status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(db.tables.testVersion).toHaveLength(3);
  });

  it('needs an ADMIN', async () => {
    await applied();
    h.actor = { userId: 'user_member', orgId: 'org_1', role: 'MEMBER', ip: null };

    const { status } = await call('POST', '/tests/test_1/retirements/ret_1/revert');

    expect(status).toBe(403);
    expect(db.tables.test[0]!.disabledAt).toBeInstanceOf(Date);
  });

  it('audits the revert with the actor and both version numbers', async () => {
    await applied();
    h.audits.length = 0;

    await call('POST', '/tests/test_1/retirements/ret_1/revert');

    const entry = h.audits.find((row) => row.action === 'test.retirement.revert')!;
    expect(entry.metadata.restoredFromVersion).toBe(2);
    expect(entry.metadata.writtenAsVersion).toBe(3);
    expect(entry.actor.userId).toBe('user_admin');
  });
});

// ─── 3. The partition, as a function ─────────────────────────────────────────

describe('partitionReopen', () => {
  it('accounts for every claimed surface exactly once', () => {
    const ledger = tests.partitionReopen(['a', 'b', 'c', 'd', 'e'], [
      { id: 'a', status: 'COVERED' },
      { id: 'b', status: 'ASSERTED_NOT_RUN' },
      { id: 'c', status: 'WAIVED' },
      { id: 'd', status: 'UNKNOWN' },
      // 'e' is missing entirely.
    ]);

    expect(ledger.reopened).toEqual(['a', 'b']);
    expect(ledger.held).toEqual([
      { itemId: 'c', hold: 'WAIVED' },
      { itemId: 'd', hold: 'UNKNOWN' },
      { itemId: 'e', hold: 'MISSING' },
    ]);
    /*
     * The arithmetic has to close. A partition that lost an item would be a
     * surface the retirement claimed, did not re-open, and did not report —
     * which is a failure suppressed without being counted.
     */
    expect(ledger.accountedFor).toBe(5);
  });

  it('counts an already-UNCOVERED surface rather than reporting it as re-opened', () => {
    const ledger = tests.partitionReopen(['a'], [{ id: 'a', status: 'UNCOVERED' }]);
    expect(ledger.reopened).toEqual([]);
    expect(ledger.held).toEqual([{ itemId: 'a', hold: 'ALREADY_UNCOVERED' }]);
  });
});
