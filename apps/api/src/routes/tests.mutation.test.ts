/**
 * The mutation score, over the wire.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The score lived only inside a Step TITLE ("Mutation score 72.4% — 89 of 123
 * mutants killed"), so nothing outside the runner plugin could read it. Five
 * columns on `TestResult` fix the storage half; a column nothing READS is this
 * codebase's signature defect (`scripts/check-wiring.ts` exists to fail on it),
 * so the number also has to come back out of an endpoint. This file is the
 * proof that it does.
 *
 * ── What is actually at risk here ───────────────────────────────────────────
 *
 * Not "does the field appear in the JSON". Three states arrive in those columns
 * and the read path is where they get conflated:
 *
 *   · all five NULL          — mutation testing never ran. Must NOT become a
 *                              point on the trend: plotted as 0 it invents a
 *                              collapse that never happened.
 *   · counts set, score NULL — it ran and produced no valid mutant. IS a point,
 *                              with a null score, because "we tried and there
 *                              was nothing to judge" is a fact about the run.
 *   · score 0                — it ran and killed nothing. A point at 0, and the
 *                              worst result a suite can report.
 *
 * Plus the delta, which has the same trap one level up: a zero delta means
 * "unchanged" and must not double as "cannot tell".
 *
 * Harness: the same shape as projects.auth-profile.test.ts — a mocked prisma
 * module, the real router driven over a loopback socket — trimmed to the three
 * models this handler reads. The last suite compares the hand-written migration
 * with schema.prisma, because `prisma migrate dev` is not run in this repo and
 * nothing else does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  /** Every `where` the survivor read filtered on. Empty when it was never made. */
  survivorWheres: Row[];
}

const h = vi.hoisted((): Hoisted => ({ prisma: {}, survivorWheres: [] }));

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

vi.mock('../lib/prisma.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const store = new AsyncLocalStorage<{ orgId: string | null }>();
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
  const { withTenant } = await import('../lib/prisma.js');
  return {
    requireAuth: (req: Row, _res: Row, next: () => void) => {
      req.actor = { userId: 'user_1', orgId: 'org_1', role: 'MEMBER', ip: null };
      void withTenant('org_1', () => next());
    },
    requireRole: () => (_req: Row, _res: Row, next: () => void) => next(),
    requireScope: () => (_req: Row, _res: Row, next: () => void) => next(),
    actorOf: (req: Row) => req.actor,
  };
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_ID = 'test_cart';

/** A result row as the handler selects one. `mutation*` absent = never measured. */
function result(over: Partial<Row> & { id: string; createdAt: string }): Row {
  return {
    status: 'PASSED',
    durationMs: 1_000,
    errorMessage: null,
    retriedAndPassed: false,
    mutationScore: null,
    mutationDetected: null,
    mutationUndetected: null,
    mutationExcluded: null,
    mutationMinScore: null,
    ...over,
    createdAt: new Date(over.createdAt),
    run: {
      id: `run_for_${over.id}`,
      queuedAt: new Date(over.createdAt),
      trigger: 'PUSH',
      branch: 'main',
      commitSha: `sha_${over.id}`,
      environment: { name: 'staging', kind: 'STAGING' },
      ...((over.run as Row) ?? {}),
    },
  };
}

/** A measured result: the three counts plus the bar, with a score. */
function measured(
  id: string,
  createdAt: string,
  over: { score?: number | null; detected?: number; undetected?: number; excluded?: number } = {},
): Row {
  return result({
    id,
    createdAt,
    mutationScore: over.score === undefined ? 70 : over.score,
    mutationDetected: over.detected ?? 70,
    mutationUndetected: over.undetected ?? 30,
    mutationExcluded: over.excluded ?? 0,
    mutationMinScore: 60,
  });
}

function install(results: Row[], survivors: Row[] = []): void {
  h.survivorWheres = [];
  h.prisma = {
    test: {
      findUnique: async ({ where }: Row) =>
        where.id === TEST_ID
          ? {
              id: TEST_ID,
              projectId: 'proj_a',
              name: 'cart totals',
              filePath: 'tests/cart.spec.ts',
              type: 'MUTATION',
              priority: 'IMPORTANT',
              tags: [],
              quarantined: false,
              quarantinedAt: null,
              quarantineReason: null,
              flakeRate: 0,
              consecutiveFailures: 0,
              lastRunAt: null,
              reviewFlags: [],
            }
          : null,
    },
    testResult: {
      // Newest-first, as the handler's own orderBy asks for.
      findMany: async ({ take }: Row = {}) =>
        [...results]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take ?? results.length),
      count: async () => results.length,
    },
    mutationSurvivor: {
      findMany: async ({ where, take }: Row = {}) => {
        h.survivorWheres.push(where ?? {});
        return survivors
          .filter((s) => s.testResultId === where?.testResultId)
          .slice(0, take ?? survivors.length)
          .map(({ testResultId: _ignored, ...rest }) => rest);
      },
    },
  };
}

// ─── The app under test ──────────────────────────────────────────────────────

const express = (await import('express')).default;
const { testsRouter, mutationTrend } = await import('./tests.js');
const { errorHandler, notFoundHandler } = await import('../middleware/errors.js');

const app = express();
app.use(express.json());
app.use('/tests', testsRouter);
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

async function history(path = `/tests/${TEST_ID}/history`): Promise<{ status: number; body: Row }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : {} };
}

beforeEach(() => {
  install([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) The number has a consumer
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /tests/:testId/history returns the mutation score', () => {
  it('reads the score, the counts and the threshold back out', async () => {
    install([
      measured('r1', '2026-10-20T10:00:00.000Z', {
        score: 72.4,
        detected: 89,
        undetected: 34,
        excluded: 5,
      }),
    ]);

    const { status, body } = await history();

    expect(status).toBe(200);
    expect(body.mutation.latest).toMatchObject({
      testResultId: 'r1',
      runId: 'run_for_r1',
      score: 72.4,
      detected: 89,
      undetected: 34,
      excluded: 5,
      // Derived, never stored: a second copy of detected + undetected is one
      // more thing that can disagree with its own inputs.
      valid: 123,
      minScore: 60,
    });
    expect(body.mutation.measured).toBe(1);
  });

  it('returns the trend newest-first with the change since the previous run', async () => {
    install([
      measured('older', '2026-10-01T10:00:00.000Z', { score: 60 }),
      measured('newer', '2026-10-20T10:00:00.000Z', { score: 72 }),
    ]);

    const { body } = await history();

    expect(body.mutation.points.map((p: Row) => p.testResultId)).toEqual(['newer', 'older']);
    // The actual question: is this getting better? +12 points.
    expect(body.mutation.deltaFromPrevious).toBeCloseTo(12, 6);
  });

  it('names the surviving mutants of the newest measured run', async () => {
    install(
      [measured('r1', '2026-10-20T10:00:00.000Z', { undetected: 2 })],
      [
        {
          testResultId: 'r1',
          id: 's1',
          file: 'src/cart.ts',
          line: 42,
          mutator: 'ConditionalExpression',
          detail: 'replaced with true',
          reason: 'survived',
        },
        {
          testResultId: 'r1',
          id: 's2',
          file: 'src/pricing.ts',
          line: null,
          mutator: 'ArithmeticOperator',
          detail: null,
          reason: 'no-coverage',
        },
      ],
    );

    const { body } = await history();

    expect(body.mutation.survivors).toHaveLength(2);
    expect(body.mutation.survivors[0]).toMatchObject({
      file: 'src/cart.ts',
      line: 42,
      mutator: 'ConditionalExpression',
      reason: 'survived',
    });
    // The whole value of the survivor list: a location a person can open.
    expect(body.mutation.survivors[1].line).toBeNull();
    expect(body.mutation.survivorsTruncated).toBe(false);
    expect(h.survivorWheres).toEqual([{ testResultId: 'r1' }]);
  });

  it('makes no survivor query at all when the newest run killed everything', async () => {
    install([
      measured('r1', '2026-10-20T10:00:00.000Z', { score: 100, detected: 120, undetected: 0 }),
    ]);

    const { body } = await history();

    // A healthy suite pays nothing for this feature.
    expect(h.survivorWheres).toEqual([]);
    expect(body.mutation.survivors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Null is not zero, on the way out as well as in
// ─────────────────────────────────────────────────────────────────────────────

describe('a test that never measured mutation reports nothing, not zero', () => {
  it('returns no points and a null latest for unmeasured results', async () => {
    install([result({ id: 'r1', createdAt: '2026-10-20T10:00:00.000Z' })]);

    const { body } = await history();

    expect(body.mutation.measured).toBe(0);
    expect(body.mutation.latest).toBeNull();
    expect(body.mutation.points).toEqual([]);
    // The inversion this guards: a 0 here draws a suite that asserts nothing.
    expect(body.mutation.deltaFromPrevious).toBeNull();
    expect(h.survivorWheres).toEqual([]);
  });

  it('keeps a real score of 0 as a point, because it is the worst result there is', async () => {
    install([
      measured('r1', '2026-10-20T10:00:00.000Z', { score: 0, detected: 0, undetected: 123 }),
    ]);

    const { body } = await history();

    expect(body.mutation.measured).toBe(1);
    expect(body.mutation.latest.score).toBe(0);
    expect(body.mutation.latest.score).not.toBeNull();
  });

  it('keeps "ran, nothing valid to judge" as a point with a null score', async () => {
    // Every mutant failed to build: the tool ran, there was no denominator.
    install([
      measured('r1', '2026-10-20T10:00:00.000Z', {
        score: null,
        detected: 0,
        undetected: 0,
        excluded: 12,
      }),
    ]);

    const { body } = await history();

    // A point, because something happened — and an unscored one, because
    // nothing was judged. `excluded` is what makes it readable.
    expect(body.mutation.measured).toBe(1);
    expect(body.mutation.latest.score).toBeNull();
    expect(body.mutation.latest.excluded).toBe(12);
    expect(body.mutation.deltaFromPrevious).toBeNull();
  });

  it('does not mistake "unchanged" for "cannot tell"', async () => {
    install([
      measured('older', '2026-10-01T10:00:00.000Z', { score: 70 }),
      measured('newer', '2026-10-20T10:00:00.000Z', { score: 70 }),
    ]);

    const { body } = await history();

    // 0 is a finding. `null` would be the absence of one, and a UI cannot tell
    // them apart if the API will not.
    expect(body.mutation.deltaFromPrevious).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) The rule as a pure function
// ─────────────────────────────────────────────────────────────────────────────

describe('mutationTrend', () => {
  /** The function's own input type, so this suite cannot drift from it. */
  type TrendRow = Parameters<typeof mutationTrend>[0][number];

  const row = (over: Partial<TrendRow>): TrendRow => ({
    id: 'r',
    createdAt: new Date('2026-10-20T10:00:00.000Z'),
    mutationScore: null,
    mutationDetected: null,
    mutationUndetected: null,
    mutationExcluded: null,
    mutationMinScore: null,
    run: { id: 'run', commitSha: null },
    ...over,
  });

  it('uses mutationDetected and not the score to decide a run measured anything', () => {
    /*
     * Keyed on `detected` because the score is legitimately null on a measured
     * run. Keying on the score would silently drop the "nothing valid to judge"
     * state, which is the one a misconfigured `scope` produces — exactly the
     * run somebody needs to see.
     */
    expect(mutationTrend([row({ mutationDetected: 0, mutationUndetected: 0 })]).measured).toBe(1);
    expect(mutationTrend([row({})]).measured).toBe(0);
  });

  it('never fabricates a delta from a single point', () => {
    expect(
      mutationTrend([row({ mutationScore: 80, mutationDetected: 8, mutationUndetected: 2 })])
        .deltaFromPrevious,
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) The migration declares what the schema declares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `prisma migrate dev` is not run in this repo — migrations are hand-written —
 * so nothing but this compares the two declarations. A migration that disagrees
 * with the schema is a deployment that comes up either missing a column the
 * code writes to, or holding one the code believes is absent, and neither shows
 * up until a query runs in production.
 */
describe('the migration declares what the Prisma schema declares', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');
  const schema = read('prisma/schema.prisma');
  const migration = read(
    'prisma/migrations/20261024010000_mutation_metric_and_survivors/migration.sql',
  );
  /*
   * The STATEMENTS, with the `--` commentary stripped. Most of this migration
   * is an argument about why the columns are nullable, and that prose quotes
   * both the trend query and the words "NOT NULL" — so an assertion about what
   * the migration DOES has to read the DDL rather than the essay around it.
   */
  const ddl = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  const model = (name: string): string => {
    const block = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    expect(block, `schema.prisma declares no model ${name}`).toBeTruthy();
    return block![1]!;
  };

  it('adds five NULLABLE metric columns with no default', () => {
    const testResult = model('TestResult');
    for (const [column, type] of [
      ['mutationScore', 'Float'],
      ['mutationDetected', 'Int'],
      ['mutationUndetected', 'Int'],
      ['mutationExcluded', 'Int'],
      ['mutationMinScore', 'Float'],
    ] as const) {
      expect(testResult).toMatch(new RegExp(`^\\s*${column}\\s+${type}\\?\\s*$`, 'm'));
    }

    expect(migration).toMatch(/ADD COLUMN\s+"mutationScore" DOUBLE PRECISION/);
    expect(migration).toMatch(/ADD COLUMN\s+"mutationDetected" INTEGER/);
    expect(migration).toMatch(/ADD COLUMN\s+"mutationUndetected" INTEGER/);
    expect(migration).toMatch(/ADD COLUMN\s+"mutationExcluded" INTEGER/);
    expect(migration).toMatch(/ADD COLUMN\s+"mutationMinScore" DOUBLE PRECISION/);
  });

  it('gives no mutation column a DEFAULT, in either declaration', () => {
    /*
     * The single most load-bearing assertion in this file. `DEFAULT 0` would
     * make "never measured" and "every mutant survived" the same row for every
     * result in the table — and on `TestResult`, the largest table in this
     * product, it would also rewrite the whole thing on deploy.
     */
    expect(model('TestResult')).not.toMatch(/mutation\w+\s+\w+\?\s+@default/);
    expect(ddl).not.toMatch(/"mutation\w+"[^,;]*DEFAULT/);
    expect(ddl).not.toMatch(/"mutation\w+"[^,;]*NOT NULL/);
  });

  it('creates MutationSurvivor with the columns and indexes the schema declares', () => {
    const survivor = model('MutationSurvivor');
    expect(survivor).toMatch(/^\s*file\s+String\s*$/m);
    // Nullable: line 0 does not exist, and a 0 would send a reader to the top
    // of the file with confidence.
    expect(survivor).toMatch(/^\s*line\s+Int\?\s*$/m);
    expect(survivor).toMatch(/^\s*mutator\s+String\s*$/m);
    expect(survivor).toMatch(/^\s*detail\s+String\?\s*$/m);
    expect(survivor).toMatch(/^\s*reason\s+String\s*$/m);
    expect(survivor).toMatch(/@@index\(\[testResultId\]\)/);
    expect(survivor).toMatch(/@@index\(\[orgId, file\]\)/);
    expect(survivor).toMatch(/@@index\(\[createdAt\]\)/);

    expect(migration).toContain('CREATE TABLE "MutationSurvivor"');
    expect(migration).toContain('"line" INTEGER,');
    expect(migration).toContain(
      'CREATE INDEX "MutationSurvivor_testResultId_idx" ON "MutationSurvivor"("testResultId")',
    );
    expect(migration).toContain(
      'CREATE INDEX "MutationSurvivor_orgId_file_idx" ON "MutationSurvivor"("orgId", "file")',
    );
    expect(migration).toContain(
      'CREATE INDEX "MutationSurvivor_createdAt_idx" ON "MutationSurvivor"("createdAt")',
    );
  });

  it('cascades the survivors from their result, as the schema says', () => {
    expect(model('MutationSurvivor')).toMatch(
      /testResult\s+TestResult\s+@relation\(fields: \[testResultId\], references: \[id\], onDelete: Cascade\)/,
    );
    expect(migration).toContain(
      'ALTER TABLE "MutationSurvivor" ADD CONSTRAINT "MutationSurvivor_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it('touches no table but TestResult and MutationSurvivor', () => {
    // The migration's own claim about itself, kept true: anything else belongs
    // in its own migration with its own argument.
    const altered = [...ddl.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect([...new Set(altered)].sort()).toEqual(['MutationSurvivor', 'TestResult']);
    const created = [...ddl.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(created).toEqual(['MutationSurvivor']);
  });
});
