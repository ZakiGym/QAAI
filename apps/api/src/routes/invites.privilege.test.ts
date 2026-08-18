/**
 * Who may hand out an OWNER seat — at both ends of an invite.
 *
 * `PATCH /settings/members/:userId` has always refused to let an ADMIN mint an
 * OWNER, and `POST /settings/invites` did not, so the refusal was decorative:
 * an ADMIN invited an address they controlled at role OWNER, accepted the link,
 * and came back holding the role that gates `POST /billing/checkout` (moves
 * money on the org's card), `GET /export/org` (streams every org-owned row),
 * `POST /retention/sweep` (irreversible deletion), and the member route itself —
 * from which they could demote the people who hired them. Two HTTP calls, no
 * error, nothing in the product that looks wrong afterwards.
 *
 * So this file asserts the escalation is closed at BOTH layers independently,
 * because they fail for different reasons and a fix at one is not a fix at the
 * other:
 *
 *   · the write site refuses the request, with the sibling route's wording;
 *   · the ACCEPTANCE site clamps the grant, so an invite row that already says
 *     OWNER — written before the check landed, or by any future path — still
 *     cannot produce an OWNER membership.
 *
 * The second is the one that actually closes the hole. It is asserted on the
 * membership ROW rather than the response body, because a 201 that says ADMIN
 * while the table says OWNER is precisely the failure being guarded against.
 *
 * ─── On the harness ──────────────────────────────────────────────────────────
 *
 * A trimmed copy of the in-memory Prisma stand-in in accounts.test.ts, kept
 * separate rather than shared: this is a security property that should keep
 * proving itself even if the account-cluster suite is rewritten around it, and a
 * fake shared between the two would let a convenience added for one quietly
 * weaken the other. Same rules as over there — no database, real routers driven
 * over a loopback socket, and the fake THROWS on any filter it does not
 * implement, because a stand-in that shrugs at `acceptedAt: null` passes the
 * tests whose whole point is that the filter was applied.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../lib/crypto.js';

/** `any` is off for test files by policy; used only for parsed bodies and rows. */
type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
  }),
);

// env.ts exits on a bad environment and reads the repo-root .env, so a
// developer's local file would otherwise decide what these tests see.
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
 * The tenancy scope is real. requireAuth opens it with `withTenant(orgId, …)`
 * and the handlers' queries run in the async continuation of that call, so a
 * plain variable would be restored before they ran and the org filtering would
 * appear to work (or not) for reasons unrelated to the route.
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

// Only the transport is replaced; nothing here asserts on message bodies.
vi.mock('../lib/mail.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/mail.js')>('../lib/mail.js');
  return {
    ...actual,
    mailDriver: () => 'console' as const,
    sendMail: async () => ({ driver: 'console' as const, delivered: false }),
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = ['user', 'organization', 'membership', 'session', 'invite', 'auditLog'] as const;
type ModelName = (typeof MODELS)[number];

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
  /** Org-owned, so the tenancy extension filters and stamps it. */
  scoped?: boolean;
  defaults?: Row;
  hydrate?: (row: Row) => Row;
}

const MODEL_OPTIONS: Record<ModelName, ModelOptions> = {
  user: {
    defaults: { passwordHash: null, isSuperuser: false, totpEnabledAt: null, lastLoginAt: null },
  },
  organization: { defaults: { plan: 'FREE', limitOverrides: null } },
  membership: { scoped: true, defaults: { role: 'MEMBER' } },
  session: { defaults: { activeOrgId: null, ip: null, userAgent: null, revokedAt: null } },
  invite: { scoped: true, defaults: { role: 'MEMBER', acceptedAt: null } },
  auditLog: { scoped: true, defaults: {} },
};

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
      const orgId = h.currentOrg();
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: new Date(CLOCK_BASE + ticks++),
        ...opts.defaults,
        ...(opts.scoped && orgId && data.orgId === undefined ? { orgId } : {}),
        ...data,
      };
      rows().push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select }: Row) => read(find(where)[0], select),
      findFirst: async ({ where, select, orderBy }: Row = {}) =>
        read(find(where, orderBy)[0], select),
      findMany: async ({ where, select, orderBy }: Row = {}) =>
        find(where, orderBy).map((r) => read(r, select)),
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

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);

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

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof makeDb>;
let idSeq = 0;
const fixtureId = (prefix: string) => `${prefix}_fixture_${++idSeq}`;

const PASSWORD = 'correct-horse-battery';

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

function seedUser(email: string): Row {
  const user = {
    id: fixtureId('user'),
    email,
    name: email.split('@')[0],
    passwordHash: 'scrypt$x',
    isSuperuser: false,
    totpEnabledAt: null,
    lastLoginAt: null,
    createdAt: new Date(CLOCK_BASE),
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

/** Faked exactly the way one is minted, so the real requireAuth path runs. */
function seedSession(userId: string, orgId: string): string {
  const raw = fixtureId('session-token');
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

/** An invite row written directly — i.e. one that predates the route's check. */
function seedInvite(over: Row & { orgId: string; email: string; invitedBy: string }): string {
  const raw = fixtureId('invite-token');
  db.tables.invite.push({
    id: fixtureId('invite'),
    role: 'MEMBER',
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    acceptedAt: null,
    createdAt: new Date(CLOCK_BASE),
    ...over,
  });
  return raw;
}

/** An org with an OWNER and an ADMIN, each with a live session. */
function seedTeam() {
  const org = seedOrg('Acme');
  const owner = seedUser('owner@acme-corp.test');
  seedMember(org.id, owner.id, 'OWNER');
  const admin = seedUser('ada@acme-corp.test');
  seedMember(org.id, admin.id, 'ADMIN');
  return {
    org,
    owner,
    admin,
    ownerCookie: seedSession(owner.id, org.id),
    adminCookie: seedSession(admin.id, org.id),
  };
}

const signupBody = (over: Row = {}): Row => ({
  email: 'mallory@acme-corp.test',
  password: PASSWORD,
  name: 'Mallory',
  ...over,
});

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: the write site
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /settings/invites', () => {
  it('refuses an ADMIN who invites somebody as OWNER', async () => {
    const { adminCookie } = seedTeam();

    const res = await call('POST', '/settings/invites', {
      cookie: adminCookie,
      body: { email: 'mallory@acme-corp.test', role: 'OWNER' },
    });

    // Same sentence as PATCH /settings/members/:userId, because it is the same
    // policy — an admin reading one and then the other must not see two rules.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Only an owner can make someone else an owner.');
    // And nothing durable came of it: no row to accept later, no email sent.
    expect(db.tables.invite).toHaveLength(0);
  });

  it('lets an OWNER invite an OWNER', async () => {
    const { ownerCookie } = seedTeam();

    const res = await call('POST', '/settings/invites', {
      cookie: ownerCookie,
      body: { email: 'mallory@acme-corp.test', role: 'OWNER' },
    });

    // Proves the refusal above is about the ACTOR's role, not about OWNER being
    // uninvitable — succession is a real thing owners need to do.
    expect(res.status).toBe(201);
    expect(res.body.invite.role).toBe('OWNER');
    expect(db.tables.invite[0]!.role).toBe('OWNER');
  });

  it('still lets an ADMIN invite every role below OWNER', async () => {
    const { adminCookie } = seedTeam();

    for (const role of ['ADMIN', 'MEMBER', 'VIEWER']) {
      const res = await call('POST', '/settings/invites', {
        cookie: adminCookie,
        body: { email: `${role.toLowerCase()}@acme-corp.test`, role },
      });
      // Administering the org is still an administration task; the new check
      // must not have turned into "only owners may invite".
      expect(res.status).toBe(201);
      expect(res.body.invite.role).toBe(role);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: the acceptance site — the one that actually closes the hole
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /auth/signup with an OWNER invite', () => {
  it('does not grant OWNER for a row an ADMIN wrote', async () => {
    const { org, admin } = seedTeam();
    // The row the two-step escalation leaves behind: written before the check
    // above existed, or by any future path that forgets it.
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'OWNER',
      invitedBy: admin.id,
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(res.status).toBe(201);
    // Asserted on the ROW, not the response: a 201 that says ADMIN while the
    // table says OWNER is exactly the failure this exists to catch.
    const membership = db.tables.membership.find((m) => m.userId === res.body.user.id);
    expect(membership!.role).toBe('ADMIN');
    expect(res.body.org.role).toBe('ADMIN');
    expect(db.tables.membership.filter((m) => m.role === 'OWNER')).toHaveLength(1);
  });

  it('does not grant OWNER when the inviter is no longer in the org', async () => {
    const { org } = seedTeam();
    // The inviter was removed, or the row is old enough that nobody knows. A
    // seat nobody present can vouch for is not an OWNER seat.
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'OWNER',
      invitedBy: 'user_long_gone',
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(res.status).toBe(201);
    expect(db.tables.membership.find((m) => m.userId === res.body.user.id)!.role).toBe('ADMIN');
  });

  it('does grant OWNER when an OWNER sent it', async () => {
    const { org, owner } = seedTeam();
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'OWNER',
      invitedBy: owner.id,
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    // Without this the clamp would be indistinguishable from "OWNER invites are
    // broken", and handing over an org would stop working.
    expect(res.status).toBe(201);
    expect(db.tables.membership.find((m) => m.userId === res.body.user.id)!.role).toBe('OWNER');
  });

  it('leaves every other invited role exactly as sent', async () => {
    const { org, admin } = seedTeam();
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'ADMIN',
      invitedBy: admin.id,
    });

    const res = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });

    expect(db.tables.membership.find((m) => m.userId === res.body.user.id)!.role).toBe('ADMIN');
  });

  it('tells the signup screen the role it will actually get', async () => {
    const { org, admin } = seedTeam();
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'OWNER',
      invitedBy: admin.id,
    });

    const res = await call('GET', `/auth/invite?token=${token}`);

    // "You are joining Acme as owner" followed by an ADMIN membership is the
    // same disagreement one step earlier, and the one the user would report.
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ADMIN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The escalation itself, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('the two-step escalation', () => {
  it('cannot be walked by an ADMIN', async () => {
    const { org, admin, adminCookie } = seedTeam();

    // Step one: invite an address the admin controls, as OWNER.
    const invited = await call('POST', '/settings/invites', {
      cookie: adminCookie,
      body: { email: 'mallory@acme-corp.test', role: 'OWNER' },
    });
    expect(invited.status).toBe(400);

    // Step two, attempted anyway against a row planted directly — because the
    // point is that neither layer alone is the fix.
    const token = seedInvite({
      orgId: org.id,
      email: 'mallory@acme-corp.test',
      role: 'OWNER',
      invitedBy: admin.id,
    });
    const accepted = await call('POST', '/auth/signup', { body: signupBody({ invite: token }) });
    expect(accepted.status).toBe(201);

    // The org still has exactly the one OWNER it started with.
    const owners = db.tables.membership.filter((m) => m.orgId === org.id && m.role === 'OWNER');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.userId).not.toBe(admin.id);
  });
});
