/**
 * Tests for GET /projects/:projectId/search — the editor's ⌘⇧F.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. The search is TENANT-SCOPED. It takes a projectId straight off the URL
 *      and returns source code, so the failure mode is one customer reading
 *      another customer's tests by guessing an id. The route's only defence is
 *      that it queries through the scoped `prisma` client inside the request's
 *      tenant scope, and that is invisible at the call site — there is no
 *      `orgId` in the `where` to review. So the fake below applies the scope the
 *      way the real extension does, and the first test drives the same request
 *      from two orgs. Swap `prisma` for `unscoped(...)` in the route and it
 *      fails; nothing else here would notice.
 *
 *   2. Matching is LITERAL. No caller-supplied text becomes a pattern, because
 *      Node cannot interrupt a running match and one pathological pattern is an
 *      outage for every tenant. `a.c` not matching `abc` is the assertion that
 *      says so, and it is the one that breaks the moment someone "simplifies"
 *      whole-word back into a RegExp.
 *
 *   3. The caps hold and `truncated` is honest. A cap that silently drops
 *      results while the response says it did not is worse than no cap: the
 *      panel then tells the reader there is nothing else to find.
 *
 * Harness: same shape as integrations.test.ts — mocked prisma module with a real
 * AsyncLocalStorage tenant scope, the real router driven over a loopback socket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  /** Every findMany the route issued — used to prove a blank query scans nothing. */
  queries: Row[];
}

const h = vi.hoisted(
  (): Hoisted => ({
    prisma: {},
    currentOrg: () => null,
    actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
    queries: [],
  }),
);

vi.mock('../env.js', () => ({
  env: {
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
  runWithRequestContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
}));

/*
 * The tenancy scope is real, not stubbed: the route's query runs in the async
 * continuation of `withTenant(orgId, () => next())`, so a plain variable would
 * be restored before it ran and the org-isolation test would pass for a reason
 * that has nothing to do with the route.
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

/* queues.ts opens an ioredis connection at import time; nothing here enqueues. */
vi.mock('../lib/queues.js', () => ({ enqueue: async () => {} }));

vi.mock('../lib/audit.js', () => ({ audit: async () => {} }));

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

/**
 * Only `test.findMany` is needed, but it applies the tenant filter exactly as
 * the extension does — merging the ambient orgId into the `where` — because
 * that merge IS the security property under test. Unknown filters throw: a fake
 * that shrugs at `disabledAt: null` would pass the test proving it is honoured.
 */
const KNOWN_FILTERS = new Set(['projectId', 'disabledAt', 'orgId']);

function makeDb(rows: Row[]) {
  return {
    test: {
      findMany: async ({ where = {}, orderBy, select }: Row = {}) => {
        h.queries.push({ where, orderBy });
        const orgId = h.currentOrg();
        const scoped: Row = orgId ? { ...where, orgId } : { ...where };

        for (const key of Object.keys(scoped)) {
          if (!KNOWN_FILTERS.has(key)) {
            throw new Error(`fake prisma: unsupported filter on ${key}`);
          }
        }

        const matched = rows.filter((row) =>
          Object.entries(scoped).every(([key, cond]) =>
            cond === null ? (row[key] ?? null) === null : row[key] === cond,
          ),
        );

        const sorted = orderBy
          ? [...matched].sort((a, b) =>
              String(a.filePath ?? '').localeCompare(String(b.filePath ?? '')),
            )
          : matched;

        return sorted.map((row) => {
          if (!select) return { ...row };
          const out: Row = {};
          for (const [key, want] of Object.entries(select)) if (want === true) out[key] = row[key];
          return out;
        });
      },
    },
  };
}

/** A row in the shape the route selects. Defaults are the common case. */
function seed(over: Row): Row {
  return {
    id: 'test_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    name: 'a test',
    type: 'E2E',
    filePath: 'tests/a.spec.ts',
    code: '',
    spec: null,
    disabledAt: null,
    ...over,
  };
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

interface SearchMatch {
  line: number;
  column: number;
  length: number;
  text: string;
}
interface SearchFile {
  testId: string;
  name: string;
  filePath: string;
  type: string;
  matchCount: number;
  matches: SearchMatch[];
}
interface SearchBody {
  query: string;
  files: SearchFile[];
  totalMatches: number;
  truncated: boolean;
  error?: { code: string; message: string };
}

/** The panel's own request: `q`, plus `case=1` / `word=1` only when toggled on. */
async function search(
  q: string,
  opts: { matchCase?: boolean; wholeWord?: boolean; projectId?: string } = {},
): Promise<{ status: number; body: SearchBody }> {
  const params = new URLSearchParams({ q });
  if (opts.matchCase) params.set('case', '1');
  if (opts.wholeWord) params.set('word', '1');
  const res = await fetch(
    `${baseUrl}/projects/${opts.projectId ?? 'proj_1'}/search?${params.toString()}`,
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as SearchBody) : ({} as SearchBody) };
}

function install(rows: Row[]): void {
  h.prisma = makeDb(rows);
}

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.queries.length = 0;
  install([]);
});

describe('org scoping', () => {
  /*
   * Both rows carry the SAME projectId, which is the attack: the caller has a
   * project id that is not theirs — leaked in a screenshot, a support thread, or
   * guessed — and the route's `where` names only that id.
   */
  const rows = [
    seed({
      id: 'test_ours',
      orgId: 'org_1',
      filePath: 'tests/ours.spec.ts',
      code: 'await page.goto(SECRET_URL);',
    }),
    seed({
      id: 'test_theirs',
      orgId: 'org_2',
      filePath: 'tests/theirs.spec.ts',
      code: 'await page.goto(SECRET_URL);',
    }),
  ];

  it('never returns another org’s test, even for the same projectId', async () => {
    install(rows);

    const mine = await search('SECRET_URL');
    expect(mine.status).toBe(200);
    expect(mine.body.files.map((f) => f.testId)).toEqual(['test_ours']);
    expect(JSON.stringify(mine.body)).not.toContain('theirs');

    // The mirror image: the same request from the other org sees only its own.
    h.actor = { userId: 'user_2', orgId: 'org_2', role: 'MEMBER', ip: null };
    const theirs = await search('SECRET_URL');
    expect(theirs.body.files.map((f) => f.testId)).toEqual(['test_theirs']);

    // And an org with nothing here gets an empty result, not the other two.
    h.actor = { userId: 'user_3', orgId: 'org_3', role: 'MEMBER', ip: null };
    const stranger = await search('SECRET_URL');
    expect(stranger.body).toMatchObject({ files: [], totalMatches: 0 });
  });

  it('skips disabled tests', async () => {
    install([
      seed({ id: 'test_live', code: 'expect(total).toBe(1);' }),
      seed({
        id: 'test_dead',
        filePath: 'tests/dead.spec.ts',
        code: 'expect(total).toBe(1);',
        disabledAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ]);
    const { body } = await search('expect');
    expect(body.files.map((f) => f.testId)).toEqual(['test_live']);
  });
});

describe('the blank query', () => {
  it('answers an empty result without scanning, for both empty and whitespace', async () => {
    install([seed({ code: 'anything at all' })]);

    for (const q of ['', '   ', '\t\n']) {
      const { status, body } = await search(q);
      expect(status).toBe(200);
      expect(body).toEqual({ query: '', files: [], totalMatches: 0, truncated: false });
    }
    // The point of the early return: no query reached the database at all.
    expect(h.queries).toHaveLength(0);
  });

  it('trims the query it echoes and searches', async () => {
    install([seed({ code: 'const total = 1;' })]);
    const { body } = await search('  total  ');
    expect(body.query).toBe('total');
    expect(body.totalMatches).toBe(1);
  });

  it('refuses a query longer than the cap rather than scanning with it', async () => {
    install([seed({ code: 'x' })]);
    const { status, body } = await search('q'.repeat(201));
    expect(status).toBe(400);
    expect(body.error?.message).toContain('200');
    expect(h.queries).toHaveLength(0);
  });
});

describe('case sensitivity', () => {
  const rows = [seed({ code: ['const Token = 1;', 'const token = 2;', 'TOKEN;'].join('\n') })];

  it('matches every casing when the toggle is off', async () => {
    install(rows);
    const { body } = await search('token');
    expect(body.totalMatches).toBe(3);
    expect(body.files[0]!.matches.map((m) => m.line)).toEqual([1, 2, 3]);
  });

  it('matches only the exact casing when the toggle is on', async () => {
    install(rows);
    const lower = await search('token', { matchCase: true });
    expect(lower.body.totalMatches).toBe(1);
    expect(lower.body.files[0]!.matches[0]).toMatchObject({ line: 2, column: 6, length: 5 });

    const upper = await search('Token', { matchCase: true });
    expect(upper.body.totalMatches).toBe(1);
    expect(upper.body.files[0]!.matches[0]!.line).toBe(1);

    // A casing nobody wrote finds nothing rather than falling back.
    const neither = await search('ToKeN', { matchCase: true });
    expect(neither.body.files).toEqual([]);
  });
});

describe('whole word', () => {
  const rows = [
    seed({
      code: [
        'test();', //            a whole word
        'const greatest = 1;', // inside a longer word — the classic false hit
        'testing();', //         prefix
        'my_test = 2;', //       `_` is a word character, so this is not whole
        '[test] "test"', //      punctuation either side IS a boundary (twice)
      ].join('\n'),
    }),
  ];

  it('matches inside longer words when the toggle is off', async () => {
    install(rows);
    const { body } = await search('test');
    expect(body.totalMatches).toBe(6);
    expect(body.files[0]!.matches.map((m) => m.line)).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('matches only free-standing words when the toggle is on', async () => {
    install(rows);
    const { body } = await search('test', { wholeWord: true });
    // Lines 2 (greatest), 3 (testing) and 4 (my_test) are gone; line 5 has two.
    expect(body.files[0]!.matches.map((m) => m.line)).toEqual([1, 5, 5]);
    expect(body.totalMatches).toBe(3);
  });

  it('treats the start and end of a line as boundaries', async () => {
    install([seed({ code: 'test' })]);
    const { body } = await search('test', { wholeWord: true });
    expect(body.totalMatches).toBe(1);
    expect(body.files[0]!.matches[0]).toMatchObject({ line: 1, column: 0 });
  });

  it('does not fall over on a query that is punctuation, where \\b would invert', async () => {
    // `\bpage.\b` matches nothing at all; a hand-written boundary check does the
    // obvious thing — the char after `.` here is a space, so the hit stands.
    install([seed({ code: 'await page. click();' })]);
    const { body } = await search('page.', { wholeWord: true });
    expect(body.totalMatches).toBe(1);
  });
});

describe('the query is never a pattern', () => {
  it('treats regex metacharacters as the literal characters they are', async () => {
    install([
      seed({
        code: ['abc', 'a.c', 'aaa', 'a+c', '(group)'].join('\n'),
      }),
    ]);

    // `.` as a wildcard would match `abc` and `a+c` too.
    const dot = await search('a.c');
    expect(dot.body.totalMatches).toBe(1);
    expect(dot.body.files[0]!.matches[0]!.line).toBe(2);

    // `a+` as a quantifier would match the run of a's.
    const plus = await search('a+');
    expect(plus.body.totalMatches).toBe(1);
    expect(plus.body.files[0]!.matches[0]!.line).toBe(4);

    // An unbalanced group is a search for a bracket, not a syntax error.
    const broken = await search('(group');
    expect(broken.status).toBe(200);
    expect(broken.body.totalMatches).toBe(1);
  });

  it('answers a pathological pattern as fast as any other miss', async () => {
    // The classic catastrophic-backtracking pair. As literal text it is simply
    // absent, and the response is a 200 saying so.
    install([seed({ code: `'${'a'.repeat(2000)}'` })]);
    const started = Date.now();
    const { status, body } = await search('(a+)+$');
    expect(status).toBe(200);
    expect(body.files).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('what a match reports', () => {
  it('gives the line as the panel draws it: indentation dropped, column re-based', async () => {
    install([seed({ code: ['describe(() => {', '      await page.click();', '});'].join('\n') })]);
    const { body } = await search('page');

    expect(body.files[0]).toMatchObject({
      testId: 'test_1',
      name: 'a test',
      filePath: 'tests/a.spec.ts',
      type: 'E2E',
      matchCount: 1,
    });
    expect(body.files[0]!.matches[0]).toEqual({
      line: 2,
      // 12 in the raw line, 6 once the six spaces of indent are gone.
      column: 6,
      length: 4,
      text: 'await page.click();',
    });
  });

  it('reports one row per hit, not one per line', async () => {
    install([seed({ code: 'const a = a + a;' })]);
    const { body } = await search('a ');
    expect(body.files[0]!.matchCount).toBe(3);
    expect(body.files[0]!.matches.map((m) => m.column)).toEqual([6, 10, 14]);
    // Distinct columns are what keep the panel's row keys unique.
    expect(new Set(body.files[0]!.matches.map((m) => m.column)).size).toBe(3);
  });

  it('searches a spec-driven test as the JSON the editor opens, not its code column', async () => {
    install([
      seed({
        // An API test's editor buffer is its `spec`, not its `code` column.
        type: 'API',
        code: '// generated from the spec above — do not edit',
        spec: { steps: [{ action: 'click', selector: '#checkout' }] },
      }),
    ]);

    const inSpec = await search('checkout');
    expect(inSpec.body.totalMatches).toBe(1);
    // The line number must point into the buffer the editor shows.
    expect(inSpec.body.files[0]!.matches[0]!.text).toContain('#checkout');

    // Text that exists only in the unopenable `code` column is not a result.
    const inCode = await search('do not edit');
    expect(inCode.body.files).toEqual([]);
  });
});

describe('the caps', () => {
  it('caps rows per file, keeps the true count, and says it truncated', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `hit ${i}`);
    install([seed({ code: lines.join('\n') })]);

    const { body } = await search('hit');
    expect(body.files[0]!.matchCount).toBe(60);
    expect(body.files[0]!.matches).toHaveLength(50);
    // The count is the whole file's, so the panel can say "+10 more".
    expect(body.totalMatches).toBe(60);
    expect(body.truncated).toBe(true);
  });

  it('does not claim truncation when everything fits', async () => {
    install([seed({ code: 'hit\nhit' })]);
    const { body } = await search('hit');
    expect(body.truncated).toBe(false);
    expect(body.files[0]!.matchCount).toBe(body.files[0]!.matches.length);
  });

  it('caps the files it reports and says it truncated', async () => {
    install(
      Array.from({ length: 120 }, (_, i) =>
        seed({
          id: `test_${String(i).padStart(3, '0')}`,
          filePath: `tests/${String(i).padStart(3, '0')}.spec.ts`,
          code: 'hit',
        }),
      ),
    );

    const { body } = await search('hit');
    expect(body.files).toHaveLength(100);
    expect(body.truncated).toBe(true);
    // Ordered by path, so the cap takes a stable prefix rather than a lottery.
    expect(body.files[0]!.filePath).toBe('tests/000.spec.ts');
    expect(body.files[99]!.filePath).toBe('tests/099.spec.ts');
  });

  it('stops once the project-wide match budget is spent', async () => {
    // 30 files × 40 hits = 1200, so the 1000-match budget runs out partway.
    install(
      Array.from({ length: 30 }, (_, i) =>
        seed({
          id: `test_${i}`,
          filePath: `tests/${String(i).padStart(3, '0')}.spec.ts`,
          code: Array.from({ length: 40 }, (_, n) => `hit ${n}`).join('\n'),
        }),
      ),
    );

    const { body } = await search('hit');
    expect(body.truncated).toBe(true);
    expect(body.files.length).toBeLessThan(30);
    expect(body.totalMatches).toBeGreaterThanOrEqual(1000);
  });

  it('caps a long line and reports the hit past the cap as unplaceable', async () => {
    const line = `${'x'.repeat(500)}needle${'y'.repeat(10)}`;
    install([seed({ code: line })]);

    const { body } = await search('needle');
    const match = body.files[0]!.matches[0]!;
    expect(match.text).toHaveLength(400);
    // -1 is the panel's contract for "this line matches, position unknown".
    expect(match.column).toBe(-1);
    expect(body.files[0]!.matchCount).toBe(1);
  });

  it('places a hit that survives the line cap', async () => {
    install([seed({ code: `needle${'y'.repeat(500)}` })]);
    const { body } = await search('needle');
    expect(body.files[0]!.matches[0]).toMatchObject({ column: 0, length: 6 });
  });
});
