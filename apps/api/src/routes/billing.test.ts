/**
 * Tests for the money paths (§9): checkout, plan changes, and the Stripe
 * webhook.
 *
 * Written the same pessimistic way round as accounts.test.ts, and for a
 * stronger reason: every failure mode in this file is SILENT, and here a silent
 * failure is money. A checkout that opens a second subscription for an org that
 * already pays is a double charge nobody sees until the customer's accountant
 * does; a webhook redelivered by Stripe's retry queue re-applies a plan change;
 * an event arriving out of order regresses a newer state to an older one; a
 * failed card that only produces a log line is dunning that never happened. All
 * of it returns 200. So most tests below assert what must NOT have happened —
 * no session minted, no second processing, no state regressed, no row deleted.
 *
 * ─── The contract, in one place ──────────────────────────────────────────────
 *
 * Written in lockstep with the money-path fixes (double charge, cancelled-plan,
 * idempotency, ordering, dunning), which landed as a sibling change. What is
 * pinned:
 *
 *  - POST /checkout for an org with a LIVE subscription modifies that
 *    subscription at Stripe and never opens a second checkout session. A
 *    cancelled subscription is not live: buying again goes through a new
 *    session (on the same Stripe customer, keeping the invoice history).
 *  - The local rows still move only on the webhook — billing.ts's header rule.
 *    A checkout round-trip proves redirection, not payment.
 *  - The webhook is idempotent (a redelivered event id is processed once) and
 *    ordered (an older subscription.updated cannot overwrite a newer state).
 *  - subscription.deleted drops the org to FREE, keeps the row (it holds the
 *    customer id), and audits — money-state mutations always audit.
 *  - An unknown price cannot leave the org sitting on its old paid plan
 *    silently: the state applies as FREE — the one plan always safe to grant —
 *    and the transition is audited with the reason, because what produces this
 *    in production is rotated STRIPE_PRICE_* env vars.
 *  - invoice.payment_failed marks the org PAST_DUE and mails every OWNER;
 *    invoice.paid clears the mark. Record-and-notify only — the mark gates
 *    nothing, by design, so the assertions are on the rows and the mail.
 *  - A downgrade REPORTS usage over the new plan's limits and deletes nothing.
 *    That follows lib/plan.ts's rule — limits gate the start of work, never
 *    the finish — so existing over-limit projects survive; only new ones are
 *    refused, and the response says what is over.
 *
 * ─── No Stripe account exists ───────────────────────────────────────────────
 *
 * By design: every STRIPE_* env var is empty until launch. The stripe npm
 * module is therefore mocked wholesale — no test here can reach the network.
 * The stub records every call, mints deterministic objects, and (like the
 * prisma stand-in, which throws on any filter it does not implement) THROWS on
 * any client surface it does not implement, so a new Stripe call cannot pass
 * by accident.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_LIMITS } from '@qaai/shared';
import { hashToken } from '../lib/crypto.js';

/**
 * `any` is allowed in tests (see eslint.config.js). Used for exactly two
 * things — parsed JSON bodies and in-memory rows — because a hand-written
 * Prisma row type would be a second copy of the schema that can drift from it.
 */
type Row = Record<string, any>;

interface StripeCallLog {
  customersCreate: Row[];
  sessionsCreate: Row[];
  portalCreate: Row[];
  subscriptionsRetrieve: string[];
  subscriptionsUpdate: Array<{ id: string; params: Row }>;
}

interface StripeStubState {
  /** The object `new Stripe(...)` hands back, reached lazily through h. */
  client: Row;
  calls: StripeCallLog;
  /** Stripe's side of the world: subscription objects by id, for retrieve/update. */
  subs: Record<string, Row>;
}

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  mail: {
    driver: 'smtp' | 'console';
    fail: boolean;
    sent: Array<{ to: string; subject: string; text: string }>;
  };
  stripe: StripeStubState;
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    mail: { driver: 'console', fail: false, sent: [] },
    stripe: {
      client: {},
      calls: {
        customersCreate: [],
        sessionsCreate: [],
        portalCreate: [],
        subscriptionsRetrieve: [],
        subscriptionsUpdate: [],
      },
      subs: {},
    },
  }),
);

/** What the mocked env sells which plan for. Deliberately unlike real ids. */
const TEAM_PRICE = 'price_stub_team';
const BUSINESS_PRICE = 'price_stub_business';
const WEBHOOK_SECRET = 'whsec_stub';
/** The one signature the stub's constructEvent accepts. */
const GOOD_SIG = 't=1,v1=stub-valid-signature';

/*
 * env.ts calls process.exit(1) on a bad environment and reads the repo-root
 * .env, so a developer's local file would decide what these tests see. Stripe
 * is CONFIGURED here — empty keys would make every paid path 400 before
 * reaching the logic under test; the unconfigured degradation is a separate
 * property from the money paths.
 */
vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SESSION_TTL_HOURS: 72,
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    STRIPE_SECRET_KEY: 'sk_test_stub',
    STRIPE_WEBHOOK_SECRET: 'whsec_stub',
    STRIPE_PRICE_TEAM: 'price_stub_team',
    STRIPE_PRICE_BUSINESS: 'price_stub_business',
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
 * The tenancy scope is real, not stubbed — same reasoning as accounts.test.ts:
 * requireAuth opens it around the handlers, and the webhook runs with none,
 * which is itself part of what is under test.
 */
vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key) => (h.prisma as Row)[key as string] }),
    withTenant: <T,>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T,>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/* Only the transport is replaced; dunning mail must be observable, not sent. */
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

/*
 * The stripe module itself. billing.ts constructs the client lazily and caches
 * it for the life of the module, so the constructor hands back a stable proxy
 * that reads through `h` — each test's fresh stub is what actually answers.
 */
vi.mock('stripe', () => {
  const indirection = new Proxy(
    {},
    { get: (_t, key) => (h.stripe.client)[key as string] },
  );
  return {
    default: class StripeStub {
      constructor(_key?: unknown) {
        return indirection;
      }
    },
  };
});

// ─── The Stripe stub ─────────────────────────────────────────────────────────

function makeStripe(): StripeStubState {
  const calls: StripeCallLog = {
    customersCreate: [],
    sessionsCreate: [],
    portalCreate: [],
    subscriptionsRetrieve: [],
    subscriptionsUpdate: [],
  };
  const subs: Record<string, Row> = {};
  let seq = 0;

  const real: Row = {
    customers: {
      create: async (params: Row) => {
        calls.customersCreate.push(params);
        return { id: `cus_stub_${++seq}`, object: 'customer', metadata: params.metadata ?? {} };
      },
    },
    checkout: {
      sessions: {
        create: async (params: Row) => {
          calls.sessionsCreate.push(params);
          const id = `cs_stub_${++seq}`;
          return { id, object: 'checkout.session', url: `https://checkout.stripe.test/${id}` };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: Row) => {
          calls.portalCreate.push(params);
          return { url: 'https://portal.stripe.test/ps_stub' };
        },
      },
    },
    subscriptions: {
      /*
       * The route asks Stripe, not the local row, whether anything live exists
       * — a missed webhook must not become a second monthly bill — so the stub
       * answers from its own registry, `status: 'all'` semantics included.
       */
      list: async (params: Row = {}) => ({
        object: 'list',
        data: Object.values(subs).filter(
          (s) => !params.customer || s.customer === params.customer,
        ),
        has_more: false,
      }),
      retrieve: async (id: string) => {
        calls.subscriptionsRetrieve.push(id);
        const sub = subs[id];
        if (!sub) throw new Error(`stripe stub: no such subscription: ${id}`);
        return sub;
      },
      update: async (id: string, params: Row = {}) => {
        calls.subscriptionsUpdate.push({ id, params });
        const sub = subs[id];
        if (!sub) throw new Error(`stripe stub: no such subscription: ${id}`);
        // Enough mutation to be coherent if the code reads the reply; the
        // authoritative apply still only happens through the webhook.
        const price = params.items?.[0]?.price;
        if (typeof price === 'string' && sub.items?.data?.[0]?.price) {
          sub.items.data[0].price.id = price;
        }
        if ('cancel_at_period_end' in params) sub.cancel_at_period_end = params.cancel_at_period_end;
        return sub;
      },
    },
    webhooks: {
      constructEvent: (body: unknown, signature: string, secret: string) => {
        // Real verification is Stripe's; what is under test is that the route
        // REFUSES when this throws and trusts the payload only when it does not.
        if (secret !== WEBHOOK_SECRET || signature !== GOOD_SIG) {
          throw new Error('Webhook signature verification failed');
        }
        const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
        return JSON.parse(raw);
      },
    },
  };

  // Loud on purpose, like the prisma stand-in: a Stripe surface the code
  // touches without the stub knowing is a call that would hit the network.
  const client = new Proxy(real, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then') return (target)[key as string];
      if (key in target) return target[key];
      return new Proxy(
        {},
        {
          get: (_t, method) => {
            if (typeof method === 'symbol' || method === 'then') return undefined;
            return () => {
              throw new Error(
                `stripe stub: client.${key}.${String(method)} is not implemented — extend makeStripe()`,
              );
            };
          },
        },
      );
    },
  });

  return { client, calls, subs };
}

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'user',
  'organization',
  'membership',
  'session',
  'subscription',
  'usageRecord',
  'project',
  'auditLog',
] as const;

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

/** Date/bigint-aware equality, so `period` and `quantity` compare by value. */
function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') return Number(a) === Number(b);
  return a === b;
}

function comparable(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  return v as number | string;
}

interface Relation {
  model: string;
  kind: 'one' | 'many';
  /** Field on THIS row holding the related id (membership.userId → user.id). */
  localKey?: string;
  /** Field on the RELATED row holding this row's id (subscription.orgId ← org.id). */
  foreignKey?: string;
}

/**
 * Just the joins billing-shaped code can plausibly take: reaching OWNERs from
 * an org for dunning mail, and hopping between org and subscription.
 */
const RELATIONS: Record<string, Record<string, Relation>> = {
  membership: {
    user: { model: 'user', kind: 'one', localKey: 'userId' },
    org: { model: 'organization', kind: 'one', localKey: 'orgId' },
  },
  subscription: { org: { model: 'organization', kind: 'one', localKey: 'orgId' } },
  project: { org: { model: 'organization', kind: 'one', localKey: 'orgId' } },
  organization: {
    memberships: { model: 'membership', kind: 'many', foreignKey: 'orgId' },
    subscription: { model: 'subscription', kind: 'one', foreignKey: 'orgId' },
  },
  user: { memberships: { model: 'membership', kind: 'many', foreignKey: 'userId' } },
};

interface ModelOptions {
  /** Org-owned, so the tenancy stand-in filters and stamps it. */
  scoped?: boolean;
  defaults?: Row;
}

const MODEL_OPTIONS: Record<string, ModelOptions> = {
  user: {
    defaults: {
      emailVerified: null,
      passwordHash: null,
      avatarUrl: null,
      isSuperuser: false,
      totpSecretEnc: null,
      totpEnabledAt: null,
      lastLoginAt: null,
    },
  },
  organization: { defaults: { plan: 'FREE', billingState: 'OK', limitOverrides: null } },
  membership: { scoped: true, defaults: { role: 'MEMBER' } },
  session: { defaults: { activeOrgId: null, ip: null, userAgent: null, revokedAt: null } },
  subscription: {
    defaults: {
      plan: 'FREE',
      status: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
  },
  usageRecord: { defaults: { quantity: 0n } },
  project: { scoped: true, defaults: { archivedAt: null } },
  auditLog: { scoped: true, defaults: {} },
};

const CLOCK_BASE = new Date('2026-08-01T00:00:00.000Z').getTime();

function makeDb() {
  const tables: Record<string, Row[]> = Object.fromEntries(MODELS.map((m) => [m, []]));
  let ids = 0;
  let ticks = 0;

  const resolveRelation = (rel: Relation, row: Row): Row | Row[] | null => {
    const list = tables[rel.model] ?? [];
    if (rel.kind === 'many') return list.filter((r) => r[rel.foreignKey!] === row.id);
    const found = rel.localKey
      ? list.find((r) => r.id === row[rel.localKey!])
      : list.find((r) => r[rel.foreignKey!] === row.id);
    return found ?? null;
  };

  function matches(model: string, row: Row, where: Row): boolean {
    for (const [key, cond] of Object.entries(flatten(where))) {
      if (cond === undefined) continue;
      if (key === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((c: Row) => matches(model, row, c))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!(cond as Row[]).some((c) => matches(model, row, c))) return false;
        continue;
      }
      if (key === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((c: Row) => matches(model, row, c))) return false;
        continue;
      }

      const rel = RELATIONS[model]?.[key];
      if (rel) {
        const related = resolveRelation(rel, row);
        if (rel.kind === 'one') {
          if (cond === null) {
            if (related) return false;
            continue;
          }
          const nested = (cond as Row).is ?? cond;
          if (!related || !matches(rel.model, related, nested as Row)) return false;
          continue;
        }
        const list = related as Row[];
        const filter = cond as Row;
        if ('some' in filter) {
          if (!list.some((r) => matches(rel.model, r, filter.some))) return false;
          continue;
        }
        if ('none' in filter) {
          if (list.some((r) => matches(rel.model, r, filter.none))) return false;
          continue;
        }
        if ('every' in filter) {
          if (!list.every((r) => matches(rel.model, r, filter.every))) return false;
          continue;
        }
        throw new Error(`fake prisma: unsupported relation filter on ${model}.${key}`);
      }

      const value = row[key];
      if (cond === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (cond instanceof Date) {
        if (!eq(value, cond)) return false;
        continue;
      }
      if (cond && typeof cond === 'object') {
        for (const [op, arg] of Object.entries(cond as Row)) {
          switch (op) {
            case 'equals':
              if (!eq(value, arg)) return false;
              break;
            case 'in':
              if (!(arg as unknown[]).some((x) => eq(value, x))) return false;
              break;
            case 'notIn':
              if ((arg as unknown[]).some((x) => eq(value, x))) return false;
              break;
            case 'not':
              if (arg === null) {
                if (value === null || value === undefined) return false;
              } else if (arg && typeof arg === 'object' && !(arg instanceof Date)) {
                throw new Error(`fake prisma: unsupported nested \`not\` on ${key}`);
              } else if (eq(value, arg)) return false;
              break;
            case 'lt':
              if (!(comparable(value) < comparable(arg))) return false;
              break;
            case 'lte':
              if (!(comparable(value) <= comparable(arg))) return false;
              break;
            case 'gt':
              if (!(comparable(value) > comparable(arg))) return false;
              break;
            case 'gte':
              if (!(comparable(value) >= comparable(arg))) return false;
              break;
            default:
              // Loud on purpose: a fake that shrugs at a filter it does not
              // know passes the tests whose whole point is that filter.
              throw new Error(
                `fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`,
              );
          }
        }
        continue;
      }
      if (!eq(value, cond)) return false;
    }
    return true;
  }

  function projectRow(model: string, row: Row, select?: Row, include?: Row): Row {
    if (select) {
      const out: Row = {};
      for (const [key, value] of Object.entries(select)) {
        if (!value) continue;
        const rel = RELATIONS[model]?.[key];
        if (rel) {
          const related = resolveRelation(rel, row);
          if (rel.kind === 'many') {
            out[key] = (related as Row[]).map((r) =>
              projectRow(rel.model, r, (value as Row).select, (value as Row).include),
            );
          } else {
            out[key] = related
              ? projectRow(rel.model, related, (value as Row).select, (value as Row).include)
              : null;
          }
          continue;
        }
        if (value === true) out[key] = row[key];
        else throw new Error(`fake prisma: unsupported nested select on ${model}.${key}`);
      }
      return out;
    }
    const out = { ...row };
    if (include) {
      for (const [key, value] of Object.entries(include)) {
        if (!value) continue;
        const rel = RELATIONS[model]?.[key];
        if (!rel) throw new Error(`fake prisma: unknown include on ${model}.${key}`);
        const related = resolveRelation(rel, row);
        if (rel.kind === 'many') {
          out[key] = (related as Row[]).map((r) =>
            value === true
              ? { ...r }
              : projectRow(rel.model, r, (value as Row).select, (value as Row).include),
          );
        } else {
          out[key] = related
            ? value === true
              ? { ...(related as Row) }
              : projectRow(rel.model, related, (value as Row).select, (value as Row).include)
            : null;
        }
      }
    }
    return out;
  }

  function sortRows(list: Row[], orderBy?: Row | Row[]): Row[] {
    const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
    if (!order) return list;
    const [key, direction] = Object.entries(order)[0]!;
    return [...list].sort((a, b) => {
      const left = comparable(a[key]);
      const right = comparable(b[key]);
      const cmp =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return direction === 'desc' ? -cmp : cmp;
    });
  }

  const makeModel = (name: string) => {
    const opts = MODEL_OPTIONS[name] ?? {};
    const rows = () => (tables[name] ??= []);

    const scope = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return opts.scoped && orgId ? { ...where, orgId } : where;
    };

    const find = (where: Row = {}, orderBy?: Row | Row[]): Row[] =>
      sortRows(
        rows().filter((r) => matches(name, r, scope(where))),
        orderBy,
      );

    const read = (row: Row | undefined | null, select?: Row, include?: Row): Row | null =>
      row ? projectRow(name, row, select, include) : null;

    const insert = (data: Row): Row => {
      const orgId = h.currentOrg();
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: new Date(CLOCK_BASE + ticks++),
        ...opts.defaults,
        ...(opts.scoped && orgId && data.orgId === undefined ? { orgId } : {}),
        ...data,
      };
      /*
       * `id` is unique here the way it is in Postgres, and violating it throws
       * the way Prisma throws (code P2002). Webhook idempotency is very often
       * "create the event row, treat the unique violation as already-seen" —
       * a fake that admits duplicate ids would fail that implementation while
       * the real database passed it.
       */
      if (rows().some((r) => r.id === row.id)) {
        const err = new Error(
          `fake prisma: unique constraint violated on ${name}.id`,
        ) as Error & { code: string; meta: { target: string[] } };
        err.code = 'P2002';
        err.meta = { target: ['id'] };
        throw err;
      }
      rows().push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select, include }: Row) =>
        read(find(where)[0], select, include),
      findFirst: async ({ where, select, include, orderBy }: Row = {}) =>
        read(find(where, orderBy)[0], select, include),
      findMany: async ({ where, select, include, orderBy, take }: Row = {}) => {
        const list = find(where, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) =>
          read(r, select, include),
        );
      },
      count: async ({ where }: Row = {}) => find(where).length,
      create: async ({ data, select, include }: Row) => read(insert(data), select, include),
      createMany: async ({ data, skipDuplicates }: Row) => {
        const list = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const item of list) {
          if (skipDuplicates && item.id !== undefined && rows().some((r) => r.id === item.id)) {
            continue;
          }
          insert(item);
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data, select, include }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data);
        return read(row, select, include);
      },
      updateMany: async ({ where, data }: Row = {}) => {
        const list = find(where);
        for (const row of list) Object.assign(row, data);
        return { count: list.length };
      },
      upsert: async ({ where, create, update, select, include }: Row) => {
        const row = find(where)[0];
        if (row) {
          Object.assign(row, update);
          return read(row, select, include);
        }
        return read(insert(create), select, include);
      },
      delete: async ({ where }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.delete matched no row`);
        rows().splice(rows().indexOf(row), 1);
        return row;
      },
      deleteMany: async ({ where }: Row = {}) => {
        const list = find(where);
        for (const row of list) rows().splice(rows().indexOf(row), 1);
        return { count: list.length };
      },
    };
  };

  const base: Row = {};

  /*
   * Rollback is not decoration here either: an idempotency guard that writes
   * its event row inside the same transaction as the state change must lose
   * both when the transaction fails, or a replay would be refused for an event
   * that never took effect.
   */
  base.$transaction = async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    const names = Object.keys(tables);
    const snapshot = names.map((m) => [m, tables[m]!.map((r) => ({ ...r }))] as const);
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(client);
    } catch (err) {
      for (const [name, saved] of snapshot) {
        tables[name]!.length = 0;
        tables[name]!.push(...saved);
      }
      for (const name of Object.keys(tables)) {
        if (!names.includes(name)) tables[name]!.length = 0;
      }
      throw err;
    }
  };

  const modelCache: Record<string, unknown> = {};
  /*
   * Models materialise on first touch rather than from a fixed list. The
   * idempotency and ordering fixes add a model this file cannot know the name
   * of yet (a webhook-event ledger, whatever it ends up being called); the
   * stand-in must store its rows rather than crash on the name, while unknown
   * FILTERS still throw. Loud where it matters, permissive where it cannot.
   */
  const client: Row = new Proxy(base, {
    get: (target, key) => {
      if (typeof key !== 'string') return target[key as unknown as string];
      if (key in target) return target[key];
      if (key.startsWith('$') || key === 'then') return undefined;
      return (modelCache[key] ??= makeModel(key));
    },
  });

  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { billingRouter, registerStripeWebhook } = await import('./billing.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
// Mirrors index.ts: the webhook prefix is raw bytes — the signature is over
// exactly what Stripe sent, and a re-serialised body would not match.
app.use('/webhooks', express.raw({ type: 'application/json', limit: '2mb' }));
app.use(express.json());
app.use('/billing', billingRouter);
const webhookRouter = express.Router();
registerStripeWebhook(webhookRouter);
app.use('/webhooks', webhookRouter);
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

/** Deliver a webhook event the way Stripe does: raw JSON plus a signature. */
async function deliver(event: Row, signature = GOOD_SIG): Promise<Reply> {
  const res = await fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(event),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

// ─── Stripe object fixtures ──────────────────────────────────────────────────

/** Epoch seconds, in Stripe's unit. Ordering tests offset from this base. */
const EVENT_BASE = 1_754_000_000;
const PERIOD_END = EVENT_BASE + 30 * 86_400;

let eventSeq = 0;
function stripeEvent(type: string, object: Row, over: Row = {}): Row {
  eventSeq += 1;
  return {
    id: `evt_stub_${eventSeq}`,
    object: 'event',
    api_version: '2026-01-01',
    created: EVENT_BASE + eventSeq,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
    ...over,
  };
}

function stripeSubscription(over: {
  id?: string;
  orgId?: string;
  customer?: string;
  status?: string;
  priceId?: string;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}): Row {
  return {
    id: over.id ?? 'sub_acme_1',
    object: 'subscription',
    customer: over.customer ?? 'cus_acme',
    status: over.status ?? 'active',
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    created: EVENT_BASE,
    metadata: over.orgId ? { orgId: over.orgId } : {},
    items: {
      object: 'list',
      data: [
        {
          id: 'si_acme_1',
          object: 'subscription_item',
          current_period_end: over.periodEnd ?? PERIOD_END,
          price: { id: over.priceId ?? TEAM_PRICE, object: 'price' },
        },
      ],
    },
  };
}

/**
 * Carries the org three ways — customer id, subscription id, and the metadata
 * under `parent.subscription_details` where current Stripe API versions put
 * it — so the handler may resolve it by any of them.
 */
function stripeInvoice(over: {
  customer?: string;
  subscriptionId?: string;
  orgId?: string;
  status?: string;
}): Row {
  const subscriptionId = over.subscriptionId ?? 'sub_acme_1';
  return {
    id: `in_stub_${++eventSeq}`,
    object: 'invoice',
    customer: over.customer ?? 'cus_acme',
    subscription: subscriptionId,
    status: over.status ?? 'open',
    billing_reason: 'subscription_cycle',
    metadata: {},
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: subscriptionId,
        metadata: over.orgId ? { orgId: over.orgId } : {},
      },
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof makeDb>;

let idSeq = 0;
const fixtureId = (prefix: string) => `${prefix}_fixture_${++idSeq}`;

function seedOrg(name: string, plan = 'FREE'): Row {
  const org = {
    id: fixtureId('org'),
    name,
    slug: `${name.toLowerCase()}-${idSeq}`,
    plan,
    billingState: 'OK',
    limitOverrides: null,
    createdAt: new Date(CLOCK_BASE),
  };
  db.tables.organization!.push(org);
  return org;
}

function seedUser(email: string): Row {
  const user = {
    id: fixtureId('user'),
    email,
    name: email.split('@')[0],
    passwordHash: 'scrypt$x',
    emailVerified: null,
    avatarUrl: null,
    isSuperuser: false,
    totpSecretEnc: null,
    totpEnabledAt: null,
    lastLoginAt: null,
    createdAt: new Date(CLOCK_BASE),
  };
  db.tables.user!.push(user);
  return user;
}

function seedMember(orgId: string, userId: string, role: string): void {
  db.tables.membership!.push({
    id: fixtureId('membership'),
    orgId,
    userId,
    role,
    createdAt: new Date(CLOCK_BASE + db.tables.membership!.length),
  });
}

/** A session faked the way one is minted: a row keyed by the SHA-256 of the cookie. */
function seedSession(userId: string, orgId: string): string {
  const raw = fixtureId('session-token');
  db.tables.session!.push({
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

function seedProject(orgId: string, name: string): void {
  db.tables.project!.push({
    id: fixtureId('project'),
    orgId,
    name,
    archivedAt: null,
    createdAt: new Date(CLOCK_BASE),
  });
}

/**
 * An org that bought a plan through Stripe: the local cache row, and the
 * subscription object on the stub's side of the API for retrieve/update.
 */
function seedBilledOrg(over: { plan?: 'TEAM' | 'BUSINESS'; status?: string } = {}) {
  const plan = over.plan ?? 'TEAM';
  const status = over.status ?? 'active';
  const cancelled = status === 'canceled';
  const org = seedOrg('Acme', cancelled ? 'FREE' : plan);
  const owner = seedUser('owner@acme-corp.test');
  seedMember(org.id, owner.id, 'OWNER');
  const cookie = seedSession(owner.id, org.id);

  db.tables.subscription!.push({
    id: fixtureId('subscription'),
    orgId: org.id,
    stripeCustomerId: 'cus_acme',
    stripeSubscriptionId: 'sub_acme_1',
    plan: cancelled ? 'FREE' : plan,
    status,
    currentPeriodEnd: new Date(PERIOD_END * 1000),
    cancelAtPeriodEnd: false,
    createdAt: new Date(CLOCK_BASE),
    updatedAt: new Date(CLOCK_BASE),
  });
  h.stripe.subs['sub_acme_1'] = stripeSubscription({
    orgId: org.id,
    status,
    priceId: plan === 'BUSINESS' ? BUSINESS_PRICE : TEAM_PRICE,
  });

  return { org, owner, cookie };
}

const orgRow = (id: string): Row => db.tables.organization!.find((o) => o.id === id)!;
const subRow = (orgId: string): Row | undefined =>
  db.tables.subscription!.find((s) => s.orgId === orgId);

/** Audit rows by action — the operator-facing names are part of the contract. */
const auditsFor = (action: string): Row[] =>
  db.tables.auditLog!.filter((r) => r.action === action);

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.mail.driver = 'console';
  h.mail.fail = false;
  h.mail.sent = [];
  h.stripe = makeStripe();
});

// ─────────────────────────────────────────────────────────────────────────────
// The billing screen
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /billing', () => {
  it('shows the plan, usage, and which plans are purchasable', async () => {
    const { cookie, org } = seedBilledOrg({ plan: 'TEAM' });
    seedProject(org.id, 'web');
    seedProject(org.id, 'api');

    const res = await call('GET', '/billing', { cookie });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'TEAM', paying: true, configured: true });
    expect(res.body.usage).toMatchObject({ projects: 2, runsThisMonth: 0 });
    const purchasable = Object.fromEntries(
      (res.body.catalogue as Row[]).map((c) => [c.plan, c.purchasable]),
    );
    // FREE has nothing to buy and Enterprise is a conversation; the two priced
    // tiers are the only links the screen may render.
    expect(purchasable).toEqual({ FREE: false, TEAM: true, BUSINESS: true, ENTERPRISE: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout — first purchase
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout with no subscription', () => {
  it('creates a checkout session, a customer carrying the orgId, and an audit row', async () => {
    const org = seedOrg('Acme');
    const owner = seedUser('owner@acme-corp.test');
    seedMember(org.id, owner.id, 'OWNER');
    const cookie = seedSession(owner.id, org.id);

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(String(res.body.url)).toContain('https://checkout.stripe.test/');

    // The customer carries the orgId: renewal webhooks arrive with the
    // customer, not the original session's metadata.
    expect(h.stripe.calls.customersCreate).toHaveLength(1);
    expect(h.stripe.calls.customersCreate[0]!.metadata).toMatchObject({ orgId: org.id });

    expect(h.stripe.calls.sessionsCreate).toHaveLength(1);
    const session = h.stripe.calls.sessionsCreate[0]!;
    expect(session.line_items).toEqual([{ price: TEAM_PRICE, quantity: 1 }]);
    // `pending=1` is the honest post-checkout UX: poll for the webhook rather
    // than declare victory on a redirect anyone can navigate to.
    expect(String(session.success_url)).toContain('pending=1');

    // The customer id is remembered so a later purchase reuses it — but the
    // PLAN has not moved: only the webhook does that.
    expect(subRow(org.id)).toMatchObject({ stripeCustomerId: 'cus_stub_1' });
    expect(orgRow(org.id).plan).toBe('FREE');

    expect(db.tables.auditLog!.some((r) => r.action === 'billing.checkout.start')).toBe(true);
  });

  it('is OWNER-only — billing moves money that belongs to whoever owns the account', async () => {
    const org = seedOrg('Acme');
    const admin = seedUser('ada@acme-corp.test');
    seedMember(org.id, admin.id, 'ADMIN');

    const res = await call('POST', '/billing/checkout', {
      cookie: seedSession(admin.id, org.id),
      body: { plan: 'TEAM' },
    });

    expect(res.status).toBe(403);
    expect(h.stripe.calls.sessionsCreate).toHaveLength(0);
  });

  it('a CANCELLED subscription buys again through a new session on the same customer', async () => {
    /*
     * The other side of the modify-in-place boundary: a dead subscription
     * cannot be "modified" back to life, and trying is the cancelled-plan bug
     * — the upgrade call errors at Stripe and the org can never re-subscribe.
     * Correct is a fresh session, on the EXISTING customer so the invoice
     * history survives.
     */
    const { org, cookie } = seedBilledOrg({ status: 'canceled' });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    expect(h.stripe.calls.subscriptionsUpdate).toHaveLength(0);
    expect(h.stripe.calls.sessionsCreate).toHaveLength(1);
    expect(h.stripe.calls.sessionsCreate[0]!.customer).toBe('cus_acme');
    expect(h.stripe.calls.customersCreate).toHaveLength(0);
    expect(String(res.body.url)).toContain('https://checkout.stripe.test/');
    expect(orgRow(org.id).plan).toBe('FREE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout with a live subscription — the double-charge path
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout with a live subscription', () => {
  it('MODIFIES the existing subscription and does not create a session', async () => {
    /*
     * The single most important test in this file. A checkout session in
     * `subscription` mode creates a NEW subscription; for an org that already
     * has a live one, that is two subscriptions billing the same team — the
     * double charge. An upgrade must be a modification of the subscription
     * that exists, and the only acceptable number of sessions is zero.
     */
    const { org, cookie } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'BUSINESS' } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, plan: 'BUSINESS' });
    expect(h.stripe.calls.sessionsCreate).toHaveLength(0);

    expect(h.stripe.calls.subscriptionsUpdate.length).toBeGreaterThan(0);
    const update = h.stripe.calls.subscriptionsUpdate[0]!;
    expect(update.id).toBe('sub_acme_1');
    // However the items are expressed, the Business price must be in them.
    expect(JSON.stringify(update.params)).toContain(BUSINESS_PRICE);

    /*
     * And the local rows have NOT moved. billing.ts's header rule: Stripe is
     * the source of truth and this app is a cache of it — the modification
     * comes back as a customer.subscription.updated webhook, which is what
     * moves the plan. A route that writes the plan here would make the webhook
     * ordering guard meaningless.
     */
    expect(orgRow(org.id).plan).toBe('TEAM');
    expect(subRow(org.id)!.plan).toBe('TEAM');

    // audit() every mutation that changes money state — an upgrade request is one.
    expect(auditsFor('billing.plan.change')).toHaveLength(1);
    expect(auditsFor('billing.plan.change')[0]!.metadata).toMatchObject({
      from: 'TEAM',
      to: 'BUSINESS',
    });
  });

  it('downgrade reports usage over the new limits and deletes nothing', async () => {
    /*
     * lib/plan.ts: limits gate the START of work, never the finish. A team
     * downgrading Business→Team with 5 projects (Team allows 3) keeps all
     * five — deleting or archiving customer data over a billing change is
     * indefensible — but the response must SAY what is over, because the
     * alternative is a team discovering the ceiling weeks later when a
     * project refuses to be created.
     */
    expect(PLAN_LIMITS.TEAM.maxProjects).toBe(3); // the premise of the fixture
    const { org, cookie } = seedBilledOrg({ plan: 'BUSINESS', status: 'active' });
    for (let i = 1; i <= 5; i += 1) seedProject(org.id, `project-${i}`);

    const res = await call('POST', '/billing/checkout', { cookie, body: { plan: 'TEAM' } });

    expect(res.status).toBe(200);
    // Same boundary as the upgrade: live subscription, so never a session.
    expect(h.stripe.calls.sessionsCreate).toHaveLength(0);
    expect(h.stripe.calls.subscriptionsUpdate.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.stripe.calls.subscriptionsUpdate[0]!.params)).toContain(TEAM_PRICE);

    // The over-limit report: which ceiling, how far over it, in the response
    // AND the audit row — the refusals plan.ts is about to start issuing on
    // "New project" must be explainable from both.
    expect(res.body.overLimit).toEqual([{ limit: 'projects', used: 5, max: 3 }]);
    expect(auditsFor('billing.plan.change')[0]!.metadata).toMatchObject({
      from: 'BUSINESS',
      to: 'TEAM',
      overLimit: [{ limit: 'projects', used: 5, max: 3 }],
    });

    // Nothing deleted, nothing archived, plan not moved locally.
    const projects = db.tables.project!.filter((p) => p.orgId === org.id);
    expect(projects).toHaveLength(5);
    expect(projects.every((p) => p.archivedAt === null)).toBe(true);
    expect(orgRow(org.id).plan).toBe('BUSINESS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The webhook — the only thing allowed to move a plan
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /webhooks/stripe', () => {
  it('refuses a bad signature without touching anything', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM' });
    const event = stripeEvent(
      'customer.subscription.updated',
      stripeSubscription({ orgId: org.id, priceId: BUSINESS_PRICE }),
    );

    const res = await deliver(event, 't=1,v1=forged');

    // This endpoint is the only thing that can grant a paid plan; a forgery
    // that moved state would be worth real money.
    expect(res.status).toBe(400);
    expect(orgRow(org.id).plan).toBe('TEAM');
    expect(subRow(org.id)!.plan).toBe('TEAM');
  });

  it('checkout.session.completed applies the purchased plan through the fetched subscription', async () => {
    const org = seedOrg('Acme');
    const owner = seedUser('owner@acme-corp.test');
    seedMember(org.id, owner.id, 'OWNER');
    h.stripe.subs['sub_acme_1'] = stripeSubscription({ orgId: org.id, priceId: TEAM_PRICE });

    const res = await deliver(
      stripeEvent('checkout.session.completed', {
        id: 'cs_stub_done',
        object: 'checkout.session',
        mode: 'subscription',
        customer: 'cus_acme',
        subscription: 'sub_acme_1',
        metadata: { orgId: org.id, plan: 'TEAM' },
      }),
    );

    expect(res.status).toBe(200);
    expect(orgRow(org.id).plan).toBe('TEAM');
    expect(subRow(org.id)).toMatchObject({
      plan: 'TEAM',
      status: 'active',
      stripeSubscriptionId: 'sub_acme_1',
      stripeCustomerId: 'cus_acme',
    });
  });

  it('subscription.deleted drops the org to FREE, keeps the row, and audits', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const res = await deliver(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription({ orgId: org.id, status: 'canceled', priceId: TEAM_PRICE }),
      ),
    );

    expect(res.status).toBe(200);
    expect(orgRow(org.id).plan).toBe('FREE');

    // Dropped, not deleted: the row holds the Stripe customer id, and losing
    // it orphans the invoice history the next time they subscribe.
    const sub = subRow(org.id);
    expect(sub).toMatchObject({ plan: 'FREE', status: 'canceled', stripeCustomerId: 'cus_acme' });

    // Losing a paying customer is a money-state change; it audits like one.
    const audits = auditsFor('billing.plan.applied');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.orgId).toBe(org.id);
    expect(audits[0]!.metadata).toMatchObject({ from: 'TEAM', to: 'FREE' });
  });

  it('an unknown price on subscription.updated cannot leave the org on its old paid plan silently', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const res = await deliver(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscription({ orgId: org.id, priceId: 'price_never_configured' }),
      ),
    );

    /*
     * A price this install cannot name means the STRIPE_PRICE_* env vars and
     * the Stripe account have drifted — an operator mistake. The pre-fix
     * behaviour was an early return: log a line, keep the org on TEAM forever,
     * with nobody billing for it and nothing recording why. The fixed contract
     * applies the state as FREE — the one plan that is always safe to grant —
     * so the org's entitlements track what is actually being paid for, and the
     * mistake surfaces as a support conversation instead of free Business.
     */
    expect(res.status).toBe(200);
    expect(orgRow(org.id).plan).toBe('FREE');
    expect(subRow(org.id)!.plan).toBe('FREE');

    // And not silently: the transition audits, with the reason attached, so
    // the operator who rotated the env can explain the org's sudden FREE.
    const audits = auditsFor('billing.plan.applied');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      from: 'TEAM',
      to: 'FREE',
      reason: 'unknown_price',
    });
  });

  it('a redelivered event id is processed once', async () => {
    /*
     * Stripe retries until it believes delivery succeeded, and believes in
     * at-least-once. The same event id arriving twice must be acknowledged
     * twice — a non-2xx on the replay would make Stripe retry forever — and
     * PROCESSED once. The fetch count is the tell: reprocessing the session
     * means fetching the subscription again.
     */
    const org = seedOrg('Acme');
    h.stripe.subs['sub_acme_1'] = stripeSubscription({ orgId: org.id, priceId: TEAM_PRICE });
    const event = stripeEvent('checkout.session.completed', {
      id: 'cs_stub_replay',
      object: 'checkout.session',
      mode: 'subscription',
      customer: 'cus_acme',
      subscription: 'sub_acme_1',
      metadata: { orgId: org.id, plan: 'TEAM' },
    });

    const first = await deliver(event);
    const second = await deliver(event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.stripe.calls.subscriptionsRetrieve).toHaveLength(1);
    expect(orgRow(org.id).plan).toBe('TEAM');
  });

  it('an older subscription.updated cannot regress a newer state', async () => {
    /*
     * Stripe does not guarantee order, and a retried event can arrive minutes
     * after the events that superseded it. Upgrade Team→Business, then replay
     * the older Team-priced update: last-write-wins would quietly bill the
     * customer for Business while the app enforces Team.
     */
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const newer = stripeEvent(
      'customer.subscription.updated',
      stripeSubscription({ orgId: org.id, priceId: BUSINESS_PRICE }),
      { created: EVENT_BASE + 500 },
    );
    const older = stripeEvent(
      'customer.subscription.updated',
      stripeSubscription({ orgId: org.id, priceId: TEAM_PRICE }),
      { created: EVENT_BASE + 100 },
    );

    const upgraded = await deliver(newer);
    expect(upgraded.status).toBe(200);
    expect(orgRow(org.id).plan).toBe('BUSINESS'); // the newer state took

    const replayed = await deliver(older);
    expect(replayed.status).toBe(200); // acknowledged — Stripe must not retry it

    expect(orgRow(org.id).plan).toBe('BUSINESS');
    expect(subRow(org.id)!.plan).toBe('BUSINESS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dunning — a failed card must reach a human who can fix it
// ─────────────────────────────────────────────────────────────────────────────

describe('invoice payment events', () => {
  it('payment_failed marks the org and mails every OWNER; invoice.paid clears it', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });
    const second = seedUser('odile@acme-corp.test');
    seedMember(org.id, second.id, 'OWNER');
    const member = seedUser('mel@acme-corp.test');
    seedMember(org.id, member.id, 'MEMBER');

    const failed = await deliver(
      stripeEvent('invoice.payment_failed', stripeInvoice({ orgId: org.id })),
    );
    expect(failed.status).toBe(200);

    /*
     * The mark is record-and-notify only: `billingState` gates nothing, by
     * design — whether a past-due org keeps paid limits is Stripe's `past_due`
     * status arriving on its own subscription event, not a side effect a
     * webhook handler gets to invent. So the durable record IS the contract:
     * the row, and the audit trail.
     */
    expect(orgRow(org.id).billingState).toBe('PAST_DUE');
    expect(auditsFor('billing.payment.failed')).toHaveLength(1);
    expect(auditsFor('billing.payment.failed')[0]!.orgId).toBe(org.id);

    /*
     * OWNERs are who can fix a card — billing is OWNER-only — so they are who
     * the mail must reach. Not the members: a payment problem is not their
     * surface, and mailing a whole org about money is how billing mail gets
     * marked as spam.
     */
    const recipients = h.mail.sent.map((m) => m.to).join(' ');
    expect(recipients).toContain('owner@acme-corp.test');
    expect(recipients).toContain('odile@acme-corp.test');
    expect(recipients).not.toContain('mel@acme-corp.test');
    expect(h.mail.sent[0]!.subject).toMatch(/payment/i);

    // The card gets fixed, Stripe collects, and the mark must come OFF — a
    // PAST_DUE that survives payment is a stale warning nobody can clear.
    const paid = await deliver(
      stripeEvent('invoice.paid', stripeInvoice({ orgId: org.id, status: 'paid' })),
    );
    expect(paid.status).toBe(200);

    expect(orgRow(org.id).billingState).toBe('OK');
    expect(auditsFor('billing.payment.recovered')).toHaveLength(1);
    expect(orgRow(org.id).plan).toBe('TEAM'); // dunning never moves the plan itself
  });
});

describe('invoice event ordering and redelivery', () => {
  /*
   * Stripe does not promise delivery order, and the harm of assuming it does
   * is concrete: a payment_failed that arrives AFTER the paid that superseded
   * it would mark a healthy org PAST_DUE and mail every OWNER a false alarm
   * that stands until the next renewal. The guard is the same single-clock
   * rule applySubscription uses — Stripe's event.created, nobody's else.
   */
  it('a payment_failed older than the paid already applied is refused', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const paid = await deliver(
      stripeEvent('invoice.paid', stripeInvoice({ orgId: org.id, status: 'paid' }), {
        created: EVENT_BASE + 5_000,
      }),
    );
    expect(paid.status).toBe(200);

    const mailsBefore = h.mail.sent.length;
    const staleFailure = await deliver(
      stripeEvent('invoice.payment_failed', stripeInvoice({ orgId: org.id }), {
        created: EVENT_BASE + 4_000,
      }),
    );
    expect(staleFailure.status).toBe(200);

    // No false alarm: state untouched, nobody mailed, nothing audited.
    expect(orgRow(org.id).billingState).toBe('OK');
    expect(h.mail.sent.length).toBe(mailsBefore);
    expect(auditsFor('billing.payment.failed')).toHaveLength(0);
  });

  it('an older paid cannot clear a newer failure', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const failed = await deliver(
      stripeEvent('invoice.payment_failed', stripeInvoice({ orgId: org.id }), {
        created: EVENT_BASE + 5_000,
      }),
    );
    expect(failed.status).toBe(200);
    expect(orgRow(org.id).billingState).toBe('PAST_DUE');

    const stalePaid = await deliver(
      stripeEvent('invoice.paid', stripeInvoice({ orgId: org.id, status: 'paid' }), {
        created: EVENT_BASE + 4_000,
      }),
    );
    expect(stalePaid.status).toBe(200);

    // The failure is the newer fact; an old receipt does not erase it.
    expect(orgRow(org.id).billingState).toBe('PAST_DUE');
    expect(auditsFor('billing.payment.recovered')).toHaveLength(0);
  });

  it('a redelivered event id runs its side effects exactly once', async () => {
    const { org } = seedBilledOrg({ plan: 'TEAM', status: 'active' });

    const event = stripeEvent('invoice.payment_failed', stripeInvoice({ orgId: org.id }));
    const first = await deliver(event);
    expect(first.status).toBe(200);
    const mailsAfterFirst = h.mail.sent.length;
    expect(mailsAfterFirst).toBeGreaterThan(0);

    /*
     * The SAME event object — same id — the way Stripe redelivers after a
     * timeout. The claim-first insert makes the second delivery a no-op:
     * acknowledged as a duplicate, and crucially nobody is dunned twice.
     */
    const second = await deliver(event);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    expect(h.mail.sent.length).toBe(mailsAfterFirst);
    expect(auditsFor('billing.payment.failed')).toHaveLength(1);
  });
});
