/**
 * Tests for the plugin registry (§4).
 *
 * The crypto is REAL — `generateKeyPairSync('ed25519')` and the shipped
 * `evaluateInstall`. Nothing about signature checking is stubbed, because a
 * stub is exactly how "the API verifies signatures" becomes true of the test
 * suite and false of the product.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. ORG ISOLATION on every endpoint, including the two the tenant layer
 *      cannot see. Trust is per-org, so a publisher another org registered must
 *      not make their key install anything here — and the enablement path takes
 *      a plugin id AND a project id, upserts on the pair, and `upsert` is the
 *      one operation lib/prisma.ts deliberately does not ownership-check. If the
 *      handler's own lookups were removed, a leaked pair of ids would write
 *      through and nothing else in this file would notice.
 *   2. FAIL CLOSED. A fresh org trusts nobody, so its first install is refused.
 *      An unknown publisher, a bad signature, a hash that does not match the
 *      signed manifest, a protocol this build cannot honour, a name a
 *      first-party plugin owns, and a capability the plan cannot grant are each
 *      a DISTINCT status and code — a UI given one bucket shows one sentence,
 *      and "bad signature" and "upgrade your plan" are not the same event.
 *   3. RBAC. Every mutation is ADMIN, enablement included, and a refused call
 *      writes no audit row.
 *   4. A REFUSED install is audited anyway. It is the most interesting thing
 *      this feature can produce and the only one that leaves no row behind by
 *      default.
 *   5. Install is not enablement. A freshly installed plugin runs nowhere until
 *      somebody turns it on for a named project.
 *
 * Not proven here, and deliberately: the foreign-key cascade that removes
 * enablements when a plugin is uninstalled. That is in the migration, it is
 * enforced by Postgres, and asserting it against an in-memory fake would only
 * prove the fake implements it. The uninstall test asserts what this code is
 * responsible for — the row is gone and the listing no longer shows it.
 *
 * Harness: same shape as schedules.test.ts — mocked prisma module with a real
 * AsyncLocalStorage tenant scope, real router over a loopback socket.
 */

import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
  }),
);

vi.mock('../env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WEB_PUBLIC_URL: 'https://app.qaai.test' },
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
 * Auth is a switchable actor; RBAC stays real in spirit — the requireRole
 * stand-in ranks with the same ROLE_RANK table the middleware uses, so the
 * MEMBER tests exercise the same comparison the product does.
 */
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

// Recorded, not silent: several tests assert exactly which rows were written.
vi.mock('../lib/audit.js', () => ({
  audit: async (input: unknown) => {
    h.audits.push(input as Row);
  },
}));

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'project',
  'plugin',
  'pluginPublisher',
  'pluginEnablement',
  'organization',
  'subscription',
] as const;
type ModelName = (typeof MODELS)[number];

/**
 * Composite unique selectors arrive as `{ orgId_name: { orgId, name } }`, which
 * is a shape no row has. Flattened here rather than special-cased per call site,
 * and only for keys that actually look composite — an unrecognised object
 * filter still throws below, which is the behaviour that keeps the fake honest.
 */
function flatten(where: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(where)) {
    const composite =
      key.includes('_') && value && typeof value === 'object' && !(value instanceof Date);
    if (composite) Object.assign(out, value as Row);
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
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
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

const DEFAULTS: Record<ModelName, Row> = {
  project: { archivedAt: null },
  plugin: { homepage: null, governedCapabilities: [], installedBy: null },
  pluginPublisher: { revokedAt: null, revokedBy: null, addedBy: null },
  pluginEnablement: { enabled: true, updatedBy: null },
  organization: { plan: 'BUSINESS' },
  subscription: {},
};

const CLOCK_BASE = new Date('2026-08-01T00:00:00.000Z').getTime();

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;
  let ticks = 0;

  const makeModel = (name: ModelName) => {
    const rows = () => tables[name];
    const scope = (where: Row = {}): Row => {
      const orgId = h.currentOrg();
      // Organization is scoped by primary key, not by an orgId column — the
      // same carve-out lib/prisma.ts makes.
      if (!orgId || name === 'organization') return where;
      return { ...where, orgId };
    };
    const find = (where: Row = {}, orderBy?: Row): Row[] =>
      sortRows(
        rows().filter((r) => matches(r, scope(where))),
        orderBy,
      );

    const insert = (data: Row): Row => {
      const orgId = h.currentOrg();
      const stamp = new Date(CLOCK_BASE + ticks++);
      const row: Row = {
        id: `${name}_${++ids}`,
        createdAt: stamp,
        updatedAt: stamp,
        ...DEFAULTS[name],
        ...(orgId && data.orgId === undefined ? { orgId } : {}),
        ...data,
      };
      rows().push(row);
      return row;
    };

    return {
      findUnique: async ({ where, select }: Row) => {
        const row = find(where)[0];
        return row ? project(row, select) : null;
      },
      findFirst: async ({ where, select, orderBy }: Row = {}) => {
        const row = find(where, orderBy)[0];
        return row ? project(row, select) : null;
      },
      findMany: async ({ where, select, orderBy, take }: Row = {}) => {
        const list = find(where, orderBy);
        return (typeof take === 'number' ? list.slice(0, take) : list).map((r) =>
          project(r, select),
        );
      },
      create: async ({ data, select }: Row) => project(insert(data), select),
      update: async ({ where, data, select }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.update matched no row`);
        Object.assign(row, data, { updatedAt: new Date(CLOCK_BASE + ticks++) });
        return project(row, select);
      },
      upsert: async ({ where, create, update, select }: Row) => {
        // `where` is a unique selector and is NOT tenant-scoped, exactly as the
        // real extension leaves it — so a handler that fails to prove ownership
        // of the ids it was handed writes through here too.
        const row = rows().filter((r) => matches(r, flatten(where)))[0];
        if (!row) return project(insert({ ...flatten(where), ...create }), select);
        Object.assign(row, update, { updatedAt: new Date(CLOCK_BASE + ticks++) });
        return project(row, select);
      },
      delete: async ({ where }: Row) => {
        const row = find(where)[0];
        if (!row) throw new Error(`fake prisma: ${name}.delete matched no row`);
        rows().splice(rows().indexOf(row), 1);
        return row;
      },
    };
  };

  const client: Record<string, unknown> = {};
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { pluginsRouter } = await import('./plugins.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');
const {
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  bundleDigest,
  manifestSigningInput,
  publisherKeyFingerprint,
  GOVERNED_CAPABILITIES,
} = await import('../../../../packages/shared/src/plugin-manifest.js');
const { PLUGIN_CAPABILITIES } = await import(
  '../../../../packages/shared/src/plugin-capabilities.js'
);
type PluginManifest = import('../../../../packages/shared/src/plugin-manifest.js').PluginManifest;

const app = express();
app.use(express.json());
app.use('/plugins', pluginsRouter);
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
  body?: unknown,
): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

// ─── Keys and manifests ──────────────────────────────────────────────────────

function keypair(): { privateKey: KeyObject; spki: Buffer; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, spki, raw: spki.subarray(spki.length - 32) };
}

const acme = keypair();
const impostor = keypair();

const BUNDLE = Buffer.from('export const plugin = {};\n', 'utf8');
const BUNDLE_SHA = bundleDigest(BUNDLE);

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schema: PLUGIN_MANIFEST_SCHEMA,
    name: 'acme-lighthouse',
    version: '1.4.2',
    publisher: 'acme',
    displayName: 'Acme Lighthouse',
    description: 'Runs Lighthouse against every page the suite visits.',
    protocol: PLUGIN_PROTOCOL_VERSION,
    capabilities: ['http', 'fixtures'],
    code: { sha256: BUNDLE_SHA, bytes: BUNDLE.length, entry: 'dist/index.js' },
    ...overrides,
  };
}

function installBody(m: PluginManifest = manifest(), key = acme.privateKey, sha = BUNDLE_SHA) {
  return {
    manifest: m,
    signature: {
      algorithm: 'ed25519' as const,
      value: signBytes(null, manifestSigningInput(m), key).toString('base64'),
    },
    bundleSha256: sha,
  };
}

// ─── The cast ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const OTHER = 'org_2';

let db: ReturnType<typeof makeDb>;

/** Seeds a trusted-publisher row directly, so the tests do not depend on POST. */
function trust(orgId: string, publisherId: string, raw: Buffer, over: Row = {}): Row {
  const row = {
    id: `pub_${orgId}_${publisherId}`,
    orgId,
    publisherId,
    displayName: publisherId,
    publicKey: raw.toString('base64'),
    fingerprint: publisherKeyFingerprint(raw),
    revokedAt: null,
    revokedBy: null,
    addedBy: null,
    createdAt: new Date(CLOCK_BASE),
    updatedAt: new Date(CLOCK_BASE),
    ...over,
  };
  db.tables.pluginPublisher.push(row);
  return row;
}

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_1', orgId: ORG, role: 'ADMIN', ip: null };
  h.audits.length = 0;

  // No Subscription rows: both orgs are honoured at their Organization.plan,
  // which is the path every seeded and self-hosted install takes.
  db.tables.organization.push({ id: ORG, plan: 'BUSINESS' }, { id: OTHER, plan: 'BUSINESS' });
  db.tables.project.push(
    { id: 'proj_1', orgId: ORG, name: 'Storefront', archivedAt: null },
    { id: 'proj_2', orgId: ORG, name: 'Checkout', archivedAt: null },
    { id: 'proj_other', orgId: OTHER, name: 'Their app', archivedAt: null },
  );
});

const asMember = () => {
  h.actor = { ...h.actor, role: 'MEMBER' };
};
const asOtherOrg = () => {
  h.actor = { userId: 'user_2', orgId: OTHER, role: 'ADMIN', ip: null };
};

// ─── Fail closed ─────────────────────────────────────────────────────────────

describe('a fresh organisation trusts nobody', () => {
  it('refuses the first install, naming the publisher it has never heard of', async () => {
    const res = await call('POST', '/plugins', installBody());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNKNOWN_PUBLISHER');
    expect(res.body.error.message).toContain('"acme"');
    expect(db.tables.plugin).toHaveLength(0);
  });

  it('lists an empty registry rather than failing', async () => {
    const res = await call('GET', '/plugins');
    expect(res.status).toBe(200);
    expect(res.body.publishers).toEqual([]);
    expect(res.body.plugins).toEqual([]);
    expect(res.body.projects.map((p: Row) => p.id)).toEqual(['proj_2', 'proj_1']);
  });
});

// ─── Org isolation ───────────────────────────────────────────────────────────

describe('org isolation', () => {
  it('does not let another org’s trusted key install anything here', async () => {
    // OTHER trusts acme's real key. ORG does not. Same publisher name, same
    // signature, same bytes — and it must still be refused.
    trust(OTHER, 'acme', acme.raw);

    const res = await call('POST', '/plugins', installBody());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNKNOWN_PUBLISHER');
    expect(db.tables.plugin).toHaveLength(0);
  });

  it('shows only this org’s publishers, plugins and projects', async () => {
    trust(ORG, 'acme', acme.raw);
    trust(OTHER, 'zenith', impostor.raw);
    db.tables.plugin.push(
      { id: 'plg_1', orgId: ORG, name: 'acme-lighthouse', publisherRowId: `pub_${ORG}_acme` },
      { id: 'plg_2', orgId: OTHER, name: 'zenith-audit', publisherRowId: `pub_${OTHER}_zenith` },
    );

    const res = await call('GET', '/plugins');
    expect(res.body.publishers.map((p: Row) => p.publisherId)).toEqual(['acme']);
    expect(res.body.plugins.map((p: Row) => p.name)).toEqual(['acme-lighthouse']);
    expect(res.body.projects.map((p: Row) => p.id)).toEqual(['proj_2', 'proj_1']);
  });

  it('404s on another org’s plugin instead of uninstalling it', async () => {
    db.tables.plugin.push({
      id: 'plg_other',
      orgId: OTHER,
      name: 'zenith-audit',
      version: '1.0.0',
      publisher: 'zenith',
      capabilities: [],
    });

    const res = await call('DELETE', '/plugins/plg_other');
    expect(res.status).toBe(404);
    expect(db.tables.plugin).toHaveLength(1);
    expect(h.audits).toHaveLength(0);
  });

  it('404s on another org’s publisher instead of revoking it', async () => {
    trust(OTHER, 'acme', acme.raw);
    const res = await call('POST', `/plugins/publishers/pub_${OTHER}_acme/revoke`);
    expect(res.status).toBe(404);
    expect(db.tables.pluginPublisher[0]!.revokedAt).toBeNull();
  });

  /*
   * The upsert hole. `PluginEnablement` is written through a composite unique
   * key, and lib/prisma.ts leaves upsert's update path unscoped on purpose — so
   * these two cases are guarded by the handler's own lookups and by nothing
   * else. Delete either lookup and one of these tests goes green-to-red.
   */
  it('404s when the plugin belongs to another org', async () => {
    db.tables.plugin.push({
      id: 'plg_other',
      orgId: OTHER,
      name: 'zenith-audit',
      version: '1.0.0',
      publisher: 'zenith',
      capabilities: [],
    });

    const res = await call('PUT', '/plugins/plg_other/projects/proj_1', { enabled: true });
    expect(res.status).toBe(404);
    expect(db.tables.pluginEnablement).toHaveLength(0);
  });

  it('404s when the project belongs to another org', async () => {
    db.tables.plugin.push({
      id: 'plg_1',
      orgId: ORG,
      name: 'acme-lighthouse',
      version: '1.4.2',
      publisher: 'acme',
      capabilities: ['http'],
    });

    const res = await call('PUT', '/plugins/plg_1/projects/proj_other', { enabled: true });
    expect(res.status).toBe(404);
    expect(db.tables.pluginEnablement).toHaveLength(0);
  });
});

// ─── RBAC ────────────────────────────────────────────────────────────────────

describe('every mutation is ADMIN', () => {
  beforeEach(() => {
    trust(ORG, 'acme', acme.raw);
    db.tables.plugin.push({
      id: 'plg_1',
      orgId: ORG,
      name: 'acme-lighthouse',
      version: '1.4.2',
      publisher: 'acme',
      publisherRowId: `pub_${ORG}_acme`,
      capabilities: ['http'],
    });
    asMember();
  });

  it.each([
    ['POST', '/plugins/publishers', { publisherId: 'zen', displayName: 'Z', publicKey: 'x' }],
    ['POST', `/plugins/publishers/pub_${ORG}_acme/revoke`, undefined],
    ['POST', '/plugins', undefined],
    ['DELETE', '/plugins/plg_1', undefined],
    ['PUT', '/plugins/plg_1/projects/proj_1', { enabled: true }],
  ] as Array<[string, string, unknown]>)('refuses %s %s for a MEMBER', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    // A refusal is not a mutation and must not look like one in the log.
    expect(h.audits).toHaveLength(0);
  });

  it('still lets a MEMBER read the registry', async () => {
    const res = await call('GET', '/plugins');
    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(1);
  });
});

// ─── Trusting a publisher ────────────────────────────────────────────────────

describe('trusting a publisher', () => {
  it('accepts the SPKI DER and stores the normalised raw key with a fingerprint', async () => {
    const res = await call('POST', '/plugins/publishers', {
      publisherId: 'acme',
      displayName: 'Acme Inc',
      publicKey: acme.spki.toString('base64'),
    });

    expect(res.status).toBe(201);
    expect(res.body.publisher.fingerprint).toBe(publisherKeyFingerprint(acme.raw));
    // Normalised, not stored as pasted: two encodings of one key must not be
    // able to sit in this column as two different values.
    expect(db.tables.pluginPublisher[0]!.publicKey).toBe(acme.raw.toString('base64'));
    expect(h.audits[0]).toMatchObject({ action: 'plugin.publisher.trust' });
  });

  it('refuses anything that is not an Ed25519 public key', async () => {
    const res = await call('POST', '/plugins/publishers', {
      publisherId: 'acme',
      displayName: 'Acme Inc',
      publicKey: Buffer.from('hunter2').toString('base64'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Ed25519');
    expect(db.tables.pluginPublisher).toHaveLength(0);
  });

  it('refuses a second live key for the same publisher', async () => {
    trust(ORG, 'acme', acme.raw);
    const res = await call('POST', '/plugins/publishers', {
      publisherId: 'acme',
      displayName: 'Acme Inc',
      publicKey: impostor.raw.toString('base64'),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(publisherKeyFingerprint(acme.raw));
    expect(db.tables.pluginPublisher[0]!.publicKey).toBe(acme.raw.toString('base64'));
  });

  it('rotates onto a revoked row once nothing is installed under it', async () => {
    trust(ORG, 'acme', acme.raw, { revokedAt: new Date(CLOCK_BASE) });

    const res = await call('POST', '/plugins/publishers', {
      publisherId: 'acme',
      displayName: 'Acme Inc',
      publicKey: impostor.raw.toString('base64'),
    });

    expect(res.status).toBe(200);
    expect(db.tables.pluginPublisher).toHaveLength(1);
    expect(db.tables.pluginPublisher[0]!.revokedAt).toBeNull();
    expect(res.body.publisher.fingerprint).toBe(publisherKeyFingerprint(impostor.raw));
    expect(h.audits[0]).toMatchObject({ action: 'plugin.publisher.rotate' });
  });

  it('refuses the rotation while plugins signed by the old key are still installed', async () => {
    trust(ORG, 'acme', acme.raw, { revokedAt: new Date(CLOCK_BASE) });
    db.tables.plugin.push({
      id: 'plg_1',
      orgId: ORG,
      name: 'acme-lighthouse',
      publisherRowId: `pub_${ORG}_acme`,
    });

    const res = await call('POST', '/plugins/publishers', {
      publisherId: 'acme',
      displayName: 'Acme Inc',
      publicKey: impostor.raw.toString('base64'),
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('acme-lighthouse');
    // Still the revoked key: nothing was quietly re-trusted.
    expect(db.tables.pluginPublisher[0]!.publicKey).toBe(acme.raw.toString('base64'));
    expect(db.tables.pluginPublisher[0]!.revokedAt).not.toBeNull();
  });

  it('revokes without uninstalling, and records what was still installed', async () => {
    trust(ORG, 'acme', acme.raw);
    db.tables.plugin.push({
      id: 'plg_1',
      orgId: ORG,
      name: 'acme-lighthouse',
      publisherRowId: `pub_${ORG}_acme`,
    });

    const res = await call('POST', `/plugins/publishers/pub_${ORG}_acme/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.stillInstalled.map((p: Row) => p.name)).toEqual(['acme-lighthouse']);
    // Revoking a key must not silently stop somebody's nightly suite.
    expect(db.tables.plugin).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'plugin.publisher.revoke',
      metadata: { stillInstalled: ['acme-lighthouse'] },
    });
  });

  it('marks the plugins of a revoked publisher on the listing', async () => {
    trust(ORG, 'acme', acme.raw, { revokedAt: new Date(CLOCK_BASE) });
    db.tables.plugin.push({
      id: 'plg_1',
      orgId: ORG,
      name: 'acme-lighthouse',
      publisherRowId: `pub_${ORG}_acme`,
    });

    const res = await call('GET', '/plugins');
    expect(res.body.plugins[0].publisherRevoked).toBe(true);
    // Never leaked: the row id is an internal join key, not part of the shape.
    expect(res.body.plugins[0].publisherRowId).toBeUndefined();
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('refusing an install', () => {
  beforeEach(() => {
    trust(ORG, 'acme', acme.raw);
  });

  it('refuses a signature made with a key this org does not trust', async () => {
    const res = await call('POST', '/plugins', installBody(manifest(), impostor.privateKey));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
    expect(res.body.error.message).toContain(publisherKeyFingerprint(acme.raw));
    expect(db.tables.plugin).toHaveLength(0);
  });

  it('refuses a manifest altered after it was signed', async () => {
    const body = installBody();
    // The classic: a valid signature, moved onto a manifest that now asks for
    // secrets. Nothing but the signature check stands between this and an
    // install, which is why it gets its own test.
    body.manifest = manifest({ capabilities: ['http', 'fixtures', 'secrets'] });

    const res = await call('POST', '/plugins', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a bundle that does not hash to what was signed', async () => {
    const other = bundleDigest(Buffer.from('something else entirely'));
    const res = await call('POST', '/plugins', installBody(manifest(), acme.privateKey, other));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HASH_MISMATCH');
    expect(res.body.error.details).toMatchObject({ actual: other });
  });

  it('refuses a protocol this build cannot honour, and says which', async () => {
    const m = manifest({ protocol: PLUGIN_PROTOCOL_VERSION + 1 });
    const res = await call('POST', '/plugins', installBody(m));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROTOCOL_TOO_NEW');
    expect(res.body.error.message).toContain(String(PLUGIN_PROTOCOL_VERSION));
  });

  it('refuses a name a first-party plugin already owns', async () => {
    const m = manifest({ name: 'accessibility' });
    const res = await call('POST', '/plugins', installBody(m));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RESERVED_NAME');
  });

  it('refuses a manifest that is not one, with a 400 rather than a 422', async () => {
    const res = await call('POST', '/plugins', {
      manifest: { name: 'acme-lighthouse' },
      signature: { algorithm: 'ed25519', value: 'AAAA' },
      bundleSha256: BUNDLE_SHA,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MANIFEST_MALFORMED');
  });

  it('refuses a governed capability the plan cannot grant, with 402', async () => {
    // FREE has no audit log, so there is nowhere to see what a plugin holding
    // the org's secrets actually did with them.
    db.tables.organization[0]!.plan = 'FREE';
    const m = manifest({ capabilities: ['fixtures', 'secrets'] });

    const res = await call('POST', '/plugins', installBody(m));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('CAPABILITY_NOT_IN_PLAN');
    expect(res.body.error.message).toContain('Free');
    expect(db.tables.plugin).toHaveLength(0);
  });

  it('still installs an ungoverned plugin on a plan with no audit log', async () => {
    db.tables.organization[0]!.plan = 'FREE';
    const res = await call('POST', '/plugins', installBody());
    expect(res.status).toBe(201);
  });

  it('audits the refusal even though nothing was written', async () => {
    await call('POST', '/plugins', installBody(manifest(), impostor.privateKey));
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'plugin.install.refused',
      metadata: { reason: 'SIGNATURE_INVALID', publisher: 'acme' },
    });
  });

  it('refuses a second install of a name already taken, naming the version there', async () => {
    await call('POST', '/plugins', installBody());
    const res = await call('POST', '/plugins', installBody(manifest({ version: '2.0.0' })));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('1.4.2');
    expect(db.tables.plugin).toHaveLength(1);
  });
});

// ─── Installing ──────────────────────────────────────────────────────────────

describe('installing', () => {
  beforeEach(() => {
    trust(ORG, 'acme', acme.raw);
  });

  it('records what was verified, and enables it nowhere', async () => {
    const m = manifest({ capabilities: ['http', 'fixtures', 'secrets'] });
    const body = installBody(m);
    const res = await call('POST', '/plugins', body);

    expect(res.status).toBe(201);
    expect(res.body.plugin).toMatchObject({
      name: 'acme-lighthouse',
      version: '1.4.2',
      publisher: 'acme',
      protocol: PLUGIN_PROTOCOL_VERSION,
      capabilities: ['http', 'fixtures', 'secrets'],
      governedCapabilities: ['secrets'],
      codeSha256: BUNDLE_SHA,
      codeEntry: 'dist/index.js',
    });
    // Installed is not running.
    expect(res.body.plugin.projects).toEqual({});
    expect(db.tables.pluginEnablement).toHaveLength(0);

    // The evidence is kept verbatim so the runner can re-verify before loading.
    const stored = db.tables.plugin[0]!;
    expect(stored.manifest).toEqual(m);
    expect(stored.signature).toBe(body.signature.value);
    expect(stored.publisherRowId).toBe(`pub_${ORG}_acme`);

    expect(h.audits[0]).toMatchObject({
      action: 'plugin.install',
      metadata: {
        name: 'acme-lighthouse',
        capabilities: ['http', 'fixtures', 'secrets'],
        codeSha256: BUNDLE_SHA,
        fingerprint: publisherKeyFingerprint(acme.raw),
      },
    });
  });

  it('uninstalls, recording which projects just lost it', async () => {
    await call('POST', '/plugins', installBody());
    const id = db.tables.plugin[0]!.id;
    await call('PUT', `/plugins/${id}/projects/proj_1`, { enabled: true });
    h.audits.length = 0;

    const res = await call('DELETE', `/plugins/${id}`);
    expect(res.status).toBe(200);
    expect(db.tables.plugin).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({
      action: 'plugin.uninstall',
      metadata: { name: 'acme-lighthouse', wasEnabledOn: ['proj_1'] },
    });

    const listing = await call('GET', '/plugins');
    expect(listing.body.plugins).toEqual([]);
  });
});

// ─── Enablement ──────────────────────────────────────────────────────────────

describe('enable and disable, per project', () => {
  let pluginId = '';

  beforeEach(async () => {
    trust(ORG, 'acme', acme.raw);
    await call('POST', '/plugins', installBody());
    pluginId = db.tables.plugin[0]!.id;
    h.audits.length = 0;
  });

  it('turns one project on without touching the others', async () => {
    const res = await call('PUT', `/plugins/${pluginId}/projects/proj_1`, { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enablement).toMatchObject({ projectId: 'proj_1', enabled: true });

    const listing = await call('GET', '/plugins');
    expect(listing.body.plugins[0].projects).toEqual({ proj_1: true });
    expect(h.audits[0]).toMatchObject({
      action: 'plugin.enable',
      metadata: { projectId: 'proj_1', projectName: 'Storefront', capabilities: ['http', 'fixtures'] },
    });
  });

  it('flips an existing row rather than adding a second', async () => {
    await call('PUT', `/plugins/${pluginId}/projects/proj_1`, { enabled: true });
    const res = await call('PUT', `/plugins/${pluginId}/projects/proj_1`, { enabled: false });

    expect(res.status).toBe(200);
    expect(db.tables.pluginEnablement).toHaveLength(1);
    expect(db.tables.pluginEnablement[0]!.enabled).toBe(false);
    expect(h.audits.map((a) => a.action)).toEqual(['plugin.enable', 'plugin.disable']);

    const listing = await call('GET', '/plugins');
    expect(listing.body.plugins[0].projects).toEqual({ proj_1: false });
  });

  it('refuses to enable on an archived project but still lets it be turned off', async () => {
    await call('PUT', `/plugins/${pluginId}/projects/proj_2`, { enabled: true });
    db.tables.project.find((p) => p.id === 'proj_2')!.archivedAt = new Date(CLOCK_BASE);

    const blocked = await call('PUT', `/plugins/${pluginId}/projects/proj_2`, { enabled: true });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain('archived');

    // Disabling has to keep working, or a project archived precisely to stop
    // third-party code touching it is stuck with that code enabled.
    const off = await call('PUT', `/plugins/${pluginId}/projects/proj_2`, { enabled: false });
    expect(off.status).toBe(200);
    expect(db.tables.pluginEnablement[0]!.enabled).toBe(false);
  });
});

// ─── What the screen is given ────────────────────────────────────────────────

describe('the listing', () => {
  it('serves the capability vocabulary the API itself enforces on', async () => {
    const res = await call('GET', '/plugins');

    const names = res.body.capabilities.map((c: Row) => c.name);
    // Against the vocabulary itself, not a copy of it. A literal list here is a
    // second definition of the thing this endpoint exists to serve, and the
    // whole reason this test exists is that there used to be two.
    expect([...names].sort()).toEqual([...PLUGIN_CAPABILITIES].sort());
    for (const capability of res.body.capabilities) {
      expect(capability.label).toBeTruthy();
      expect(capability.grants).toBeTruthy();
      expect(capability.bounded).toBeTruthy();
    }
    // The ones the plan gate is about, flagged so the screen can say so before
    // anyone clicks Install rather than after the 402.
    expect(
      res.body.capabilities.filter((c: Row) => c.governed).map((c: Row) => c.name),
    ).toEqual([...GOVERNED_CAPABILITIES]);
  });

  it('serves the reserved names the screen warns on, so the two cannot drift', async () => {
    const res = await call('GET', '/plugins');
    // Every first-party test type, in the name a plugin would collide under.
    expect(res.body.reservedNames).toContain('e2e');
    expect(res.body.reservedNames).toContain('security-smoke');
    expect(res.body.reservedNames).toContain('external');
    expect(res.body.reservedNames).not.toContain('acme-lighthouse');
  });

  it('reports the plan gate and the protocol this build speaks', async () => {
    const business = await call('GET', '/plugins');
    expect(business.body.plan).toEqual({ label: 'Business', allowsGovernedCapabilities: true });
    expect(business.body.protocol.speaks).toBe(PLUGIN_PROTOCOL_VERSION);

    db.tables.organization[0]!.plan = 'FREE';
    const free = await call('GET', '/plugins');
    expect(free.body.plan).toEqual({ label: 'Free', allowsGovernedCapabilities: false });
  });

  it('reads the plan of the caller’s own org', async () => {
    db.tables.organization.find((o) => o.id === OTHER)!.plan = 'FREE';
    asOtherOrg();

    const res = await call('GET', '/plugins');
    expect(res.body.plan.label).toBe('Free');
  });
});
