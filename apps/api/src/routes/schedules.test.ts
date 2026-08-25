/**
 * Tests for the read-and-edit half of schedules and monitors (§6).
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. ORG AND PROJECT ISOLATION on all three endpoints. Another org's project
 *      is a 404 rather than an empty list, another org's schedule cannot be
 *      read or written through, and — the one the tenant layer does NOT cover —
 *      a schedule belonging to a DIFFERENT PROJECT OF THE SAME ORG is a 404
 *      too, and a repoint at another project's suite or environment is refused.
 *      That last pair is route logic, not framework logic.
 *   2. `nextRunAt` is a cache of the cron and is kept true. Retiming moves it;
 *      resuming a schedule paused days ago moves it FORWARD, because the stored
 *      value is in the past and the worker's sweep fires anything overdue — an
 *      unpause at 10am that immediately runs last night's suite is the bug this
 *      assertion exists for. Pausing must not touch it.
 *   3. The monitor streak is reset in the two cases that otherwise silence it:
 *      resuming, and lowering the threshold below the streak already standing
 *      (the worker alerts on `streak === threshold` exactly, so a streak that
 *      has already passed the new threshold can never cross it again).
 *   4. Last-run attribution is honest. A run is only claimed when exactly one
 *      schedule or monitor targets that suite and environment; a MANUAL run of
 *      the same suite is never claimed; and outside the lookback window the row
 *      keeps its `lastRunAt` and reports no outcome instead of an old one.
 *
 * The cron parser and the timezone check are REAL — cron-parser and Intl, the
 * same two the worker's sweep uses. A stubbed parser would let "0 3 * * 1-5"
 * and "every tuesday" through alike, and the whole point of validating on write
 * is that the worker does not silently disable the schedule later.
 *
 * Harness: same shape as integrations.test.ts — mocked prisma module with a
 * real AsyncLocalStorage tenant scope, real router over a loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
  }),
);

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
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/*
 * Auth is replaced with a switchable actor; RBAC stays real in spirit — the
 * requireRole stand-in ranks with the same ROLE_RANK table the middleware uses,
 * so the VIEWER tests exercise the same comparison.
 */
vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
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

// Recorded, not silent: several tests assert that a refusal writes no audit row.
vi.mock('../lib/audit.js', () => ({
  audit: async (input: unknown) => {
    h.audits.push(input as Row);
  },
}));

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = ['project', 'schedule', 'monitor', 'suite', 'environment', 'run'] as const;
type ModelName = (typeof MODELS)[number];

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const filter = cond as Row;
      if ('in' in filter) {
        if (!(filter.in as unknown[]).includes(value)) return false;
        continue;
      }
      // Loud on purpose: a fake that shrugs at a filter it does not know passes
      // the tests whose whole point is that the filter is applied.
      throw new Error(`fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
    }
    if (value !== cond) return false;
  }
  return true;
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = row[key];
  }
  return out;
}

/** Dates and strings both, because this router orders by `name` and by `queuedAt`. */
function sortRows(list: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return list;
  const [key, direction] = Object.entries(orderBy)[0]!;
  return [...list].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    const cmp =
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : String(left).localeCompare(String(right));
    return direction === 'desc' ? -cmp : cmp;
  });
}

const DEFAULTS: Record<ModelName, Row> = {
  project: {},
  schedule: { timezone: 'UTC', enabled: true, lastRunAt: null, nextRunAt: null },
  monitor: {
    intervalMinutes: 15,
    enabled: true,
    failureThreshold: 2,
    consecutiveFailures: 0,
    lastStatus: null,
    lastCheckedAt: null,
  },
  suite: {},
  environment: { kind: 'STAGING' },
  run: {
    status: 'PASSED',
    trigger: 'MANUAL',
    suiteId: null,
    finishedAt: null,
    totalCount: 0,
    passedCount: 0,
    failedCount: 0,
  },
};

/** Ordering is asserted, so the insertion clock must not tie. */
const CLOCK_BASE = new Date('2026-08-01T00:00:00.000Z').getTime();

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;
  let ticks = 0;

  const makeModel = (name: ModelName) => {
    const rows = () => tables[name];
    const scope = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return orgId ? { ...where, orgId } : where;
    };
    const find = (where: Row = {}, orderBy?: Row): Row[] =>
      sortRows(
        rows().filter((r) => matches(r, scope(where))),
        orderBy,
      );

    const insert = (data: Row): Row => {
      const orgId = h.currentOrg();
      const stamp = new Date(CLOCK_BASE + ticks++);
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: stamp,
        updatedAt: stamp,
        queuedAt: stamp,
        ...DEFAULTS[name],
        ...(orgId && data.orgId === undefined ? { orgId } : {}),
        ...data,
      };
      rows().push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select }: Row) => {
        const row = find(where)[0];
        return row ? project(row, select) : null;
      },
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const row = find(where, orderBy)[0];
        return row ? project(row, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: Row = {}) => {
        const list = find(where, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) =>
          project(r, select),
        );
      },
      create: async ({ data, select }: Row) => project(insert(data), select),
      update: async ({ where, data, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data, { updatedAt: new Date(CLOCK_BASE + ticks++) });
        return project(row, select);
      },
      delete: async ({ where }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.delete matched no row`);
        rows().splice(rows().indexOf(row), 1);
        return row;
      },
    };
  };

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { schedulesRouter } = await import('./schedules.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/automation', schedulesRouter);
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

/*
 * A fixed cast, built directly in the tables rather than through the API,
 * because the create endpoints live in routes/projects.ts and this file must
 * not depend on them being mounted.
 *
 * `other` is a second org; `sibling` is a second PROJECT OF THE SAME ORG, which
 * is the isolation boundary the tenant layer cannot see.
 */
const ORG = 'org_1';
const OTHER_ORG = 'org_2';

interface Fixture {
  projectId: string;
  siblingProjectId: string;
  otherOrgProjectId: string;
  suiteId: string;
  siblingSuiteId: string;
  otherOrgSuiteId: string;
  envId: string;
  siblingEnvId: string;
  scheduleId: string;
  monitorId: string;
  siblingScheduleId: string;
  otherOrgScheduleId: string;
  otherOrgMonitorId: string;
}

function seed(): Fixture {
  const push = (name: ModelName, row: Row): string => {
    const id = `${name}_${db.tables[name].length + 1}_${Math.random().toString(36).slice(2, 8)}`;
    db.tables[name].push({
      id,
      createdAt: new Date(CLOCK_BASE + db.tables[name].length),
      updatedAt: new Date(CLOCK_BASE + db.tables[name].length),
      ...DEFAULTS[name],
      ...row,
    });
    return id;
  };

  const projectId = push('project', { orgId: ORG, name: 'Storefront' });
  const siblingProjectId = push('project', { orgId: ORG, name: 'Admin' });
  const otherOrgProjectId = push('project', { orgId: OTHER_ORG, name: 'Rival' });

  const suiteId = push('suite', { orgId: ORG, projectId, name: 'Smoke' });
  const siblingSuiteId = push('suite', {
    orgId: ORG,
    projectId: siblingProjectId,
    name: 'Admin smoke',
  });
  const otherOrgSuiteId = push('suite', {
    orgId: OTHER_ORG,
    projectId: otherOrgProjectId,
    name: 'Theirs',
  });

  const envId = push('environment', { orgId: ORG, projectId, name: 'staging' });
  const siblingEnvId = push('environment', {
    orgId: ORG,
    projectId: siblingProjectId,
    name: 'admin-staging',
  });

  const scheduleId = push('schedule', {
    orgId: ORG,
    projectId,
    suiteId,
    environmentId: envId,
    name: 'Nightly',
    cron: '0 3 * * 1-5',
    timezone: 'UTC',
  });
  const monitorId = push('monitor', {
    orgId: ORG,
    projectId,
    suiteId,
    environmentId: envId,
    name: 'Checkout uptime',
  });
  const siblingScheduleId = push('schedule', {
    orgId: ORG,
    projectId: siblingProjectId,
    suiteId: siblingSuiteId,
    environmentId: siblingEnvId,
    name: 'Admin nightly',
    cron: '0 4 * * *',
  });
  const otherOrgScheduleId = push('schedule', {
    orgId: OTHER_ORG,
    projectId: otherOrgProjectId,
    suiteId: otherOrgSuiteId,
    environmentId: push('environment', {
      orgId: OTHER_ORG,
      projectId: otherOrgProjectId,
      name: 'theirs',
    }),
    name: 'Theirs',
    cron: '0 5 * * *',
  });
  const otherOrgMonitorId = push('monitor', {
    orgId: OTHER_ORG,
    projectId: otherOrgProjectId,
    suiteId: otherOrgSuiteId,
    environmentId: 'env_theirs',
    name: 'Their monitor',
  });

  return {
    projectId,
    siblingProjectId,
    otherOrgProjectId,
    suiteId,
    siblingSuiteId,
    otherOrgSuiteId,
    envId,
    siblingEnvId,
    scheduleId,
    monitorId,
    siblingScheduleId,
    otherOrgScheduleId,
    otherOrgMonitorId,
  };
}

let f: Fixture;

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client as Record<string, unknown>;
  h.actor = { userId: 'user_1', orgId: ORG, role: 'ADMIN', ip: null };
  h.audits.length = 0;
  f = seed();
});

const scheduleRow = (id: string): Row => db.tables.schedule.find((r) => r.id === id)!;
const monitorRow = (id: string): Row => db.tables.monitor.find((r) => r.id === id)!;

describe('GET /automation/:projectId', () => {
  it('returns this project’s schedules and monitors with their cadence intact', async () => {
    const { status, body } = await call('GET', `/automation/${f.projectId}`);

    expect(status).toBe(200);
    expect(body.project).toMatchObject({ id: f.projectId, name: 'Storefront' });
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toMatchObject({
      id: f.scheduleId,
      name: 'Nightly',
      cron: '0 3 * * 1-5',
      timezone: 'UTC',
      enabled: true,
      suiteId: f.suiteId,
      environmentId: f.envId,
      lastRun: null,
      lastRunAmbiguous: false,
    });
    expect(body.monitors).toHaveLength(1);
    expect(body.monitors[0]).toMatchObject({
      id: f.monitorId,
      intervalMinutes: 15,
      failureThreshold: 2,
      consecutiveFailures: 0,
    });
  });

  it('returns the suites and environments the pickers need, and only this project’s', async () => {
    const { body } = await call('GET', `/automation/${f.projectId}`);

    expect(body.suites.map((s: Row) => s.id)).toEqual([f.suiteId]);
    expect(body.environments.map((e: Row) => e.id)).toEqual([f.envId]);
  });

  it('404s on another org’s project rather than answering with an empty list', async () => {
    const { status, body } = await call('GET', `/automation/${f.otherOrgProjectId}`);

    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('never leaks another org’s schedules, even under its own project id', async () => {
    h.actor = { ...h.actor, orgId: OTHER_ORG };
    const { body } = await call('GET', `/automation/${f.otherOrgProjectId}`);

    // Sanity: as the owning org the row IS visible, so the 404 above was
    // isolation and not a broken fixture.
    expect(body.schedules.map((s: Row) => s.id)).toEqual([f.otherOrgScheduleId]);
    expect(body.schedules[0].name).toBe('Theirs');
  });

  it('404s on a project id that does not exist at all', async () => {
    const { status } = await call('GET', '/automation/project_nope');
    expect(status).toBe(404);
  });

  it('attaches the newest SCHEDULE run and ignores a manual run of the same suite', async () => {
    db.tables.run.push(
      {
        id: 'run_old',
        orgId: ORG,
        projectId: f.projectId,
        suiteId: f.suiteId,
        environmentId: f.envId,
        trigger: 'SCHEDULE',
        status: 'PASSED',
        queuedAt: new Date('2026-08-01T03:00:00Z'),
        finishedAt: new Date('2026-08-01T03:04:00Z'),
        totalCount: 10,
        passedCount: 10,
        failedCount: 0,
      },
      {
        id: 'run_new',
        orgId: ORG,
        projectId: f.projectId,
        suiteId: f.suiteId,
        environmentId: f.envId,
        trigger: 'SCHEDULE',
        status: 'FAILED',
        queuedAt: new Date('2026-08-02T03:00:00Z'),
        finishedAt: new Date('2026-08-02T03:06:00Z'),
        totalCount: 10,
        passedCount: 7,
        failedCount: 3,
      },
      {
        // The trap: newest of all, same suite and environment, but somebody
        // pressed the button. Claiming it would report a human's run as the
        // nightly's result.
        id: 'run_manual',
        orgId: ORG,
        projectId: f.projectId,
        suiteId: f.suiteId,
        environmentId: f.envId,
        trigger: 'MANUAL',
        status: 'PASSED',
        queuedAt: new Date('2026-08-03T09:00:00Z'),
        finishedAt: new Date('2026-08-03T09:02:00Z'),
        totalCount: 10,
        passedCount: 10,
        failedCount: 0,
      },
    );

    const { body } = await call('GET', `/automation/${f.projectId}`);

    expect(body.schedules[0].lastRun).toMatchObject({
      id: 'run_new',
      status: 'FAILED',
      failedCount: 3,
    });
  });

  it('does not hand a monitor’s run to a schedule that shares its suite', async () => {
    db.tables.run.push({
      id: 'run_monitor',
      orgId: ORG,
      projectId: f.projectId,
      suiteId: f.suiteId,
      environmentId: f.envId,
      trigger: 'MONITOR',
      status: 'PASSED',
      queuedAt: new Date('2026-08-02T03:00:00Z'),
      finishedAt: null,
      totalCount: 3,
      passedCount: 3,
      failedCount: 0,
    });

    const { body } = await call('GET', `/automation/${f.projectId}`);

    expect(body.schedules[0].lastRun).toBeNull();
    expect(body.monitors[0].lastRun).toMatchObject({ id: 'run_monitor' });
  });

  it('refuses to guess when two schedules share a suite and environment', async () => {
    db.tables.schedule.push({
      id: 'schedule_twin',
      orgId: ORG,
      projectId: f.projectId,
      suiteId: f.suiteId,
      environmentId: f.envId,
      name: 'Hourly',
      cron: '0 * * * *',
      timezone: 'UTC',
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date(CLOCK_BASE + 999),
    });
    db.tables.run.push({
      id: 'run_ambiguous',
      orgId: ORG,
      projectId: f.projectId,
      suiteId: f.suiteId,
      environmentId: f.envId,
      trigger: 'SCHEDULE',
      status: 'PASSED',
      queuedAt: new Date('2026-08-02T03:00:00Z'),
      finishedAt: null,
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
    });

    const { body } = await call('GET', `/automation/${f.projectId}`);

    expect(body.schedules).toHaveLength(2);
    for (const schedule of body.schedules) {
      expect(schedule.lastRun).toBeNull();
      expect(schedule.lastRunAmbiguous).toBe(true);
    }
  });

  it('keeps lastRunAt but reports no outcome once the run falls out of the window', async () => {
    scheduleRow(f.scheduleId).lastRunAt = new Date('2026-01-01T03:00:00Z');
    db.tables.run.push({
      id: 'run_ancient',
      orgId: ORG,
      projectId: f.projectId,
      suiteId: f.suiteId,
      environmentId: f.envId,
      trigger: 'SCHEDULE',
      status: 'PASSED',
      queuedAt: new Date('2026-01-01T03:00:00Z'),
      finishedAt: null,
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
    });
    // 300 newer triggered runs of a different suite push it past the lookback.
    for (let i = 0; i < 300; i++) {
      db.tables.run.push({
        id: `run_filler_${i}`,
        orgId: ORG,
        projectId: f.projectId,
        suiteId: 'suite_other',
        environmentId: f.envId,
        trigger: 'MONITOR',
        status: 'PASSED',
        queuedAt: new Date(Date.UTC(2026, 5, 1, 0, i)),
        finishedAt: null,
        totalCount: 1,
        passedCount: 1,
        failedCount: 0,
      });
    }

    const { body } = await call('GET', `/automation/${f.projectId}`);

    expect(body.schedules[0].lastRun).toBeNull();
    expect(body.schedules[0].lastRunAmbiguous).toBe(false);
    expect(body.schedules[0].lastRunAt).toBe('2026-01-01T03:00:00.000Z');
  });
});

describe('PATCH /automation/:projectId/schedules/:scheduleId', () => {
  it('edits every field a schedule has and re-arms the next fire time', async () => {
    scheduleRow(f.scheduleId).lastRunAt = new Date('2026-08-01T03:00:00Z');
    db.tables.suite.push({
      id: 'suite_second',
      orgId: ORG,
      projectId: f.projectId,
      name: 'Full regression',
    });
    db.tables.environment.push({
      id: 'env_second',
      orgId: ORG,
      projectId: f.projectId,
      name: 'production',
      kind: 'PRODUCTION',
    });

    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      {
        name: 'Weeknights',
        cron: '30 2 * * 1-5',
        timezone: 'Europe/Berlin',
        suiteId: 'suite_second',
        environmentId: 'env_second',
      },
    );

    expect(status).toBe(200);
    expect(body.schedule).toMatchObject({
      name: 'Weeknights',
      cron: '30 2 * * 1-5',
      timezone: 'Europe/Berlin',
      suiteId: 'suite_second',
      environmentId: 'env_second',
    });

    const next = new Date(body.schedule.nextRunAt).getTime();
    expect(next).toBeGreaterThan(Date.now());
    // Weeknights at 02:30 — the next one is never more than four days out.
    expect(next).toBeLessThan(Date.now() + 4 * 24 * 60 * 60_000);

    // The edit must not erase the record of when it last fired. Nulling
    // nextRunAt instead of recomputing it would, because the worker's arming
    // branch clears lastRunAt.
    expect(scheduleRow(f.scheduleId).lastRunAt).toEqual(new Date('2026-08-01T03:00:00Z'));

    expect(h.audits.at(-1)).toMatchObject({
      action: 'schedule.update',
      targetType: 'Schedule',
      targetId: f.scheduleId,
      metadata: { name: 'Weeknights', reArmed: true },
    });
  });

  it('pausing leaves the stored fire time alone', async () => {
    const armed = new Date('2026-09-01T03:00:00Z');
    scheduleRow(f.scheduleId).nextRunAt = armed;

    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { enabled: false },
    );

    expect(status).toBe(200);
    expect(body.schedule.enabled).toBe(false);
    expect(scheduleRow(f.scheduleId).nextRunAt).toEqual(armed);
  });

  it('resuming pushes an overdue fire time into the future, so it does not run at once', async () => {
    const row = scheduleRow(f.scheduleId);
    row.enabled = false;
    // Paused days ago; the worker sweeps anything with nextRunAt <= now.
    row.nextRunAt = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    row.cron = '*/15 * * * *';

    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { enabled: true },
    );

    expect(status).toBe(200);
    expect(body.schedule.enabled).toBe(true);
    const next = new Date(body.schedule.nextRunAt).getTime();
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
  });

  it('refuses a cron the worker could not parse, and writes nothing', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { cron: 'every tuesday' },
    );

    expect(status).toBe(400);
    expect(body.error.message).toContain('is not a cron expression');
    expect(scheduleRow(f.scheduleId).cron).toBe('0 3 * * 1-5');
    expect(h.audits).toHaveLength(0);
  });

  /*
   * The gate is `Intl`, exactly as in the digest validator in routes/team.ts,
   * and ICU is looser than the error message suggests: it also accepts the
   * legacy abbreviations PST, EST and PST8PDT as aliases. Tightening past that
   * would fork a product-wide decision that lives in team.ts, so this proves
   * the refusal on a zone that genuinely does not exist — and the schedules
   * screen prints each row's resolved UTC offset, which is what makes whatever
   * was stored legible rather than taken on trust.
   */
  it('refuses a timezone that is not a zone at all', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { timezone: 'Mars/Phobos' },
    );

    expect(status).toBe(400);
    expect(body.error.message).toContain('is not a time zone');
    expect(scheduleRow(f.scheduleId).timezone).toBe('UTC');
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a repoint at another project’s suite', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { suiteId: f.siblingSuiteId },
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('That suite is not part of this project.');
    expect(scheduleRow(f.scheduleId).suiteId).toBe(f.suiteId);
  });

  it('refuses a repoint at another org’s suite', async () => {
    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { suiteId: f.otherOrgSuiteId },
    );

    expect(status).toBe(400);
    expect(scheduleRow(f.scheduleId).suiteId).toBe(f.suiteId);
  });

  it('refuses a repoint at another project’s environment', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { environmentId: f.siblingEnvId },
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('That environment is not part of this project.');
  });

  it('404s on another org’s schedule and leaves it untouched', async () => {
    const { status } = await call(
      'PATCH',
      `/automation/${f.otherOrgProjectId}/schedules/${f.otherOrgScheduleId}`,
      { enabled: false },
    );

    expect(status).toBe(404);
    expect(db.tables.schedule.find((r) => r.id === f.otherOrgScheduleId)!.enabled).toBe(true);
    expect(h.audits).toHaveLength(0);
  });

  it('404s on a schedule that belongs to a sibling project of the same org', async () => {
    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.siblingScheduleId}`,
      { enabled: false },
    );

    expect(status).toBe(404);
    expect(scheduleRow(f.siblingScheduleId).enabled).toBe(true);
  });

  it('refuses a VIEWER', async () => {
    h.actor = { ...h.actor, role: 'VIEWER' };
    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { enabled: false },
    );

    expect(status).toBe(403);
    expect(scheduleRow(f.scheduleId).enabled).toBe(true);
  });

  it('refuses an empty body rather than writing an audit row for nothing', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      {},
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('Nothing to update.');
    expect(h.audits).toHaveLength(0);
  });

  it('refuses an unknown key instead of accepting-and-ignoring it', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { orgId: OTHER_ORG, name: 'Renamed' },
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(scheduleRow(f.scheduleId).name).toBe('Nightly');
    expect(scheduleRow(f.scheduleId).orgId).toBe(ORG);
  });

  it('caps the name at 80 characters', async () => {
    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { name: 'n'.repeat(81) },
    );

    expect(status).toBe(400);
    expect(scheduleRow(f.scheduleId).name).toBe('Nightly');
  });

  it('re-validates a cron that is resubmitted unchanged, so a broken row cannot look fixed', async () => {
    scheduleRow(f.scheduleId).cron = 'nonsense';

    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/schedules/${f.scheduleId}`,
      { cron: 'nonsense' },
    );

    expect(status).toBe(400);
  });
});

describe('PATCH /automation/:projectId/monitors/:monitorId', () => {
  it('edits the interval, the threshold and the target', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/monitors/${f.monitorId}`,
      { name: 'Checkout', intervalMinutes: 5, failureThreshold: 4 },
    );

    expect(status).toBe(200);
    expect(body.monitor).toMatchObject({
      name: 'Checkout',
      intervalMinutes: 5,
      failureThreshold: 4,
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: 'monitor.update',
      targetType: 'Monitor',
      targetId: f.monitorId,
    });
  });

  it('resuming clears the streak so it cannot page on its first check', async () => {
    const row = monitorRow(f.monitorId);
    row.enabled = false;
    row.consecutiveFailures = 4;
    row.failureThreshold = 5;

    const { body } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      enabled: true,
    });

    expect(body.monitor).toMatchObject({ enabled: true, consecutiveFailures: 0 });
  });

  it('lowering the threshold below the standing streak restarts the count', async () => {
    monitorRow(f.monitorId).consecutiveFailures = 3;
    monitorRow(f.monitorId).failureThreshold = 5;

    const { body } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      failureThreshold: 2,
    });

    // Without this the worker's `streak === threshold` crossing walks 4, 5, 6
    // and never equals 2 again: the monitor would go permanently silent.
    expect(body.monitor).toMatchObject({ failureThreshold: 2, consecutiveFailures: 0 });
    expect(h.audits.at(-1)).toMatchObject({ metadata: { streakReset: true } });
  });

  it('lowering the threshold TO the standing streak also restarts the count', async () => {
    /*
     * The boundary, and the commonest way to hit this. `<` left the streak
     * alone here, so the worker's `streak === threshold` crossing walked 4, 5,
     * 6 and never equalled 3 again — the monitor went silent for the rest of
     * the outage, because of the change meant to make it alert sooner.
     */
    monitorRow(f.monitorId).consecutiveFailures = 3;
    monitorRow(f.monitorId).failureThreshold = 5;

    const { body } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      failureThreshold: 3,
    });

    expect(body.monitor).toMatchObject({ failureThreshold: 3, consecutiveFailures: 0 });
  });

  it('a patch that does not touch the threshold leaves an already-paged streak alone', async () => {
    // A monitor at its threshold has already paged. Renaming it must not
    // quietly wipe the streak that page was about — which a bare `<=` would.
    monitorRow(f.monitorId).consecutiveFailures = 5;
    monitorRow(f.monitorId).failureThreshold = 5;

    const { body } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      name: 'Renamed',
    });

    expect(body.monitor).toMatchObject({ name: 'Renamed', consecutiveFailures: 5 });
  });

  it('raising the threshold keeps the streak, because nothing has been missed', async () => {
    monitorRow(f.monitorId).consecutiveFailures = 3;

    const { body } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      failureThreshold: 8,
    });

    expect(body.monitor).toMatchObject({ failureThreshold: 8, consecutiveFailures: 3 });
  });

  it('caps the interval at a day and the threshold at ten', async () => {
    for (const body of [
      { intervalMinutes: 0 },
      { intervalMinutes: 1441 },
      { failureThreshold: 0 },
      { failureThreshold: 11 },
      { intervalMinutes: 5.5 },
    ]) {
      const { status } = await call(
        'PATCH',
        `/automation/${f.projectId}/monitors/${f.monitorId}`,
        body,
      );
      expect(status, JSON.stringify(body)).toBe(400);
    }
    expect(monitorRow(f.monitorId).intervalMinutes).toBe(15);
    expect(monitorRow(f.monitorId).failureThreshold).toBe(2);
  });

  it('refuses a repoint at another project’s suite', async () => {
    const { status } = await call('PATCH', `/automation/${f.projectId}/monitors/${f.monitorId}`, {
      suiteId: f.siblingSuiteId,
    });

    expect(status).toBe(400);
    expect(monitorRow(f.monitorId).suiteId).toBe(f.suiteId);
  });

  it('404s on another org’s monitor and leaves it untouched', async () => {
    const { status } = await call(
      'PATCH',
      `/automation/${f.otherOrgProjectId}/monitors/${f.otherOrgMonitorId}`,
      { enabled: false },
    );

    expect(status).toBe(404);
    expect(db.tables.monitor.find((r) => r.id === f.otherOrgMonitorId)!.enabled).toBe(true);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a VIEWER', async () => {
    h.actor = { ...h.actor, role: 'VIEWER' };
    const { status } = await call(
      'PATCH',
      `/automation/${f.projectId}/monitors/${f.monitorId}`,
      { enabled: false },
    );

    expect(status).toBe(403);
    expect(monitorRow(f.monitorId).enabled).toBe(true);
  });

  it('refuses an empty body', async () => {
    const { status, body } = await call(
      'PATCH',
      `/automation/${f.projectId}/monitors/${f.monitorId}`,
      {},
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('Nothing to update.');
  });
});
