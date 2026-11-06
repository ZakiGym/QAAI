/**
 * Tests for the SSO routes, aimed almost entirely at SAML (§1, §9).
 *
 * The survey found the login page offering a "Sign in with SSO" button that led
 * nowhere for SAML, and the reason turned out not to be the one written on the
 * tin. The *return* leg was complete and had been for a while: a real XML
 * signature verifier (lib/saml-verifier.ts) registered at the composition root,
 * every condition check in `checkSamlAssertion`, replay guarded by a unique
 * index. What did not exist was the *outbound* leg — `/sso/start` refused
 * `protocol === 'SAML'` outright, nothing ever built an `<AuthnRequest>`, and
 * `SsoLoginRequest.samlRequestId` was a column nothing wrote.
 *
 * So what is being proven here, in order of how expensive the bug would be:
 *
 *   1. **The entrance exists and binds.** /sso/start returns a real HTTP-Redirect
 *      binding whose deflated AuthnRequest carries the same ID that lands in
 *      `samlRequestId`, and the ACS then requires the assertion to echo THAT —
 *      not the login request's row id, which is a database key no identity
 *      provider has ever seen. Both halves are driven through the real routes,
 *      so the test would fail if either end changed alone.
 *   2. **Signature verification has no opt-out.** With no verifier registered,
 *      /sso/start refuses before the browser leaves and the ACS refuses on the
 *      way in. A verifier that throws refuses too, issues no session, and its
 *      message — which interpolates values read out of the attacker's XML — is
 *      not reflected into the login page's query string.
 *   3. **Replay stays load-bearing.** Two posts of one assertion id yield one
 *      session. The fake enforces the `@@unique([connectionId, assertionId])`
 *      index from schema.prisma, because without that constraint modelled the
 *      test would pass with the guard deleted.
 *   4. **Org isolation on every admin endpoint**, and on the login path: a
 *      RelayState minted at one org's connection is treated as absent at
 *      another's, which drops the flow into the strictly stricter
 *      IdP-initiated rules rather than trusting it.
 *   5. **A half-configured connection says which half.** "SAML is not
 *      available" was a lie told to administrators who had simply not pasted a
 *      certificate in yet; each missing field now names itself.
 *
 * Harness: the shape accounts.test.ts and integrations.test.ts use — a mocked
 * prisma module over a real AsyncLocalStorage tenant scope, the real router
 * driven over a loopback socket. `lib/sso.ts` is mocked ONLY to swap
 * `samlVerifier()`; every trust decision in it (`checkSamlAssertion`,
 * `assertedEmailIsInScope`, `safeOutboundUrl`, `clampJitRole`,
 * `safeRelativePath`) runs for real, and so does the vault. The XML signature
 * check itself is covered by lib/saml-verifier.test.ts — stubbing it here is
 * how the route's plumbing gets tested without turning this file into a second
 * copy of that one.
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import { guardUrl, resolveEgressPolicy } from '@qaai/shared';
import type { EgressGuardIo, EgressPermit } from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
import type { SsoEgressGuard } from '../lib/sso.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const API_PUBLIC_URL = 'https://api.qaai.test';
const WEB_PUBLIC_URL = 'https://app.qaai.test';
const IDP_SSO_URL = 'https://idp.acme.test/sso/saml';
const IDP_ENTITY_ID = 'https://idp.acme.test/entity';
const IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  /*
   * `scopes` is part of the actor because `requireScope` is the real function
   * now. A session actor holds the `'*'` sentinel, which is what a human with a
   * role holds in production — an actor with no `scopes` at all would make the
   * real guard throw and the stub-shaped hole would reopen as a 500.
   */
  actor: { userId: string; orgId: string; role: string; ip: string | null; scopes: string[] };
  audits: Row[];
  /** Which orgs are on a plan that includes SSO. */
  ssoOrgs: Set<string>;
  /** null = no verifier registered on this deployment. */
  samlVerify: ((xml: string, certs: string[]) => Row) | null;
  verifyCalls: Array<{ xml: string; certs: string[] }>;
  txt: (host: string) => Promise<string[][]>;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_admin', orgId: 'org_a', role: 'ADMIN', ip: null, scopes: ['*'] },
  audits: [],
  ssoOrgs: new Set<string>(),
  samlVerify: null,
  verifyCalls: [],
  txt: async () => {
    throw new Error('ENOTFOUND');
  },
}));

vi.mock('../env.js', () => ({
  env: {
    // hashToken() is an HMAC keyed on this; without it every token
    // digest throws. A fixed value keeps the digests stable across runs.
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PUBLIC_URL,
    WEB_PUBLIC_URL,
    SESSION_TTL_HOURS: 72,
    // 32 bytes, so the real vault seals and opens for real on the admin path.
    VAULT_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
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

vi.mock('node:dns', () => ({ promises: { resolveTxt: (host: string) => h.txt(host) } }));

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
  h.currentOrg = () => store.getStore()?.orgId ?? null;

  return {
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
    withTenant: <T>(orgId: string, fn: () => T | Promise<T>) =>
      store.run({ orgId }, async () => fn()),
    unscoped: <T>(fn: () => T | Promise<T>) => store.run({ orgId: null }, async () => fn()),
    currentTenant: () => store.getStore()?.orgId ?? null,
    disconnectPrisma: async () => {},
  };
});

/*
 * `requireAuth` is replaced because this file has no session rows and no
 * cookies; everything else is the REAL middleware.
 *
 * `requireScope` USED TO BE A PASS-THROUGH STUB HERE — `() => (…) => next()` —
 * and that is the test-fake trap the house rules name: with it in place,
 * adding `requireScope` to any route in sso.ts would be undetectable, and
 * deleting one already there would be too. It is now the real exported
 * function, which is a pure predicate over `req.actor.scopes`, so the stub
 * cannot absorb a control. That is also why `h.actor` carries `scopes`.
 */
vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>();
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    SESSION_COOKIE: 'qaai_session',
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
    requireScope: actual.requireScope,
    actorOf: (req: Row) => req.actor,
  };
});

vi.mock('../lib/audit.js', () => ({
  audit: async (input: unknown) => {
    h.audits.push(input as Row);
  },
}));

vi.mock('../lib/plan.js', () => ({
  hasFeature: async (orgId: string) => h.ssoOrgs.has(orgId),
}));

/*
 * `lib/sso.ts` is mocked for exactly ONE export.
 *
 * `samlVerifier()` reads a module-level global that `registerSamlVerifier()`
 * only ever sets — there is no way to put it back to null, and "is this
 * refused when no verifier is registered" is one of the three things this file
 * exists to prove. Everything else comes through untouched, which matters more
 * than it looks: `SsoError` must stay the same class object or `failToLogin`'s
 * `instanceof` stops matching and every refusal turns into a logged 500.
 */
vi.mock('../lib/sso.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    samlVerifier: () =>
      h.samlVerify
        ? {
            verify: (xml: string, certs: string[]) => {
              h.verifyCalls.push({ xml, certs });
              return h.samlVerify!(xml, certs);
            },
          }
        : null,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'ssoConnection',
  'ssoDomain',
  'ssoLoginRequest',
  'ssoAssertionSeen',
  'user',
  'membership',
  'session',
] as const;
type ModelName = (typeof MODELS)[number];
type Tables = Record<ModelName, Row[]>;

/** Compound-unique `where` keys, flattened the way Prisma names them. */
const COMPOUND_KEYS: Record<string, string[]> = { orgId_userId: ['orgId', 'userId'] };

function flatten(where: Row = {}): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(where)) {
    const parts = COMPOUND_KEYS[key];
    if (parts && value && typeof value === 'object') {
      for (const part of parts) out[part] = (value as Row)[part];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const filter = cond as Row;
      if ('not' in filter) {
        if (filter.not === null) {
          if (value === null || value === undefined) return false;
          continue;
        }
        if (value === filter.not) return false;
        continue;
      }
      if ('gt' in filter) {
        if (!(value instanceof Date) || value.getTime() <= (filter.gt as Date).getTime()) {
          return false;
        }
        continue;
      }
      if ('lt' in filter) {
        if (!(value instanceof Date) || value.getTime() >= (filter.lt as Date).getTime()) {
          return false;
        }
        continue;
      }
      if ('in' in filter) {
        if (!(filter.in as unknown[]).includes(value)) return false;
        continue;
      }
      // Loud on purpose: a fake that shrugs at a filter it does not understand
      // passes the tests whose whole point is that the filter is applied.
      throw new Error(`fake prisma: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
    }
    if (value !== cond) return false;
  }
  return true;
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

interface Relation {
  target: ModelName;
  many: boolean;
  resolve: (row: Row, tables: Tables) => Row[];
}

const RELATIONS: Partial<Record<ModelName, Record<string, Relation>>> = {
  ssoConnection: {
    domains: {
      target: 'ssoDomain',
      many: true,
      resolve: (row, tables) => tables.ssoDomain.filter((d) => d.connectionId === row.id),
    },
  },
  ssoDomain: {
    connection: {
      target: 'ssoConnection',
      many: false,
      resolve: (row, tables) => tables.ssoConnection.filter((c) => c.id === row.connectionId),
    },
  },
};

function project(name: ModelName, row: Row, select: Row | undefined, tables: Tables): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) {
      out[key] = row[key];
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const relation = RELATIONS[name]?.[key];
    if (!relation) throw new Error(`fake prisma: ${name}.${key} is not a modelled relation`);
    const opts = value as Row;
    const resolved = relation
      .resolve(row, tables)
      .filter((r) => matches(r, flatten((opts.where ?? {}) as Row)));
    const ordered = sortRows(resolved, opts.orderBy as Row | undefined);
    out[key] = relation.many
      ? ordered.map((r) => project(relation.target, r, opts.select as Row, tables))
      : ordered[0]
        ? project(relation.target, ordered[0], opts.select as Row, tables)
        : null;
  }
  return out;
}

interface ModelOptions {
  /** Filtered and stamped by the tenancy extension (i.e. not in GLOBAL_MODELS). */
  scoped?: boolean;
  defaults?: Row;
  /**
   * Unique indexes from schema.prisma, modelled because a route relies on the
   * INSERT failing. Without these the replay test would pass with the guard
   * deleted, which is the exact failure mode the house rules call out.
   */
  unique?: string[][];
}

const MODEL_OPTIONS: Record<ModelName, ModelOptions> = {
  ssoConnection: {
    scoped: true,
    defaults: {
      enabled: true,
      defaultRole: 'MEMBER',
      oidcIssuer: null,
      oidcClientId: null,
      oidcClientSecretEnc: null,
      oidcKeyVersion: null,
      oidcScopes: [],
      samlIdpEntityId: null,
      samlSsoUrl: null,
      samlIdpCertsPem: [],
    },
  },
  ssoDomain: { scoped: true, defaults: { verifiedAt: null }, unique: [['domain']] },
  ssoLoginRequest: {
    scoped: true,
    defaults: {
      nonceHash: null,
      pkceVerifierEnc: null,
      keyVersion: null,
      samlRequestId: null,
      redirectTo: null,
      ip: null,
      consumedAt: null,
    },
    unique: [['stateHash']],
  },
  ssoAssertionSeen: { scoped: true, unique: [['connectionId', 'assertionId']] },
  user: {
    defaults: {
      name: null,
      passwordHash: null,
      emailVerified: null,
      isSuperuser: false,
      lastLoginAt: null,
    },
    unique: [['email']],
  },
  membership: { scoped: true, defaults: { role: 'MEMBER' }, unique: [['orgId', 'userId']] },
  session: { defaults: { activeOrgId: null, ip: null, userAgent: null, revokedAt: null } },
};

const CLOCK_BASE = new Date('2026-08-01T00:00:00.000Z').getTime();

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Tables;
  let ids = 0;
  let ticks = 0;

  const makeModel = (name: ModelName) => {
    const opts = MODEL_OPTIONS[name];
    const rows = () => tables[name];

    const scope = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      return opts.scoped && orgId ? { ...flatten(where), orgId } : flatten(where);
    };
    const find = (where: Row = {}, orderBy?: Row): Row[] =>
      sortRows(
        rows().filter((r) => matches(r, scope(where))),
        orderBy,
      );
    const read = (row: Row | undefined, select?: Row): Row | null =>
      row ? project(name, row, select, tables) : null;

    const insert = (data: Row): Row => {
      const orgId = h.currentOrg();
      const stamp = new Date(CLOCK_BASE + ticks++);
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: stamp,
        updatedAt: stamp,
        ...opts.defaults,
        ...(opts.scoped && orgId && data.orgId === undefined ? { orgId } : {}),
        ...data,
      };
      for (const keys of opts.unique ?? []) {
        // Modelled from schema.prisma, and it throws the way Prisma does: the
        // route's only signal that an assertion has been seen before.
        if (rows().some((existing) => keys.every((k) => existing[k] === row[k]))) {
          throw new Error(`fake prisma: unique constraint on ${name}(${keys.join(',')})`);
        }
      }
      rows().push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select }: Row) => read(find(where)[0], select),
      findUniqueOrThrow: async ({ where, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.findUniqueOrThrow matched no row`);
        return read(row, select);
      },
      findFirst: async ({ where, select, orderBy }: Row = {}) =>
        read(find(where, orderBy)[0], select),
      findMany: async ({ where, select, orderBy, take }: Row = {}) => {
        const list = find(where, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) => read(r, select)!);
      },
      create: async ({ data, select }: Row) => read(insert(data), select),
      update: async ({ where, data, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data, { updatedAt: new Date(CLOCK_BASE + ticks++) });
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
      deleteMany: async ({ where }: Row = {}) => {
        const list = find(where);
        for (const row of list) rows().splice(rows().indexOf(row), 1);
        return { count: list.length };
      },
    };
  };

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { ssoRouter, configureSsoEgress, ssoTransportCounts, resetSsoTransportCounts } =
  await import('./sso.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const { hashToken } = await import('../lib/crypto.js');
const { spAcsUrl, spEntityId, domainVerificationRecord } = await import('../lib/sso.js');

const app = express();
app.use(express.json());
// The ACS is reached by an HTTP-POST binding from the identity provider, which
// is a form post — index.ts mounts the same parser, globally.
app.use(express.urlencoded({ extended: false }));
app.use('/sso', ssoRouter);
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
  location: string;
  cookies: string[];
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  form?: Record<string, string>,
): Promise<Reply> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    // Manual: every refusal on the login path IS a redirect, and following it
    // would leave the test asserting on the login page instead of on us.
    redirect: 'manual',
    headers: form
      ? { 'content-type': 'application/x-www-form-urlencoded' }
      : body === undefined
        ? {}
        : { 'content-type': 'application/json' },
    ...(form
      ? { body: new URLSearchParams(form).toString() }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Row = {};
  try {
    parsed = text ? (JSON.parse(text) as Row) : {};
  } catch {
    parsed = {};
  }
  return {
    status: res.status,
    body: parsed,
    text,
    location: res.headers.get('location') ?? '',
    cookies: res.headers.getSetCookie(),
  };
}

/** The sentence the API put on the login page, decoded. */
function ssoError(reply: Reply): string {
  const url = new URL(reply.location, WEB_PUBLIC_URL);
  return url.searchParams.get('sso_error') ?? '';
}

/*
 * ── THE ALLOWED VERDICT USED TO BE A FAKE THAT COULD ABSORB THE CONTROL ────
 *
 * It read `{ kind: 'UNPINNED', url, host }`, cast through `unknown` — a shape
 * `guardUrl` has never produced. `EgressPermit` has exactly two members, PINNED
 * and OBSERVED, and the point of that is that a caller must decide what to do
 * with each. A permit of a third kind sent `providerFetch` down the OBSERVE
 * branch, so the pinned arm would have had NO test at all and this round's
 * actual fix could have been deleted with this file green.
 *
 * It now takes the REAL permit the real `guardUrl` builds, which is also why
 * {@link pinnedPermitFor} exists rather than a literal.
 */
const allowedVerdict = (permit: EgressPermit) =>
  ({ ok: true, permit }) as Awaited<ReturnType<SsoEgressGuard>>;

/**
 * A PINNED PERMIT FROM THE REAL GUARD, with one address substituted.
 *
 * Built by driving the shipped `guardUrl` with a fake resolver, so every field
 * — `decision`, `pinnedAt`, `fromLiteral`, the context — is the shape
 * production produces and not a literal that can drift from it.
 *
 * THE ONE INVENTED FACT is the address, swapped for a loopback one so no socket
 * this file opens can leave the machine. `classifyAddress('127.0.0.1')` is
 * `loopback` and SSO_METADATA may never reach one in any deployment, so the real
 * guard will never issue this permit — which is exactly the point: the swap
 * stands in for the attacker's second DNS answer, and the tests assert the
 * transport goes to the SUBSTITUTED address and never asks the resolver.
 */
async function pinnedPermitFor(host: string, address: string): Promise<EgressPermit> {
  const io: EgressGuardIo = {
    classifyHost: (h) => classifyHost(h),
    classifyAddress: (a) => classifyAddress(a),
    lookup: async () => [{ address: '93.184.216.34' }],
    now: () => new Date('2026-11-05T00:00:00.000Z'),
    monotonicMs: () => 0,
    delay: async () => {},
  };
  const verdict = await guardUrl({
    url: `https://${host}/.well-known/openid-configuration`,
    context: 'SSO_METADATA',
    policy: resolveEgressPolicy(undefined),
    io,
  });
  if (!verdict.ok) throw new Error('the real guard refused the fixture host');
  const permit = verdict.permit;
  if (permit.kind !== 'PINNED') throw new Error('the real guard issued no pin');
  return { ...permit, pinned: { ...permit.pinned, addresses: [{ address, class: 'loopback' }] } };
}

let db: ReturnType<typeof makeDb>;

const acsUrl = (connectionId: string) => spAcsUrl(API_PUBLIC_URL, connectionId);
const SP_ENTITY_ID = spEntityId(API_PUBLIC_URL);

function seedConnection(over: Row = {}): Row {
  const row: Row = {
    id: 'conn_a',
    orgId: 'org_a',
    protocol: 'SAML',
    name: 'Acme IdP',
    enabled: true,
    defaultRole: 'MEMBER',
    oidcIssuer: null,
    oidcClientId: null,
    oidcClientSecretEnc: null,
    oidcKeyVersion: null,
    oidcScopes: [],
    samlIdpEntityId: IDP_ENTITY_ID,
    samlSsoUrl: IDP_SSO_URL,
    samlIdpCertsPem: [IDP_CERT],
    createdAt: new Date(CLOCK_BASE),
    updatedAt: new Date(CLOCK_BASE),
    ...over,
  };
  db.tables.ssoConnection.push(row);
  return row;
}

function seedDomain(connection: Row, over: Row = {}): Row {
  const row: Row = {
    id: `dom_${connection.id}`,
    orgId: connection.orgId,
    connectionId: connection.id,
    domain: 'acme.test',
    verificationToken: 'tok-acme',
    verifiedAt: new Date(CLOCK_BASE),
    createdAt: new Date(CLOCK_BASE),
    ...over,
  };
  db.tables.ssoDomain.push(row);
  return row;
}

/** A verified assertion, as the signature verifier would hand it back. */
function factsFor(connection: Row, over: Row = {}): Row {
  return {
    signedSubtree: 'ASSERTION',
    id: '_assertion_1',
    issuer: IDP_ENTITY_ID,
    audiences: [SP_ENTITY_ID],
    destination: null,
    recipient: acsUrl(connection.id),
    inResponseTo: null,
    conditionsNotBefore: null,
    conditionsNotOnOrAfter: new Date(Date.now() + 300_000),
    subjectNotOnOrAfter: null,
    nameId: 'ada@acme.test',
    attributes: { email: ['ada@acme.test'] },
    ...over,
  };
}

/** Drives /sso/start and returns what the IdP would have been handed. */
async function startSaml(connectionId: string, next?: string) {
  const reply = await call(
    'GET',
    `/sso/start/${connectionId}${next ? `?next=${encodeURIComponent(next)}` : ''}`,
  );
  if (reply.status !== 302 || !reply.location.startsWith(IDP_SSO_URL)) return { reply };
  const url = new URL(reply.location);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString(
    'utf8',
  );
  return { reply, url, xml, relayState: url.searchParams.get('RelayState')! };
}

const SAML_RESPONSE = Buffer.from('<samlp:Response/>', 'utf8').toString('base64');

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_admin', orgId: 'org_a', role: 'ADMIN', ip: null, scopes: ['*'] };
  h.audits.length = 0;
  h.ssoOrgs = new Set(['org_a', 'org_b']);
  h.verifyCalls.length = 0;
  // The deployment default under test: a verifier IS registered (index.ts does
  // it at boot). The tests that need the other case say so explicitly.
  h.samlVerify = (_xml, _certs) => factsFor({ id: 'conn_a' });
  h.txt = async () => {
    throw new Error('ENOTFOUND');
  };
});

// ─── The outbound leg ────────────────────────────────────────────────────────

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

describe('the outbound leg resolves the provider host before a secret travels to it', () => {
  /*
   * ── THE DEFECT ────────────────────────────────────────────────────────────
   *
   * `providerFetch` checked the provider URL with `safeOutboundUrl`, which is a
   * PATTERN MATCH THAT NEVER RESOLVES: it refuses `localhost`, a bare name and
   * the recognisable internal spellings, and answers "not internal" for any
   * name with a dot. So `https://idp.attacker.test` whose single A record is
   * 169.254.169.254 was accepted with ZERO DNS queries — on the function that
   * carries the OIDC client secret to the token endpoint.
   *
   * `guardOutboundUrl` is the resolving version. It was written, tested, and
   * left with NO PRODUCTION CALLER; one of its own test blocks in lib/sso.ts is
   * titled "the guard production actually gets". These tests are what make that
   * title true.
   *
   * The guard is injected rather than built inline so this can be driven with a
   * fake: a control that needs real DNS to test is a control nobody tests.
   */
  /*
   * The shapes the real guard returns, built here rather than inlined so the
   * tests cannot drift from `GuardVerdict`. These are full verdicts on purpose:
   * a partial literal typechecks in a test file that vitest never typechecks,
   * which is how a fake comes to assert a shape production does not produce.
   */
  const refusedVerdict = () =>
    ({
      ok: false,
      refusal: 'CLASS_NOT_PERMITTED',
      operatorDetail: 'link-local 169.254.169.254',
      context: 'SSO_METADATA',
      decision: null,
      target: null,
      paddedMs: 0,
    }) as Awaited<ReturnType<SsoEgressGuard>>;


  afterEach(() => {
    configureSsoEgress(null);
  });

  it('REFUSES a provider whose host resolves inside, before any request leaves', async () => {
    const asked: string[] = [];
    let fetched = 0;
    const realFetch = globalThis.fetch;
    /*
     * Counts only requests to the PROVIDER. `call()` reaches the router over a
     * loopback socket with this same global, so a bare counter counts the
     * test's own request and reads as "something leaked" on a clean run.
     */
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchUrlOf(input).includes('attacker.test')) fetched += 1;
      return realFetch(input, init);
    };
    configureSsoEgress(() => Promise.resolve((url: string) => {
      asked.push(url);
      // What the real guard answers for a name whose records point at IMDS.
      return Promise.resolve(refusedVerdict());
    }));

    const connection = seedConnection({ protocol: 'OIDC', oidcIssuer: 'https://idp.attacker.test', oidcClientId: 'client_1' });
    seedDomain(connection);
    const reply = await call('GET', `/sso/start/${connection.id}`);
    globalThis.fetch = realFetch;

    // The guard was consulted, with the discovery URL derived from the issuer.
    expect(asked).toEqual(['https://idp.attacker.test/.well-known/openid-configuration']);
    // And NOTHING left the process.
    expect(fetched).toBe(0);
    /*
     * 302 and not a 4xx: this router answers a failed login by redirecting to
     * the sign-in page with an error, which is the house style for a surface a
     * browser lands on. What matters is WHERE — it must not be the IdP, and it
     * must not carry the refusal's detail in the URL, which would make the
     * redirect itself the oracle.
     */
    expect(reply.status).toBe(302);
    const location = reply.location;
    expect(location).not.toContain('attacker.test');
    expect(location).not.toContain('169.254');
    expect(location).not.toContain('CLASS_NOT_PERMITTED');
  });

  it('does not tell the caller WHY it was refused', async () => {
    // An SSO failure renders at a sign-in page to whoever typed the issuer URL.
    // A message distinguishing "that is a link-local address" from "that host
    // did not resolve" turns a broken login into a port scanner for our own
    // network, with a readable report.
    configureSsoEgress(() => Promise.resolve(() => Promise.resolve(refusedVerdict())));

    const connection = seedConnection({ protocol: 'OIDC', oidcIssuer: 'https://idp.attacker.test', oidcClientId: 'client_1' });
    seedDomain(connection);
    const reply = await call('GET', `/sso/start/${connection.id}`);

    const body = JSON.stringify(reply.body ?? {});
    expect(body).not.toContain('169.254.169.254');
    expect(body).not.toContain('link-local');
    expect(body).not.toContain('CLASS_NOT_PERMITTED');
  });

  it('consults the guard for EVERY outbound leg, not only discovery', async () => {
    /*
     * Discovery, JWKS, the token endpoint and userinfo all go through
     * `providerFetch`, which is the point of putting the guard there rather
     * than at one call site: a provider that passes discovery can still name a
     * JWKS or token URL pointing inside, and the token leg is the one carrying
     * the client secret.
     */
    const asked: string[] = [];
    configureSsoEgress(() => Promise.resolve((url: string) => {
      asked.push(url);
      return Promise.resolve(refusedVerdict());
    }));

    const connection = seedConnection({ protocol: 'OIDC', oidcIssuer: 'https://idp.attacker.test', oidcClientId: 'client_1' });
    seedDomain(connection);
    await call('GET', `/sso/start/${connection.id}`);

    // One leg reached, and it was guarded. The others are unreachable from here
    // because this one refused — which is the fail-closed ordering we want.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/.well-known/openid-configuration');
  });

  it('lets a provider on a public host through, so the guard is not a blanket refusal', async () => {
    /*
     * The other half: without this, the three tests above would also pass if
     * `providerFetch` simply always threw.
     *
     * ── IT NO LONGER STUBS GLOBAL `fetch`, BECAUSE THAT WOULD PROVE NOTHING ──
     *
     * It used to install a `globalThis.fetch` returning a 200 discovery
     * document. The pinned arm does not call `fetch` — that was the defect — so
     * the stub is no longer on the path and a test built on it would be
     * asserting about a function production stopped calling. What this asserts
     * instead is that the guard was consulted and the request REACHED THE
     * TRANSPORT: `providerFetch` counted a pinned outcome, which it only does
     * after `pinnedRequest` has opened (or failed to open) a real socket.
     *
     * The socket itself cannot succeed here, and that is a property of the
     * path rather than of this test: `safeOutboundUrl` pins every provider URL
     * to https on the default port, and an unprivileged process cannot listen
     * on 443 (MEASURED: `listen EACCES 127.0.0.1:443`). The transport's
     * delivery of a real request and a real body is proved against a real
     * loopback socket in `packages/shared/src/pinned-request.test.ts`.
     */
    const issuerHost = 'idp.acme.test';
    const asked: string[] = [];
    resetSsoTransportCounts();
    const permit = await pinnedPermitFor(issuerHost, '127.0.0.1');
    configureSsoEgress(() => Promise.resolve((url: string) => {
      asked.push(url);
      return Promise.resolve(allowedVerdict(permit));
    }));

    const connection = seedConnection({ protocol: 'OIDC', oidcIssuer: `https://${issuerHost}`, oidcClientId: 'client_1' });
    seedDomain(connection);
    await call('GET', `/sso/start/${connection.id}`);

    /*
     * `endpointsFor` memoises discovery in a MODULE-LEVEL `discoveryCache` that
     * no test resets, so a sibling test that already warmed this issuer would
     * make the guard look unconsulted here. Assert on the issuer this test owns
     * and tolerate the cache by checking the guard saw it OR a transport
     * outcome was counted — what must never be true is that neither happened.
     */
    const counts = ssoTransportCounts();
    const attempted = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(asked.length + attempted).toBeGreaterThan(0);
    if (asked.length > 0) {
      expect(asked[0]).toBe(`https://${issuerHost}/.well-known/openid-configuration`);
      // The PINNED arm, not the OBSERVE one. A fabricated permit shape used to
      // make this go down the unpinned branch without anything noticing.
      expect(counts.get('OBSERVED_BY_NAME')).toBeUndefined();
      expect(attempted).toBe(1);
    }
  });
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PIN, AT THE SOCKET, DRIVEN THROUGH THE REAL ROUTE AGAINST A REAL SOCKET.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, AS AN ADVERSARY MEASURED IT ────────────────────────────
 *
 * `guardOutboundUrl` resolved the provider name, classified every address and
 * PINNED them — and then `providerFetch` called global `fetch(url)` BY NAME,
 * which resolves independently. Two DNS queries per request, with no cache
 * between them, so whoever owns the zone answers the second one differently and
 * the OIDC client secret goes wherever they like. No timing precision; 100%
 * reliable.
 *
 * ── WHAT THIS BLOCK MEASURES, AND WHY THAT IS THE RIGHT MEASUREMENT ────────
 *
 * The defect WAS the second DNS query. So the test counts them: it patches the
 * REAL `dns.lookup` — the one `node:net` consults, reached through
 * `createRequire` because this file mocks the `node:dns` ESM module — to record
 * every call and to answer `127.0.0.1`, which is exactly the attacker's second
 * answer. A loopback server stands in for the internal host.
 *
 * MEASURED on this tree before writing these tests, with a probe against a
 * loopback server:
 *
 *   http.request BY NAME                 -> dns.lookup called ONCE, server HIT
 *   http.request through an agent lookup -> dns.lookup called ZERO times
 *   global fetch BY NAME                 -> dns.lookup called ONCE, server HIT
 *
 * So "zero recorded system lookups during a real /sso/start" is not a proxy for
 * the fix; it is the fix, stated as a number. Revert `sendPinned` to
 * `fetch(target.href, …)` — the exact old code — and the count becomes 1.
 *
 * ── AND WHAT IT CANNOT MEASURE HERE, STATED RATHER THAN IMPLIED ───────────
 *
 * `safeOutboundUrl` requires https on the DEFAULT PORT, so every provider URL
 * this path can produce is port 443 — and an unprivileged process cannot
 * listen there (MEASURED: `listen EACCES 127.0.0.1:443`). The loopback server
 * below therefore CANNOT be reached at the URL's port whichever transport runs,
 * so `hits === []` alone would be a VACUOUS assertion and is not what these
 * tests rest on. It is asserted anyway, because it is the thing that would
 * break if a future transport rewrote the URL to an address literal with a
 * port of its own. The non-vacuous assertions are the lookup count and which
 * arm of `providerFetch` ran.
 *
 * That the pinned transport DELIVERS a request and returns a body is proved
 * against a real loopback socket in `packages/shared/src/pinned-request.test.ts`,
 * where the URL is free to carry a port.
 */
describe('the pinned transport: the socket goes where the guard said', () => {
  /** The real `dns.lookup`, which `node:net` consults — `node:dns` is mocked here. */
  const nodeDns = createRequire(import.meta.url)('dns') as typeof import('node:dns');

  const servers: import('node:http').Server[] = [];

  /** A loopback server standing in for the internal host, recording every hit. */
  async function internalServer(): Promise<{ port: number; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: 'whatever' }));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return { port: address.port, hits };
  }

  /**
   * REBIND THE NAME, the way an attacker who owns the zone does.
   *
   * Returns the recorded hostnames and a restore function. The answer is
   * `127.0.0.1` so that a transport which resolves the name reaches THIS
   * machine rather than the internet — nothing in this file may reach a host
   * the test does not control.
   */
  function rebind(name: string): { asked: string[]; restore: () => void } {
    const asked: string[] = [];
    const real = nodeDns.lookup;
    const patched = (host: string, options: unknown, callback?: unknown): void => {
      if (host !== name) {
        (real as unknown as (...args: unknown[]) => void)(host, options, callback);
        return;
      }
      asked.push(host);
      const done = (typeof options === 'function' ? options : callback) as (
        err: Error | null,
        address?: unknown,
        family?: number,
      ) => void;
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
      done(null, all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
    };
    // @ts-expect-error the builtin is patched deliberately; `net` reads it at call time.
    nodeDns.lookup = patched;
    return {
      asked,
      restore: () => {
        nodeDns.lookup = real;
      },
    };
  }

  afterEach(() => {
    configureSsoEgress(null);
    for (const server of servers.splice(0)) server.close();
  });

  it('makes ZERO DNS queries of its own, so a rebound name reaches nothing', async () => {
    const issuerHost = 'sso.pin-socket.test';
    const internal = await internalServer();
    const rebound = rebind(issuerHost);
    resetSsoTransportCounts();

    const permit = await pinnedPermitFor(issuerHost, '127.0.0.1');
    const asked: string[] = [];
    configureSsoEgress(() =>
      Promise.resolve((url: string) => {
        asked.push(url);
        return Promise.resolve(allowedVerdict(permit));
      }),
    );

    const connection = seedConnection({
      protocol: 'OIDC',
      oidcIssuer: `https://${issuerHost}`,
      // Without this the route returns early, BEFORE discovery, and the whole
      // test passes while measuring nothing.
      oidcClientId: 'client_1',
    });
    seedDomain(connection);

    let reply: Reply;
    try {
      reply = await call('GET', `/sso/start/${connection.id}`);
    } finally {
      rebound.restore();
    }

    // The guard WAS consulted, once, for the discovery URL derived from the issuer.
    expect(asked).toEqual([`https://${issuerHost}/.well-known/openid-configuration`]);

    /*
     * THE ASSERTION THIS WHOLE ROUND IS FOR. The transport asked the SYSTEM
     * RESOLVER nothing. Before the fix it asked it once — and that second
     * query, answered `127.0.0.1` by whoever owns the zone, is how the client
     * secret reached an internal host with an `authorization` header on it.
     */
    expect(rebound.asked).toEqual([]);

    // And the pinned arm ran: a real socket was opened to 127.0.0.1:443 and the
    // kernel refused it. Not the OBSERVE arm, which would have connected by name.
    const counts = ssoTransportCounts();
    expect(counts.get('OBSERVED_BY_NAME')).toBeUndefined();
    expect((counts.get('TRANSPORT_FAILED') ?? 0) + (counts.get('TIMED_OUT') ?? 0)).toBe(1);

    // Nothing reached the stand-in internal server. See the block header for
    // why this is a guard against a future transport and not the discriminator.
    expect(internal.hits).toEqual([]);

    // The login page gets the refusal, and no part of it is an oracle.
    expect(reply.status).toBe(302);
    expect(reply.location).not.toContain('127.0.0.1');
    expect(reply.location).not.toContain(issuerHost);
    expect(reply.location).not.toContain('TRANSPORT_FAILED');
  });

  it('refuses a permit pinned to a DIFFERENT host than the URL names', async () => {
    /*
     * A caller that pinned `a` and then passed a URL for `b` would send b's
     * path to a's addresses under b's Host header — worse than no pin at all.
     * `providerFetch` obtains the permit per URL so this cannot happen by
     * accident, and the transport refuses it if it ever does.
     */
    const issuerHost = 'sso.pin-mismatch.test';
    const internal = await internalServer();
    const rebound = rebind(issuerHost);
    resetSsoTransportCounts();

    const permit = await pinnedPermitFor('sso.somewhere-else.test', '127.0.0.1');
    configureSsoEgress(() => Promise.resolve(() => Promise.resolve(allowedVerdict(permit))));

    const connection = seedConnection({
      protocol: 'OIDC',
      oidcIssuer: `https://${issuerHost}`,
      oidcClientId: 'client_1',
    });
    seedDomain(connection);

    let reply: Reply;
    try {
      reply = await call('GET', `/sso/start/${connection.id}`);
    } finally {
      rebound.restore();
    }

    expect(ssoTransportCounts().get('HOST_NOT_THE_PINNED_ONE')).toBe(1);
    expect(rebound.asked).toEqual([]);
    expect(internal.hits).toEqual([]);
    expect(reply.status).toBe(302);
    // The uniform egress sentence, not a helpful one naming either host.
    expect(ssoError(reply)).not.toContain(issuerHost);
    expect(ssoError(reply)).not.toContain('somewhere-else');
  });

  it('REFUSES a body over the cap instead of parsing the part it read', async () => {
    /*
     * ── A CAP THAT WAS NOT THERE AT ALL ───────────────────────────────
     *
     * `providerFetch` read `await response.text()` with NO limit, on a leg
     * reachable by an ANONYMOUS GET /sso/start, so a provider — or whatever a
     * rebound name pointed at — could stream until the process died. The round
     * that wired the pin was briefed that "every call site already has a
     * documented cap"; this one did not, and `PROVIDER_RESPONSE_MAX_BYTES` is
     * new rather than restated.
     *
     * TRUNCATION IS A REFUSAL, NOT A SHORT ANSWER. Parsing the part that fit
     * would hand `parseDiscovery` a half-document, and an administrator would
     * be told "your provider has no `issuer`" — a lie about the provider, and
     * the kind of lie that sends somebody to the wrong vendor's support desk.
     *
     * Driven through the OBSERVE arm because that is the arm that still uses
     * global `fetch`, which a stub can answer; the pinned arm's own cap is
     * `maxBytes`, which `pinned-request.test.ts` proves against a real socket.
     */
    const issuerHost = 'sso.pin-toobig.test';
    resetSsoTransportCounts();

    const realFetch = globalThis.fetch;
    let served = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (!fetchUrlOf(input).includes(issuerHost)) return realFetch(input, init);
      served += 1;
      // Comfortably over 256 KiB, and valid JSON so a parse could not be what
      // refuses it — the cap has to be the thing that does.
      return Promise.resolve(
        new Response(JSON.stringify({ issuer: `https://${issuerHost}`, pad: 'x'.repeat(400_000) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    const io: EgressGuardIo = {
      classifyHost: (h) => classifyHost(h),
      classifyAddress: (a) => classifyAddress(a),
      lookup: async () => [{ address: '169.254.169.254' }],
      now: () => new Date('2026-11-05T00:00:00.000Z'),
      monotonicMs: () => 0,
      delay: async () => {},
    };
    configureSsoEgress(() =>
      Promise.resolve((url: string) =>
        guardUrl({
          url,
          context: 'SSO_METADATA',
          policy: resolveEgressPolicy({ deployment: 'HOSTED', mode: 'OBSERVE' }),
          io,
        }),
      ),
    );

    const connection = seedConnection({
      protocol: 'OIDC',
      oidcIssuer: `https://${issuerHost}`,
      oidcClientId: 'client_1',
    });
    seedDomain(connection);

    let reply: Reply;
    try {
      reply = await call('GET', `/sso/start/${connection.id}`);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(served).toBe(1);
    // Refused, not redirected to the identity provider.
    expect(reply.status).toBe(302);
    expect(reply.location).toContain('sso_error');
    expect(ssoError(reply)).toContain('larger response than QAAI will read');
    // And NOT the message a half-parsed document would have produced: the
    // refusal names the SIZE, not a field the provider is accused of omitting.
    expect(ssoError(reply)).not.toContain('discovery document');
    expect(ssoError(reply)).not.toContain('has no');
  });

  it('connects BY NAME under the OBSERVE brake, and counts that it did', async () => {
    /*
     * ── THE CONVERSE OF FAIL-CLOSED, AND IT MATTERS AS MUCH ───────────────
     *
     * An OBSERVED permit authorises NO address, so `pinnedRequest` answers
     * NOT_PINNED. Refusing on that would make the OBSERVE brake a silent
     * enforcement switch — the opposite of what it promises — so this arm
     * connects by name exactly as the code did before the pin existed. The
     * rebinding window is open for those connections, which is why the only
     * acceptable way to ship it is to COUNT it.
     *
     * The system resolver IS consulted here, and that asymmetry with the test
     * above is the whole evidence that the pinned arm's zero is caused by the
     * pin and not by something incidental to this harness.
     */
    const issuerHost = 'sso.pin-observe.test';
    const internal = await internalServer();
    const rebound = rebind(issuerHost);
    resetSsoTransportCounts();

    const io: EgressGuardIo = {
      classifyHost: (h) => classifyHost(h),
      classifyAddress: (a) => classifyAddress(a),
      lookup: async () => [{ address: '169.254.169.254' }],
      now: () => new Date('2026-11-05T00:00:00.000Z'),
      monotonicMs: () => 0,
      delay: async () => {},
    };
    configureSsoEgress(() =>
      Promise.resolve((url: string) =>
        guardUrl({
          url,
          context: 'SSO_METADATA',
          policy: resolveEgressPolicy({ deployment: 'HOSTED', mode: 'OBSERVE' }),
          io,
        }),
      ),
    );

    const connection = seedConnection({
      protocol: 'OIDC',
      oidcIssuer: `https://${issuerHost}`,
      oidcClientId: 'client_1',
    });
    seedDomain(connection);

    try {
      await call('GET', `/sso/start/${connection.id}`);
    } finally {
      rebound.restore();
    }

    const counts = ssoTransportCounts();
    expect(counts.get('OBSERVED_BY_NAME')).toBe(1);
    // No pinned outcome was recorded: the pinned arm did not run.
    expect(counts.get('PINNED_SENT')).toBeUndefined();
    expect(counts.get('NOT_PINNED')).toBeUndefined();
    // And the name WAS resolved by the system resolver — by name is what
    // OBSERVE promises, and the count above is the honest record of it.
    expect(rebound.asked).toEqual([issuerHost]);
    // Still unreachable at port 443, so nothing actually arrived; the point of
    // this test is which arm ran, not what answered.
    expect(internal.hits).toEqual([]);
  });
});

describe('GET /sso/start/:id — SAML', () => {
  it('sends an AuthnRequest whose ID is the value stored as samlRequestId', async () => {
    const connection = seedConnection();
    seedDomain(connection);

    const { reply, url, xml, relayState } = await startSaml(connection.id);

    expect(reply.status).toBe(302);
    expect(url!.origin + url!.pathname).toBe(IDP_SSO_URL);

    const request = db.tables.ssoLoginRequest[0]!;
    /*
     * The whole feature in one assertion: the ID inside the deflated
     * AuthnRequest is the value the ACS will later demand as InResponseTo. It
     * is read out of the redirect the route actually produced and compared
     * against the row the route actually wrote, so neither end can drift.
     */
    expect(xml).toContain(`ID="${request.samlRequestId}"`);
    expect(request.samlRequestId).toBeTruthy();

    /*
     * xsd:ID means NCName, which may not begin with a digit — and a base64url
     * token does about a sixth of the time. So the underscore is asserted
     * literally rather than by pattern: a pattern check passes five times in
     * six with the prefix deleted, which would leave a bug that fails against
     * strict IdPs on roughly one login in six and gets called "flaky SSO" for
     * a year. (Confirmed: removing the prefix does not move a pattern-only
     * assertion.)
     */
    expect(String(request.samlRequestId).startsWith('_')).toBe(true);
    expect(request.samlRequestId).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

    expect(xml).toContain(`Destination="${IDP_SSO_URL}"`);
    expect(xml).toContain(`AssertionConsumerServiceURL="${acsUrl(connection.id)}"`);
    expect(xml).toContain(`<saml:Issuer>${SP_ENTITY_ID}</saml:Issuer>`);
    expect(xml).toContain('ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"');
    // Unsigned by design, and our metadata advertises exactly that.
    expect(xml).not.toContain('SignatureValue');

    // RelayState is the single-use state token, stored only as a hash — the
    // same treatment the OIDC leg gives it.
    expect(hashToken(relayState!)).toBe(request.stateHash);
    expect(relayState!.length).toBeLessThanOrEqual(80);

    // Anonymous caller: the org comes from the connection, never from a header.
    expect(request.orgId).toBe('org_a');
    expect(request.connectionId).toBe(connection.id);
    expect(request.consumedAt).toBeNull();
  });

  it('carries ?next through to the login request row, and rejects an off-site one', async () => {
    const connection = seedConnection();
    seedDomain(connection);

    await startSaml(connection.id, '/runs/run_7');
    expect(db.tables.ssoLoginRequest[0]!.redirectTo).toBe('/runs/run_7');

    await call('GET', `/sso/start/${connection.id}?next=https://evil.test/steal`);
    expect(db.tables.ssoLoginRequest[1]!.redirectTo).toBe('/runs');
  });

  it('names the missing sign-on URL instead of refusing SAML in general', async () => {
    const connection = seedConnection({ samlSsoUrl: null });
    seedDomain(connection);

    const reply = await call('GET', `/sso/start/${connection.id}`);
    expect(reply.status).toBe(302);
    expect(reply.location.startsWith(`${WEB_PUBLIC_URL}/login`)).toBe(true);
    expect(ssoError(reply)).toContain('sign-on URL');
    // Nothing in flight: a login that cannot start must not leave a row behind.
    expect(db.tables.ssoLoginRequest).toHaveLength(0);
  });

  it('names the missing IdP entity id', async () => {
    const connection = seedConnection({ samlIdpEntityId: null });
    seedDomain(connection);
    expect(ssoError(await call('GET', `/sso/start/${connection.id}`))).toContain('entity id');
  });

  it('names the missing signing certificate', async () => {
    const connection = seedConnection({ samlIdpCertsPem: [] });
    seedDomain(connection);

    const reply = await call('GET', `/sso/start/${connection.id}`);
    expect(ssoError(reply)).toContain('signing certificate');
    expect(db.tables.ssoLoginRequest).toHaveLength(0);
  });

  it('refuses at the door when no signature verifier is registered', async () => {
    h.samlVerify = null;
    const connection = seedConnection();
    seedDomain(connection);

    const reply = await call('GET', `/sso/start/${connection.id}`);
    expect(ssoError(reply)).toContain('not available on this deployment');
    /*
     * The point of refusing here rather than at the ACS: nobody is sent to
     * their identity provider, made to authenticate, and turned away on the
     * doorstep — which looks to them like their password was wrong.
     */
    expect(db.tables.ssoLoginRequest).toHaveLength(0);
  });

  it('re-validates the stored sign-on URL at the point of use', async () => {
    // A row written before `safeOutboundUrl` guarded the column, or by a future
    // path that forgets to. Rows outlive the validation in force when written.
    const connection = seedConnection({ samlSsoUrl: 'http://idp.acme.test/sso' });
    seedDomain(connection);

    const reply = await call('GET', `/sso/start/${connection.id}`);
    expect(ssoError(reply)).toContain('https');
    expect(db.tables.ssoLoginRequest).toHaveLength(0);
  });

  it('refuses a disabled connection, an unverified domain, and an org off the plan', async () => {
    const disabled = seedConnection({ id: 'conn_off', enabled: false });
    seedDomain(disabled, { id: 'dom_off' });
    expect(ssoError(await call('GET', '/sso/start/conn_off'))).toContain('turned off');

    const unverified = seedConnection({ id: 'conn_unver' });
    seedDomain(unverified, { id: 'dom_unver', domain: 'other.test', verifiedAt: null });
    expect(ssoError(await call('GET', '/sso/start/conn_unver'))).toContain(
      'no verified email domain',
    );

    const offPlan = seedConnection({ id: 'conn_free', orgId: 'org_free' });
    seedDomain(offPlan, { id: 'dom_free', domain: 'free.test' });
    expect(ssoError(await call('GET', '/sso/start/conn_free'))).toContain('Business');

    expect(db.tables.ssoLoginRequest).toHaveLength(0);
  });
});

// ─── The return leg ──────────────────────────────────────────────────────────

describe('POST /sso/saml/:id/acs', () => {
  it('signs in an SP-initiated login whose assertion answers the AuthnRequest', async () => {
    const connection = seedConnection();
    seedDomain(connection);

    const { relayState } = await startSaml(connection.id, '/runs/run_9');
    const requestId = db.tables.ssoLoginRequest[0]!.samlRequestId as string;
    h.samlVerify = () => factsFor(connection, { inResponseTo: requestId });

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
      RelayState: relayState!,
    });

    expect(reply.status).toBe(302);
    expect(reply.location).toBe(`${WEB_PUBLIC_URL}/runs/run_9`);
    expect(reply.cookies.join(';')).toContain('qaai_session=');

    const user = db.tables.user[0]!;
    expect(user.email).toBe('ada@acme.test');
    // JIT accounts have no password to guess; that is the point of them.
    expect(user.passwordHash).toBeNull();
    expect(db.tables.membership[0]).toMatchObject({ orgId: 'org_a', role: 'MEMBER' });
    expect(db.tables.session[0]).toMatchObject({ userId: user.id, activeOrgId: 'org_a' });
    // Single-use: the state row is spent even though the login succeeded.
    expect(db.tables.ssoLoginRequest[0]!.consumedAt).not.toBeNull();
  });

  it('refuses an assertion that echoes the login request row id instead of the AuthnRequest ID', async () => {
    /*
     * The regression this change exists to fix. The ACS used to pass the login
     * request's PRIMARY KEY as the expected InResponseTo — a cuid the identity
     * provider has never seen and could not echo — so every real SP-initiated
     * assertion was refused, and the only value that WOULD have satisfied it is
     * the one asserted here.
     */
    const connection = seedConnection();
    seedDomain(connection);

    const { relayState } = await startSaml(connection.id);
    const row = db.tables.ssoLoginRequest[0]!;
    expect(row.samlRequestId).not.toBe(row.id);
    h.samlVerify = () => factsFor(connection, { inResponseTo: row.id as string });

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
      RelayState: relayState!,
    });

    expect(ssoError(reply)).toContain('does not answer the request this browser made');
    expect(db.tables.session).toHaveLength(0);
  });

  it('accepts an IdP-initiated assertion, and refuses one that claims to answer a request', async () => {
    const connection = seedConnection();
    seedDomain(connection);

    h.samlVerify = () => factsFor(connection, { inResponseTo: null });
    const ok = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });
    expect(ok.location).toBe(`${WEB_PUBLIC_URL}/runs`);
    expect(db.tables.session).toHaveLength(1);

    h.samlVerify = () =>
      factsFor(connection, { id: '_assertion_2', inResponseTo: '_someone_elses_request' });
    const refused = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });
    expect(ssoError(refused)).toContain('did not make');
    expect(db.tables.session).toHaveLength(1);
  });

  it('consumes an assertion id exactly once', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    h.samlVerify = () => factsFor(connection);

    const first = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });
    expect(first.cookies.join(';')).toContain('qaai_session=');

    const replayed = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(ssoError(replayed)).toContain('already been used');
    expect(replayed.cookies).toHaveLength(0);
    // The guard is the unique index, so the proof is one session, not one 302.
    expect(db.tables.session).toHaveLength(1);
    expect(db.tables.ssoAssertionSeen).toHaveLength(1);
  });

  it('treats another org’s RelayState as absent rather than as a request to answer', async () => {
    const a = seedConnection({ id: 'conn_a' });
    seedDomain(a);
    const b = seedConnection({ id: 'conn_b', orgId: 'org_b' });
    seedDomain(b, { id: 'dom_b', domain: 'beta.test' });

    const { relayState } = await startSaml(a.id);
    const requestId = db.tables.ssoLoginRequest[0]!.samlRequestId as string;

    /*
     * The assertion is otherwise perfect for org B — signed, in-audience, in a
     * domain B has proved — and carries the InResponseTo that org A's login is
     * waiting for. Because the RelayState belongs to a different connection it
     * is dropped, which puts the flow under the IdP-initiated rule that an
     * assertion must then carry NO InResponseTo at all. Without that guard this
     * is a login at B satisfying a challenge issued by A.
     */
    h.samlVerify = () =>
      factsFor(b, { inResponseTo: requestId, nameId: 'eve@beta.test', attributes: {} });

    const reply = await call('POST', `/sso/saml/${b.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
      RelayState: relayState!,
    });

    expect(ssoError(reply)).toContain('did not make');
    expect(db.tables.session).toHaveLength(0);
    expect(db.tables.membership).toHaveLength(0);
  });

  it('refuses when no verifier is registered, without reading the response', async () => {
    h.samlVerify = null;
    const connection = seedConnection();
    seedDomain(connection);

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(ssoError(reply)).toContain('not available on this deployment');
    expect(db.tables.session).toHaveLength(0);
  });

  it('refuses before verifying when the connection has no certificate to verify against', async () => {
    const connection = seedConnection({ samlIdpCertsPem: [] });
    seedDomain(connection);

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(ssoError(reply)).toContain('signing certificate');
    // Not merely refused — never handed to the verifier at all, so there is no
    // path on which an empty trust anchor list reaches a signature check.
    expect(h.verifyCalls).toHaveLength(0);
  });

  it('refuses a verifier failure without reflecting its message into the login page', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    const leak = 'unsupported transform: <script>alert(1)</script>';
    h.samlVerify = () => {
      throw new Error(leak);
    };

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    /*
     * The verifier interpolates values read out of the attacker's XML into its
     * messages, and this handler ends in a redirect that puts its message in a
     * query string. Echoing would make an unauthenticated endpoint a reflection
     * primitive, so the whole reply is grepped, not just the parsed parameter.
     */
    expect(reply.text + reply.location).not.toContain('script');
    expect(ssoError(reply)).toContain('could not be verified');
    expect(db.tables.session).toHaveLength(0);
    expect(
      h.audits.some((a) => a.action === 'sso.login_refused' && a.actor.orgId === 'org_a'),
    ).toBe(true);
  });

  it('refuses an email outside the connection’s verified domains, touching nothing', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    h.samlVerify = () =>
      factsFor(connection, { nameId: 'ada@evil.test', attributes: { email: ['ada@evil.test'] } });

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(ssoError(reply)).toContain('outside the domains verified');
    /*
     * `User` is global and /auth/switch-org needs no re-authentication, so an
     * IdP that can name any address gets a session for that human everywhere
     * they are a member. No row at all is the only acceptable outcome.
     */
    expect(db.tables.user).toHaveLength(0);
    expect(db.tables.membership).toHaveLength(0);
    expect(db.tables.session).toHaveLength(0);

    const refusal = h.audits.find((a) => a.action === 'sso.login_refused')!;
    // The domain, never the address of someone who may not be a customer.
    expect(refusal.metadata.assertedDomain).toBe('evil.test');
    expect(JSON.stringify(refusal)).not.toContain('ada@');
  });

  it('never provisions OWNER, whatever the connection row says', async () => {
    // Planted directly in the table: the zod enum keeps OWNER out on the way in,
    // so the only way to see clampJitRole work is a row that got past it.
    const connection = seedConnection({ defaultRole: 'OWNER' });
    seedDomain(connection);
    h.samlVerify = () => factsFor(connection);

    await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(db.tables.membership[0]!.role).toBe('MEMBER');
  });

  it('leaves an existing membership’s role alone', async () => {
    const connection = seedConnection({ defaultRole: 'ADMIN' });
    seedDomain(connection);
    db.tables.user.push({ id: 'user_ada', email: 'ada@acme.test', passwordHash: null });
    db.tables.membership.push({
      id: 'mem_ada',
      orgId: 'org_a',
      userId: 'user_ada',
      role: 'VIEWER',
    });
    h.samlVerify = () => factsFor(connection);

    await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    // Re-applying defaultRole would silently undo a demotion made in the UI.
    expect(db.tables.membership).toHaveLength(1);
    expect(db.tables.membership[0]!.role).toBe('VIEWER');
  });

  it('is not reachable through an OIDC connection', async () => {
    const connection = seedConnection({ protocol: 'OIDC', oidcIssuer: 'https://idp.acme.test' });
    seedDomain(connection);

    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });
    expect(ssoError(reply)).toContain('not found');
  });
});

// ─── Metadata ────────────────────────────────────────────────────────────────

describe('GET /sso/saml/:id/metadata', () => {
  it('serves SP metadata naming this connection’s ACS, and 404s for OIDC', async () => {
    const connection = seedConnection();
    const reply = await call('GET', `/sso/saml/${connection.id}/metadata`);

    expect(reply.status).toBe(200);
    expect(reply.text).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(reply.text).toContain(`Location="${acsUrl(connection.id)}"`);
    // We do not sign AuthnRequests, and the metadata must not claim we do.
    expect(reply.text).toContain('AuthnRequestsSigned="false"');
    /*
     * Deliberately unauthenticated — an administrator pastes this into the IdP
     * before anyone can log in. It is a description of US, derived from the
     * connection id and our own origin, and carries no organization name, no
     * domain and no key.
     */
    expect(reply.text).not.toContain('org_a');
    expect(reply.text).not.toContain('acme.test');

    const oidc = seedConnection({ id: 'conn_oidc', protocol: 'OIDC' });
    expect((await call('GET', `/sso/saml/${oidc.id}/metadata`)).status).toBe(404);
  });
});

// ─── Discovery ───────────────────────────────────────────────────────────────

describe('POST /sso/discover', () => {
  it('hands back a start URL for a verified SAML domain', async () => {
    const connection = seedConnection();
    seedDomain(connection);

    const { body } = await call('POST', '/sso/discover', { email: 'ada@ACME.test' });
    expect(body).toMatchObject({
      available: true,
      protocol: 'SAML',
      startUrl: `${API_PUBLIC_URL}/sso/start/${connection.id}`,
    });
    // Nothing about which customer this is.
    expect(JSON.stringify(body)).not.toContain('org_a');
  });

  it('says why a SAML domain is unusable when this deployment has no verifier', async () => {
    h.samlVerify = null;
    const connection = seedConnection();
    seedDomain(connection);

    const { body } = await call('POST', '/sso/discover', { email: 'ada@acme.test' });
    /*
     * The login page needs this to avoid offering a button that cannot work.
     * The reason describes the DEPLOYMENT, not the organization, which is why
     * it is safe to hand an anonymous caller.
     */
    expect(body).toEqual({ available: false, reason: 'SAML_UNAVAILABLE' });
  });

  it('gives no reason for an unverified domain or an org off the plan', async () => {
    const connection = seedConnection();
    seedDomain(connection, { verifiedAt: null });
    expect((await call('POST', '/sso/discover', { email: 'ada@acme.test' })).body).toEqual({
      available: false,
    });

    db.tables.ssoDomain[0]!.verifiedAt = new Date(CLOCK_BASE);
    h.ssoOrgs = new Set();
    /*
     * No reason code here on purpose: "that org is not paying for SSO" is
     * somebody else's billing state, and this endpoint answers anyone.
     */
    expect((await call('POST', '/sso/discover', { email: 'ada@acme.test' })).body).toEqual({
      available: false,
    });
  });

  it('answers a domain nobody has claimed without saying so twice', async () => {
    expect((await call('POST', '/sso/discover', { email: 'nobody@nowhere.test' })).body).toEqual({
      available: false,
    });
    expect((await call('POST', '/sso/discover', { email: 'not-an-email' })).body).toEqual({
      available: false,
    });
  });
});

// ─── Admin surface: org isolation ────────────────────────────────────────────

describe('admin connections and domains are scoped to the caller’s org', () => {
  /*
   * Every case below is "another org's row", because that is the failure this
   * codebase's tenancy design can actually produce: the Prisma extension scopes
   * by orgId automatically, so the way a route leaks is by reaching for
   * `unscoped()` — which the login path legitimately does everywhere, four
   * functions up this same file. These assertions are what stops one of those
   * being copied down into the admin half.
   */
  // Both domains start UNVERIFIED, so the verify endpoint has real work to do
  // in every case below. A pre-verified row short-circuits to 200 without
  // touching DNS, which would make the cross-org verify test pass on a route
  // that had no scoping at all.
  beforeEach(() => {
    seedConnection({ id: 'conn_a', orgId: 'org_a', name: 'Ours' });
    seedDomain(
      { id: 'conn_a', orgId: 'org_a' },
      { id: 'dom_a', domain: 'acme.test', verifiedAt: null },
    );
    seedConnection({ id: 'conn_b', orgId: 'org_b', name: 'Theirs' });
    seedDomain(
      { id: 'conn_b', orgId: 'org_b' },
      { id: 'dom_b', domain: 'beta.test', verificationToken: 'tok-beta', verifiedAt: null },
    );
  });

  it('lists only this org’s connections', async () => {
    const { body } = await call('GET', '/sso/connections');
    expect(body.connections.map((c: Row) => c.name)).toEqual(['Ours']);
    expect(body.connections[0].domains.map((d: Row) => d.domain)).toEqual(['acme.test']);
  });

  it('cannot read, patch or delete another org’s connection', async () => {
    expect((await call('PATCH', '/sso/connections/conn_b', { name: 'Mine now' })).status).toBe(404);
    expect((await call('DELETE', '/sso/connections/conn_b')).status).toBe(404);
    // Asserted on the row: a 404 alone would also be produced by a route that
    // did the write and then failed to read it back.
    expect(db.tables.ssoConnection.find((c) => c.id === 'conn_b')!.name).toBe('Theirs');
    expect(db.tables.ssoConnection).toHaveLength(2);
  });

  it('cannot attach a domain to another org’s connection', async () => {
    const reply = await call('POST', '/sso/connections/conn_b/domains', { domain: 'new.test' });
    expect(reply.status).toBe(404);
    expect(db.tables.ssoDomain).toHaveLength(2);
  });

  it('cannot verify or delete another org’s domain', async () => {
    // The record the other org would need is published and correct, so the only
    // thing standing between this caller and a verified foreign domain is the
    // tenant scope on the lookup.
    h.txt = async () => [[domainVerificationRecord('tok-beta')]];
    expect((await call('POST', '/sso/domains/dom_b/verify')).status).toBe(404);
    expect((await call('DELETE', '/sso/domains/dom_b')).status).toBe(404);
    const theirs = db.tables.ssoDomain.find((d) => d.id === 'dom_b')!;
    expect(theirs.verifiedAt).toBeNull();
  });

  it('refuses a domain another org already claimed, without naming them', async () => {
    const reply = await call('POST', '/sso/connections/conn_a/domains', { domain: 'beta.test' });
    expect(reply.status).toBe(409);
    // A message naming the holder would turn this into a directory of who uses
    // QAAI; the same-org case is allowed to be specific because it is yours.
    expect(reply.text).not.toContain('org_b');
    expect(reply.body.error.message).toContain('already claimed');
  });

  it('verifies a domain only against the real TXT record', async () => {
    h.txt = async () => [['qaai-domain-verification=', 'wrong']];
    const wrong = await call('POST', '/sso/domains/dom_a/verify');
    expect(wrong.status).toBe(400);
    expect(db.tables.ssoDomain.find((d) => d.id === 'dom_a')!.verifiedAt).toBeNull();

    // resolveTxt returns a record split into 255-byte chunks; rejoining before
    // comparing is the difference between working and never working.
    h.txt = async () => [['qaai-domain-verification=', 'tok-acme']];
    const right = await call('POST', '/sso/domains/dom_a/verify');
    expect(right.status).toBe(200);
    expect(db.tables.ssoDomain.find((d) => d.id === 'dom_a')!.verifiedAt).not.toBeNull();
  });

  it('never returns a stored client secret', async () => {
    const secret = 'sup3r-s3cret-value';
    const created = await call('POST', '/sso/connections', {
      name: 'Okta',
      protocol: 'OIDC',
      oidcIssuer: 'https://acme.okta.test',
      oidcClientId: 'client-1',
      oidcClientSecret: secret,
    });

    expect(created.status).toBe(201);
    expect(created.body.hasClientSecret).toBe(true);
    // The whole body, not just the field we expect it in.
    expect(created.text).not.toContain(secret);
    expect(JSON.stringify(h.audits)).not.toContain(secret);

    const listed = await call('GET', '/sso/connections');
    expect(listed.text).not.toContain(secret);
  });

  it('refuses the whole admin surface for an org without the plan', async () => {
    h.ssoOrgs = new Set(['org_b']);
    const reply = await call('GET', '/sso/connections');
    expect(reply.status).toBe(402);
    expect(reply.body.error.code).toBe('PLAN_LIMIT');
  });

  it('refuses a VIEWER', async () => {
    h.actor = { userId: 'user_v', orgId: 'org_a', role: 'VIEWER', ip: null, scopes: ['*'] };
    expect((await call('GET', '/sso/connections')).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SSO JIT PRE-ACCOUNT-TAKEOVER
//
// `provisionAndSignIn` did `prisma.user.findUnique({ where: { email } })` and
// `if (existing) return existing` — it claimed ANY row with that address, with
// no check of `emailVerified` and no check of `passwordHash`, and then attached
// a membership in the customer's org to it.
//
// THE ATTACK, which is what these tests construct: sign up at /auth/signup as
// victim@customer.com with a password of your choosing, wait for the customer
// to configure SSO for customer.com, and when the real victim signs in through
// the identity provider the membership lands on YOUR row with YOUR password
// still on it.
//
// Every test here drives the real ACS route, which is the production call site.
// ─────────────────────────────────────────────────────────────────────────────

describe('an SSO login that claims an existing row', () => {
  /** The row an attacker leaves behind: unverified address, password they chose. */
  function seedPreMadeRow(over: Row = {}): Row {
    const row: Row = {
      id: 'user_premade',
      email: 'ada@acme.test',
      name: 'Not Ada',
      // A stored scrypt digest, not a password and not a key-shaped literal.
      passwordHash: 'scrypt$attacker-chose-this',
      emailVerified: null,
      isSuperuser: false,
      lastLoginAt: null,
      createdAt: new Date(CLOCK_BASE),
      updatedAt: new Date(CLOCK_BASE),
      ...over,
    };
    db.tables.user.push(row);
    return row;
  }

  function seedLiveSession(userId: string, over: Row = {}): Row {
    const row: Row = {
      id: `session_${userId}_${db.tables.session.length}`,
      userId,
      tokenHash: hashToken(`pre-claim-cookie-${db.tables.session.length}`),
      activeOrgId: null,
      ip: null,
      userAgent: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      revokedAt: null,
      createdAt: new Date(CLOCK_BASE),
      ...over,
    };
    db.tables.session.push(row);
    return row;
  }

  async function signInThroughIdp(connection: Row): Promise<Reply> {
    h.samlVerify = () => factsFor(connection);
    return call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });
  }

  it('severs the password on a row whose address nobody ever proved', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    const premade = seedPreMadeRow();

    const reply = await signInThroughIdp(connection);

    // The login SUCCEEDS — the whole reason severance was chosen over a
    // refusal is that nobody is locked out.
    expect(reply.status).toBe(302);
    expect(reply.cookies.join(';')).toContain('qaai_session=');
    // And the password that was never proved to be anybody's is gone.
    expect(premade.passwordHash).toBeNull();
    // The address is now verified, by the same reasoning the create path uses:
    // the IdP asserted it and the domain was proved.
    expect(premade.emailVerified).not.toBeNull();
  });

  it('revokes the sessions that predate the claim, and not the one it just minted', async () => {
    /*
     * Nulling the password alone is NOT enough, which is the half an attacker
     * would still have walked through: the pre-made row carries a live cookie,
     * and once the membership lands that cookie can reach the customer's org
     * through /auth/switch-org.
     */
    const connection = seedConnection();
    seedDomain(connection);
    const premade = seedPreMadeRow();
    const stale = seedLiveSession(premade.id);
    const alsoStale = seedLiveSession(premade.id);

    await signInThroughIdp(connection);

    expect(stale.revokedAt).not.toBeNull();
    expect(alsoStale.revokedAt).not.toBeNull();

    // Exactly one live session, and it is the one this login minted.
    const live = db.tables.session.filter((s) => s.revokedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.activeOrgId).toBe('org_a');
  });

  it('severs BEFORE the membership exists, so the two are never both live', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    const premade = seedPreMadeRow();
    seedLiveSession(premade.id);

    await signInThroughIdp(connection);

    // The ordering is the guarantee; what is observable afterwards is that the
    // membership landed on a row with nothing pre-claim still attached to it.
    expect(db.tables.membership).toHaveLength(1);
    expect(db.tables.membership[0]).toMatchObject({ orgId: 'org_a', userId: premade.id });
    expect(premade.passwordHash).toBeNull();
    expect(db.tables.session.filter((s) => s.userId === premade.id && s.revokedAt === null))
      .toHaveLength(1);
  });

  it('LEAVES A VERIFIED USER’S PASSWORD ALONE', async () => {
    /*
     * The other direction, and it is the one that keeps this from being a
     * lockout. A user who proved their address owns that password; an org
     * adding SSO must not silently take away the login its people already had.
     */
    const connection = seedConnection();
    seedDomain(connection);
    const genuine = seedPreMadeRow({
      name: 'Ada',
      emailVerified: new Date(CLOCK_BASE),
      passwordHash: 'scrypt$chosen-by-the-real-ada',
    });
    const theirSession = seedLiveSession(genuine.id);

    await signInThroughIdp(connection);

    expect(genuine.passwordHash).toBe('scrypt$chosen-by-the-real-ada');
    expect(theirSession.revokedAt).toBeNull();
    // Nothing to report, so nothing is reported.
    expect(h.audits.some((a) => a.action === 'sso.claim_severed')).toBe(false);
  });

  it('does not depend on EMAIL_VERIFICATION being in ENFORCE', async () => {
    /*
     * The brake for email verification defaults to OBSERVE, because enforcing
     * it would lock out every existing user. If severance were gated on that
     * mode the takeover would stay open in every deployment that had armed
     * nothing — which is all of them. The org below has stored no modes.
     */
    const connection = seedConnection();
    seedDomain(connection);
    const premade = seedPreMadeRow();

    await signInThroughIdp(connection);

    expect(premade.passwordHash).toBeNull();
  });

  it('records the severance without quoting any part of the credential', async () => {
    const connection = seedConnection();
    seedDomain(connection);
    const premade = seedPreMadeRow();
    const stale = seedLiveSession(premade.id);
    const hashBefore = premade.passwordHash as string;

    await signInThroughIdp(connection);

    const row = h.audits.find((a) => a.action === 'sso.claim_severed');
    expect(row).toBeDefined();
    expect(row!.metadata).toMatchObject({
      assertedDomain: 'acme.test',
      passwordCleared: true,
      sessionsRevoked: 1,
    });

    /*
     * Rule 11, asserted rather than assumed, and asserted over EVERY audit row
     * this login wrote rather than only the severance one: the password digest
     * and the revoked session's token hash are credentials, and they must
     * appear nowhere at all.
     */
    const serialised = JSON.stringify(h.audits);
    expect(serialised).not.toContain(hashBefore);
    expect(serialised).not.toContain(hashBefore.slice(-12));
    expect(serialised).not.toContain(stale.tokenHash as string);

    /*
     * THE ADDRESS IS CHECKED ON THE SEVERANCE ROW ONLY, and the reason is worth
     * writing down because the first draft of this test asserted it globally
     * and failed. The pre-existing `sso.login` row carries the asserted NameID
     * in `metadata.subject`, which is deliberate and not this slice's to
     * change: that row exists to say WHO signed in, the audit log is an
     * ADMIN-only surface, and an address there is the same grade of fact as the
     * `userId` beside it. The severance row is different — it is written about
     * a person who may not be a customer at all, so it carries the DOMAIN the
     * connection proved and nothing more, exactly as the domain-refusal row
     * above it does.
     */
    expect(JSON.stringify(row)).not.toContain('ada@acme.test');
  });

  it('still refuses a claim on an address outside the connection’s proved domains', async () => {
    // The pre-existing guard has to keep working: severance is a thing that
    // happens AFTER the domain check, never instead of it.
    const connection = seedConnection();
    seedDomain(connection);
    const outsider = seedPreMadeRow({ id: 'user_outside', email: 'eve@elsewhere.test' });

    h.samlVerify = () =>
      factsFor(connection, { nameId: 'eve@elsewhere.test', attributes: {} });
    const reply = await call('POST', `/sso/saml/${connection.id}/acs`, undefined, {
      SAMLResponse: SAML_RESPONSE,
    });

    expect(ssoError(reply)).toContain('outside the domains verified');
    // Nothing was touched, which is what "before any user row" means.
    expect(outsider.passwordHash).not.toBeNull();
    expect(db.tables.membership).toHaveLength(0);
  });

  it('does not run the severance over a row it has just created', async () => {
    /*
     * THE TITLE USED TO SAY "is not treated as a claim" AND THE TEST COULD NOT
     * TELL. Worth recording, because it is the trap the house rules name: the
     * end state is IDENTICAL either way. If the create path stopped stamping
     * `emailVerified`, the fresh row would fall into the severance branch and
     * come out with a null password and a verified address — the same three
     * values this test was asserting — and with no audit row either, because
     * severance only reports when it actually took something away. A mutation
     * run proved the assertions were insensitive.
     *
     * So the thing that distinguishes the two paths is asserted directly: the
     * number of writes to the user row. One write (the `lastLoginAt` stamp
     * every login makes) means the claim branch was not entered; two means it
     * was.
     */
    const connection = seedConnection();
    seedDomain(connection);

    const userModel = db.client.user as { update: (args: Row) => Promise<Row> };
    const real = userModel.update.bind(userModel);
    const updates: Row[] = [];
    userModel.update = async (args: Row) => {
      updates.push(args.data as Row);
      return real(args);
    };

    await signInThroughIdp(connection);

    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!)).toEqual(['lastLoginAt']);

    const created = db.tables.user[0]!;
    expect(created.passwordHash).toBeNull();
    expect(created.emailVerified).not.toBeNull();
    // And no severance row, because a report of work that did not happen is the
    // kind of number that gets quoted at a customer and cannot be defended.
    expect(h.audits.some((a) => a.action === 'sso.claim_severed')).toBe(false);
  });
});
