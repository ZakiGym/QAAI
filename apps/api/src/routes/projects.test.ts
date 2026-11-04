/**
 * THE SESSION THE SIGN-IN ROUTE STORES, OVER THE WIRE.
 *
 * `POST …/auth-profiles/:id/sign-in` is the only USER-TRIGGERED writer of
 * `AuthProfile.storageState`, and what stood there was
 *
 *   data: { storageState: (result.storageState as object) ?? undefined,
 *           storageStateExpiresAt: result.expiresAt }
 *
 * — a live customer session, cookies and origin storage, written into the
 * plaintext column. Which made the claim that the field is sealed FALSE for the
 * one path a person can reach, and meant the hourly sweep read what the cockpit
 * had just written as `LEGACY_PLAINTEXT` (its highest-precedence state) and
 * nulled it, so a session captured here survived exactly until the next tick.
 *
 * The properties this file holds the route to, each driven as a REQUEST:
 *
 *   1. THE STORED ROW HOLDS NO PLAINTEXT. Not the cookie value, not the token,
 *      nowhere in the row — and the sealed envelope is a `qs1` envelope with a
 *      key version on the row beside it, so a rotation sweep can find it.
 *   2. `sessionStateOf` ON WHAT WAS WRITTEN ANSWERS `SEALED_FRESH`. That is the
 *      contract between this route and every reader of the column; a row the
 *      gate would refuse is not a stored session.
 *   3. NEITHER THE RESPONSE NOR THE AUDIT ROW CARRIES ANY PART OF IT.
 *   4. A SEAL THAT FAILS DISCARDS THE SESSION AND SAYS SO. It does not fall
 *      back to plaintext and it does not report the customer's own login as
 *      broken for a fault that is ours.
 *   5. A LOGIN THAT PRODUCED NO SESSION DOES NOT WRITE AN EXPIRY ON ITS OWN —
 *      the pair-must-move-together rule, which the old `?? undefined` broke.
 *   6. `signedIn` ON THE LIST IS THE GATE'S ANSWER, not `expiresAt > now`,
 *      which reported TRUE for three states in which there is no usable
 *      session.
 *
 * NO NETWORK, NO BROWSER AND NO DNS: `signInWithProfile` is injected, the
 * cipher is the real AES-256-GCM one over a fake 32-byte master key, and the
 * clock is injected through `configureProjectsIo` so a sealed row's timestamps
 * are a fixed fact.
 *
 * Harness: the same shape as projects.auth-profile.test.ts — a mocked prisma
 * module with a real AsyncLocalStorage tenant scope, and the real router driven
 * over a loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

/** A session shaped like Playwright's, with values nothing may echo. */
const COOKIE_VALUE = 'session-cookie-value-nothing-may-echo';
const TOKEN_VALUE = 'origin-storage-token-nothing-may-echo';
const STORAGE_STATE = {
  cookies: [{ name: 'sid', value: COOKIE_VALUE, domain: 'app.example.com', path: '/' }],
  origins: [
    {
      origin: 'https://app.example.com',
      localStorage: [{ name: 'token', value: TOKEN_VALUE }],
    },
  ],
};

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** What the injected login answers. Set per test. */
  login: Row;
  /**
   * The RAW `data` objects handed to `authProfile.update`, before the fake
   * resolves Prisma's null sentinels. Kept because `Prisma.DbNull` and
   * `Prisma.JsonNull` are not interchangeable here and the difference is not
   * visible in the stored row: `JsonNull` writes the JSON value `null`, which
   * reads back as a column that HAS a value, and `sessionStateOf` tests
   * `storageState !== null` FIRST — so it would classify a freshly sealed row
   * as LEGACY_PLAINTEXT and refuse the session for ever.
   */
  writes: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  login: {},
  writes: [],
}));

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

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
 * A PARTIAL MOCK, and the `importActual` is the load-bearing half: this route
 * also takes `DEFAULT_GATE_RULES`, `checkQuarantineBudget`,
 * `quarantineExpiryFrom` and `quarantineSuppresses` from the same package, and
 * a mock that replaced the module wholesale would leave those undefined — which
 * fails as an unrelated 500 three handlers away.
 */
vi.mock('@qaai/runner', async () => {
  const actual = await vi.importActual<typeof import('@qaai/runner')>('@qaai/runner');
  return {
    ...actual,
    signInWithProfile: async () => h.login,
  };
});

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

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

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
  project: Row[];
  environment: Row[];
  authProfile: Row[];
  secret: Row[];
}

let store: Store;

/**
 * Enough of Prisma to drive these two handlers, and NOT a shrugging fake.
 *
 * `select` IS HONOURED and an unimplemented filter THROWS. Rule 9, and here it
 * is the whole proof: the list route's projection is `...SESSION_ROW_SELECT`,
 * and a fake that returned every column regardless would let that spread be
 * deleted — `sessionStateOf` would then read `undefined` for
 * `storageStateNeedsReseal` and a row marked for re-seal would look fresh,
 * with every assertion below still green.
 */
function makeDb(): Row {
  const orgOf = () => h.currentOrg();

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond === null) return (row[key] ?? null) === null;
      if (typeof cond === 'object') {
        throw new Error(`fake prisma: unimplemented filter on ${key}: ${JSON.stringify(cond)}`);
      }
      return row[key] === cond;
    });

  const pick = (row: Row, select?: Row): Row => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, want] of Object.entries(select)) {
      if (want !== true) throw new Error(`fake prisma: unimplemented select on ${key}`);
      out[key] = row[key] ?? null;
    }
    return out;
  };

  const model = (name: keyof Store): Row => ({
    findMany: async ({ where = {}, select, orderBy }: Row = {}) => {
      const orgId = orgOf();
      let rows = store[name].filter(
        (row) => (!orgId || row.orgId === orgId) && matches(row, where),
      );
      const sort = Object.entries(orderBy ?? {})[0];
      if (sort) {
        const [field, dir] = sort;
        rows = [...rows].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const cmp = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return rows.map((row) => pick(row, select));
    },
    findUnique: async ({ where = {}, select }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) return null;
      const orgId = orgOf();
      if (orgId && found.orgId !== orgId) return null;
      return pick(found, select);
    },
    update: async ({ where = {}, data = {}, select }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) throw new Error(`fake prisma: no ${name} ${String(where.id)}`);
      if (name === 'authProfile') h.writes.push(data as Row);
      /*
       * `Prisma.DbNull` IS A SENTINEL OBJECT, NOT `null`, and it means SQL
       * NULL. Resolving it here rather than storing the sentinel is what makes
       * the "no plaintext in the row" assertions below real: a fake that kept
       * the object would leave a truthy `storageState` and `sessionStateOf`
       * would answer LEGACY_PLAINTEXT for a row the route had just sealed.
       */
      for (const [key, value] of Object.entries(data as Row)) {
        found[key] = value === DB_NULL ? null : value;
      }
      return pick(found, select);
    },
  });

  return {
    project: model('project'),
    environment: model('environment'),
    authProfile: model('authProfile'),
    secret: model('secret'),
  };
}

const FORM_LOGIN_CONFIG = {
  loginUrl: 'https://app.example.com/login',
  usernameSelector: '#email',
  passwordSelector: '#password',
  submitSelector: 'button[type=submit]',
  usernameSecretName: 'APP_USER',
  passwordSecretName: 'APP_PASSWORD',
  successSelector: '[data-testid=dashboard]',
};

function profile(over: Row = {}): Row {
  return {
    id: 'prof_a',
    orgId: 'org_1',
    environmentId: 'env_a',
    name: 'Admin',
    kind: 'FORM_LOGIN',
    config: FORM_LOGIN_CONFIG,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    storageState: null,
    storageStateExpiresAt: null,
    storageStateSealed: null,
    storageStateKeyVersion: null,
    storageStateSealedAt: null,
    storageStateNeedsReseal: false,
    ...over,
  };
}

function install(profiles: Row[] = [profile()]): void {
  store = {
    project: [{ id: 'proj_a', orgId: 'org_1', name: 'A' }],
    environment: [
      {
        id: 'env_a',
        orgId: 'org_1',
        projectId: 'proj_a',
        name: 'staging',
        kind: 'STAGING',
        baseUrl: 'https://app.example.com',
        egressPolicy: null,
      },
    ],
    authProfile: profiles,
    secret: [],
  };
  h.prisma = makeDb();
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { Prisma } = await import('../generated/prisma/client.js');
const DB_NULL = Prisma.DbNull;
const { projectsRouter, configureProjectsIo } = await import('./projects.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const {
  SESSION_REFRESH_LEAD_MS,
  localSessionCipher,
  masterKeyResolver,
  openSession,
  sessionStateOf,
  useSessionState,
} = await import('../lib/session-store.js');
const { currentKeyring } = await import('../lib/vault.js');

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);
app.use(notFoundHandler);
app.use(errorHandler);

let baseUrl = '';
let server: import('node:http').Server;

/** Frozen, so `storageStateSealedAt` and the expiry are facts a test can name. */
const NOW = new Date('2026-10-30T12:00:00.000Z');
const LOGIN_EXPIRY = new Date(NOW.getTime() + 8 * 3600_000);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  configureProjectsIo({ now: () => NOW });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as Row) : {} };
}

const SIGN_IN = '/projects/proj_a/environments/env_a/auth-profiles/prof_a/sign-in';
const LIST = '/projects/proj_a/environments/env_a/auth-profiles';

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits = [];
  h.writes = [];
  h.login = {
    ok: true,
    storageState: STORAGE_STATE,
    message: 'Signed in and confirmed by the dashboard locator.',
    expiresAt: LOGIN_EXPIRY,
    failure: null,
    confirmedBy: 'SUCCESS_SELECTOR',
  };
  install();
  // The default cipher is built from the (mocked) master key on first use; the
  // tests that need a refusal replace it and restore it themselves.
  configureProjectsIo({ now: () => NOW, sessionCipher: null });
});

// ─── The seal ────────────────────────────────────────────────────────────────

describe('a successful sign-in seals the session it captured', () => {
  it('stores a versioned envelope and NO plaintext', async () => {
    const res = await call('POST', SIGN_IN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionStored).toBe(true);

    const row = store.authProfile[0]!;
    // The legacy column is NULL, not merely absent: the sealed value and the
    // plaintext one must never coexist, and a row that holds both is the state
    // the sweep refuses outright.
    expect(row.storageState).toBeNull();
    expect(row.storageStateSealed).toMatch(/^qs1\./);
    expect(row.storageStateKeyVersion).toBe(1);
    expect(row.storageStateSealedAt).toEqual(NOW);
    expect(row.storageStateExpiresAt).toEqual(LOGIN_EXPIRY);
    // Always false on a value sealed under the ACTIVE key — a row left marked
    // would be re-signed-in by the sweep an hour later for no reason.
    expect(row.storageStateNeedsReseal).toBe(false);

    // SQL NULL and not the JSON value `null`. See {@link Hoisted.writes}.
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.storageState).toBe(Prisma.DbNull);
    expect(h.writes[0]!.storageState).not.toBe(Prisma.JsonNull);
  });

  it('leaves no part of the session anywhere in the row', async () => {
    await call('POST', SIGN_IN);
    const serialised = JSON.stringify(store.authProfile[0]);
    expect(serialised).not.toContain(COOKIE_VALUE);
    expect(serialised).not.toContain(TOKEN_VALUE);
    expect(serialised).not.toContain('localStorage');
  });

  /**
   * THE CONTRACT WITH EVERY READER. `sessionStateOf` is what the worker, the
   * crawl and the run gate on, so a row this route writes has to classify as a
   * session they will carry — not merely as "some columns were set".
   */
  it('writes a row `sessionStateOf` calls SEALED_FRESH', async () => {
    await call('POST', SIGN_IN);
    expect(sessionStateOf(store.authProfile[0]! as never, NOW)).toBe('SEALED_FRESH');
  });

  /** And it is the SESSION that was captured, not merely something encrypted. */
  it('round-trips through openSession under the deployment\'s own keyring', async () => {
    await call('POST', SIGN_IN);
    const opened = await openSession({
      row: store.authProfile[0]! as never,
      keys: currentKeyring().keys,
      cipher: localSessionCipher(masterKeyResolver(MASTER_KEY)),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(useSessionState(opened.value, (state) => state)).toEqual(STORAGE_STATE);
  });

  it('puts no part of the session in the response or the audit row', async () => {
    const res = await call('POST', SIGN_IN);
    expect(res.text).not.toContain(COOKIE_VALUE);
    expect(res.text).not.toContain(TOKEN_VALUE);
    expect(res.body.storageState).toBeUndefined();

    const audit = h.audits.find((a) => a.action === 'auth-profile.sign-in')!;
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(audit)).not.toContain(TOKEN_VALUE);
    expect(audit.metadata.sessionSealed).toBe(true);
    expect(audit.metadata.sealRefusal).toBeNull();
  });

  /**
   * `succeeded()` in login.ts always stamps an expiry, so this is the path that
   * does not exist today and must not become a claim of validity if one
   * appears. One refresh lead, deliberately not eight hours.
   */
  it('floors a missing expiry at one refresh lead rather than inventing a TTL', async () => {
    h.login = { ...h.login, expiresAt: null };
    await call('POST', SIGN_IN);
    expect(store.authProfile[0]!.storageStateExpiresAt).toEqual(
      new Date(NOW.getTime() + SESSION_REFRESH_LEAD_MS),
    );
  });
});

// ─── The seal that fails ─────────────────────────────────────────────────────

describe('a session that cannot be sealed is discarded, and said so', () => {
  /**
   * A cipher that refuses is the shape of the one reachable failure: an ACTIVE
   * key version this process holds no material for. The property is that
   * NOTHING is stored — not the plaintext, and not an expiry on its own.
   */
  it('stores nothing at all and reports the refusal by name', async () => {
    configureProjectsIo({
      now: () => NOW,
      sessionCipher: {
        encrypt: async () => {
          throw new Error('no material for that version');
        },
        decrypt: async () => {
          throw new Error('no material for that version');
        },
      },
    });

    const res = await call('POST', SIGN_IN);

    // The customer's login WORKED. Reporting `ok: false` would blame their
    // application for a fault that is entirely ours.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionStored).toBe(false);
    expect(res.body.sessionRefusal).toBe('UNKNOWN_KEY_VERSION');
    expect(typeof res.body.sessionMessage).toBe('string');

    const row = store.authProfile[0]!;
    expect(row.storageState).toBeNull();
    expect(row.storageStateSealed).toBeNull();
    // THE PAIR MOVES TOGETHER. An expiry written without a session is how
    // `expiresAt > now` came to report a valid session for a profile with none.
    expect(row.storageStateExpiresAt).toBeNull();
  });

  it('quotes no part of the session in its refusal', async () => {
    configureProjectsIo({
      now: () => NOW,
      sessionCipher: {
        encrypt: async () => {
          throw new Error('no material for that version');
        },
        decrypt: async () => {
          throw new Error('no material for that version');
        },
      },
    });

    const res = await call('POST', SIGN_IN);
    expect(res.text).not.toContain(COOKIE_VALUE);
    expect(res.text).not.toContain(TOKEN_VALUE);
    const audit = h.audits.find((a) => a.action === 'auth-profile.sign-in')!;
    expect(audit.metadata.sessionSealed).toBe(false);
    expect(audit.metadata.sealRefusal).toBe('UNKNOWN_KEY_VERSION');
  });
});

// ─── A login with no browser session ─────────────────────────────────────────

describe('a kind that produces no browser session', () => {
  /**
   * `?? undefined` used to write the EXPIRY ON ITS OWN here, which made
   * `storageStateExpiresAt !== null && > now` answer TRUE for a profile holding
   * nothing. A header-auth profile has no session to cache and the honest row
   * is the untouched one.
   */
  it('writes neither a session nor an expiry', async () => {
    h.login = { ...h.login, storageState: null };
    const res = await call('POST', SIGN_IN);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionStored).toBe(false);
    expect(res.body.sessionRefusal).toBeNull();

    const row = store.authProfile[0]!;
    expect(row.storageState).toBeNull();
    expect(row.storageStateSealed).toBeNull();
    expect(row.storageStateExpiresAt).toBeNull();
  });
});

// ─── A failed login ──────────────────────────────────────────────────────────

describe('a login that did not complete', () => {
  it('writes nothing and audits the failure', async () => {
    h.login = {
      ok: false,
      storageState: null,
      message: 'The dashboard locator never appeared.',
      expiresAt: null,
      failure: { kind: 'WRONG_CREDENTIALS', step: 'SUBMIT', fault: 'THEIRS', detail: '' },
      confirmedBy: null,
    };

    const res = await call('POST', SIGN_IN);
    expect(res.body.ok).toBe(false);
    expect(res.body.sessionStored).toBe(false);
    expect(store.authProfile[0]!.storageStateSealed).toBeNull();
    expect(h.audits.some((a) => a.action === 'auth-profile.sign-in.failed')).toBe(true);
  });
});

// ─── `signedIn` on the list ──────────────────────────────────────────────────

describe('the list reports the state of a stored session, not `expiresAt > now`', () => {
  /** The future, so a bare expiry comparison would answer TRUE for all of these. */
  const FUTURE = new Date(NOW.getTime() + 8 * 3600_000);

  it('is signed in after this route sealed a session', async () => {
    await call('POST', SIGN_IN);
    const listed = await call('GET', LIST);
    expect(listed.body.profiles[0].signedIn).toBe(true);
    expect(listed.body.profiles[0].session.state).toBe('SEALED_FRESH');
  });

  it('is NOT signed in for a row the migration marked for re-seal', async () => {
    install([profile({ storageStateNeedsReseal: true, storageStateExpiresAt: FUTURE })]);
    const listed = await call('GET', LIST);
    expect(listed.body.profiles[0].signedIn).toBe(false);
    expect(listed.body.profiles[0].session.state).toBe('NEEDS_RESEAL');
    // Ours, not the customer's: we destroyed the plaintext that was here.
    expect(listed.body.profiles[0].session.fault).toBe('OURS');
  });

  it('is NOT signed in for a row holding legacy plaintext', async () => {
    install([
      profile({ storageState: STORAGE_STATE, storageStateExpiresAt: FUTURE }),
    ]);
    const listed = await call('GET', LIST);
    expect(listed.body.profiles[0].signedIn).toBe(false);
    expect(listed.body.profiles[0].session.state).toBe('LEGACY_PLAINTEXT');
  });

  it('is NOT signed in for a sealed row with no key version', async () => {
    install([
      profile({
        storageStateSealed: 'qs1.local-master.1.AES_256_GCM.not-read-here',
        storageStateKeyVersion: null,
        storageStateExpiresAt: FUTURE,
      }),
    ]);
    const listed = await call('GET', LIST);
    expect(listed.body.profiles[0].signedIn).toBe(false);
    expect(listed.body.profiles[0].session.state).toBe('SEALED_UNVERSIONED');
  });

  it('distinguishes "never signed in" from the states above', async () => {
    const listed = await call('GET', LIST);
    expect(listed.body.profiles[0].signedIn).toBe(false);
    expect(listed.body.profiles[0].session.state).toBe('ABSENT');
    // A TTL that has not been reached is not a fault.
    expect(listed.body.profiles[0].session.fault).toBe('LIFECYCLE');
  });

  /**
   * The list now SELECTS the sealed envelope and the legacy column, because
   * `sessionStateOf` needs both. A `{ ...p }` in the response map would hand a
   * live session to any authenticated member who can read this endpoint, which
   * is a worse hole than the one being closed.
   */
  it('never serves the sealed envelope or the legacy column', async () => {
    install([profile({ storageState: STORAGE_STATE, storageStateExpiresAt: FUTURE })]);
    const listed = await call('GET', LIST);
    expect(listed.text).not.toContain(COOKIE_VALUE);
    expect(listed.text).not.toContain(TOKEN_VALUE);
    expect(listed.body.profiles[0].storageState).toBeUndefined();
    expect(listed.body.profiles[0].storageStateSealed).toBeUndefined();
  });
});
