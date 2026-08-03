/**
 * Tests for the account cluster: invite acceptance, password reset, and member
 * management.
 *
 * These three features share one property that makes them worth a file of their
 * own — every one of their failure modes is SILENT. An invite that drops the
 * recipient into a private organisation of their own still returns 201 and still
 * signs them in; a reset link that works twice still says `{ ok: true }`; a demoted
 * last OWNER still gets a green toast. Nothing errors, nothing is logged, and the
 * customer finds out weeks later when they cannot see the runs their colleague
 * made or cannot administer their own account. So the assertions below are
 * written the pessimistic way round: most of them assert a REFUSAL, and the happy
 * paths exist mainly to prove the refusals are not vacuous.
 *
 * The single most important test in this file is
 * "joins the inviting org at the invited role, and creates no new org". That is
 * the bug being fixed: `POST /settings/invites` had always minted a
 * `…/signup?invite=<token>` link, and signup unconditionally created a fresh
 * organisation, so every invited teammate landed alone. `Invite.acceptedAt` was
 * never written by any code path. Nothing about that is observable from a status
 * code, which is why the org-table count is asserted directly.
 *
 * ─── Why this one runs the routers, when every other test here is pure ───────
 *
 * apps/api's existing suites (sso, ownership, concurrency, metrics…) are unit
 * tests over pure helpers, because that is where those decisions live. The
 * decisions being tested here do not: "which org does this membership go in",
 * "is this token still burnable", "is this the last OWNER" are all expressed as
 * Prisma calls inside route handlers, and there is no seam above them to test.
 * Rewriting the routes to create one would be a larger and riskier change than
 * the feature itself.
 *
 * So this follows the pattern apps/worker/src/processors/retention.test.ts
 * already established for prisma-shaped logic: mock the module that owns the
 * client, hand the real code a narrow in-memory stand-in, and drive the real
 * exported thing. The only difference is that the exported thing here is an
 * Express Router, so it is mounted and driven over a loopback socket rather than
 * called directly. Nothing else about the setup is new — no database, no
 * container, no fixtures on disk.
 *
 * The stand-in deliberately THROWS on any filter it does not implement. A fake
 * that quietly ignores `usedAt: null` would pass the single-use tests while the
 * product handed out reusable reset links.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signupSchema } from '@qaai/shared';
import { hashToken } from '../lib/crypto.js';

/**
 * `any` is off for test files by policy (see eslint.config.js). It is used for
 * exactly two things here — parsed JSON response bodies and in-memory rows —
 * because writing a Prisma row type by hand would be a second copy of the schema
 * that can drift from it.
 */
type Row = Record<string, any>;

interface Hoisted {
  /** Swapped per test; reached through the Proxy the prisma mock returns. */
  prisma: Record<string, unknown>;
  /** Assigned by the prisma mock factory, which owns the tenant AsyncLocalStorage. */
  currentOrg: () => string | null;
  mail: {
    driver: 'smtp' | 'console';
    /** Set to make sendMail throw, which is how a real SMTP refusal arrives. */
    fail: boolean;
    sent: Array<{ to: string; subject: string; text: string }>;
  };
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    mail: { driver: 'console', fail: false, sent: [] },
  }),
);

/*
 * env.ts calls process.exit(1) on a bad environment and reads the repo-root
 * .env, so a developer's local file would decide what these tests see. Only four
 * values are read by anything in this import graph.
 */
vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_TTL_HOURS: 72,
    WEB_PUBLIC_URL: 'https://app.qaai.test',
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
 * The tenancy scope is real, not stubbed. requireAuth opens it with
 * `withTenant(orgId, () => next())` and the handlers' queries run in the async
 * continuation of that call — a plain variable would be restored before they
 * ran, so GET /settings/invites would appear to leak across orgs (or not) for
 * reasons that had nothing to do with the route.
 */
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
 * The message BODIES are the real ones — the reset token exists nowhere else
 * once the route returns, so the tests recover it the same way an operator
 * reading the API log would. Only the transport is replaced.
 */
vi.mock('../lib/mail.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/mail.js')>('../lib/mail.js');
  return {
    ...actual,
    mailDriver: () => h.mail.driver,
    sendMail: async (mail: { to: string; subject: string; text: string }) => {
      if (h.mail.fail) throw new Error('SMTP connection refused');
      h.mail.sent.push(mail);
      return { driver: h.mail.driver, delivered: h.mail.driver === 'smtp' };
    },
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'user',
  'organization',
  'membership',
  'session',
  'invite',
  'verificationToken',
  'auditLog',
] as const;

type ModelName = (typeof MODELS)[number];

/** The compound uniques these routes look rows up by. */
const COMPOUND: Record<string, string[]> = {
  orgId_userId: ['orgId', 'userId'],
  orgId_email: ['orgId', 'email'],
};

function flatten(where: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (COMPOUND[key]) Object.assign(out, value);
    else out[key] = value;
  }
  return out;
}

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(flatten(where))) {
    if (key === 'NOT') {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (cond && typeof cond === 'object') {
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
    else if (value && typeof value === 'object') {
      const nested = row[key] as Row | null | undefined;
      out[key] = nested ? project(nested, (value as Row).select as Row) : null;
    }
  }
  return out;
}

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

interface ModelOptions {
  /**
   * Org-owned, so the tenancy extension filters and stamps it. Organization is
   * NOT in this set: the real extension scopes it by `id` rather than `orgId`,
   * and every route here already names the id it wants.
   */
  scoped?: boolean;
  defaults?: Row;
  hydrate?: (row: Row) => Row;
  onCreate?: (row: Row, nested: Row) => void;
}

const MODEL_OPTIONS: Record<ModelName, ModelOptions> = {
  user: {
    defaults: {
      emailVerified: null,
      // Explicitly null, not absent: /password/forgot distinguishes an SSO
      // account from a password one with `passwordHash !== null`, and `undefined`
      // would pass that check and hand an SSO user a password.
      passwordHash: null,
      avatarUrl: null,
      isSuperuser: false,
      totpSecretEnc: null,
      totpEnabledAt: null,
      lastLoginAt: null,
    },
  },
  organization: { defaults: { plan: 'FREE', limitOverrides: null } },
  membership: { scoped: true, defaults: { role: 'MEMBER' } },
  session: {
    defaults: { activeOrgId: null, ip: null, userAgent: null, revokedAt: null },
  },
  invite: { scoped: true, defaults: { role: 'MEMBER', acceptedAt: null } },
  verificationToken: { defaults: { usedAt: null } },
  auditLog: { scoped: true, defaults: {} },
};

/** Ordering is asserted (`orderBy: createdAt`), so the clock must not tie. */
const CLOCK_BASE = new Date('2026-07-01T00:00:00.000Z').getTime();

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;
  let ticks = 0;

  const makeModel = (name: ModelName) => {
    const opts = MODEL_OPTIONS[name];
    const rows = () => tables[name];

    const scope = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return opts.scoped && orgId ? { ...where, orgId } : where;
    };

    const find = (where: Row = {}, orderBy?: Row): Row[] =>
      sortRows(
        rows().filter((r) => matches(r, scope(where))),
        orderBy,
      );

    const read = (row: Row | undefined, select?: Row): Row | null =>
      row ? project(opts.hydrate ? opts.hydrate(row) : row, select) : null;

    const insert = (data: Row): Row => {
      const nested: Row = {};
      const scalar: Row = {};
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && !(value instanceof Date) && 'create' in value) {
          nested[key] = (value as Row).create;
        } else {
          scalar[key] = value;
        }
      }
      const orgId = h.currentOrg();
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: new Date(CLOCK_BASE + ticks++),
        ...opts.defaults,
        ...(opts.scoped && orgId && scalar.orgId === undefined ? { orgId } : {}),
        ...scalar,
      };
      rows().push(row);
      opts.onCreate?.(row, nested);
      return row;
    };

    return {
      findUnique: async ({ where, select }: Row) => read(find(where)[0], select),
      findFirst: async ({ where, select, orderBy }: Row = {}) =>
        read(find(where, orderBy)[0], select),
      findMany: async ({ where, select, orderBy, take }: Row = {}) => {
        const list = find(where, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) => read(r, select));
      },
      create: async ({ data, select }: Row) => read(insert(data), select),
      update: async ({ where, data, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data);
        return read(row, select);
      },
      updateMany: async ({ where, data }: Row = {}) => {
        const list = find(where);
        for (const row of list) Object.assign(row, data);
        return { count: list.length };
      },
      delete: async ({ where }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.delete matched no row`);
        rows().splice(rows().indexOf(row), 1);
        return row;
      },
      upsert: async ({ where, create, update, select }: Row) => {
        const row = find(where)[0];
        if (row) {
          Object.assign(row, update);
          return read(row, select);
        }
        return read(insert(create), select);
      },
    };
  };

  MODEL_OPTIONS.invite.hydrate = (row) => ({
    ...row,
    org: tables.organization.find((o) => o.id === row.orgId) ?? null,
  });
  MODEL_OPTIONS.organization.onCreate = (row, nested) => {
    // `memberships: { create: … }` in signup's org branch.
    if (nested.memberships) {
      tables.membership.push({
        id: `membership_${++ids}`,
        createdAt: new Date(CLOCK_BASE + ticks++),
        orgId: row.id,
        ...nested.memberships,
      });
    }
  };

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);

  /*
   * Rollback matters here rather than being decoration: signup's invite branch
   * creates the user and THEN discovers the invite was consumed under it, and a
   * surviving orphan user turns the retry into "an account with that email
   * already exists" — a different bug, hiding the one being tested.
   */
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = MODELS.map((m) => [m, tables[m].map((r) => ({ ...r }))] as const);
    try {
      return await fn(client);
    } catch (err) {
      for (const [name, saved] of snapshot) {
        tables[name].length = 0;
        tables[name].push(...saved);
      }
      throw err;
    }
  };

  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { authRouter } = await import('./auth.js');
const { settingsRouter } = await import('./settings.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/settings', settingsRouter);
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
  setCookie: string | null;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Reply> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Row) : {},
    setCookie: res.headers.get('set-cookie'),
  };
}

const cookieFrom = (setCookie: string | null): string => {
  const match = /qaai_session=([^;]+)/.exec(setCookie ?? '');
  return match ? `qaai_session=${match[1]}` : '';
};

/** The reset token exists only in the mail body; this is how a user gets it. */
const tokenFromLastMail = (): string => {
  const last = h.mail.sent.at(-1);
  const match = /[?&]token=([^\s&]+)/.exec(last?.text ?? '');
  if (!match) throw new Error('no link in the last message');
  return match[1]!;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof makeDb>;

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-different-long-one';

let idSeq = 0;
const fixtureId = (prefix: string) => `${prefix}_fixture_${++idSeq}`;

function seedOrg(name: string): Row {
  const org = {
    id: fixtureId('org'),
    name,
    slug: name.toLowerCase(),
    plan: 'FREE',
    limitOverrides: null,
    createdAt: new Date(CLOCK_BASE),
  };
  db.tables.organization.push(org);
  return org;
}

function seedUser(email: string, over: Row = {}): Row {
  const user = {
    id: fixtureId('user'),
    email,
    name: email.split('@')[0],
    passwordHash: null,
    emailVerified: null,
    avatarUrl: null,
    isSuperuser: false,
    totpSecretEnc: null,
    totpEnabledAt: null,
    lastLoginAt: null,
    createdAt: new Date(CLOCK_BASE),
    ...over,
  };
  db.tables.user.push(user);
  return user;
}

function seedMember(orgId: string, userId: string, role: string): Row {
  const membership = {
    id: fixtureId('membership'),
    orgId,
    userId,
    role,
    createdAt: new Date(CLOCK_BASE + db.tables.membership.length),
  };
  db.tables.membership.push(membership);
  return membership;
}

/**
 * A session is faked exactly the way one is minted: a row keyed by the SHA-256
 * of the cookie value. Nothing about the middleware is stubbed, so a test that
 * passes here proves the real requireAuth path accepted the caller.
 */
function seedSession(userId: string, orgId: string, raw = fixtureId('session-token')): string {
  db.tables.session.push({
    id: fixtureId('session'),
    userId,
    tokenHash: hashToken(raw),
    activeOrgId: orgId,
    ip: null,
    userAgent: null,
    expiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
    createdAt: new Date(CLOCK_BASE),
  });
  return `qaai_session=${raw}`;
}

function seedInvite(over: Row & { orgId: string; email: string }): string {
  const raw = fixtureId('invite-token');
  db.tables.invite.push({
    id: fixtureId('invite'),
    role: 'MEMBER',
    tokenHash: hashToken(raw),
    invitedBy: 'user_inviter',
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    acceptedAt: null,
    createdAt: new Date(CLOCK_BASE),
    ...over,
  });
  return raw;
}

const signupBody = (over: Row = {}): Row => ({
  email: 'dana@acme-corp.test',
  password: PASSWORD,
  name: 'Dana Scully',
  ...over,
});

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.mail.driver = 'console';
  h.mail.fail = false;
  h.mail.sent = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// The signup union
// ─────────────────────────────────────────────────────────────────────────────

describe('signupSchema', () => {
  it('accepts the org-creating shape', () => {
    const parsed = signupSchema.parse(signupBody({ orgName: 'Acme' }));
    expect(parsed).toMatchObject({ email: 'dana@acme-corp.test', orgName: 'Acme' });
  });

  it('accepts the invite shape', () => {
    expect(signupSchema.parse(signupBody({ invite: 'raw-token' }))).toMatchObject({
      invite: 'raw-token',
    });
  });

  it('refuses both an orgName and an invite', () => {
    // Not pedantry: with both accepted, whichever the handler happened to check
    // first would silently win, and the field the caller meant would do nothing.
    expect(signupSchema.safeParse(signupBody({ orgName: 'Acme', invite: 'tok' })).success).toBe(
      false,
    );
  });

  it('refuses neither', () => {
    expect(signupSchema.safeParse(signupBody()).success).toBe(false);
  });

  it('refuses an unknown key, in both shapes', () => {
    // .strict() is what stops `{ …, role: 'OWNER' }` being accepted-and-ignored.
    expect(signupSchema.safeParse(signupBody({ orgName: 'Acme', role: 'OWNER' })).success).toBe(
      false,
    );
    expect(signupSchema.safeParse(signupBody({ invite: 'tok', orgId: 'org_1' })).success).toBe(
      false,
    );
  });

  it('refuses an explicit null for the branch it is not taking', () => {
    /*
     * JSON has no `undefined`, so a client that always sends the whole form
     * object nulls the unused field — and `z.undefined().optional()` refuses
     * null. The web client must OMIT the key, not null it. Pinned here because
     * the failure is a 400 on the happy path, in a field the user never filled.
     */
    expect(signupSchema.safeParse(signupBody({ orgName: 'Acme', invite: null })).success).toBe(
      false,
    );
    expect(signupSchema.safeParse(signupBody({ invite: 'tok', orgName: null })).success).toBe(false);
  });

  it('holds the password and token floors', () => {
    expect(signupSchema.safeParse(signupBody({ orgName: 'Acme', password: 'short' })).success).toBe(
      false,
    );
    expect(signupSchema.safeParse(signupBody({ invite: '' })).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading an invite before signing up
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /auth/invite', () => {
  it('names the org and the role the link is for', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test', role: 'ADMIN' });

    const res = await call('GET', `/auth/invite?token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: true,
      email: 'dana@acme-corp.test',
      role: 'ADMIN',
      org: { name: 'Acme' },
    });
  });

  it('refuses an expired link with the wording the signup screen shows', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({
      orgId: org.id,
      email: 'dana@acme-corp.test',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await call('GET', `/auth/invite?token=${token}`);

    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      valid: false,
      reason: 'That invitation has expired. Ask for a new one.',
    });
  });

  it('refuses a link that has already been used', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({
      orgId: org.id,
      email: 'dana@acme-corp.test',
      acceptedAt: new Date(),
    });

    const res = await call('GET', `/auth/invite?token=${token}`);

    expect(res.status).toBe(410);
    expect(res.body.reason).toBe('That invitation has already been used.');
  });

  it('refuses an unknown token, and requires one at all', async () => {
    expect((await call('GET', '/auth/invite?token=nope')).status).toBe(410);
    expect((await call('GET', '/auth/invite')).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signing up — the bug this cluster exists to fix
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/signup with an invite', () => {
  it('joins the INVITING org at the INVITED role, and creates no new org', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test', role: 'ADMIN' });

    const res = await call('POST', '/auth/signup', {
      body: signupBody({ invite: token }),
    });

    expect(res.status).toBe(201);
    // The whole feature, in three assertions: the right org, the right role, and
    // — the part that used to be wrong — no second organisation.
    expect(res.body.org.id).toBe(org.id);
    expect(res.body.org.name).toBe('Acme');
    expect(res.body.org.role).toBe('ADMIN');
    expect(db.tables.organization).toHaveLength(1);

    const membership = db.tables.membership.find((m) => m.orgId === org.id);
    expect(membership).toMatchObject({ orgId: org.id, role: 'ADMIN' });
    expect(membership!.userId).toBe(res.body.user.id);
  });

  it('signs the new member into the org they joined', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test', role: 'MEMBER' });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    const session = db.tables.session[0];
    expect(session!.activeOrgId).toBe(org.id);
    // Proven end-to-end rather than by reading the row: the cookie works.
    const me = await call('GET', '/auth/me', { cookie: cookieFrom(res.setCookie) });
    expect(me.status).toBe(200);
    expect(me.body.activeOrgId).toBe(org.id);
  });

  it('marks the invite accepted', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test' });

    await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    // Never written by any code path before this feature landed.
    expect(db.tables.invite[0]!.acceptedAt).toBeInstanceOf(Date);
  });

  it('refuses an invite addressed to somebody else', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test', role: 'ADMIN' });

    // Without this check the link is a bearer token for a seat in the org:
    // whoever opens it signs up as themselves and takes the ADMIN role.
    const res = await call('POST', '/auth/signup', {
      body: signupBody({ email: 'mallory@evil.test', invite: token }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('dana@acme-corp.test');
    expect(db.tables.user).toHaveLength(0);
    expect(db.tables.membership).toHaveLength(0);
  });

  it('matches the address case-insensitively', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'Dana@Acme-Corp.test', role: 'MEMBER' });

    const res = await call('POST', '/auth/signup', {
      body: signupBody({ email: 'DANA@acme-corp.TEST', invite: token }),
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('dana@acme-corp.test');
  });

  it('refuses an expired invite', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({
      orgId: org.id,
      email: 'dana@acme-corp.test',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That invitation has expired. Ask for a new one.');
    expect(db.tables.user).toHaveLength(0);
  });

  it('refuses an invite that was already accepted', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({
      orgId: org.id,
      email: 'dana@acme-corp.test',
      acceptedAt: new Date(),
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That invitation has already been used.');
  });

  it('cannot be used twice', async () => {
    const org = seedOrg('Acme');
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test', role: 'ADMIN' });

    expect((await call('POST', '/auth/signup', { body: signupBody({ invite: token }) })).status).toBe(
      201,
    );

    // A DIFFERENT address, so this gets past the duplicate-account check and
    // actually reaches the invite. Same token: it must be spent.
    const second = await call('POST', '/auth/signup', {
      body: signupBody({ email: 'walter@acme-corp.test', invite: token }),
    });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toBe('That invitation has already been used.');

    expect(db.tables.membership).toHaveLength(1);
    expect(db.tables.user).toHaveLength(1);

    // And the pre-signup lookup agrees, so the screen says why.
    const lookup = await call('GET', `/auth/invite?token=${token}`);
    expect(lookup.status).toBe(410);
    expect(lookup.body.reason).toBe('That invitation has already been used.');
  });

  it('refuses an invite for an address that already has an account', async () => {
    const org = seedOrg('Acme');
    seedUser('dana@acme-corp.test', { passwordHash: 'scrypt$x' });
    const token = seedInvite({ orgId: org.id, email: 'dana@acme-corp.test' });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(res.status).toBe(409);
    expect(db.tables.invite[0]!.acceptedAt).toBeNull();
  });
});

describe('POST /auth/signup without an invite', () => {
  it('creates the org and makes the caller its OWNER', async () => {
    const res = await call('POST', '/auth/signup', { body: signupBody({ orgName: 'Acme Inc' }) });

    expect(res.status).toBe(201);
    expect(res.body.org).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc', role: 'OWNER' });
    expect(db.tables.membership[0]!.role).toBe('OWNER');
  });

  it('does not hand a second org the same slug', async () => {
    await call('POST', '/auth/signup', { body: signupBody({ orgName: 'Acme' }) });
    const second = await call('POST', '/auth/signup', {
      body: signupBody({ email: 'walter@acme-corp.test', orgName: 'Acme' }),
    });

    // slug is @unique, so a collision is a 500 on somebody's first ever request.
    expect(second.status).toBe(201);
    expect(second.body.org.slug).not.toBe('acme');
    expect(second.body.org.slug.startsWith('acme-')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/password/forgot', () => {
  it('answers a known and an unknown address identically', async () => {
    const org = seedOrg('Acme');
    const user = seedUser('dana@acme-corp.test', { passwordHash: 'scrypt$x' });
    seedMember(org.id, user.id, 'OWNER');

    const known = await call('POST', '/auth/password/forgot', {
      body: { email: 'dana@acme-corp.test' },
    });
    const unknown = await call('POST', '/auth/password/forgot', {
      body: { email: 'nobody@acme-corp.test' },
    });

    /*
     * Byte-identical, not merely both-200. Any difference at all — a field, a
     * word, even ordering — turns this endpoint into a "does this person use
     * QAAI?" oracle that anybody can query for a customer list.
     */
    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
    expect(known.body.ok).toBe(true);

    // …and it really did nothing for the address with no account.
    expect(db.tables.verificationToken).toHaveLength(1);
    expect(db.tables.verificationToken[0]!.email).toBe('dana@acme-corp.test');
    expect(h.mail.sent).toHaveLength(1);
  });

  it('says when the link went to the log instead of an inbox', async () => {
    seedUser('dana@acme-corp.test', { passwordHash: 'scrypt$x' });

    const consoleReply = await call('POST', '/auth/password/forgot', {
      body: { email: 'dana@acme-corp.test' },
    });
    expect(consoleReply.body.delivery).toBe('console');

    h.mail.driver = 'smtp';
    const smtpReply = await call('POST', '/auth/password/forgot', {
      body: { email: 'dana@acme-corp.test' },
    });
    expect(smtpReply.body.delivery).toBe('smtp');

    /*
     * The UI keys off this field. Telling somebody to check their email on a
     * deployment with no mail server is the defect this project keeps fixing,
     * and the message text alone cannot say which happened.
     */
    expect(consoleReply.body.message).toBe(smtpReply.body.message);
  });

  it('gives an SSO account nothing to reset', async () => {
    seedUser('dana@acme-corp.test'); // passwordHash null, as lib/sso.ts creates them

    const res = await call('POST', '/auth/password/forgot', {
      body: { email: 'dana@acme-corp.test' },
    });

    // A second credential for an account the customer's IdP is meant to own
    // exclusively would be a way around their offboarding.
    expect(res.status).toBe(200);
    expect(db.tables.verificationToken).toHaveLength(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('kills the previous unused link when a new one is asked for', async () => {
    seedUser('dana@acme-corp.test', { passwordHash: 'scrypt$x' });

    await call('POST', '/auth/password/forgot', { body: { email: 'dana@acme-corp.test' } });
    const firstToken = tokenFromLastMail();
    await call('POST', '/auth/password/forgot', { body: { email: 'dana@acme-corp.test' } });

    const res = await call('POST', '/auth/password/reset', {
      body: { token: firstToken, password: NEW_PASSWORD },
    });
    // Otherwise every request ever made stays live until it expires, and one
    // leaked old email is enough.
    expect(res.status).toBe(400);
  });

  it('still answers 200 when the mail server refuses', async () => {
    seedUser('dana@acme-corp.test', { passwordHash: 'scrypt$x' });
    h.mail.driver = 'smtp';
    h.mail.fail = true;

    const res = await call('POST', '/auth/password/forgot', {
      body: { email: 'dana@acme-corp.test' },
    });

    // A 500 here would say "this address exists", which is what the uniform
    // response above is for.
    expect(res.status).toBe(200);
    expect(db.tables.verificationToken).toHaveLength(1);
  });
});

describe('POST /auth/password/reset', () => {
  const seedResettableUser = async () => {
    const org = seedOrg('Acme');
    const signup = await call('POST', '/auth/signup', { body: signupBody({ orgName: 'Acme Two' }) });
    const userId = signup.body.user.id as string;
    await call('POST', '/auth/password/forgot', { body: { email: 'dana@acme-corp.test' } });
    return { org, userId, token: tokenFromLastMail(), cookie: cookieFrom(signup.setCookie) };
  };

  it('changes the password, and the old one stops working', async () => {
    const { token } = await seedResettableUser();

    const res = await call('POST', '/auth/password/reset', {
      body: { token, password: NEW_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const withNew = await call('POST', '/auth/login', {
      body: { email: 'dana@acme-corp.test', password: NEW_PASSWORD },
    });
    expect(withNew.status).toBe(200);

    const withOld = await call('POST', '/auth/login', {
      body: { email: 'dana@acme-corp.test', password: PASSWORD },
    });
    expect(withOld.status).toBe(401);
  });

  it('burns the token, so the link works exactly once', async () => {
    const { token } = await seedResettableUser();

    expect(
      (await call('POST', '/auth/password/reset', { body: { token, password: NEW_PASSWORD } }))
        .status,
    ).toBe(200);

    const second = await call('POST', '/auth/password/reset', {
      body: { token, password: 'yet-another-long-one' },
    });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toBe(
      'That reset link is invalid or has expired. Ask for a new one.',
    );

    // The second attempt must not have taken effect either.
    const login = await call('POST', '/auth/login', {
      body: { email: 'dana@acme-corp.test', password: 'yet-another-long-one' },
    });
    expect(login.status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const { token } = await seedResettableUser();
    // A reset link is a password; it must not stay usable in an inbox for a day.
    db.tables.verificationToken[0]!.expiresAt = new Date(Date.now() - 1000);

    const res = await call('POST', '/auth/password/reset', {
      body: { token, password: NEW_PASSWORD },
    });

    expect(res.status).toBe(400);
    expect(db.tables.verificationToken[0]!.usedAt).toBeNull();
  });

  it('refuses a token that is not a password reset, and one that is invented', async () => {
    const { token } = await seedResettableUser();
    db.tables.verificationToken[0]!.purpose = 'EMAIL_VERIFY';

    expect(
      (await call('POST', '/auth/password/reset', { body: { token, password: NEW_PASSWORD } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/auth/password/reset', {
          body: { token: 'made-up', password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(400);
  });

  it('revokes every existing session', async () => {
    const { token, cookie } = await seedResettableUser();

    // The session was live a moment ago.
    expect((await call('GET', '/auth/me', { cookie })).status).toBe(200);

    await call('POST', '/auth/password/reset', { body: { token, password: NEW_PASSWORD } });

    /*
     * If the reset happened because somebody else had the account, leaving their
     * session alive makes the reset pointless — they are still signed in.
     */
    expect((await call('GET', '/auth/me', { cookie })).status).toBe(401);
    expect(db.tables.session.every((s) => s.revokedAt !== null)).toBe(true);
  });
});

describe('POST /auth/password/change', () => {
  it('requires the current password, and keeps this session while cutting the others', async () => {
    const signup = await call('POST', '/auth/signup', { body: signupBody({ orgName: 'Acme' }) });
    const cookie = cookieFrom(signup.setCookie);
    const userId = signup.body.user.id as string;
    const otherDevice = seedSession(userId, signup.body.org.id as string);

    const wrong = await call('POST', '/auth/password/change', {
      cookie,
      body: { currentPassword: 'not-it-at-all', newPassword: NEW_PASSWORD },
    });
    // A borrowed laptop or a stolen cookie must not become permanent ownership.
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe('That is not your current password.');

    const ok = await call('POST', '/auth/password/change', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(ok.status).toBe(200);

    // Signing someone out of the tab they just changed their password in reads
    // as a failure; every other device is the thing worth cutting off.
    expect((await call('GET', '/auth/me', { cookie })).status).toBe(200);
    expect((await call('GET', '/auth/me', { cookie: otherDevice })).status).toBe(401);
  });

  it('is refused without a session', async () => {
    expect(
      (
        await call('POST', '/auth/password/change', {
          body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        })
      ).status,
    ).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

/** An org with one OWNER, plus whoever else the test needs. */
function seedTeam() {
  const org = seedOrg('Acme');
  const owner = seedUser('owner@acme-corp.test', { passwordHash: 'scrypt$x', name: 'Olive Owner' });
  seedMember(org.id, owner.id, 'OWNER');
  return { org, owner, cookie: seedSession(owner.id, org.id) };
}

describe('GET /settings/members', () => {
  it('names everyone in the org, oldest first', async () => {
    const { org, cookie } = seedTeam();
    const member = seedUser('mel@acme-corp.test', { name: 'Mel Member' });
    seedMember(org.id, member.id, 'MEMBER');

    const res = await call('GET', '/settings/members', { cookie });

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).toMatchObject({
      role: 'OWNER',
      email: 'owner@acme-corp.test',
      name: 'Olive Owner',
    });
    expect(res.body.members[1]).toMatchObject({ role: 'MEMBER', email: 'mel@acme-corp.test' });
    expect(res.body.members[1].joinedAt).toBeTruthy();
  });

  it('refuses an anonymous caller', async () => {
    expect((await call('GET', '/settings/members')).status).toBe(401);
  });

  it('does not show one org the other org’s people', async () => {
    const { cookie } = seedTeam();
    const other = seedOrg('Other');
    const stranger = seedUser('stranger@other.test');
    seedMember(other.id, stranger.id, 'OWNER');

    const res = await call('GET', '/settings/members', { cookie });

    expect(res.body.members.map((m: Row) => m.email)).toEqual(['owner@acme-corp.test']);
  });
});

describe('PATCH /settings/members/:userId', () => {
  it('refuses to demote the last OWNER', async () => {
    const { owner, cookie } = seedTeam();

    const res = await call('PATCH', `/settings/members/${owner.id}`, {
      cookie,
      body: { role: 'ADMIN' },
    });

    /*
     * OWNER is the only role that can promote anyone, so an org with none is a
     * one-way door: nobody inside the product can ever administer it again. The
     * message has to say what to do, because "400" does not.
     */
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'This is the only owner. Promote someone else to owner first, then change this role.',
    );
    expect(db.tables.membership[0]!.role).toBe('OWNER');
  });

  it('demotes an OWNER once there is a second one', async () => {
    const { org, owner, cookie } = seedTeam();
    const second = seedUser('sam@acme-corp.test');
    seedMember(org.id, second.id, 'OWNER');

    const res = await call('PATCH', `/settings/members/${owner.id}`, {
      cookie,
      body: { role: 'ADMIN' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ member: { userId: owner.id, role: 'ADMIN' }, changed: true });
    expect(db.tables.membership.find((m) => m.userId === owner.id)!.role).toBe('ADMIN');
    // The guard counts OWNERs, so the survivor is untouched.
    expect(db.tables.membership.find((m) => m.userId === second.id)!.role).toBe('OWNER');
  });

  it('lets only an OWNER mint another OWNER', async () => {
    const { org, cookie: ownerCookie } = seedTeam();
    const admin = seedUser('ada@acme-corp.test');
    seedMember(org.id, admin.id, 'ADMIN');
    const target = seedUser('mel@acme-corp.test');
    seedMember(org.id, target.id, 'MEMBER');

    const refused = await call('PATCH', `/settings/members/${target.id}`, {
      cookie: seedSession(admin.id, org.id),
      body: { role: 'OWNER' },
    });
    // Handing out the one role that can remove the person who granted it is an
    // escalation, not an administration task. ADMIN passes requireRole, so this
    // has to be refused inside the handler or not at all.
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('Only an owner can make someone else an owner.');
    expect(db.tables.membership.find((m) => m.userId === target.id)!.role).toBe('MEMBER');

    const allowed = await call('PATCH', `/settings/members/${target.id}`, {
      cookie: ownerCookie,
      body: { role: 'OWNER' },
    });
    expect(allowed.status).toBe(200);
    expect(db.tables.membership.find((m) => m.userId === target.id)!.role).toBe('OWNER');
  });

  it('is refused to a plain member, and 404s on a stranger', async () => {
    const { org, cookie } = seedTeam();
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');

    const asMember = await call('PATCH', `/settings/members/${member.id}`, {
      cookie: seedSession(member.id, org.id),
      body: { role: 'ADMIN' },
    });
    expect(asMember.status).toBe(403);

    const stranger = seedUser('stranger@other.test');
    const missing = await call('PATCH', `/settings/members/${stranger.id}`, {
      cookie,
      body: { role: 'ADMIN' },
    });
    expect(missing.status).toBe(404);
  });

  it('rejects a role that is not a role', async () => {
    const { org, cookie } = seedTeam();
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');

    const res = await call('PATCH', `/settings/members/${member.id}`, {
      cookie,
      body: { role: 'SUPERUSER' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('DELETE /settings/members/:userId', () => {
  it('refuses to remove the last OWNER', async () => {
    const { owner, cookie } = seedTeam();

    const res = await call('DELETE', `/settings/members/${owner.id}`, { cookie });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      'This is the only owner. Make someone else an owner before removing them.',
    );
    expect(db.tables.membership).toHaveLength(1);
  });

  it('removes an OWNER once there is a second one', async () => {
    const { org, owner, cookie } = seedTeam();
    const second = seedUser('sam@acme-corp.test');
    seedMember(org.id, second.id, 'OWNER');

    const res = await call('DELETE', `/settings/members/${owner.id}`, { cookie });

    expect(res.status).toBe(200);
    expect(db.tables.membership.map((m) => m.userId)).toEqual([second.id]);
  });

  it('cuts the removed member’s session in this org immediately', async () => {
    const { org, cookie } = seedTeam();
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');
    const memberCookie = seedSession(member.id, org.id);
    const elsewhere = seedOrg('Elsewhere');
    const untouched = seedSession(member.id, elsewhere.id);

    expect((await call('GET', '/settings/members', { cookie: memberCookie })).status).toBe(200);

    await call('DELETE', `/settings/members/${member.id}`, { cookie });

    expect((await call('GET', '/settings/members', { cookie: memberCookie })).status).toBe(401);
    /*
     * Asserted on the ROW, not only on the 401: the membership is gone by now,
     * so requireAuth would refuse this caller whether or not the session was
     * revoked, and a 401 alone proves nothing about the revocation. Verified by
     * removing the updateMany — the status assertion above still passed.
     *
     * It matters because the session is what carries the org, and a live row for
     * a person who has been told they are out is a credential nobody is tracking.
     */
    const revoked = db.tables.session.filter((s) => s.revokedAt !== null);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.tokenHash).toBe(hashToken(memberCookie.split('=')[1]!));

    // And only in THIS org: their session elsewhere is not the removing org's
    // business, and cutting it would sign them out of a customer they still work
    // for.
    expect(db.tables.session.find((s) => s.tokenHash === hashToken(untouched.split('=')[1]!))!
      .revokedAt).toBeNull();
  });

  it('does not let an ADMIN remove an OWNER', async () => {
    const { org, owner } = seedTeam();
    const second = seedUser('sam@acme-corp.test');
    seedMember(org.id, second.id, 'OWNER');
    const admin = seedUser('ada@acme-corp.test');
    seedMember(org.id, admin.id, 'ADMIN');

    const res = await call('DELETE', `/settings/members/${owner.id}`, {
      cookie: seedSession(admin.id, org.id),
    });

    // Not the last-owner guard — there are two. This is the rank rule.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Only an owner can remove another owner.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invites, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('the invite round trip', () => {
  it('carries a real minted link into membership of the inviting org', async () => {
    const { org, cookie } = seedTeam();

    const created = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'dana@acme-corp.test', role: 'ADMIN' },
    });
    expect(created.status).toBe(201);

    // The token the admin would actually paste into a chat window.
    const token = new URL(created.body.acceptUrl as string).searchParams.get('invite')!;
    expect(token).toBeTruthy();

    const signup = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });
    expect(signup.status).toBe(201);
    expect(signup.body.org.id).toBe(org.id);
    expect(signup.body.org.role).toBe('ADMIN');
    expect(db.tables.organization).toHaveLength(1);

    const members = await call('GET', '/settings/members', { cookie });
    expect(members.body.members.map((m: Row) => m.email).sort()).toEqual([
      'dana@acme-corp.test',
      'owner@acme-corp.test',
    ]);

    // Accepted invites drop off the pending list.
    const pending = await call('GET', '/settings/invites', { cookie });
    expect(pending.body.invites).toHaveLength(0);
  });

  it('says when the link was not actually emailed', async () => {
    const { cookie } = seedTeam();

    const onConsole = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'dana@acme-corp.test', role: 'MEMBER' },
    });
    expect(onConsole.body.delivery).toBe('console');

    h.mail.driver = 'smtp';
    h.mail.fail = true;
    const failed = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'walter@acme-corp.test', role: 'MEMBER' },
    });
    // The row is durable either way, so the UI must offer the link by hand
    // rather than claim it was sent.
    expect(failed.status).toBe(201);
    expect(failed.body.delivery).toBe('failed');
    expect(failed.body.acceptUrl).toContain('/signup?invite=');
  });

  it('re-inviting replaces the earlier link rather than colliding', async () => {
    const { cookie } = seedTeam();

    const first = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'dana@acme-corp.test', role: 'MEMBER' },
    });
    const second = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'dana@acme-corp.test', role: 'ADMIN' },
    });

    // @@unique([orgId, email]) means the naive path is a 409 with no way out —
    // there was no revoke endpoint either.
    expect(second.status).toBe(201);
    expect(db.tables.invite).toHaveLength(1);

    const firstToken = new URL(first.body.acceptUrl as string).searchParams.get('invite')!;
    expect((await call('GET', `/auth/invite?token=${firstToken}`)).status).toBe(410);

    const secondToken = new URL(second.body.acceptUrl as string).searchParams.get('invite')!;
    const lookup = await call('GET', `/auth/invite?token=${secondToken}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.role).toBe('ADMIN');
  });

  it('refuses to invite someone who is already in this org, and allows a revoke', async () => {
    const { org, cookie } = seedTeam();
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');

    const conflict = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'mel@acme-corp.test', role: 'ADMIN' },
    });
    expect(conflict.status).toBe(409);

    const created = await call('POST', '/settings/invites', {
      cookie,
      body: { email: 'dana@acme-corp.test', role: 'MEMBER' },
    });
    const revoked = await call('DELETE', `/settings/invites/${created.body.invite.id}`, { cookie });
    expect(revoked.status).toBe(200);

    const token = new URL(created.body.acceptUrl as string).searchParams.get('invite')!;
    expect((await call('GET', `/auth/invite?token=${token}`)).status).toBe(410);
  });

  it('is refused to a plain member', async () => {
    const { org } = seedTeam();
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');

    const res = await call('POST', '/settings/invites', {
      cookie: seedSession(member.id, org.id),
      body: { email: 'dana@acme-corp.test', role: 'ADMIN' },
    });

    expect(res.status).toBe(403);
  });
});
