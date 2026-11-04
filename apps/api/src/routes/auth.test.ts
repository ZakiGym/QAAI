/**
 * Tests for the auth platform, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A WRONG TOTP CODE DOES NOT SIGN YOU IN. The route checked that a code
 *      was SUPPLIED and never looked at its value, so any six digits worked.
 *      That is the single most serious defect in this round and the first test
 *      below is the one that would have caught it.
 *
 *   2. A ROW WITH `totpEnabledAt` SET AND `totpConfirmedAt` NULL IS NOT
 *      ENROLLED. Every row in every existing install is in that state, because
 *      enrolment never verified a code either. Demanding a code from those
 *      users would lock the installed base out of their own organisations;
 *      accepting any six digits is the defect. Both are asserted.
 *
 *   3. A LOCKED ACCOUNT IS INDISTINGUISHABLE FROM ONE THAT DOES NOT EXIST.
 *      Status, body AND elapsed time, compared directly. A lockout that can be
 *      told apart is an account-enumeration oracle, which leaks more than the
 *      brute force it was built to stop.
 *
 *   4. A REVOKED SESSION STOPS WORKING ON THE NEXT REQUEST. Driven through the
 *      REAL `middleware/auth.ts` rather than a stand-in, because "immediate" is
 *      a claim about that file and a faithful reimplementation would be
 *      asserting about the reimplementation.
 *
 *   5. A COOKIE-AUTHENTICATED MUTATION NEEDS A CSRF TOKEN, and a bearer caller
 *      does not.
 *
 *   6. EVERY BRAKE COUNTS WHAT IT WOULD HAVE REFUSED. OBSERVE mode admits the
 *      request and writes both the `LoginAttempt` row and the audit count, so
 *      "how big is the hole" is answerable before anybody enforces.
 *
 *   7. NO SEED, CODE, RECOVERY CODE, TOKEN OR QR PAYLOAD REACHES AN AUDIT
 *      ENTRY, A REFUSAL OR A LOG. Walked over the error paths, not sampled.
 *
 * Harness notes:
 *   - `middleware/auth.ts` is NOT mocked. It is the file that honours
 *     `revokedAt`, and test 4 is about it.
 *   - `lib/vault.ts` is NOT mocked either, so the TOTP seed is really sealed
 *     and really opened, AAD and all. A fake seal would have made the key
 *     version column untested.
 *   - The prisma stand-in HONOURS `select` and REFUSES an unknown filter. A
 *     select-blind fake makes deleting a field from a query undetectable, and
 *     a filter-blind one makes deleting `usedAt: null` from a recovery-code
 *     redemption undetectable — which is test "a recovery code works once".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  audits: Row[];
  mails: Row[];
  logs: Row[];
}

const h = vi.hoisted((): Hoisted => ({ prisma: {}, audits: [], mails: [], logs: [] }));

const SECRET = 'test-session-secret-at-least-32-characters-long';

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    SESSION_SECRET: SECRET,
    SESSION_TTL_HOURS: 72,
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_HOST: '',
  },
  isProd: false,
}));

/*
 * Captured rather than discarded. "No credential reaches a log line" is a
 * property of this router, so the lines are asserted on and not just silenced.
 */
vi.mock('../lib/logger.js', () => {
  const capture = (level: string) => (a?: unknown, b?: unknown) => {
    h.logs.push({ level, a, b });
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

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

vi.mock('../lib/mail.js', () => ({
  mailDriver: () => 'console',
  sendMail: async (mail: Row) => {
    h.mails.push(mail);
    return { driver: 'console', delivered: false };
  },
  passwordResetMail: (to: string, url: string, ttl: number) => ({
    to,
    subject: 'Reset your QAAI password',
    text: `${url} ${ttl}`,
  }),
}));

/*
 * The tenancy scope is real, not stubbed: every query runs in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran.
 */
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

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

type ModelName =
  | 'user'
  | 'membership'
  | 'organization'
  | 'session'
  | 'verificationToken'
  | 'invite'
  | 'apiKey'
  | 'loginThrottle'
  | 'loginAttempt'
  | 'totpRecoveryCode'
  | 'ssoConnection';

/**
 * The filters these routes are allowed to use. Anything else throws rather than
 * being quietly ignored — a fake that shrugged at `usedAt: null` would pass the
 * single-use tests against a route that had no such check.
 */
const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  user: new Set(['id', 'email']),
  membership: new Set(['id', 'orgId', 'userId', 'orgId_userId']),
  organization: new Set(['id', 'slug']),
  session: new Set(['id', 'userId', 'tokenHash', 'revokedAt', 'expiresAt', 'lastSeenAt', 'NOT', 'OR']),
  verificationToken: new Set(['id', 'email', 'tokenHash', 'purpose', 'usedAt']),
  invite: new Set(['id', 'tokenHash', 'acceptedAt']),
  apiKey: new Set(['id', 'keyHash']),
  loginThrottle: new Set(['identifierHash']),
  loginAttempt: new Set(['identifierHash', 'outcome', 'createdAt']),
  totpRecoveryCode: new Set(['id', 'userId', 'codeHash', 'usedAt']),
  ssoConnection: new Set(['id', 'orgId', 'enabled']),
};

/**
 * The `@unique` columns, per model, as schema.prisma declares them. Enforced by
 * the stand-in's `create`, because a unique constraint that exists only in
 * production is a constraint the tests cannot tell you about.
 */
const UNIQUE_COLUMNS: Record<ModelName, readonly string[]> = {
  user: ['email'],
  membership: [],
  organization: ['slug'],
  session: ['tokenHash'],
  verificationToken: ['tokenHash'],
  invite: ['tokenHash'],
  apiKey: ['keyHash'],
  loginThrottle: ['identifierHash'],
  loginAttempt: [],
  totpRecoveryCode: ['codeHash'],
  ssoConnection: [],
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>([
  'user',
  'session',
  'verificationToken',
  'organization',
  // The three this round adds. They are global for the same reason `Session`
  // is: an identifier is not known to belong to any organisation when the
  // counter is incremented, and a recovery code belongs to a person.
  'loginThrottle',
  'loginAttempt',
  'totpRecoveryCode',
]);

/** Column defaults the database would apply, PER MODEL. Not one shared set. */
const CREATE_DEFAULTS: Record<ModelName, Row> = {
  user: {
    emailVerified: null,
    passwordHash: null,
    avatarUrl: null,
    isSuperuser: false,
    totpSecretEnc: null,
    totpSecretKeyVersion: null,
    totpEnabledAt: null,
    totpConfirmedAt: null,
    lastLoginAt: null,
  },
  membership: { role: 'MEMBER' },
  organization: {
    plan: 'FREE',
    limitOverrides: null,
    billingState: 'OK',
    enforceSso: false,
    securityControlModes: null,
    loginThrottlePolicy: null,
  },
  session: {
    activeOrgId: null,
    ip: null,
    userAgent: null,
    deviceLabel: null,
    lastSeenAt: null,
    revokedAt: null,
    revokedReason: null,
    revokedBy: null,
  },
  verificationToken: { usedAt: null },
  invite: { acceptedAt: null, role: 'MEMBER' },
  apiKey: { scopes: [], lastUsedAt: null, expiresAt: null, revokedAt: null },
  loginThrottle: {
    failures: 0,
    lockedUntil: null,
    lockCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  },
  loginAttempt: {},
  totpRecoveryCode: { usedAt: null, usedFromIp: null },
  ssoConnection: { enabled: true, defaultRole: 'MEMBER' },
};

type Store = Record<ModelName, Row[]>;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('gt' in c) return value instanceof Date && value.getTime() > (c.gt as Date).getTime();
    if ('gte' in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
    if ('lt' in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
    if ('not' in c) return !matchesCondition(value, c.not);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: ModelName, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matchesWhere(model, row, cond as Row);
    if (key === 'OR') return (cond as Row[]).some((clause) => matchesWhere(model, row, clause));
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    if (key === 'orgId_userId') {
      const compound = cond as Row;
      return row.orgId === compound.orgId && row.userId === compound.userId;
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, spec] = Object.entries(clause)[0] as [string, unknown];
      const dir: 'asc' | 'desc' =
        typeof spec === 'string' ? (spec as 'asc' | 'desc') : ((spec as Row).sort as 'asc' | 'desc');
      /* Postgres's own default: NULLS FIRST for DESC, NULLS LAST for ASC. */
      const nulls: 'first' | 'last' =
        typeof spec === 'string'
          ? dir === 'desc'
            ? 'first'
            : 'last'
          : ((spec as Row).nulls as 'first' | 'last');
      const left = a[key] ?? null;
      const right = b[key] ?? null;
      if (left === null && right === null) continue;
      if (left === null) return nulls === 'first' ? -1 : 1;
      if (right === null) return nulls === 'first' ? 1 : -1;
      const l = left instanceof Date ? left.getTime() : left;
      const r = right instanceof Date ? right.getTime() : right;
      if (l === r) continue;
      return (l < r ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/**
 * `select` is HONOURED, nested relation selects included, and a column the row
 * does not have is a THROW.
 *
 * A select-blind fake makes deleting a field from a query undetectable: the
 * route would read `row.totpConfirmedAt` from a result it never asked for, the
 * test would pass, and production would read `undefined` — which is falsy, so
 * the second factor would simply stop being required.
 */
function projectRow(store: Store, model: ModelName, row: Row, sel: Row | undefined): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want === true) {
      if (!(key in row)) throw new Error(`fake prisma: ${model} has no column ${key}`);
      out[key] = row[key];
      continue;
    }
    if (key === 'org' && model === 'membership') {
      /*
       * NULL FOR A MISSING ORGANISATION, not a throw. Prisma types this
       * relation as non-null and the FK normally guarantees it — but a read
       * against a lagging replica, or one racing a cascade, returns null, and
       * that is precisely the state the route's `memberOrg` guard defends
       * against. A fake that threw here would make the guard untestable and
       * leave the only evidence for it a comment.
       */
      const org = store.organization.find((o) => o.id === row.orgId);
      out.org = org ? projectRow(store, 'organization', org, (want as Row).select) : null;
      continue;
    }
    throw new Error(`fake prisma: unsupported select on ${model}.${key}`);
  }
  return out;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

function makeDb(store: Store): Row {
  const model = (name: ModelName): Row => {
    const global = GLOBAL_MODELS.has(name);
    const currentOrg = (): string | null => null;
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where)));

    const unique = (where: Row): Row => where;
    const bySelector = (where: Row): Row | undefined =>
      store[name].find((row) => matchesWhere(name, row, unique(where)));

    const createRow = (data: Row): Row => {
      /*
       * THE UNIQUE CONSTRAINTS THE SCHEMA DECLARES, ENFORCED.
       *
       * A fake that lets a duplicate through is a fake that turns a database
       * error into a passing test — and for `TotpRecoveryCode.codeHash` the
       * consequence is specific: two rows with one hash means redeeming one
       * burns both, so a code is not single-use and the remaining count is
       * wrong. That is exactly what a constant entropy source produced here on
       * the first run.
       */
      for (const column of UNIQUE_COLUMNS[name]) {
        if (data[column] === undefined) continue;
        if (store[name].some((row) => row[column] === data[column])) {
          throw new Error(`fake prisma: unique constraint ${name}.${column}`);
        }
      }
      const row: Row = {
        id: nextId(name),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...CREATE_DEFAULTS[name],
        ...data,
      };
      // Nested `memberships: { create: … }` — the shape signup uses to make an
      // org and its first OWNER in one statement.
      for (const [key, value] of Object.entries(row)) {
        if (value && typeof value === 'object' && 'create' in (value as Row)) {
          delete row[key];
          const nested = (value as Row).create as Row;
          if (key === 'memberships') {
            store.membership.push({
              id: nextId('membership'),
              createdAt: new Date(),
              orgId: row.id,
              ...CREATE_DEFAULTS.membership,
              ...nested,
            });
          } else {
            throw new Error(`fake prisma: unsupported nested create ${name}.${key}`);
          }
        }
      }
      store[name].push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        const found = bySelector(where);
        return found ? projectRow(store, name, found, sel) : null;
      },
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        const rows = sortRows(select(where), orderBy);
        return rows[0] ? projectRow(store, name, rows[0], sel) : null;
      },
      findMany: async ({ where, orderBy, select: sel, take }: Row = {}) => {
        const rows = sortRows(select(where), orderBy);
        const page = typeof take === 'number' ? rows.slice(0, take) : rows;
        return page.map((row) => projectRow(store, name, row, sel));
      },
      count: async ({ where }: Row = {}) => select(where).length,
      create: async ({ data, select: sel }: Row) =>
        projectRow(store, name, createRow(data), sel),
      createMany: async ({ data }: Row) => {
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) createRow(row);
        return { count: rows.length };
      },
      upsert: async ({ where, create, update, select: sel }: Row) => {
        const found = bySelector(where);
        if (found) {
          Object.assign(found, update);
          return projectRow(store, name, found, sel);
        }
        return projectRow(store, name, createRow(create), sel);
      },
      update: async ({ where, data, select: sel }: Row) => {
        const found = bySelector(where);
        if (!found) throw new Error(`fake prisma: no ${name} to update`);
        Object.assign(found, data);
        return projectRow(store, name, found, sel);
      },
      updateMany: async ({ where, data }: Row) => {
        const hits = select(where);
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
      deleteMany: async ({ where }: Row = {}) => {
        const hits = select(where);
        for (const row of hits) store[name].splice(store[name].indexOf(row), 1);
        return { count: hits.length };
      },
    };
  };

  const db: Row = {
    /*
     * THE CALLBACK FORM, which is what every write in this router uses. The
     * delegates handed to the callback are the SAME objects as the top-level
     * ones, which an in-memory fake cannot avoid — so a test asserting
     * atomicity would be asserting nothing. What the callback form DOES buy
     * here is that a `throw` inside it propagates, which is the mechanism
     * behind "the token is burned in the same transaction, conditionally".
     */
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: Row) => Promise<unknown>)(db);
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      throw new Error('fake prisma: unsupported $transaction argument');
    },
  };
  for (const name of Object.keys(KNOWN_FILTERS) as ModelName[]) db[name] = model(name);
  return db;
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { authRouter, configureAuthIo, LOGIN_REFUSAL, LOGIN_TIME_FLOOR_MS, OBSERVED_ACTION } =
  await import('./auth.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const { hashToken } = await import('../lib/crypto.js');
const { CSRF_HEADER, csrfTokenFor } = await import('../lib/sessions.js');
const { hashRecoveryCode, inProcessReplayStore, stepAt, toBase32, totpCodeAt } =
  await import('../lib/totp.js');
const { seal } = await import('../lib/vault.js');
const { throttleKey } = await import('../lib/throttle.js');
const { LOGIN_THROTTLE_DEFAULTS } = await import('@qaai/shared');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/auth', authRouter);
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

interface CallResult {
  status: number;
  body: Row;
  setCookie: string[];
  elapsedMs: number;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; csrf?: string; headers?: Row } = {},
): Promise<CallResult> {
  const startedAt = Date.now();
  const headers: Row = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers[CSRF_HEADER] = options.csrf;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Row) : {},
    setCookie: res.headers.getSetCookie(),
    elapsedMs: Date.now() - startedAt,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const USER = 'user_1';
const EMAIL = 'person@example.test';
const PASSWORD = 'correct horse battery staple';
/** No account anywhere. The other half of every no-oracle comparison. */
const NO_SUCH_EMAIL = 'nobody-at-all@example.test';

/** Twenty bytes of a counting pattern. A fixture, not a credential. */
const SEED = toBase32(Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 11 + 5) & 0xff)));

let store: Store;
let clock: number;
let restoreIo: ReturnType<typeof configureAuthIo> | null = null;

/** A real scrypt hash, computed ONCE: it costs ~100ms and every login needs it. */
const { hashPassword } = await import('../lib/crypto.js');
const passwordHash = await hashPassword(PASSWORD);

function seedStore(over: { user?: Row; org?: Row } = {}): Store {
  const sealed = seal(SEED, USER, 'User.totpSecretEnc');
  return {
    user: [
      {
        id: USER,
        email: EMAIL,
        name: 'A Person',
        ...CREATE_DEFAULTS.user,
        passwordHash,
        emailVerified: new Date(clock - 86_400_000),
        createdAt: new Date(clock - 30 * 86_400_000),
        updatedAt: new Date(clock),
        /* Present but inert unless a test turns the factor on. */
        totpSecretEnc: sealed.ciphertext,
        totpSecretKeyVersion: sealed.keyVersion,
        ...over.user,
      },
    ],
    membership: [
      { id: 'mem_1', orgId: ORG, userId: USER, role: 'OWNER', createdAt: new Date(clock) },
    ],
    organization: [
      {
        id: ORG,
        name: 'Example',
        slug: 'example',
        ...CREATE_DEFAULTS.organization,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
        ...over.org,
      },
    ],
    session: [],
    verificationToken: [],
    invite: [],
    apiKey: [],
    loginThrottle: [],
    loginAttempt: [],
    totpRecoveryCode: [],
    ssoConnection: [],
  };
}

function wireIo(next: Parameters<typeof configureAuthIo>[0]): void {
  const previous = configureAuthIo(next);
  if (restoreIo === null) restoreIo = previous;
}

beforeEach(() => {
  clock = Date.now();
  sequence = 0;
  h.audits = [];
  h.mails = [];
  h.logs = [];
  store = seedStore();
  h.prisma = makeDb(store);
  /*
   * A controllable clock and an instant sleep, so a ±1-step window can be
   * driven across a boundary and the suite does not spend 300ms per login
   * waiting out the floor. The ONE test that is about the floor restores the
   * real pair.
   */
  /*
   * A COUNTING entropy source and not a constant one, and that is a finding
   * rather than a fixture detail: `Buffer.alloc(n, 0x3c)` made every one of the
   * ten recovery codes IDENTICAL (60 % 31 is one character), redeeming one
   * burned all ten, and the remaining-count read answered zero. In production
   * `TotpRecoveryCode.codeHash` is `@unique`, so `createMany` would have thrown
   * — which is why the stand-in below enforces that constraint too, rather
   * than letting a duplicate pass here and fail in a customer's database.
   */
  let entropy = 0;
  wireIo({
    now: () => clock,
    sleep: async () => {},
    random: (n: number) =>
      Buffer.from(Array.from({ length: n }, () => (entropy = (entropy + 7) & 0xff))),
    replay: inProcessReplayStore(() => clock),
  });
});

afterEach(() => {
  if (restoreIo) {
    configureAuthIo(restoreIo);
    restoreIo = null;
  }
});

/** The code the user's authenticator would be showing. */
function currentCode(offsetSteps = 0): string {
  const code = totpCodeAt(SEED, stepAt(clock) + offsetSteps);
  if (code === null) throw new Error('the fixture seed did not decode');
  return code;
}

/** Six digits that are not the code, derived rather than written out. */
function wrongCode(): string {
  return String((Number(currentCode()) + 500_000) % 1_000_000).padStart(6, '0');
}

function enableTotp(confirmed: boolean): void {
  const user = store.user[0]!;
  user.totpEnabledAt = new Date(clock - 86_400_000);
  user.totpConfirmedAt = confirmed ? new Date(clock - 86_400_000) : null;
}

/** Sign in and return the cookie header plus the CSRF token. */
async function signIn(body: Row = {}): Promise<{ cookie: string; csrf: string }> {
  const res = await call('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD, ...body },
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  const session = res.setCookie.find((c) => c.startsWith('qaai_session='))!;
  return { cookie: session.split(';')[0]!, csrf: String(res.body.csrfToken) };
}

function attemptsWith(outcome: string): Row[] {
  return store.loginAttempt.filter((row) => row.outcome === outcome);
}

function observedCounts(control: string): Row[] {
  return h.audits.filter((a) => a.action === OBSERVED_ACTION && a.targetId === control);
}

// ─── 1. The second factor ────────────────────────────────────────────────────

describe('the second factor, which used to accept any six digits', () => {
  beforeEach(() => {
    enableTotp(true);
  });

  it('REFUSES A WRONG CODE — the defect this round exists to close', async () => {
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: wrongCode() },
    });

    expect(res.status).toBe(401);
    // One sentence for all five refusals, so a replay cannot be told from a
    // wrong code by the response.
    expect(res.body.error.message).toBe('That two-factor code is not valid.');
    expect(res.setCookie.filter((c) => c.startsWith('qaai_session='))).toHaveLength(0);
    // The outcome that has never once been reachable, because the value was
    // never checked.
    expect(attemptsWith('BAD_TOTP')).toHaveLength(1);
  });

  it('accepts the current code', async () => {
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode() },
    });
    expect(res.status).toBe(200);
    expect(attemptsWith('SUCCESS')).toHaveLength(1);
  });

  it('accepts the previous step, and refuses two steps back', async () => {
    const back = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode(-1) },
    });
    expect(back.status).toBe(200);

    const farther = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode(-2) },
    });
    expect(farther.status).toBe(401);
  });

  it('REFUSES THE SAME CODE TWICE, so an intercepted code is not reusable', async () => {
    const code = currentCode();
    expect((await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD, totpCode: code } })).status).toBe(200);

    clock += 2_000;
    const replay = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: code },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe('That two-factor code is not valid.');
  });

  it('asks for a code when none was supplied, rather than letting the login through', async () => {
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('A two-factor code is required');
  });

  it('COUNTS A BAD CODE AGAINST THE THROTTLE, so six digits are not brute-forceable', async () => {
    await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: wrongCode() },
    });
    const row = store.loginThrottle.find((r) => r.identifierHash === throttleKey('email', EMAIL));
    // Behind a correct password the second factor is the only thing left
    // standing, which is the one place an unthrottled six-digit space matters.
    expect(row?.failures).toBe(1);
  });

  it('REFUSES rather than admitting when the seed cannot be opened', async () => {
    // A key problem must not become an authentication bypass. This is the one
    // exception handler in the route that could have fallen through to "allow".
    store.user[0]!.totpSecretEnc = 'not-a-ciphertext-at-all';
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode() },
    });
    expect(res.status).toBe(401);
  });
});

describe('a row with the factor STARTED and never CONFIRMED', () => {
  beforeEach(() => {
    enableTotp(false);
  });

  it('SIGNS IN WITH THE PASSWORD ALONE, because that row is NOT ENROLLED', async () => {
    // Every row in every existing install is in this state: enrolment never
    // verified a code, so the user may hold a seed their authenticator never
    // saw. Demanding a code here locks the installed base out of their own
    // organisations, which is why `totpConfirmedAt` is a separate column.
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(200);
  });

  it('reports the pair as two facts, never as one boolean', async () => {
    const { cookie } = await signIn();
    const me = await call('GET', '/auth/me', { cookie });
    expect(me.body.user.twoFactor).toEqual({
      started: true,
      confirmed: false,
      recoveryCodesRemaining: 0,
    });
  });
});

describe('the TOTP_VERIFICATION brake', () => {
  beforeEach(() => {
    enableTotp(true);
    store.organization[0]!.securityControlModes = { TOTP_VERIFICATION: 'OBSERVE' };
  });

  it('ADMITS a bad code in OBSERVE mode AND COUNTS IT', async () => {
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: wrongCode() },
    });
    expect(res.status).toBe(200);

    // The brake's own words for this number: "the size of the hole; it must not
    // be left running." A mode with no counter is an off switch.
    const counted = observedCounts('TOTP_VERIFICATION');
    expect(counted).toHaveLength(1);
    expect(counted[0]!.metadata).toMatchObject({
      control: 'TOTP_VERIFICATION',
      wouldHaveRefused: true,
      refusal: 'CODE_DID_NOT_VERIFY',
    });
    expect(attemptsWith('BAD_TOTP')).toHaveLength(1);
  });

  it('defaults to ENFORCE when the organisation has stored nothing', async () => {
    store.organization[0]!.securityControlModes = null;
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: wrongCode() },
    });
    expect(res.status).toBe(401);
    expect(observedCounts('TOTP_VERIFICATION')).toHaveLength(0);
  });

  it('falls back to ENFORCE for a malformed stored mode rather than to OBSERVE', async () => {
    for (const stored of ['nonsense', [], { TOTP_VERIFICATION: 'MAYBE' }, 42]) {
      store.loginAttempt = [];
      store.organization[0]!.securityControlModes = stored;
      const res = await call('POST', '/auth/login', {
        body: { email: EMAIL, password: PASSWORD, totpCode: wrongCode() },
      });
      // A control that is off for as long as a row is malformed is not a
      // control.
      expect(res.status).toBe(401);
    }
  });
});

// ─── 2. Throttling, and the oracle it must not become ───────────────────────

describe('per-identifier throttling', () => {
  it('locks the identifier at the threshold and then refuses uniformly', async () => {
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.maxFailures; i += 1) {
      const res = await call('POST', '/auth/login', {
        body: { email: EMAIL, password: 'wrong password entirely' },
      });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe(LOGIN_REFUSAL);
    }

    // The CORRECT password now, which is the point: the lock is what bounds the
    // guess rate, and a lock a correct guess walks through bounds nothing.
    const locked = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toBe(LOGIN_REFUSAL);
    expect(attemptsWith('LOCKED_OUT')).toHaveLength(1);
  });

  it('counts the SOURCE as well, and never hard-locks it', async () => {
    // Ten different addresses from one host: the identifier counters each see
    // one failure, the source counter sees ten.
    for (let i = 0; i < 10; i += 1) {
      await call('POST', '/auth/login', {
        body: { email: `walker-${i}@example.test`, password: 'wrong' },
      });
    }
    const sources = store.loginThrottle.filter((r) => r.failures >= 10);
    expect(sources).toHaveLength(1);
    // An office behind one NAT address is one source.
    expect(sources[0]!.lockedUntil).toBeNull();
  });

  it('a COMPLETED PASSWORD RESET clears the lock', async () => {
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.maxFailures; i += 1) {
      await call('POST', '/auth/login', { body: { email: EMAIL, password: 'wrong' } });
    }

    // Start and finish a reset, which needs the mailed token — the one thing
    // somebody locking a stranger out does not have.
    await call('POST', '/auth/password/forgot', { body: { email: EMAIL } });
    const link = String(h.mails.at(-1)!.text).match(/token=([^\s]+)/)![1]!;
    const reset = await call('POST', '/auth/password/reset', {
      body: { token: link, password: 'a brand new long password' },
    });
    expect(reset.status).toBe(200);

    const row = store.loginThrottle.find((r) => r.identifierHash === throttleKey('email', EMAIL))!;
    expect(row.lockedUntil).toBeNull();
    // The lock count survives: "locked out forty times this month" separates a
    // forgetful human from a password list.
    expect(row.lockCount).toBe(1);
  });

  it('the LOGIN_THROTTLE brake admits and counts in OBSERVE mode', async () => {
    store.organization[0]!.securityControlModes = { LOGIN_THROTTLE: 'OBSERVE' };
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.maxFailures; i += 1) {
      await call('POST', '/auth/login', { body: { email: EMAIL, password: 'wrong' } });
    }
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(attemptsWith('LOCKED_OUT')).toHaveLength(1);
    expect(observedCounts('LOGIN_THROTTLE')).toHaveLength(1);
  });
});

/**
 * THE WINDOW BETWEEN THE CODE LANDING AND `prisma migrate deploy` RUNNING.
 *
 * `LoginThrottle` arrives in a hand-written migration, so there is a window in
 * which this router is deployed and the relation is not there. The throttle
 * READ is deliberately unwrapped — an unreadable lock must not be assumed open
 * — and MEASURED on this tree before the fix, with that one relation answering
 * Postgres's `P2021`: **`POST /auth/login` answered 500, body and all, for
 * every caller.** Fail-closed AND a total login outage, and nothing owned it.
 *
 * "There is no lock table" and "I cannot read the lock table" are two facts
 * with opposite correct answers. These tests pin the split at the door; the
 * recogniser itself is pinned in lib/throttle.test.ts.
 */
describe('the throttle relation does not exist yet', () => {
  /**
   * Prisma's own shape for a missing relation. Built here rather than imported
   * because the point is that the recogniser reads `code` off whatever the
   * client throws, and a fake carrying only a message must not satisfy it.
   */
  function dbError(code: string, message: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.name = 'PrismaClientKnownRequestError';
    err.code = code;
    return err;
  }

  /** Every `loginThrottle` query answers the same way. Nothing else is touched. */
  function throttleAnswers(err: () => never): void {
    (h.prisma as Row).loginThrottle = new Proxy(
      {},
      { get: () => async () => err() },
    );
  }

  it('SIGNS THE USER IN instead of answering 500, and says so out loud', async () => {
    throttleAnswers(() => {
      throw dbError('P2021', 'The table `public.LoginThrottle` does not exist in the current database.');
    });

    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });

    // The whole point. 500 here is every customer locked out of the product by
    // a control that holds no state and therefore protects nobody.
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);

    /*
     * COUNTED, and `wouldHaveRefused` is NULL rather than false: nothing was
     * read, so there is no answer to "would this have been refused" and a
     * `false` there would be a measured-looking value nobody measured.
     */
    const observed = h.audits.filter(
      (row) => row.action === OBSERVED_ACTION && row.targetId === 'LOGIN_THROTTLE',
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]!.metadata).toMatchObject({
      control: 'LOGIN_THROTTLE',
      wouldHaveRefused: null,
      availability: 'NOT_INSTALLED',
    });

    // LOUD, at error, naming the remedy. A security control that is off and
    // quiet about it is the defect, not the migration window.
    const loud = h.logs.filter(
      (line) => line.level === 'error' && String(line.b).includes('prisma migrate deploy'),
    );
    expect(loud).toHaveLength(1);
  });

  it('STILL ANSWERS 500 when the relation is there and cannot be read', async () => {
    /*
     * The half that must not be degraded with the other. "I cannot tell whether
     * you are locked out" is not "you are not locked out", and admitting the
     * login on that basis is the control being switched off by a dropped
     * connection — which is a thing an attacker can cause.
     */
    throttleAnswers(() => {
      throw dbError('P1001', "Can't reach database server");
    });

    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });

    expect(res.status).toBe(500);
    // And NOT counted as a not-installed degrade, which would report an
    // unreadable lock as a control nobody had installed.
    expect(
      h.audits.filter((row) => row.metadata?.availability === 'NOT_INSTALLED'),
    ).toEqual([]);
  });

  it('answers the SAME uniform 500 whichever control could not be read', async () => {
    /*
     * Rule: a refusal must not tell a caller what is wrong inside the network.
     * The two unreadable cases below are different relations failing, and the
     * caller gets one code and one sentence for both — `errorHandler` attaches
     * a driver `details` in development only (`isProd`), and that is the one
     * place the table name appears.
     *
     * NOT A TEST ABOUT THE PASSWORD. An earlier draft of this test fabricated a
     * driver error carrying the login password and asserted it did not reach
     * the body; it does reach `details` in development, and the draft was
     * asserting a property the code never claimed against an error no driver
     * produces — the query on this path carries the identifier HASH and never
     * the password. Recorded because a test built on an unreachable premise is
     * worse than no test.
     */
    const bodies: string[] = [];
    for (const code of ['P1001', 'P2024']) {
      store = seedStore();
      h.prisma = makeDb(store);
      (h.prisma as Row).loginThrottle = new Proxy(
        {},
        {
          get: () => async () => {
            throw dbError(code, 'the relation could not be read');
          },
        },
      );
      const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
      expect(res.status).toBe(500);
      bodies.push(`${res.body.error.code}|${res.body.error.message}`);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe('INTERNAL|Something went wrong on our side');
  });
});

describe('THE LOCKOUT MUST NOT BE AN ACCOUNT-ENUMERATION ORACLE', () => {
  /** Drive one identifier to its lock with the instant sleep, so priming is cheap. */
  async function lockOut(email: string): Promise<void> {
    for (let i = 0; i < LOGIN_THROTTLE_DEFAULTS.maxFailures; i += 1) {
      await call('POST', '/auth/login', { body: { email, password: 'wrong password entirely' } });
    }
  }

  it('answers a FRESH existing address and a FRESH unknown one identically, in body AND time', async () => {
    /*
     * THE WALL CLOCK, with the real sleep. This is the empirical half: the
     * fixed floor is the only thing that makes the two branches comparable at
     * all, because a known address costs a membership lookup and an unknown one
     * does not.
     *
     * The tolerance is generous because a CI box is noisy. What it rules out is
     * the order-of-magnitude difference an unfloored pair produces — before the
     * floor the known branch did strictly more work and answered strictly
     * later, every time.
     */
    wireIo({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

    const known = await call('POST', '/auth/login', { body: { email: EMAIL, password: 'nope' } });
    const unknown = await call('POST', '/auth/login', {
      body: { email: NO_SUCH_EMAIL, password: 'nope' },
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(known.body.error.message).toBe(LOGIN_REFUSAL);
    expect(known.elapsedMs).toBeGreaterThanOrEqual(LOGIN_TIME_FLOOR_MS);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(LOGIN_TIME_FLOOR_MS);
    const ratio =
      Math.max(known.elapsedMs, unknown.elapsedMs) / Math.min(known.elapsedMs, unknown.elapsedMs);
    expect(ratio).toBeLessThan(2);
  }, 20_000);

  it('answers a LOCKED EXISTING account and a LOCKED UNKNOWN one identically', async () => {
    /*
     * LIKE FOR LIKE, and that is the whole design of this test.
     *
     * Comparing a locked existing account against a FRESH unknown one would
     * measure the backoff rather than the oracle: the locked side pays the
     * capped delay because the caller themselves failed ten times against it,
     * which happens to an address with no account exactly the same way. So both
     * sides are driven to the lock, and what is compared is the answer.
     *
     * THE REQUESTED DELAY, not the wall clock. The two sides each ask for the
     * four-second cap, and asserting on the requested number is deterministic
     * where asserting on 8.6 seconds of real sleeping would be both slow and
     * flaky. The wall-clock half of the claim is the test above.
     */
    const asked: number[] = [];
    wireIo({ sleep: async (ms) => void asked.push(ms) });

    await lockOut(EMAIL);
    await lockOut(NO_SUCH_EMAIL);
    asked.length = 0;

    const locked = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    const lockedDelay = asked.reduce((a, b) => a + b, 0);
    asked.length = 0;

    const unknown = await call('POST', '/auth/login', {
      body: { email: NO_SUCH_EMAIL, password: PASSWORD },
    });
    const unknownDelay = asked.reduce((a, b) => a + b, 0);

    expect(locked.status).toBe(unknown.status);
    expect(locked.body).toEqual(unknown.body);
    expect(locked.body.error.message).toBe(LOGIN_REFUSAL);
    expect(lockedDelay).toBe(unknownDelay);
    expect(lockedDelay).toBeGreaterThan(LOGIN_TIME_FLOOR_MS);

    // And the operator CAN tell them apart, inside their own tenant.
    expect(attemptsWith('LOCKED_OUT')).toHaveLength(2);
  }, 20_000);

  it('answers a wrong password and an unknown address identically', async () => {
    const wrong = await call('POST', '/auth/login', { body: { email: EMAIL, password: 'nope' } });
    const missing = await call('POST', '/auth/login', {
      body: { email: NO_SUCH_EMAIL, password: 'nope' },
    });
    expect(wrong.status).toBe(missing.status);
    expect(wrong.body).toEqual(missing.body);
    // The OPERATOR can tell them apart, inside their own tenant. That is the
    // difference between "somebody forgot their password" and "somebody is
    // walking a list", and collapsing it would remove the only signal that
    // says which is happening.
    expect(attemptsWith('BAD_PASSWORD')).toHaveLength(1);
    expect(attemptsWith('UNKNOWN_IDENTIFIER')).toHaveLength(1);
  });

  it('CREATES A COUNTER FOR AN ADDRESS WITH NO ACCOUNT', async () => {
    await call('POST', '/auth/login', { body: { email: NO_SUCH_EMAIL, password: 'nope' } });
    expect(
      store.loginThrottle.find((r) => r.identifierHash === throttleKey('email', NO_SUCH_EMAIL))
        ?.failures,
    ).toBe(1);
  });
});

// ─── 3. Sessions ────────────────────────────────────────────────────────────

describe('signing out a lost laptop', () => {
  it('lists the live sessions with a device label, and never the token', async () => {
    const first = await signIn({ deviceLabel: 'Work laptop' });
    await signIn({ deviceLabel: 'Phone' });

    const res = await call('GET', '/auth/sessions', { cookie: first.cookie });
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.map((s: Row) => s.deviceLabel).sort()).toEqual(['Phone', 'Work laptop']);
    expect(res.body.sessions.filter((s: Row) => s.current)).toHaveLength(1);
    // The whole payload, not a field spot-check.
    expect(JSON.stringify(res.body)).not.toContain(hashToken(first.cookie.split('=')[1]!));
  });

  it('A REVOKED SESSION STOPS WORKING ON THE NEXT REQUEST', async () => {
    const keep = await signIn({ deviceLabel: 'Desk' });
    const lost = await signIn({ deviceLabel: 'Lost laptop' });

    const list = await call('GET', '/auth/sessions', { cookie: keep.cookie });
    const target = list.body.sessions.find((s: Row) => s.deviceLabel === 'Lost laptop')!;

    const killed = await call('DELETE', `/auth/sessions/${target.id}`, {
      cookie: keep.cookie,
      csrf: keep.csrf,
    });
    expect(killed.status).toBe(200);

    /*
     * Driven through the REAL `middleware/auth.ts`, which is the file that
     * reads `revokedAt` on every request. There is no token cache and no expiry
     * window between the two, so this is immediate rather than "at the next
     * token expiry" — a revocation that takes an hour is not a revocation.
     */
    const after = await call('GET', '/auth/sessions', { cookie: lost.cookie });
    expect(after.status).toBe(401);
    // The survivor is untouched, which is the point of a per-device list.
    expect((await call('GET', '/auth/sessions', { cookie: keep.cookie })).status).toBe(200);
  });

  it('REFUSES to revoke somebody else\'s session, as a 404', async () => {
    const mine = await signIn();
    store.session.push({
      id: 'sess_theirs',
      userId: 'user_other',
      tokenHash: 'f'.repeat(64),
      ...CREATE_DEFAULTS.session,
      expiresAt: new Date(clock + 86_400_000),
      createdAt: new Date(clock),
    });

    const res = await call('DELETE', '/auth/sessions/sess_theirs', {
      cookie: mine.cookie,
      csrf: mine.csrf,
    });
    // Indistinguishable from "no such session": an id must not be a probe for
    // whose session it is.
    expect(res.status).toBe(404);
    expect(store.session.find((s) => s.id === 'sess_theirs')!.revokedAt).toBeNull();
  });

  it('revokes in bulk and REPORTS THE NUMBER', async () => {
    const keep = await signIn();
    await signIn();
    await signIn();

    const res = await call('POST', '/auth/sessions/revoke-all', {
      cookie: keep.cookie,
      csrf: keep.csrf,
      body: {},
    });
    expect(res.body).toMatchObject({ ok: true, revoked: 2, includeCurrent: false });
    // The caller's own session survives by default; signing somebody out of the
    // tab they clicked in reads as a failure.
    expect((await call('GET', '/auth/sessions', { cookie: keep.cookie })).status).toBe(200);
  });

  it('includes the current session when asked', async () => {
    const mine = await signIn();
    await signIn();
    const res = await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      csrf: mine.csrf,
      body: { includeCurrent: true },
    });
    expect(res.body.revoked).toBe(2);
    expect((await call('GET', '/auth/sessions', { cookie: mine.cookie })).status).toBe(401);
  });

  it('records WHY each session stopped working', async () => {
    const mine = await signIn();
    await signIn();
    await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      csrf: mine.csrf,
      body: {},
    });
    const revoked = store.session.filter((s) => s.revokedAt !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.revokedReason).toBe('ALL_SESSIONS_REVOKED');
    expect(revoked[0]!.revokedBy).toBe(USER);
  });

  it('stamps lastSeenAt, so the list can be acted on', async () => {
    const mine = await signIn();
    clock += 120_000;
    await call('GET', '/auth/me', { cookie: mine.cookie });
    const row = store.session.find((s) => s.tokenHash === hashToken(mine.cookie.split('=')[1]!))!;
    expect(row.lastSeenAt).toEqual(new Date(clock));
  });

  it('a PASSWORD CHANGE revokes the others, with a reason, and keeps this one', async () => {
    const mine = await signIn();
    await signIn();

    const res = await call('POST', '/auth/password/change', {
      cookie: mine.cookie,
      csrf: mine.csrf,
      body: { currentPassword: PASSWORD, newPassword: 'another long enough password' },
    });
    expect(res.body).toMatchObject({ ok: true, sessionsRevoked: 1 });
    expect(store.session.find((s) => s.revokedAt !== null)!.revokedReason).toBe('PASSWORD_CHANGED');
    expect((await call('GET', '/auth/me', { cookie: mine.cookie })).status).toBe(200);
  });
});

// ─── 4. CSRF ────────────────────────────────────────────────────────────────

describe('CSRF on a cookie-authenticated mutation', () => {
  it('REFUSES a state-changing request with no token', async () => {
    const mine = await signIn();
    const res = await call('POST', '/auth/sessions/revoke-all', { cookie: mine.cookie, body: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This request is missing a valid CSRF token.');
  });

  it('REFUSES a wrong token with the SAME sentence as a missing one', async () => {
    const mine = await signIn();
    const missing = await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      body: {},
    });
    const wrong = await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      csrf: 'a'.repeat(64),
      body: {},
    });
    // "Missing" versus "wrong" would tell a page whether it had guessed the
    // header name.
    expect(wrong.status).toBe(missing.status);
    expect(wrong.body).toEqual(missing.body);
  });

  it('REFUSES ANOTHER SESSION\'S TOKEN, so one is not a bearer token for all', async () => {
    const mine = await signIn();
    const other = await signIn();
    const res = await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      csrf: other.csrf,
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('allows the matching token', async () => {
    const mine = await signIn();
    const res = await call('POST', '/auth/sessions/revoke-all', {
      cookie: mine.cookie,
      csrf: mine.csrf,
      body: {},
    });
    expect(res.status).toBe(200);
  });

  it('does NOT apply to a safe method', async () => {
    const mine = await signIn();
    expect((await call('GET', '/auth/sessions', { cookie: mine.cookie })).status).toBe(200);
  });

  it('does NOT apply to a caller with no cookie, so login and signup are unaffected', async () => {
    // A CSRF check exists because the browser attaches the cookie by itself; a
    // bearer token is attached deliberately.
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(200);
  });

  it('sets the readable companion cookie, which is how the page echoes it back', async () => {
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    const csrf = res.setCookie.find((c) => c.startsWith('qaai_csrf='))!;
    expect(csrf).not.toContain('HttpOnly');
    const session = res.setCookie.find((c) => c.startsWith('qaai_session='))!;
    // The session cookie stays HttpOnly. The readable one authorises nothing on
    // its own.
    expect(session).toContain('HttpOnly');
    expect(csrf).toContain(encodeURIComponent(csrfTokenFor(hashToken(session.split(';')[0]!.split('=')[1]!))));
  });

  it('counts instead of refusing in OBSERVE mode', async () => {
    store.organization[0]!.securityControlModes = { CSRF_TOKEN: 'OBSERVE' };
    const mine = await signIn();
    const res = await call('POST', '/auth/sessions/revoke-all', { cookie: mine.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(observedCounts('CSRF_TOKEN')).toHaveLength(1);
    expect(observedCounts('CSRF_TOKEN')[0]!.metadata).toMatchObject({
      control: 'CSRF_TOKEN',
      method: 'POST',
      path: '/sessions/revoke-all',
    });
  });
});

// ─── 5. Email verification ──────────────────────────────────────────────────

describe('proving the address', () => {
  it('issues a token at signup and sends it through the one send policy', async () => {
    const res = await call('POST', '/auth/signup', {
      body: {
        email: 'new@example.test',
        password: 'a long enough password here',
        name: 'New Person',
        orgName: 'New Org',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.emailVerification).toEqual({ sent: true, delivery: 'console' });

    const issued = store.verificationToken.filter((t) => t.purpose === 'EMAIL_VERIFY');
    expect(issued).toHaveLength(1);
    expect(h.mails).toHaveLength(1);
    // The row holds the HASH; the mail holds the link. Nothing holds both.
    expect(String(h.mails[0]!.text)).toContain('https://app.qaai.test/verify-email?token=');
    expect(issued[0]!.tokenHash).not.toBe(
      String(h.mails[0]!.text).match(/token=([^\s]+)/)![1],
    );
  });

  it('records the fact when the link is redeemed, and only once', async () => {
    store.user[0]!.emailVerified = null;
    const { cookie, csrf } = await signIn();
    await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} });
    const token = String(h.mails.at(-1)!.text).match(/token=([^\s]+)/)![1]!;

    const first = await call('POST', '/auth/verify-email', { body: { token } });
    expect(first.status).toBe(200);
    expect(store.user[0]!.emailVerified).not.toBeNull();

    const second = await call('POST', '/auth/verify-email', { body: { token } });
    // Single use. The update IS the lock, so two concurrent uses of one link
    // cannot both succeed.
    expect(second.status).toBe(400);
  });

  it('answers the same for a token that never existed, is spent, or has expired', async () => {
    store.user[0]!.emailVerified = null;
    const { cookie, csrf } = await signIn();
    await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} });
    const token = String(h.mails.at(-1)!.text).match(/token=([^\s]+)/)![1]!;

    const unknown = await call('POST', '/auth/verify-email', { body: { token: 'never-issued' } });
    clock += 25 * 3_600_000;
    const expired = await call('POST', '/auth/verify-email', { body: { token } });
    expect(unknown.status).toBe(expired.status);
    expect(unknown.body).toEqual(expired.body);
  });

  it('RATE-LIMITS the resend, because a mail endpoint with no limit is a relay', async () => {
    store.user[0]!.emailVerified = null;
    const { cookie, csrf } = await signIn();

    expect((await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} })).status).toBe(200);
    const again = await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} });
    // 429 and a wait, not a silent success: an action that reports "sent" and
    // does nothing is the failure this codebase keeps producing.
    expect(again.status).toBe(429);
    expect(h.mails).toHaveLength(1);

    clock += 6 * 60_000;
    expect((await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} })).status).toBe(200);
    expect(h.mails).toHaveLength(2);
  });

  it('invalidates an earlier unused link when a new one is asked for', async () => {
    store.user[0]!.emailVerified = null;
    const { cookie, csrf } = await signIn();
    await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} });
    const old = String(h.mails.at(-1)!.text).match(/token=([^\s]+)/)![1]!;
    clock += 6 * 60_000;
    await call('POST', '/auth/verify-email/resend', { cookie, csrf, body: {} });

    // Otherwise every message ever sent stays live until it expires, so one
    // leaked old email is enough.
    expect((await call('POST', '/auth/verify-email', { body: { token: old } })).status).toBe(400);
  });

  it('the EMAIL_VERIFICATION brake admits and counts by default, and refuses in ENFORCE', async () => {
    store.user[0]!.emailVerified = null;

    // Default is OBSERVE: enforcing would lock out the whole installed base,
    // because nothing has ever written this column for a password account.
    const observed = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(observed.status).toBe(200);
    expect(attemptsWith('EMAIL_UNVERIFIED')).toHaveLength(1);
    expect(observedCounts('EMAIL_VERIFICATION')).toHaveLength(1);

    store.organization[0]!.securityControlModes = { EMAIL_VERIFICATION: 'ENFORCE' };
    const enforced = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(enforced.status).toBe(403);
    expect(enforced.body.error.message).toContain('Confirm your email address');
  });
});

// ─── 6. Enforce-SSO ─────────────────────────────────────────────────────────

describe('an organisation that refuses password login', () => {
  beforeEach(() => {
    store.organization[0]!.enforceSso = true;
    store.ssoConnection.push({
      id: 'sso_1',
      orgId: ORG,
      protocol: 'OIDC',
      name: 'Okta',
      ...CREATE_DEFAULTS.ssoConnection,
      createdAt: new Date(clock),
    });
  });

  it('REFUSES the password, which `enforceSso` never did before — it had no reader', async () => {
    store.membership[0]!.role = 'MEMBER';
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This organization signs in through its identity provider.');
    expect(attemptsWith('SSO_REQUIRED')).toHaveLength(1);
  });

  it('BREAK-GLASS 1: lets the password through when NO connection is enabled', async () => {
    store.membership[0]!.role = 'MEMBER';
    store.ssoConnection[0]!.enabled = false;
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    // Covers the org that set the flag before configuring SSO, and the one
    // whose only connection was disabled — including by us, on a certificate
    // rotation. An attacker cannot reach this door: reaching it would mean
    // already holding the authority to disable the connection.
    expect(res.status).toBe(200);
    expect(h.audits.filter((a) => a.action === 'auth.sso.break_glass')).toHaveLength(1);
    expect(h.audits.find((a) => a.action === 'auth.sso.break_glass')!.metadata).toMatchObject({
      door: 'NO_ENABLED_SSO_CONNECTION',
    });
  });

  it('BREAK-GLASS 2: an OWNER with a CONFIRMED second factor gets in', async () => {
    enableTotp(true);
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode() },
    });
    // If the IdP itself is down, door 1 does not open and the organisation is
    // genuinely stranded. An attacker holding only the password does not reach
    // this; one holding both has the IdP too.
    expect(res.status).toBe(200);
    expect(h.audits.find((a) => a.action === 'auth.sso.break_glass')!.metadata).toMatchObject({
      door: 'OWNER_WITH_SECOND_FACTOR',
    });
  });

  it('does NOT open door 2 for an OWNER with no confirmed factor', async () => {
    enableTotp(false);
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(403);
  });

  it('does NOT open door 2 for a non-OWNER who has a confirmed factor', async () => {
    store.membership[0]!.role = 'ADMIN';
    enableTotp(true);
    const res = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, totpCode: currentCode() },
    });
    expect(res.status).toBe(403);
  });

  it('admits and counts in OBSERVE mode', async () => {
    store.membership[0]!.role = 'MEMBER';
    store.organization[0]!.securityControlModes = { ENFORCE_SSO: 'OBSERVE' };
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(observedCounts('ENFORCE_SSO')).toHaveLength(1);
  });
});

// ─── 7. Enrolment ───────────────────────────────────────────────────────────

describe('enrolling in TOTP', () => {
  it('needs TWO steps, and the second one needs a code that verifies', async () => {
    const { cookie, csrf } = await signIn();

    const started = await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });
    expect(started.status).toBe(200);
    expect(started.body.confirmed).toBe(false);
    // Started and not confirmed: the login path treats this row as NOT
    // ENROLLED, so a user who abandons the flow is never locked out.
    expect(store.user[0]!.totpEnabledAt).not.toBeNull();
    expect(store.user[0]!.totpConfirmedAt).toBeNull();

    const secret = String(started.body.secret);
    const code = totpCodeAt(secret, stepAt(clock))!;

    const wrong = await call('POST', '/auth/totp/confirm', {
      cookie,
      csrf,
      body: { code: String((Number(code) + 7) % 1_000_000).padStart(6, '0') },
    });
    expect(wrong.status).toBe(400);
    expect(store.user[0]!.totpConfirmedAt).toBeNull();

    const right = await call('POST', '/auth/totp/confirm', { cookie, csrf, body: { code } });
    expect(right.status).toBe(200);
    expect(store.user[0]!.totpConfirmedAt).not.toBeNull();
    expect(right.body.recoveryCodes).toHaveLength(10);
  });

  it('seals the seed and writes the KEY VERSION beside it', async () => {
    const { cookie, csrf } = await signIn();
    const started = await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });

    const row = store.user[0]!;
    // Sealed, not stored: the column has always said `Enc` and the version
    // column is what lets a rotation sweep ever visit it.
    expect(row.totpSecretEnc).not.toBe(started.body.secret);
    expect(row.totpSecretKeyVersion).toBe(1);
  });

  it('NEVER PUTS THE SEED OR THE QR PAYLOAD IN AN AUDIT ENTRY OR A LOG', async () => {
    const { cookie, csrf } = await signIn();
    const started = await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });
    const secret = String(started.body.secret);
    const url = String(started.body.otpauthUrl);

    const code = totpCodeAt(secret, stepAt(clock))!;
    const confirmed = await call('POST', '/auth/totp/confirm', { cookie, csrf, body: { code } });
    const recovery = confirmed.body.recoveryCodes as string[];

    const everything = JSON.stringify({ audits: h.audits, logs: h.logs });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(url);
    for (const value of recovery) expect(everything).not.toContain(value);
    expect(everything).not.toContain(code);
    // The audit entries that DO exist say what happened without quoting it.
    expect(h.audits.map((a) => a.action)).toContain('user.totp.confirmed');
    expect(h.audits.find((a) => a.action === 'user.totp.confirmed')!.metadata).toEqual({
      recoveryCodes: 10,
    });
  });

  it('refuses to re-enrol over a working factor', async () => {
    enableTotp(true);
    const { cookie, csrf } = await signIn({ totpCode: currentCode() });
    const res = await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });
    // Replacing a working factor with an unconfirmed one would leave the user
    // with neither.
    expect(res.status).toBe(409);
  });

  it('refuses a confirmation with no code at all, through the schema', async () => {
    const { cookie, csrf } = await signIn();
    await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });
    const res = await call('POST', '/auth/totp/confirm', { cookie, csrf, body: {} });
    expect(res.status).toBe(400);
    // The path, never the zod message: a message quotes the offending value.
    expect(JSON.stringify(res.body)).toContain('code');
  });
});

describe('recovery codes', () => {
  /** Enrol for real, and keep the seed the route minted — not the fixture's. */
  async function enrol(): Promise<{
    cookie: string;
    csrf: string;
    secret: string;
    codes: string[];
  }> {
    const { cookie, csrf } = await signIn();
    const started = await call('POST', '/auth/totp/enrol', { cookie, csrf, body: {} });
    const secret = String(started.body.secret);
    const code = totpCodeAt(secret, stepAt(clock))!;
    const confirmed = await call('POST', '/auth/totp/confirm', { cookie, csrf, body: { code } });
    if (confirmed.status !== 200) {
      throw new Error(`enrolment failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
    }
    return { cookie, csrf, secret, codes: confirmed.body.recoveryCodes as string[] };
  }

  it('are stored as hashes only', async () => {
    const { codes } = await enrol();
    expect(store.totpRecoveryCode).toHaveLength(10);
    for (const row of store.totpRecoveryCode) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      for (const code of codes) expect(row.codeHash).not.toContain(code);
    }
  });

  it('WORK ONCE, and the second use is refused', async () => {
    const { codes } = await enrol();
    clock += 60_000;

    const first = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, recoveryCode: codes[0] },
    });
    expect(first.status).toBe(200);
    expect(store.totpRecoveryCode.filter((r) => r.usedAt !== null)).toHaveLength(1);

    const second = await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, recoveryCode: codes[0] },
    });
    // A code that works twice is a code that is not single-use.
    expect(second.status).toBe(401);
  });

  it('records where one was redeemed from, for the incident review that follows', async () => {
    const { codes } = await enrol();
    clock += 60_000;
    await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, recoveryCode: codes[1] },
    });
    const used = store.totpRecoveryCode.find((r) => r.usedAt !== null)!;
    expect(used.usedFromIp).not.toBeUndefined();
  });

  it('are counted, never returned, by /auth/me', async () => {
    const { cookie, codes } = await enrol();
    clock += 60_000;
    await call('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD, recoveryCode: codes[2] },
    });

    const me = await call('GET', '/auth/me', { cookie });
    expect(me.body.user.twoFactor.recoveryCodesRemaining).toBe(9);
    // "Three of your ten codes are gone" is the fact a person acts on. The
    // codes themselves are never retrievable after the response that minted
    // them.
    for (const code of codes) expect(JSON.stringify(me.body)).not.toContain(code);
  });

  it('are REPLACED WHOLESALE on a re-mint, so an old printout stops working', async () => {
    const { cookie, csrf, secret, codes } = await enrol();
    const before = store.totpRecoveryCode.map((r) => r.codeHash);

    // A new step, because the confirm above spent the current one.
    clock += 60_000;
    const minted = await call('POST', '/auth/totp/recovery-codes', {
      cookie,
      csrf,
      body: { code: totpCodeAt(secret, stepAt(clock))! },
    });
    expect(minted.status).toBe(200);
    expect(minted.body.recoveryCodes).toHaveLength(10);

    expect(store.totpRecoveryCode).toHaveLength(10);
    // Left beside the new ones, a printout the user threw away would still
    // work — a credential nobody is tracking.
    for (const hash of before) {
      expect(store.totpRecoveryCode.some((r) => r.codeHash === hash)).toBe(false);
    }
    for (const old of codes) {
      expect(store.totpRecoveryCode.some((r) => r.codeHash === hashRecoveryCode(old))).toBe(false);
    }
  });

  it('a re-mint needs a working code, not just a session', async () => {
    const { cookie, csrf, secret } = await enrol();
    clock += 60_000;
    const res = await call('POST', '/auth/totp/recovery-codes', {
      cookie,
      csrf,
      body: { code: String((Number(totpCodeAt(secret, stepAt(clock))!) + 3) % 1_000_000).padStart(6, '0') },
    });
    expect(res.status).toBe(400);
  });
});

// ─── 8. Failing closed, and reporting honestly, when a read does not work ──

describe('when something underneath does not answer', () => {
  it('REFUSES the login when the membership\'s organisation cannot be read', async () => {
    // Prisma types the relation as non-null and in a consistent database it is.
    // A cascade mid-flight or a lagging replica makes it null, and the four
    // brakes below read their stored mode off this object — so without the
    // guard this is a TypeError and a 500, where every other refusal on the
    // route is a 401. A crash AND a difference an attacker can observe.
    store.organization = [];
    const res = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('This account is not a member of any organization');
  });

  it('REPORTS `sent: false` when the verification token could not be written', async () => {
    const broken = makeDb(store);
    broken.verificationToken = {
      ...(broken.verificationToken as Row),
      create: async () => {
        throw new Error('fake prisma: verificationToken.create refused');
      },
    };
    h.prisma = broken;

    const res = await call('POST', '/auth/signup', {
      body: {
        email: 'another@example.test',
        password: 'a long enough password here',
        name: 'Another',
        orgName: 'Another Org',
      },
    });

    // The account was committed, so the signup succeeded and says so…
    expect(res.status).toBe(201);
    // …and the verification is reported as what it is, rather than a `true`
    // compiled from "we called the function". The screen must not say "check
    // your email" for a link that was never minted.
    expect(res.body.emailVerification).toEqual({ sent: false, delivery: 'console' });
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('REPORTS NULL, NEVER ZERO, when the recovery-code count cannot be read', async () => {
    enableTotp(true);
    const { cookie } = await signIn({ totpCode: currentCode() });

    const broken = makeDb(store);
    broken.totpRecoveryCode = {
      ...(broken.totpRecoveryCode as Row),
      count: async () => {
        throw new Error('fake prisma: totpRecoveryCode.count refused');
      },
    };
    h.prisma = broken;

    const me = await call('GET', '/auth/me', { cookie });
    expect(me.status).toBe(200);
    // Zero reads as "mint more codes"; null reads as "we could not tell you",
    // which is the truth. A number reported as measured that was not measured
    // is the lie this product cannot afford, and a security page is the worst
    // place for one.
    expect(me.body.user.twoFactor.recoveryCodesRemaining).toBeNull();
  });
});

// ─── 8. Rule 11, as a sweep over the error paths ────────────────────────────

describe('no credential reaches a response, an audit entry or a log', () => {
  it('holds across every refusal the login path can produce', async () => {
    enableTotp(true);
    const code = wrongCode();

    const responses = [
      await call('POST', '/auth/login', { body: { email: EMAIL, password: 'the wrong one' } }),
      await call('POST', '/auth/login', { body: { email: NO_SUCH_EMAIL, password: PASSWORD } }),
      await call('POST', '/auth/login', {
        body: { email: EMAIL, password: PASSWORD, totpCode: code },
      }),
      await call('POST', '/auth/login', {
        body: { email: EMAIL, password: PASSWORD, recoveryCode: 'ABCDE-FGHJK' },
      }),
      await call('POST', '/auth/password/reset', {
        body: { token: 'a-token-that-was-never-issued', password: 'long enough to pass' },
      }),
    ];

    const everything = JSON.stringify({ responses, audits: h.audits, logs: h.logs });
    for (const secret of [
      PASSWORD,
      'the wrong one',
      code,
      'ABCDE-FGHJK',
      'a-token-that-was-never-issued',
      SEED,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('never writes an identifier in the clear to the attempt log', async () => {
    await call('POST', '/auth/login', { body: { email: NO_SUCH_EMAIL, password: 'nope' } });
    const serialised = JSON.stringify(store.loginAttempt);
    // The table must not become a readable list of the addresses somebody is
    // walking. The digest is a KEY and not anonymisation, and the column says
    // so — what it buys is that the table cannot be READ as a list.
    expect(serialised).not.toContain(NO_SUCH_EMAIL);
    expect(serialised).toContain(throttleKey('email', NO_SUCH_EMAIL));
  });
});
