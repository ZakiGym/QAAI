/**
 * THE BASE URL'S ADDRESS CLASS, OVER THE WIRE.
 *
 * `environmentBaseUrl` in packages/shared/src/schemas.ts checks http(s), a
 * length bound and the absence of `user:pass@`, and its own header says in
 * terms that it MUST NOT be described as having checked the address, naming
 * `apps/api/src/routes/projects.ts` as the route that owes that check. MEASURED
 * on this tree before the door was cut: both `createEnvironmentSchema` and
 * `updateEnvironmentSchema` accepted and stored `http://169.254.169.254/` — the
 * cloud metadata service on AWS, GCP and Azure alike — along with
 * `http://127.0.0.1:6379/`, `http://10.0.0.5/` and `http://2130706433/`. A
 * MEMBER's FORM_LOGIN profile then drives a real browser at that URL and types
 * vault plaintext into whatever answers, and the crawl's progress events report
 * what it found.
 *
 * So this file drives REQUESTS, not functions. The properties it holds the
 * route to:
 *
 *   1. A POST that stores a metadata-service, loopback or private base URL is
 *      REFUSED, and no environment row is left behind.
 *   2. The alternate-encoding forms do not get a second chance.
 *   3. THE REFUSAL IS NOT AN ORACLE. One sentence — the shared
 *      `EGRESS_REFUSAL_SENTENCE` — for every class, with the class in the audit
 *      row inside the tenant and nowhere else.
 *   4. THE BRAKE GATES THE WRITE. In OBSERVE the row is written exactly as it
 *      was before this door existed AND the decision is counted; in ENFORCE it
 *      is not written at all.
 *   5. A PATCH that does not mention `baseUrl` is not refused for an address
 *      that is already stored — otherwise a customer with a private staging box
 *      could not rename their own environment.
 *   6. The allowlist the refusal NAMES actually widens the door, including the
 *      org-wide form, which is the only one that can exist before the
 *      environment does.
 *
 * NO NETWORK AND NO DNS. This door decides the synchronous half only — an
 * ambiguous host and an IP literal whose class the policy refuses — so nothing
 * here resolves a name, and the route holds no resolver to inject. A name's
 * verdict belongs at the moment the connection is opened; see `baseUrlProblem`
 * in the route for the measurement behind that split.
 *
 * Harness: the same shape as projects.auth-profile.test.ts — a mocked prisma
 * module with a real AsyncLocalStorage tenant scope, and the real router driven
 * over a loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGRESS_REFUSAL_SENTENCE } from '@qaai/shared';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
}));

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
 * Real scope, not a stubbed variable: the route's queries run in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before they ran.
 */
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
  organization: Row[];
  egressAllowlistEntry: Row[];
}

let store: Store;
let nextId = 0;

/**
 * Enough of Prisma to drive these two handlers, and NOT a shrugging fake.
 *
 * `select` IS HONOURED, because this round's rule 9 is about exactly the
 * failure a select-blind fake hides: deleting `egressPolicy: true` from the
 * PATCH route's projection would otherwise be undetectable, and the route would
 * then decide every edit against the HOSTED default while every test passed.
 * `orderBy` and `take` are honoured for the same reason, and ANY FILTER THIS
 * FAKE DOES NOT IMPLEMENT THROWS — a fake that accepts `OR` and ignores it
 * would make the org-wide allowlist read below look as though it worked.
 */
function makeDb(): Row {
  const orgOf = () => h.currentOrg();

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === 'OR') {
        if (!Array.isArray(cond)) throw new Error('fake prisma: OR must be an array');
        return (cond as Row[]).some((clause) => matches(row, clause));
      }
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
    findMany: async ({ where = {}, select, orderBy, take }: Row = {}) => {
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
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((row) => pick(row, select));
    },
    findUnique: async ({ where = {}, select }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) return null;
      const orgId = orgOf();
      // Organization is scoped by its primary key, not by an orgId column —
      // lib/prisma.ts handles that, and the fake must not demand an orgId it
      // does not have.
      if (orgId && name !== 'organization' && found.orgId !== orgId) return null;
      return pick(found, select);
    },
    create: async ({ data = {}, select }: Row = {}) => {
      const row: Row = { id: `${name}_${++nextId}`, ...(data as Row) };
      store[name].push(row);
      return pick(row, select);
    },
    update: async ({ where = {}, data = {}, select }: Row = {}) => {
      const found = store[name].find((row) => row.id === where.id);
      if (!found) throw new Error(`fake prisma: no ${name} ${String(where.id)}`);
      Object.assign(found, data as Row);
      return pick(found, select);
    },
    count: async ({ where = {} }: Row = {}) =>
      store[name].filter((row) => matches(row, where)).length,
  });

  return {
    project: model('project'),
    environment: model('environment'),
    organization: model('organization'),
    egressAllowlistEntry: model('egressAllowlistEntry'),
    run: { count: async () => 0 },
  };
}

function install(over: Partial<Store> = {}): void {
  nextId = 0;
  store = {
    project: [{ id: 'proj_a', orgId: 'org_1', name: 'A' }],
    environment: [
      {
        id: 'env_a',
        orgId: 'org_1',
        projectId: 'proj_a',
        name: 'staging',
        kind: 'STAGING',
        baseUrl: 'https://staging.example.com',
        runnerPool: null,
        egressPolicy: null,
      },
    ],
    organization: [{ id: 'org_1', securityControlModes: null }],
    egressAllowlistEntry: [],
    ...over,
  };
  h.prisma = makeDb();
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { projectsRouter } = await import('./projects.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/projects', projectsRouter);
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
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

const egressAudits = (): Row[] =>
  h.audits.filter((a) => a.action === 'environment.base-url.egress');

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits = [];
  install();
});

// ─── The five addresses two adversaries drove ────────────────────────────────

/**
 * The cases, and what each one is. `http://2130706433/` is in here because the
 * WHATWG URL parser normalises it to `127.0.0.1` — which is the point:
 * `classifyHost` sees a loopback literal and the alternate encoding gets no
 * second chance.
 */
const REFUSED = [
  ['http://169.254.169.254/', 'link-local', 'the cloud metadata service'],
  ['http://127.0.0.1:6379/', 'loopback', 'a local Redis'],
  ['http://10.0.0.5/', 'private', 'an RFC1918 host'],
  ['http://2130706433/', 'loopback', 'loopback as one integer'],
  ['http://0177.0.0.1/', 'loopback', 'loopback in octal'],
] as const;

describe('creating an environment at an address QAAI may not open', () => {
  for (const [url, addressClass, what] of REFUSED) {
    it(`refuses ${url} (${what}) and stores nothing`, async () => {
      const created = await call('POST', '/projects/proj_a/environments', {
        name: 'imds',
        kind: 'STAGING',
        baseUrl: url,
      });

      expect(created.status).toBe(400);
      // NO ROW. A refusal that writes first and reports afterwards is not a
      // refusal, and this is the assertion that would catch the check being
      // moved below `environment.create`.
      expect(store.environment.map((e) => e.baseUrl)).toEqual(['https://staging.example.com']);

      // The class is in the operator's own copy, inside their tenant.
      const audit = egressAudits();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata.outcome).toBe('REFUSED');
      expect(audit[0]!.metadata.addressClass).toBe(addressClass);
      expect(audit[0]!.metadata.control).toBe('EGRESS_CLASSIFICATION');
    });
  }

  it('answers ONE sentence whatever the class, so the refusal is not an oracle', async () => {
    const seen = new Set<string>();
    for (const [url] of REFUSED) {
      install();
      const refused = await call('POST', '/projects/proj_a/environments', {
        name: 'x',
        kind: 'STAGING',
        baseUrl: url,
      });
      seen.add(refused.body.error.message);
      // Neither the class, nor the deployment mode, nor the host.
      expect(refused.body.error.message).not.toMatch(/loopback|private|link-local|HOSTED/);
    }
    expect([...seen]).toEqual([EGRESS_REFUSAL_SENTENCE]);
  });

  it('names the field so a form can highlight it', async () => {
    const refused = await call('POST', '/projects/proj_a/environments', {
      name: 'x',
      kind: 'STAGING',
      baseUrl: 'http://169.254.169.254/',
    });
    expect(refused.body.error.details.refusedPaths).toEqual(['baseUrl']);
  });

  it('still creates an environment at a public address', async () => {
    const created = await call('POST', '/projects/proj_a/environments', {
      name: 'prod',
      kind: 'PRODUCTION',
      baseUrl: 'https://app.example.com',
    });
    expect(created.status).toBe(201);
    expect(egressAudits()).toHaveLength(0);
  });

  /**
   * `localhost` is a NAME with `internal: true`, exactly like
   * `metadata.google.internal`, and this door decides the synchronous half
   * only. The onboarding panel offers a one-click button that sets this very
   * URL to test the bundled demo, so refusing it here would break a working
   * product on the next deploy; the name's verdict is taken at the moment the
   * connection is opened, by a control that is wired. Asserted as the MEASURED
   * behaviour rather than left to be rediscovered as a hole.
   */
  it('does NOT refuse the bundled demo URL, and records nothing about it', async () => {
    const created = await call('POST', '/projects/proj_a/environments', {
      name: 'demo',
      kind: 'LOCAL',
      baseUrl: 'http://localhost:5050',
    });
    expect(created.status).toBe(201);
    expect(egressAudits()).toHaveLength(0);
  });
});

// ─── The brake ───────────────────────────────────────────────────────────────

describe('the EGRESS_CLASSIFICATION brake gates the write, not only the report', () => {
  it('in OBSERVE the environment IS created and the decision is counted', async () => {
    install({ organization: [{ id: 'org_1', securityControlModes: { EGRESS_CLASSIFICATION: 'OBSERVE' } }] });

    const created = await call('POST', '/projects/proj_a/environments', {
      name: 'imds',
      kind: 'STAGING',
      baseUrl: 'http://169.254.169.254/',
    });

    expect(created.status).toBe(201);
    expect(store.environment.some((e) => e.baseUrl === 'http://169.254.169.254/')).toBe(true);

    const audit = egressAudits();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      mode: 'OBSERVE',
      outcome: 'WOULD_REFUSE',
      wouldHaveRefused: true,
      addressClass: 'link-local',
      context: 'CRAWL',
    });
  });

  it('falls back to the control\'s own default (ENFORCE) for an unreadable column', async () => {
    install({ organization: [{ id: 'org_1', securityControlModes: 'not an object' }] });
    const created = await call('POST', '/projects/proj_a/environments', {
      name: 'imds',
      kind: 'STAGING',
      baseUrl: 'http://10.0.0.5/',
    });
    expect(created.status).toBe(400);
    expect(egressAudits()[0]!.metadata.outcome).toBe('REFUSED');
  });
});

// ─── The stored policy, and the edit that must not be refused ───────────────

describe('repointing and renaming an environment', () => {
  it('refuses a PATCH that repoints an environment at the metadata service', async () => {
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://169.254.169.254/',
    });
    expect(patched.status).toBe(400);
    expect(store.environment[0]!.baseUrl).toBe('https://staging.example.com');
  });

  /**
   * THE ALREADY-STORED BAD BASE URL, which is the interesting case: a customer
   * whose staging box has always been on `10.0.0.5` must still be able to
   * rename it and move it between runner pools. Refusing an edit that does not
   * mention `baseUrl` would make a stored address a permanent lock on the row.
   */
  it('renames an environment whose stored base URL this policy would refuse', async () => {
    install({
      environment: [
        {
          id: 'env_a',
          orgId: 'org_1',
          projectId: 'proj_a',
          name: 'old name',
          kind: 'STAGING',
          baseUrl: 'http://10.0.0.5/',
          runnerPool: null,
          egressPolicy: null,
        },
      ],
    });

    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      name: 'new name',
    });
    expect(patched.status).toBe(200);
    expect(store.environment[0]!.name).toBe('new name');
    expect(store.environment[0]!.baseUrl).toBe('http://10.0.0.5/');
    expect(egressAudits()).toHaveLength(0);
  });

  /**
   * A SELF_HOSTED environment legitimately points at a private address, and
   * that decision belongs to `baseUrlEgressProblem` rather than to this route —
   * which is also the assertion that catches `egressPolicy: true` being dropped
   * from the PATCH route's `select`, since the policy would then read as the
   * HOSTED default and the edit would be refused.
   */
  it('permits a private address on an environment whose stored policy is SELF_HOSTED', async () => {
    install({
      environment: [
        {
          id: 'env_a',
          orgId: 'org_1',
          projectId: 'proj_a',
          name: 'internal',
          kind: 'STAGING',
          baseUrl: 'https://app.example.com',
          runnerPool: null,
          egressPolicy: { deployment: 'SELF_HOSTED', mode: 'ENFORCE' },
        },
      ],
    });

    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5:3000/',
    });
    expect(patched.status).toBe(200);
    expect(store.environment[0]!.baseUrl).toBe('http://10.0.0.5:3000/');
  });

  /**
   * ...and the line that does NOT move. A SELF_HOSTED install running on EC2
   * has an instance role worth stealing exactly like a hosted one does, so
   * `link-local` is refused in both deployment modes.
   */
  it('refuses the metadata address even on a SELF_HOSTED environment', async () => {
    install({
      environment: [
        {
          id: 'env_a',
          orgId: 'org_1',
          projectId: 'proj_a',
          name: 'internal',
          kind: 'STAGING',
          baseUrl: 'https://app.example.com',
          runnerPool: null,
          egressPolicy: { deployment: 'SELF_HOSTED', mode: 'ENFORCE' },
        },
      ],
    });

    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://169.254.169.254/',
    });
    expect(patched.status).toBe(400);
    expect(egressAudits()[0]!.metadata.deployment).toBe('SELF_HOSTED');
  });
});

// ─── The escape the refusal names ───────────────────────────────────────────

describe('the egress allowlist the refusal names actually widens this door', () => {
  const entry = (over: Row = {}): Row => ({
    id: 'allow_1',
    orgId: 'org_1',
    environmentId: 'env_a',
    host: '10.0.0.5',
    contexts: ['CRAWL'],
    ownerEmail: 'sre@example.com',
    reason: 'the staging box lives behind our own firewall',
    expiresAt: null,
    ...over,
  });

  it('permits a private address named by an entry for THIS environment', async () => {
    install({ egressAllowlistEntry: [entry()] });
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5/',
    });
    expect(patched.status).toBe(200);
    expect(egressAudits()).toHaveLength(0);
  });

  /**
   * THE ORG-WIDE ENTRY IS WHAT MAKES THE CREATE PATH REACHABLE. An entry
   * scoped to one environment cannot exist before that environment does, so
   * without this the escape would be: create it (refused), then repoint it
   * (refused).
   */
  it('permits a create at a private address named by an ORG-WIDE entry', async () => {
    install({ egressAllowlistEntry: [entry({ environmentId: null })] });
    const created = await call('POST', '/projects/proj_a/environments', {
      name: 'internal',
      kind: 'STAGING',
      baseUrl: 'http://10.0.0.5/',
    });
    expect(created.status).toBe(201);
  });

  it('does NOT let an expired entry keep widening it', async () => {
    install({
      egressAllowlistEntry: [entry({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })],
    });
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5/',
    });
    expect(patched.status).toBe(400);
  });

  it('matches the host EXACTLY, never as a suffix', async () => {
    install({ egressAllowlistEntry: [entry({ host: '0.0.5' })] });
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5/',
    });
    expect(patched.status).toBe(400);
  });

  it('ignores an entry that does not widen the CRAWL context', async () => {
    install({ egressAllowlistEntry: [entry({ contexts: ['WEBHOOK_DELIVERY'] })] });
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5/',
    });
    expect(patched.status).toBe(400);
  });

  it('does not reach another environment\'s entry', async () => {
    install({
      egressAllowlistEntry: [entry({ environmentId: 'env_elsewhere' })],
    });
    const patched = await call('PATCH', '/projects/proj_a/environments/env_a', {
      baseUrl: 'http://10.0.0.5/',
    });
    expect(patched.status).toBe(400);
  });
});
