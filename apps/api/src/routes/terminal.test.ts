/**
 * Tests for the terminal wire.
 *
 * This is the most dangerous router in the API — it queues commands for
 * execution on a machine inside a customer's network — so the cases below are
 * ordered by how expensive the bug would be rather than by how the file is laid
 * out.
 *
 *   1. **Org isolation, on every endpoint.** The routes query through the
 *      scoped `prisma` client inside the request's tenant scope, and that is
 *      INVISIBLE at the call site: there is no `orgId` in any `where` to
 *      review. So the fake below applies the scope exactly as the extension
 *      does, and every endpoint is driven from two orgs. Swap `prisma` for
 *      `unscoped(...)` anywhere in the router and these fail; nothing else in
 *      the build would notice.
 *
 *   2. **The target is resolved from the run, never from the request.** There
 *      is no field in any of these requests that names a host, a runner or a
 *      job, and the test that proves it is the one where org B asks for a
 *      session on org A's run and is told the run does not exist.
 *
 *   3. **The refusals are refusals, not TODOs.** A run on QAAI's shared
 *      workers, a run nobody is holding, an expired lease, a runner whose agent
 *      cannot do this — each is a distinct 422 with its own sentence, because
 *      each has a different thing to do about it.
 *
 *   4. **Every mutation is audited**, including the refused command, which is
 *      the single most interesting row this feature can produce.
 *
 *   5. **The agent half authenticates as a runner and is fenced by a lease.** A
 *      second runner in the same org, holding a perfectly valid token, must not
 *      be able to read the commands typed at the first one.
 *
 * Harness: the shape of runners.test.ts — mocked prisma module with a real
 * AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
    audits: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgres://localhost/none',
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

/*
 * The tenancy scope is real, not stubbed: the router's queries run in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran and the isolation tests would pass for a reason
 * that has nothing to do with the routes.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/* Each opens a connection at import time and none is reached by these routes. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));
vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));

vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
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

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

/**
 * Applies the tenant filter exactly as the extension does — merging the ambient
 * orgId into `where` for the filterable operations, post-checking ownership on
 * the unique ones. That merge IS the security property under test, so it is
 * modelled rather than assumed, and an unrecognised filter throws instead of
 * being shrugged at.
 */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (cond && typeof cond === 'object' && 'in' in cond) {
      return (cond.in as unknown[]).includes(value);
    }
    if (cond && typeof cond === 'object') {
      throw new Error(`fake prisma: unsupported condition on ${key}`);
    }
    return value === cond;
  });
}

function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function table(rows: Row[]) {
  const scope = (where: Row = {}): Row => {
    const orgId = h.currentOrg();
    return orgId ? { ...where, orgId } : { ...where };
  };

  return {
    rows,
    findFirst: async ({ where = {}, select, orderBy }: Row = {}) => {
      const found = rows.filter((row) => matches(row, scope(where)));
      if (orderBy) {
        const [key] = Object.keys(orderBy);
        found.sort((a, b) => String(b[key!] ?? '').localeCompare(String(a[key!] ?? '')));
      }
      return found[0] ? project(found[0], select) : null;
    },
    findMany: async ({ where = {}, select }: Row = {}) =>
      rows.filter((row) => matches(row, scope(where))).map((row) => project(row, select)),
    findUnique: async ({ where, select }: Row) => {
      // A unique lookup may be by any unique column, not just id — the runner
      // token path looks up by tokenHash.
      const row = rows.find((candidate) =>
        Object.entries(where).every(([key, value]) => candidate[key] === value),
      );
      // The extension checks ownership on the RESULT, because a unique lookup
      // cannot take an extra filter. Another org's row reads as not found.
      const orgId = h.currentOrg();
      if (!row || (orgId && row.orgId !== orgId)) return null;
      return project(row, select);
    },
    update: async ({ where, data, select }: Row) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      const orgId = h.currentOrg();
      if (!row || (orgId && row.orgId !== orgId)) {
        throw Object.assign(new Error('record not found'), { code: 'P2025' });
      }
      Object.assign(row, data);
      return project(row, select);
    },
  };
}

const NOW = Date.now();
const RUNNER_TOKEN = 'qaai_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TOKEN = 'qaai_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LEASE = 'lease_1';

const { hashToken } = await import('../lib/crypto.js');
const pty = await import('../lib/pty.js');

function seedRunner(over: Row = {}): Row {
  return {
    id: 'runner_1',
    orgId: 'org_1',
    name: 'staging-01',
    tokenHash: hashToken(RUNNER_TOKEN),
    tokenPrefix: 'qaai_rt_aaaaaaaa',
    pools: ['eu'],
    capabilities: { browsers: ['chromium'], toolchains: ['node', 'terminal'] },
    agentVersion: '1.4.0',
    platform: 'linux-x64',
    revokedAt: null,
    ...over,
  };
}

function seedRun(over: Row = {}): Row {
  return {
    id: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    status: 'RUNNING',
    runnerPool: 'eu',
    ...over,
  };
}

function seedJob(over: Row = {}): Row {
  return {
    id: 'job_1',
    orgId: 'org_1',
    runId: 'run_1',
    status: 'RUNNING',
    runnerId: 'runner_1',
    leaseId: LEASE,
    leaseExpiresAt: new Date(NOW + 60_000),
    claimedAt: new Date(NOW - 5_000),
    ...over,
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { terminalRouter } = await import('./terminal.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/terminal', terminalRouter);
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

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const agent = (path: string, body?: unknown, token = RUNNER_TOKEN, lease = LEASE) =>
  call(`/terminal/agent${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-qaai-lease': lease },
    body: JSON.stringify(body ?? {}),
  });

const openSession = (runId = 'run_1') =>
  call(`/terminal/runs/${runId}/sessions`, { method: 'POST' });

const run = (sessionId: string, key: string, command: string) =>
  call(`/terminal/sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { 'x-qaai-terminal-key': key },
    body: JSON.stringify({ command }),
  });

function install(seed: { runs?: Row[]; jobs?: Row[]; runners?: Row[] } = {}): void {
  h.db = {
    run: table(seed.runs ?? [seedRun()]),
    runnerJob: table(seed.jobs ?? [seedJob()]),
    runner: table(seed.runners ?? [seedRunner()]),
  };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits.length = 0;
  pty._resetSessions();
  install();
});

/** Open a session and hand back the pieces every later call needs. */
async function opened(): Promise<{ id: string; key: string }> {
  const res = await openSession();
  expect(res.status).toBe(201);
  return { id: res.body.session.id as string, key: res.body.key as string };
}

// ─── Org isolation ───────────────────────────────────────────────────────────

describe('org isolation', () => {
  it('refuses to open a session on another org’s run, as not-found', () => {
    // Never a 403: a different error would confirm the run id is real.
    h.actor = { userId: 'user_9', orgId: 'org_2', role: 'MEMBER', ip: null };
    return openSession().then((res) => {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  it('does not leak another org’s session to a command call', async () => {
    const session = await opened();
    h.actor = { userId: 'user_9', orgId: 'org_2', role: 'MEMBER', ip: null };
    const res = await run(session.id, session.key, 'pwd');
    expect(res.status).toBe(404);
  });

  it('does not leak another org’s session to the stream', async () => {
    const session = await opened();
    h.actor = { userId: 'user_9', orgId: 'org_2', role: 'MEMBER', ip: null };
    const res = await call(`/terminal/sessions/${session.id}/stream`);
    expect(res.status).toBe(404);
  });

  it('does not let another org close a session', async () => {
    const session = await opened();
    h.actor = { userId: 'user_9', orgId: 'org_2', role: 'ADMIN', ip: null };
    const res = await call(`/terminal/sessions/${session.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    // And it really is still open for its owner.
    h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
    expect(await run(session.id, session.key, 'pwd')).toMatchObject({ status: 202 });
  });

  it('never lists another org’s sessions to an admin', async () => {
    await opened();
    h.actor = { userId: 'user_9', orgId: 'org_2', role: 'ADMIN', ip: null };
    const res = await call('/terminal/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(0);
  });

  it('does not let a second member in the same org drive someone else’s session', async () => {
    // Same tenant, different person: the key is not a shared credential.
    const session = await opened();
    h.actor = { userId: 'user_2', orgId: 'org_1', role: 'MEMBER', ip: null };
    expect((await run(session.id, session.key, 'pwd')).status).toBe(404);
  });
});

// ─── Opening: every refusal ──────────────────────────────────────────────────

describe('opening a session', () => {
  it('opens against the runner holding the run and returns the limits', async () => {
    const res = await openSession();
    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ runId: 'run_1', runnerName: 'staging-01' });
    expect(res.body.key).toMatch(/^qaai_sh_/);
    expect(res.body.limits.maxSessionSeconds).toBe(
      Math.round(pty.TERMINAL_MAX_SESSION_MS / 1000),
    );
    expect(res.body.limits.idleSeconds).toBe(Math.round(pty.TERMINAL_IDLE_MS / 1000));
    expect(res.body.allowlist.length).toBe(pty.ALLOWED_COMMANDS.size);
  });

  it('never echoes the host it resolved — only the runner’s name', async () => {
    // Nothing in the response is an address, because nothing in the request was
    // one. The target came from the job row.
    const res = await openSession();
    expect(JSON.stringify(res.body)).not.toContain('runner_1');
  });

  it('refuses a run that executed on QAAI’s shared workers, and says why', async () => {
    install({ runs: [seedRun({ runnerPool: null })] });
    const res = await openSession();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('shared workers');
    expect(res.body.error.message).toContain('own runner pool');
  });

  it('refuses when no runner is holding the run', async () => {
    install({ jobs: [seedJob({ status: 'COMPLETED' })] });
    const res = await openSession();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('only while the run is executing');
  });

  it('refuses when the holder’s lease has already expired', async () => {
    install({ jobs: [seedJob({ leaseExpiresAt: new Date(NOW - 1_000) })] });
    const res = await openSession();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('gone silent');
  });

  it('refuses when the agent does not advertise the terminal capability', async () => {
    // The gate that stops this shipping as a prompt that streams nothing back
    // forever. It names the upgrade rather than the internal reason.
    install({ runners: [seedRunner({ capabilities: { toolchains: ['node'] } })] });
    const res = await openSession();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('does not support terminal sessions');
    expect(res.body.error.message).toContain('Upgrade the QAAI agent');
  });

  it('refuses when the runner has been revoked', async () => {
    install({ runners: [seedRunner({ revokedAt: new Date(NOW - 1_000) })] });
    expect((await openSession()).status).toBe(422);
  });

  it('refuses a run that does not exist', async () => {
    expect((await openSession('run_missing')).status).toBe(404);
  });

  it('caps how many sessions one org may hold open at once', async () => {
    for (let i = 0; i < pty.TERMINAL_MAX_SESSIONS_PER_ORG; i += 1) {
      h.actor = { userId: `user_${i}`, orgId: 'org_1', role: 'MEMBER', ip: null };
      expect((await openSession()).status, `session ${i}`).toBe(201);
    }
    h.actor = { userId: 'user_last', orgId: 'org_1', role: 'MEMBER', ip: null };
    const res = await openSession();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('already has');
  });

  it('refuses a VIEWER', async () => {
    h.actor = { userId: 'user_v', orgId: 'org_1', role: 'VIEWER', ip: null };
    const res = await openSession();
    expect(res.status).toBe(403);
  });
});

// ─── Auditing ────────────────────────────────────────────────────────────────

describe('auditing', () => {
  it('records who opened a shell, on what, and against which runner', async () => {
    await opened();
    const entry = h.audits.find((row) => row.action === 'terminal.session.opened');
    expect(entry).toBeDefined();
    expect(entry!.targetType).toBe('Run');
    expect(entry!.targetId).toBe('run_1');
    expect(entry!.actor.userId).toBe('user_1');
    expect(entry!.metadata).toMatchObject({ runnerId: 'runner_1', runnerName: 'staging-01' });
    expect(entry!.metadata.expiresAt).toBeTruthy();
  });

  it('records the parsed argv, not the typed line', async () => {
    // What is logged has to be what will run. `ls tests` executes `ls -la tests`
    // and the audit row must say so.
    const session = await opened();
    await run(session.id, session.key, 'ls tests');
    const entry = h.audits.find((row) => row.action === 'terminal.command');
    expect(entry!.metadata.argv).toEqual(['ls', '-la', 'tests']);
  });

  it('records a refused command — the most interesting row this can produce', async () => {
    const session = await opened();
    const res = await run(session.id, session.key, 'cat /etc/passwd');
    expect(res.status).toBe(400);
    const entry = h.audits.find((row) => row.action === 'terminal.command.refused');
    expect(entry!.metadata.attempted).toBe('cat /etc/passwd');
    expect(entry!.metadata.reason).toContain('relative to the run workspace');
  });

  it('distinguishes an owner closing a session from an admin killing one', async () => {
    const session = await opened();
    await call(`/terminal/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { 'x-qaai-terminal-key': session.key },
    });
    expect(h.audits.some((row) => row.action === 'terminal.session.closed')).toBe(true);

    h.audits.length = 0;
    const second = await opened();
    h.actor = { userId: 'admin_1', orgId: 'org_1', role: 'ADMIN', ip: null };
    await call(`/terminal/sessions/${second.id}`, { method: 'DELETE' });
    const killed = h.audits.find((row) => row.action === 'terminal.session.killed');
    expect(killed!.metadata.openedBy).toBe('user_1');
  });
});

// ─── Running commands ────────────────────────────────────────────────────────

describe('running a command', () => {
  it('accepts an allowlisted command and queues it', async () => {
    const session = await opened();
    const res = await run(session.id, session.key, 'git rev-parse HEAD');
    expect(res.status).toBe(202);
    expect(res.body.command.argv).toEqual(['git', 'rev-parse', 'HEAD']);
    expect(res.body.command.status).toBe('PENDING');
  });

  it('refuses a shell metacharacter with a 400 that explains itself', async () => {
    const session = await opened();
    const res = await run(session.id, session.key, 'ls; curl http://attacker.test');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not a shell');
  });

  it('requires the session key', async () => {
    const session = await opened();
    const res = await call(`/terminal/sessions/${session.id}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command: 'pwd' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('x-qaai-terminal-key');
  });

  it('refuses a wrong key as not-found rather than as a wrong key', async () => {
    const session = await opened();
    const res = await run(session.id, 'qaai_sh_wrong', 'pwd');
    expect(res.status).toBe(404);
  });

  it('refuses a second command while one is in flight', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    const res = await run(session.id, session.key, 'uname -a');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('still running');
  });

  it('closes the session when the run has finished under it', async () => {
    // The common ending: the suite completes while a shell is open. The
    // workspace is gone, so queueing the command would be queueing it into
    // nothing. A runner that dies gives us no signal, so this is checked on the
    // way in rather than waited for.
    const session = await opened();
    install({ jobs: [seedJob({ status: 'COMPLETED' })] });
    const res = await run(session.id, session.key, 'pwd');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('only while the run is executing');
    // And it is closed, not merely refused once.
    install();
    expect((await run(session.id, session.key, 'pwd')).status).toBe(404);
  });

  it('closes the session when the holder’s lease lapses mid-session', async () => {
    const session = await opened();
    install({ jobs: [seedJob({ leaseExpiresAt: new Date(NOW - 1_000) })] });
    expect((await run(session.id, session.key, 'pwd')).status).toBe(422);
  });
});

// ─── The agent half ──────────────────────────────────────────────────────────

describe('the agent half', () => {
  it('refuses a caller with no runner token', async () => {
    const res = await call('/terminal/agent/jobs/job_1/next', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses a revoked runner token exactly as it refuses an unknown one', async () => {
    install({ runners: [seedRunner({ revokedAt: new Date(NOW - 1) })] });
    const revoked = await agent('/jobs/job_1/next');
    install({ runners: [seedRunner()] });
    const unknown = await agent('/jobs/job_1/next', {}, OTHER_TOKEN);
    expect(revoked.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(revoked.body.error.message).toBe(unknown.body.error.message);
  });

  it('requires the fencing lease header', async () => {
    const res = await call('/terminal/agent/jobs/job_1/next', {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('x-qaai-lease');
  });

  it('refuses a stale lease with a conflict, not a forbidden', async () => {
    // The runner did nothing wrong; the world moved. Same vocabulary as
    // /runners/agent — a 403 would have an agent stop retrying forever.
    const res = await agent('/jobs/job_1/next', {}, RUNNER_TOKEN, 'lease_stale');
    expect(res.status).toBe(409);
  });

  it('answers null when nobody has a shell open on the job it holds', async () => {
    const res = await agent('/jobs/job_1/next');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ session: null, command: null });
  });

  it('hands over the queued command exactly once', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');

    const first = await agent('/jobs/job_1/next');
    expect(first.body.command.argv).toEqual(['pwd']);
    expect(first.body.session.id).toBe(session.id);

    const second = await agent('/jobs/job_1/next');
    expect(second.body.command).toBeNull();
  });

  it('hands over argv as an array, never a joined string', async () => {
    // The agent must spawn without a shell; giving it an array leaves nothing
    // to re-split and no place for a metacharacter to reappear.
    const session = await opened();
    await run(session.id, session.key, 'head spec.ts');
    const res = await agent('/jobs/job_1/next');
    expect(Array.isArray(res.body.command.argv)).toBe(true);
    expect(res.body.command.argv).toEqual(['head', '-n', '200', 'spec.ts']);
  });

  it('does not hand the session to the runner that reclaimed the job', async () => {
    /*
     * The one that matters, and it is not hypothetical. Runner A holds job_1
     * and someone opens a shell on it. Runner A goes silent, the reaper requeues
     * the job, and runner B in the same org claims it with a FRESH lease.
     * `requireLease` is satisfied — it fences on the lease id, not on who holds
     * it — so the only thing standing between runner B and the commands typed
     * at runner A is the session's binding to the runner id it was opened
     * against. The session belongs to a container that no longer exists.
     */
    const session = await opened();
    await run(session.id, session.key, 'cat .npmrc');

    install({
      runs: [seedRun()],
      jobs: [seedJob({ runnerId: 'runner_2', leaseId: 'lease_2' })],
      runners: [
        seedRunner(),
        seedRunner({ id: 'runner_2', name: 'staging-02', tokenHash: hashToken(OTHER_TOKEN) }),
      ],
    });

    const res = await agent('/jobs/job_1/next', {}, OTHER_TOKEN, 'lease_2');
    expect(res.status).toBe(200);
    expect(res.body.session).toBeNull();
    expect(res.body.command).toBeNull();
  });

  it('closes the orphaned session rather than leaving it looking live', async () => {
    // Same reclaim, from the user's side. Nothing else in the system tells the
    // API a job changed hands, so this poll is the only moment we can learn it.
    // Without the close, the person debugging watches a live-looking prompt
    // swallow commands until the idle timeout.
    const session = await opened();
    install({
      runs: [seedRun()],
      jobs: [seedJob({ runnerId: 'runner_2', leaseId: 'lease_2' })],
      runners: [
        seedRunner(),
        seedRunner({ id: 'runner_2', name: 'staging-02', tokenHash: hashToken(OTHER_TOKEN) }),
      ],
    });
    await agent('/jobs/job_1/next', {}, OTHER_TOKEN, 'lease_2');

    const res = await run(session.id, session.key, 'pwd');
    expect(res.status).toBe(404);
  });

  it('does not let a runner in another org write output into a session', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    const claimed = await agent('/jobs/job_1/next');
    const commandId = claimed.body.command.id as string;

    install({
      runs: [seedRun(), seedRun({ id: 'run_2', orgId: 'org_2' })],
      jobs: [seedJob(), seedJob({ id: 'job_2', orgId: 'org_2', runId: 'run_2', runnerId: 'runner_2', leaseId: 'lease_2' })],
      runners: [
        seedRunner(),
        seedRunner({ id: 'runner_2', orgId: 'org_2', name: 'other-org', tokenHash: hashToken(OTHER_TOKEN) }),
      ],
    });

    const res = await agent(
      `/jobs/job_2/commands/${commandId}/output`,
      { stream: 'stdout', chunk: 'stolen' },
      OTHER_TOKEN,
      'lease_2',
    );
    expect(res.status).toBe(404);
  });

  it('refuses output for a session bound to a DIFFERENT job of the same runner', async () => {
    /*
     * The fence the cross-org test above cannot reach, because it changes the
     * runner as well as the job.
     *
     * One runner, one org, two jobs. `requireLease` proves the runner still
     * holds the job in the URL — so a runner that has LOST job_1 (reaped, or
     * reclaimed) can present its still-valid lease for job_2 and write into the
     * session bound to job_1: fabricated output in a terminal pointed at a
     * container it no longer holds. Nothing crosses a tenant here, which is
     * exactly why the org test does not catch it.
     */
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    const claimed = await agent('/jobs/job_1/next');
    const commandId = claimed.body.command.id as string;

    // A second job held by the SAME runner in the SAME org, with a live lease.
    install({
      runs: [seedRun()],
      jobs: [seedJob(), seedJob({ id: 'job_2', leaseId: 'lease_2' })],
      runners: [seedRunner()],
    });

    // Same runner, same org, live lease — for the WRONG job.
    const res = await agent(
      `/jobs/job_2/commands/${commandId}/output`,
      { stream: 'stdout', chunk: 'fabricated' },
      undefined,
      'lease_2',
    );
    expect(res.status).toBe(404);
  });

  it('refuses an unknown command id', async () => {
    const res = await agent('/jobs/job_1/commands/cmd_nope/output', {
      stream: 'stdout',
      chunk: 'x',
    });
    expect(res.status).toBe(404);
  });

  it('validates the output body', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    const claimed = await agent('/jobs/job_1/next');
    const commandId = claimed.body.command.id as string;

    const badStream = await agent(`/jobs/job_1/commands/${commandId}/output`, {
      stream: 'stdin',
      chunk: 'x',
    });
    expect(badStream.status).toBe(400);

    const huge = await agent(`/jobs/job_1/commands/${commandId}/output`, {
      stream: 'stdout',
      chunk: 'x'.repeat(70_000),
    });
    expect(huge.status).toBe(400);
  });

  it('accepts output and an exit, and frees the session for the next command', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    const claimed = await agent('/jobs/job_1/next');
    const commandId = claimed.body.command.id as string;

    expect(
      (await agent(`/jobs/job_1/commands/${commandId}/output`, {
        stream: 'stdout',
        chunk: '/workspace\n',
      })).status,
    ).toBe(200);
    expect(
      (await agent(`/jobs/job_1/commands/${commandId}/exit`, { exitCode: 0 })).status,
    ).toBe(200);

    expect((await run(session.id, session.key, 'uname -a')).status).toBe(202);
  });
});

// ─── Streaming ───────────────────────────────────────────────────────────────

describe('the output stream', () => {
  it('streams the command and its output to the person who opened the session', async () => {
    const session = await opened();

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/terminal/sessions/${session.id}/stream`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    await run(session.id, session.key, 'pwd');
    const claimed = await agent('/jobs/job_1/next');
    const commandId = claimed.body.command.id as string;
    await agent(`/jobs/job_1/commands/${commandId}/output`, {
      stream: 'stdout',
      chunk: '/workspace\n',
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: output')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(seen).toContain('event: command');
    expect(seen).toContain('event: output');
    expect(seen).toContain('/workspace');
  });

  it('never puts the session key in the URL it needs', async () => {
    // A key in a query string is a key in the access log and the browser
    // history. The stream is authorised by the caller's own session instead.
    const session = await opened();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/terminal/sessions/${session.id}/stream`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    expect(response.url).not.toContain(session.key);
  });
});

// ─── Closing ─────────────────────────────────────────────────────────────────

describe('closing a session', () => {
  it('lets the owner close it with the key, and it stays closed', async () => {
    const session = await opened();
    const res = await call(`/terminal/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { 'x-qaai-terminal-key': session.key },
    });
    expect(res.status).toBe(200);
    expect((await run(session.id, session.key, 'pwd')).status).toBe(404);
  });

  it('makes the owner present the key', async () => {
    const session = await opened();
    const res = await call(`/terminal/sessions/${session.id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('lets an admin kill a session they never opened, without the key', async () => {
    // A command channel into the customer's network that only its opener can
    // close is one an administrator cannot stop.
    const session = await opened();
    h.actor = { userId: 'admin_1', orgId: 'org_1', role: 'ADMIN', ip: null };
    const res = await call(`/terminal/sessions/${session.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  it('does not let another member kill someone else’s session', async () => {
    const session = await opened();
    h.actor = { userId: 'user_2', orgId: 'org_1', role: 'MEMBER', ip: null };
    const res = await call(`/terminal/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { 'x-qaai-terminal-key': session.key },
    });
    expect(res.status).toBe(404);
  });

  it('leaves the agent with nothing to pick up after a kill', async () => {
    const session = await opened();
    await run(session.id, session.key, 'pwd');
    h.actor = { userId: 'admin_1', orgId: 'org_1', role: 'ADMIN', ip: null };
    await call(`/terminal/sessions/${session.id}`, { method: 'DELETE' });

    const res = await agent('/jobs/job_1/next');
    expect(res.body).toMatchObject({ session: null, command: null });
  });
});

// ─── The published allowlist ─────────────────────────────────────────────────

describe('the allowlist endpoint', () => {
  it('publishes the boundary so a customer does not have to take it on trust', async () => {
    const res = await call('/terminal/allowlist');
    expect(res.status).toBe(200);
    expect(res.body.allowlist.length).toBe(pty.ALLOWED_COMMANDS.size);
    expect(res.body.limits.maxOutputBytes).toBe(pty.TERMINAL_MAX_OUTPUT_BYTES);
  });

  it('lists nothing that writes or fetches', async () => {
    const res = await call('/terminal/allowlist');
    const names = (res.body.allowlist as Row[]).map((entry) => entry.command);
    for (const forbidden of ['env', 'curl', 'sh', 'rm']) expect(names).not.toContain(forbidden);
  });
});

describe('unknown paths', () => {
  it('answers an unknown agent path without implying the route exists', async () => {
    const res = await agent('/jobs/job_1/nope');
    expect(res.status).toBe(404);
  });

  it('answers an unknown cockpit path with a 404', async () => {
    expect((await call('/terminal/nope')).status).toBe(404);
  });
});
