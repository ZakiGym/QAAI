/**
 * POST /projects/:projectId/analyze-source — the live producer of
 * `qaai.analyze-source`.
 *
 * This endpoint had no test. What it enqueues therefore had no guard, and it
 * was enqueuing wrong in a way nothing could surface: no `attempts` and no job
 * id, so it inherited the queue default of three attempts onto a processor that
 * calls `flowMap.create` and `testPlan.create`. A transient failure proposed
 * the plan twice and both attempts reported success.
 *
 * So the assertions below are mostly about the OPTIONS, not the status code.
 * The status code was never the broken part: the endpoint answered 202
 * `{ queued: true }` and wrote its audit row whatever happened afterwards,
 * which is exactly why the duplicate — and, through the worker's producer, the
 * silently dropped analysis — was invisible.
 *
 * Harness: the same shape as suites.test.ts, trimmed to the two models this
 * route reads. The fake throws on a filter the route is not supposed to use, so
 * it cannot shrug at a query that stopped scoping.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Enqueued {
  name: string;
  payload: Row;
  opts: Row;
}

interface Hoisted {
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  projects: Row[];
  snapshots: Row[];
  enqueued: Enqueued[];
  audits: Row[];
  /** Every operation the router issued, as `model.operation`. */
  ops: string[];
}

const h = vi.hoisted((): Hoisted => ({
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  projects: [],
  snapshots: [],
  enqueued: [],
  audits: [],
  ops: [],
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

/*
 * The tenant scope is real, not stubbed, for the reason suites.test.ts gives:
 * the route's queries carry no `orgId` in their `where` and rely entirely on
 * running inside `withTenant`, so a plain variable would be restored before
 * they ran and the isolation test below would pass for the wrong reason.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();

  const KNOWN_FILTERS: Record<string, Set<string>> = {
    project: new Set(['id', 'orgId']),
    codebaseSnapshot: new Set(['projectId', 'orgId']),
  };

  const scoped = (model: string, rows: Row[]): Row[] => {
    const orgId = store.getStore()?.orgId ?? null;
    return orgId === null ? rows : rows.filter((row) => row.orgId === orgId);
  };

  const matches = (model: string, row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (!KNOWN_FILTERS[model]!.has(key)) {
        throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
      }
      return (row[key] ?? null) === want;
    });

  const pick = (row: Row | undefined, select?: Row): Row | null => {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
    return out;
  };

  const delegate = (model: string, rows: () => Row[]) => ({
    findUnique: async ({ where, select }: Row) => {
      h.ops.push(`${model}.findUnique`);
      return pick(
        scoped(model, rows()).find((row) => matches(model, row, where)),
        select,
      );
    },
    findFirst: async ({ where, select, orderBy }: Row) => {
      h.ops.push(`${model}.findFirst`);
      const found = scoped(model, rows()).filter((row) => matches(model, row, where));
      if (orderBy?.createdAt === 'desc') {
        found.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
      }
      return pick(found[0], select);
    },
  });

  return {
    prisma: {
      project: delegate('project', () => h.projects),
      codebaseSnapshot: delegate('codebaseSnapshot', () => h.snapshots),
    },
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/*
 * CAPTURED, not discarded. The options are the subject of this file: a mock
 * that swallowed its third argument would let every assertion below pass
 * against the bug it was written for.
 */
vi.mock('../lib/queues.js', () => ({
  enqueue: async (name: string, payload: Row, opts: Row = {}) => {
    h.enqueued.push({ name, payload, opts });
    return 'job_1';
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

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { sourceRouter } = await import('./source.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const { requireAuth } = await import('../middleware/auth.js');
const { analyzeSourceJobOptions } = await import('@qaai/shared');

const app = express();
app.use(express.json());
// `requireAuth` is applied globally in index.ts, not by this router, and it is
// what opens the tenant scope — without it every query below runs unscoped and
// the isolation test is meaningless.
app.use(requireAuth as never);
app.use('/', sourceRouter);
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

const asOrg = (orgId: string, role = 'MEMBER'): void => {
  h.actor = { userId: `user_of_${orgId}`, orgId, role, ip: null };
};

beforeEach(() => {
  asOrg('org_1');
  h.projects = [{ id: 'proj_1', orgId: 'org_1' }];
  h.snapshots = [{ id: 'snap_1', projectId: 'proj_1', orgId: 'org_1', createdAt: 1 }];
  h.enqueued.length = 0;
  h.audits.length = 0;
  h.ops.length = 0;
});

describe('POST /projects/:projectId/analyze-source', () => {
  it('queues the analysis for the project, naming who asked', async () => {
    const res = await call('POST', '/projects/proj_1/analyze-source', { autoApprove: false });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, snapshotId: 'snap_1' });
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]?.name).toBe('qaai.analyze-source');
    expect(h.enqueued[0]?.payload).toEqual({
      orgId: 'org_1',
      projectId: 'proj_1',
      requestedBy: 'user_of_org_1',
      autoApprove: false,
    });
  });

  /*
   * THE DEFECT THIS FILE WAS WRITTEN FOR. No `attempts` was passed, so the job
   * inherited the queue default of 3 onto a processor that creates a FlowMap
   * version and a TestPlan. The retry does not re-do the work, it duplicates
   * it, and the person approves one of two identical plans — with both attempts
   * reported as successes.
   */
  it('asks for exactly one attempt, because the processor creates rows', async () => {
    await call('POST', '/projects/proj_1/analyze-source');
    expect(h.enqueued[0]?.opts.attempts).toBe(1);
  });

  /*
   * And the other half. A job id keyed on the project is a Redis key that
   * outlives the run unless both removal flags are set — at which point this
   * endpoint goes on answering 202 `{ queued: true }` and writing its audit row
   * while no analysis is ever queued again for that project. Asserted against
   * the shared options so the two producers of this queue cannot drift apart.
   */
  it('scopes the in-flight lock to the project and lets the id die with the job', async () => {
    await call('POST', '/projects/proj_1/analyze-source');
    expect(h.enqueued[0]?.opts).toEqual(analyzeSourceJobOptions('proj_1'));
    expect(h.enqueued[0]?.opts.jobId).toBe('analyze-source-proj_1');
    expect(h.enqueued[0]?.opts.removeOnComplete).toBe(true);
    expect(h.enqueued[0]?.opts.removeOnFail).toBe(true);
  });

  it('locks per project, not globally', async () => {
    h.projects.push({ id: 'proj_2', orgId: 'org_1' });
    h.snapshots.push({ id: 'snap_2', projectId: 'proj_2', orgId: 'org_1', createdAt: 1 });
    await call('POST', '/projects/proj_1/analyze-source');
    await call('POST', '/projects/proj_2/analyze-source');
    expect(h.enqueued.map((e) => e.opts.jobId)).toEqual([
      'analyze-source-proj_1',
      'analyze-source-proj_2',
    ]);
  });

  it('passes autoApprove through, since onboarding is the only caller that sets it', async () => {
    await call('POST', '/projects/proj_1/analyze-source', { autoApprove: true });
    expect(h.enqueued[0]?.payload.autoApprove).toBe(true);
  });

  it('treats a missing body as autoApprove false rather than undefined', async () => {
    await call('POST', '/projects/proj_1/analyze-source');
    expect(h.enqueued[0]?.payload.autoApprove).toBe(false);
  });

  /*
   * Refused rather than queued: a job that starts, finds no snapshot and exits
   * leaves the person watching a spinner resolve into an empty plan with no
   * explanation. Nothing may be enqueued and nothing may be audited.
   */
  it('refuses a project with no codebase, and queues nothing', async () => {
    h.snapshots = [];
    const res = await call('POST', '/projects/proj_1/analyze-source');
    expect(res.status).toBe(400);
    expect(String(res.body.error?.message)).toContain('no codebase to analyse');
    expect(h.enqueued).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('analyses the NEWEST snapshot, not whichever row came back first', async () => {
    h.snapshots.push({ id: 'snap_2', projectId: 'proj_1', orgId: 'org_1', createdAt: 2 });
    const res = await call('POST', '/projects/proj_1/analyze-source');
    expect(res.body.snapshotId).toBe('snap_2');
    expect(h.audits[0]?.targetId).toBe('snap_2');
  });

  it('audits the request against the snapshot it analysed', async () => {
    await call('POST', '/projects/proj_1/analyze-source', { autoApprove: true });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'source.analyze',
      targetType: 'CodebaseSnapshot',
      targetId: 'snap_1',
      metadata: { projectId: 'proj_1', autoApprove: true },
    });
  });

  /*
   * Cross-tenant is a 404 and never a 403: a 403 confirms the project exists.
   * The route's `where` carries no `orgId`, so this passes only because the
   * query ran inside the request's tenant scope.
   */
  it('404s on another org’s project, and queues nothing', async () => {
    asOrg('org_2');
    h.projects.push({ id: 'proj_other', orgId: 'org_1' });
    const res = await call('POST', '/projects/proj_1/analyze-source');
    expect(res.status).toBe(404);
    expect(h.enqueued).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a VIEWER, because this queues work', async () => {
    asOrg('org_1', 'VIEWER');
    const res = await call('POST', '/projects/proj_1/analyze-source');
    expect(res.status).toBe(403);
    expect(h.enqueued).toHaveLength(0);
  });
});
