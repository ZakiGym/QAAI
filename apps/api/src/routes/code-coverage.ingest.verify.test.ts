/**
 * `/code-coverage/:projectId` — THE ADVERSARIAL PASS OVER THE INGEST DOOR.
 *
 * A second test file beside `code-coverage.test.ts` on purpose, and the reason
 * is the reason this one exists: the first file was written by the agent that
 * built the door, and an author's tests cover the cases the author thought of.
 * Everything here was chosen by reading the code for the shapes it could NOT
 * see — not by re-deriving the ones it already asserts. So the overlap is
 * deliberately near zero and the four questions below are all of the form "what
 * would this answer if it were wrong".
 *
 *   1. INSTRUMENTATION ABSENT. With no tables and no injected store, is the
 *      answer 503 with the table names — or 0%, or 200 with an empty list? A 0%
 *      here reads as "your suite executes none of your code" and a 200 with
 *      nothing in it reads as "measured, and there is nothing to report". Both
 *      are measured claims made out of a missing migration.
 *   2. IDEMPOTENCY. The same payload twice, and the same MEASUREMENTS twice
 *      with a different `generatedAt` and the file keys in a different order —
 *      which is what two c8 runs of one suite actually emit. One upload, or
 *      two? Two makes every read answer from whichever arrived last.
 *   3. EVERY CAP THAT REFUSES. Drive each one past its limit and read the
 *      response for a COUNT and a REASON, not just a 4xx. A cap that bit and
 *      printed no number is the defect this product is a reaction to.
 *   4. THE PATCH DENOMINATOR. Construct a diff and check that the number counts
 *      ONLY the touched lines — and then check what it does with a touched line
 *      the upload never measured, which is the case a PR gate blocks on.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 *
 * The same shape as the file beside it, for the same reasons: a mocked prisma
 * with a real AsyncLocalStorage tenant scope, the real router over a loopback
 * socket, REAL payload parsing (no stubbed arithmetic — the arithmetic is the
 * thing most likely to be quietly wrong), and a store fake that HONOURS
 * `select` and throws on a column the row does not have. A select-blind fake
 * makes deleting a field from a query undetectable, which is how two defects
 * survived a whole slice.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  currentOrg: () => string | null;
  actor: { userId: string; orgId: string; role: string; ip: string | null };
  env: Row;
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  currentOrg: () => null,
  actor: { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null },
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

vi.mock('../lib/audit.js', () => ({ audit: async () => {} }));

vi.mock('../middleware/auth.js', async () => {
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { ...h.actor };
      void withTenant(h.actor.orgId, () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── `select`, honoured, loudly ─────────────────────────────────────────────

function selected(row: Row, select: Record<string, true> | undefined, where: string): Row {
  if (!select) throw new Error(`${where}: this fake requires an explicit \`select\``);
  const out: Row = {};
  for (const key of Object.keys(select)) {
    if (!(key in row)) throw new Error(`${where}: no column \`${key}\` on this row`);
    out[key] = row[key];
  }
  return out;
}

// ─── The in-memory store ────────────────────────────────────────────────────

interface FakeStore {
  uploads: Row[];
  files: Row[];
  writes: number;
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
      const found = fake.uploads
        .filter((row) => {
          if (row.projectId !== where.projectId) return false;
          if (where.commitSha !== undefined && row.commitSha !== where.commitSha) return false;
          if (where.runId !== undefined && row.runId !== where.runId) return false;
          if (where.testId !== undefined && row.testId !== where.testId) return false;
          return true;
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return found ? selected(found, args.select, 'findNewestUpload') : null;
    },
    findFiles: async (args: Row) =>
      fake.files
        .filter((row) => row.uploadId === args.where.uploadId)
        .slice(args.skip, args.skip + args.take)
        .map((row) => selected(row, args.select, 'findFiles')),
    countFiles: async (args: Row) =>
      fake.files.filter((row) => row.uploadId === args.where.uploadId).length,
    findFilesByPath: async (args: Row) => {
      const paths = new Set(args.where.paths as string[]);
      return fake.files
        .filter((row) => row.uploadId === args.where.uploadId && paths.has(row.path))
        .map((row) => selected(row, args.select, 'findFilesByPath'));
    },
    createUpload: async (args: Row) => {
      fake.writes += 1;
      const id = `ccu_${fake.uploads.length + 1}`;
      const createdAt = new Date(1_700_000_000_000 + fake.uploads.length * 1_000);
      fake.uploads.push({ id, createdAt, ...(args.upload as Row) });
      for (const file of args.files as Row[]) {
        fake.files.push({ id: `ccf_${fake.files.length + 1}`, uploadId: id, ...file });
      }
      return { id, createdAt };
    },
  };
}

// ─── The rest of the database ───────────────────────────────────────────────

const KNOWN_SHA = 'abc1234';
const NOW = new Date('2026-10-20T12:00:00.000Z');

let db: Row;

function install(over: Row = {}): void {
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
        paths: ['src/billing.ts', 'src/web/app.ts'],
      },
    ],
    ...over,
  };
  fake = { uploads: [], files: [], writes: 0 };
  h.prisma = {
    project: {
      findUnique: async (args: Row) => {
        const orgId = h.currentOrg();
        const found = db.projects.find((row: Row) => row.id === args.where?.id);
        if (!found) return null;
        if (orgId && found.orgId !== orgId) return null;
        return selected(found, args.select, 'project.findUnique');
      },
    },
    run: {
      findUnique: async (args: Row) => {
        const found = db.runs.find((row: Row) => row.id === args.where?.id);
        return found ? selected(found, args.select, 'run.findUnique') : null;
      },
      findFirst: async (args: Row) => {
        const found = db.runs.find(
          (row: Row) =>
            row.projectId === args.where?.projectId && row.commitSha === args.where?.commitSha,
        );
        return found ? selected(found, args.select, 'run.findFirst') : null;
      },
    },
    test: {
      findUnique: async (args: Row) => {
        const found = db.tests.find((row: Row) => row.id === args.where?.id);
        return found ? selected(found, args.select, 'test.findUnique') : null;
      },
    },
    coverageSnapshot: {
      findFirst: async (args: Row) => {
        const found = db.coverageSnapshots.find(
          (row: Row) =>
            row.projectId === args.where?.projectId && row.commitSha === args.where?.commitSha,
        );
        return found ? selected(found, args.select, 'coverageSnapshot.findFirst') : null;
      },
    },
    codebaseSnapshot: {
      findFirst: async (args: Row) => {
        const found = db.codebaseSnapshots
          .filter((row: Row) => row.projectId === args.where?.projectId)
          .sort((a: Row, b: Row) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return found ? selected(found, args.select, 'codebaseSnapshot.findFirst') : null;
      },
    },
  };
  configureCodeCoverageIo({ store: makeStore() as never, now: () => NOW });
}

// ─── The app under test ─────────────────────────────────────────────────────

const express = (await import('express')).default;
const { codeCoverageRouter, configureCodeCoverageIo, CODE_COVERAGE_CAPS } = await import(
  './code-coverage.js'
);
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
// Bigger than `payloadBytes`, deliberately: the router's own size refusal is
// only reachable if the parser in front of it does not refuse first.
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
  restoreIo = configureCodeCoverageIo({});
  install();
});

afterEach(() => {
  if (restoreIo) configureCodeCoverageIo(restoreIo);
  restoreIo = null;
});

// ─── Payload builders ───────────────────────────────────────────────────────

/**
 * One Istanbul file from `line -> hit count`.
 *
 * Istanbul is the dialect that knows statement positions, so a line ABSENT from
 * this map is a line with no statement on it — a comment, a blank, a closing
 * brace. That absence is the whole point of the patch tests below.
 */
function istanbulFile(
  lines: Readonly<Record<number, number>>,
  branches: ReadonlyArray<{ line: number; counts: number[] }> = [],
): Row {
  const statementMap: Row = {};
  const s: Row = {};
  Object.entries(lines).forEach(([line, count], index) => {
    statementMap[String(index)] = {
      start: { line: Number(line), column: 0 },
      end: { line: Number(line), column: 10 },
    };
    s[String(index)] = count;
  });
  const branchMap: Row = {};
  const b: Row = {};
  branches.forEach((branch, index) => {
    branchMap[String(index)] = {
      type: 'if',
      loc: { start: { line: branch.line, column: 0 }, end: { line: branch.line, column: 9 } },
      locations: branch.counts.map(() => ({
        start: { line: branch.line, column: 0 },
        end: { line: branch.line, column: 9 },
      })),
    };
    b[String(index)] = branch.counts;
  });
  return { statementMap, s, branchMap, b };
}

const ingest = (body: Row) =>
  call('POST', '/code-coverage/proj_1', {
    commitSha: KNOWN_SHA,
    generatedAt: NOW.toISOString(),
    ...body,
  });

// ─── (1) Instrumentation absent ─────────────────────────────────────────────

describe('no tables and no store', () => {
  /**
   * THE ANSWER IS 503 AND IT MUST NEVER BE A NUMBER.
   *
   * `CodeCoverageUpload` and `CodeCoverageFile` are not in schema.prisma, so
   * `prismaStore()` resolves no delegates and there is nothing to read. 0% would
   * read as "your suite executes none of your code" and a 200 with an empty
   * list as "measured, nothing to report". Both are measured claims about the
   * customer manufactured out of our own missing migration, which is the exact
   * shape of lie this product cannot afford.
   */
  it('answers 503 and names the tables, never 0% and never an empty 200', async () => {
    configureCodeCoverageIo({ store: null });
    for (const probe of [
      () => ingest({ payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) } }),
      () => call('GET', '/code-coverage/proj_1/files'),
      () => call('GET', '/code-coverage/proj_1/uncovered'),
      () =>
        call('POST', '/code-coverage/proj_1/patch', {
          changed: [{ path: 'src/billing.ts', lines: [1] }],
        }),
    ]) {
      const res = await probe();
      expect(res.status).toBe(503);
      const text = JSON.stringify(res.body);
      expect(text).toContain('CodeCoverageUpload');
      expect(text).toContain('CodeCoverageFile');
      // No percentage anywhere in an UNAVAILABLE answer.
      expect(res.body.totals).toBeUndefined();
      expect(text).not.toContain('linePercent');
    }
  });
});

// ─── (2) Idempotency ────────────────────────────────────────────────────────

describe('the same measurements twice', () => {
  const payload = {
    'src/billing.ts': istanbulFile({ 3: 1, 4: 0, 5: 2 }),
    'src/web/app.ts': istanbulFile({ 1: 1 }),
  };

  it('the identical payload twice writes once', async () => {
    const first = await ingest({ payload });
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);
    const second = await ingest({ payload });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(second.body.stored).toEqual({ files: 0 });
    expect(fake.writes).toBe(1);
    expect(fake.uploads).toHaveLength(1);
    expect(fake.files).toHaveLength(2);
  });

  it('a later generatedAt and a different key order is still one upload', async () => {
    /*
     * This is the case that actually happens. Two c8 runs of one suite emit the
     * same coverage with the object keys in a different order and `generatedAt`
     * a second apart. Hashing the BYTES would store that as two uploads and let
     * every read answer from whichever arrived last — so the key is built from
     * the sorted per-file measurements and `generatedAt` is deliberately out of
     * it.
     */
    const first = await ingest({ payload });
    const reordered = {
      'src/web/app.ts': payload['src/web/app.ts'],
      'src/billing.ts': payload['src/billing.ts'],
    };
    const second = await ingest({
      payload: reordered,
      generatedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    });
    expect(second.body.idempotent).toBe(true);
    expect(second.body.uploadId).toBe(first.body.uploadId);
    expect(fake.writes).toBe(1);
  });

  it('a changed COUNT is a different upload, so a re-measure is not swallowed', async () => {
    /*
     * The other half, and the one that would make idempotency dangerous if it
     * were wrong: two payloads whose arithmetic differs are two measurements. A
     * key that collapsed them would answer every read with the first run's
     * number for ever.
     */
    await ingest({ payload });
    const improved = {
      ...payload,
      'src/billing.ts': istanbulFile({ 3: 1, 4: 7, 5: 2 }),
    };
    const second = await ingest({ payload: improved });
    expect(second.body.idempotent).toBe(false);
    expect(fake.writes).toBe(2);
  });

  it('the same payload under a different variant is a different upload', async () => {
    await ingest({ payload });
    const other = await ingest({ payload, variantKey: 'firefox|1280x720' });
    expect(other.body.idempotent).toBe(false);
    expect(fake.writes).toBe(2);
  });
});

// ─── (3) Every cap, made to bite ────────────────────────────────────────────

describe('each cap bites with a count and a reason', () => {
  /**
   * A 4xx is not a disclosure. Each refusal has to carry the limit, how far
   * over the payload was, and a sentence saying what the caller loses — because
   * a cap that bit and printed no number is indistinguishable from a bug, and
   * the caller cannot act on either.
   */
  const assertDisclosed = (body: Row, cap: string) => {
    const hit = (body.caps_that_bit ?? body.capsThatBit ?? body.details?.capsThatBit) as
      | Row[]
      | undefined;
    const hits = hit ?? (body.error?.details?.capsThatBit as Row[] | undefined);
    expect(hits, `no capsThatBit on the ${cap} refusal: ${JSON.stringify(body)}`).toBeDefined();
    const entry = hits?.find((row) => row.cap === cap);
    expect(entry, `${cap} not named in capsThatBit`).toBeDefined();
    expect(entry?.limit).toBe((CODE_COVERAGE_CAPS as Row)[cap]);
    expect(entry?.droppedAtLeast).toBeGreaterThan(0);
    const message = String(body.error?.message ?? body.message ?? '');
    expect(message.length).toBeGreaterThan(40);
    return { entry, message };
  };

  it('files: refused, with how many over, and nothing written', async () => {
    const payload: Row = {};
    for (let index = 0; index <= CODE_COVERAGE_CAPS.files; index += 1) {
      payload[`src/gen/f${index}.ts`] = istanbulFile({ 1: 1 });
    }
    const res = await ingest({ payload });
    expect(res.status).toBe(422);
    const { entry, message } = assertDisclosed(res.body, 'files');
    expect(entry?.droppedAtLeast).toBe(1);
    expect(message).toContain('refused rather than cut');
    // The whole point of a refusal: no partial roll-up exists afterwards.
    expect(fake.writes).toBe(0);
    expect(fake.uploads).toHaveLength(0);
  });

  it('pathChars: refused with the count, before the insert that would 500', async () => {
    const payload: Row = { [`src/${'a'.repeat(CODE_COVERAGE_CAPS.pathChars)}.ts`]: istanbulFile({ 1: 1 }) };
    const res = await ingest({ payload });
    expect(res.status).toBe(422);
    assertDisclosed(res.body, 'pathChars');
    expect(fake.writes).toBe(0);
  });

  it('maxPayloadAgeMs: refused, with the age and the limit as numbers', async () => {
    const res = await ingest({
      payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) },
      generatedAt: new Date(NOW.getTime() - CODE_COVERAGE_CAPS.maxPayloadAgeMs - 1_000).toISOString(),
    });
    expect(res.status).toBe(422);
    const details = res.body.error?.details as Row;
    expect(details?.ageMs).toBeGreaterThan(CODE_COVERAGE_CAPS.maxPayloadAgeMs);
    expect(details?.maxPayloadAgeMs).toBe(CODE_COVERAGE_CAPS.maxPayloadAgeMs);
    expect(fake.writes).toBe(0);
  });

  it('clockSkewMs: a future payload is refused, with now and the allowance', async () => {
    const res = await ingest({
      payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) },
      generatedAt: new Date(NOW.getTime() + CODE_COVERAGE_CAPS.clockSkewMs + 60_000).toISOString(),
    });
    expect(res.status).toBe(422);
    const details = res.body.error?.details as Row;
    expect(details?.clockSkewMs).toBe(CODE_COVERAGE_CAPS.clockSkewMs);
    expect(details?.nowIso).toBe(NOW.toISOString());
    expect(fake.writes).toBe(0);
  });

  it('patchPaths and patchLinesPerPath: refused, counted, and not answered at 0%', async () => {
    await ingest({ payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) } });

    const manyPaths = await call('POST', '/code-coverage/proj_1/patch', {
      changed: Array.from({ length: CODE_COVERAGE_CAPS.patchPaths + 1 }, (_, index) => ({
        path: `src/gen/f${index}.ts`,
        lines: [1],
      })),
    });
    expect(manyPaths.status).toBe(422);
    assertDisclosed(manyPaths.body, 'patchPaths');
    expect(JSON.stringify(manyPaths.body)).not.toContain('"percent":0');

    const manyLines = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [
        {
          path: 'src/billing.ts',
          lines: Array.from({ length: CODE_COVERAGE_CAPS.patchLinesPerPath + 1 }, (_, i) => i + 1),
        },
      ],
    });
    expect(manyLines.status).toBe(422);
    assertDisclosed(manyLines.body, 'patchLinesPerPath');
  });

  it('a truncated diff is refused rather than answered in the flattering direction', async () => {
    await ingest({ payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [{ path: 'src/billing.ts', lines: [1] }],
      diffTruncated: true,
    });
    expect(res.status).toBe(422);
    expect(String(res.body.error?.message)).toContain('would have caught');
  });

  it('uncoveredLinesPerFile truncates the LIST, discloses it, and the COUNT stays whole', async () => {
    /*
     * The one cap here that truncates instead of refusing, and the asymmetry is
     * the disclosure: a reader who measures the array gets the cap, a reader who
     * reads the count gets the truth, and the flag is how the first finds out.
     */
    const lines: Record<number, number> = {};
    const total = CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 25;
    for (let line = 1; line <= total; line += 1) lines[line] = 0;
    const res = await ingest({ payload: { 'src/billing.ts': istanbulFile(lines) } });
    expect(res.status).toBe(200);
    const hit = (res.body.capsThatBit as Row[]).find((row) => row.cap === 'uncoveredLinesPerFile');
    expect(hit).toBeDefined();
    expect(hit?.droppedAtLeast).toBe(1);
    const row = fake.files[0] as Row;
    expect(row.uncoveredLines).toHaveLength(CODE_COVERAGE_CAPS.uncoveredLinesPerFile);
    expect(row.uncoveredLinesTruncated).toBe(true);
    // The count is NOT capped. That is what makes the truncation survivable.
    expect(row.uncoveredLineCount).toBe(total);
    expect(res.body.capRule).toContain('uncoveredLinesPerFile');
  });

  it('uncoveredBranchesPerFile truncates its list and keeps its count whole', async () => {
    const total = CODE_COVERAGE_CAPS.uncoveredBranchesPerFile + 7;
    const branches = Array.from({ length: total }, (_, index) => ({
      line: index + 1,
      counts: [0],
    }));
    const res = await ingest({
      payload: { 'src/billing.ts': istanbulFile({ 1: 1 }, branches) },
    });
    expect(res.status).toBe(200);
    const hit = (res.body.capsThatBit as Row[]).find(
      (row) => row.cap === 'uncoveredBranchesPerFile',
    );
    expect(hit?.limit).toBe(CODE_COVERAGE_CAPS.uncoveredBranchesPerFile);
    expect(hit?.droppedAtLeast).toBe(1);
    const row = fake.files[0] as Row;
    expect(row.uncoveredBranches).toHaveLength(CODE_COVERAGE_CAPS.uncoveredBranchesPerFile);
    expect(row.uncoveredBranchesTruncated).toBe(true);
    // The count is not capped, so the roll-up is still right.
    expect(row.uncoveredBranchCount).toBe(total);
    expect(res.body.totals.branchesFound).toBe(total);
  });

  it('sourceTreePaths: the tree read is capped and SAID to be capped', async () => {
    /*
     * The quietest of the caps: it does not change a count on the response, it
     * changes which payload paths could be RESOLVED. A reader watching
     * `notInSourceTree` rise has to be able to tell "these paths are not in the
     * repo" from "we stopped reading the repo".
     */
    install({
      codebaseSnapshots: [
        {
          id: 'cbs_big',
          projectId: 'proj_1',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
          paths: Array.from(
            { length: CODE_COVERAGE_CAPS.sourceTreePaths + 5 },
            (_, index) => `src/gen/f${index}.ts`,
          ),
        },
      ],
    });
    const res = await ingest({ payload: { 'src/billing.ts': istanbulFile({ 1: 1 }) } });
    expect(res.status).toBe(200);
    const hit = (res.body.capsThatBit as Row[]).find((row) => row.cap === 'sourceTreePaths');
    expect(hit?.limit).toBe(CODE_COVERAGE_CAPS.sourceTreePaths);
    expect(hit?.droppedAtLeast).toBeGreaterThan(0);
    expect(res.body.sourceTree.pathCount).toBe(CODE_COVERAGE_CAPS.sourceTreePaths);
    expect(res.body.capRule).toContain('sourceTreePaths');
  });

  it('patchFilesListed: the LIST is cut, the total is not, and the cut is named', async () => {
    const files: Row = {};
    const changed: Row[] = [];
    const count = CODE_COVERAGE_CAPS.patchFilesListed + 3;
    for (let index = 0; index < count; index += 1) {
      files[`src/gen/f${index}.ts`] = istanbulFile({ 1: index % 2 });
      changed.push({ path: `src/gen/f${index}.ts`, lines: [1] });
    }
    await ingest({ payload: files });
    const res = await call('POST', '/code-coverage/proj_1/patch', { changed });
    expect(res.status).toBe(200);
    expect(res.body.filesTotal).toBe(count);
    expect(res.body.filesListed).toBe(CODE_COVERAGE_CAPS.patchFilesListed);
    const hit = (res.body.capsThatBit as Row[]).find((row) => row.cap === 'patchFilesListed');
    expect(hit?.droppedAtLeast).toBe(3);
    // The arithmetic is over every file, not only the listed ones — a cut list
    // with a cut denominator behind it would be a percentage about 500 files
    // presented as one about 503.
    expect(res.body.patch.denominator).toBe(count);
  });
});

// ─── (4) The patch denominator ──────────────────────────────────────────────

describe('patch coverage counts only the touched lines', () => {
  /**
   * The file is measured at lines 10-14; the diff touches 12, 13 and 14 only.
   * Nothing about lines 10 and 11 may reach the numerator or the denominator —
   * patch coverage that quietly widened to the file would turn every PR on a
   * badly-covered file green or red for reasons that are not in the diff.
   */
  const measuredFile = istanbulFile({ 10: 1, 11: 1, 12: 1, 13: 0, 14: 0 });

  it('the denominator is the changed lines, not the file', async () => {
    await ingest({ payload: { 'src/billing.ts': measuredFile } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [{ path: 'src/billing.ts', lines: [12, 13, 14] }],
    });
    expect(res.status).toBe(200);
    expect(res.body.patch).toMatchObject({
      denominator: 3,
      covered: 1,
      uncovered: 2,
      notMeasured: 0,
      percent: 33.3,
      measured: true,
    });
    // The file's own number is a different, larger fraction. They must differ,
    // or the patch number is just the file number wearing a diff.
    expect(res.body.totals.linesFound).toBe(5);
    expect(res.body.files[0].uncoveredLines).toEqual([13, 14]);
  });

  it('a changed line in a file the upload never measured is NOT MEASURED, not uncovered', async () => {
    await ingest({ payload: { 'src/billing.ts': measuredFile } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [
        { path: 'src/billing.ts', lines: [13] },
        { path: 'src/web/app.ts', lines: [1, 2, 3] },
      ],
    });
    expect(res.body.patch.denominator).toBe(1);
    expect(res.body.patch.notMeasured).toBe(3);
    expect(res.body.patch.uncovered).toBe(1);
    const other = (res.body.files as Row[]).find((row) => row.path === 'src/web/app.ts');
    expect(other?.state).toBe('NO_COVERAGE_ROW');
    expect(other?.percent).toBeNull();
  });

  it('a diff that touches nothing measured is UNMEASURED, and `percent` is null not 0', async () => {
    /*
     * The single worst defect this endpoint could ship is a green PR check that
     * checked nothing, so `measured: false` has to come with `percent: null`.
     * A gate reading 0% here would BLOCK every PR that touches only files the
     * coverage run does not instrument; a gate reading 100% would pass them all.
     */
    await ingest({ payload: { 'src/billing.ts': measuredFile } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [{ path: 'docs/README.md', lines: [1, 2] }],
    });
    expect(res.body.patch.measured).toBe(false);
    expect(res.body.patch.percent).toBeNull();
    expect(res.body.patch.denominator).toBe(0);
    expect(res.body.patch.notMeasured).toBe(2);
    expect(res.body.caveats.join(' ')).toContain('UNMEASURED and not 0%');
  });

  it('a capped uncovered-line list makes the file NOT MEASURED rather than covered', async () => {
    /*
     * The one place a truncated list would have lied, and in the flattering
     * direction on the number a PR blocks on. Absence from a capped
     * `uncoveredLines` is not evidence a line is covered.
     */
    const lines: Record<number, number> = {};
    for (let line = 1; line <= CODE_COVERAGE_CAPS.uncoveredLinesPerFile + 5; line += 1) {
      lines[line] = 0;
    }
    await ingest({ payload: { 'src/billing.ts': istanbulFile(lines) } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [{ path: 'src/billing.ts', lines: [1, 2, 3] }],
    });
    expect(res.body.patch.measured).toBe(false);
    expect(res.body.patch.percent).toBeNull();
    expect(res.body.patch.notMeasured).toBe(3);
    expect((res.body.files as Row[])[0]?.state).toBe('LIST_TRUNCATED');
    expect(res.body.caveats.join(' ')).toContain('not evidence a line is covered');
  });

  it('the inference that makes a changed line "covered" is disclosed, because it can be wrong', async () => {
    /*
     * THE DEFECT THIS ASSERTION EXISTS FOR, and it is a disclosure and not a
     * fix.
     *
     * The only per-line evidence stored is `uncoveredLines`. So "covered" is
     * inferred from ABSENCE from that list — and a line with no statement on it
     * is absent too. On an ISTANBUL upload, where the statement map is the
     * authority, a changed comment, blank line or closing brace is therefore
     * counted as COVERED. Below: 6 changed lines, 3 of them with no statement,
     * and the endpoint reports 4/6 where the executable truth is 1/3.
     *
     * Fixing the arithmetic needs the COVERED (or found) line list stored, which
     * needs a column on a table that is not in schema.prisma yet — so what is
     * enforced here is that the response SAYS SO. An inflation a reader can see
     * is survivable; this one was silent, and `denominatorRule` read as though
     * every counted line had been measured.
     */
    await ingest({ payload: { 'src/billing.ts': istanbulFile({ 10: 1, 13: 0, 14: 0 }) } });
    const res = await call('POST', '/code-coverage/proj_1/patch', {
      changed: [{ path: 'src/billing.ts', lines: [10, 11, 12, 13, 14, 15] }],
    });
    expect(res.body.patch).toMatchObject({ denominator: 6, covered: 4, uncovered: 2 });
    const rule = String(res.body.patch.coveredRule ?? '');
    expect(rule).toContain('ABSENCE');
    expect(rule).toContain('no statement in an Istanbul map');
    expect(rule).toContain('UPPER BOUND');
    // The count travels with the sentence, so a reader can see how much of
    // their number rests on the inference rather than on a measurement.
    expect(res.body.caveats.join(' ')).toContain('4 of the 6 changed line(s) are counted as covered');
  });
});
