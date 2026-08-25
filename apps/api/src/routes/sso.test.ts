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

import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const API_PUBLIC_URL = 'https://api.qaai.test';
const WEB_PUBLIC_URL = 'https://app.qaai.test';
const IDP_SSO_URL = 'https://idp.acme.test/sso/saml';
const IDP_ENTITY_ID = 'https://idp.acme.test/entity';
const IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
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
  actor: { userId: 'user_admin', orgId: 'org_a', role: 'ADMIN', ip: null },
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

vi.mock('../middleware/auth.js', async () => {
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
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
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
const { ssoRouter } = await import('./sso.js');
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
  h.actor = { userId: 'user_admin', orgId: 'org_a', role: 'ADMIN', ip: null };
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
    h.actor = { userId: 'user_v', orgId: 'org_a', role: 'VIEWER', ip: null };
    expect((await call('GET', '/sso/connections')).status).toBe(403);
  });
});
