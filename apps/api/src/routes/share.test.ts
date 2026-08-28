/**
 * Tests for the public run-share link.
 *
 * The feature is a URL that grants read access with no login, so the tests are
 * mostly about what the URL CANNOT do. In order of how expensive the bug would
 * be:
 *
 *   1. THE PUBLIC READER IS UNSCOPED BY CONSTRUCTION, AND MUST STAY THAT WAY.
 *      An anonymous request has no org, so every query the reader issues runs
 *      through `unscoped()`. That is the one thing about this file that cannot
 *      be seen at a call site — the reads look exactly like the scoped ones a
 *      few lines below. So every fake operation records the tenant in scope at
 *      the moment it ran, and the public tests assert that scope was `null` for
 *      every single one. Swap an `unscoped` for a plain call and the endpoint
 *      would still work in production (it would throw, loudly, on the first
 *      request) — but here it fails with a message naming the query.
 *
 *   2. THE TOKEN IS A CREDENTIAL AND IS STORED AS A DIGEST. The row written by
 *      the mint endpoint is checked field by field against `hashToken(raw)`
 *      computed in the TEST from the URL the endpoint returned, and the raw
 *      token is asserted absent from every column. A database dump must not
 *      hand out live links.
 *
 *   3. IT GRANTS EXACTLY ONE RUN. The fixtures seed a second org with its own
 *      run, its own steps and its own artifacts, and every id that addresses
 *      something outside the shared run — the org, the project, the
 *      environment, the base URL, the test ids, the trace and video keys, the
 *      console text, the network query string and response bodies — carries the
 *      marker `LEAK-`. The redaction test asserts that marker appears nowhere
 *      in the serialised response. A field added to Run next year that is
 *      passed through by accident does not fail this test unless somebody seeds
 *      it — which is why the same test ALSO asserts the specific absences by
 *      name, and why the screenshot endpoint is probed with a step id from the
 *      other org's run.
 *
 *      The fake deliberately IGNORES `select` on the run read and returns the
 *      whole fixture row. That is not laziness: it means these assertions prove
 *      the redaction in `buildReport`, which is the real defence, rather than
 *      proving that Prisma honours a `select` — which it does, and which is the
 *      second line, not the first.
 *
 *   4. REVOCATION AND EXPIRY ACTUALLY CLOSE THE DOOR — including for the
 *      screenshots, which are the one part of the report that is a separate
 *      request and could easily be left open.
 *
 *   5. ORG ISOLATION on the authenticated half: minting a link for another
 *      org's run must 404 and must write no row.
 *
 * Harness: same shape as runs.test.ts — mocked prisma module with a real
 * AsyncLocalStorage tenant scope, the real router driven over a loopback
 * socket, and the real `hashToken` underneath.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Op {
  op: string;
  /** The tenant in scope when the query ran. `null` means unscoped. */
  org: string | null;
}

interface Hoisted {
  db: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  ops: Op[];
  /** Keys handed to storage.get, so a redirect-instead-of-proxy would show up. */
  fetched: string[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    db: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_LEAK-ORG', role: 'MEMBER', ip: null },
    audits: [],
    ops: [],
    fetched: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
    // hashToken() is an HMAC keyed on this; a fixed value keeps the digests
    // stable so the test can recompute one and compare.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    DATABASE_URL: 'postgres://localhost/none',
    ARTIFACTS_LOCAL: true,
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
 * be restored before they ran and every scope assertion below would pass for a
 * reason that has nothing to do with the code under test.
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

vi.mock('../lib/audit.js', () => ({
  audit: async (entry: Row) => {
    h.audits.push(entry);
  },
}));

/** Records the key so "proxied the bytes" is provable, not assumed. */
vi.mock('../lib/storage.js', () => ({
  storage: {
    get: async (key: string) => {
      h.fetched.push(key);
      return Buffer.from('PNGBYTES');
    },
    signedUrl: async () => {
      throw new Error('the public screenshot endpoint must not hand out a bucket URL');
    },
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

interface Store {
  runs: Row[];
  runShares: Row[];
  steps: Row[];
  artifacts: Row[];
}

let store: Store;
let shareSeq = 0;

function record(op: string): void {
  h.ops.push({ op, org: h.currentOrg() });
}

/**
 * The tenant filter, applied the way the extension applies it.
 *
 * `findUnique` cannot take an extra filter, so the extension checks ownership
 * on the RESULT and returns null for another org's row. That behaviour is what
 * stands between a leaked run id and another customer's failure report, so it
 * is modelled rather than assumed.
 */
function ownedByCaller(row: Row | undefined): Row | null {
  const orgId = h.currentOrg();
  if (!row) return null;
  return orgId && row.orgId !== orgId ? null : row;
}

/**
 * `select`, applied the way Prisma applies it — for RunShare only.
 *
 * It matters on exactly one model: the share row holds `tokenHash`, and the
 * route's defence against returning it is a `select` that does not ask for it.
 * A fake that ignored `select` here would pass a test asserting the digest is
 * absent while the real client returned it.
 *
 * The run read deliberately does NOT do this; see the note at the top.
 */
function project(row: Row | null, select?: Row): Row | null {
  if (!row || !select) return row;
  const out: Row = {};
  for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
  return out;
}

function scoped(rows: Row[]): Row[] {
  const orgId = h.currentOrg();
  return orgId ? rows.filter((r) => r.orgId === orgId) : rows;
}

function makeDb(): Record<string, unknown> {
  return {
    run: {
      // `select` is ignored on purpose — see the note at the top of the file.
      findUnique: async ({ where }: Row) => {
        record('run.findUnique');
        return ownedByCaller(store.runs.find((r) => r.id === where.id));
      },
    },

    runShare: {
      findUnique: async ({ where }: Row) => {
        record('runShare.findUnique');
        return ownedByCaller(store.runShares.find((s) => s.tokenHash === where.tokenHash));
      },
      findFirst: async ({ where = {}, select }: Row = {}) => {
        record('runShare.findFirst');
        const found =
          scoped(store.runShares)
            .filter((s) => s.runId === where.runId)
            .filter((s) => (where.revokedAt === null ? s.revokedAt === null : true))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
        return project(found, select);
      },
      create: async ({ data, select }: Row) => {
        record('runShare.create');
        const orgId = h.currentOrg();
        shareSeq += 1;
        const row: Row = {
          id: `share_${shareSeq}`,
          revokedAt: null,
          viewCount: 0,
          lastViewedAt: null,
          createdAt: new Date(),
          ...data,
          ...(orgId ? { orgId } : {}),
        };
        store.runShares.push(row);
        return project(row, select);
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        record('runShare.updateMany');
        const found = scoped(store.runShares)
          .filter((s) => s.runId === where.runId)
          .filter((s) => (where.revokedAt === null ? s.revokedAt === null : true));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
      update: async ({ where, data }: Row) => {
        record('runShare.update');
        const row = store.runShares.find((s) => s.id === where.id);
        if (!row) throw new Error('no such share');
        if (typeof data.viewCount?.increment === 'number') {
          row.viewCount += data.viewCount.increment;
        }
        if (data.lastViewedAt) row.lastViewedAt = data.lastViewedAt;
        return row;
      },
    },

    step: {
      findUnique: async ({ where }: Row) => {
        record('step.findUnique');
        const step = store.steps.find((s) => s.id === where.id);
        if (!step) return null;
        return {
          screenshotKey: step.screenshotKey,
          testResult: { runId: step.runId },
          orgId: step.orgId,
        };
      },
    },

    artifact: {
      findUnique: async ({ where }: Row) => {
        record('artifact.findUnique');
        return store.artifacts.find((a) => a.key === where.key) ?? null;
      },
    },
  };
}

// ─── Seeds ───────────────────────────────────────────────────────────────────

/*
 * Every value that must never reach a public viewer carries `LEAK-`, so one
 * assertion covers the whole class and a new leak seeded next year is caught
 * without a new test.
 */
const ORG = 'org_LEAK-ORG';
const OTHER_ORG = 'org_LEAK-OTHERORG';
const RUN_ID = 'run_LEAK-RUNID-aa11bb22';
const BASE_URL = 'https://staging-LEAK-HOST.example.test';
const SHOT_KEY = `org/${ORG}/run/${RUN_ID}/step-1.png`;
const TRACE_KEY = `org/${ORG}/run/${RUN_ID}/trace-LEAK-TRACE.zip`;

function seed(): void {
  shareSeq = 0;
  store = {
    runs: [
      {
        id: RUN_ID,
        orgId: ORG,
        projectId: 'proj_LEAK-PROJECT',
        suiteId: 'suite_LEAK-SUITE',
        environmentId: 'env_LEAK-ENVIRONMENT',
        runnerPool: null,
        baseUrlOverride: 'https://preview-LEAK-PREVIEW.example.test',
        status: 'FAILED',
        trigger: 'CI',
        queuedAt: new Date('2026-08-01T10:00:00Z'),
        startedAt: new Date('2026-08-01T10:00:05Z'),
        finishedAt: new Date('2026-08-01T10:02:05Z'),
        totalCount: 2,
        passedCount: 1,
        failedCount: 1,
        flakyCount: 0,
        skippedCount: 0,
        errorMessage: null,
        stopReason: null,
        branch: 'feat/checkout',
        commitSha: '0123456789abcdef0123',
        prNumber: 42,
        environment: { name: 'staging', kind: 'STAGING', baseUrl: BASE_URL },
        results: [
          {
            id: 'res_LEAK-RESULTID',
            status: 'FAILED',
            durationMs: 4200,
            errorMessage: 'expected the order confirmation to be visible',
            retriedAndPassed: false,
            videoKey: `org/${ORG}/run/${RUN_ID}/video-LEAK-VIDEO.webm`,
            traceKey: TRACE_KEY,
            network: [
              {
                method: 'post',
                url: `${BASE_URL}/api/orders/8461/items?token=LEAK-QUERYSECRET`,
                status: 500,
                durationMs: 812,
                responseBodySnippet: '{"detail":"LEAK-RESPONSEBODY"}',
              },
              {
                method: 'GET',
                url: 'https://api.stripe.com/v1/charges/ch_LEAK-9999999',
                status: 402,
                durationMs: 190,
                responseBodySnippet: null,
              },
            ],
            consoleLog: [
              { level: 'error', text: 'Authorization: Bearer LEAK-CONSOLEJWT', at: '2026-08-01' },
              { level: 'warn', text: 'LEAK-CONSOLESECOND', at: '2026-08-01' },
            ],
            test: {
              id: 'test_LEAK-TESTID',
              name: 'checkout completes with a saved card',
              type: 'E2E',
              priority: 'P1',
              filePath: 'tests/checkout.spec.ts',
            },
            steps: [
              {
                id: 'step_1',
                index: 0,
                title: 'open the cart',
                status: 'PASSED',
                durationMs: 900,
                errorMessage: null,
                errorStack: null,
                selector: null,
                expected: null,
                actual: null,
                screenshotKey: SHOT_KEY,
              },
              {
                id: 'step_2',
                index: 1,
                title: 'confirm the order',
                status: 'FAILED',
                durationMs: 3300,
                errorMessage: 'locator resolved to 0 elements',
                errorStack: 'at confirm (tests/checkout.spec.ts:44:7)',
                selector: '[data-test=order-confirmation]',
                expected: 'visible',
                actual: 'not found',
                // Points at the TRACE, not an image. The endpoint must refuse
                // it on content type even though the step legitimately names it.
                screenshotKey: TRACE_KEY,
              },
            ],
            findings: [
              {
                id: 'find_1',
                kind: 'ACCESSIBILITY',
                severity: 'SERIOUS',
                code: 'color-contrast',
                message: 'insufficient contrast on the confirm button',
                location: '#confirm',
                helpUrl: 'https://dequeuniversity.com/rules/axe/color-contrast',
              },
            ],
          },
        ],
      },
      {
        id: 'run_LEAK-OTHERRUN',
        orgId: OTHER_ORG,
        environment: { name: 'prod', kind: 'PRODUCTION', baseUrl: 'https://other.example.test' },
        status: 'PASSED',
        trigger: 'MANUAL',
        queuedAt: new Date('2026-08-01T09:00:00Z'),
        startedAt: null,
        finishedAt: null,
        totalCount: 0,
        passedCount: 0,
        failedCount: 0,
        flakyCount: 0,
        skippedCount: 0,
        errorMessage: null,
        stopReason: null,
        branch: null,
        commitSha: null,
        prNumber: null,
        results: [],
      },
    ],
    runShares: [],
    steps: [
      { id: 'step_1', orgId: ORG, runId: RUN_ID, screenshotKey: SHOT_KEY },
      { id: 'step_2', orgId: ORG, runId: RUN_ID, screenshotKey: TRACE_KEY },
      {
        id: 'step_other',
        orgId: OTHER_ORG,
        runId: 'run_LEAK-OTHERRUN',
        screenshotKey: 'org/org_LEAK-OTHERORG/run/run_LEAK-OTHERRUN/step-1.png',
      },
    ],
    artifacts: [
      { key: SHOT_KEY, orgId: ORG, runId: RUN_ID, contentType: 'image/png' },
      { key: TRACE_KEY, orgId: ORG, runId: RUN_ID, contentType: 'application/zip' },
      {
        key: 'org/org_LEAK-OTHERORG/run/run_LEAK-OTHERRUN/step-1.png',
        orgId: OTHER_ORG,
        runId: 'run_LEAK-OTHERRUN',
        contentType: 'image/png',
      },
    ],
  };
  h.db = makeDb();
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { shareRouter } = await import('./share.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const { hashToken } = await import('../lib/crypto.js');

const app = express();
app.use(express.json());
app.use('/', shareRouter);
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

interface Reply {
  status: number;
  body: Row;
  text: string;
  headers: Headers;
}

async function call(path: string, init: RequestInit = {}): Promise<Reply> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: Row = {};
  try {
    body = JSON.parse(text) as Row;
  } catch {
    /* an image, or an empty body */
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** Mint a link and hand back the raw token from the one-time URL. */
async function mint(body: Row = {}): Promise<{ reply: Reply; token: string }> {
  const reply = await call(`/runs/${RUN_ID}/share`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const url = String(reply.body.url ?? '');
  return { reply, token: url.slice(url.lastIndexOf('/') + 1) };
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', ip: null };
  h.audits.length = 0;
  h.ops.length = 0;
  h.fetched.length = 0;
  seed();
});

// ─── Minting ─────────────────────────────────────────────────────────────────

describe('minting a link', () => {
  it('stores only the digest, and shows the token exactly once', async () => {
    const { reply, token } = await mint();

    expect(reply.status).toBe(201);
    expect(reply.body.url).toBe(`https://app.qaai.test/share/${token}`);
    // 32 bytes of base64url. A short token would be a guessable public URL.
    expect(token.length).toBeGreaterThanOrEqual(40);

    const row = store.runShares[0]!;
    // Recomputed in the test from the URL the endpoint returned, so the two
    // sides of this assertion do not both come from the code under test.
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenPrefix).toBe(`sh_${token.slice(0, 8)}`);

    // The raw token must not be recoverable from any column.
    expect(JSON.stringify(row)).not.toContain(token);
    // …and the state payload must not carry it either, because that is the
    // response the run page re-reads on every open.
    expect(JSON.stringify(reply.body.share)).not.toContain(token);
    expect(reply.body.share.tokenHash).toBeUndefined();
  });

  it('defaults to a thirty-day expiry and accepts an explicit forever', async () => {
    await mint();
    const defaulted = store.runShares[0]!.expiresAt as Date;
    const days = (defaulted.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    seed();
    // Explicit null is a different input from an absent field, and only one of
    // them should produce a link with no deadline.
    await mint({ expiresInDays: null });
    expect(store.runShares[0]!.expiresAt).toBeNull();
  });

  it('refuses an expiry past the ceiling', async () => {
    const { reply } = await mint({ expiresInDays: 400 });
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('VALIDATION_FAILED');
    expect(store.runShares).toEqual([]);
  });

  it('replaces the live link rather than refusing, and the old token dies', async () => {
    const first = await mint();
    const second = await mint();

    expect(second.reply.body.replacedLinks).toBe(1);
    expect(store.runShares).toHaveLength(2);
    expect(store.runShares[0]!.revokedAt).toBeInstanceOf(Date);

    // The whole point of replacing: the URL somebody already sent stops working.
    expect((await call(`/share/${first.token}`)).status).toBe(410);
    expect((await call(`/share/${second.token}`)).status).toBe(200);
  });

  it('audits the mint with the prefix and never the token', async () => {
    const { token } = await mint();

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'run.share.create',
      targetType: 'Run',
      targetId: RUN_ID,
    });
    expect(JSON.stringify(h.audits[0])).not.toContain(token);
    expect(h.audits[0]!.metadata.tokenPrefix).toBe(`sh_${token.slice(0, 8)}`);
  });

  it('requires MEMBER — a VIEWER cannot publish the org’s failures', async () => {
    h.actor = { ...h.actor, role: 'VIEWER' };
    const { reply } = await mint();

    expect(reply.status).toBe(403);
    expect(store.runShares).toEqual([]);
  });
});

// ─── Org isolation on the authenticated half ─────────────────────────────────

describe('org isolation', () => {
  it('will not mint a link for another org’s run, and writes nothing', async () => {
    const reply = await call('/runs/run_LEAK-OTHERRUN/share', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    // 404, not 403: the two must be indistinguishable or the endpoint is an
    // existence oracle for other people's runs.
    expect(reply.status).toBe(404);
    expect(reply.body.error.code).toBe('NOT_FOUND');
    expect(store.runShares).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('reports no link for another org’s run even when that run has one', async () => {
    // A live link, owned by the other org, on the other org's run.
    store.runShares.push({
      id: 'share_other',
      orgId: OTHER_ORG,
      runId: 'run_LEAK-OTHERRUN',
      tokenHash: hashToken('whatever'),
      tokenPrefix: 'sh_other',
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
      createdBy: null,
      viewCount: 0,
      lastViewedAt: null,
    });

    const reply = await call('/runs/run_LEAK-OTHERRUN/share');
    expect(reply.status).toBe(404);
  });
});

// ─── Reading the state ───────────────────────────────────────────────────────

describe('the state of a link', () => {
  it('reports the live link with its counters, and never its token', async () => {
    const { token } = await mint();
    await call(`/share/${token}`);
    await call(`/share/${token}`);

    const reply = await call(`/runs/${RUN_ID}/share`);
    expect(reply.status).toBe(200);
    expect(reply.body.share).toMatchObject({ tokenPrefix: `sh_${token.slice(0, 8)}`, viewCount: 2 });
    expect(reply.body.share.lastViewedAt).not.toBeNull();
    expect(reply.text).not.toContain(token);
  });

  it('reports no link once it has expired, so the run page cannot claim it is live', async () => {
    await mint();
    store.runShares[0]!.expiresAt = new Date(Date.now() - 1000);

    const reply = await call(`/runs/${RUN_ID}/share`);
    expect(reply.body.share).toBeNull();
  });
});

// ─── Revocation and expiry ───────────────────────────────────────────────────

describe('revocation', () => {
  it('turns the link off, is idempotent, and is audited both times', async () => {
    const { token } = await mint();
    expect((await call(`/share/${token}`)).status).toBe(200);

    const first = await call(`/runs/${RUN_ID}/share`, { method: 'DELETE' });
    expect(first.body.revokedLinks).toBe(1);

    const second = await call(`/runs/${RUN_ID}/share`, { method: 'DELETE' });
    expect(second.status).toBe(200);
    expect(second.body.revokedLinks).toBe(0);

    const revocations = h.audits.filter((a) => a.action === 'run.share.revoke');
    expect(revocations).toHaveLength(2);

    const after = await call(`/share/${token}`);
    expect(after.status).toBe(410);
    expect(after.body.error.code).toBe('LINK_REVOKED');
  });

  it('closes the screenshots too, not just the report', async () => {
    const { token } = await mint();
    expect((await call(`/share/${token}/screenshot/step_1`)).status).toBe(200);

    await call(`/runs/${RUN_ID}/share`, { method: 'DELETE' });

    const shot = await call(`/share/${token}/screenshot/step_1`);
    expect(shot.status).toBe(410);
    // Nothing was read from the bucket after the link was turned off.
    expect(h.fetched).toEqual([SHOT_KEY]);
  });

  it('an expired link reads as expired, not as missing', async () => {
    const { token } = await mint();
    store.runShares[0]!.expiresAt = new Date(Date.now() - 1000);

    const reply = await call(`/share/${token}`);
    expect(reply.status).toBe(410);
    expect(reply.body.error.code).toBe('LINK_EXPIRED');
  });

  it('an unknown token is a plain 404', async () => {
    const reply = await call(`/share/${'z'.repeat(43)}`);
    expect(reply.status).toBe(404);
  });
});

// ─── The public reader ───────────────────────────────────────────────────────

describe('the public report', () => {
  it('renders the failure with no session and no tenant scope anywhere', async () => {
    const { token } = await mint();
    h.ops.length = 0;

    const reply = await call(`/share/${token}`);
    expect(reply.status).toBe(200);

    /*
     * The assertion this whole file is built around. An anonymous request has
     * no org, so every read the public path issues must be unscoped — and that
     * is invisible at the call site, because a scoped read looks identical.
     */
    expect(h.ops.length).toBeGreaterThan(0);
    expect(h.ops.filter((o) => o.org !== null)).toEqual([]);

    const report = reply.body.report;
    expect(report).toMatchObject({
      reference: 'aa11bb22',
      status: 'FAILED',
      branch: 'feat/checkout',
      prNumber: 42,
      environment: { name: 'staging', kind: 'STAGING' },
      totals: { total: 2, passed: 1, failed: 1, flaky: 0, skipped: 0 },
    });
    // Shortened: the full sha is not needed to find a commit and the short one
    // is what a person pastes.
    expect(report.commitSha).toBe('0123456789ab');

    const result = report.results[0];
    expect(result.name).toBe('checkout completes with a saved card');
    expect(result.errorMessage).toContain('order confirmation');
    expect(result.steps[1]).toMatchObject({
      title: 'confirm the order',
      status: 'FAILED',
      selector: '[data-test=order-confirmation]',
      expected: 'visible',
      actual: 'not found',
    });
    expect(result.findings[0].code).toBe('color-contrast');
  });

  it('leaks no id, host, key or free text from outside the run', async () => {
    const { token } = await mint();
    const reply = await call(`/share/${token}`);

    /*
     * Every fixture value that must never be published carries this marker,
     * including two — the base URL and the trace key — that the route reads on
     * purpose and has to drop on the way out.
     */
    expect(reply.text).not.toMatch(/LEAK-/);

    // Named as well as swept, because the sweep only catches what was seeded.
    const report = reply.body.report;
    expect(report.results[0].traceKey).toBeUndefined();
    expect(report.results[0].videoKey).toBeUndefined();
    expect(report.results[0].test).toBeUndefined();
    expect(report.results[0].consoleLog).toBeUndefined();
    expect(report.environment.baseUrl).toBeUndefined();
    expect(report.projectId).toBeUndefined();
    expect(report.orgId).toBeUndefined();
    expect(report.environmentId).toBeUndefined();
    // The reference is the tail of the run id and the id itself is not here.
    expect(report.id).toBeUndefined();
  });

  it('summarises the network log and says so, without a body, host or query', async () => {
    const { token } = await mint();
    const { network, networkTotal, consoleTotal } = (await call(`/share/${token}`)).body.report
      .results[0];

    expect(networkTotal).toBe(2);
    expect(network).toEqual([
      // The order id is replaced, the query string is gone, and the host — which
      // on a preview deploy is itself the access control — never appears.
      { method: 'POST', path: '/api/orders/:id/items', status: 500, durationMs: 812, thirdParty: false },
      { method: 'GET', path: '/v1/charges/:id', status: 402, durationMs: 190, thirdParty: true },
    ]);

    // Counted, published nowhere. The count is what makes the omission honest.
    expect(consoleTotal).toBe(2);
  });

  it('tells the reader what was withheld and how much of it there is', async () => {
    const { token } = await mint();
    const withheld = (await call(`/share/${token}`)).body.report.withheld as Array<{
      what: string;
      detail: string;
    }>;

    const summary = withheld.map((w) => w.what).join(' | ');
    expect(summary).toContain('2 network requests, summarised');
    expect(summary).toContain('2 console lines, withheld');
    // One trace and one video on the single result.
    expect(summary).toContain('2 recordings, withheld');
    expect(summary).toContain('The workspace around this run');
  });

  it('counts a view and stamps when, because that is the only record of a public read', async () => {
    const { token } = await mint();
    expect(store.runShares[0]!.viewCount).toBe(0);

    await call(`/share/${token}`);
    await call(`/share/${token}`);

    // The counter update is fire-and-forget, so give the microtask a turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.runShares[0]!.viewCount).toBe(2);
    expect(store.runShares[0]!.lastViewedAt).toBeInstanceOf(Date);
  });

  it('never asks a search engine to keep it', async () => {
    const { token } = await mint();
    const reply = await call(`/share/${token}`);
    expect(reply.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('behaves identically for a signed-in visitor — the session is not consulted', async () => {
    const { token } = await mint();
    const anonymous = await call(`/share/${token}`);

    // A cookie, and an actor from a completely different org. Neither may make
    // any difference: a reader that quietly widened for a signed-in visitor is
    // one nobody could test, because the person testing it is signed in.
    h.actor = { userId: 'user_9', orgId: OTHER_ORG, role: 'OWNER', ip: null };
    const withSession = await call(`/share/${token}`, {
      headers: { cookie: 'qaai_session=whatever' },
    });

    expect(withSession.status).toBe(anonymous.status);
    expect(withSession.body.report).toEqual(anonymous.body.report);

    // And it cannot rescue a link that was turned off.
    h.actor = { userId: 'user_1', orgId: ORG, role: 'OWNER', ip: null };
    await call(`/runs/${RUN_ID}/share`, { method: 'DELETE' });
    expect((await call(`/share/${token}`)).status).toBe(410);
  });
});

// ─── Screenshots ─────────────────────────────────────────────────────────────

describe('the public screenshot endpoint', () => {
  it('proxies the bytes rather than handing out a bucket URL', async () => {
    const { token } = await mint();
    const reply = await call(`/share/${token}/screenshot/step_1`);

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('image/png');
    expect(reply.text).toBe('PNGBYTES');
    expect(h.fetched).toEqual([SHOT_KEY]);
    // The key embeds the org id and the run id; a redirect would publish both.
    expect(reply.headers.get('location')).toBeNull();
    expect(reply.text).not.toMatch(/LEAK-/);
  });

  it('refuses a step from another run, even a real one', async () => {
    const { token } = await mint();
    const reply = await call(`/share/${token}/screenshot/step_other`);

    expect(reply.status).toBe(404);
    expect(h.fetched).toEqual([]);
  });

  it('refuses anything that is not an image, so it cannot become a trace reader', async () => {
    const { token } = await mint();
    // step_2's screenshotKey names the trace zip. The step is in the right run
    // and the artifact row exists — only the content type stops it.
    const reply = await call(`/share/${token}/screenshot/step_2`);

    expect(reply.status).toBe(404);
    expect(h.fetched).toEqual([]);
  });

  it('refuses an unknown step without touching storage', async () => {
    const { token } = await mint();
    expect((await call(`/share/${token}/screenshot/step_nope`)).status).toBe(404);
    expect(h.fetched).toEqual([]);
  });
});
