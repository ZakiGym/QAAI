/**
 * Tests for the subscription lifecycle: buy, change, leave, and the webhook
 * that applies what Stripe decided.
 *
 * The bug this file exists to pin down is the double charge. POST
 * /billing/checkout used to create a subscription-mode Checkout Session
 * unconditionally — a TEAM org clicking BUSINESS bought a SECOND subscription,
 * Stripe billed both every month, and QAAI held no record of the first to
 * cancel or refund. Nothing about that was observable from a status code: the
 * response was a perfectly good checkout URL. So the central assertions here
 * are about which Stripe calls were made — `subscriptions.update` for a
 * customer with a live subscription, `checkout.sessions.create` only for a
 * customer without one — and about the calls that must NOT happen.
 *
 * The second money bug pinned here is the cancelled-plan bug: the webhook's
 * unknown-price early return meant `customer.subscription.deleted` for a price
 * missing from the env left the org on its paid plan forever, silently. The
 * webhook tests assert the org lands on FREE and that an audit row says so.
 *
 * Same harness as accounts.test.ts: the real routers driven over a loopback
 * socket, an in-memory prisma stand-in that THROWS on filters it does not
 * implement, and — new here — a Stripe fake that records every call, because
 * the calls are the behaviour under test. No STRIPE_* secret is real; the env
 * is mocked, which is also how the "not configured" degradation is tested.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  /**
   * Mutated per test, never reassigned: the env mock captures this OBJECT once
   * at module-mock time, so a fresh object would silently disconnect the tests
   * from the code under test.
   */
  env: Record<string, unknown>;
  stripe: {
    /** What subscriptions.list returns, keyed by nothing — filtered by customer. */
    subscriptions: Row[];
    sessionsCreate: Row[];
    subscriptionsUpdate: Array<{ id: string; params: Row }>;
    customersCreate: Row[];
  };
  mail: { sent: Array<{ to: string; subject: string }> };
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    // hashToken() is an HMAC keyed on SESSION_SECRET; the auth middleware
    // hashes the session cookie on every request, so an empty env throws
    // before any handler runs. Tests that reassign `h.env` must keep it.
    env: { SESSION_SECRET: 'test-session-secret-at-least-32-characters-long' } as Record<
      string,
      unknown
    >,
    stripe: { subscriptions: [], sessionsCreate: [], subscriptionsUpdate: [], customersCreate: [] },
    mail: { sent: [] },
  }),
);

vi.mock('../env.js', () => ({ env: h.env, isProd: false }));

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

// Only the transport is faked. The dunning path (billing's other webhook arm)
// has its own tests; here mail exists so importing billing.ts does not explode.
vi.mock('../lib/mail.js', () => ({
  mailDriver: () => 'console' as const,
  sendMail: async (mail: { to: string; subject: string }) => {
    h.mail.sent.push(mail);
    return { driver: 'console', delivered: false };
  },
  paymentFailedMail: (to: string, orgName: string, url: string) => ({
    to,
    subject: `Payment failed for ${orgName} on QAAI`,
    text: url,
  }),
}));

/*
 * The Stripe fake. Every method the routes call is here and RECORDS its call —
 * the assertions are about which of these ran, with what, and which did not.
 * `constructEvent` verifies nothing cryptographic: signature checking is
 * Stripe's code, and what is ours to test is that the route refuses when the
 * library throws and proceeds when it does not.
 */
vi.mock('stripe', () => {
  let ids = 0;
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Row) => {
          h.stripe.sessionsCreate.push(params);
          return { id: `cs_${++ids}`, url: 'https://checkout.stripe.test/session' };
        },
      },
    };

    customers = {
      create: async (params: Row) => {
        h.stripe.customersCreate.push(params);
        return { id: `cus_created_${++ids}` };
      },
    };

    subscriptions = {
      list: async (params: Row) => ({
        data: h.stripe.subscriptions.filter((sub) => sub.customer === params.customer),
      }),
      update: async (id: string, params: Row) => {
        h.stripe.subscriptionsUpdate.push({ id, params });
        const sub = h.stripe.subscriptions.find((s) => s.id === id);
        if (!sub) throw new Error(`fake stripe: no subscription ${id}`);
        if (params.cancel_at_period_end !== undefined) {
          sub.cancel_at_period_end = params.cancel_at_period_end;
        }
        if (params.items) sub.items.data[0].price = { id: params.items[0].price };
        if (params.metadata) sub.metadata = { ...sub.metadata, ...params.metadata };
        return structuredClone(sub);
      },
      retrieve: async (id: string) => {
        const sub = h.stripe.subscriptions.find((s) => s.id === id);
        if (!sub) throw new Error(`fake stripe: no subscription ${id}`);
        return structuredClone(sub);
      },
    };

    billingPortal = {
      sessions: { create: async () => ({ url: 'https://portal.stripe.test/session' }) },
    };

    webhooks = {
      constructEvent: (raw: Buffer | string, signature: string) => {
        if (signature !== 'sig_valid') throw new Error('signature mismatch');
        return JSON.parse(raw.toString());
      },
    };
  }
  return { default: FakeStripe };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'user',
  'organization',
  'membership',
  'session',
  'subscription',
  'project',
  'usageRecord',
  'stripeEventSeen',
  'auditLog',
] as const;

type ModelName = (typeof MODELS)[number];

/** The compound uniques these routes look rows up by. */
const COMPOUND: Record<string, string[]> = {
  orgId_userId: ['orgId', 'userId'],
  orgId_metric_period: ['orgId', 'metric', 'period'],
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

interface ModelOptions {
  /** Org-owned, so the tenancy extension filters and stamps it. */
  scoped?: boolean;
  defaults?: Row;
}

const MODEL_OPTIONS: Record<ModelName, ModelOptions> = {
  user: { defaults: { emailVerified: null, passwordHash: null } },
  organization: { defaults: { plan: 'FREE', limitOverrides: null, billingState: 'OK' } },
  membership: { scoped: true, defaults: { role: 'MEMBER' } },
  session: { defaults: { activeOrgId: null, ip: null, userAgent: null, revokedAt: null } },
  subscription: {
    defaults: {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: 'FREE',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      planSyncedAt: null,
    },
  },
  project: { scoped: true, defaults: { archivedAt: null } },
  usageRecord: { defaults: {} },
  stripeEventSeen: { defaults: {} },
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

    const find = (where: Row = {}): Row[] => rows().filter((r) => matches(r, scope(where)));

    const read = (row: Row | undefined, select?: Row): Row | null =>
      row ? project(row, select) : null;

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
      findFirst: async ({ where, select }: Row = {}) => read(find(where)[0], select),
      findMany: async ({ where, select }: Row = {}) => find(where).map((r) => read(r, select)),
      count: async ({ where }: Row = {}) => find(where).length,
      create: async ({ data, select }: Row) => read(insert(data), select),
      update: async ({ where, data, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data);
        return read(row, select);
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

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { billingRouter, registerStripeWebhook } = await import('./billing.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
// Raw body on the webhook prefix, exactly as index.ts mounts it: signature
// verification is over the exact bytes Stripe signed.
const webhooks = express.Router();
registerStripeWebhook(webhooks);
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooks);
app.use(express.json());
app.use('/billing', billingRouter);
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
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

let eventSeq = 0;

/** Deliver a webhook event the way Stripe would: raw JSON plus a signature. */
async function deliver(event: Row, signature: string | null = 'sig_valid'): Promise<Reply> {
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'stripe-signature': signature } : {}),
    },
    body: JSON.stringify({
      id: `evt_${++eventSeq}`,
      created: 1_770_000_000 + eventSeq,
      ...event,
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof makeDb>;

let idSeq = 0;
const fixtureId = (prefix: string) => `${prefix}_fixture_${++idSeq}`;

const ORG_ID = 'org_1';
const PERIOD_END_EPOCH = 1_772_000_000;

function seedOrg(plan: string): Row {
  const org = {
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    plan,
    limitOverrides: null,
    billingState: 'OK',
    createdAt: new Date(CLOCK_BASE),
  };
  db.tables.organization.push(org);
  return org;
}

/** An OWNER with a live session, the only role allowed to touch billing. */
function seedOwner(role = 'OWNER'): string {
  const user = {
    id: fixtureId('user'),
    email: 'owner@acme-corp.test',
    name: 'Olive Owner',
    passwordHash: 'scrypt$x',
    createdAt: new Date(CLOCK_BASE),
  };
  db.tables.user.push(user);
  db.tables.membership.push({
    id: fixtureId('membership'),
    orgId: ORG_ID,
    userId: user.id,
    role,
    createdAt: new Date(CLOCK_BASE),
  });
  const raw = fixtureId('session-token');
  db.tables.session.push({
    id: fixtureId('session'),
    userId: user.id,
    tokenHash: hashToken(raw),
    activeOrgId: ORG_ID,
    ip: null,
    userAgent: null,
    expiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
    createdAt: new Date(CLOCK_BASE),
  });
  return `qaai_session=${raw}`;
}

function seedSubscriptionRow(over: Row = {}): Row {
  const row = {
    id: fixtureId('subscription'),
    orgId: ORG_ID,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    plan: 'TEAM',
    status: 'active',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    planSyncedAt: null,
    createdAt: new Date(CLOCK_BASE),
    ...over,
  };
  db.tables.subscription.push(row);
  return row;
}

/** A subscription as Stripe would return it — the shape the routes read. */
function stripeSub(over: Row = {}): Row {
  const sub = {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    metadata: { orgId: ORG_ID },
    items: {
      data: [{ id: 'si_1', price: { id: 'price_team' }, current_period_end: PERIOD_END_EPOCH }],
    },
    ...over,
  };
  h.stripe.subscriptions.push(sub);
  return sub;
}

function seedProjects(count: number): void {
  for (let i = 0; i < count; i += 1) {
    db.tables.project.push({
      id: fixtureId('project'),
      orgId: ORG_ID,
      name: `p${i}`,
      archivedAt: null,
      createdAt: new Date(CLOCK_BASE + i),
    });
  }
}

const auditRows = (action: string): Row[] =>
  db.tables.auditLog.filter((row) => row.action === action);

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.stripe.subscriptions = [];
  h.stripe.sessionsCreate = [];
  h.stripe.subscriptionsUpdate = [];
  h.stripe.customersCreate = [];
  h.mail.sent = [];
  // Mutated, never reassigned — the env mock holds this object by reference.
  for (const key of Object.keys(h.env)) delete h.env[key];
  Object.assign(h.env, {
    // Rebuilt every test because the loop above clears the object. Without it
    // `hashToken` — the HMAC the auth middleware runs on every request — throws
    // before any handler is reached.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_TTL_HOURS: 72,
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_TEAM: 'price_team',
    STRIPE_PRICE_BUSINESS: 'price_business',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout with a live subscription — the double-charge bug
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout with a live subscription', () => {
  it('modifies the existing subscription instead of selling a second one', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow();
    stripeSub();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'BUSINESS' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, plan: 'BUSINESS' });
    // The whole bug, in two assertions: the one subscription was updated, and
    // no second Checkout Session — no second monthly bill — was created.
    expect(res.body.url).toBeUndefined();
    expect(h.stripe.sessionsCreate).toHaveLength(0);
    expect(h.stripe.subscriptionsUpdate).toHaveLength(1);

    const { id, params } = h.stripe.subscriptionsUpdate[0]!;
    expect(id).toBe('sub_1');
    expect(params.items).toEqual([{ id: 'si_1', price: 'price_business' }]);
    expect(params.proration_behavior).toBe('create_prorations');

    const audit = auditRows('billing.plan.change');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: 'TEAM', to: 'BUSINESS' });

    // The local plan is deliberately untouched: only the webhook moves an org
    // between plans, and Stripe will send subscription.updated for this change.
    expect(db.tables.organization[0]!.plan).toBe('TEAM');
  });

  it('finds the live subscription at Stripe even when the local row is stale', async () => {
    // The local cache says FREE and knows no subscription id — say a webhook
    // was missed. Trusting it would sell a second subscription anyway.
    seedOrg('FREE');
    const cookie = seedOwner();
    seedSubscriptionRow({ plan: 'FREE', stripeSubscriptionId: null });
    stripeSub();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'BUSINESS' } });

    expect(res.status).toBe(200);
    expect(h.stripe.sessionsCreate).toHaveLength(0);
    expect(h.stripe.subscriptionsUpdate).toHaveLength(1);
  });

  it('refuses the plan the org is already on', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow();
    stripeSub();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already on Team');
    expect(h.stripe.subscriptionsUpdate).toHaveLength(0);
  });

  it('re-choosing the current plan while a cancellation is scheduled resumes it', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow({ cancelAtPeriodEnd: true });
    stripeSub({ cancel_at_period_end: true });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, plan: 'TEAM', resumed: true });
    expect(h.stripe.subscriptionsUpdate).toHaveLength(1);
    expect(h.stripe.subscriptionsUpdate[0]!.params).toEqual({ cancel_at_period_end: false });
  });

  it('a downgrade flags what is over the lower limits and deletes nothing', async () => {
    seedOrg('BUSINESS');
    const cookie = seedOwner();
    seedSubscriptionRow({ plan: 'BUSINESS' });
    stripeSub({ items: { data: [{ id: 'si_1', price: { id: 'price_business' } }] } });
    seedProjects(5); // BUSINESS allows 10; TEAM allows 3.

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(res.body.overLimit).toEqual([{ limit: 'projects', used: 5, max: 3 }]);
    // Nothing was deleted: the excess stays readable, creating MORE is what
    // the forward limit checks refuse.
    expect(db.tables.project).toHaveLength(5);

    const audit = auditRows('billing.plan.change');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata.overLimit).toEqual([{ limit: 'projects', used: 5, max: 3 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Downgrade to FREE — cancel at period end, never delete
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout to FREE', () => {
  it('cancels at the period end — the customer paid for the month', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow();
    stripeSub();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'FREE' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      changed: true,
      plan: 'TEAM',
      to: 'FREE',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(PERIOD_END_EPOCH * 1000).toISOString(),
    });

    expect(h.stripe.subscriptionsUpdate).toHaveLength(1);
    const { params } = h.stripe.subscriptionsUpdate[0]!;
    // Cancel-at-period-end and NOTHING else: no immediate deletion, no
    // repricing. The plan drop itself arrives as subscription.deleted later.
    expect(params).toEqual({ cancel_at_period_end: true });

    const audit = auditRows('billing.plan.change');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: 'TEAM', to: 'FREE', cancelAtPeriodEnd: true });
  });

  it('reports usage that will be over FREE limits, without touching it', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow();
    stripeSub();
    seedProjects(2); // FREE allows 1.
    db.tables.usageRecord.push({
      id: fixtureId('usage'),
      orgId: ORG_ID,
      metric: 'runs',
      period: (() => {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      })(),
      quantity: 500n, // FREE allows 100/mo.
      createdAt: new Date(CLOCK_BASE),
    });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'FREE' } });

    expect(res.status).toBe(200);
    expect(res.body.overLimit).toEqual([
      { limit: 'projects', used: 2, max: 1 },
      { limit: 'runs', used: 500, max: 100 },
    ]);
    expect(db.tables.project).toHaveLength(2);
  });

  it('with nothing live to cancel is refused honestly', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'FREE' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('no paid subscription to cancel');
  });

  it('refuses to schedule the same cancellation twice', async () => {
    seedOrg('TEAM');
    const cookie = seedOwner();
    seedSubscriptionRow({ cancelAtPeriodEnd: true });
    stripeSub({ cancel_at_period_end: true });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'FREE' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already set to end');
    expect(h.stripe.subscriptionsUpdate).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout with nothing live — the only path that sells
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout with no live subscription', () => {
  it('creates a Checkout Session for a brand-new customer', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/session');
    expect(h.stripe.subscriptionsUpdate).toHaveLength(0);

    expect(h.stripe.customersCreate).toHaveLength(1);
    expect(h.stripe.customersCreate[0]!.metadata).toEqual({ orgId: ORG_ID });

    expect(h.stripe.sessionsCreate).toHaveLength(1);
    expect(h.stripe.sessionsCreate[0]).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_team', quantity: 1 }],
      subscription_data: { metadata: { orgId: ORG_ID } },
    });

    // The customer id is remembered so the NEXT purchase reuses it — and so
    // the live-subscription check above has something to ask Stripe about.
    expect(db.tables.subscription[0]!.stripeCustomerId).toBe('cus_created_1');
    expect(auditRows('billing.checkout.start')).toHaveLength(1);
  });

  it('a customer whose old subscription is cancelled gets a session, not a modify', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();
    seedSubscriptionRow({ plan: 'FREE', status: 'canceled' });
    stripeSub({ status: 'canceled' });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(res.body.url).toBeTruthy();
    expect(h.stripe.subscriptionsUpdate).toHaveLength(0);
    expect(h.stripe.sessionsCreate).toHaveLength(1);
    // And the existing customer was reused, not re-created.
    expect(h.stripe.customersCreate).toHaveLength(0);
    expect(h.stripe.sessionsCreate[0]!.customer).toBe('cus_1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout guards', () => {
  it('degrades honestly when Stripe is not configured', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();
    h.env.STRIPE_SECRET_KEY = '';

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Billing is not configured on this instance.');
  });

  it('says when a plan has no price configured', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();
    h.env.STRIPE_PRICE_TEAM = '';

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('no Stripe price configured');
  });

  it('refuses Enterprise, refuses garbage, refuses non-OWNERs', async () => {
    seedOrg('FREE');
    const cookie = seedOwner();

    const enterprise = await call('POST', '/billing/checkout', {
      cookie,
      body: { plan: 'ENTERPRISE' },
    });
    expect(enterprise.status).toBe(400);
    expect(enterprise.body.error.message).toContain('talk to us');

    const garbage = await call('POST', '/billing/checkout', { cookie, body: { plan: 'SUPER' } });
    expect(garbage.status).toBe(400);

    db.tables.membership[0]!.role = 'ADMIN';
    const admin = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });
    expect(admin.status).toBe(403);
    expect(h.stripe.sessionsCreate).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The webhook — the cancelled-plan bug
// ─────────────────────────────────────────────────────────────────────────────

describe('the Stripe webhook', () => {
  it('subscription.deleted drops the org to FREE with an audit row', async () => {
    seedOrg('TEAM');
    seedSubscriptionRow();

    const res = await deliver({
      type: 'customer.subscription.deleted',
      data: { object: stripeSub({ status: 'canceled' }) },
    });

    expect(res.status).toBe(200);
    expect(db.tables.organization[0]!.plan).toBe('FREE');
    expect(db.tables.subscription[0]!.plan).toBe('FREE');

    const audit = auditRows('billing.plan.applied');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: 'TEAM', to: 'FREE', status: 'canceled' });
  });

  it('a price that maps to nothing no longer strands the org on its paid plan', async () => {
    // The cancelled-plan bug: this exact event used to return early, leaving a
    // TEAM label nobody was paying for.
    seedOrg('TEAM');
    seedSubscriptionRow();

    const res = await deliver({
      type: 'customer.subscription.updated',
      data: {
        object: stripeSub({
          items: { data: [{ id: 'si_1', price: { id: 'price_retired' } }] },
        }),
      },
    });

    expect(res.status).toBe(200);
    expect(db.tables.organization[0]!.plan).toBe('FREE');

    const audit = auditRows('billing.plan.applied');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      from: 'TEAM',
      to: 'FREE',
      reason: 'unknown_price',
      priceId: 'price_retired',
    });
  });

  it('a renewal restating the same plan writes no audit row', async () => {
    seedOrg('TEAM');
    seedSubscriptionRow();

    await deliver({
      type: 'customer.subscription.updated',
      data: { object: stripeSub() },
    });

    expect(db.tables.organization[0]!.plan).toBe('TEAM');
    expect(auditRows('billing.plan.applied')).toHaveLength(0);
  });

  it('checkout.session.completed applies the purchased plan', async () => {
    seedOrg('FREE');
    seedSubscriptionRow({ plan: 'FREE', stripeSubscriptionId: null });
    stripeSub(); // what subscriptions.retrieve('sub_1') returns

    const res = await deliver({
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', subscription: 'sub_1' } },
    });

    expect(res.status).toBe(200);
    expect(db.tables.organization[0]!.plan).toBe('TEAM');
    expect(db.tables.subscription[0]!.plan).toBe('TEAM');

    const audit = auditRows('billing.plan.applied');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: 'FREE', to: 'TEAM' });
  });

  it('refuses a missing or invalid signature, and 503s unconfigured', async () => {
    seedOrg('TEAM');
    seedSubscriptionRow();

    const missing = await deliver({ type: 'customer.subscription.deleted' }, null);
    expect(missing.status).toBe(400);

    const forged = await deliver({ type: 'customer.subscription.deleted' }, 'sig_forged');
    expect(forged.status).toBe(400);

    h.env.STRIPE_WEBHOOK_SECRET = '';
    const unconfigured = await deliver({ type: 'customer.subscription.deleted' });
    expect(unconfigured.status).toBe(503);

    // None of the refusals touched the plan.
    expect(db.tables.organization[0]!.plan).toBe('TEAM');
  });
});
