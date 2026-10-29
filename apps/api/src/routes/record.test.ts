/**
 * Tests for record mode as an ENUMERATION SOURCE.
 *
 * Record mode reaches what the crawler cannot — the wizard, the modal, the page
 * behind the payment step — and until now that reach widened the suite and
 * never the denominator. A route only a human could get to was not uncovered,
 * it was INVISIBLE, and absent raises a coverage percentage while uncovered
 * lowers it. So what is proven here, in order of how expensive the bug would be:
 *
 *   1. THE EXTRACTOR READS WHAT HAPPENED AND GUESSES NOTHING. A literal
 *      `page.goto('/x')` is a route; a `page.goto(target)` is an UNRESOLVED
 *      navigation that is counted and named by line, never dropped and never
 *      invented. "We could not read it" and "there was nothing there" are
 *      different facts and a report built on the second one is a lie.
 *   2. THE MERGE ADDS AND NEVER RETIRES. One person's path is not a census.
 *   3. PROVENANCE IS MANUAL AND `origin` IS DERIVED. Filing a recording under
 *      CRAWL would inflate "the crawl reached N" — a claim about our own
 *      capability — in the flattering direction.
 *   4. AN EXISTING ROW KEEPS ITS `file`, `line` AND `detector`. The source
 *      detector knows where a route is declared; a recording does not.
 *   5. NOTHING_READABLE IS NOT A ZERO-FILLED SUCCESS, and a FAILED merge is
 *      reported rather than swallowed — swallowed it is indistinguishable from
 *      a session that touched no surface.
 *   6. The poll contract apps/web reads (`status`, `code`, `error`) is intact.
 *
 * NO BROWSER. `@qaai/runner`'s recorder is mocked: the thing under test is what
 * QAAI does with a spec, and the spec is a string.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  /** Resolved by each test to hand the route a recorded spec. */
  recorded: { resolve: (code: string) => void; reject: (err: Error) => void; cancelled: boolean };
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null },
    audits: [],
    recorded: { resolve: () => {}, reject: () => {}, cancelled: false },
  }),
);

vi.mock('../env.js', () => ({
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
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

vi.mock('@qaai/runner', () => ({
  startRecording: () => ({
    done: new Promise<string>((resolve, reject) => {
      h.recorded.resolve = resolve;
      h.recorded.reject = reject;
    }),
    cancel: () => {
      h.recorded.cancelled = true;
    },
  }),
  // The real one, minus the spawn: renaming the test and making URLs relative
  // is exactly what the extractor downstream depends on, so it is not stubbed
  // out — it is reimplemented as its own two rules would behave on input the
  // tests already write relative.
  cleanupRecordedSpec: (raw: string, opts: { name: string }) =>
    raw.replace(/test\(\s*(['"`])test\1/, `test('${opts.name}'`),
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

vi.mock('../middleware/auth.js', async () => {
  const { ROLE_RANK } = await import('@qaai/shared');
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole:
      (minimum: keyof typeof ROLE_RANK) => (req: Row, res: Row, next: () => void) => {
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

// ─── The in-memory Prisma stand-in ───────────────────────────────────────────

const MODELS = [
  'environment',
  'coverageItem',
  'project',
  'suite',
  'test',
  'recordingPromotion',
] as const;
type ModelName = (typeof MODELS)[number];

function matchOne(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    const filter = cond as Row;
    if ('in' in filter) return (filter.in as unknown[]).includes(value);
    throw new Error(`fake prisma: unsupported filter ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => matchOne(row[key], cond));
}

/**
 * Honours `select`. Load-bearing: the provenance union below reads `sources`
 * off a selected row, so a `select` that stopped asking for it would make the
 * merge overwrite `['SOURCE']` with `['MANUAL']` — and a select-blind fake
 * would pass. Two defects survived a whole slice behind exactly that.
 */
function project(row: Row, select?: Row): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) if (value === true) out[key] = row[key];
  return out;
}

const DEFAULTS: Record<ModelName, Row> = {
  environment: {},
  coverageItem: {
    file: null,
    line: null,
    detector: null,
    meta: {},
    sources: null,
    exercisability: null,
    exerciseDetail: null,
    environmentId: null,
    status: 'UNCOVERED',
    matches: [],
    retiredAt: null,
  },
  project: {},
  suite: { description: null },
  test: { suiteId: null, feature: null, spec: null, tags: [], versions: null },
  recordingPromotion: {
    environmentId: null,
    state: 'CAPTURED',
    promotedTestId: null,
    rejectedReason: null,
    promotedBy: null,
    promotedAt: null,
  },
};

function makeDb() {
  const tables = Object.fromEntries(MODELS.map((m) => [m, [] as Row[]])) as Record<
    ModelName,
    Row[]
  >;
  let ids = 0;

  const flatten = (where: Row): Row => {
    const out: Row = {};
    for (const [key, value] of Object.entries(where)) {
      if (value && typeof value === 'object' && key.includes('_')) Object.assign(out, value);
      else out[key] = value;
    }
    return out;
  };

  const makeModel = (name: ModelName) => {
    const rows = () => tables[name];
    const insert = (data: Row): Row => {
      const row: Row = { id: `${name}_${++ids}`, ...DEFAULTS[name], ...data };
      rows().push(row);
      return row;
    };
    return {
      __insert: insert,
      /**
       * `create` HONOURS `select` AND KEEPS THE NESTED WRITE.
       *
       * The promotion route creates the test and its first `TestVersion` in one
       * nested write, and a fake that dropped the nested payload would make
       * "the promoted test has a version 1 recorded as HUMAN" unprovable — and
       * deleting that block from the route undetectable.
       */
      create: async ({ data, select }: Row) => project(insert(data), select),
      delete: async ({ where }: Row) => {
        const index = rows().findIndex((r) => matches(r, flatten(where)));
        if (index < 0) throw new Error(`fake prisma: no ${name} to delete`);
        return rows().splice(index, 1)[0];
      },
      findUnique: async ({ where, select }: Row) => {
        const row = rows().find((r) => matches(r, flatten(where)));
        return row ? project(row, select) : null;
      },
      findMany: async ({ where, select }: Row = {}) =>
        rows()
          .filter((r) => matches(r, where ?? {}))
          .map((r) => project(r, select)),
      upsert: ({ where, create, update, select }: Row) => {
        const row = rows().find((r) => matches(r, flatten(where)));
        if (row) {
          Object.assign(row, update);
          return Promise.resolve(project(row, select));
        }
        return Promise.resolve(project(insert(create), select));
      },
    } as Row;
  };

  const client: Record<string, unknown> = {
    /**
     * BOTH FORMS. The array form is the merge's; the callback form is the
     * promotion's, and it is handed THIS SAME client — so a row written inside
     * the callback is visible to the assertions afterwards. The fake does not
     * roll back, which is stated here rather than implied: no test in this file
     * asserts that a failed promotion left nothing behind, because this fake
     * could not prove it.
     */
    $transaction: async (operations: unknown) => {
      if (typeof operations === 'function') {
        return (operations as (tx: unknown) => Promise<unknown>)(client);
      }
      return Promise.all(operations as Promise<unknown>[]);
    },
  };
  for (const name of MODELS) client[name] = makeModel(name);
  return { tables, client };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const record = await import('./record.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/', record.recordRouter);
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
): Promise<{ status: number; body: Row; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {}, text };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  h.prisma = db.client;
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'ADMIN', ip: null };
  h.audits.length = 0;
  h.recorded.cancelled = false;
  (db.client.environment as Row).__insert({
    id: 'env_1',
    projectId: 'proj_1',
    baseUrl: 'https://shop.example.test',
  });
  (db.client.project as Row).__insert({ id: 'proj_1', orgId: 'org_1' });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** What codegen actually emits, already made relative by cleanupRecordedSpec. */
const CHECKOUT_SPEC = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Products' }).click();
  await page.goto('/products');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout/payment');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByLabel('Expiry').fill('12/30');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('Thank you')).toBeVisible();
});
`;

// ─── 1. The extractor, which is pure ─────────────────────────────────────────

describe('surfaceFromRecordedSpec', () => {
  it('reads the routes a person visited, in order, deduplicated', () => {
    const surface = record.surfaceFromRecordedSpec(CHECKOUT_SPEC);
    expect(surface.routes).toEqual(['/', '/products', '/checkout/payment']);
  });

  it('attributes exercised controls to the route they were exercised on', () => {
    const surface = record.surfaceFromRecordedSpec(CHECKOUT_SPEC);
    expect(surface.controlsByRoute['/']).toEqual(['Products']);
    expect(surface.controlsByRoute['/products']).toEqual(['Add to cart']);
    expect(surface.controlsByRoute['/checkout/payment']).toEqual(['Pay now']);
  });

  it('reads a submitted form as the fields filled before the click, sorted', () => {
    const surface = record.surfaceFromRecordedSpec(CHECKOUT_SPEC);
    // Sorted, because the order a person fills a form in varies between
    // recordings and the field set does not.
    expect(surface.formsByRoute['/checkout/payment']).toEqual(['Card number', 'Expiry']);
    expect(surface.formsByRoute['/products']).toBeUndefined();
  });

  it('counts a revisited route once, so a loop does not inflate the denominator', () => {
    const spec = `test('t', async ({ page }) => {
  await page.goto('/cart');
  await page.goto('/products');
  await page.goto('/cart');
});`;
    const surface = record.surfaceFromRecordedSpec(spec);
    // Two surfaces, walked three times. A person who goes back to the cart has
    // not discovered a second cart, and counting it twice would add a row to
    // the denominator that nothing can ever cover.
    expect(surface.routes).toEqual(['/cart', '/products']);
  });

  it('sorts a form’s fields, so filling the same form in a different order is the same form', () => {
    const forwards = record.surfaceFromRecordedSpec(`test('t', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill('a@b.c');
  await page.getByLabel('Password').fill('hunter2');
  await page.getByRole('button', { name: 'Create' }).click();
});`);
    const backwards = record.surfaceFromRecordedSpec(`test('t', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Password').fill('hunter2');
  await page.getByLabel('Email').fill('a@b.c');
  await page.getByRole('button', { name: 'Create' }).click();
});`);
    // The identity a stored FORM row is keyed on is built from this list, so an
    // unsorted one would mint a second row for the same form the next time
    // somebody filled it top-to-bottom instead of bottom-to-top.
    expect(forwards.formsByRoute['/signup']).toEqual(['Email', 'Password']);
    expect(backwards.formsByRoute['/signup']).toEqual(['Email', 'Password']);
  });

  it('counts a navigation it could not read instead of dropping or guessing it', () => {
    const spec = `test('t', async ({ page }) => {
  await page.goto('/orders');
  await page.goto(nextUrl);
  await page.goto(\`/orders/\${id}\`);
});`;
    const surface = record.surfaceFromRecordedSpec(spec);
    expect(surface.routes).toEqual(['/orders']);
    // Lines 3 and 4 of the spec. NAMED, so a human can read the file and say.
    expect(surface.unresolvedNavigations).toEqual([3, 4]);
  });

  it('does not count an off-origin navigation as this application’s surface', () => {
    const spec = `test('t', async ({ page }) => {
  await page.goto('/login');
  await page.goto('https://accounts.google.com/signin');
});`;
    const surface = record.surfaceFromRecordedSpec(spec);
    // A third-party IdP's page is somebody else's route, and counting it would
    // produce a coverage gap for an app we are not testing.
    expect(surface.routes).toEqual(['/login']);
    expect(surface.unresolvedNavigations).toEqual([3]);
  });

  it('attributes nothing to a route it has not seen', () => {
    const spec = `test('t', async ({ page }) => {
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.goto('/home');
});`;
    const surface = record.surfaceFromRecordedSpec(spec);
    expect(surface.routes).toEqual(['/home']);
    // The click happened on whatever page the recorder opened at, and
    // attributing it to /home would invent the attribution.
    expect(surface.controlsByRoute).toEqual({});
    expect(surface.actions.filter((action) => action.kind === 'CONTROL')).toHaveLength(1);
  });

  it('starts a fresh form after each submit, so two forms on a page are two forms', () => {
    const spec = `test('t', async ({ page }) => {
  await page.goto('/account');
  await page.getByLabel('Email').fill('a@b.c');
  await page.getByRole('button', { name: 'Save email' }).click();
  await page.getByLabel('Password').fill('hunter2');
  await page.getByRole('button', { name: 'Save password' }).click();
});`;
    const surface = record.surfaceFromRecordedSpec(spec);
    // The route key carries one field set; the SECOND submit replaces it,
    // which is the documented limitation of a route-scoped form identity.
    expect(surface.formsByRoute['/account']).toEqual(['Password']);
    expect(surface.controlsByRoute['/account']).toEqual(['Save email', 'Save password']);
  });

  it('declares every action kind it can produce, so the union cannot drift', () => {
    const surface = record.surfaceFromRecordedSpec(CHECKOUT_SPEC);
    const produced = [...new Set(surface.actions.map((action) => action.kind))].sort();
    // The compiler enforces RECORDED_ACTION_PRESENT against the union; this
    // enforces the extractor against the record. A kind in the union that the
    // extractor can never emit is dead vocabulary, and one the extractor emits
    // that the union does not know would not compile.
    expect(produced).toEqual([...record.RECORDED_ACTION_KINDS].sort());
  });
});

// ─── 2. The merge ────────────────────────────────────────────────────────────

describe('mergeRecordedSurface', () => {
  const input = {
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    sessionName: 'Checkout with a saved card',
    code: CHECKOUT_SPEC,
  };

  it('puts the routes and the form into the registry with MANUAL provenance', async () => {
    const merge = await record.mergeRecordedSurface(input);

    expect(merge.status).toBe('MERGED');
    expect(merge.routesVisited).toBe(3);
    expect(merge.formsSubmitted).toBe(1);
    expect(merge.controlsExercised).toBe(3);
    expect(merge.surfaceCreated).toBe(4);
    expect(merge.surfaceUpdated).toBe(0);

    const keys = db.tables.coverageItem.map((row) => row.key);
    expect(keys).toContain('ROUTE:/checkout/payment');
    expect(keys).toContain('FORM:/checkout/payment#Card number,Expiry');

    const route = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/checkout/payment')!;
    // MANUAL and not CRAWL: filing a recording under CRAWL would inflate "the
    // crawl reached N", a claim about our own capability, in our own favour.
    expect(route.sources).toEqual(['MANUAL']);
    expect(route.origin).toBe('SOURCE_ONLY');
    expect(route.detector).toBe('record-session');
    expect(route.environmentId).toBe('env_1');
    // A person drove it, so our harness provably can.
    expect(route.exercisability).toBe('EXERCISABLE');
    expect(route.evidence).toMatch(/A person reached this route while recording/);
    expect(route.meta.exercisedControls).toEqual(['Pay now']);
    // Written LIVE, not retired. Re-seeing a retired route un-retires it; and
    // minting one already retired would put a surface in the inventory that is
    // excluded from every count the moment it arrives.
    expect(route.retiredAt).toBeNull();
  });

  it('says the form was INFERRED and does not claim a <form> element was seen', async () => {
    await record.mergeRecordedSurface(input);
    const form = db.tables.coverageItem.find((row) => row.kind === 'FORM')!;
    expect(form.meta.inferredFrom).toBe('FILLS_THEN_CLICK');
    expect(form.evidence).toMatch(/codegen does not record that a <form> element was involved/);
  });

  it('unions MANUAL onto an existing declarer and keeps the file the detector found', async () => {
    (db.client.coverageItem as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      key: 'ROUTE:/checkout/payment',
      kind: 'ROUTE',
      label: '/checkout/payment',
      origin: 'SOURCE_ONLY',
      evidence: 'app/checkout/payment/page.tsx — directory path is the URL',
      file: 'app/checkout/payment/page.tsx',
      line: 7,
      detector: 'next-app-router',
      sources: ['SOURCE'],
    });

    const merge = await record.mergeRecordedSurface(input);
    expect(merge.surfaceUpdated).toBe(1);

    const route = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/checkout/payment')!;
    expect(route.sources).toEqual(['SOURCE', 'MANUAL']);
    // A recording does not know where a route is declared, so it must not
    // write null over the editor link on the best-evidenced rows in the table.
    expect(route.file).toBe('app/checkout/payment/page.tsx');
    expect(route.line).toBe(7);
    expect(route.detector).toBe('next-app-router');
  });

  it('never retires a row the recording did not reach', async () => {
    (db.client.coverageItem as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      key: 'ROUTE:/admin/refunds',
      kind: 'ROUTE',
      label: '/admin/refunds',
      origin: 'SOURCE_ONLY',
      evidence: 'declared in source',
      sources: ['SOURCE'],
    });
    await record.mergeRecordedSurface(input);
    const admin = db.tables.coverageItem.find((row) => row.key === 'ROUTE:/admin/refunds')!;
    // One person's path is not a census; its silence is evidence of nothing.
    expect(admin.retiredAt).toBeNull();
    expect(admin.sources).toEqual(['SOURCE']);
  });

  it('reports NOTHING_READABLE rather than a zero-filled success', async () => {
    const merge = await record.mergeRecordedSurface({
      ...input,
      code: `test('t', async ({ page }) => {
  await page.goto(wherever);
});`,
    });
    // Not MERGED with 0: "our extractor could read nothing" and "the session
    // touched no surface" are different sentences and only one is true.
    expect(merge.status).toBe('NOTHING_READABLE');
    expect(merge.unresolvedNavigations).toEqual([2]);
    expect(merge.reason).toMatch(/No route literal could be read/);
    expect(db.tables.coverageItem).toHaveLength(0);
  });

  it('distinguishes "read nothing" from "nothing happened"', async () => {
    const merge = await record.mergeRecordedSurface({ ...input, code: '// an empty spec' });
    expect(merge.status).toBe('NOTHING_READABLE');
    expect(merge.unresolvedNavigations).toEqual([]);
    expect(merge.reason).toMatch(/No navigation or form submission could be read/);
  });

  it('carries the unresolved navigations through a successful merge', async () => {
    const merge = await record.mergeRecordedSurface({
      ...input,
      code: `test('t', async ({ page }) => {
  await page.goto('/orders');
  await page.goto(deepLink);
});`,
    });
    expect(merge.status).toBe('MERGED');
    expect(merge.routesVisited).toBe(1);
    // A recording that reached one readable page and one unreadable one has
    // reached at least two surfaces, and reporting only one would claim a
    // completeness it has not got.
    expect(merge.unresolvedNavigations).toEqual([3]);
  });
});

// ─── 3. The lifecycle, through the route ─────────────────────────────────────

describe('record lifecycle', () => {
  async function startAndFinish(code: string): Promise<Row> {
    const start = await call('POST', '/projects/proj_1/record', {
      environmentId: 'env_1',
      name: 'Checkout with a saved card',
    });
    expect(start.status).toBe(202);
    h.recorded.resolve(code);

    // The merge runs off the settled promise, so poll the way a client does.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const poll = await call('GET', `/projects/proj_1/record/${start.body.sessionId}`);
      if (poll.body.enumeration) return poll.body;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the merge never reported');
  }

  it('merges the surface when the recording becomes ready, and keeps the poll contract', async () => {
    const body = await startAndFinish(CHECKOUT_SPEC);

    // The three fields apps/web reads, unchanged.
    expect(body.status).toBe('ready');
    expect(body.code).toContain("test('Checkout with a saved card'");
    expect(body.error).toBeNull();

    expect(body.enumeration.status).toBe('MERGED');
    expect(body.enumeration.routesVisited).toBe(3);
    expect(body.enumeration.surfaceCreated).toBe(4);
    expect(db.tables.coverageItem.map((row) => row.key)).toContain('ROUTE:/checkout/payment');

    const entry = h.audits.find((row) => row.action === 'record.enumerate')!;
    expect(entry.metadata.routesVisited).toBe(3);
    expect(entry.metadata.surfaceCreated).toBe(4);
  });

  it('reports a merge failure instead of swallowing it, and still hands back the spec', async () => {
    // A registry the merge cannot write to. Swallowed, this is
    // indistinguishable from a recording that touched no surface.
    (db.client.coverageItem as Row).upsert = () => {
      throw new Error('registry is read-only');
    };

    const body = await startAndFinish(CHECKOUT_SPEC);
    expect(body.status).toBe('ready');
    expect(body.code).toContain("test('Checkout with a saved card'");
    expect(body.enumeration.status).toBe('FAILED');
    expect(body.enumeration.reason).toMatch(/registry is read-only/);
    expect(body.enumeration.reason).toMatch(/The spec above is unaffected/);
  });

  it('leaves enumeration null while the recording is still running', async () => {
    const start = await call('POST', '/projects/proj_1/record', {
      environmentId: 'env_1',
      name: 'In progress',
    });
    const poll = await call('GET', `/projects/proj_1/record/${start.body.sessionId}`);
    expect(poll.body.status).toBe('recording');
    // Null and not a zero-filled result: "not merged yet" and "merged and
    // found nothing" are different answers.
    expect(poll.body.enumeration).toBeNull();
    h.recorded.reject(new Error('Recording cancelled'));
  });

  it('still refuses a missing environment', async () => {
    const { status, body } = await call('POST', '/projects/proj_1/record', {});
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/environmentId is required/);
  });

  it('still refuses an environment belonging to another project', async () => {
    (db.client.environment as Row).__insert({
      id: 'env_other',
      projectId: 'proj_2',
      baseUrl: 'https://other.example.test',
    });
    const { status } = await call('POST', '/projects/proj_1/record', {
      environmentId: 'env_other',
    });
    expect(status).toBe(404);
  });
});

// ─── 4. Promotion: the recording becomes a test, exactly once ────────────────

/**
 * WHY THESE AND NOT A HAPPY PATH.
 *
 * The idempotence of this route is not a nicety: without it a double-click
 * makes two identical tests out of one session, and the second one is
 * indistinguishable from a copy somebody meant to make. And the whole mechanism
 * rests on one assumption — that `recordingKey` IS the hash of the code it
 * arrives with. A client that sends an unrelated key turns the unique index
 * into decoration. So the key check and the second promotion are the two tests
 * that would be most expensive to lose, and they are first.
 */
describe('promoting a recording', () => {
  const { recordingKeyOf } = record;

  const promote = (over: Row = {}) => {
    const code = (over.code as string) ?? CHECKOUT_SPEC;
    return call('POST', '/projects/proj_1/record/promote', {
      projectId: 'proj_1',
      environmentId: 'env_1',
      recordingKey: recordingKeyOf(code),
      name: 'Checkout, end to end',
      code,
      ...over,
    });
  };

  const promotions = () => db.tables.recordingPromotion;
  const tests = () => db.tables.test;

  it('refuses a key that is not the hash of the code it came with, and writes nothing', async () => {
    const { status, body } = await promote({
      recordingKey: 'a'.repeat(64),
    });
    expect(status).toBe(400);
    expect(body.error?.message).toMatch(/sha256 of the cleaned spec/);
    expect(tests()).toHaveLength(0);
    expect(promotions()).toHaveLength(0);
  });

  it('refuses when the path and the body name different projects', async () => {
    const { status, body } = await promote({ projectId: 'proj_other' });
    expect(status).toBe(400);
    expect(body.error?.message).toMatch(/disagree/);
    expect(tests()).toHaveLength(0);
  });

  it('writes one test, in its own suite, with a first version attributed to the human', async () => {
    const { status, body } = await promote();
    expect(status).toBe(201);
    expect(body.idempotent).toBe(false);

    expect(tests()).toHaveLength(1);
    const written = tests()[0]!;
    expect(written.name).toBe('Checkout, end to end');
    expect(written.code).toBe(CHECKOUT_SPEC);
    expect(written.type).toBe('E2E');
    expect(written.feature).toBe('Recorded');

    const suite = db.tables.suite.find((s) => s.id === written.suiteId);
    expect(suite?.name).toBe('Recorded');

    // The nested write, which is what makes the test's history start at the
    // recording rather than at nothing.
    expect(written.versions.create).toMatchObject({
      version: 1,
      source: 'HUMAN',
      authorId: 'user_1',
      code: CHECKOUT_SPEC,
    });

    expect(promotions()).toHaveLength(1);
    expect(promotions()[0]!).toMatchObject({
      projectId: 'proj_1',
      environmentId: 'env_1',
      recordingKey: recordingKeyOf(CHECKOUT_SPEC),
      state: 'PROMOTED',
      promotedTestId: written.id,
      recordedBy: 'user_1',
      promotedBy: 'user_1',
    });
  });

  it('promoting the same session twice makes ONE test and says the second was a no-op', async () => {
    const first = await promote();
    expect(first.status).toBe(201);

    const second = await promote();
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.test.id).toBe(first.body.test.id);

    expect(tests()).toHaveLength(1);
    expect(promotions()).toHaveLength(1);
    // And the second call wrote no audit, because it wrote nothing.
    expect(h.audits.filter((a) => a.action === 'recording.promote')).toHaveLength(1);
  });

  it('two different sessions are two different recordings', async () => {
    await promote();
    const other = `${CHECKOUT_SPEC}\n// a second pass through the same flow\n`;
    const second = await promote({ code: other, name: 'Checkout again' });
    expect(second.status).toBe(201);
    expect(tests()).toHaveLength(2);
    expect(promotions()).toHaveLength(2);
    expect(new Set(promotions().map((p) => p.recordingKey)).size).toBe(2);
  });

  it('refuses to promote over a rejection, and keeps the reason', async () => {
    (db.client.recordingPromotion as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      recordingKey: recordingKeyOf(CHECKOUT_SPEC),
      name: 'Checkout, end to end',
      state: 'REJECTED',
      rejectedReason: 'the card number is real',
      recordedBy: 'user_1',
    });

    const { status, body } = await promote();
    expect(status).toBe(409);
    expect(body.error?.message).toMatch(/rejected/);
    expect(body.error?.details?.rejectedReason).toBe('the card number is real');
    expect(tests()).toHaveLength(0);
  });

  it('promotes a CAPTURED row rather than refusing it, and does not add a second row', async () => {
    (db.client.recordingPromotion as Row).__insert({
      orgId: 'org_1',
      projectId: 'proj_1',
      recordingKey: recordingKeyOf(CHECKOUT_SPEC),
      name: 'Checkout, end to end',
      state: 'CAPTURED',
      recordedBy: 'user_9',
    });

    const { status } = await promote();
    expect(status).toBe(201);
    expect(promotions()).toHaveLength(1);
    expect(promotions()[0]!.state).toBe('PROMOTED');
    // The row remembers who recorded it; promotion does not rewrite that.
    expect(promotions()[0]!.recordedBy).toBe('user_9');
  });

  it('re-creates the test when the row claims one that is gone, and repoints the same row', async () => {
    const first = await promote();
    const firstId = first.body.test.id as string;
    await (db.client.test as Row).delete({ where: { id: firstId } });

    const again = await promote();
    expect(again.status).toBe(201);
    expect(again.body.test.id).not.toBe(firstId);

    // One row, one live test — never two of either.
    expect(promotions()).toHaveLength(1);
    expect(tests()).toHaveLength(1);
    expect(promotions()[0]!.promotedTestId).toBe(again.body.test.id);

    const audits = h.audits.filter((a) => a.action === 'recording.promote');
    expect(audits).toHaveLength(2);
    expect(audits[0]!.metadata.replacedTestId).toBeNull();
    expect(audits[1]!.metadata.replacedTestId).toBe(firstId);
  });

  it('refuses an environment from another project, and writes nothing', async () => {
    (db.client.environment as Row).__insert({
      id: 'env_elsewhere',
      projectId: 'proj_other',
      baseUrl: 'https://other.example.test',
    });
    const { status } = await promote({ environmentId: 'env_elsewhere' });
    expect(status).toBe(404);
    expect(tests()).toHaveLength(0);
    expect(promotions()).toHaveLength(0);
  });

  it('accepts no environment at all — a recording is still a recording', async () => {
    const { status } = await promote({ environmentId: null });
    expect(status).toBe(201);
    expect(promotions()[0]!.environmentId).toBeNull();
  });

  it('refuses an unknown project', async () => {
    const { status } = await call('POST', '/projects/proj_missing/record/promote', {
      projectId: 'proj_missing',
      recordingKey: recordingKeyOf(CHECKOUT_SPEC),
      name: 'Checkout',
      code: CHECKOUT_SPEC,
    });
    expect(status).toBe(404);
  });

  it('the audit names the recording key, so the row and the test can be tied together', async () => {
    const { body } = await promote();
    const entry = h.audits.find((a) => a.action === 'recording.promote');
    expect(entry).toMatchObject({
      targetType: 'Test',
      targetId: body.test.id,
      metadata: { recordingKey: recordingKeyOf(CHECKOUT_SPEC), environmentId: 'env_1' },
    });
  });
});

/**
 * The key and the path, as pure functions. Both are small and both are
 * load-bearing: the key is the idempotence claim, and the path is the one place
 * a human's sentence could have reached the filesystem.
 */
describe('recordingKeyOf and promotedFilePath', () => {
  const { recordingKeyOf, promotedFilePath } = record;

  it('hashes the code it is given, and the same code twice is the same key', () => {
    const key = recordingKeyOf(CHECKOUT_SPEC);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(recordingKeyOf(CHECKOUT_SPEC)).toBe(key);
    expect(recordingKeyOf(`${CHECKOUT_SPEC} `)).not.toBe(key);
  });

  it('never puts the name in the path verbatim', () => {
    const key = 'abcdef012345' + '0'.repeat(52);
    const path = promotedFilePath('../../etc/passwd "quoted"', key);
    expect(path).toBe('recorded/etc-passwd-quoted-abcdef012345.spec.ts');
    expect(path).not.toContain('..');
    expect(path).not.toContain('"');
  });

  it('falls back to the key alone when the name slugs to nothing', () => {
    const key = 'f'.repeat(64);
    expect(promotedFilePath('。。。', key)).toBe(`recorded/${'f'.repeat(12)}.spec.ts`);
    expect(promotedFilePath('', key)).toBe(`recorded/${'f'.repeat(12)}.spec.ts`);
  });

  it('bounds the slug, so a long name cannot make a long path', () => {
    const key = '0'.repeat(64);
    const path = promotedFilePath('a'.repeat(400), key);
    expect(path.length).toBeLessThan(100);
    expect(path.startsWith('recorded/' + 'a'.repeat(60) + '-')).toBe(true);
  });

  it('two recordings called the same thing do not land on one file', () => {
    const a = promotedFilePath('Checkout', recordingKeyOf('one'));
    const b = promotedFilePath('Checkout', recordingKeyOf('two'));
    expect(a).not.toBe(b);
  });
});
