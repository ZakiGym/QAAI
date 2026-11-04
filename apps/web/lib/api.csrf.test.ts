/**
 * THE COCKPIT'S HALF OF THE DOUBLE-SUBMIT TOKEN.
 *
 * The API grew a CSRF guard over the whole `/auth` router and a readable
 * companion cookie to feed it. The cookie had a WRITER AND NO READER, so every
 * cookie-authenticated `/auth/*` mutation the cockpit makes answered 403 —
 * sign-out and switch-org included. A customer would have reported it as "Sign
 * out does nothing", which is why the two cases that matter most here are the
 * last two: the real router, refusing and then accepting, over a real socket.
 *
 * WHAT EACH GROUP IS FOR
 *
 *   1. THE HEADER THE CLIENT COMPOSES. Driven through the exported `api()`
 *      itself with a stubbed `fetch`, because the defect was in `api()` and a
 *      test of an extracted helper would have been a test of the extraction.
 *      The header NAME and the cookie NAME are imported from the API's own
 *      `lib/sessions.ts` rather than retyped, so the two literals in `api.ts`
 *      cannot drift away from the server without this file going red.
 *
 *   2. THE WAYS A COOKIE READER IS QUIETLY WRONG. A name that is a SUFFIX of
 *      another cookie's name; a percent-encoded value; an empty value; a jar
 *      that throws; no `document` at all, which is every server render. Each is
 *      a real failure mode of the one-line version of this code
 *      (`document.cookie.includes('qaai_csrf=')`).
 *
 *   3. NO OTHER COOKIE REACHES A HEADER. The session cookie is HttpOnly and so
 *      is never in the jar — but "we did not try" is worth proving, so the jar
 *      in that case contains one anyway.
 *
 *   4. END TO END, THROUGH THE REAL GUARD. `apps/api/src/routes/auth.ts` is
 *      mounted on a loopback server and `api()` makes a real request at it.
 *      403 without the header, 200 with it, from the production code path on
 *      both sides.
 *
 * HARNESS NOTES
 *   - No network and no DNS: the server listens on 127.0.0.1 and the clock is
 *     injected through `configureAuthIo`.
 *   - Node's `fetch` has no cookie jar, so the end-to-end cases hand the
 *     SESSION cookie over in `init.headers` — that is the browser's job, not
 *     this module's. The CSRF header is NOT handed over: it has to come out of
 *     `api()` reading the stubbed jar, which is the whole point.
 *   - The Prisma stand-in honours `select` and `orderBy` and THROWS on any
 *     filter or operation it does not implement. A select-blind fake makes
 *     deleting a column from a query undetectable.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  store: Record<string, Row[]>;
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({ store: {}, audits: [] }));

/** Long enough for the HMAC, and a phrase rather than anything key-shaped. */
const SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';

vi.mock('../../api/src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    SESSION_SECRET,
    SESSION_TTL_HOURS: 72,
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_HOST: '',
  },
  isProd: false,
}));

/*
 * Silenced AND captured. "No credential reaches a log line" is a property of
 * the router this file drives, so the lines are available to assert on rather
 * than thrown away.
 */
const logLines: Row[] = [];
vi.mock('../../api/src/lib/logger.js', () => {
  const capture = (level: string) => (a?: unknown, b?: unknown) => {
    logLines.push({ level, a, b });
  };
  return {
    logger: {
      trace: capture('trace'),
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      fatal: capture('fatal'),
    },
    currentRequestId: () => 'req_test',
    setRequestActor: () => {},
    runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
    registerRequestSecrets: () => {},
  };
});

vi.mock('../../api/src/lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

vi.mock('../../api/src/lib/mail.js', () => ({
  mailDriver: () => 'console',
  sendMail: async () => ({ driver: 'console', delivered: false }),
  passwordResetMail: (to: string, url: string) => ({ to, subject: 'unused', text: url }),
}));

// ─── The Prisma stand-in ─────────────────────────────────────────────────────

/**
 * The filters this request path is allowed to use. Anything else THROWS.
 *
 * A fake that shrugs at a filter it does not know turns a deleted
 * `revokedAt: null` into a passing test — which here would mean a revoked
 * session's `lastSeenAt` creeping forward, and nothing would say so.
 */
const KNOWN_FILTERS: Record<string, Set<string>> = {
  session: new Set(['tokenHash', 'revokedAt', 'lastSeenAt', 'OR']),
  membership: new Set(['orgId_userId', 'userId']),
  organization: new Set(['id']),
};

const KNOWN_ARGS = new Set(['where', 'select', 'orderBy', 'data']);

function rows(model: string): Row[] {
  const table = h.store[model];
  if (!table) throw new Error(`fake prisma: no table for model "${model}"`);
  return table;
}

function matches(model: string, row: Row, where: Row): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (!KNOWN_FILTERS[model]!.has(key)) {
      throw new Error(`fake prisma: unimplemented filter "${key}" on ${model}`);
    }
    if (key === 'OR') {
      if (!Array.isArray(value)) throw new Error(`fake prisma: OR on ${model} is not an array`);
      if (!value.some((sub: Row) => matches(model, row, sub))) return false;
      continue;
    }
    if (key === 'orgId_userId') {
      const compound = value as Row;
      if (row.orgId !== compound.orgId || row.userId !== compound.userId) return false;
      continue;
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const ops = Object.keys(value as Row);
      if (ops.length !== 1 || ops[0] !== 'lt') {
        throw new Error(`fake prisma: unimplemented operator "${ops.join(',')}" on ${model}.${key}`);
      }
      const left = row[key];
      if (left === null || left === undefined) return false;
      if (!(left < (value as Row).lt)) return false;
      continue;
    }
    const left = row[key];
    if (left instanceof Date && value instanceof Date) {
      if (left.getTime() !== value.getTime()) return false;
      continue;
    }
    if (left !== value) return false;
  }
  return true;
}

/** `select` is honoured, and a column the row does not have is an error. */
function project(model: string, row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted !== true) throw new Error(`fake prisma: unimplemented select on ${model}.${field}`);
    if (!(field in row)) throw new Error(`fake prisma: ${model} row has no column "${field}"`);
    out[field] = row[field];
  }
  return out;
}

function checkArgs(model: string, op: string, args: Row): void {
  for (const key of Object.keys(args)) {
    if (!KNOWN_ARGS.has(key)) {
      throw new Error(`fake prisma: unimplemented argument "${key}" on ${model}.${op}`);
    }
  }
}

function ordered(model: string, found: Row[], orderBy: Row | undefined): Row[] {
  if (!orderBy) return found;
  const entries = Object.entries(orderBy);
  if (entries.length !== 1) throw new Error(`fake prisma: multi-key orderBy on ${model}`);
  const [field, direction] = entries[0]!;
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(`fake prisma: unimplemented orderBy direction "${String(direction)}"`);
  }
  const sign = direction === 'asc' ? 1 : -1;
  return [...found].sort((a, b) => (a[field] < b[field] ? -sign : a[field] > b[field] ? sign : 0));
}

function model(name: string): Row {
  const implemented: Row = {
    findUnique: async (args: Row = {}) => {
      checkArgs(name, 'findUnique', args);
      const hit = rows(name).find((row) => matches(name, row, args.where ?? {}));
      return hit ? project(name, hit, args.select) : null;
    },
    findFirst: async (args: Row = {}) => {
      checkArgs(name, 'findFirst', args);
      const hits = rows(name).filter((row) => matches(name, row, args.where ?? {}));
      const first = ordered(name, hits, args.orderBy)[0];
      return first ? project(name, first, args.select) : null;
    },
    updateMany: async (args: Row = {}) => {
      checkArgs(name, 'updateMany', args);
      const hits = rows(name).filter((row) => matches(name, row, args.where ?? {}));
      for (const row of hits) Object.assign(row, args.data ?? {});
      return { count: hits.length };
    },
  };
  // Anything else is an operation this harness has not been taught, and a
  // silent `undefined` there would read as a route that made no query at all.
  return new Proxy(implemented, {
    get: (target, key: string) => {
      if (key in target) return target[key];
      throw new Error(`fake prisma: unimplemented operation "${name}.${key}"`);
    },
  });
}

vi.mock('../../api/src/lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const scope = new AsyncLocalStorage<{ orgId: string | null }>();
  const models: Row = {};
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, key: string) => {
          models[key] ??= model(key);
          return models[key];
        },
      },
    ),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      scope.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => scope.run({ orgId: null }, async () => fn()),
    currentTenant: () => scope.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

// ─── The two halves, both imported from where they really live ───────────────

const express = (await import('express')).default;
const { authRouter, configureAuthIo } = await import('../../api/src/routes/auth.js');
const { errorHandler, notFoundHandler } = await import('../../api/src/middleware/errors.js');
const { hashToken } = await import('../../api/src/lib/crypto.js');
const { CSRF_COOKIE, CSRF_HEADER, csrfTokenFor } = await import('../../api/src/lib/sessions.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/auth', authRouter);
app.use(notFoundHandler);
app.use(errorHandler);

/** Fixed, so `lastSeenAt` and `expiresAt` are facts rather than a race. */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/*
 * THE LISTEN HAPPENS HERE AND NOT IN `beforeAll`, and the reason is the bug
 * this ordering fixes: `API_URL` in ./api.ts is read ONCE at module load from
 * `process.env.NEXT_PUBLIC_API_URL`, which is how Next inlines it. A `beforeAll`
 * runs after collection, so the client had already frozen the default
 * `http://localhost:4000` and the end-to-end cases failed with ECONNREFUSED
 * against a port nothing was listening on — a harness failure that looks
 * exactly like a refused request.
 */
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address() as import('node:net').AddressInfo;
process.env.NEXT_PUBLIC_API_URL = `http://127.0.0.1:${address.port}`;

const { ApiError, api } = await import('./api.js');

let restoreIo: ReturnType<typeof configureAuthIo> | null = null;

beforeAll(() => {
  restoreIo = configureAuthIo({ now: () => NOW });
});

afterAll(async () => {
  if (restoreIo) configureAuthIo(restoreIo);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const USER = 'user_1';
/** A session token fixture. Opaque, obviously fake, and never logged. */
const RAW_SESSION = 'session-token-that-only-this-file-ever-sees';
const TOKEN_HASH = hashToken(RAW_SESSION);
/** What the API would have written into the readable cookie for that session. */
const EXPECTED_TOKEN = csrfTokenFor(TOKEN_HASH);

function seed(): void {
  h.store.session = [
    {
      id: 'ses_1',
      userId: USER,
      activeOrgId: ORG,
      tokenHash: TOKEN_HASH,
      /*
       * THE LIVE CLOCK, DELIBERATELY. `configureAuthIo` seams the ROUTER's
       * clock, but `middleware/auth.ts` has no such seam — `actorFromSession`
       * compares `expiresAt` against a bare `new Date()`. An expiry set from
       * the injected `NOW` therefore reads as already expired, the actor
       * resolves to undefined, and `revokedBy` comes back null: a harness
       * artefact that would have looked like a route forgetting to stamp it.
       */
      expiresAt: new Date(Date.now() + 3_600_000),
      revokedAt: null,
      revokedReason: null,
      revokedBy: null,
      lastSeenAt: null,
    },
  ];
  h.store.membership = [
    { id: 'mem_1', orgId: ORG, userId: USER, role: 'OWNER', createdAt: new Date(NOW - 1000) },
  ];
  h.store.organization = [
    { id: ORG, enforceSso: false, securityControlModes: null, loginThrottlePolicy: null },
  ];
}

/** The jar as a browser would present it: "; "-joined, values encoded. */
function jar(...pairs: Array<[string, string]>): string {
  return pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

function stubJar(cookie: string): void {
  vi.stubGlobal('document', { cookie });
}

interface Sent {
  url: string;
  init: RequestInit;
}

const sent: Sent[] = [];

/** Records what `api()` composed and answers with a plausible JSON body. */
function stubFetch(status = 200, body: unknown = { ok: true }): void {
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

function headersOf(index = 0): Record<string, string> {
  const call = sent[index];
  if (!call) throw new Error('nothing was sent');
  return (call.init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  sent.length = 0;
  h.audits.length = 0;
  logLines.length = 0;
  seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 1. The header the client composes ───────────────────────────────────────

describe('the CSRF header apps/web composes', () => {
  it('sends the token the API wrote, on a POST', async () => {
    stubJar(jar([CSRF_COOKIE, EXPECTED_TOKEN]));
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(headersOf()[CSRF_HEADER]).toBe(EXPECTED_TOKEN);
  });

  it('omits the header entirely when there is no companion cookie', async () => {
    stubJar(jar(['qaai_theme', 'dark']));
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    // Absent, not ''. An empty header would claim the page holds a token.
    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('omits the header when the cookie has been cleared to an empty value', async () => {
    // What sign-out itself leaves behind: `qaai_csrf=; Max-Age=0`.
    stubJar(`${CSRF_COOKIE}=`);
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('does not send the header on a GET', async () => {
    stubJar(jar([CSRF_COOKIE, EXPECTED_TOKEN]));
    stubFetch(200, { projects: [] });

    await api('/projects');

    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('sends the header on a DELETE, which is a mutation too', async () => {
    stubJar(jar([CSRF_COOKIE, EXPECTED_TOKEN]));
    stubFetch();

    await api('/auth/sessions/ses_2', { method: 'delete' });

    // Lower-cased on purpose: `fetch` upper-cases the method, so a case-blind
    // check here would have let every lower-cased caller through unprotected.
    expect(headersOf()[CSRF_HEADER]).toBe(EXPECTED_TOKEN);
  });

  it('still sets content-type and the caller’s own headers', async () => {
    stubJar(jar([CSRF_COOKIE, EXPECTED_TOKEN]));
    stubFetch();

    await api('/auth/switch-org', {
      method: 'POST',
      body: JSON.stringify({ orgId: ORG }),
      headers: { 'x-qaai-test': 'kept' },
    });

    expect(headersOf()).toMatchObject({
      'content-type': 'application/json',
      'x-qaai-test': 'kept',
      [CSRF_HEADER]: EXPECTED_TOKEN,
    });
  });
});

// ─── 2. The ways a cookie reader is quietly wrong ────────────────────────────

describe('reading the companion cookie', () => {
  it('does not mistake a cookie whose name ends with ours for ours', async () => {
    // `document.cookie.includes('qaai_csrf=')` matches this and sends it.
    stubJar(['x_qaai_csrf=WRONG-VALUE-FROM-ANOTHER-COOKIE'].join('; '));
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('picks ours out of a jar that also holds a longer-named neighbour', async () => {
    stubJar(
      [
        'x_qaai_csrf=WRONG-VALUE-FROM-ANOTHER-COOKIE',
        `${CSRF_COOKIE}=${EXPECTED_TOKEN}`,
        'qaai_csrf_backup=ALSO-WRONG',
      ].join('; '),
    );
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(headersOf()[CSRF_HEADER]).toBe(EXPECTED_TOKEN);
  });

  it('decodes a percent-encoded cookie value before echoing it', async () => {
    // The API writes the cookie with `encodeURIComponent`. Today's token is hex
    // and survives either way, which is exactly why this is pinned: the day the
    // derivation changes shape, a raw read starts sending `%2F` to the server.
    const token = 'needs/encoding+and spaces';
    stubJar(jar([CSRF_COOKIE, token]));
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(headersOf()[CSRF_HEADER]).toBe(token);
  });

  it('omits the header when the cookie value is a malformed escape', async () => {
    stubJar(`${CSRF_COOKIE}=%E0%A4%A`);
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('does not throw during a server render, where document does not exist', async () => {
    vi.stubGlobal('document', undefined);
    expect(typeof document).toBe('undefined');
    stubFetch();

    await expect(api('/auth/logout', { method: 'POST' })).resolves.toEqual({ ok: true });

    // Fails closed: the request goes, without the header, and the server
    // refuses it. It is not treated as exempt.
    expect(CSRF_HEADER in headersOf()).toBe(false);
  });

  it('survives a cookie jar that throws, without sending a header', async () => {
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error('SecurityError: sandboxed frame');
      },
    });
    stubFetch();

    await expect(api('/auth/logout', { method: 'POST' })).resolves.toEqual({ ok: true });
    expect(CSRF_HEADER in headersOf()).toBe(false);
  });
});

// ─── 3. No other cookie reaches a header ─────────────────────────────────────

describe('what else leaves the cookie jar', () => {
  it('never puts the session cookie, or any other cookie, into a header', async () => {
    // The session cookie is HttpOnly and so is never in this jar in a real
    // browser. It is here so that "we did not reach for it" is a measured fact
    // rather than a sentence in a comment.
    stubJar(
      jar(
        ['qaai_session', RAW_SESSION],
        [CSRF_COOKIE, EXPECTED_TOKEN],
        ['qaai_analytics', 'some-other-value'],
      ),
    );
    stubFetch();

    await api('/auth/logout', { method: 'POST' });

    const values = Object.values(headersOf());
    expect(values).not.toContain(RAW_SESSION);
    for (const value of values) {
      expect(value).not.toContain(RAW_SESSION);
      expect(value).not.toContain('some-other-value');
    }
    expect(Object.keys(headersOf()).sort()).toEqual([CSRF_HEADER]);
  });
});

// ─── 4. End to end, through the real guard ───────────────────────────────────

/**
 * The before and the after, against `apps/api/src/routes/auth.ts` itself.
 *
 * The session cookie is passed in `init.headers` because Node's `fetch` has no
 * cookie jar; in a browser it arrives by itself, which is the entire reason a
 * CSRF check exists. The CSRF header is NOT passed: it has to come out of
 * `api()` reading the stubbed jar.
 */
describe('POST /auth/logout against the real router', () => {
  const sessionCookieHeader = { cookie: `qaai_session=${encodeURIComponent(RAW_SESSION)}` };

  it('is refused 403 when the page sends no token', async () => {
    stubJar(jar(['qaai_theme', 'dark']));

    const error = await api('/auth/logout', {
      method: 'POST',
      headers: sessionCookieHeader,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    const api_error = error as InstanceType<typeof ApiError>;
    expect(api_error.status).toBe(403);
    expect(api_error.code).toBe('FORBIDDEN');
    expect(api_error.message).toBe('This request is missing a valid CSRF token.');
    // The refusal is uniform and quotes nothing: no token, no hash, no cookie.
    expect(api_error.message).not.toContain(RAW_SESSION);
    expect(api_error.message).not.toContain(TOKEN_HASH);
    expect(api_error.message).not.toContain(EXPECTED_TOKEN);
    // And the session really is still alive, which is what the user saw: the
    // button did nothing at all.
    expect(h.store.session![0]!.revokedAt).toBeNull();
  });

  it('answers 200 and revokes the session when the page echoes the cookie', async () => {
    stubJar(jar([CSRF_COOKIE, EXPECTED_TOKEN]));

    await expect(
      api('/auth/logout', { method: 'POST', headers: sessionCookieHeader }),
    ).resolves.toEqual({ ok: true });

    const row = h.store.session![0]!;
    expect(row.revokedAt).toEqual(new Date(NOW));
    expect(row.revokedReason).toBe('USER_SIGNED_OUT');
    expect(row.revokedBy).toBe(USER);
  });

  it('logs no part of the session token or the CSRF token on the refused call', async () => {
    stubJar(jar(['qaai_theme', 'dark']));

    await api('/auth/logout', { method: 'POST', headers: sessionCookieHeader }).catch(() => {});

    const written = JSON.stringify({ logLines, audits: h.audits });
    expect(written).not.toContain(RAW_SESSION);
    expect(written).not.toContain(TOKEN_HASH);
    expect(written).not.toContain(EXPECTED_TOKEN);
  });
});
