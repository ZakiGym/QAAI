/**
 * The triage feedback doors: mute, unmute, re-triage, history, scorecard.
 *
 * Every endpoint here closes a register defect, so the tests are about the
 * properties a careless edit would break rather than about happy paths:
 *
 *  1. A MUTE HAS AN EXPIRY AND A REASON. Muting forever is the quarantine
 *     mistake, and an unexplained silence is the thing somebody inherits with
 *     no way to evaluate it. The clamp is asserted as a DATE, because a null
 *     that serialised to "null" would satisfy a looser check.
 *  2. A MUTE CANNOT BE MINTED FROM AN HTTP REQUEST. Muting a cause nobody has
 *     ever observed would create an identity — with a first-seen date — for a
 *     failure that never happened.
 *  3. A RE-TRIAGE SUPERSEDES. This endpoint must leave the human's correction
 *     ALONE: the worker archives it. An endpoint that cleared `reviewState`
 *     here would destroy the training signal before the worker ever saw it.
 *  4. THE JOB ID CARRIES THE REVISION. `enqueueTriage` dedupes on
 *     `triage-<resultId>` forever, so reusing that id would let BullMQ swallow
 *     every re-triage after the first — the original defect in a new costume.
 *  5. A SPLIT MEMBER IS NOT DRAGGED BACK. A cause-wide re-triage must skip the
 *     members a human deliberately took out of the cause.
 *  6. THE SCORECARD DOES NOT PRINT 0% FOR "NOBODY CHECKED".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTE_MAX_DAYS } from '@qaai/agent';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  jobs: Array<{ queue: string; payload: Row; opts: Row }>;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  jobs: [],
}));

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
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

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => (h.prisma as Row)[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({
  enqueue: async (queue: string, payload: Row, opts: Row = {}) => {
    h.jobs.push({ queue, payload, opts });
    return String(opts.jobId ?? `job_${h.jobs.length}`);
  },
}));

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

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

// ─── The in-memory store ─────────────────────────────────────────────────────

interface Store {
  project: Row[];
  failureSignature: Row[];
  runFailureCluster: Row[];
  triageVerdict: Row[];
  triageVerdictRevision: Row[];
}

let store: Store;

/** A triage verdict with its result, run and test resolved. */
function hydrateVerdict(row: Row): Row {
  return {
    ...row,
    testResult: {
      id: row.testResultId,
      runId: row.runId,
      run: { projectId: row.projectId ?? 'proj_1' },
      test: { name: row.testName ?? 'a test', filePath: 'tests/x.spec.ts' },
    },
  };
}

function matchesNested(value: unknown, cond: Row): boolean {
  if (!value || typeof value !== 'object') return false;
  const source = value as Row;
  return Object.entries(cond).every(([key, inner]) =>
    inner && typeof inner === 'object' && !(inner instanceof Date)
      ? matchesNested(source[key], inner as Row)
      : source[key] === inner,
  );
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === null) return (row[key] ?? null) === null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(row[key]);
      if ('gt' in c) return row[key] instanceof Date && row[key] > (c.gt as Date);
      if ('gte' in c) return row[key] instanceof Date && row[key] >= (c.gte as Date);
      // A relation filter, modelled: the scorecard and the correction prior both
      // scope by project through `testResult.run.projectId`, and that scoping is
      // the property under test.
      return matchesNested(row[key], c);
    }
    return row[key] === cond;
  });
}

function compositeFind(rows: Row[], where: Row = {}): Row | undefined {
  if (where.id) return rows.find((r) => r.id === where.id);
  const key = where.orgId_projectId_clusterKey as Row | undefined;
  if (key) {
    return rows.find(
      (r) =>
        r.orgId === key.orgId && r.projectId === key.projectId && r.clusterKey === key.clusterKey,
    );
  }
  return undefined;
}

function install(over: Partial<Store> = {}): void {
  store = {
    project: [{ id: 'proj_1', orgId: 'org_1' }],
    failureSignature: [],
    runFailureCluster: [],
    triageVerdict: [],
    triageVerdictRevision: [],
    ...over,
  };

  const verdicts = (): Row[] => store.triageVerdict.map(hydrateVerdict);

  h.prisma = {
    project: {
      findUnique: async (args: Row = {}) =>
        store.project.find((p) => p.id === args.where?.id && p.orgId === h.actor.orgId) ?? null,
    },
    failureSignature: {
      findUnique: async (args: Row = {}) => compositeFind(store.failureSignature, args.where) ?? null,
      findMany: async (args: Row = {}) => {
        const out = store.failureSignature.filter((r) => matches(r, args.where));
        return typeof args.take === 'number' ? out.slice(0, args.take) : out;
      },
      update: async (args: Row = {}) => {
        const found = compositeFind(store.failureSignature, args.where);
        if (!found) throw new Error('fake prisma: no failureSignature');
        Object.assign(found, args.data);
        return found;
      },
    },
    runFailureCluster: {
      findMany: async (args: Row = {}) => {
        // `take` is honoured, not ignored: the cause-detail endpoint reads one
        // row past its cap to decide whether more exist, and a fake that
        // returned everything would make that probe untestable.
        const out = store.runFailureCluster.filter((r) => matches(r, args.where));
        const capped = typeof args.take === 'number' ? out.slice(0, args.take) : out;
        if (!args.select) return capped;
        /*
         * And `select` is APPLIED. Found by a mutation experiment: with the
         * whole row handed back regardless, deleting `resolvedAt: true` from
         * the route's select left every test green — which is exactly the hole
         * the four write-only columns were hiding in. A column the route does
         * not ask for has to come back missing, or a test cannot tell a reader
         * from a dead column.
         */
        return capped.map((row) => {
          const picked: Row = {};
          for (const key of Object.keys(args.select as Row)) picked[key] = row[key] ?? null;
          return picked;
        });
      },
    },
    triageVerdict: {
      findUnique: async (args: Row = {}) => {
        const found = store.triageVerdict.find((v) => v.id === args.where?.id);
        return found ? hydrateVerdict(found) : null;
      },
      findMany: async (args: Row = {}) => {
        const out = verdicts().filter((r) => matches(r, args.where));
        const capped = typeof args.take === 'number' ? out.slice(0, args.take) : out;
        /*
         * `select` is APPLIED here too. It was applied for `runFailureCluster`
         * and not for this model, in the same file and for the same response:
         * dropping `revision: true` from the cause-detail verdict select left
         * every test green. A column the route does not ask for has to come
         * back missing, whichever model it is on.
         */
        if (!args.select) return capped;
        return capped.map((row) => {
          const picked: Row = {};
          for (const key of Object.keys(args.select as Row)) {
            picked[key] = key in row ? row[key] : null;
          }
          return picked;
        });
      },
      /*
       * The exact size of the cause, which is what the fan-out endpoint now
       * reports alongside what it covered. Deliberately NOT derived from the
       * `take`-limited findMany above — the whole point of the count is that it
       * sees past the cap.
       */
      count: async (args: Row = {}) => verdicts().filter((r) => matches(r, args.where)).length,
      updateMany: async (args: Row = {}) => {
        const ids = (args.where?.id?.in ?? []) as string[];
        let count = 0;
        for (const row of store.triageVerdict) {
          if (!ids.includes(row.id)) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
      groupBy: async (args: Row = {}) => {
        const by = args.by as string[];
        const rows = verdicts().filter((r) => matches(r, args.where));
        const buckets = new Map<string, Row>();
        for (const row of rows) {
          const key = by.map((f) => String(row[f])).join('|');
          const found = buckets.get(key);
          if (found) found._count._all += 1;
          else {
            const entry: Row = { _count: { _all: 1 } };
            for (const f of by) entry[f] = row[f] ?? null;
            buckets.set(key, entry);
          }
        }
        return [...buckets.values()];
      },
    },
    triageVerdictRevision: {
      findMany: async (args: Row = {}) => {
        const hydrated = store.triageVerdictRevision.map((r) => ({
          ...r,
          parent: hydrateVerdict(store.triageVerdict.find((v) => v.id === r.verdictId) ?? {}),
        }));
        const out = hydrated.filter((r) => matches(r, args.where));
        return typeof args.take === 'number' ? out.slice(0, args.take) : out;
      },
    },
  };
}

function seedCause(over: Row = {}): Row {
  const row = {
    id: 'sig_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    clusterKey: 'abc123abc123',
    signature: 'class=TimeoutError | call=locator.click',
    label: 'Checkout never appears',
    firstSeenAt: new Date('2026-10-20T10:00:00.000Z'),
    firstSeenRunId: 'run_1',
    lastSeenAt: new Date('2026-10-24T10:00:00.000Z'),
    lastSeenRunId: 'run_9',
    runCount: 4,
    occurrenceCount: 80,
    mutedUntil: null,
    mutedAt: null,
    mutedBy: null,
    mutedReason: null,
    suppressedCount: 0,
    ...over,
  };
  store.failureSignature.push(row);
  return row;
}

function seedVerdict(over: Row = {}): Row {
  const n = store.triageVerdict.length;
  const row = {
    id: `v_${n}`,
    orgId: 'org_1',
    projectId: 'proj_1',
    testResultId: `tr_${n}`,
    runId: 'run_9',
    testName: `checkout ${n}`,
    verdict: 'FLAKE',
    confidence: 0.6,
    explanation: 'timing',
    model: 'cheap',
    clusterKey: 'abc123abc123',
    derivedFromId: null,
    splitFromClusterKey: null,
    revision: 1,
    reviewState: 'PENDING',
    overriddenTo: null,
    reviewedBy: null,
    reviewedAt: null,
    retriageRequestedAt: null,
    retriageRequestedBy: null,
    retriageReason: null,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    ...over,
  };
  store.triageVerdict.push(row);
  return row;
}

/**
 * One run's occurrence of a cause — every column the worker writes, including
 * the four that nothing used to read back.
 */
function seedOccurrence(over: Row = {}): Row {
  const n = store.runFailureCluster.length;
  const row = {
    id: `rfc_${n}`,
    orgId: 'org_1',
    runId: `run_${n}`,
    projectId: 'proj_1',
    clusterKey: 'abc123abc123',
    signature: 'class=TimeoutError | call=locator.click',
    label: 'Checkout never appears',
    ownerResultId: 'tr_0',
    verdictId: 'v_0',
    members: 40,
    modelCalls: 1,
    attachments: 39,
    suppressed: false,
    firstSeenInProject: false,
    createdAt: new Date(Date.parse('2026-10-24T10:00:00.000Z') - n * 60_000),
    resolvedAt: new Date('2026-10-24T10:00:30.000Z'),
    ...over,
  };
  store.runFailureCluster.push(row);
  return row;
}

const express = (await import('express')).default;
const { triageRouter, MAX_RETRIAGE_FANOUT, CAUSE_PAGE_LIMIT } = await import('./triage.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/triage', triageRouter);
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

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits.length = 0;
  h.jobs.length = 0;
  install();
});

// ─── Mute ────────────────────────────────────────────────────────────────────

describe('POST /triage/signatures/:clusterKey/mute', () => {
  it('refuses a mute with no reason', async () => {
    seedCause();
    const { status, body } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/reason is required/);
    expect(store.failureSignature[0]!.mutedUntil).toBeNull();
  });

  /*
   * The expiry is the whole difference between a mute and a deletion nobody
   * signed, so it is asserted as a real date in the right window.
   */
  it('stamps an expiry and returns the cause', async () => {
    seedCause();
    const { status, body } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      days: 3,
      reason: 'known issue, fix lands next sprint',
    });

    expect(status).toBe(200);
    const until = Date.parse(String(body.cause.mute.until));
    expect(Number.isFinite(until)).toBe(true);
    expect(until).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    expect(until).toBeLessThan(Date.now() + 4 * 86_400_000);
    expect(body.cause.mute.inForce).toBe(true);
    expect(body.cause.mute.reason).toBe('known issue, fix lands next sprint');
    // Stored, not only echoed.
    expect(store.failureSignature[0]!.mutedUntil).toBeInstanceOf(Date);
    expect(store.failureSignature[0]!.mutedBy).toBe('user_1');
  });

  it('clamps a long mute and says out loud that it did', async () => {
    seedCause();
    const { body } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      days: 365,
      reason: 'we are never fixing this',
    });

    const until = Date.parse(String(body.cause.mute.until));
    expect(until).toBeLessThan(Date.now() + (MUTE_MAX_DAYS + 1) * 86_400_000);
    expect(until).toBeGreaterThan(Date.now() + (MUTE_MAX_DAYS - 1) * 86_400_000);
    expect(body.note).toMatch(new RegExp(`Clamped to ${MUTE_MAX_DAYS} days`));
    expect(h.audits[0]!.metadata).toMatchObject({ daysAsked: 365, daysGranted: MUTE_MAX_DAYS });
  });

  /*
   * A cause with no identity row has never been observed. Minting one here
   * would put a first-seen date on a failure that never happened.
   */
  it('404s a cause nobody has ever observed, and mints nothing', async () => {
    const { status } = await call('POST', '/triage/signatures/nope/mute', {
      projectId: 'proj_1',
      reason: 'x',
    });
    expect(status).toBe(404);
    expect(store.failureSignature).toHaveLength(0);
  });

  it('extends a live mute rather than refusing it', async () => {
    seedCause({ mutedUntil: new Date(Date.now() + 1000), mutedReason: 'old reason' });
    const { status, body } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      days: 7,
      reason: 'still waiting on the vendor',
    });
    expect(status).toBe(200);
    expect(body.cause.mute.reason).toBe('still waiting on the vendor');
    expect(h.audits[0]!.metadata.extendedExistingMute).toBe(true);
  });

  /*
   * THE REASON CAP IS STATED, NOT APPLIED IN SILENCE. The reason is the whole
   * justification a later reader inherits, and a 400 that says "501 is too
   * long" leaves them with their sentence; a truncation at 500 leaves them with
   * three quarters of it and no sign that anything was cut.
   */
  it('refuses a reason longer than the cap instead of truncating it', async () => {
    seedCause();
    const { status, body } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      reason: 'x'.repeat(501),
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/500 characters or fewer/);
    expect(store.failureSignature[0]!.mutedUntil).toBeNull();
  });

  it('accepts a reason exactly at the cap', async () => {
    seedCause();
    const { status } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      reason: 'x'.repeat(500),
    });
    expect(status).toBe(200);
    expect(store.failureSignature[0]!.mutedReason).toHaveLength(500);
  });

  it('refuses a non-positive mute window', async () => {
    seedCause();
    const { status } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      days: 0,
      reason: 'x',
    });
    expect(status).toBe(400);
  });

  it('404s a project in another org without confirming it exists', async () => {
    seedCause();
    h.actor = { userId: 'u2', orgId: 'org_2', role: 'MEMBER', ip: null };
    const { status } = await call('POST', '/triage/signatures/abc123abc123/mute', {
      projectId: 'proj_1',
      reason: 'x',
    });
    expect(status).toBe(404);
  });
});

describe('POST /triage/signatures/:clusterKey/unmute', () => {
  it('clears the expiry and the reason but keeps what the mute cost', async () => {
    seedCause({
      mutedUntil: new Date(Date.now() + 86_400_000),
      mutedReason: 'known issue',
      mutedBy: 'user_9',
      suppressedCount: 12,
    });

    const { status, body } = await call('POST', '/triage/signatures/abc123abc123/unmute', {
      projectId: 'proj_1',
    });

    expect(status).toBe(200);
    expect(body.cause.mute).toBeNull();
    expect(store.failureSignature[0]!.mutedReason).toBeNull();
    // The evidence of what the mute swallowed survives: it is what decides
    // whether muting this was a good idea.
    expect(store.failureSignature[0]!.suppressedCount).toBe(12);
    expect(h.audits[0]!.metadata).toMatchObject({
      wasInForce: true,
      suppressedWhileMuted: 12,
    });
  });
});

// ─── The cause list ──────────────────────────────────────────────────────────

describe('GET /triage/signatures', () => {
  it('reports newInThisBuild as NULL when no run was named', async () => {
    seedCause();
    const { body } = await call('GET', '/triage/signatures?projectId=proj_1');
    // Not false. "Not new" and "nobody asked about a build" are different facts.
    expect(body.causes[0].newInThisBuild).toBeNull();
  });

  it('answers newInThisBuild with an equality when a run is named', async () => {
    seedCause({ firstSeenRunId: 'run_1' });
    const fresh = await call('GET', '/triage/signatures?projectId=proj_1&runId=run_1');
    expect(fresh.body.causes[0].newInThisBuild).toBe(true);
    const old = await call('GET', '/triage/signatures?projectId=proj_1&runId=run_2');
    expect(old.body.causes[0].newInThisBuild).toBe(false);
  });

  it('narrows to live mutes for the mute roster', async () => {
    seedCause({ clusterKey: 'live', mutedUntil: new Date(Date.now() + 86_400_000), id: 's1' });
    seedCause({ clusterKey: 'lapsed', mutedUntil: new Date(Date.now() - 1000), id: 's2' });
    seedCause({ clusterKey: 'loud', id: 's3' });

    const { body } = await call('GET', '/triage/signatures?projectId=proj_1&muted=true');
    expect(body.causes.map((c: Row) => c.clusterKey)).toEqual(['live']);
  });

  it('reports the limit so a truncated list is never mistaken for the whole set', async () => {
    seedCause();
    const { body } = await call('GET', '/triage/signatures?projectId=proj_1&limit=1');
    expect(body).toMatchObject({ returned: 1, limit: 1 });
  });

  /*
   * `?limit=` IS CLAMPED AT BOTH ENDS, and the upper end is the one that
   * matters: without it `?limit=100000` is a full-table read anybody can ask
   * for over HTTP, on the table that grows with every distinct failure the
   * install has ever produced.
   */
  it('clamps the page size a caller may ask for, at both ends', async () => {
    seedCause();
    const huge = await call('GET', '/triage/signatures?projectId=proj_1&limit=100000');
    expect(huge.body.limit).toBe(500);

    const negative = await call('GET', '/triage/signatures?projectId=proj_1&limit=-5');
    expect(negative.body.limit).toBe(1);

    // Zero and nonsense both fall back to the default rather than returning an
    // empty page: `Number(x) || 100` treats them alike, and a caller who gets
    // 100 rows and is told `limit: 100` has been told the truth either way.
    const zero = await call('GET', '/triage/signatures?projectId=proj_1&limit=0');
    expect(zero.body.limit).toBe(100);

    const nonsense = await call('GET', '/triage/signatures?projectId=proj_1&limit=banana');
    expect(nonsense.body.limit).toBe(100);
  });

  /*
   * `?newInRun=` — the filter that makes "what did THIS build break that
   * nothing had broken before" one index read. It is the sole consumer of
   * `@@index([orgId, projectId, firstSeenRunId])`, so this is also the test
   * that says the index is still earning its keep.
   */
  it('narrows to the causes that first appeared in one run', async () => {
    seedCause({ id: 's1', clusterKey: 'old', firstSeenRunId: 'run_1' });
    seedCause({ id: 's2', clusterKey: 'fresh', firstSeenRunId: 'run_5' });

    const { body } = await call('GET', '/triage/signatures?projectId=proj_1&newInRun=run_5');
    expect(body.causes.map((c: Row) => c.clusterKey)).toEqual(['fresh']);
    // A FILTER, not the flag: nothing asked about a build, so the flag stays
    // null rather than asserting "not new" about rows selected for being new.
    expect(body.causes[0].newInThisBuild).toBeNull();

    const both = await call(
      'GET',
      '/triage/signatures?projectId=proj_1&newInRun=run_5&runId=run_5',
    );
    expect(both.body.causes[0].newInThisBuild).toBe(true);
  });
});

describe('GET /triage/signatures/:clusterKey', () => {
  it('lists the runs the cause appeared in and marks the derived verdicts', async () => {
    seedCause();
    seedOccurrence({ runId: 'run_9' });
    seedVerdict();
    seedVerdict({ derivedFromId: 'v_0' });

    const { status, body } = await call(
      'GET',
      '/triage/signatures/abc123abc123?projectId=proj_1&runId=run_9',
    );
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ members: 40, modelCalls: 1, attachments: 39 });
    expect(body.verdicts.map((v: Row) => v.derived)).toEqual([false, true]);
    // `revision` is returned so a reader can see a verdict has been re-triaged.
    // Asserted, or the column goes back to being selected and read by nobody.
    expect(body.verdicts.map((v: Row) => v.revision)).toEqual([1, 1]);
  });

  /*
   * THE COLUMNS THAT HAD NO READER. `ownerResultId`, `verdictId` and
   * `resolvedAt` were written on every cause of every run and selected by no
   * query in the product — correct, queryable and dead, which is this repo's
   * signature defect and one check-wiring.ts cannot see because it works at
   * model level. This is the test that notices if they go back to being
   * write-only.
   */
  it('reports who claimed the cause, which verdict answered it, and when', async () => {
    seedCause();
    seedOccurrence({
      runId: 'run_9',
      ownerResultId: 'tr_7',
      verdictId: 'v_42',
      resolvedAt: new Date('2026-10-24T10:00:30.000Z'),
    });

    const { body } = await call('GET', '/triage/signatures/abc123abc123?projectId=proj_1');
    expect(body.runs[0].ownerResultId).toBe('tr_7');
    expect(body.runs[0].verdictId).toBe('v_42');
    expect(Date.parse(String(body.runs[0].resolvedAt))).toBe(
      Date.parse('2026-10-24T10:00:30.000Z'),
    );
  });

  /*
   * A cause the worker claimed and never answered. NULL is the honest report —
   * "no member has published a verdict for this cause in this run" — and it
   * must not arrive as a date, an empty string or a 0.
   */
  it('reports an unanswered cause as null rather than inventing an answer', async () => {
    seedCause();
    seedOccurrence({ runId: 'run_9', verdictId: null, resolvedAt: null, suppressed: true });

    const { body } = await call('GET', '/triage/signatures/abc123abc123?projectId=proj_1');
    expect(body.runs[0].verdictId).toBeNull();
    expect(body.runs[0].resolvedAt).toBeNull();
    expect(body.runs[0].suppressed).toBe(true);
  });

  /*
   * The clusterer's wording moved; the failure did not. This is what makes the
   * per-run `label` and `signature` copies worth keeping rather than two more
   * denormalised columns nobody reads: they are the grouping AS IT WAS, and a
   * run that disagrees with today's identity is evidence a normalisation rule
   * changed under a cause somebody is tracking.
   */
  it('flags a run whose recorded label or signature no longer matches the identity', async () => {
    seedCause({ label: 'Checkout never appears', signature: 'class=TimeoutError' });
    seedOccurrence({
      runId: 'run_9',
      label: 'Checkout never appears',
      signature: 'class=TimeoutError',
    });
    seedOccurrence({
      runId: 'run_8',
      label: 'timeout waiting for a locator',
      signature: 'class=TimeoutError',
    });
    seedOccurrence({
      runId: 'run_7',
      label: 'Checkout never appears',
      signature: 'class=TimeoutError | call=locator.click',
    });

    const { body } = await call('GET', '/triage/signatures/abc123abc123?projectId=proj_1');
    const byRun = new Map(body.runs.map((r: Row) => [r.runId, r]));
    expect(byRun.get('run_9')).toMatchObject({ labelDrift: false, signatureDrift: false });
    expect(byRun.get('run_8')).toMatchObject({ labelDrift: true, signatureDrift: false });
    expect(byRun.get('run_7')).toMatchObject({ labelDrift: false, signatureDrift: true });
  });

  /*
   * BOTH CAPS ARE DISCLOSED. 50 runs and 50 verdicts with nothing in the
   * response saying so is the same defect as the fan-out that reported 200 of a
   * 500-member cause as the whole cause — and it bites hardest on the causes
   * worth reading about, since a 200-test outage has 200 verdicts.
   */
  /*
   * THE VERDICT LIST IS THE PROJECT'S, and the cap count has to describe the
   * same set the caller asked about. `clusterKey` is sha1(signature) and
   * `FailureSignature` is unique on (orgId, projectId, clusterKey), so one org
   * with two projects hitting the same failure holds the key twice — and a
   * verdict read keyed on the cluster alone answers with both. The runs list
   * beside it was already scoped by projectId, which is what makes the two
   * halves of one response disagree about what the cause is.
   */
  it('keeps another project’s verdicts out of the cause, and out of the count', async () => {
    seedCause();
    seedOccurrence({ runId: 'run_9' });
    seedVerdict();
    seedVerdict({ projectId: 'proj_2', testName: 'the other project’s test' });

    const { status, body } = await call(
      'GET',
      '/triage/signatures/abc123abc123?projectId=proj_1',
    );
    expect(status).toBe(200);
    expect(body.verdicts).toHaveLength(1);
    expect(body.verdicts[0].testResult.test.name).toBe('checkout 0');
    // And the disclosure counts what it returned, not what it saw.
    expect(body.limits.verdicts.returned).toBe(1);
    expect(body.limits.verdicts.more).toBe(false);
  });

  it('says that the run list and the verdict list are capped, and that more exist', async () => {
    seedCause();
    for (let i = 0; i < CAUSE_PAGE_LIMIT + 1; i += 1) seedOccurrence();
    for (let i = 0; i < CAUSE_PAGE_LIMIT + 1; i += 1) seedVerdict();

    const { body } = await call('GET', '/triage/signatures/abc123abc123?projectId=proj_1');
    expect(body.runs).toHaveLength(CAUSE_PAGE_LIMIT);
    expect(body.verdicts).toHaveLength(CAUSE_PAGE_LIMIT);
    expect(body.limits).toMatchObject({
      runs: { returned: CAUSE_PAGE_LIMIT, limit: CAUSE_PAGE_LIMIT, more: true },
      verdicts: { returned: CAUSE_PAGE_LIMIT, limit: CAUSE_PAGE_LIMIT, more: true },
    });
  });

  /*
   * ...and `more` is observed rather than inferred from `returned === limit`:
   * a cause with exactly 50 runs is not a truncated one, and the extra row read
   * past the cap is what lets this endpoint tell the two apart.
   */
  it('does not claim more exist when the list stops exactly at the cap', async () => {
    seedCause();
    for (let i = 0; i < CAUSE_PAGE_LIMIT; i += 1) seedOccurrence();

    const { body } = await call('GET', '/triage/signatures/abc123abc123?projectId=proj_1');
    expect(body.runs).toHaveLength(CAUSE_PAGE_LIMIT);
    expect(body.limits.runs.more).toBe(false);
    expect(body.limits.verdicts).toMatchObject({ returned: 0, more: false });
  });
});

// ─── Re-triage ───────────────────────────────────────────────────────────────

describe('POST /triage/verdicts/:verdictId/retriage', () => {
  /*
   * THE ENDPOINT MUST NOT TOUCH THE CORRECTION. The worker archives it into a
   * revision row; an endpoint that cleared `reviewState` here would destroy the
   * training signal before the worker ever saw it.
   */
  it('stamps the request and leaves the human’s correction intact', async () => {
    const verdict = seedVerdict({ reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' });

    const { status, body } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      reason: 'the service was healthy',
    });

    expect(status).toBe(202);
    expect(body).toMatchObject({ requested: 1, scope: 'member', split: false });
    expect(verdict.retriageRequestedAt).toBeInstanceOf(Date);
    expect(verdict.retriageRequestedBy).toBe('user_1');
    expect(verdict.retriageReason).toBe('the service was healthy');
    // Untouched, on purpose.
    expect(verdict.reviewState).toBe('OVERRIDDEN');
    expect(verdict.overriddenTo).toBe('REAL_BUG');
    expect(verdict.revision).toBe(1);
    expect(body.note).toMatch(/kept in its revision history/);
  });

  /*
   * THE JOB ID CARRIES THE REVISION. `enqueueTriage` dedupes on
   * `triage-<resultId>` forever, so reusing that id would let BullMQ's
   * completed set swallow every re-triage after the first.
   */
  it('enqueues with a revision-bearing job id', async () => {
    const verdict = seedVerdict({ revision: 2 });
    await call('POST', `/triage/verdicts/${verdict.id}/retriage`);

    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]!.opts.jobId).toBe('triage-tr_0-r3');
    expect(h.jobs[0]!.payload).toMatchObject({
      orgId: 'org_1',
      runId: 'run_9',
      testResultId: 'tr_0',
    });
  });

  it('409s a second request while one is already pending', async () => {
    const verdict = seedVerdict({ retriageRequestedAt: new Date() });
    const { status, body } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`);
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toMatch(/already pending/);
    expect(h.jobs).toHaveLength(0);
  });

  it('stamps splitFromClusterKey on a split so the worker withholds the cluster', async () => {
    const verdict = seedVerdict({ derivedFromId: 'v_other' });
    await call('POST', `/triage/verdicts/${verdict.id}/retriage`, { split: true });
    expect(verdict.splitFromClusterKey).toBe('abc123abc123');
  });

  it('refuses a split of the whole cause, which is the opposite request', async () => {
    const verdict = seedVerdict();
    const { status } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      split: true,
      scope: 'cluster',
    });
    expect(status).toBe(400);
    expect(h.jobs).toHaveLength(0);
  });

  it('fans out across the cause and enqueues one job per member', async () => {
    const first = seedVerdict();
    seedVerdict();
    seedVerdict();
    const { body } = await call('POST', `/triage/verdicts/${first.id}/retriage`, {
      scope: 'cluster',
    });

    expect(body.requested).toBe(3);
    expect(h.jobs).toHaveLength(3);
    expect(store.triageVerdict.every((v) => v.retriageRequestedAt instanceof Date)).toBe(true);
    expect(h.audits[0]!.metadata).toMatchObject({ scope: 'cluster', covered: 3 });
  });

  /*
   * A member somebody deliberately split out is not part of the cause any more.
   * A cause-wide re-triage that dragged it back would silently undo their
   * decision, which is the same mistake as an "undo" that reverts a colleague.
   */
  it('skips a member that was split out of the cause', async () => {
    const first = seedVerdict();
    const split = seedVerdict({ splitFromClusterKey: 'abc123abc123' });
    const { body } = await call('POST', `/triage/verdicts/${first.id}/retriage`, {
      scope: 'cluster',
    });

    expect(body.requested).toBe(1);
    expect(split.retriageRequestedAt).toBeNull();
  });

  /*
   * ── THE CAP THAT USED TO LIE ────────────────────────────────────────────
   *
   * `take: MAX_RETRIAGE_FANOUT` with `requested: targets.length` told a caller
   * who asked for a 500-member cause that 200 WAS the cause: 300 members kept
   * the verdict the reviewer had just rejected and nothing said so. The
   * response now carries the real size of the set, how much of it was left
   * alone, and how to take the next page.
   */
  it('says how much of an over-cap cause it left alone', async () => {
    const first = seedVerdict();
    for (let i = 0; i < MAX_RETRIAGE_FANOUT; i += 1) seedVerdict();

    const { body } = await call('POST', `/triage/verdicts/${first.id}/retriage`, {
      scope: 'cluster',
    });

    expect(body.requested).toBe(MAX_RETRIAGE_FANOUT);
    expect(body.eligible).toBe(MAX_RETRIAGE_FANOUT + 1);
    expect(body.notRequested).toBe(1);
    expect(body.cap).toBe(MAX_RETRIAGE_FANOUT);
    expect(body.truncatedNote).toMatch(/keep the verdict they have/);
    expect(h.jobs).toHaveLength(MAX_RETRIAGE_FANOUT);
    // On the record as well: an audit row saying only "covered 200" describes a
    // decision about a cause nobody told the actor the size of.
    expect(h.audits[0]!.metadata).toMatchObject({
      covered: MAX_RETRIAGE_FANOUT,
      eligible: MAX_RETRIAGE_FANOUT + 1,
      notRequested: 1,
    });

    // The members left alone are untouched, so a second identical request
    // picks them up instead of re-stamping the ones already requested.
    const untouched = store.triageVerdict.filter((v) => v.retriageRequestedAt === null);
    expect(untouched).toHaveLength(1);
  });

  it('reports nothing left behind when the whole cause fitted', async () => {
    const first = seedVerdict();
    seedVerdict();

    const { body } = await call('POST', `/triage/verdicts/${first.id}/retriage`, {
      scope: 'cluster',
    });
    expect(body).toMatchObject({ requested: 2, eligible: 2, notRequested: 0 });
    expect(body.truncatedNote).toBeNull();
  });

  /*
   * WHAT IT WILL SPEND, BEFORE IT SPENDS IT. This product's thesis is one model
   * call per cause; this door deliberately opts out of it, because handing back
   * a copy of the answer the reviewer rejected is the button doing nothing. A
   * 202 that said nothing about cost let a reviewer buy 200 strong-tier calls
   * from a screen that looked like a refresh button.
   */
  it('states the model-call cost of a cause-wide re-triage', async () => {
    const first = seedVerdict();
    seedVerdict();
    seedVerdict();

    const { body } = await call('POST', `/triage/verdicts/${first.id}/retriage`, {
      scope: 'cluster',
    });
    expect(body.cost.modelCallsAtMost).toBe(3);
    expect(body.cost.note).toMatch(/each of the 3 members buys its own model call/);
  });

  it('states the cost of a single-member re-triage too', async () => {
    const verdict = seedVerdict();
    const { body } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`);
    expect(body.cost.modelCallsAtMost).toBe(1);
    expect(body.cost.note).toMatch(/One fresh model call/);
  });

  /*
   * The reason is kept or refused, never quietly shortened: it is the
   * justification that lands in the audit row, in the revision history and in
   * the prior the next prompt reads back.
   */
  it('refuses an over-long reason instead of truncating the audit trail', async () => {
    const verdict = seedVerdict();
    const { status } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      reason: 'x'.repeat(501),
    });
    expect(status).toBe(400);
    expect(verdict.retriageRequestedAt).toBeNull();
    expect(h.jobs).toHaveLength(0);
  });

  it('keeps a reason that is exactly at the cap, in full', async () => {
    const verdict = seedVerdict();
    const { status } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      reason: 'y'.repeat(500),
    });
    expect(status).toBe(202);
    expect(verdict.retriageReason).toHaveLength(500);
  });

  it('degrades to this member when the verdict predates cause clustering', async () => {
    const verdict = seedVerdict({ clusterKey: null });
    const { body } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      scope: 'cluster',
    });
    expect(body.requested).toBe(1);
    expect(body.degradedToMember).toMatch(/predates cause clustering/);
  });

  it('rejects an unknown scope rather than guessing', async () => {
    const verdict = seedVerdict();
    const { status } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`, {
      scope: 'everything',
    });
    expect(status).toBe(400);
  });

  it('403s a VIEWER', async () => {
    const verdict = seedVerdict();
    h.actor = { userId: 'u3', orgId: 'org_1', role: 'VIEWER', ip: null };
    const { status } = await call('POST', `/triage/verdicts/${verdict.id}/retriage`);
    expect(status).toBe(403);
    expect(verdict.retriageRequestedAt).toBeNull();
  });
});

// ─── History ─────────────────────────────────────────────────────────────────

describe('GET /triage/verdicts/:verdictId/history', () => {
  it('shows what the verdict used to say, including the override', async () => {
    const verdict = seedVerdict({ revision: 2, verdict: 'REAL_BUG' });
    store.triageVerdictRevision.push({
      verdictId: verdict.id,
      revision: 1,
      verdict: 'FLAKE',
      confidence: 0.5,
      explanation: 'timing',
      model: 'cheap',
      reviewState: 'OVERRIDDEN',
      overriddenTo: 'REAL_BUG',
      reviewedBy: 'user_7',
      reviewedAt: new Date(),
      supersededAt: new Date(),
      supersededBy: 'user_7',
      reason: 'the service was healthy',
    });

    const { status, body } = await call('GET', `/triage/verdicts/${verdict.id}/history`);
    expect(status).toBe(200);
    expect(body.current).toMatchObject({ revision: 2, verdict: 'REAL_BUG', derived: false });
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0]).toMatchObject({
      revision: 1,
      verdict: 'FLAKE',
      reviewState: 'OVERRIDDEN',
      overriddenTo: 'REAL_BUG',
    });
  });
});

// ─── The scorecard ───────────────────────────────────────────────────────────

describe('GET /triage/accuracy', () => {
  /*
   * THE ONE NUMBER THAT MUST NOT BE FAKED. 0% reads as a pass; null reads as
   * "nobody looked", which is the truth.
   */
  it('leaves the rate null and calls it unmeasured when nothing was reviewed', async () => {
    seedVerdict({ verdict: 'REAL_BUG', reviewState: 'PENDING' });
    seedVerdict({ verdict: 'REAL_BUG', reviewState: 'PENDING' });

    const { status, body } = await call('GET', '/triage/accuracy?projectId=proj_1');
    expect(status).toBe(200);
    const realBug = body.rows.find((r: Row) => r.verdict === 'REAL_BUG');
    expect(realBug.minted).toBe(2);
    expect(realBug.overrideRatePercent).toBeNull();
    expect(realBug.sentence).toMatch(/nobody has reviewed one/);
    expect(body.totals.overrideRatePercent).toBeNull();
  });

  it('counts overrides per verdict kind and names where they went', async () => {
    for (let i = 0; i < 3; i += 1) {
      seedVerdict({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' });
    }
    seedVerdict({ verdict: 'FLAKE', reviewState: 'ACCEPTED' });

    const { body } = await call('GET', '/triage/accuracy?projectId=proj_1');
    const flake = body.rows.find((r: Row) => r.verdict === 'FLAKE');
    expect(flake.reviewed).toBe(4);
    expect(flake.overridden).toBe(3);
    expect(flake.overrideRatePercent).toBeCloseTo(75);
    expect(flake.correctedTo[0]).toEqual({ to: 'REAL_BUG', count: 3 });
  });

  /*
   * A correction a human made is evidence whether or not a later re-triage
   * replaced it. Reading the live rows only would under-count exactly the
   * projects that use re-triage most.
   */
  it('counts corrections that a re-triage has since superseded', async () => {
    const verdict = seedVerdict({ verdict: 'ENV_ISSUE', reviewState: 'PENDING' });
    store.triageVerdictRevision.push({
      verdictId: verdict.id,
      revision: 1,
      verdict: 'FLAKE',
      overriddenTo: 'REAL_BUG',
      reviewState: 'OVERRIDDEN',
      supersededAt: new Date(),
    });

    const { body } = await call('GET', '/triage/accuracy?projectId=proj_1');
    const flake = body.rows.find((r: Row) => r.verdict === 'FLAKE');
    expect(flake.overridden).toBe(1);
    expect(flake.correctedTo[0]).toEqual({ to: 'REAL_BUG', count: 1 });
    expect(body.supersededCorrections).toBe(1);
  });

  it('reports every verdict kind, even the ones with no rows', async () => {
    const { body } = await call('GET', '/triage/accuracy?projectId=proj_1');
    expect(body.rows.map((r: Row) => r.verdict)).toEqual([
      'REAL_BUG',
      'INTENDED_CHANGE',
      'FLAKE',
      'ENV_ISSUE',
    ]);
    expect(body.kinds).toHaveLength(4);
  });

  it('clamps the window a caller may ask for', async () => {
    const { body } = await call('GET', '/triage/accuracy?projectId=proj_1&days=99999');
    expect(body.windowDays).toBe(365);
  });

  it('scopes to the project, so another project’s corrections do not leak in', async () => {
    seedVerdict({ verdict: 'FLAKE', reviewState: 'OVERRIDDEN', overriddenTo: 'REAL_BUG' });
    seedVerdict({
      verdict: 'FLAKE',
      reviewState: 'OVERRIDDEN',
      overriddenTo: 'REAL_BUG',
      projectId: 'proj_other',
    });

    const { body } = await call('GET', '/triage/accuracy?projectId=proj_1');
    expect(body.rows.find((r: Row) => r.verdict === 'FLAKE').overridden).toBe(1);
  });
});
