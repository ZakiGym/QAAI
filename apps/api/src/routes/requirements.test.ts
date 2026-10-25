/**
 * Tests for the specification ingest door, over HTTP.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. A CRITERION KEEPS ITS ROW WHEN THE LIST IS REORDERED. Insert a bullet
 *      at the top of a ticket and every ordinal below it shifts. Matched by
 *      ordinal alone, a link a PERSON asserted against criterion 3 would
 *      silently claim to cover the text that used to be criterion 2. This is
 *      the one defect in this file that quietly corrupts an audit artifact, so
 *      it is asserted on the stored rows AND on the surviving link.
 *
 *   2. NOT_SEARCHED IS NEVER REPORTED AS NOT_LINKED. An import looks for no
 *      tests, so every new row is our silence. Both counts come back on every
 *      read, and the import says so in words.
 *
 *   3. A GUESS CANNOT MASQUERADE AS TRACEABILITY. SURFACE_MATCH is capped at
 *      0.5, below `TRACEABLE_LINK_CONFIDENCE`, the clamp is REPORTED, and its
 *      sentence lands on the row's own evidence.
 *
 *   4. A STATUS WE DO NOT RECOGNISE IS UNMAPPED WITH THE WORD, NEVER A
 *      DEFAULT. `requirementCounts` decides from that member whether a row is
 *      in the denominator, so a guess here is a coverage percentage moved by a
 *      mapping table nobody reviewed. Including the case that cost real
 *      thought: GitHub's `open` is not Jira's "Open".
 *
 *   5. EVERY CAP IS DISCLOSED AS A COUNT AND A REASON — the import batch, the
 *      connector page limit, the byte limit. An ingest that stops at 1,000 rows
 *      and reports success is the undisclosed cap that makes coverage go UP.
 *
 *   6. A CONNECTOR WE CANNOT RUN IS A 501 WITH A REASON, NEVER AN EMPTY
 *      IMPORT. And its credential comes off an `Integration` row the customer
 *      owns — there is no environment variable anywhere in this path.
 *
 *   7. EVERY ROUTE CHECKS ITS SCOPE AND ITS ROLE, AND CROSS-TENANT IS A 404.
 *      The auth mock carries the real semantics, so a handler with no
 *      `requireScope` fails here.
 *
 * Harness: the same shape as routes/surface.test.ts — a mocked prisma module
 * with a real AsyncLocalStorage tenant scope, a select-honouring in-memory
 * store whose `$transaction` hands back the same delegates (so a write inside
 * one is visible, which is where `persistRequirement` does all its work), and
 * the real router over a loopback socket. The connector HTTP is injected, so
 * nothing here opens a socket to a provider.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; scopes: string[]; ip: string | null };
  audits: Row[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', scopes: ['*'], ip: null },
  audits: [],
}));

vi.mock('../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    ANTHROPIC_API_KEY: null,
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
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

vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

vi.mock('../lib/audit.js', () => ({
  audit: async (input: Row) => {
    h.audits.push(input);
  },
}));

/*
 * The vault is mocked, not exercised. `openToken` is lib/integrations.ts's job
 * and has its own tests; what matters here is that the credential comes off the
 * Integration ROW and that an unopenable one is a 422 rather than a 500. The
 * fake returns a marker so a test can prove the token reached the reader's
 * Authorization header and NEVER the response or the audit log.
 */
vi.mock('../lib/integrations.js', () => ({
  openToken: (ciphertext: string) => {
    if (ciphertext === 'broken') throw new Error('bad tag');
    return 'TOKEN-7731';
  },
}));

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

vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  const { forbidden, unauthorized } = await import('../lib/errors.js');

  type Next = (err?: unknown) => void;
  return {
    requireAuth: (req: Row, _res: Row, next: Next) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: (minimum: string) => (req: Row, _res: Row, next: Next) => {
      if (!req.actor) {
        next(unauthorized());
        return;
      }
      const rank = ROLE_RANK as Record<string, number>;
      if ((rank[req.actor.role] ?? -1) < (rank[minimum] ?? 0)) {
        next(forbidden(`This action requires the ${minimum} role or higher`));
        return;
      }
      next();
    },
    requireScope: (scope: string) => (req: Row, _res: Row, next: Next) => {
      if (!req.actor) {
        next(unauthorized());
        return;
      }
      const scopes: string[] = req.actor.scopes ?? [];
      if (!scopes.includes('*') && !scopes.includes(scope)) {
        next(forbidden(`This API key is missing the "${scope}" scope`));
        return;
      }
      next();
    },
    actorOf: (req: Row) => req.actor,
  };
});

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

type ModelName =
  | 'project'
  | 'user'
  | 'test'
  | 'coverageItem'
  | 'integration'
  | 'requirement'
  | 'acceptanceCriterion'
  | 'requirementLink';

const KNOWN_FILTERS: Record<ModelName, Set<string>> = {
  project: new Set(['id', 'orgId']),
  user: new Set(['id', 'email']),
  test: new Set(['id', 'orgId', 'projectId']),
  coverageItem: new Set(['id', 'orgId', 'projectId', 'key']),
  integration: new Set(['id', 'orgId', 'kind', 'enabled']),
  requirement: new Set([
    'id',
    'orgId',
    'projectId',
    'sourceSystem',
    'externalId',
    'status',
    'linkState',
    'retiredAt',
  ]),
  acceptanceCriterion: new Set(['id', 'orgId', 'requirementId', 'ordinal', 'retiredAt']),
  requirementLink: new Set([
    'id',
    'orgId',
    'projectId',
    'requirementId',
    'criterionId',
    'testId',
    'coverageItemId',
    'method',
  ]),
};

/** Models with no orgId column, mirroring GLOBAL_MODELS in lib/prisma.ts. */
const GLOBAL_MODELS = new Set<ModelName>(['user']);

type Store = Record<ModelName, Row[]>;

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond === null) return (value ?? null) === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (cond && typeof cond === 'object') {
    const c = cond as Row;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('not' in c) return !matchesCondition(value, c.not);
    throw new Error(`fake prisma: unsupported condition ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matchesWhere(model: ModelName, row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!KNOWN_FILTERS[model].has(key)) {
      throw new Error(`fake prisma: unsupported filter on ${model}.${key}`);
    }
    return matchesCondition(row[key] ?? null, cond);
  });
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, dir] = Object.entries(clause)[0] as [string, string];
      const left = a[key] instanceof Date ? a[key].getTime() : a[key];
      const right = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (left === right) continue;
      return (left < right ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/**
 * `select` is HONOURED, including the nested `criteria` relation the
 * traceability read asks for.
 *
 * A select-blind fake makes deleting a field from a query undetectable: the
 * router would read `row.retiredAt` from a result it never asked for, the test
 * would pass, and production would read `undefined`.
 */
function projectRow(model: ModelName, row: Row, sel: Row | undefined, store: Store): Row {
  if (!sel) return { ...row };
  const out: Row = {};
  for (const [key, want] of Object.entries(sel)) {
    if (want === true) {
      out[key] = row[key] ?? null;
      continue;
    }
    if (key === 'criteria' && model === 'requirement') {
      const nested = want as Row;
      const mine = store.acceptanceCriterion.filter(
        (candidate) =>
          candidate.requirementId === row.id &&
          matchesWhere('acceptanceCriterion', candidate, nested.where ?? {}),
      );
      out.criteria = sortRows(mine, nested.orderBy).map((criterion) =>
        projectRow('acceptanceCriterion', criterion, nested.select, store),
      );
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
    const scopedWhere = (where: Row = {}): Row => {
      const orgId = global ? null : h.currentOrg();
      return orgId ? { ...where, orgId } : { ...where };
    };
    const select = (where: Row = {}): Row[] =>
      store[name].filter((row) => matchesWhere(name, row, scopedWhere(where)));
    /** The unique selector, compound or not, matched literally. */
    const unique = (where: Row): Row =>
      (where.projectId_sourceSystem_externalId ?? where.requirementId_ordinal ?? where) as Row;
    const bySelector = (where: Row): Row | undefined =>
      store[name].find((row) =>
        Object.entries(unique(where)).every(([key, value]) => row[key] === value),
      );

    return {
      findUnique: async ({ where, select: sel }: Row) => {
        const found = bySelector(where);
        if (!found) return null;
        if (!global && found.orgId !== h.currentOrg()) return null;
        return projectRow(name, found, sel, store);
      },
      findFirst: async ({ where, orderBy, select: sel }: Row = {}) => {
        const found = sortRows(select(where), orderBy)[0];
        return found ? projectRow(name, found, sel, store) : null;
      },
      findMany: async ({ where, orderBy, select: sel, take, skip }: Row = {}) => {
        const rows = sortRows(select(where), orderBy);
        const from = typeof skip === 'number' ? skip : 0;
        const page = typeof take === 'number' ? rows.slice(from, from + take) : rows.slice(from);
        return page.map((row) => projectRow(name, row, sel, store));
      },
      count: async ({ where }: Row = {}) => select(where).length,
      create: async ({ data, select: sel }: Row) => {
        const orgId = global ? null : h.currentOrg();
        const row: Row = {
          id: nextId(name),
          retiredAt: null,
          linkState: 'NOT_SEARCHED',
          linkedAt: null,
          contentChangedAt: null,
          statusRaw: null,
          url: null,
          externalId: null,
          byUserId: null,
          byEmail: null,
          criterionId: null,
          testId: null,
          coverageItemId: null,
          ...data,
          ...(orgId ? { orgId } : {}),
          firstImportedAt: new Date('2026-01-01T00:00:00Z'),
          lastImportedAt: new Date('2026-01-01T00:00:00Z'),
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
          createdAt: new Date('2026-01-01T00:00:00Z'),
        };
        store[name].push(row);
        return projectRow(name, row, sel, store);
      },
      update: async ({ where, data, select: sel }: Row) => {
        const found = bySelector(where);
        if (!found) throw new Error(`fake prisma: no ${name} to update`);
        if (!global && found.orgId !== h.currentOrg()) {
          throw new Error(`fake prisma: cross-tenant ${name}.update`);
        }
        /*
         * The unique constraint is MODELLED, not assumed. `@@unique([requirementId,
         * ordinal])` is what forces `persistRequirement`'s two-phase ordinal
         * shuffle; a fake that let two criteria hold ordinal 0 at once would
         * pass the reorder test with the shuffle deleted.
         */
        if (name === 'acceptanceCriterion' && typeof data.ordinal === 'number') {
          const clash = store.acceptanceCriterion.find(
            (candidate) =>
              candidate.id !== found.id &&
              candidate.requirementId === found.requirementId &&
              candidate.ordinal === data.ordinal,
          );
          if (clash) {
            throw new Error(
              `fake prisma: unique violation on acceptanceCriterion(${found.requirementId}, ${data.ordinal})`,
            );
          }
        }
        Object.assign(found, data);
        return projectRow(name, found, sel, store);
      },
    };
  };

  const db: Row = {};
  for (const name of Object.keys(KNOWN_FILTERS) as ModelName[]) db[name] = model(name);
  /*
   * `persistRequirement` does ALL its writing inside `$transaction(fn)`, so the
   * callback is handed the same delegates — which is what the real extended
   * client does too (the tx client inherits the tenancy extension). A fake that
   * put the delegates only at the top level would make every write inside the
   * transaction throw on `undefined`.
   */
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORG = 'org_1';
const PROJECT = 'proj_1';
const OTHER_ORG_PROJECT = 'proj_2';

function seed(): Store {
  return {
    project: [
      { id: PROJECT, orgId: ORG, name: 'Storefront' },
      { id: OTHER_ORG_PROJECT, orgId: 'org_2', name: 'Someone else' },
    ],
    user: [{ id: 'user_1', email: 'qa@example.test' }],
    test: [
      { id: 'test_1', orgId: ORG, projectId: PROJECT, name: 'checkout works' },
      { id: 'test_elsewhere', orgId: ORG, projectId: 'proj_other', name: 'not ours' },
    ],
    coverageItem: [
      {
        id: 'item_1',
        orgId: ORG,
        projectId: PROJECT,
        key: 'ROUTE:/checkout',
      },
    ],
    integration: [
      {
        id: 'int_jira',
        orgId: ORG,
        kind: 'JIRA',
        name: 'Acme Jira',
        enabled: true,
        configEnc: 'sealed',
        config: { baseUrl: 'https://acme.atlassian.net', projectKey: 'QA', email: 'bot@acme.test' },
      },
      {
        id: 'int_github',
        orgId: ORG,
        kind: 'GITHUB',
        name: 'Acme repo',
        enabled: true,
        configEnc: 'sealed',
        config: { repo: 'acme/storefront' },
      },
      {
        id: 'int_broken',
        orgId: ORG,
        kind: 'JIRA',
        name: 'Stale credential',
        enabled: true,
        configEnc: 'broken',
        config: { baseUrl: 'https://acme.atlassian.net', projectKey: 'QA' },
      },
    ],
    requirement: [],
    acceptanceCriterion: [],
    requirementLink: [],
  };
}

let store: Store;

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { requirementsRouter, configureRequirementsIo, SPEC_CONNECTORS, extractCriteria, parseCsv } =
  await import('./requirements.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json({ limit: '24mb' }));
app.use(requirementsRouter);
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

const get = (path: string) => call('GET', path);
const post = (path: string, body?: unknown) => call('POST', path, body);

function asActor(overrides: Partial<Hoisted['actor']> = {}): void {
  h.actor = { userId: 'user_1', orgId: ORG, role: 'MEMBER', scopes: ['*'], ip: null, ...overrides };
}

const message = (body: Row): string => String(body.error?.message ?? body.message ?? '');

let restoreIo: ReturnType<typeof configureRequirementsIo> | null = null;
let httpCalls: Array<{ url: string; headers: Record<string, string> }> = [];

function wireHttp(responses: Array<{ status?: number; json: unknown }>): void {
  let index = 0;
  restoreIo = configureRequirementsIo({
    http: async (request) => {
      httpCalls.push({ url: request.url, headers: request.headers });
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { status: next.status ?? 200, json: next.json, text: JSON.stringify(next.json) };
    },
  });
}

beforeEach(() => {
  asActor();
  h.audits.length = 0;
  httpCalls = [];
  store = seed();
  h.prisma = makeDb(store);
});

afterEach(() => {
  if (restoreIo) configureRequirementsIo(restoreIo);
  restoreIo = null;
});

/** One requirement in the shape `requirementImportSchema` accepts. */
function requirement(overrides: Row = {}): Row {
  return {
    externalId: 'PROJ-1',
    sourceSystem: 'JIRA',
    title: 'Checkout accepts a saved card',
    body: 'A returning customer can pay with a stored card.',
    status: 'DONE',
    statusRaw: 'Done',
    url: null,
    criteria: [
      { ordinal: 0, text: 'the saved card is offered', format: 'BULLET', externalId: null },
      { ordinal: 1, text: 'the charge succeeds', format: 'BULLET', externalId: null },
    ],
    ...overrides,
  };
}

const inline = (rows: Row[], extra: Row = {}) =>
  post(`/requirements/${PROJECT}`, { source: 'INLINE', requirements: rows, ...extra });

// ─── 1. The criteria extractor ──────────────────────────────────────────────

describe('extractCriteria', () => {
  it('keeps a Gherkin scenario as ONE criterion, not four bullets', async () => {
    const { criteria, estimated } = extractCriteria(
      'Given a cart with 3 items\nWhen the customer pays\nThen the order is created\nAnd a receipt is sent',
    );

    // Four criteria here would inflate the spec-side denominator and make
    // "three of four criteria are untested" a sentence about our parser.
    expect(criteria).toHaveLength(1);
    expect(criteria[0]!.format).toBe('GIVEN_WHEN_THEN');
    expect(criteria[0]!.text).toContain('And a receipt is sent');
    expect(estimated).toBe(false);
  });

  it('reads a checkbox as a checkbox and not as a bullet', async () => {
    const { criteria } = extractCriteria('- [ ] card is offered\n- [x] charge succeeds');

    // A `- [ ]` line is also a bullet; testing in the wrong order loses the
    // distinction the format enum exists to record.
    expect(criteria.map((entry) => entry.format)).toEqual(['CHECKBOX', 'CHECKBOX']);
    expect(criteria[0]!.text).toBe('card is offered');
  });

  it('drops a table header rather than counting it as a criterion', async () => {
    const { criteria } = extractCriteria(
      '| input | expected |\n| --- | --- |\n| 0 items | refused |\n| 1 item | accepted |',
    );

    expect(criteria).toHaveLength(2);
    expect(criteria.map((entry) => entry.format)).toEqual(['TABLE_ROW', 'TABLE_ROW']);
    expect(criteria[0]!.text).toBe('0 items | refused');
  });

  it('falls back to sentences and SAYS the count is an estimate', async () => {
    const { criteria, estimated } = extractCriteria(
      'The customer can pay with a saved card. The receipt shows the last four digits.',
    );

    expect(criteria).toHaveLength(2);
    expect(criteria.every((entry) => entry.format === 'UNSTRUCTURED')).toBe(true);
    // A count arrived at by splitting on full stops must not be printed beside
    // an exact one without saying which it is.
    expect(estimated).toBe(true);
  });

  it('numbers criteria from 0 in the order they appear', async () => {
    const { criteria } = extractCriteria('1. first\n2. second\n3. third');
    expect(criteria.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(criteria.map((entry) => entry.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('parseCsv', () => {
  it('keeps commas and newlines inside a quoted field', async () => {
    const rows = parseCsv('id,criteria\nPROJ-1,"Given a cart with 3 items,\nthen it is kept"');

    // Splitting on commas would shear every interesting acceptance criterion in
    // half, and the damage would look like the customer's data being malformed.
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]).toBe('Given a cart with 3 items,\nthen it is kept');
  });

  it('reads a doubled quote as one quote', async () => {
    const rows = parseCsv('id,title\nPROJ-1,"the ""saved card"" option"');
    expect(rows[1]![1]).toBe('the "saved card" option');
  });
});

// ─── 2. Import, re-import, and the content hash ─────────────────────────────

describe('POST /requirements/:projectId — inline', () => {
  it('stores the requirement and its criteria as ROWS', async () => {
    const { status, body } = await inline([requirement()]);

    expect(status).toBe(201);
    expect(body.totals).toMatchObject({ accepted: 1, NEW: 1, criteriaStored: 2 });
    expect(store.requirement).toHaveLength(1);
    expect(store.acceptanceCriterion).toHaveLength(2);
    expect(store.acceptanceCriterion.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(store.requirement[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.requirement[0]!.statusRaw).toBe('Done');
  });

  it('leaves a new row NOT_SEARCHED and says so in words', async () => {
    const { body } = await inline([requirement()]);

    // Our silence, not a finding. An import looks for no tests.
    expect(store.requirement[0]!.linkState).toBe('NOT_SEARCHED');
    expect(String(body.linkStateNote)).toContain('NOT_SEARCHED');
    expect(String(body.linkStateNote)).toContain('NOT_LINKED');
  });

  it('reports an unchanged re-import as UNCHANGED and does not stamp a change date', async () => {
    await inline([requirement()]);
    const { body } = await inline([requirement()]);

    expect(body.totals).toMatchObject({ UNCHANGED: 1, NEW: 0 });
    expect(store.requirement).toHaveLength(1);
    // "When did this specification last change?" must not answer "whenever a
    // cron last ran".
    expect(store.requirement[0]!.contentChangedAt).toBeNull();
  });

  it('reports an edited re-import as CHANGED and stamps the date', async () => {
    await inline([requirement()]);
    const { body } = await inline([requirement({ title: 'Checkout accepts a saved card, v2' })]);

    expect(body.totals).toMatchObject({ CHANGED: 1 });
    expect(store.requirement[0]!.contentChangedAt).not.toBeNull();
  });

  it('does not treat a status change as an edit to the specification', async () => {
    await inline([requirement({ status: 'READY', statusRaw: 'Ready' })]);
    const { body } = await inline([requirement({ status: 'DONE', statusRaw: 'Done' })]);

    // The status is deliberately NOT in the content hash: a ticket moving to
    // Done would otherwise re-open every link in a project on the day its
    // sprint closed.
    expect(body.totals).toMatchObject({ UNCHANGED: 1, CHANGED: 0 });
    expect(store.requirement[0]!.status).toBe('DONE');
  });

  it('calls a stored row with no hash NOT_COMPARABLE, not UNCHANGED', async () => {
    await inline([requirement()]);
    // A row written by an importer that did not hash, or carried in by hand.
    store.requirement[0]!.contentHash = '';

    const { body } = await inline([requirement()]);

    // UNCHANGED would drop the customer's edit silently; CHANGED would churn
    // every link on every import. Neither is true and the fourth member says so.
    expect(body.totals).toMatchObject({ NOT_COMPARABLE: 1 });
    expect((body.changes as Row[])[0]?.detail).toContain('no content hash');
    expect(store.requirement[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses UNMAPPED with no raw status, counts it, and stores nothing', async () => {
    const { body } = await inline([requirement({ status: 'UNMAPPED', statusRaw: null })]);

    // "We could not map it" with nothing to show is indistinguishable from a
    // bug in our mapping table.
    expect(body.totals.rejected).toBe(1);
    expect(body.totals.accepted).toBe(0);
    expect(store.requirement).toHaveLength(0);
    expect((body.problems as string[])[0]).toContain('statusRaw');
  });

  it('counts a duplicated external id instead of letting the second win silently', async () => {
    const { body } = await inline([requirement(), requirement({ title: 'A different title' })]);

    expect(body.totals.duplicates).toBe(1);
    expect(body.totals.accepted).toBe(1);
    expect(store.requirement[0]!.title).toBe('Checkout accepts a saved card');
  });

  it('discloses the import batch cap as a count and a reason', async () => {
    const many = Array.from({ length: 1_002 }, (_, index) =>
      requirement({ externalId: `PROJ-${index}`, criteria: [] }),
    );
    const { body } = await inline(many);

    const hit = (body.capsThatBit as Row[]).find((entry) => entry.cap === 'importBatch');
    expect(hit).toMatchObject({ cap: 'importBatch', limit: 1_000, droppedAtLeast: 2 });
    expect(String(body.capRule)).toContain('hid at least 2');
    expect(store.requirement).toHaveLength(1_000);
  });

  it('dryRun reports the diff and writes nothing', async () => {
    const { status, body } = await inline([requirement()], { dryRun: true });

    expect(status).toBe(200);
    expect(body.applied).toBe(false);
    expect(store.requirement).toHaveLength(0);
  });

  it('never writes requirement text to the audit log', async () => {
    await inline([requirement({ body: 'SHIBBOLETH-9134 is the confidential bit' })]);

    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits[0])).not.toContain('SHIBBOLETH');
    expect(h.audits[0]!.metadata.stored).toBe(1);
  });
});

// ─── 3. The criterion reorder — the expensive defect ────────────────────────

describe('criteria identity across a re-import', () => {
  it('keeps a criterion ROW when a bullet is inserted above it, so its link survives', async () => {
    await inline([requirement()]);
    const second = store.acceptanceCriterion.find((row) => row.ordinal === 1)!;
    const secondId = second.id;

    // A person asserts that a test covers criterion 1, "the charge succeeds".
    const linked = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: 1,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST', testId: 'test_1' },
    });
    expect(linked.status).toBe(201);

    // The ticket is edited: a new first bullet.
    const { body } = await inline([
      requirement({
        criteria: [
          { ordinal: 0, text: 'the cart shows a total', format: 'BULLET', externalId: null },
          { ordinal: 1, text: 'the saved card is offered', format: 'BULLET', externalId: null },
          { ordinal: 2, text: 'the charge succeeds', format: 'BULLET', externalId: null },
        ],
      }),
    ]);

    // THE assertion: the row that said "the charge succeeds" is the SAME row,
    // now at ordinal 2. Delete-plus-insert would have retired the link a person
    // asserted and silently re-pointed criterion 1 at different text.
    const moved = store.acceptanceCriterion.find((row) => row.id === secondId)!;
    expect(moved.text).toBe('the charge succeeds');
    expect(moved.ordinal).toBe(2);
    expect(moved.retiredAt).toBeNull();

    const link = store.requirementLink[0]!;
    expect(link.criterionId).toBe(secondId);
    expect(store.requirementLink).toHaveLength(1);

    // And the move is REPORTED, not silent.
    expect(body.totals.criteriaMoved).toBeGreaterThanOrEqual(1);
    expect((body.changes as Row[])[0]?.criteria.moved).toBeGreaterThanOrEqual(1);
  });

  it('survives two criteria swapping places, which the unique index forbids in one step', async () => {
    await inline([requirement()]);
    const first = store.acceptanceCriterion.find((row) => row.ordinal === 0)!.id;
    const second = store.acceptanceCriterion.find((row) => row.ordinal === 1)!.id;

    const { status } = await inline([
      requirement({
        criteria: [
          { ordinal: 0, text: 'the charge succeeds', format: 'BULLET', externalId: null },
          { ordinal: 1, text: 'the saved card is offered', format: 'BULLET', externalId: null },
        ],
      }),
    ]);

    expect(status).toBe(201);
    expect(store.acceptanceCriterion.find((row) => row.id === first)!.ordinal).toBe(1);
    expect(store.acceptanceCriterion.find((row) => row.id === second)!.ordinal).toBe(0);
    // No row is parked on a negative ordinal once the transaction is done.
    expect(store.acceptanceCriterion.every((row) => row.ordinal >= 0)).toBe(true);
  });

  it('retires a criterion the source stopped stating, rather than deleting it', async () => {
    await inline([requirement()]);
    const dropped = store.acceptanceCriterion.find((row) => row.ordinal === 1)!.id;

    const { body } = await inline([
      requirement({
        criteria: [
          { ordinal: 0, text: 'the saved card is offered', format: 'BULLET', externalId: null },
        ],
      }),
    ]);

    expect(body.totals.criteriaRetired).toBe(1);
    const row = store.acceptanceCriterion.find((entry) => entry.id === dropped)!;
    // Kept, with a date. A shrinking spec-side denominator needs an audit trail
    // at least as much as a growing one.
    expect(row.retiredAt).not.toBeNull();
    expect(store.acceptanceCriterion).toHaveLength(2);
  });
});

// ─── 4. CSV and Markdown ────────────────────────────────────────────────────

describe('POST /requirements/:projectId — CSV and Markdown', () => {
  it('imports a CSV, extracting criteria from the criteria column', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content:
        'Issue Key,Summary,Status,Acceptance Criteria\n' +
        'QA-1,Saved card checkout,Done,"- the card is offered\n- the charge succeeds"\n',
    });

    expect(status).toBe(201);
    expect(body.totals.accepted).toBe(1);
    expect(store.requirement[0]!.sourceSystem).toBe('CSV');
    expect(store.requirement[0]!.status).toBe('DONE');
    expect(store.acceptanceCriterion).toHaveLength(2);
    expect(store.acceptanceCriterion[0]!.format).toBe('BULLET');
  });

  it('400s naming the aliases when the CSV has no id column, and stores nothing', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content: 'Summary,Status\nSaved card checkout,Done\n',
    });

    expect(status).toBe(400);
    expect(message(body)).toContain('issue key');
    expect(message(body)).toContain('Summary');
    expect(store.requirement).toHaveLength(0);
  });

  it('counts a CSV row with no id instead of dropping it in silence', async () => {
    const { body } = await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content: 'id,title\nQA-1,Real one\n,No id here\n',
    });

    expect(body.totals.accepted).toBe(1);
    expect((body.problems as string[]).some((problem) => problem.includes('no id'))).toBe(true);
  });

  it('maps an unrecognised status word to UNMAPPED with the word kept', async () => {
    await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content: 'id,title,status\nQA-1,Saved card,Pending Grooming\n',
    });

    // Not DRAFT, not READY. `requirementCounts` decides from this member
    // whether the row is in the denominator.
    expect(store.requirement[0]!.status).toBe('UNMAPPED');
    expect(store.requirement[0]!.statusRaw).toBe('Pending Grooming');
  });

  it('reports a status column that is simply absent as NOT_STATED', async () => {
    await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content: 'id,title\nQA-1,Saved card\n',
    });

    // NOT_STATED is "the source declared no status", which is not DRAFT.
    expect(store.requirement[0]!.status).toBe('NOT_STATED');
    expect(store.requirement[0]!.statusRaw).toBeNull();
  });

  it('imports Markdown sections and discloses every id it had to invent', async () => {
    const { body } = await post(`/requirements/${PROJECT}`, {
      source: 'MARKDOWN',
      content:
        '## PROJ-412 Saved card checkout\n- the card is offered\n\n' +
        '## Refunds, eventually\n- a refund can be issued\n',
    });

    expect(body.totals.accepted).toBe(2);
    expect(body.totals.idsSynthesised).toBe(1);
    expect(store.requirement.map((row) => row.externalId).sort()).toEqual([
      'PROJ-412',
      'refunds-eventually',
    ]);
    expect(store.requirement.find((row) => row.externalId === 'PROJ-412')!.title).toBe(
      'Saved card checkout',
    );
    // Editing that heading changes the id and orphans every link asserted
    // against it, so saying nothing is not an option.
    expect((body.problems as string[]).some((problem) => problem.includes('orphans'))).toBe(true);
  });

  it('refuses headingless Markdown rather than inventing one requirement', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'MARKDOWN',
      content: 'Just some prose with no headings at all.',
    });

    expect(status).toBe(400);
    expect(message(body)).toContain('no headings');
    expect(store.requirement).toHaveLength(0);
  });

  it('refuses a document past the byte cap instead of truncating it', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CSV',
      content: `id,title\n${'QA-1,x\n'.repeat(600_000)}`,
    });

    expect(status).toBe(400);
    expect(message(body)).toContain('refused');
    expect(store.requirement).toHaveLength(0);
  });
});

// ─── 5. Connectors ──────────────────────────────────────────────────────────

describe('POST /requirements/:projectId — connectors', () => {
  it('reads a Jira project, pages it, and carries the token only in the header', async () => {
    wireHttp([
      {
        json: {
          total: 1,
          issues: [
            {
              key: 'QA-7',
              fields: {
                summary: 'Saved card checkout',
                status: { name: 'In Progress' },
                description: {
                  type: 'doc',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: '- card is offered' }] },
                    { type: 'paragraph', content: [{ type: 'text', text: '- charge succeeds' }] },
                  ],
                },
              },
            },
          ],
        },
      },
    ]);

    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_jira',
    });

    expect(status).toBe(201);
    expect(body.totals.accepted).toBe(1);
    expect(body.connector).toMatchObject({ pagesFetched: 1, moreAvailable: false });
    expect(store.requirement[0]!.sourceSystem).toBe('JIRA');
    expect(store.requirement[0]!.status).toBe('IN_PROGRESS');
    expect(store.requirement[0]!.url).toBe('https://acme.atlassian.net/browse/QA-7');
    // ADF read as a tree, not stringified: `[object Object]` would have become
    // the body and the criteria would have been extracted from punctuation.
    expect(store.acceptanceCriterion.map((row) => row.text)).toEqual([
      'card is offered',
      'charge succeeds',
    ]);
    // The credential came off the Integration row, went into the header, and
    // reached neither the response nor the audit log.
    expect(httpCalls[0]!.headers.authorization).toContain(
      Buffer.from('bot@acme.test:TOKEN-7731').toString('base64'),
    );
    expect(JSON.stringify(body)).not.toContain('TOKEN-7731');
    expect(JSON.stringify(h.audits)).not.toContain('TOKEN-7731');
  });

  it('discloses the connector page cap as a cap that bit', async () => {
    // Every page comes back full, so the provider always says there is more.
    wireHttp([
      {
        json: {
          total: 10_000,
          issues: Array.from({ length: 100 }, (_, index) => ({
            key: `QA-${index}`,
            fields: { summary: `Issue ${index}`, status: { name: 'Done' }, description: '' },
          })),
        },
      },
    ]);

    const { body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_jira',
    });

    expect(body.connector).toMatchObject({ pagesFetched: 20, pageLimit: 20, moreAvailable: true });
    const hit = (body.capsThatBit as Row[]).find((entry) => entry.cap === 'connectorPages');
    // A FLOOR of 1 and not an invented number: the provider said another page
    // exists, so at least one more row does.
    expect(hit).toMatchObject({ limit: 20, droppedAtLeast: 1 });
  });

  it('names a Jira description it cannot read instead of storing an empty body', async () => {
    wireHttp([
      {
        json: {
          total: 1,
          issues: [
            {
              key: 'QA-9',
              fields: {
                summary: 'Odd description',
                status: { name: 'Done' },
                // Neither a string nor an ADF tree.
                description: { weird: true },
              },
            },
          ],
        },
      },
    ]);

    const { body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_jira',
    });

    // Our gap, named as ours, rather than "this ticket has no description".
    expect(
      (body.problems as string[]).some(
        (problem) => problem.includes('QA-9') && problem.includes('our gap'),
      ),
    ).toBe(true);
  });

  it('maps GitHub `open` to UNMAPPED and skips pull requests', async () => {
    wireHttp([
      {
        json: [
          { number: 1, title: 'A real issue', state: 'open', body: '- it works' },
          { number: 2, title: 'A pull request', state: 'open', pull_request: { url: 'x' } },
          { number: 3, title: 'Closed as wont-do', state: 'closed', state_reason: 'not_planned' },
          { number: 4, title: 'Shipped', state: 'closed', state_reason: 'completed' },
        ],
      },
    ]);

    const { body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'GITHUB_ISSUES',
      integrationId: 'int_github',
    });

    expect(body.totals.accepted).toBe(3);
    const byId = new Map(store.requirement.map((row) => [row.externalId, row]));
    // GitHub's `open` is a binary, not a workflow state. READY here would tell
    // a generator to expect every open issue's test to fail.
    expect(byId.get('#1')).toMatchObject({ status: 'UNMAPPED', statusRaw: 'open' });
    expect(byId.get('#3')!.status).toBe('OBSOLETE');
    expect(byId.get('#4')!.status).toBe('DONE');
    // A pull request is not a requirement; counting it inflates the spec-side
    // denominator with our own review traffic.
    expect(byId.has('#2')).toBe(false);
  });

  it('501s with the reason for a connector whose provenance we cannot record', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'CONFLUENCE',
      integrationId: 'int_jira',
    });

    expect(status).toBe(501);
    expect(message(body)).toContain('SpecSourceSystem');
    // Not a 200 with nothing: "we imported nothing" and "we could not look" are
    // opposite facts.
    expect(store.requirement).toHaveLength(0);
  });

  it('refuses an integration of the wrong kind, and one with no credential', async () => {
    const wrongKind = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_github',
    });
    expect(wrongKind.status).toBe(400);
    expect(message(wrongKind.body)).toContain('GITHUB');

    store.integration.push({
      id: 'int_empty',
      orgId: ORG,
      kind: 'JIRA',
      name: 'No token',
      enabled: true,
      configEnc: null,
      config: { baseUrl: 'https://acme.atlassian.net', projectKey: 'QA' },
    });
    const noToken = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_empty',
    });
    expect(noToken.status).toBe(400);
    expect(message(noToken.body)).toContain('never in the environment');
  });

  it('422s on a credential it cannot open, without echoing the failure', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_broken',
    });

    expect(status).toBe(422);
    expect(message(body)).toContain('Re-enter it');
    // The vault's own message can carry key material.
    expect(message(body)).not.toContain('bad tag');
  });

  it('turns a provider refusal into a 422 and imports nothing', async () => {
    wireHttp([{ status: 401, json: { errorMessages: ['Unauthorized'] } }]);
    const { status } = await post(`/requirements/${PROJECT}`, {
      source: 'CONNECTOR',
      connector: 'JIRA',
      integrationId: 'int_jira',
    });

    expect(status).toBe(422);
    expect(store.requirement).toHaveLength(0);
  });
});

describe('GET /requirements/:projectId/connectors', () => {
  it('lists every connector with a reason when it cannot run', async () => {
    const { status, body } = await get(`/requirements/${PROJECT}/connectors`);

    expect(status).toBe(200);
    const byName = new Map((body.connectors as Row[]).map((entry) => [entry.connector, entry]));
    expect([...byName.keys()].sort()).toEqual([...SPEC_CONNECTORS].sort());

    expect(byName.get('JIRA')).toMatchObject({ available: true, unavailableReason: null });
    expect(byName.get('JIRA')!.integrations).toEqual([
      { id: 'int_jira', name: 'Acme Jira' },
      { id: 'int_broken', name: 'Stale credential' },
    ]);

    // Our vocabulary's gap, named as ours, and distinct from "you have not
    // connected one".
    expect(byName.get('NOTION')).toMatchObject({
      available: false,
      unavailableReason: 'NO_SOURCE_SYSTEM',
      bodyIsTheSource: true,
    });
    expect(byName.get('LINEAR')).toMatchObject({
      available: false,
      unavailableReason: 'NOT_CONFIGURED',
    });
    expect(body.credentialFreeSources).toEqual(['INLINE', 'CSV', 'MARKDOWN']);
  });
});

// ─── 6. Links and traceability ──────────────────────────────────────────────

describe('POST /requirements/:projectId/links', () => {
  beforeEach(async () => {
    await inline([requirement()]);
  });

  it('records a human assertion as ASSERTED, with the person on the row', async () => {
    const { status, body } = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: 0,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST', testId: 'test_1' },
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      clamped: false,
      traceable: true,
      requirementLinkState: 'ASSERTED',
      criterionLinkState: 'ASSERTED',
    });
    expect(store.requirement[0]!.linkState).toBe('ASSERTED');
    expect(store.requirement[0]!.linkedAt).not.toBeNull();
    // A waiver-shaped rule: who made the claim must survive.
    expect(store.requirementLink[0]!.byEmail).toBe('qa@example.test');
  });

  it('caps a guess below the traceable threshold and puts the rule on the row', async () => {
    const { body } = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'SURFACE_MATCH',
      confidence: 0.99,
      criterionOrdinal: null,
      evidence: 'the requirement names /checkout and a test visits it',
      target: { target: 'SURFACE', coverageItemId: 'item_1' },
    });

    // A link that cannot exceed a coin flip cannot be the reason a requirement
    // reads as covered.
    expect(body).toMatchObject({ confidence: 0.5, clamped: true, traceable: false });
    expect(String(body.clampRule)).toContain('capped at 0.5');
    expect(store.requirementLink[0]!.evidence).toContain('capped at 0.5');
    // Links exist but every one is a machine's guess.
    expect(store.requirement[0]!.linkState).toBe('INFERRED');
    // A machine's link has no author to record.
    expect(store.requirementLink[0]!.byUserId).toBeNull();
  });

  it('updates rather than duplicating when the same claim is made twice', async () => {
    const body = {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL' as const,
      confidence: 1,
      criterionOrdinal: null,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST' as const, testId: 'test_1' },
    };
    const first = await post(`/requirements/${PROJECT}/links`, body);
    const again = await post(`/requirements/${PROJECT}/links`, {
      ...body,
      evidence: 'Re-reviewed on 2026-04-01.',
    });

    expect(first.status).toBe(201);
    // PostgreSQL treats NULLs as distinct in a unique index, so the schema's
    // five-column unique does NOT stop this row being inserted twice. The
    // router prevents it; a second row here would be two claims where a person
    // made one.
    expect(again.status).toBe(200);
    expect(store.requirementLink).toHaveLength(1);
    expect(store.requirementLink[0]!.evidence).toBe('Re-reviewed on 2026-04-01.');
  });

  it('404s on a dangling surface id and on a test from another project', async () => {
    const dangling = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: null,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'SURFACE', coverageItemId: 'item_missing' },
    });
    expect(dangling.status).toBe(404);
    expect(message(dangling.body)).toContain('surface registry');

    const foreign = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: null,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST', testId: 'test_elsewhere' },
    });
    expect(foreign.status).toBe(404);
    expect(store.requirementLink).toHaveLength(0);
  });

  it('refuses a link to a retired criterion', async () => {
    await inline([
      requirement({
        criteria: [
          { ordinal: 0, text: 'the saved card is offered', format: 'BULLET', externalId: null },
        ],
      }),
    ]);

    const { status, body } = await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: 1,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST', testId: 'test_1' },
    });

    expect(status).toBe(400);
    expect(message(body)).toContain('retired');
  });

  it('refuses a target that names both or neither', async () => {
    for (const target of [
      { target: 'TEST', coverageItemId: 'item_1' },
      { target: 'SURFACE', testId: 'test_1' },
      {},
    ]) {
      const { status } = await post(`/requirements/${PROJECT}/links`, {
        externalId: 'PROJ-1',
        sourceSystem: 'JIRA',
        method: 'MANUAL',
        confidence: 1,
        criterionOrdinal: null,
        evidence: 'Reviewed with the payments team on 2026-03-02.',
        target,
      });
      expect(status).toBe(400);
    }
  });
});

describe('GET /requirements/:projectId and /traceability', () => {
  beforeEach(async () => {
    await inline([
      requirement(),
      requirement({ externalId: 'PROJ-2', title: 'Refunds', status: 'READY', statusRaw: 'Ready' }),
    ]);
  });

  it('400s on an unknown filter value and names the valid ones', async () => {
    const { status, body } = await get(`/requirements/${PROJECT}?linkState=NOTLINKED`);

    expect(status).toBe(400);
    expect(message(body)).toContain('NOTLINKED');
    expect(message(body)).toContain('NOT_LINKED');
    expect((await get(`/requirements/${PROJECT}?status=DONEE`)).status).toBe(400);
    expect((await get(`/requirements/${PROJECT}?sourceSystem=JIRAA`)).status).toBe(400);
  });

  it('reports NOT_SEARCHED beside NOT_LINKED on every read', async () => {
    const { body } = await get(`/requirements/${PROJECT}?linkState=NOT_LINKED`);

    expect(body.total).toBe(0);
    // A customer who reads "0 unlinked" without seeing "2 never looked at" has
    // been misled by arithmetic.
    expect(body.byLinkState).toEqual([
      { linkState: 'NOT_SEARCHED', count: 2 },
      { linkState: 'NOT_LINKED', count: 0 },
      { linkState: 'INFERRED', count: 0 },
      { linkState: 'ASSERTED', count: 0 },
    ]);
    expect(String(body.linkStateRule)).toContain('2 requirement(s) are NOT_SEARCHED');
  });

  it('carries the derived testability and denominator membership per row', async () => {
    const { body } = await get(`/requirements/${PROJECT}`);
    const byId = new Map((body.requirements as Row[]).map((entry) => [entry.externalId, entry]));

    expect(byId.get('PROJ-1')).toMatchObject({ testability: 'TESTABLE_NOW', counts: true });
    // A READY requirement's test is expected to FAIL — the feature is not built
    // — and a generator must be told that rather than guess.
    expect(byId.get('PROJ-2')).toMatchObject({ testability: 'NOT_YET_BUILT', counts: true });
  });

  it('drops only the withdrawn rows from the counting set', async () => {
    await inline([requirement({ externalId: 'PROJ-3', status: 'OBSOLETE', statusRaw: 'Cancelled' })]);

    expect((await get(`/requirements/${PROJECT}`)).body.total).toBe(3);
    const counting = await get(`/requirements/${PROJECT}?countingOnly=true`);
    expect(counting.body.total).toBe(2);
    expect(
      (counting.body.requirements as Row[]).every((entry) => entry.counts === true),
    ).toBe(true);
  });

  it('reports the full total even when the page is smaller', async () => {
    const { body } = await get(`/requirements/${PROJECT}?limit=1`);
    expect(body.requirements).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
  });

  it('shows the matrix with per-criterion state and whether each link is a guess', async () => {
    await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'MANUAL',
      confidence: 1,
      criterionOrdinal: 0,
      evidence: 'Reviewed with the payments team on 2026-03-02.',
      target: { target: 'TEST', testId: 'test_1' },
    });
    await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'SURFACE_MATCH',
      confidence: 0.9,
      criterionOrdinal: null,
      evidence: 'the requirement names /checkout and a test visits it',
      target: { target: 'SURFACE', coverageItemId: 'item_1' },
    });

    const { body } = await get(`/requirements/${PROJECT}/traceability`);
    const first = (body.requirements as Row[]).find((entry) => entry.externalId === 'PROJ-1')!;

    // A requirement ASSERTED through one criterion while the other is
    // NOT_SEARCHED. A matrix with only requirement-level state calls that
    // covered.
    expect(first.linkState).toBe('ASSERTED');
    expect(first.criteria[0]!.linkState).toBe('ASSERTED');
    expect(first.criteria[1]!.linkState).toBe('NOT_SEARCHED');
    expect(first.criteria[0]!.links[0]).toMatchObject({
      method: 'MANUAL',
      asserted: true,
      traceable: true,
      target: { target: 'TEST', testId: 'test_1' },
    });
    const guess = first.requirementLevelLinks[0]!;
    expect(guess).toMatchObject({ method: 'SURFACE_MATCH', asserted: false, traceable: false });
    expect(body.traceableConfidence).toBe(0.6);
    expect(body.malformedLinks).toBe(0);
  });

  it('counts a link row that names both targets instead of reading it as a test link', async () => {
    store.requirementLink.push({
      id: 'link_bad',
      orgId: ORG,
      projectId: PROJECT,
      requirementId: store.requirement[0]!.id,
      criterionId: null,
      testId: 'test_1',
      coverageItemId: 'item_1',
      method: 'MANUAL',
      confidence: 1,
      evidence: 'written by a linker with a bug',
      byUserId: null,
      byEmail: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const { body } = await get(`/requirements/${PROJECT}/traceability`);
    const first = (body.requirements as Row[]).find((entry) => entry.externalId === 'PROJ-1')!;

    expect(body.malformedLinks).toBe(1);
    // `linkTargetOfRow` returns null rather than picking whichever column it saw
    // first, so a malformed row is reported instead of becoming coverage.
    expect(first.requirementLevelLinks[0]!.target).toBeNull();
  });

  it('shows only traceable links on request', async () => {
    await post(`/requirements/${PROJECT}/links`, {
      externalId: 'PROJ-1',
      sourceSystem: 'JIRA',
      method: 'SURFACE_MATCH',
      confidence: 0.5,
      criterionOrdinal: null,
      evidence: 'the requirement names /checkout and a test visits it',
      target: { target: 'SURFACE', coverageItemId: 'item_1' },
    });

    const all = await get(`/requirements/${PROJECT}/traceability`);
    const strict = await get(`/requirements/${PROJECT}/traceability?traceableOnly=true`);
    const pick = (body: Row) =>
      (body.requirements as Row[]).find((entry) => entry.externalId === 'PROJ-1')!;

    expect(pick(all.body).linkTotal).toBe(1);
    expect(pick(strict.body).linkTotal).toBe(0);
  });
});

// ─── 7. Auth and tenancy ────────────────────────────────────────────────────

describe('scope, role and tenancy', () => {
  const linkPayload = {
    externalId: 'PROJ-1',
    sourceSystem: 'JIRA',
    method: 'MANUAL',
    confidence: 1,
    criterionOrdinal: null,
    evidence: 'Reviewed with the payments team on 2026-03-02.',
    target: { target: 'TEST', testId: 'test_1' },
  };
  const routes: Array<[string, string, unknown, string]> = [
    ['GET', `/requirements/${PROJECT}`, undefined, 'tests:read'],
    ['GET', `/requirements/${PROJECT}/traceability`, undefined, 'tests:read'],
    ['GET', `/requirements/${PROJECT}/connectors`, undefined, 'tests:read'],
    [
      'POST',
      `/requirements/${PROJECT}`,
      { source: 'INLINE', requirements: [requirement()] },
      'tests:write',
    ],
    ['POST', `/requirements/${PROJECT}/links`, linkPayload, 'tests:write'],
  ];

  it('refuses an API key that is missing the scope', async () => {
    for (const [method, path, body, scope] of routes) {
      asActor({ scopes: ['runs:write'] });
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path} must require ${scope}`).toBe(403);
    }
  });

  it('refuses a VIEWER on the write routes', async () => {
    for (const [method, path, body] of routes.filter(([verb]) => verb === 'POST')) {
      asActor({ role: 'VIEWER' });
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path} must require MEMBER`).toBe(403);
    }
  });

  it("404s on another org's project on every route", async () => {
    for (const [method, path, body] of routes) {
      const response = await call(method, path.replace(PROJECT, OTHER_ORG_PROJECT), body);
      expect(response.status, `${method} ${path} must not reach another org`).toBe(404);
    }
    expect(store.requirement).toHaveLength(0);
  });
});

// ─── 8. The vocabulary's two guards ─────────────────────────────────────────

describe('the connector vocabulary', () => {
  it('has a shape for every member, checked at run time against the list', async () => {
    const { SPEC_CONNECTOR_SHAPES } = await import('./requirements.js');

    /*
     * The run-time half of the pattern this codebase enforces. The compiler
     * already refuses a `Record` with a missing key; this catches the half it
     * cannot see — a member added to the list with no arm reachable from the
     * write path. Eight GateRule kinds shipped unsaveable for two slices
     * because only one of the two mechanisms existed.
     */
    expect(Object.keys(SPEC_CONNECTOR_SHAPES).sort()).toEqual([...SPEC_CONNECTORS].sort());
    for (const connector of SPEC_CONNECTORS) {
      const shape = SPEC_CONNECTOR_SHAPES[connector];
      expect(shape.requiredConfig.length, `${connector} declares no config`).toBeGreaterThan(0);
      // A connector that can record provenance and holds a credential must have
      // a reader, or it is a catalogue entry for a feature that does not exist.
      if (shape.sourceSystem !== null && shape.integrationKind !== null) {
        expect(shape.read, `${connector} is available but has no reader`).not.toBeNull();
      }
    }
  });

  it('accepts every connector name the import schema will take', async () => {
    for (const connector of SPEC_CONNECTORS) {
      const { body } = await post(`/requirements/${PROJECT}`, {
        source: 'CONNECTOR',
        connector,
        integrationId: 'int_jira',
      });
      /*
       * A wrong-kind 400 or an unavailable 501 is the route doing its job. What
       * must never happen is the BODY SCHEMA rejecting the name: a member the
       * write path will not take is a member no customer can use, which is the
       * unsaveable-kind defect this pattern exists to prevent.
       */
      const fieldErrors = body.error?.details?.fieldErrors ?? {};
      expect(fieldErrors.connector, `${connector} was rejected by the body schema`).toBeUndefined();
      expect(message(body), `${connector} was rejected by the body schema`).not.toContain(
        'Invalid option',
      );
    }
  });
});
