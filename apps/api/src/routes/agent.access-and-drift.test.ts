/**
 * The request paths for the four tables that landed with a writer and no door.
 *
 * ── What these cover ────────────────────────────────────────────────────────
 *
 * A re-enumeration trigger could only be fired by the worker's own tick, so a
 * CI step and a deploy webhook had nowhere to POST and no endpoint even existed
 * to CREATE a trigger — which made "the denominator goes stale and nobody is
 * told" the default state of every install. A SurfaceDriftRecord was computed
 * and on no screen. The route x role matrix was visible only inside one
 * run-finished event. And nothing read or wrote EnvironmentAccess at all, so an
 * application behind reCAPTCHA or a WAF could neither tell us how to get in nor
 * be told why its coverage was zero.
 *
 * Every read below is asserted to report an EMPTY table as "nobody has looked"
 * rather than as a clean result, because that substitution is the single defect
 * this whole round exists to remove.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { RE_ENUMERATION_RUN_STATES, triggerHasRun } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  db: Record<string, unknown>;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  enqueued: Array<{ name: string; payload: Row }>;
  enqueueThrows: boolean;
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
    enqueued: [],
    enqueueThrows: false,
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
    ANTHROPIC_API_KEY: '',
  },
  isProd: false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} },
  currentRequestId: () => 'req_test',
  setRequestActor: () => {},
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.db[key] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) => store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

vi.mock('../lib/queues.js', () => ({
  enqueue: async (name: string, payload: Row) => {
    if (h.enqueueThrows) throw new Error('redis is down');
    h.enqueued.push({ name, payload });
    return 'job_1';
  },
}));
vi.mock('../lib/storage.js', () => ({ storage: {} }));
vi.mock('../lib/events.js', () => ({ publish: () => {}, subscribe: () => () => {} }));
vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
}));

/*
 * The VAULT IS MOCKED and `github-app.js` IS NOT. The signature check is the
 * authentication on an unauthenticated route, so it is exercised against the
 * real `webhookSignatureMatches` — a mocked HMAC would assert that the route
 * calls a function, which is not the property worth pinning.
 */
vi.mock('../lib/vault.js', () => ({
  open: (valueEnc: string) => {
    if (valueEnc === 'retired') throw new Error('sealed under a retired key');
    return valueEnc.replace(/^enc:/, '');
  },
  seal: (plaintext: string) => ({ valueEnc: `enc:${plaintext}`, keyVersion: 1, hint: 'xxxx' }),
  needsRotation: () => false,
}));

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

const express = (await import('express')).default;
const { agentRouter, reEnumerationWebhookMessage, ACCESS_CELL_LIMIT } = await import('./agent.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/', agentRouter);
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
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const ENV = {
  id: 'env_1',
  orgId: 'org_1',
  projectId: 'proj_1',
  kind: 'STAGING' as const,
  baseUrl: 'https://staging.example.com',
};
const WEBHOOK_SECRET = 'whsec_not_a_real_one';
const URL_BASE = '/projects/proj_1/environments/env_1';

/** State the delegates below read, reset per test. */
let triggers: Row[] = [];
let secrets: Row[] = [];
let drifts: Row[] = [];
let attempts: Row[] = [];
let cells: Row[] = [];
let accessRow: Row | null = null;
let authProfiles: Row[] = [];
let upserted: Row[] = [];

function trigger(over: Row = {}): Row {
  return {
    id: 'trg_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    name: 'on-deploy',
    kind: 'DEPLOY',
    enabled: true,
    cron: null,
    timezone: null,
    webhookSecretName: 'DEPLOY_HOOK',
    lastRunState: 'NEVER_RUN',
    lastRunAt: null,
    lastFailureMessage: null,
    consecutiveFailures: 0,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

function sign(message: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(message, 'utf8')).digest('hex')}`;
}

function webhookHeaders(over: { name?: string; timestamp?: string; secret?: string } = {}): Record<string, string> {
  const name = over.name ?? 'on-deploy';
  const timestamp = over.timestamp ?? new Date().toISOString();
  const message = reEnumerationWebhookMessage({
    projectId: 'proj_1',
    environmentId: 'env_1',
    triggerName: name,
    timestamp,
  });
  return {
    'x-qaai-trigger': name,
    'x-qaai-timestamp': timestamp,
    'x-qaai-signature': sign(message, over.secret),
  };
}

beforeEach(() => {
  h.audits = [];
  h.enqueued = [];
  h.enqueueThrows = false;
  triggers = [trigger()];
  secrets = [{ id: 's1', environmentId: 'env_1', name: 'DEPLOY_HOOK', valueEnc: `enc:${WEBHOOK_SECRET}`, keyVersion: 1 }];
  drifts = [];
  attempts = [];
  cells = [];
  accessRow = null;
  authProfiles = [];
  upserted = [];

  h.db = {
    project: { findUnique: async () => ({ id: 'proj_1' }) },
    environment: { findUnique: async ({ where }: Row) => (where.id === 'env_1' ? ENV : null) },
    reEnumerationTrigger: {
      findUnique: async ({ where }: Row) =>
        triggers.find(
          (row) =>
            row.environmentId === where.environmentId_name.environmentId &&
            row.name === where.environmentId_name.name,
        ) ?? null,
      findMany: async () => triggers,
      // The claim, as Postgres arbitrates it: the where clause pins the row to
      // the values that were READ, so a second caller matches nothing.
      updateMany: async ({ where, data }: Row) => {
        const row = triggers.find((candidate) => candidate.id === where.id);
        if (!row) return { count: 0 };
        if ('lastRunAt' in where && row.lastRunAt !== where.lastRunAt) return { count: 0 };
        if (where.lastRunState?.not && row.lastRunState === where.lastRunState.not) return { count: 0 };
        if (where.lastRunState && typeof where.lastRunState === 'string' && row.lastRunState !== where.lastRunState) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      upsert: async ({ create, update, where }: Row) => {
        const existing = triggers.find(
          (row) =>
            row.environmentId === where.environmentId_name.environmentId &&
            row.name === where.environmentId_name.name,
        );
        const row = existing ? Object.assign(existing, update) : trigger(create);
        if (!existing) triggers.push(row);
        upserted.push(row);
        return row;
      },
    },
    secret: {
      findUnique: async ({ where }: Row) =>
        secrets.find(
          (row) =>
            row.environmentId === where.environmentId_name.environmentId &&
            row.name === where.environmentId_name.name,
        ) ?? null,
    },
    surfaceDriftRecord: { findMany: async () => drifts },
    roleCrawlAttempt: { findMany: async () => attempts },
    routeAccessCell: { findMany: async () => cells, count: async () => cells.length },
    environmentAccess: {
      findUnique: async () => accessRow,
      upsert: async ({ create, update }: Row) => {
        accessRow = accessRow ? Object.assign(accessRow, update) : { ...create };
        upserted.push(accessRow as Row);
        return accessRow;
      },
    },
    authProfile: {
      groupBy: async () => authProfiles,
    },
    coverageItem: { findMany: async () => [] },
  };
});

// ─── The deploy webhook ──────────────────────────────────────────────────────

describe('the deploy webhook', () => {
  it('fires the trigger and asks for a crawl at the environment’s own width', async () => {
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: webhookHeaders(),
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ fired: true });
    expect(h.enqueued).toHaveLength(1);
    /*
     * ZERO IS NOT A PLACEHOLDER. The explore processor reads a non-positive
     * budget as "no caller override" and lets Environment.crawlPolicy decide. A
     * hard-coded 60 here would re-enumerate a 412-route application as 60
     * routes every deploy and call the difference drift.
     */
    expect(h.enqueued[0]?.payload).toMatchObject({
      projectId: 'proj_1',
      environmentId: 'env_1',
      maxPages: 0,
      maxDepth: 0,
      autoApprove: false,
      requestedBy: 're-enumeration:trg_1',
    });
    // Claimed BEFORE the enqueue, so a second delivery cannot double-fire.
    expect(triggers[0]?.lastRunState).toBe('RUNNING');
  });

  it('REFUSES a bad signature, and claims nothing', async () => {
    const headers = webhookHeaders();
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: { ...headers, 'x-qaai-signature': sign('something else') },
    });

    expect(res.status).toBe(401);
    expect(h.enqueued).toEqual([]);
    expect(triggers[0]?.lastRunState).toBe('NEVER_RUN');
  });

  it('refuses a signature for a DIFFERENT trigger on the same environment', async () => {
    /*
     * The trigger name is in the signed material. Without it one valid
     * signature would fire every trigger on the environment, which on an
     * install with a cheap preview trigger and an expensive production one is
     * not a theoretical difference.
     */
    triggers.push(trigger({ id: 'trg_2', name: 'on-prod-deploy' }));
    const stolen = webhookHeaders({ name: 'on-deploy' });
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: { ...stolen, 'x-qaai-trigger': 'on-prod-deploy' },
    });

    expect(res.status).toBe(401);
    expect(h.enqueued).toEqual([]);
  });

  it('calls a stale timestamp a clock problem, not a bad secret', async () => {
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: webhookHeaders({ timestamp: new Date(Date.now() - 60 * 60_000).toISOString() }),
    });

    // 400 and not 401: the caller is probably right and their clock is wrong,
    // and a skew error that reads as a bad secret sends them to the wrong fix.
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/Check the clock/);
    expect(h.enqueued).toEqual([]);
  });

  it('refuses a trigger that is not a DEPLOY trigger', async () => {
    triggers = [trigger({ kind: 'CI' })];
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: webhookHeaders(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toMatch(/is a CI trigger/);
  });

  it('refuses when the named vault entry cannot be read, and says which', async () => {
    secrets = [{ ...secrets[0], valueEnc: 'retired' }];
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: webhookHeaders(),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toContain('DEPLOY_HOOK');
    // The NAME, never the value.
    expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('never puts the shared secret in a response, on any path', async () => {
    const ok = await call(`${URL_BASE}/re-enumerate/webhook`, { method: 'POST', headers: webhookHeaders() });
    const bad = await call(`${URL_BASE}/re-enumerate/webhook`, {
      method: 'POST',
      headers: { ...webhookHeaders(), 'x-qaai-signature': 'sha256=0' },
    });
    for (const res of [ok, bad]) expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
  });

  it('refuses a second delivery while the first crawl is in flight', async () => {
    const first = await call(`${URL_BASE}/re-enumerate/webhook`, { method: 'POST', headers: webhookHeaders() });
    expect(first.body.fired).toBe(true);

    const second = await call(`${URL_BASE}/re-enumerate/webhook`, { method: 'POST', headers: webhookHeaders() });
    expect(second.body).toEqual({ fired: false, why: 'another caller claimed this trigger first' });
    // One crawl, not two browsers at the customer's application.
    expect(h.enqueued).toHaveLength(1);
  });

  it('RELEASES the claim when the crawl could not be queued', async () => {
    /*
     * A trigger left RUNNING against a crawl that was never queued waits out
     * the worker's run timeout and is then recorded FAILED — which reads as a
     * fact about the customer's application. A queue that would not take the
     * job is a fact about US.
     */
    h.enqueueThrows = true;
    /*
     * The mock's `findUnique` hands back the LIVE row object, so the claim's
     * write is visible through the handle the route is holding. Real Prisma
     * never aliases like that — this is deliberately harsher than reality,
     * because a release that reads the state back off that handle restores
     * RUNNING and strands the trigger forever.
     */
    const res = await call(`${URL_BASE}/re-enumerate/webhook`, { method: 'POST', headers: webhookHeaders() });

    expect(res.body).toEqual({ fired: false, why: 'the crawl could not be queued' });
    expect(triggers[0]?.lastRunState).toBe('NEVER_RUN');
    expect(triggers[0]?.lastRunAt).toBeNull();
  });
});

// ─── Firing CI and MANUAL, and creating a trigger at all ─────────────────────

describe('firing a trigger from a request', () => {
  it('fires a CI trigger', async () => {
    triggers = [trigger({ kind: 'CI', name: 'ci', webhookSecretName: null })];
    const res = await call(`${URL_BASE}/re-enumerate`, {
      method: 'POST',
      body: JSON.stringify({ triggerName: 'ci' }),
    });
    expect(res.status).toBe(202);
    expect(res.body.fired).toBe(true);
    expect(h.audits[0]?.action).toBe('surface.re_enumeration.fired');
    // Countable, so a dashboard can say "3 of 11 fires were refused".
    expect(h.audits[0]?.metadata).toMatchObject({ kind: 'CI', fired: true });
  });

  it('refuses a SCHEDULE or DEPLOY trigger from this route', async () => {
    for (const kind of ['SCHEDULE', 'DEPLOY'] as const) {
      triggers = [trigger({ kind, name: 'x' })];
      const res = await call(`${URL_BASE}/re-enumerate`, {
        method: 'POST',
        body: JSON.stringify({ triggerName: 'x' }),
      });
      expect(res.status).toBe(422);
      expect(h.enqueued).toEqual([]);
    }
  });

  it('reports a disabled trigger as not fired, rather than firing it', async () => {
    triggers = [trigger({ kind: 'MANUAL', name: 'm', enabled: false })];
    const res = await call(`${URL_BASE}/re-enumerate`, {
      method: 'POST',
      body: JSON.stringify({ triggerName: 'm' }),
    });
    expect(res.body).toEqual({ fired: false, why: 'the trigger is disabled' });
    expect(h.enqueued).toEqual([]);
  });
});

describe('configuring a trigger', () => {
  it('stores a cron for SCHEDULE and NULL for every other kind', async () => {
    /*
     * The mutation this kills is writing `input.cron` through unconditionally.
     * A CI trigger with a cron is a trigger that fires on a timer the customer
     * did not ask for, and `* * * * *` as a default would be obeyed.
     */
    await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'nightly', kind: 'SCHEDULE', cron: '0 3 * * *', timezone: 'Europe/London' }),
    });
    expect(upserted.at(-1)).toMatchObject({ cron: '0 3 * * *', timezone: 'Europe/London' });

    await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'ci', kind: 'CI', cron: '0 3 * * *' }),
    });
    expect(upserted.at(-1)).toMatchObject({ kind: 'CI', cron: null, timezone: null });
  });

  it('clears the cron on the UPDATE path too, when a trigger changes kind', async () => {
    /*
     * The create branch and the update branch of one upsert are two pieces of
     * code, and a mutation applied to only the update branch SURVIVED the first
     * version of the test above — it created new triggers every time, so half
     * the endpoint was never executed. A customer who converts a nightly
     * trigger to a CI one takes the update branch, and a leftover cron there is
     * a trigger that keeps firing on a timer after being told not to.
     */
    triggers = [trigger({ name: 'nightly', kind: 'SCHEDULE', cron: '0 3 * * *', timezone: 'Europe/London', webhookSecretName: null })];
    await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'nightly', kind: 'CI' }),
    });
    expect(upserted.at(-1)).toMatchObject({ kind: 'CI', cron: null, timezone: null });

    // And the reverse: a DEPLOY trigger converted away loses its secret name.
    triggers = [trigger({ name: 'hook', kind: 'DEPLOY', webhookSecretName: 'DEPLOY_HOOK' })];
    await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'hook', kind: 'MANUAL' }),
    });
    expect(upserted.at(-1)).toMatchObject({ kind: 'MANUAL', webhookSecretName: null });
  });

  it('refuses a cron the scheduler cannot read, instead of storing it', async () => {
    const res = await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'nightly', kind: 'SCHEDULE', cron: 'every tuesday-ish' }),
    });
    expect(res.status).toBe(400);
    expect(upserted).toEqual([]);
  });

  it('refuses a SCHEDULE trigger with no cron, which would never fire', async () => {
    const res = await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'nightly', kind: 'SCHEDULE' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toMatch(/nothing would ever fire it/);
  });

  it('refuses a DEPLOY trigger with no shared secret', async () => {
    const res = await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'd', kind: 'DEPLOY' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toMatch(/needs a shared secret/);
  });

  it('refuses a secret NAME that has no vault entry behind it', async () => {
    // Otherwise the webhook exists, every delivery is rejected, and the
    // customer finds out at deploy time.
    const res = await call(`${URL_BASE}/re-enumeration`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'd', kind: 'DEPLOY', webhookSecretName: 'NOT_THERE' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toContain('NOT_THERE');
  });
});

describe('reading the triggers', () => {
  it('says a NEVER_RUN trigger has never run, and never says "no drift"', async () => {
    triggers = [trigger({ kind: 'SCHEDULE', lastRunState: 'NEVER_RUN', lastRunAt: null })];
    const res = await call(`${URL_BASE}/re-enumeration`);

    expect(res.body.triggers[0].hasRun).toBe(false);
    expect(res.body.triggers[0].staleness).toMatch(/never been re-enumerated/);
    expect(res.body.triggers[0].staleness).toMatch(/no comparison has been made/);
    expect(JSON.stringify(res.body)).not.toMatch(/no drift/i);
  });

  it('reports a run of consecutive failures as a count', async () => {
    triggers = [trigger({ kind: 'SCHEDULE', lastRunState: 'FAILED', lastRunAt: new Date(), consecutiveFailures: 6 })];
    const res = await call(`${URL_BASE}/re-enumeration`);
    expect(res.body.triggers[0].hasRun).toBe(true);
    expect(res.body.triggers[0].staleness).toMatch(/failed 6 run\(s\) in a row/);
  });

  it('decides hasRun from the STATE, for every state the enum has', async () => {
    /*
     * The run-time half of the parity pattern. `lastRunAt !== null` is the
     * tempting local answer and it is a SECOND predicate: the moment a state is
     * added, or a row is written with one field and not the other, the banner
     * and `triggerHasRun` disagree and only one of them is on screen. This
     * pins the endpoint to the shared predicate across the whole enum rather
     * than on the one row a writer happens to produce.
     */
    triggers = RE_ENUMERATION_RUN_STATES.map((state, index) =>
      trigger({ id: `trg_${index}`, name: `t${index}`, lastRunState: state, lastRunAt: null }),
    );
    const res = await call(`${URL_BASE}/re-enumeration`);
    expect(res.body.triggers.map((row: Row) => row.hasRun)).toEqual(
      RE_ENUMERATION_RUN_STATES.map((state) => triggerHasRun(state)),
    );
  });

  it('reports NO triggers as "nothing is watching", not as health', async () => {
    triggers = [];
    const res = await call(`${URL_BASE}/re-enumeration`);
    expect(res.body.triggers).toEqual([]);
    expect(res.body.why).toMatch(/Nothing is watching for drift/);
  });
});

// ─── Drift ───────────────────────────────────────────────────────────────────

function drift(over: Row = {}): Row {
  return {
    id: 'drift_1',
    currentFlowMapId: 'fm_2',
    baselineFlowMapId: 'fm_1',
    comparability: 'COMPARABLE',
    routesAdded: 4,
    routesRemoved: 0,
    routesChanged: 1,
    controlsAdded: 2,
    controlsRemoved: 0,
    newSurfaceWithoutTests: 4,
    detail: { why: null },
    comparedAt: new Date('2026-10-24T02:00:00Z'),
    createdAt: new Date('2026-10-24T02:00:00Z'),
    producedByTrigger: { id: 'trg_1', name: 'nightly', kind: 'SCHEDULE' },
    ...over,
  };
}

describe('reading the drift feed', () => {
  it('reports the headline count for a real comparison', async () => {
    drifts = [drift()];
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records[0].newSurfaceWithoutTests).toBe(4);
    expect(res.body.records[0].counts).toMatchObject({ routesAdded: 4, routesChanged: 1 });
  });

  it('reports NULL, never 0, for a comparison that could not happen', async () => {
    drifts = [
      drift({
        comparability: 'UNCOMPARABLE_NO_BASELINE',
        baselineFlowMapId: null,
        routesAdded: null,
        newSurfaceWithoutTests: null,
        comparedAt: null,
        detail: { why: 'this is the first stored crawl of this environment' },
      }),
    ];
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records[0].newSurfaceWithoutTests).toBeNull();
    expect(res.body.records[0].counts).toBeNull();
    expect(res.body.records[0].why).toMatch(/first stored crawl/);
  });

  it('refuses a COMPARABLE row whose count is missing, instead of reporting 0', async () => {
    /*
     * That row is a WRITER BUG, and a 0 would hide it behind a green tick. The
     * mutation this kills is reading the column directly instead of through
     * `newSurfaceWithoutTests`.
     */
    drifts = [drift({ newSurfaceWithoutTests: null })];
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records[0].newSurfaceWithoutTests).toBeNull();
  });

  it('never publishes a count that an uncomparable row happens to carry', async () => {
    // A writer that filled a count on an UNCOMPARABLE record must not reach a
    // screen through this endpoint.
    drifts = [drift({ comparability: 'NOT_COMPARED', routesAdded: 99, newSurfaceWithoutTests: 99 })];
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records[0].counts).toBeNull();
    expect(res.body.records[0].newSurfaceWithoutTests).toBeNull();
    expect(JSON.stringify(res.body.records[0].counts)).not.toContain('99');
  });

  it('surfaces a refused REMOVAL as refused, not as zero removals', async () => {
    drifts = [
      drift({
        routesRemoved: null,
        detail: { why: null, truncation: { removalsRefusedBecause: 'the per-template budget bit on /orders/:id' } },
      }),
    ];
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records[0].removalsRefusedBecause).toMatch(/per-template budget/);
    expect(res.body.records[0].counts.routesRemoved).toBeNull();
  });

  it('reports an empty feed as "nothing was compared", not as no drift', async () => {
    const res = await call(`${URL_BASE}/surface-drift`);
    expect(res.body.records).toEqual([]);
    expect(res.body.why).toMatch(/NOT a report that nothing changed/);
  });
});

// ─── The authorization axis ──────────────────────────────────────────────────

function cell(over: Row = {}): Row {
  return {
    routeTemplate: '/admin',
    role: 'admin',
    outcome: 'ALLOWED',
    basis: 'OBSERVED',
    status: 200,
    finalUrl: 'https://staging.example.com/admin',
    probedAt: new Date('2026-10-24T02:00:00Z'),
    ...over,
  };
}

describe('reading the access matrix', () => {
  it('reports NOT_PROBED when no access row exists, not "nothing is blocking us"', async () => {
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.access).toBeNull();
    expect(res.body.reachability).toBe('NOT_PROBED');
    expect(res.body.reachabilityWhy).toMatch(/not a report that nothing is blocking us/);
  });

  it('reports an empty matrix as unprobed, not as an app with no role restrictions', async () => {
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.cells).toEqual([]);
    expect(res.body.counts).toMatchObject({ total: 0, measured: 0 });
    expect(res.body.why).toMatch(/NOT a report that the application has no role restrictions/);
  });

  it('counts only OBSERVED, probed cells as measured', async () => {
    cells = [
      cell(),
      cell({ routeTemplate: '/admin', role: 'member', outcome: 'FORBIDDEN', status: 403 }),
      // Neither of these is a measurement of authorization.
      cell({ routeTemplate: '/admin', role: 'viewer', outcome: 'NOT_PROBED', status: null, probedAt: null }),
      cell({ routeTemplate: '/billing', role: 'member', outcome: 'ERRORED', status: 500 }),
      cell({ routeTemplate: '/billing', role: 'admin', outcome: 'ALLOWED', basis: 'DECLARED', status: null }),
    ];
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.counts).toMatchObject({ total: 5, shown: 5, measured: 2, notMeasured: 3 });
  });

  it('REFUSES to say a role has no extra surface when its login failed', async () => {
    attempts = [
      {
        role: 'admin',
        authProfileId: 'prof_1',
        outcome: 'LOGIN_FAILED',
        detail: 'the application answered and said no',
        remedy: 'check the stored password',
        attemptedAt: new Date(),
        routesReached: null,
        routesNewToThisRole: null,
        cappedBy: null,
        atLeastMoreRoutes: null,
      },
    ];
    const res = await call(`${URL_BASE}/access`);
    // null, not false: "admin sees nothing extra" is the dangerous sentence.
    expect(res.body.roles[0].hadNoExtraSurface).toBeNull();
    expect(res.body.roles[0].fault).toBe('THEIRS');
    expect(res.body.roles[0].routesReached).toBeNull();
  });

  it('REFUSES to answer for a capped crawl that happened to find nothing new', async () => {
    attempts = [
      {
        role: 'member',
        authProfileId: 'prof_2',
        outcome: 'CRAWLED_PARTIAL',
        detail: null,
        remedy: null,
        attemptedAt: new Date(),
        routesReached: 40,
        routesNewToThisRole: 0,
        cappedBy: 'the page budget',
        atLeastMoreRoutes: 240,
      },
    ];
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.roles[0].hadNoExtraSurface).toBeNull();
    // The disclosure pair, as a count AND a reason.
    expect(res.body.roles[0].cappedBy).toBe('the page budget');
    expect(res.body.roles[0].atLeastMoreRoutes).toBe(240);
  });

  it('answers only for a role whose crawl actually completed', async () => {
    attempts = [
      {
        role: 'viewer',
        authProfileId: 'prof_3',
        outcome: 'CRAWLED',
        detail: null,
        remedy: null,
        attemptedAt: new Date(),
        routesReached: 12,
        routesNewToThisRole: 0,
        cappedBy: null,
        atLeastMoreRoutes: null,
      },
    ];
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.roles[0].hadNoExtraSurface).toBe(true);
    expect(res.body.roles[0].fault).toBe('NOBODY');
  });

  it('discloses the page size as a COUNT and a REASON, never as a shorter matrix', async () => {
    cells = Array.from({ length: ACCESS_CELL_LIMIT + 7 }, (_unused, index) =>
      cell({ routeTemplate: `/r${index}` }),
    );
    const res = await call(`${URL_BASE}/access`);
    expect(res.body.cells).toHaveLength(ACCESS_CELL_LIMIT);
    expect(res.body.counts.total).toBe(ACCESS_CELL_LIMIT + 7);
    expect(res.body.atLeastMoreCells).toBe(7);
    expect(res.body.cappedBy).toContain(String(ACCESS_CELL_LIMIT));
  });
});

// ─── Telling QAAI how to get in ──────────────────────────────────────────────

describe('configuring an environment’s access', () => {
  it('records UNREACHABLE with a remedy when nothing legitimate is configured', async () => {
    const res = await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({ botProtection: { provider: 'TURNSTILE', bypassMode: 'NOT_CONFIGURED' } }),
    });

    expect(res.status).toBe(200);
    expect(res.body.access.reachability).toBe('UNREACHABLE_BEHIND_BOT_PROTECTION');
    expect(res.body.access.remedy).toMatch(/test keys/);
  });

  it('NEVER reports REACHABLE from configuration alone', async () => {
    /*
     * The whole point of the state machine. A customer who says "we configured
     * the provider's test keys" has told us a FACT ABOUT THEIR CONFIGURATION,
     * and reporting that as reachable would be reporting as measured a thing
     * nobody measured.
     */
    for (const bypassMode of ['PROVIDER_TEST_KEYS', 'ALLOWLISTED_BY_CUSTOMER'] as const) {
      const res = await call(`${URL_BASE}/access`, {
        method: 'PUT',
        body: JSON.stringify({ botProtection: { provider: 'TURNSTILE', bypassMode } }),
      });
      expect(res.body.access.reachability).toBe('NOT_PROBED');
      expect(res.body.note).toMatch(/not a measurement/);
    }
  });

  it('refuses a signed bypass whose vault entry does not exist', async () => {
    const res = await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({
        botProtection: {
          provider: 'WAF',
          bypassMode: 'SIGNED_BYPASS_HEADER',
          bypassHeaderName: 'x-edge-bypass',
          bypassSecretName: 'MISSING',
        },
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.message).toContain('MISSING');
    expect(res.body.error?.message).toMatch(/reports it as a defect in your application/);
  });

  it('refuses a signed bypass mode that carries nothing to send', async () => {
    const res = await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({ botProtection: { provider: 'WAF', bypassMode: 'SIGNED_BYPASS_HEADER' } }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an Authorization header with an inline value', async () => {
    const res = await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({
        botProtection: { provider: 'NONE', bypassMode: 'NOT_CONFIGURED' },
        extraHeaders: [{ name: 'Authorization', value: 'Bearer abc' }],
      }),
    });
    expect(res.status).toBe(400);
    expect(accessRow).toBeNull();
  });

  it('leaves the stored headers ALONE when the request omits them', async () => {
    /*
     * null means nobody configured headers; `[]` means somebody looked and
     * chose none. The mutation this kills is defaulting to `[]`, which erases a
     * decision the customer made on a different screen.
     */
    accessRow = {
      orgId: 'org_1',
      environmentId: 'env_1',
      provider: 'NONE',
      bypassMode: 'NOT_CONFIGURED',
      bypassHeaderName: null,
      bypassSecretName: null,
      extraHeaders: [{ name: 'X-Environment', value: 'staging' }],
      reachability: 'NOT_PROBED',
      remedy: null,
    };
    const res = await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({ botProtection: { provider: 'WAF', bypassMode: 'ALLOWLISTED_BY_CUSTOMER' } }),
    });
    expect(res.body.access.extraHeaderNames).toEqual(['X-Environment']);
  });

  it('audits header NAMES and never a value', async () => {
    secrets.push({ id: 's2', environmentId: 'env_1', name: 'TENANT', valueEnc: 'enc:t0ps3cret', keyVersion: 1 });
    await call(`${URL_BASE}/access`, {
      method: 'PUT',
      body: JSON.stringify({
        botProtection: { provider: 'NONE', bypassMode: 'NOT_CONFIGURED' },
        extraHeaders: [
          { name: 'X-Environment', value: 'staging' },
          { name: 'X-Tenant', secretName: 'TENANT' },
        ],
      }),
    });
    const entry = h.audits.at(-1);
    expect(entry?.metadata?.extraHeaderNames).toEqual(['X-Environment', 'X-Tenant']);
    expect(JSON.stringify(entry)).not.toContain('t0ps3cret');
  });
});

// ─── Which auth profile kinds this install can honour ────────────────────────

describe('the auth profile kinds', () => {
  it('reports PASSKEY as UNAVAILABLE and names the capability that is missing', async () => {
    const res = await call('/auth-profile-kinds');
    const passkey = res.body.kinds.find((entry: Row) => entry.kind === 'PASSKEY');

    // A kind the UI offers and the login module cannot perform is the same
    // defect as eight GateRule kinds that shipped unsaveable.
    expect(passkey.unavailable).not.toBeNull();
    expect(passkey.unavailable.missing).toContain('CDP_WEBAUTHN');
    expect(passkey.unavailable.remedy).toMatch(/Chromium/i);
    expect(passkey.requires).toEqual(['BROWSER', 'CDP_WEBAUTHN']);
  });

  it('reports every kind that needs nothing as available', async () => {
    const res = await call('/auth-profile-kinds');
    for (const kind of ['FORM_LOGIN', 'COOKIE_INJECTION', 'SSO_BYPASS_TOKEN']) {
      expect(res.body.kinds.find((entry: Row) => entry.kind === kind).unavailable).toBeNull();
    }
    /*
     * Measured against the real `loginCapabilities`, not assumed: BROWSER is
     * reported present because the default surface IS the Playwright adapter,
     * and TOTP_CLOCK because computing a code needs nothing but a clock. The
     * four that are genuinely absent — MAILBOX_POLL, OTP_SINK, CDP_WEBAUTHN,
     * MOCK_IDP_ISSUER — are the four kinds no adapter exists for today.
     */
    expect(res.body.capabilitiesPresent).toEqual(['NONE', 'BROWSER', 'TOTP_CLOCK']);
    expect(res.body.capabilitiesPresent).not.toContain('CDP_WEBAUTHN');
  });

  it('names every kind, so a ninth cannot be offered without appearing here', async () => {
    const res = await call('/auth-profile-kinds');
    expect(res.body.kinds.map((entry: Row) => entry.kind)).toEqual([
      'FORM_LOGIN',
      'MAGIC_LINK',
      'SSO_BYPASS_TOKEN',
      'COOKIE_INJECTION',
      'TOTP_MFA',
      'PASSKEY',
      'PHONE_OTP',
      'MOCK_IDP',
    ]);
  });

  it('refuses MOCK_IDP on PRODUCTION and nowhere else', async () => {
    const staging = await call('/auth-profile-kinds?environmentId=env_1');
    expect(staging.body.kinds.find((entry: Row) => entry.kind === 'MOCK_IDP').refusedHere).toBeNull();

    h.db = {
      ...h.db,
      environment: { findUnique: async () => ({ ...ENV, kind: 'PRODUCTION' }) },
    };
    const production = await call('/auth-profile-kinds?environmentId=env_1');
    const mock = production.body.kinds.find((entry: Row) => entry.kind === 'MOCK_IDP');
    expect(mock.refusedHere).toMatch(/forging a real identity/);
  });

  it('says out loud that the answer is a FLOOR, not a measurement', async () => {
    const res = await call('/auth-profile-kinds');
    expect(res.body.note).toMatch(/capability FLOOR/);
  });
});
