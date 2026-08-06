/**
 * Prisma client + the multi-tenancy enforcement layer (§1).
 *
 * The rule: no query is trusted to scope itself. A request runs inside
 * `withTenant(orgId, fn)`, and this extension rewrites every operation on an
 * org-owned model to carry that orgId — filtering reads, stamping writes, and
 * post-verifying the unique-lookup operations that cannot take an extra filter.
 *
 * Escaping the scope is possible but must be explicit and greppable:
 * `unscoped(fn)`. Login (email → user, before any org is known), the worker's
 * cross-org queue drain, and the retention sweeper are the legitimate users.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * Models that genuinely have no `orgId` column. Everything else is org-owned and
 * gets scoped. Listed explicitly so adding a model is a conscious decision — a
 * new org-owned model left out of the schema's orgId convention will throw at
 * runtime rather than leak across tenants.
 */
const GLOBAL_MODELS = new Set([
  'User',
  'OAuthAccount',
  'Session',
  'VerificationToken',
  'Organization', // scoped by `id`, not `orgId` — handled separately
  'FeatureFlag',
  // Webhook replay guard. A Stripe event id arrives before we know which org
  // it is for, so the table has no orgId to scope by.
  'StripeEventSeen',
]);

/**
 * Org-owned models reached only through a parent relation. They carry orgId and
 * are scoped like the rest; this list exists purely as documentation of intent.
 */
const ORG_OWNED_CHILD_MODELS = new Set(['Step', 'Finding', 'TestVersion', 'ChatMessage']);

type TenantStore = { orgId: string | null; unscoped: boolean };

const tenantStore = new AsyncLocalStorage<TenantStore>();

/**
 * Both helpers wrap the callback in an `async` function rather than passing it
 * to `run()` directly, and that detail is load-bearing.
 *
 * Prisma promises are lazy: `prisma.user.findUnique(...)` builds a thenable but
 * does not issue the query until something awaits it. Handing the raw callback
 * to `AsyncLocalStorage.run()` therefore returns an unexecuted promise, the
 * scope exits, and the query finally runs with no tenant context at all —
 * silently unscoped. Awaiting inside the async wrapper keeps execution within
 * the scope, which is the entire point of these functions.
 */

/** Runs `fn` with every org-owned query pinned to `orgId`. */
export function withTenant<T>(orgId: string, fn: () => T | Promise<T>): Promise<T> {
  return tenantStore.run({ orgId, unscoped: false }, async () => fn());
}

/**
 * Runs `fn` with tenancy enforcement disabled. Use only where no org exists yet
 * or the operation is legitimately cross-org, and say why at the call site.
 */
export function unscoped<T>(fn: () => T | Promise<T>): Promise<T> {
  return tenantStore.run({ orgId: null, unscoped: true }, async () => fn());
}

export function currentTenant(): string | null {
  return tenantStore.getStore()?.orgId ?? null;
}

class TenancyError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

/** Operations whose `where` accepts arbitrary filters. */
const FILTERABLE = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/** Operations whose `where` must be a unique selector — filter after the fact. */
const UNIQUE_LOOKUP = new Set(['findUnique', 'findUniqueOrThrow']);

/** Unique-selector mutations: verify the row belongs to the tenant, then proceed. */
const UNIQUE_MUTATION = new Set(['update', 'delete']);

function mergeWhere(args: Record<string, unknown>, orgId: string): Record<string, unknown> {
  const existing = (args.where ?? {}) as Record<string, unknown>;
  return { ...args, where: { ...existing, orgId } };
}

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  log: env.LOG_LEVEL === 'trace' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/**
 * The extension is *transparent*: it rewrites arguments and re-checks ownership
 * but returns exactly the shapes the base client would. Prisma's types cannot
 * express that — wrapping `$allOperations` collapses payload inference, so
 * `include` and `select` stop narrowing the result.
 *
 * Casting back to the base client's type restores inference without changing
 * behaviour. The cast is the reason `extended` is kept separate below: if the
 * extension ever starts reshaping results, this stops being true and the cast
 * must go.
 */
const extended = basePrisma.$extends({
  name: 'qaai-tenancy',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const store = tenantStore.getStore();

        // No tenant context at all: allow, but make it visible. This is the
        // shape a bug takes — a query that ran outside any request scope.
        if (!store) {
          logger.warn({ model, operation }, 'prisma query ran with no tenant context');
          return query(args);
        }
        if (store.unscoped) return query(args);

        const orgId = store.orgId;
        if (!orgId) throw new TenancyError(`No org in scope for ${model}.${operation}`);

        // Organization is scoped by its primary key rather than an orgId column.
        if (model === 'Organization') {
          if (FILTERABLE.has(operation)) {
            const a = (args ?? {}) as Record<string, unknown>;
            const existing = (a.where ?? {}) as Record<string, unknown>;
            return query({ ...a, where: { ...existing, id: orgId } });
          }
          const result = await query(args);
          if (result && typeof result === 'object' && 'id' in result && result.id !== orgId) {
            return null;
          }
          return result;
        }

        if (GLOBAL_MODELS.has(model)) return query(args);

        const a = (args ?? {}) as Record<string, unknown>;

        if (FILTERABLE.has(operation)) {
          return query(mergeWhere(a, orgId));
        }

        if (operation === 'create') {
          const data = (a.data ?? {}) as Record<string, unknown>;
          return query({ ...a, data: { ...data, orgId } });
        }

        if (operation === 'createMany' || operation === 'createManyAndReturn') {
          const data = a.data;
          const stamped = Array.isArray(data)
            ? data.map((row) => ({ ...(row as Record<string, unknown>), orgId }))
            : { ...(data as Record<string, unknown>), orgId };
          return query({ ...a, data: stamped });
        }

        if (operation === 'upsert') {
          const create = (a.create ?? {}) as Record<string, unknown>;
          const where = (a.where ?? {}) as Record<string, unknown>;
          // `where` on upsert must stay a unique selector, so the guarantee here
          // is on the create side; a cross-tenant update path would require the
          // caller to already know a unique key from another org.
          return query({ ...a, create: { ...create, orgId }, where });
        }

        if (UNIQUE_LOOKUP.has(operation)) {
          // A unique lookup cannot take an extra filter, so ownership is checked
          // on the result. That requires orgId to actually be in the result —
          // and a caller-supplied `select` will happily omit it. Add it for the
          // check, then strip it back out so the caller gets the shape it asked
          // for. Without this, every narrow select silently returns null.
          const select = a.select as Record<string, unknown> | undefined;
          const orgIdWasRequested = !select || select.orgId === true;
          const args = orgIdWasRequested ? a : { ...a, select: { ...select, orgId: true } };

          const result = (await query(args)) as Record<string, unknown> | null;
          if (result && result.orgId !== orgId) {
            // Indistinguishable from "not found" — never confirm existence.
            if (operation === 'findUniqueOrThrow') {
              throw new TenancyError(`No ${model} found`);
            }
            return null;
          }
          if (result && !orgIdWasRequested) delete result.orgId;
          return result;
        }

        if (UNIQUE_MUTATION.has(operation)) {
          const where = (a.where ?? {}) as Record<string, unknown>;
          // Pre-flight ownership check. Costs one indexed read; buys the guarantee
          // that a leaked id from another org cannot be written through.
          const owner = (await (
            basePrisma as unknown as Record<
              string,
              { findUnique: (x: unknown) => Promise<unknown> }
            >
          )[lowerFirst(model)]!.findUnique({ where, select: { orgId: true } })) as {
            orgId?: string;
          } | null;

          if (!owner) throw new TenancyError(`No ${model} found`);
          if (owner.orgId !== orgId) throw new TenancyError(`No ${model} found`);
          return query(a);
        }

        return query(a);
      },
    },
  },
});

export const prisma = extended as unknown as typeof basePrisma;

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export type Prisma = typeof prisma;

/** Exposed for tests and for the enum-drift check. */
export const _internal = { GLOBAL_MODELS, ORG_OWNED_CHILD_MODELS };

export async function disconnectPrisma(): Promise<void> {
  await basePrisma.$disconnect();
}
