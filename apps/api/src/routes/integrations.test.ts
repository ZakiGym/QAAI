/**
 * Tests for the chat/webhook half of the integrations surface (§7).
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. The webhook URL is a credential and behaves like one: sealed into the
 *      vault with the row's own id in the AAD, never present in any response,
 *      any config row, or any audit row — not on create, not on list, not on a
 *      validation error. The assertions grep whole response bodies for the
 *      token, because "we return hasUrl instead" is exactly the kind of claim
 *      that rots one field at a time.
 *   2. The test-send endpoint is honest both ways: a landed POST and a refused
 *      or failed one BOTH leave a WebhookDelivery row saying what happened,
 *      and the send-time host re-check runs on the unsealed URL — a ciphertext
 *      that reached the database around the API still cannot aim a payload at
 *      an attacker's host.
 *   3. The deliveries endpoint actually answers "did my Slack message go out":
 *      newest first, capped, scoped to the org, and free of the payload and
 *      signature columns.
 *
 * Harness: same shape as accounts.test.ts — mocked prisma module with a real
 * AsyncLocalStorage tenant scope, real routers driven over a loopback socket.
 * The VAULT IS REAL: sealing and opening run the actual AES-GCM code against a
 * test master key, because "the URL round-trips through the vault" is the
 * feature, and a stubbed vault would pass with the sealing accidentally
 * deleted.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressPermit } from '@qaai/shared';

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
  env: {
    // hashToken() is an HMAC keyed on this; without it every token
    // digest throws. A fixed value keeps the digests stable across runs.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    // 32 bytes, so the real vault code seals and opens for real.
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
 * requireRole stand-in ranks with the same ROLE_RANK table the middleware
 * uses, so the VIEWER test exercises the same comparison.
 */
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
          res
            .status(403)
            .json({ error: { code: 'FORBIDDEN', message: `Requires ${minimum}` } });
          return;
        }
        next();
      },
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// Recorded, not stubbed silent: the tests assert the URL never lands in one.
vi.mock('../lib/audit.js', () => ({
  audit: async (input: unknown) => {
    h.audits.push(input as Row);
  },
}));

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = ['integration', 'webhookDelivery'] as const;
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

function sortRows(list: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return list;
  const [key, direction] = Object.entries(orderBy)[0]!;
  return [...list].sort((a, b) => {
    const cmp = (a[key] as Date).getTime() - (b[key] as Date).getTime();
    return direction === 'desc' ? -cmp : cmp;
  });
}

const DEFAULTS: Record<ModelName, Row> = {
  integration: { projectId: null, config: {}, configEnc: null, enabled: true },
  webhookDelivery: {
    signature: '',
    status: 'PENDING',
    responseStatus: null,
    attempts: 0,
    deliveredAt: null,
    lastError: null,
  },
};

/** Ordering is asserted (`orderBy: createdAt desc`), so the clock must not tie. */
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
const { integrationsRouter } = await import('./integrations.js');
const { CHAT_RESPONSE_MAX_BYTES, configureChatEgress, configureChatTransport } = await import(
  '../lib/chat-integrations.js'
);
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const { openChatCredentials, sealChatCredentials } = await import('../lib/integrations.js');

const app = express();
app.use(express.json());
app.use('/integrations', integrationsRouter);
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

/*
 * The tests stub the GLOBAL fetch to intercept what the route sends outward,
 * and this helper is how the tests talk to the route — so it must hold the
 * real fetch from before any stubbing, or the harness intercepts itself.
 */
const realFetch = globalThis.fetch.bind(globalThis);

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Row; text: string }> {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {}, text };
}

let db: ReturnType<typeof makeDb>;

/**
 * A PINNED permit for the host in `url`, which is what the real guard returns
 * and what this harness used to throw away.
 *
 * The stub used to answer `{ ok: true, permit: null }`, and that mattered more
 * than it looks: `permit: null` means "no guard decided about this host", so
 * every WEBHOOK test-send in this file took the BY-NAME branch and the pinned
 * transport was never exercised by the route at all. A harness that cannot
 * reach the control is a harness that passes whether the control is wired or
 * not — which is how this defect survived four rounds of green suites.
 */
function pinnedPermitFor(url: string): EgressPermit {
  const host = new URL(url).hostname;
  return {
    kind: 'PINNED',
    context: 'WEBHOOK_DELIVERY',
    target: { host, scheme: 'https:', port: '' },
    decision: { allowed: true },
    pinned: { host, addresses: [{ address: '93.184.216.34', class: 'public' }] },
    wouldRefuse: null,
  } as unknown as EgressPermit;
}

/**
 * The pinned transport, captured. A test that means to send through it installs
 * one of these; the default below THROWS, so a route that opens a pinned socket
 * in a test that did not expect one fails loudly instead of trying to reach
 * 93.184.216.34 for real.
 */
interface PinnedCall {
  host: string;
  url: string;
  init: { method: string; headers?: Record<string, string>; body?: string; maxBytes: number };
}
function capturePinned(status = 200): PinnedCall[] {
  const calls: PinnedCall[] = [];
  configureChatTransport(async (permit, url, init) => {
    calls.push({
      host: permit.kind === 'PINNED' ? permit.pinned.host : '',
      url,
      init: {
        method: init.method,
        ...(init.headers ? { headers: { ...init.headers } } : {}),
        ...(init.body === undefined ? {} : { body: init.body }),
        maxBytes: init.maxBytes,
      },
    });
    return { ok: true, response: { status, headers: {}, text: 'ok', truncated: false } };
  });
  return calls;
}

beforeEach(() => {
  configureChatEgress(() =>
    Promise.resolve((url: string) =>
      Promise.resolve({ ok: true, permit: pinnedPermitFor(url) } as never),
    ),
  );
  configureChatTransport(() => {
    throw new Error('this test opened a pinned socket without stubbing the transport');
  });
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
});

afterEach(() => {
  // The REAL transport, restored, so one test cannot leak its fake into the
  // next — the same reason `configureChatEgress(null)` exists.
  configureChatTransport(null);
  vi.unstubAllGlobals();
});

/** The webhook path segment the whole file greps responses for. */
const TOKEN = 'tok3nTOK3Ntok3n';
const SLACK_URL = `https://hooks.slack.com/services/T0001/B0001/${TOKEN}`;

describe('POST /integrations/chat', () => {
  it('creates a Slack destination with the URL sealed, and never echoes it', async () => {
    const { status, body, text } = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Engineering',
      url: SLACK_URL,
    });

    expect(status).toBe(201);
    expect(body.integration).toMatchObject({
      kind: 'SLACK',
      name: 'Engineering',
      host: 'hooks.slack.com',
      enabled: true,
      hasUrl: true,
      hasSecret: false,
      notify: { runFinished: 'failures', digest: true },
    });
    // The whole response, not a field: hasUrl instead of url is the claim.
    expect(text).not.toContain(TOKEN);

    const row = db.tables.integration[0]!;
    expect(row.configEnc).toBeTruthy();
    expect(JSON.stringify(row.config)).not.toContain(TOKEN);
    // The real vault round-trips it, AAD bound to this row's own id…
    expect(openChatCredentials(row.configEnc, 1, 'org_1', row.id)).toEqual({ url: SLACK_URL });
    // …so the same ciphertext under any other row id fails closed.
    expect(() => openChatCredentials(row.configEnc, 1, 'org_1', 'integration_other')).toThrow();

    // The audit trail records the host and never the credential.
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits)).not.toContain(TOKEN);
    expect(h.audits[0]!.metadata.host).toBe('hooks.slack.com');
  });

  it('refuses a wrong host, http, a secret on a pinned kind, and PAGERDUTY — without echoing the URL', async () => {
    const wrongHost = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'X',
      url: `https://evil.example.com/services/T/B/${TOKEN}`,
    });
    expect(wrongHost.status).toBe(400);
    expect(wrongHost.body.error.message).toContain('evil.example.com');
    expect(wrongHost.text).not.toContain(TOKEN);

    const http = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'X',
      url: `http://hooks.slack.com/services/T/B/${TOKEN}`,
    });
    expect(http.status).toBe(400);
    expect(http.text).not.toContain(TOKEN);

    const secretOnSlack = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'X',
      url: SLACK_URL,
      secret: 'not-for-slack',
    });
    expect(secretOnSlack.status).toBe(400);
    expect(secretOnSlack.body.error.message).toContain('WEBHOOK');

    // In the Prisma enum, deliberately not creatable: nothing can deliver to it.
    const pagerduty = await call('POST', '/integrations/chat', {
      kind: 'PAGERDUTY',
      name: 'On-call',
      url: 'https://events.pagerduty.com/v2/enqueue',
    });
    expect(pagerduty.status).toBe(400);

    expect(db.tables.integration).toHaveLength(0);
  });

  it('refuses a duplicate kind+name with a 409', async () => {
    await call('POST', '/integrations/chat', { kind: 'SLACK', name: 'Eng', url: SLACK_URL });
    const dup = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    expect(dup.status).toBe(409);
  });

  it('is closed to MEMBERs — writes need ADMIN', async () => {
    h.actor.role = 'MEMBER';
    const { status } = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    expect(status).toBe(403);
    expect(db.tables.integration).toHaveLength(0);
  });
});

describe('GET /integrations/chat and /', () => {
  it('keeps the two families apart, and the credential out of both', async () => {
    await call('POST', '/integrations/chat', { kind: 'SLACK', name: 'Eng', url: SLACK_URL });
    // A git row created directly — the git POST needs its own schema fields.
    db.tables.integration.push({
      id: 'integration_git',
      orgId: 'org_1',
      kind: 'GITHUB',
      name: 'Repo',
      config: { repo: 'acme/web', defaultBranch: 'qaai/tests' },
      configEnc: 'sealed',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const chat = await call('GET', '/integrations/chat');
    expect(chat.body.integrations).toHaveLength(1);
    expect(chat.body.integrations[0].kind).toBe('SLACK');
    expect(chat.text).not.toContain(TOKEN);

    const git = await call('GET', '/integrations');
    expect(git.body.integrations).toHaveLength(1);
    expect(git.body.integrations[0].kind).toBe('GITHUB');
  });
});

describe('PATCH /integrations/chat/:id', () => {
  it('merges the notify preference without touching the sealed URL', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;
    const sealedBefore = db.tables.integration[0]!.configEnc;

    const { status, body } = await call('PATCH', `/integrations/chat/${id}`, {
      notify: { runFinished: 'all' },
    });
    expect(status).toBe(200);
    // digest untouched by a patch that named only runFinished.
    expect(body.integration.notify).toEqual({ runFinished: 'all', digest: true });
    expect(db.tables.integration[0]!.configEnc).toBe(sealedBefore);
  });

  it('rotating a WEBHOOK URL carries the signing secret; rotating the secret keeps the URL', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'WEBHOOK',
      name: 'CI hook',
      url: 'https://hooks.example.com/qaai',
      secret: 'first-secret',
    });
    const id = created.body.integration.id as string;
    expect(created.body.integration.hasSecret).toBe(true);

    const moved = await call('PATCH', `/integrations/chat/${id}`, {
      url: 'https://hooks.example.com/qaai-v2',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.integration.hasSecret).toBe(true);
    expect(openChatCredentials(db.tables.integration[0]!.configEnc, 1, 'org_1', id)).toEqual({
      url: 'https://hooks.example.com/qaai-v2',
      secret: 'first-secret',
    });

    const rotated = await call('PATCH', `/integrations/chat/${id}`, { secret: 'second-secret' });
    expect(rotated.status).toBe(200);
    expect(openChatCredentials(db.tables.integration[0]!.configEnc, 1, 'org_1', id)).toEqual({
      url: 'https://hooks.example.com/qaai-v2',
      secret: 'second-secret',
    });
  });

  it('each PATCH refuses the other family’s rows', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const chatId = created.body.integration.id as string;
    db.tables.integration.push({
      id: 'integration_git',
      orgId: 'org_1',
      kind: 'GITHUB',
      name: 'Repo',
      config: { repo: 'acme/web', defaultBranch: 'qaai/tests' },
      configEnc: 'sealed',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The git PATCH would rewrite a chat row's config in the git shape,
    // destroying the notify preference and the stored host — refused instead.
    const gitOnChat = await call('PATCH', `/integrations/${chatId}`, { name: 'renamed' });
    expect(gitOnChat.status).toBe(400);
    expect(gitOnChat.body.error.message).toContain('/integrations/chat/');

    const chatOnGit = await call('PATCH', '/integrations/chat/integration_git', {
      name: 'renamed',
    });
    expect(chatOnGit.status).toBe(400);
  });
});

/**
 * The URL of a `fetch` call, for a stub that needs to tell the outbound leg
 * from the test's own request to the router.
 *
 * `String(input)` would do it and lints as `no-base-to-string`, which is right
 * to complain: `RequestInfo` includes `Request`, whose default stringification
 * is `[object Request]`, so a stub that matched on it would silently stop
 * matching the day a caller passed one.
 */
function fetchUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('POST /integrations/chat/:id/test — the host is resolved before the token travels', () => {
  /*
   * ── THE DEFECT ────────────────────────────────────────────────────────────
   *
   * This route checked the destination with `checkChatDestination`, a PATTERN
   * MATCH THAT NEVER RESOLVES. MEASURED before the fix:
   * `checkChatDestination('WEBHOOK', 'https://hooks.attacker.test/...')`
   * returned ok with ZERO DNS queries, while `guardChatDestination` on the same
   * input refused with one. The webhook URL IS the credential — a provider
   * token lives in its path — so the POST carries a secret to whatever the name
   * answers, and the body is signed with a vault-unsealed secret besides.
   *
   * `guardChatDestination` was written and tested in the round that left it with
   * NO PRODUCTION CALLER. These tests are what make it reachable.
   */
  async function webhook(): Promise<string> {
    const created = await call('POST', '/integrations/chat', {
      kind: 'WEBHOOK',
      name: 'Ops',
      url: 'https://hooks.example.test/qaai',
    });
    return String((created.body).integration ? (created.body as Row & { integration: Row }).integration.id : (created.body).id);
  }

  it('REFUSES a destination whose host resolves inside, and posts nothing', async () => {
    let posted = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      // Only the outbound leg: `call()` reaches this router over the same global.
      if (fetchUrlOf(input).includes('hooks.example.test')) posted += 1;
      return realFetch(input, init);
    };

    const id = await webhook();
    const asked: string[] = [];
    configureChatEgress(() =>
      Promise.resolve((url: string) => {
        asked.push(url);
        return Promise.resolve({ ok: false } as never);
      }),
    );

    const pinned = capturePinned();

    const reply = await call('POST', `/integrations/chat/${id}/test`, {});
    globalThis.fetch = realFetch;

    // The guard was consulted with the stored destination...
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('hooks.example.test');
    // ...and nothing left the process, by EITHER transport. Counting only
    // `fetch` would have missed a pinned send, and counting only the pinned
    // transport would have missed a by-name one.
    expect(posted).toBe(0);
    expect(pinned).toEqual([]);
    // The refusal says nothing about WHY: this renders in the cockpit to
    // whoever typed the URL, and a message distinguishing a class from an
    // unresolvable name is a port scanner with a readable report.
    const body = JSON.stringify(reply.body);
    expect(body).not.toContain('169.254');
    expect(body).not.toContain('CLASS_NOT_PERMITTED');
  });

  it('still posts when the guard allows, THROUGH THE PINNED TRANSPORT and not by name', async () => {
    /*
     * Without this arm the test above would also pass if the route had simply
     * stopped working. And the thing it has to prove is now sharper than
     * "something was posted": the permit must reach the SOCKET.
     *
     * MEASURED before this round: the route called `fetch(destination.url)`,
     * which resolves the name a SECOND time — so the guard's classified address
     * set decided nothing and a rebound name sent the webhook token, which
     * lives in the path, to whatever the second answer pointed at. `posted`
     * below is the count of by-name sends and it must now be ZERO.
     */
    let posted = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchUrlOf(input).includes('hooks.example.test')) {
        posted += 1;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return realFetch(input, init);
    };

    const id = await webhook();
    const pinned = capturePinned();
    const { body } = await call('POST', `/integrations/chat/${id}/test`, {});
    globalThis.fetch = realFetch;

    expect(body).toMatchObject({ ok: true, responseStatus: 200 });
    // Through the pin, with the permit's own host, and NOT by name.
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.host).toBe('hooks.example.test');
    expect(pinned[0]!.url).toBe('https://hooks.example.test/qaai');
    expect(pinned[0]!.init.method).toBe('POST');
    // The cap is the call site's, not a default inside the transport.
    expect(pinned[0]!.init.maxBytes).toBe(CHAT_RESPONSE_MAX_BYTES);
    expect(posted).toBe(0);

    // COUNTED, not assumed: the audit row says which transport carried it.
    const tested = h.audits.filter((a) => a.action === 'integration.test');
    expect(tested).toHaveLength(1);
    expect(tested[0]!.metadata.transport).toBe('PINNED');
  });

  it('connects BY NAME in OBSERVE mode, and the audit row counts it', async () => {
    /*
     * An OBSERVED permit authorised NO address, so there is nothing to pin to
     * and the connection happens exactly as it did before this control existed
     * — which is what OBSERVE promises. The point of this test is that the
     * fall-back is a BRANCH TAKEN ON PURPOSE and not an exception handler
     * quietly retrying: the pinned transport must never be called, and the
     * audit row must say the pin did not apply. A mode with no counter is an
     * off switch with a reassuring name.
     */
    let posted = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchUrlOf(input).includes('hooks.example.test')) {
        posted += 1;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return realFetch(input, init);
    };

    const id = await webhook();
    const pinned = capturePinned();
    configureChatEgress(() =>
      Promise.resolve(() =>
        Promise.resolve({
          ok: true,
          permit: {
            kind: 'OBSERVED',
            context: 'WEBHOOK_DELIVERY',
            target: { host: 'hooks.example.test', scheme: 'https:', port: '' },
            decision: { outcome: 'WOULD_REFUSE' },
            pinned: null,
            wouldRefuse: 'CLASS_NOT_PERMITTED',
            observedBy: 'POLICY',
          },
        } as never),
      ),
    );

    const { body } = await call('POST', `/integrations/chat/${id}/test`, {});
    globalThis.fetch = realFetch;

    expect(body).toMatchObject({ ok: true, responseStatus: 200 });
    expect(posted).toBe(1);
    expect(pinned).toEqual([]);
    const tested = h.audits.filter((a) => a.action === 'integration.test');
    expect(tested[0]!.metadata.transport).toBe('BY_NAME_OBSERVE_MODE');
  });

  it('records BY_NAME_ALLOWLISTED_HOST for Slack, which holds no permit to pin', async () => {
    // SLACK never reaches the guard — its host comes from a real allowlist no
    // config row can choose from — so there is no pin to enforce and the count
    // must say WHICH by-name case this was. Collapsing the two by-name values
    // would hide the rollout brake being used.
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;
    const pinned = capturePinned();
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));

    await call('POST', `/integrations/chat/${id}/test`);

    expect(pinned).toEqual([]);
    const tested = h.audits.filter((a) => a.action === 'integration.test');
    expect(tested[0]!.metadata.transport).toBe('BY_NAME_ALLOWLISTED_HOST');
  });
});

describe('POST /integrations/chat/:id/test', () => {
  it('posts the hello, reports success, and records a SENT delivery row', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;

    const sent: Array<{ url: string; init: Row }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init: Row) => {
      sent.push({ url: String(url), init });
      return new Response('ok', { status: 200 });
    });

    const { status, body } = await call('POST', `/integrations/chat/${id}/test`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, responseStatus: 200, error: null });

    // The POST went to the unsealed URL with Slack's payload shape.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(SLACK_URL);
    expect(JSON.parse(sent[0]!.init.body as string)).toMatchObject({ text: expect.any(String) });
    // Never follow a redirect while holding a credentialed URL.
    expect(sent[0]!.init.redirect).toBe('manual');

    const delivery = db.tables.webhookDelivery[0]!;
    expect(delivery).toMatchObject({
      integrationId: id,
      event: 'test',
      status: 'SENT',
      responseStatus: 200,
      attempts: 1,
      lastError: null,
    });
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
    expect(body.deliveryId).toBe(delivery.id);
  });

  it('signs a WEBHOOK test with the sealed secret, and the signature travels over the PIN', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'WEBHOOK',
      name: 'CI hook',
      url: 'https://hooks.example.com/qaai',
      secret: 'shh-secret-shh',
    });
    const id = created.body.integration.id as string;

    // The generic kind is the one that gets a permit, so the signed body is
    // handed to the pinned transport and not to `fetch`.
    const pinned = capturePinned();
    await call('POST', `/integrations/chat/${id}/test`);

    expect(pinned).toHaveLength(1);
    const headers = pinned[0]!.init.headers ?? {};
    expect(headers['x-qaai-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The generic-webhook body carries the event so receivers can route.
    expect(JSON.parse(pinned[0]!.init.body as string)).toMatchObject({ event: 'test' });
  });

  it('reports a provider refusal honestly and records the FAILED row', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;

    vi.stubGlobal('fetch', async () => new Response('no_service', { status: 404 }));

    const { status, body } = await call('POST', `/integrations/chat/${id}/test`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, responseStatus: 404, error: 'HTTP 404' });
    expect(db.tables.webhookDelivery[0]).toMatchObject({
      status: 'FAILED',
      responseStatus: 404,
      attempts: 1,
      lastError: 'HTTP 404',
      deliveredAt: null,
    });
  });

  it('never echoes the URL when the network itself fails', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;

    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`fetch failed: ${SLACK_URL}`);
    });

    const { body, text } = await call('POST', `/integrations/chat/${id}/test`);
    expect(body).toMatchObject({ ok: false, error: 'delivery failed' });
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(db.tables.webhookDelivery)).not.toContain(TOKEN);
  });

  it('re-checks the host on the UNSEALED url and refuses before any bytes leave', async () => {
    /*
     * A ciphertext that reached the database around the API: sealed directly,
     * pointing a SLACK integration at an attacker's host. Write-time
     * validation never saw it, so only the send-time re-check stands between
     * this row and a POST full of test-suite details to evil.example.com.
     */
    const sealed = sealChatCredentials(
      { url: `https://evil.example.com/services/T/B/${TOKEN}` },
      'org_1',
      'integration_evil',
    );
    db.tables.integration.push({
      id: 'integration_evil',
      orgId: 'org_1',
      kind: 'SLACK',
      name: 'Poisoned',
      config: { host: 'hooks.slack.com', keyVersion: sealed.keyVersion, hasSecret: false },
      configEnc: sealed.ciphertext,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { status, body } = await call('POST', '/integrations/chat/integration_evil/test');
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('evil.example.com');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Refused-before-send is its own delivery shape: zero attempts, FAILED.
    expect(db.tables.webhookDelivery[0]).toMatchObject({ status: 'FAILED', attempts: 0 });
  });

  it('is not available for git integrations', async () => {
    db.tables.integration.push({
      id: 'integration_git',
      orgId: 'org_1',
      kind: 'GITHUB',
      name: 'Repo',
      config: {},
      configEnc: 'sealed',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { status } = await call('POST', '/integrations/chat/integration_git/test');
    expect(status).toBe(400);
  });
});

describe('GET /integrations/:id/deliveries', () => {
  it('answers newest-first, capped at 50, without payload or signature', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;

    for (let i = 0; i < 55; i++) {
      db.tables.webhookDelivery.push({
        id: `wd_${i}`,
        orgId: 'org_1',
        integrationId: id,
        event: i % 2 ? 'run.finished' : 'digest.daily',
        payload: { text: `secret suite details ${i}` },
        signature: 'sha256=abc',
        status: i % 3 ? 'SENT' : 'FAILED',
        responseStatus: i % 3 ? 200 : 500,
        attempts: 1,
        deliveredAt: i % 3 ? new Date() : null,
        lastError: i % 3 ? null : 'HTTP 500',
        createdAt: new Date(CLOCK_BASE + i * 1000),
      });
    }
    // Another integration's rows must not bleed in.
    db.tables.webhookDelivery.push({
      id: 'wd_other',
      orgId: 'org_1',
      integrationId: 'integration_other',
      event: 'run.finished',
      payload: {},
      signature: '',
      status: 'SENT',
      responseStatus: 200,
      attempts: 1,
      deliveredAt: new Date(),
      lastError: null,
      createdAt: new Date(CLOCK_BASE + 999_000),
    });

    const { status, body, text } = await call('GET', `/integrations/${id}/deliveries`);
    expect(status).toBe(200);
    expect(body.deliveries).toHaveLength(50);
    expect(body.deliveries[0].id).toBe('wd_54');
    expect(body.deliveries[49].id).toBe('wd_5');
    expect(body.deliveries[0]).toMatchObject({
      event: expect.any(String),
      status: expect.any(String),
      attempts: 1,
    });
    // The read path answers status questions; it does not replay content.
    expect(text).not.toContain('secret suite details');
    expect(text).not.toContain('signature');
    expect(text).not.toContain('wd_other');
  });

  it('is org-scoped: another org sees 404, not an empty list', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;

    h.actor = { userId: 'user_2', orgId: 'org_2', role: 'ADMIN', ip: null };
    const { status } = await call('GET', `/integrations/${id}/deliveries`);
    expect(status).toBe(404);
  });
});

describe('DELETE /integrations/:id', () => {
  it('disconnects a chat destination like any other integration', async () => {
    const created = await call('POST', '/integrations/chat', {
      kind: 'SLACK',
      name: 'Eng',
      url: SLACK_URL,
    });
    const id = created.body.integration.id as string;
    const { status, body } = await call('DELETE', `/integrations/${id}`);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(db.tables.integration).toHaveLength(0);
  });
});
