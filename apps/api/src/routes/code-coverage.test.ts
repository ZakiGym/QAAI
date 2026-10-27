/**
 * `/code-coverage/:projectId` — THE DOOR LINE COVERAGE COULD NOT GET THROUGH.
 *
 * ── The defects these tests exist for ───────────────────────────────────────
 *
 * There is no instrumentation anywhere in this product, so "coverage" meant
 * "some test mentions this route" and never "my suite executed this line". The
 * customer's own CI already computes the second one and QAAI had nowhere to put
 * it, so an untested server branch could not be named by file and line even
 * when the number existed on their build. `MIN_PATCH_COVERAGE` is a saveable
 * gate rule whose only reading was route-shaped.
 *
 * So the assertions below are mostly about the four ways this endpoint could
 * have been worse than useless:
 *
 *   1. A PARTIAL INGEST REPORTED AS SUCCESS. Too large, too old, too many
 *      files, a commit nobody has heard of — each one must refuse and write
 *      NOTHING. A stored roll-up computed from three quarters of a payload is
 *      indistinguishable afterwards from one computed from all of it.
 *   2. UNMAPPED READ AS ZERO-COVERED. A V8 payload is byte offsets; without
 *      the script's text they cannot become lines. Zero covered lines is the
 *      WORST possible measurement, so writing it for "we could not read this"
 *      is the most damaging lie available here.
 *   3. A CAP THAT BIT WITHOUT BEING DISCLOSED. The stored uncovered-line list
 *      is capped and the count is not, so patch coverage asking "is line 412
 *      uncovered?" of a truncated list must answer NOT MEASURED — not
 *      "covered", which is the flattering direction on the number a PR blocks
 *      on.
 *   4. DOUBLE-COUNTING A RETRIED UPLOAD.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 *
 * The shape of coverage.test.ts: a mocked prisma module with a REAL
 * AsyncLocalStorage tenant scope, and the real router driven over a loopback
 * socket. Two deliberate choices on top of it:
 *
 *   · EVERY FAKE HONOURS `select` AND THROWS ON A COLUMN IT DOES NOT HAVE.
 *     A select-blind fake makes deleting a field from a query undetectable —
 *     the fake returns the whole row, the response keeps the field, the
 *     assertion keeps passing, and production loses it. Two defects survived a
 *     whole slice that way.
 *   · THE PARSING IS REAL. No fake Istanbul reader: the line arithmetic (max
 *     count per line, non-whitespace-only for V8) is the thing most likely to
 *     be quietly wrong, and stubbing it would make it unobservable.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  audits: Row[];
  env: Row;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
  audits: [],
  env: {
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEB_PUBLIC_URL: 'https://app.qaai.test',
    VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    ANTHROPIC_API_KEY: '',
  },
}));

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
  runWithRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  registerRequestSecrets: () => {},
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

// ─── `select`, honoured, loudly ─────────────────────────────────────────────

/**
 * Project a row onto the keys a `select` names, and THROW on a key the row does
 * not have.
 *
 * Both halves matter. Projecting is what makes dropping a field from a query
 * visible — the response loses it and an assertion about it fails. Throwing on
 * an unknown key is what makes a select naming a column that does not exist a
 * test failure rather than a silent `undefined` that reads as a null column.
 */
function selected(row: Row, select: Record<string, true> | undefined, where: string): Row {
  if (!select) throw new Error(`${where}: this fake requires an explicit \`select\``);
  const out: Row = {};
  for (const key of Object.keys(select)) {
    if (!(key in row)) throw new Error(`${where}: no column \`${key}\` on this row`);
    out[key] = row[key];
  }
  return out;
}

// ─── The in-memory store the router is pointed at ───────────────────────────

interface UploadRow extends Row {
  id: string;
  projectId: string;
  payloadHash: string;
  createdAt: Date;
}

interface FileRow extends Row {
  id: string;
  uploadId: string;
  path: string;
}

interface FakeStore {
  uploads: UploadRow[];
  files: FileRow[];
  /** Every `createUpload` call, so "nothing was written" is checkable. */
  writes: number;
  /** Set to make the atomic write throw, so a half-ingest cannot pass unseen. */
  throwOnWrite: Error | null;
}

let fake: FakeStore;

function makeStore(): Row {
  return {
    findUploadByHash: async (args: Row) => {
      const found = fake.uploads.find(
        (row) =>
          row.projectId === args.where.projectId && row.payloadHash === args.where.payloadHash,
      );
      return found ? selected(found, args.select, 'findUploadByHash') : null;
    },
    findNewestUpload: async (args: Row) => {
      const where = args.where as Row;
      const matches = fake.uploads
        .filter((row) => {
          if (row.projectId !== where.projectId) return false;
          if (where.commitSha !== undefined && row.commitSha !== where.commitSha) return false;
          if (where.runId !== undefined && row.runId !== where.runId) return false;
          if (where.testId !== undefined && row.testId !== where.testId) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const found = matches[0];
      return found ? selected(found, args.select, 'findNewestUpload') : null;
    },
    findFiles: async (args: Row) => {
      const rows = filterFiles(args.where as Row);
      const ordered =
        args.orderBy === 'GAPS'
          ? rows
              .slice()
              .sort(
                (a, b) =>
                  (b.uncoveredLineCount ?? -1) - (a.uncoveredLineCount ?? -1) ||
                  String(a.path).localeCompare(String(b.path)),
              )
          : rows.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
      return ordered
        .slice(args.skip, args.skip + args.take)
        .map((row) => selected(row, args.select, 'findFiles'));
    },
    countFiles: async (args: Row) => filterFiles(args.where as Row).length,
    findFilesByPath: async (args: Row) => {
      const paths = new Set(args.where.paths as string[]);
      return fake.files
        .filter((row) => row.uploadId === args.where.uploadId && paths.has(row.path))
        .map((row) => selected(row, args.select, 'findFilesByPath'));
    },
    createUpload: async (args: Row) => {
      fake.writes += 1;
      if (fake.throwOnWrite) throw fake.throwOnWrite;
      const id = `ccu_${fake.uploads.length + 1}`;
      /*
       * `createdAt` strictly increasing, so `findNewestUpload` has a real
       * order. `Date.now()` twice inside one test is the same millisecond.
       */
      const createdAt = new Date(1_700_000_000_000 + fake.uploads.length * 1_000);
      fake.uploads.push({ id, createdAt, ...(args.upload as Row) } as UploadRow);
      for (const file of args.files as Row[]) {
        fake.files.push({ id: `ccf_${fake.files.length + 1}`, uploadId: id, ...file } as FileRow);
      }
      return { id, createdAt };
    },
  };
}

function filterFiles(where: Row): FileRow[] {
  return fake.files.filter((row) => {
    if (row.uploadId !== where.uploadId) return false;
    if (where.inSourceTree !== undefined && row.inSourceTree !== where.inSourceTree) return false;
    if (where.mapped !== undefined && row.mapped !== where.mapped) return false;
    if (where.withGapsOnly === true) {
      const lines = row.uncoveredLineCount ?? 0;
      const branches = row.uncoveredBranchCount ?? 0;
      if (lines <= 0 && branches <= 0) return false;
    }
    return true;
  });
}

// ─── The rest of the database ───────────────────────────────────────────────

interface Db {
  projects: Row[];
  runs: Row[];
  tests: Row[];
  coverageSnapshots: Row[];
  codebaseSnapshots: Row[];
}

let db: Db;

function installPrisma(): void {
  h.prisma = {
    project: {
      findUnique: async (args: Row) => {
        const orgId = h.currentOrg();
        const found = db.projects.find((row) => row.id === args.where?.id);
        if (!found) return null;
        if (orgId && found.orgId !== orgId) return null;
        return selected(found, args.select, 'project.findUnique');
      },
    },
    run: {
      findUnique: async (args: Row) => {
        const found = db.runs.find((row) => row.id === args.where?.id);
        return found ? selected(found, args.select, 'run.findUnique') : null;
      },
      findFirst: async (args: Row) => {
        const found = db.runs.find(
          (row) =>
            row.projectId === args.where?.projectId && row.commitSha === args.where?.commitSha,
        );
        return found ? selected(found, args.select, 'run.findFirst') : null;
      },
    },
    test: {
      findUnique: async (args: Row) => {
        const found = db.tests.find((row) => row.id === args.where?.id);
        return found ? selected(found, args.select, 'test.findUnique') : null;
      },
    },
    coverageSnapshot: {
      findFirst: async (args: Row) => {
        const found = db.coverageSnapshots.find(
          (row) =>
            row.projectId === args.where?.projectId && row.commitSha === args.where?.commitSha,
        );
        return found ? selected(found, args.select, 'coverageSnapshot.findFirst') : null;
      },
    },
    codebaseSnapshot: {
      findFirst: async (args: Row) => {
        const found = db.codebaseSnapshots
          .filter((row) => row.projectId === args.where?.projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return found ? selected(found, args.select, 'codebaseSnapshot.findFirst') : null;
      },
    },
  };
}

const KNOWN_SHA = 'abc1234';

function install(over: Partial<Db> = {}): void {
  db = {
    projects: [{ id: 'proj_1', orgId: 'org_1', name: 'Shop' }],
    runs: [{ id: 'run_1', projectId: 'proj_1', commitSha: KNOWN_SHA }],
    tests: [{ id: 'test_1', projectId: 'proj_1' }],
    coverageSnapshots: [],
    codebaseSnapshots: [
      {
        id: 'cbs_1',
        projectId: 'proj_1',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        paths: ['src/billing.ts', 'src/web/app.ts', 'src/api/app.ts'],
      },
    ],
    ...over,
  };
  fake = { uploads: [], files: [], writes: 0, throwOnWrite: null };
  installPrisma();
  configureCodeCoverageIo({ store: makeStore() as never, now: () => NOW });
}

/** Frozen clock, so "too old" and "in the future" are testable. */
const NOW = new Date('2026-10-20T12:00:00.000Z');

// ─── The app under test ─────────────────────────────────────────────────────

const express = (await import('express')).default;
const {
  codeCoverageRouter,
  configureCodeCoverageIo,
  CODE_COVERAGE_CAPS,
  COVERAGE_FORMAT_PRESENT,
  COVERAGE_FORMATS,
  codeCoverageIngestBody,
  normalisePayloadPath,
  resolveAgainstTree,
} = await import('./code-coverage.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
/*
 * 32mb, bigger than `CODE_COVERAGE_CAPS.payloadBytes`, deliberately: the
 * router's own size refusal is only reachable if the body parser in front of it
 * does not refuse first. In production the global parser's smaller limit bites
 * instead, which is the fact `inlineLimitNote` exists to disclose.
 */
app.use(express.json({ limit: '32mb' }));
app.use(codeCoverageRouter);
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

let restoreIo: ReturnType<typeof configureCodeCoverageIo> | null = null;

beforeEach(() => {
  h.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
  h.audits.length = 0;
  restoreIo = configureCodeCoverageIo({});
  install();
});

afterEach(() => {
  if (restoreIo) configureCodeCoverageIo(restoreIo);
  restoreIo = null;
});

// ─── Payload builders ───────────────────────────────────────────────────────

/**
 * An Istanbul file, from a compact description: `lines` maps a line number to
 * its hit count, and a line listed twice is how the max-per-line rule is
 * exercised.
 */
function istanbulFile(
  statements: ReadonlyArray<{ line: number; count: number }>,
  branches: ReadonlyArray<{ line: number; counts: number[]; type?: string }> = [],
): Row {
  const statementMap: Row = {};
  const s: Row = {};
  statements.forEach((statement, index) => {
    statementMap[String(index)] = {
      start: { line: statement.line, column: 0 },
      end: { line: statement.line, column: 10 },
    };
    s[String(index)] = statement.count;
  });
  const branchMap: Row = {};
  const b: Row = {};
  branches.forEach((branch, index) => {
    branchMap[String(index)] = {
      loc: { start: { line: branch.line, column: 0 } },
      type: branch.type ?? 'if',
      locations: branch.counts.map(() => ({ start: { line: branch.line, column: 0 } })),
    };
    b[String(index)] = branch.counts;
  });
  return { statementMap, s, branchMap, b };
}

const istanbulPayload = (files: Record<string, Row>): Row => files;

const v8PayloadOf = (
  scripts: ReadonlyArray<{ url: string; source?: string; ranges: Row[] }>,
): Row => ({
  result: scripts.map((script) => ({
    url: script.url,
    ...(script.source === undefined ? {} : { source: script.source }),
    functions: [{ functionName: '', ranges: script.ranges, isBlockCoverage: true }],
  })),
});

const ingest = (body: Row) =>
  call('POST', '/code-coverage/proj_1', {
    commitSha: KNOWN_SHA,
    generatedAt: NOW.toISOString(),
    ...body,
  });

// ─── (a) The vocabulary, both halves ────────────────────────────────────────

describe('the format vocabulary', () => {
  /**
   * The compiler-enforced presence record AND the run-time parity check. Eight
   * GateRule kinds shipped unsaveable for two slices because only one of the
   * two existed, and `check:wiring` cannot see that class of defect: a format
   * added to the union and not to the validator is a format no caller can
   * declare.
   */
  /**
   * THE RUN-TIME HALF. The record above is compiler-enforced against the union
   * and cannot drift from it; what CAN drift is the zod schema a caller is
   * validated against, and this reads that schema's own options rather than a
   * second copy of the list — a parity test against a list it also owns proves
   * nothing.
   */
  it('the body validator offers exactly the declared formats, plus AUTO', () => {
    const options = codeCoverageIngestBody.shape.format.unwrap().options;
    expect([...options].sort()).toEqual(['AUTO', ...Object.keys(COVERAGE_FORMAT_PRESENT)].sort());
    // And the union's own list agrees with the record built from it.
    expect([...COVERAGE_FORMATS].sort()).toEqual(Object.keys(COVERAGE_FORMAT_PRESENT).sort());
  });

  it('every declared format is accepted by the body validator', async () => {
    for (const format of Object.keys(COVERAGE_FORMAT_PRESENT)) {
      const { status, body } = await ingest({
        format,
        payload:
          format === 'ISTANBUL'
            ? istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) })
            : v8PayloadOf([{ url: 'src/billing.ts', source: 'const a = 1;\n', ranges: [] }]),
      });
      expect(status, `format ${format} was refused: ${JSON.stringify(body)}`).toBe(200);
      expect(body.format).toMatchObject({ requested: format, detected: format });
    }
  });

  it('refuses a payload that is not the format the caller declared', async () => {
    const { status, body } = await ingest({
      format: 'V8',
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain('declared format V8');
    // Refused, not reinterpreted: the two dialects measure differently.
    expect(fake.writes).toBe(0);
  });

  it('refuses a payload in neither dialect rather than reading it as empty', async () => {
    const { status, body } = await ingest({ payload: { nothing: 'useful' } });
    expect(status).toBe(400);
    expect(body.error.message).toContain('neither Istanbul');
    expect(fake.writes).toBe(0);
  });
});

// ─── (b) Istanbul arithmetic ────────────────────────────────────────────────

describe('Istanbul line and branch arithmetic', () => {
  it('takes the MAXIMUM count per line, so a part-executed line is executed', async () => {
    const { status, body } = await ingest({
      payload: istanbulPayload({
        'src/billing.ts': istanbulFile([
          // One line, two statements: one never ran, one did.
          { line: 10, count: 0 },
          { line: 10, count: 4 },
          { line: 11, count: 0 },
        ]),
      }),
    });

    expect(status).toBe(200);
    // Two distinct lines found; line 10 covered because SOMETHING on it ran.
    expect(body.totals.linesFound).toBe(2);
    expect(body.totals.linesCovered).toBe(1);
    expect(body.totals.linePercent).toBe(50);
    const file = fake.files.find((row) => row.path === 'src/billing.ts');
    expect(file?.uncoveredLines).toEqual([11]);
  });

  it('counts each branch location and names the uncovered ones by line', async () => {
    const { status, body } = await ingest({
      payload: istanbulPayload({
        'src/billing.ts': istanbulFile(
          [{ line: 1, count: 1 }],
          [
            { line: 7, counts: [3, 0] },
            { line: 9, counts: [0, 0], type: 'binary-expr' },
          ],
        ),
      }),
    });

    expect(status).toBe(200);
    expect(body.totals.branchesFound).toBe(4);
    expect(body.totals.branchesCovered).toBe(1);
    const file = fake.files.find((row) => row.path === 'src/billing.ts');
    expect(file?.uncoveredBranches).toEqual([
      { line: 7, index: 1, type: 'if' },
      { line: 9, index: 0, type: 'binary-expr' },
      { line: 9, index: 1, type: 'binary-expr' },
    ]);
  });

  it('reports a file with no executable statement as 0 found and NULL percent', async () => {
    const { status, body } = await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([]) }),
    });

    expect(status).toBe(200);
    // 0 found is a measurement — a file of type declarations has no statement.
    expect(body.totals.linesFound).toBe(0);
    expect(body.totals.linesCovered).toBe(0);
    // And the percentage over an empty denominator is NULL, never 0 or 100.
    expect(body.totals.linePercent).toBeNull();
  });
});

// ─── (c) V8, and the UNMAPPED rule ──────────────────────────────────────────

describe('V8 payloads', () => {
  it('turns byte offsets into lines, counting non-whitespace only', async () => {
    //            0123456789...
    const source = 'const a = 1;\n   \nif (a) {\n  go();\n}\n';
    // Cover the first line only: offsets 0..12.
    const { status, body } = await ingest({
      payload: v8PayloadOf([
        {
          url: '/build/src/billing.ts',
          source,
          ranges: [
            { startOffset: 0, endOffset: source.length, count: 1 },
            { startOffset: 13, endOffset: source.length, count: 0 },
          ],
        },
      ]),
    });

    expect(status).toBe(200);
    // Line 2 is whitespace only: not found, so not counted either way. Lines
    // 1, 3, 4, 5 hold code; only line 1 ran.
    expect(body.totals.linesFound).toBe(4);
    expect(body.totals.linesCovered).toBe(1);
    const file = fake.files.find((row) => row.path === 'src/billing.ts');
    expect(file?.uncoveredLines).toEqual([3, 4, 5]);
  });

  it('applies the innermost range last, so a covered function keeps its holes', async () => {
    const source = 'a();\nb();\nc();\n';
    const { status, body } = await ingest({
      payload: v8PayloadOf([
        {
          url: 'src/billing.ts',
          source,
          ranges: [
            // The outer (function) range arrives SECOND in the payload. Applied
            // in payload order it would paint over the zero below it.
            { startOffset: 5, endOffset: 10, count: 0 },
            { startOffset: 0, endOffset: source.length, count: 2 },
          ],
        },
      ]),
    });

    expect(status).toBe(200);
    expect(body.totals.linesFound).toBe(3);
    expect(body.totals.linesCovered).toBe(2);
    expect(fake.files[0]?.uncoveredLines).toEqual([2]);
  });

  it('reports NULL branch counts for V8, never 0', async () => {
    const { body } = await ingest({
      payload: v8PayloadOf([{ url: 'src/billing.ts', source: 'a();\n', ranges: [] }]),
    });
    /*
     * 0 branches would read as "this file has no conditionals", which is a
     * claim about the customer's code made out of a dialect's silence.
     */
    expect(body.totals.branchesFound).toBeNull();
    expect(body.totals.branchPercent).toBeNull();
  });

  it('is UNMAPPED with a reason and a count when no source text came with it', async () => {
    const { status, body } = await ingest({
      payload: v8PayloadOf([
        { url: '/build/src/billing.ts', ranges: [{ startOffset: 0, endOffset: 10, count: 0 }] },
      ]),
    });

    expect(status).toBe(200);
    expect(body.totals.unmapped).toBe(1);
    expect(body.unmapped.reasons).toEqual({ NO_SOURCE_TEXT: 1 });
    /*
     * THE DEFECT THIS ASSERTION EXISTS FOR. An unmapped file must be in NO
     * percentage: zero covered lines is the worst possible measurement and
     * "we could not read the artifact" is not a measurement at all.
     */
    expect(body.totals.linesFound).toBeNull();
    expect(body.totals.linesCovered).toBeNull();
    expect(body.totals.linePercent).toBeNull();
    const file = fake.files[0];
    expect(file?.mapped).toBe(false);
    expect(file?.linesFound).toBeNull();
    expect(file?.uncoveredLineCount).toBeNull();
  });

  it('is UNMAPPED when the source is compiler output with a sourceMappingURL', async () => {
    const { body } = await ingest({
      payload: v8PayloadOf([
        {
          url: 'dist/index.js',
          source: 'a();\n//# sourceMappingURL=index.js.map\n',
          ranges: [{ startOffset: 0, endOffset: 4, count: 1 }],
        },
      ]),
    });
    /*
     * Its line numbers are the bundler's. "Line 412 of dist/index.js is
     * uncovered" to somebody who wrote TypeScript is a wrong answer that looks
     * exactly like a right one.
     */
    expect(body.unmapped.reasons).toEqual({ SOURCE_MAP_UNRESOLVED: 1 });
    expect(body.totals.linePercent).toBeNull();
  });

  it('keeps the mapped files measured when only some of them are unmapped', async () => {
    const { body } = await ingest({
      payload: v8PayloadOf([
        {
          url: 'src/billing.ts',
          source: 'a();\nb();\n',
          ranges: [
            { startOffset: 0, endOffset: 10, count: 1 },
            { startOffset: 5, endOffset: 9, count: 0 },
          ],
        },
        { url: 'dist/index.js', ranges: [] },
      ]),
    });
    expect(body.totals.files).toBe(2);
    expect(body.totals.mapped).toBe(1);
    expect(body.totals.unmapped).toBe(1);
    // The denominator is the mapped file's lines and nothing from the other.
    expect(body.totals.linesFound).toBe(2);
    expect(body.totals.linesCovered).toBe(1);
    expect(body.totals.linePercent).toBe(50);
  });
});

// ─── (d) Refusals: nothing is ever partially ingested ───────────────────────

describe('a payload that cannot be trusted is refused, and nothing is written', () => {
  it('refuses one that is too large, and says which cap and by how much', async () => {
    const big = 'x'.repeat(CODE_COVERAGE_CAPS.payloadBytes + 64);
    const { status, body } = await ingest({ payload: { 'src/billing.ts': big } });

    expect(status).toBe(400);
    expect(body.error.message).toContain('refused rather than truncated');
    expect(body.error.details.capsThatBit[0]).toMatchObject({
      cap: 'payloadBytes',
      limit: CODE_COVERAGE_CAPS.payloadBytes,
    });
    expect(body.error.details.capsThatBit[0].droppedAtLeast).toBeGreaterThan(0);
    // The limit the caller actually hits in production is disclosed too.
    expect(body.error.details.inlineLimitNote).toContain('global JSON body limit');
    expect(fake.writes).toBe(0);
  });

  it('refuses one that is too old', async () => {
    const { status, body } = await ingest({
      generatedAt: new Date(NOW.getTime() - 9 * 86_400_000).toISOString(),
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain('9 day(s) ago');
    expect(fake.writes).toBe(0);
  });

  it('refuses one stamped in the future beyond the clock-skew allowance', async () => {
    const { status, body } = await ingest({
      generatedAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(422);
    /*
     * The reason, not just the refusal: a future stamp would outrank every
     * correct payload that arrived afterwards for as long as it was in front.
     */
    expect(body.error.message).toContain('outranks every correct payload');
    expect(fake.writes).toBe(0);
  });

  it('accepts one inside the clock-skew allowance', async () => {
    const { status } = await ingest({
      generatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(200);
  });

  it('refuses a commit the project has never measured anything at', async () => {
    const { status, body } = await ingest({
      commitSha: 'deadbee',
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain('no run and no coverage snapshot at commit deadbee');
    expect(body.error.details.checked).toEqual(['Run.commitSha', 'CoverageSnapshot.commitSha']);
    expect(fake.writes).toBe(0);
  });

  it('accepts a commit only a coverage snapshot knows', async () => {
    install({
      runs: [],
      coverageSnapshots: [{ id: 'cs_1', projectId: 'proj_1', commitSha: 'feedfac' }],
    });
    const { status } = await ingest({
      commitSha: 'feedfac',
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(200);
  });

  it('refuses a payload whose commit disagrees with the run it names', async () => {
    install({
      runs: [
        { id: 'run_1', projectId: 'proj_1', commitSha: KNOWN_SHA },
        { id: 'run_2', projectId: 'proj_1', commitSha: '9999999' },
      ],
    });
    const { status, body } = await ingest({
      runId: 'run_2',
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(409);
    expect(body.error.message).toContain('joins a diff to lines that were never in it');
    expect(fake.writes).toBe(0);
  });

  it('refuses a run that belongs to another project with a 404, not a dropped column', async () => {
    install({
      runs: [
        { id: 'run_1', projectId: 'proj_1', commitSha: KNOWN_SHA },
        { id: 'run_other', projectId: 'proj_2', commitSha: KNOWN_SHA },
      ],
    });
    const { status } = await ingest({
      runId: 'run_other',
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(404);
    expect(fake.writes).toBe(0);
  });

  it('refuses more files than the row cap rather than storing the first N', async () => {
    const files: Row = {};
    for (let index = 0; index <= CODE_COVERAGE_CAPS.files; index += 1) {
      files[`src/f${index}.ts`] = istanbulFile([{ line: 1, count: 1 }]);
    }
    const { status, body } = await ingest({ payload: istanbulPayload(files) });

    expect(status).toBe(422);
    /*
     * Not api-surface's store-the-first-N: dropping FILES moves the roll-up in
     * a direction nobody can predict, and the stored number would be about a
     * project that does not exist.
     */
    expect(body.error.message).toContain('refused rather than cut');
    expect(body.error.details.capsThatBit[0]).toMatchObject({
      cap: 'files',
      limit: CODE_COVERAGE_CAPS.files,
      droppedAtLeast: 1,
    });
    expect(fake.writes).toBe(0);
  });

  it('refuses a path too long for the index, with the path named', async () => {
    const long = `src/${'a'.repeat(CODE_COVERAGE_CAPS.pathChars)}.ts`;
    const { status, body } = await ingest({
      payload: istanbulPayload({ [long]: istanbulFile([{ line: 1, count: 1 }]) }),
    });

    /*
     * A 422 with the path, not a 500 from the last statement of the write: a
     * payload path is a key in somebody else's JSON and `path` is half of a
     * unique index PostgreSQL will refuse past ~2,700 bytes.
     */
    expect(status).toBe(422);
    expect(body.error.details.capsThatBit[0]).toMatchObject({
      cap: 'pathChars',
      limit: CODE_COVERAGE_CAPS.pathChars,
      droppedAtLeast: 1,
    });
    expect(fake.writes).toBe(0);
  });

  it('refuses an absent payload rather than storing an upload that measured nothing', async () => {
    const { status, body } = await ingest({ payload: null });
    expect(status).toBe(400);
    expect(body.error.message).toContain('`payload` is required');
    expect(fake.writes).toBe(0);
  });
});

// ─── (e) Idempotency ────────────────────────────────────────────────────────

describe('idempotency', () => {
  const payload = () =>
    istanbulPayload({
      'src/billing.ts': istanbulFile([
        { line: 1, count: 1 },
        { line: 2, count: 0 },
      ]),
      'src/web/app.ts': istanbulFile([{ line: 5, count: 3 }]),
    });

  it('stores one upload when the same payload arrives twice', async () => {
    const first = await ingest({ payload: payload() });
    const second = await ingest({ payload: payload() });

    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(second.body.duplicateOf.uploadId).toBe(first.body.uploadId);
    // ONE write, and the response says how the key was built.
    expect(fake.writes).toBe(1);
    expect(fake.uploads).toHaveLength(1);
    expect(second.body.idempotencyRule).toContain('sha256');
  });

  it('recognises the same measurements uploaded later and with the keys reordered', async () => {
    const first = await ingest({ payload: payload() });
    const reordered = istanbulPayload({
      'src/web/app.ts': istanbulFile([{ line: 5, count: 3 }]),
      'src/billing.ts': istanbulFile([
        { line: 2, count: 0 },
        { line: 1, count: 1 },
      ]),
    });
    const second = await ingest({
      generatedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      payload: reordered,
    });

    expect(second.body.idempotent).toBe(true);
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(fake.writes).toBe(1);
  });

  it('keeps two cells of the same matrix apart', async () => {
    const first = await ingest({ payload: payload(), variantKey: 'chromium|de-DE' });
    const second = await ingest({ payload: payload(), variantKey: 'webkit|de-DE' });

    expect(first.body.idempotent).toBe(false);
    expect(second.body.idempotent).toBe(false);
    expect(second.body.uploadId).not.toBe(first.body.uploadId);
    // The same bytes legitimately describe two different cells.
    expect(fake.uploads).toHaveLength(2);
  });

  it('notices a changed measurement for the same scope', async () => {
    await ingest({ payload: payload() });
    const changed = await ingest({
      payload: istanbulPayload({
        'src/billing.ts': istanbulFile([
          { line: 1, count: 1 },
          { line: 2, count: 1 },
        ]),
        'src/web/app.ts': istanbulFile([{ line: 5, count: 3 }]),
      }),
    });
    expect(changed.body.idempotent).toBe(false);
    expect(fake.uploads).toHaveLength(2);
  });

  it('defaults the variant to the <unvaried> sentinel rather than leaving it null', async () => {
    await ingest({ payload: payload() });
    expect(fake.uploads[0]?.variantKey).toBe('<unvaried>');
  });
});

// ─── (f) Source-tree resolution ─────────────────────────────────────────────

describe('resolving a payload path against the project source tree', () => {
  it('suffix-matches an absolute CI path onto the repo-relative one', () => {
    const tree = new Map([['billing.ts', ['src/billing.ts']]]);
    expect(resolveAgainstTree('/home/runner/work/app/app/src/billing.ts', tree)).toEqual({
      path: 'src/billing.ts',
      inSourceTree: true,
    });
  });

  it('prefers the longest match', () => {
    const tree = new Map([['app.ts', ['src/web/app.ts', 'src/api/app.ts']]]);
    expect(resolveAgainstTree('/x/src/web/app.ts', tree)).toEqual({
      path: 'src/web/app.ts',
      inSourceTree: true,
    });
  });

  it('leaves an ambiguous match unresolved rather than guessing', () => {
    /*
     * Two workspaces with the same file name is a real repo shape, and picking
     * one would attribute coverage to a file that may not have run.
     */
    const tree = new Map([['app.ts', ['web/app.ts', 'api/app.ts']]]);
    // And the path it reports back is the payload's own, leading slash included:
    // an unplaced path must round-trip so a producer can match our answer to it.
    expect(resolveAgainstTree('/x/app.ts', tree)).toEqual({
      path: '/x/app.ts',
      inSourceTree: false,
    });
  });

  it('strips file:// and normalises backslashes', () => {
    const tree = new Map([['billing.ts', ['src/billing.ts']]]);
    expect(resolveAgainstTree('file://C:\\work\\src\\billing.ts', tree).inSourceTree).toBe(true);
  });

  it('counts the paths it could not place, and does not drop them', async () => {
    const { body } = await ingest({
      payload: istanbulPayload({
        '/ci/src/billing.ts': istanbulFile([{ line: 1, count: 1 }]),
        '/ci/generated/client.ts': istanbulFile([{ line: 1, count: 0 }]),
      }),
    });
    expect(body.totals.files).toBe(2);
    expect(body.totals.notInSourceTree).toBe(1);
    // Kept, with the payload's own spelling, so the denominator stays whole.
    const unplaced = fake.files.find((row) => row.inSourceTree === false);
    expect(unplaced?.path).toBe('/ci/generated/client.ts');
    expect(unplaced?.linesFound).toBe(1);
  });

  it('leaves BOTH of two payload paths that land on one source file unresolved', async () => {
    const { body } = await ingest({
      payload: istanbulPayload({
        '/ci/a/src/billing.ts': istanbulFile([{ line: 1, count: 1 }]),
        '/ci/b/src/billing.ts': istanbulFile([{ line: 1, count: 0 }]),
      }),
    });

    /*
     * The same ambiguity the resolver refuses to guess at, seen from the other
     * side. Merging them would invent a number and picking one would attribute
     * a build's coverage to a build it did not come from.
     */
    expect(body.sourceTree.pathCollisions).toBe(1);
    expect(body.sourceTree.collidedPaths).toEqual(['src/billing.ts']);
    expect(body.totals.notInSourceTree).toBe(2);
    // Both kept, with distinct spellings, so the denominator stays whole.
    expect(fake.files.map((row) => row.path).sort()).toEqual([
      '/ci/a/src/billing.ts',
      '/ci/b/src/billing.ts',
    ]);
    expect(body.totals.linesFound).toBe(2);
  });

  it('refuses a payload that measures the same file twice', async () => {
    const { status, body } = await ingest({
      payload: v8PayloadOf([
        { url: 'file:///ci/src/billing.ts', source: 'a();\n', ranges: [] },
        { url: '/ci/src/billing.ts', source: 'a();\n', ranges: [] },
      ]),
    });

    /*
     * Two measurements of one file, and all three ways to keep going are
     * wrong: summing invents a number, keeping one discards half the evidence
     * while reporting success, and letting it reach the insert fails the whole
     * transaction at its last statement as a 500.
     */
    expect(status).toBe(422);
    expect(body.error.message).toContain('more than once');
    expect(body.error.details.duplicatePaths[0]).toMatchObject({
      path: '/ci/src/billing.ts',
      count: 2,
    });
    expect(fake.writes).toBe(0);
  });

  it('normalises the same way for the duplicate check and for resolution', () => {
    // If these two disagreed, `file://` and bare spellings would pass the
    // duplicate check and then collide on the unique at insert time.
    expect(normalisePayloadPath('file:///ci/src/billing.ts')).toBe('/ci/src/billing.ts');
    expect(normalisePayloadPath('./src/billing.ts')).toBe('src/billing.ts');
    const tree = new Map([['billing.ts', ['src/billing.ts']]]);
    expect(resolveAgainstTree('file:///ci/src/billing.ts', tree).path).toBe('src/billing.ts');
  });

  it('says that no snapshot exists, rather than letting it read as no match', async () => {
    install({ codebaseSnapshots: [] });
    const { body } = await ingest({
      payload: istanbulPayload({ '/ci/src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(body.sourceTree.resolved).toBe(false);
    expect(body.sourceTree.snapshotId).toBeNull();
    expect(body.sourceTree.note).toContain('no CodebaseSnapshot exists');
  });
});

// ─── (g) The store can be absent, and that is a 503 ─────────────────────────

describe('when the tables have not been migrated', () => {
  beforeEach(() => {
    // The Prisma client with no code-coverage delegates on it, which is exactly
    // what this deployment has until the migration lands.
    configureCodeCoverageIo({ store: null });
  });

  it.each([
    ['POST', '/code-coverage/proj_1'],
    ['GET', '/code-coverage/proj_1/files'],
    ['GET', '/code-coverage/proj_1/uncovered'],
    ['POST', '/code-coverage/proj_1/patch'],
  ])('answers 503 and names the tables on %s %s', async (method, path) => {
    const { status, body } = await call(
      method,
      path,
      method === 'POST'
        ? {
            commitSha: KNOWN_SHA,
            generatedAt: NOW.toISOString(),
            payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
            changed: [{ path: 'src/billing.ts', lines: [1] }],
          }
        : undefined,
    );

    /*
     * 503 and not 200-with-nothing. An empty list would say "your suite
     * executes none of your code", which is a measured claim about the
     * customer made out of our own missing migration.
     */
    expect(status).toBe(503);
    expect(body.error.code).toBe('CODE_COVERAGE_STORE_UNAVAILABLE');
    expect(body.error.message).toContain('CodeCoverageUpload');
    expect(body.error.message).toContain('says nothing about how much of your code is covered');
  });
});

// ─── (h) The per-file roll-up ───────────────────────────────────────────────

describe('GET /files — the per-file roll-up', () => {
  async function seed(): Promise<void> {
    await ingest({
      payload: istanbulPayload({
        'src/billing.ts': istanbulFile([
          { line: 1, count: 1 },
          { line: 2, count: 0 },
          { line: 3, count: 0 },
        ]),
        'src/web/app.ts': istanbulFile([{ line: 1, count: 1 }]),
      }),
    });
  }

  it('returns a percentage per file and the scope the number is about', async () => {
    await seed();
    const { status, body } = await call('GET', '/code-coverage/proj_1/files');

    expect(status).toBe(200);
    expect(body.commitSha).toBe(KNOWN_SHA);
    expect(body.totals.linePercent).toBe(50);
    const billing = (body.files as Row[]).find((row) => row.path === 'src/billing.ts');
    expect(billing).toMatchObject({ linesFound: 3, linesCovered: 1, uncoveredLineCount: 2 });
    expect(billing?.linePercent).toBeCloseTo(33.3, 1);
  });

  it('pages with total/offset/limit and says a short page is not the end', async () => {
    await seed();
    const { body } = await call('GET', '/code-coverage/proj_1/files?limit=1');
    expect(body.files).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.pageRule).toContain('does not mean the list is exhausted');
  });

  it('reads `withGapsOnly=false` as a filter that is off, not on', async () => {
    await seed();
    const { body } = await call('GET', '/code-coverage/proj_1/files?withGapsOnly=false');
    // `z.coerce.boolean()` would have read "false" as true and returned 1 row,
    // from which a reader would conclude every file has a gap.
    expect(body.total).toBe(2);
  });

  it('404s for a commit with no upload rather than answering with another one', async () => {
    await seed();
    const { status } = await call('GET', '/code-coverage/proj_1/files?commitSha=0000000');
    expect(status).toBe(404);
  });

  it('answers from the NEWEST upload for the scope', async () => {
    await seed();
    await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    const { body } = await call('GET', '/code-coverage/proj_1/files');
    expect(body.uploadId).toBe(fake.uploads[fake.uploads.length - 1]?.id);
    expect(body.total).toBe(1);
  });
});

// ─── (i) The ranked uncovered list ──────────────────────────────────────────

describe('GET /uncovered — which lines, ranked', () => {
  it('ranks by uncovered line count descending and names the lines', async () => {
    await ingest({
      payload: istanbulPayload({
        'src/web/app.ts': istanbulFile([
          { line: 1, count: 0 },
          { line: 2, count: 0 },
          { line: 3, count: 0 },
        ]),
        'src/billing.ts': istanbulFile([
          { line: 9, count: 1 },
          { line: 10, count: 0 },
        ]),
      }),
    });

    const { status, body } = await call('GET', '/code-coverage/proj_1/uncovered');
    expect(status).toBe(200);
    expect((body.files as Row[]).map((row) => row.path)).toEqual([
      'src/web/app.ts',
      'src/billing.ts',
    ]);
    expect(body.files[1].uncoveredLines).toEqual([10]);
    expect(body.ranking).toBe('uncoveredLineCount descending, then path ascending');
  });

  it('leaves fully covered files out of the list but not out of the totals', async () => {
    await ingest({
      payload: istanbulPayload({
        'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]),
        'src/web/app.ts': istanbulFile([{ line: 1, count: 0 }]),
      }),
    });
    const { body } = await call('GET', '/code-coverage/proj_1/uncovered');
    expect(body.total).toBe(1);
    expect(body.totals.files).toBe(2);
  });

  it('excludes unmapped files from the list and names the count', async () => {
    await ingest({
      payload: v8PayloadOf([
        {
          url: 'src/billing.ts',
          source: 'a();\nb();\n',
          ranges: [
            { startOffset: 0, endOffset: 10, count: 1 },
            { startOffset: 5, endOffset: 9, count: 0 },
          ],
        },
        { url: 'dist/index.js', ranges: [] },
      ]),
    });
    const { body } = await call('GET', '/code-coverage/proj_1/uncovered');
    expect(body.total).toBe(1);
    // Not hidden: the count is on the response and in the header's totals.
    expect(body.excluded.unmappedFiles).toBe(1);
    expect(body.totals.unmapped).toBe(1);
  });

  it('discloses the per-file list cap, and keeps the count intact', async () => {
    const statements = Array.from(
      { length: CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 20 },
      (_unused, index) => ({ line: index + 1, count: 0 }),
    );
    const ingested = await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile(statements) }),
    });

    expect(ingested.body.capsThatBit).toEqual([
      {
        cap: 'uncoveredLinesPerFile',
        limit: CODE_COVERAGE_CAPS.uncoveredLinesPerFile,
        droppedAtLeast: 1,
      },
    ]);
    expect(ingested.body.capRule).toContain('uncoveredLinesPerFile');

    const { body } = await call('GET', '/code-coverage/proj_1/uncovered');
    const file = body.files[0] as Row;
    /*
     * THE ASYMMETRY THAT IS THE WHOLE DISCLOSURE: the list truncates and the
     * count does not. A reader measuring the array would report 500 gaps in a
     * file with 520.
     */
    expect(file.uncoveredLinesListed).toBe(CODE_COVERAGE_CAPS.uncoveredLinesPerFile);
    expect(file.uncoveredLineCount).toBe(CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 20);
    expect(file.uncoveredLinesTruncated).toBe(true);
    expect(body.listCaps.rule).toContain('Read the count for arithmetic');
  });
});

// ─── (j) Patch coverage — what a PR gate actually needs ─────────────────────

describe('POST /patch — coverage of the lines a change touched', () => {
  const patch = (body: Row) => call('POST', '/code-coverage/proj_1/patch', body);

  async function seed(): Promise<void> {
    await ingest({
      payload: istanbulPayload({
        '/ci/src/billing.ts': istanbulFile([
          { line: 10, count: 1 },
          { line: 11, count: 0 },
          { line: 12, count: 0 },
          { line: 13, count: 4 },
        ]),
      }),
    });
  }

  it('divides the changed lines into covered and uncovered', async () => {
    await seed();
    const { status, body } = await patch({
      changed: [{ path: 'src/billing.ts', lines: [10, 11, 12] }],
    });

    expect(status).toBe(200);
    expect(body.patch).toMatchObject({
      denominator: 3,
      covered: 1,
      uncovered: 2,
      notMeasured: 0,
      measured: true,
    });
    expect(body.patch.percent).toBeCloseTo(33.3, 1);
    expect(body.files[0].uncoveredLines).toEqual([11, 12]);
  });

  it('resolves the diff path the same way the payload path was resolved', async () => {
    await seed();
    // The payload said `/ci/src/billing.ts`; the diff says `src/billing.ts`.
    // Only a shared normalisation makes those the same file.
    const { body } = await patch({
      changed: [{ path: './src/billing.ts', lines: [11] }],
    });
    expect(body.patch.denominator).toBe(1);
    expect(body.patch.uncovered).toBe(1);
  });

  it('keeps a file with no coverage row OUT of the denominator', async () => {
    await seed();
    const { body } = await patch({
      changed: [
        { path: 'src/billing.ts', lines: [11] },
        { path: 'prisma/migrations/x/migration.sql', lines: [1, 2, 3] },
      ],
    });

    expect(body.patch).toMatchObject({ denominator: 1, uncovered: 1, notMeasured: 3 });
    /*
     * Same judgement as `NOT_IN_INVENTORY`: a file the coverage run never
     * instrumented is usually a config or a migration, and calling its lines
     * untested would fail every PR for a reason nobody can act on.
     */
    const row = (body.files as Row[]).find((entry) => entry.path.endsWith('migration.sql'));
    expect(row?.state).toBe('NO_COVERAGE_ROW');
    expect(row?.percent).toBeNull();
  });

  it('reports UNMEASURED, not 0%, when no changed line is in a measured file', async () => {
    await seed();
    const { body } = await patch({ changed: [{ path: 'README.md', lines: [1] }] });

    expect(body.patch.measured).toBe(false);
    /* The rule the gate depends on: NULL, never 0, when nothing was divided. */
    expect(body.patch.percent).toBeNull();
    expect(body.patch.denominator).toBe(0);
    expect(body.caveats[0]).toContain('UNMEASURED and not 0%');
    expect(body.patch.measuredRule).toContain('read `measured` before `percent`');
  });

  it('refuses to call a line covered just because a truncated list omits it', async () => {
    const statements = Array.from(
      { length: CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 5 },
      (_unused, index) => ({ line: index + 1, count: 0 }),
    );
    await ingest({ payload: istanbulPayload({ 'src/billing.ts': istanbulFile(statements) }) });

    // Line 520 IS uncovered and is past the stored list's cap.
    const line = CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 3;
    const { body } = await patch({ changed: [{ path: 'src/billing.ts', lines: [line] }] });

    /*
     * THE DEFECT THIS TEST EXISTS FOR. Absence from a capped list is not
     * evidence of coverage, and answering "covered" here would be a cap biting
     * unreported, in the flattering direction, on the number a PR blocks on.
     */
    expect(body.patch.covered).toBe(0);
    expect(body.patch.notMeasured).toBe(1);
    expect(body.patch.measured).toBe(false);
    expect(body.patch.percent).toBeNull();
    expect(body.files[0].state).toBe('LIST_TRUNCATED');
    expect(body.caveats.join(' ')).toContain('absence from it is not evidence');
  });

  it('refuses a truncated diff rather than answering about the part it got', async () => {
    await seed();
    const { status, body } = await patch({
      changed: [{ path: 'src/billing.ts', lines: [11] }],
      diffTruncated: true,
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain('the ones a gate would have caught');
  });

  it('refuses a diff over the path cap, and names the cap', async () => {
    await seed();
    const changed = Array.from({ length: CODE_COVERAGE_CAPS.patchPaths + 1 }, (_unused, index) => ({
      path: `src/f${index}.ts`,
      lines: [1],
    }));
    const { status, body } = await patch({ changed });
    expect(status).toBe(422);
    expect(body.error.details.capsThatBit[0]).toMatchObject({
      cap: 'patchPaths',
      limit: CODE_COVERAGE_CAPS.patchPaths,
      droppedAtLeast: 1,
    });
  });

  it('refuses a path over the per-path line cap', async () => {
    await seed();
    const { status, body } = await patch({
      changed: [
        {
          path: 'src/billing.ts',
          lines: Array.from(
            { length: CODE_COVERAGE_CAPS.patchLinesPerPath + 1 },
            (_unused, index) => index + 1,
          ),
        },
      ],
    });
    expect(status).toBe(422);
    expect(body.error.details.capsThatBit[0].cap).toBe('patchLinesPerPath');
  });

  it('merges two diff entries that resolve to one file', async () => {
    await seed();
    const { body } = await patch({
      changed: [
        { path: 'src/billing.ts', lines: [11] },
        { path: '/ci/src/billing.ts', lines: [12] },
      ],
    });
    expect(body.filesTotal).toBe(1);
    expect(body.patch.uncovered).toBe(2);
  });
});

// ─── (k) The audit row, and the write boundary ──────────────────────────────

describe('the write itself', () => {
  it('writes one audit row naming the upload and what was unreadable', async () => {
    await ingest({
      payload: v8PayloadOf([
        {
          url: 'src/billing.ts',
          source: 'a();\n',
          ranges: [{ startOffset: 0, endOffset: 4, count: 1 }],
        },
        { url: 'dist/index.js', ranges: [] },
      ]),
    });

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'code_coverage.ingest',
      targetType: 'Project',
      targetId: 'proj_1',
    });
    expect(h.audits[0]?.metadata).toMatchObject({ fileCount: 2, unmappedFileCount: 1 });
  });

  it('writes no audit row and stores nothing when the atomic write fails', async () => {
    fake.throwOnWrite = new Error('deadlock');
    const { status } = await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });

    /*
     * An upload and its files are ONE fact. A half-written ingest would leave
     * a row claiming to have measured a payload whose measurements are not
     * there — read afterwards as a project whose every file is 0% covered.
     */
    expect(status).toBe(500);
    expect(fake.uploads).toHaveLength(0);
    expect(fake.files).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('needs MEMBER to ingest and lets a VIEWER read', async () => {
    h.actor = { ...h.actor, role: 'VIEWER' };
    const refused = await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(refused.status).toBe(403);

    h.actor = { ...h.actor, role: 'MEMBER' };
    await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    h.actor = { ...h.actor, role: 'VIEWER' };
    const read = await call('GET', '/code-coverage/proj_1/files');
    expect(read.status).toBe(200);
  });

  it('404s a project in another org rather than confirming it exists', async () => {
    h.actor = { ...h.actor, orgId: 'org_2' };
    const { status } = await ingest({
      payload: istanbulPayload({ 'src/billing.ts': istanbulFile([{ line: 1, count: 1 }]) }),
    });
    expect(status).toBe(404);
    expect(fake.writes).toBe(0);
  });
});
