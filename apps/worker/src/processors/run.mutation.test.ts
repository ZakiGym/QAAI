/**
 * Does the mutation score survive the run processor?
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The mutation score — the only honest answer to "do these tests actually
 * assert anything?" — existed ONLY interpolated into a Step title ("Mutation
 * score 72.4% — 89 of 123 mutants killed"). Nothing outside
 * packages/runner/src/plugins/mutation.ts could read it, so it could not be
 * trended, gated on, or alerted on, and the surviving mutants went the same way
 * as FAILED steps with the file and line inside the title.
 *
 * ── Why these assertions and not "it persists" ──────────────────────────────
 *
 * Most of this file is about the difference between NULL and ZERO, because that
 * is the one way this feature can be worse than not having it. A score of 0
 * means EVERY MUTANT SURVIVED — the worst result a suite can produce. A NULL
 * means nobody measured. Writing 0 for "not measured" inverts the signal for
 * every row in the table: the project that has never run mutation testing
 * becomes indistinguishable from the project whose tests assert nothing, and
 * every trend, gate and alert built on the column reads backwards.
 *
 * So: the round trip, the survivors with their file and line, absent data
 * leaving all five columns PRESENT AND NULL, a genuine 0 surviving as 0, and
 * the third state (measured, nothing valid to judge) staying distinct from
 * both.
 *
 * ── Harness ─────────────────────────────────────────────────────────────────
 *
 * A separate file from run.test.ts, which is being edited concurrently. Same
 * shape of stand-in — the worker's context opens Postgres, Redis and object
 * storage at import time, so it is replaced wholesale — trimmed to one run with
 * one MUTATION test, plus a plugin whose `TestExecution` the test dictates.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutationRunData, TestExecution } from '@qaai/shared';

type Row = Record<string, unknown>;

interface Hoisted {
  prisma: Record<string, unknown>;
  /** What the plugin reports for the single test. Set per test. */
  execution: Partial<TestExecution> | null;
  log: string[];
}

const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  execution: null,
  log: [],
}));

vi.mock('../context.js', () => ({
  config: { concurrency: 1, artifactsLocal: true, anthropicApiKey: 'test' },
  connection: { disconnect: () => {} },
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  publishEvent: () => {},
  storage: { put: async () => {}, putFile: async () => {}, get: async () => null },
}));

vi.mock('../queues.js', () => ({
  ANALYZE_SOURCE_QUEUE: 'qaai.analyze-source',
  DELIVERY_JOB: 'delivery',
  armFlakeTick: async () => {},
  armScheduleTick: async () => {},
  closeProducers: async () => {},
  enqueueNotify: async () => {},
  enqueueTriage: async () => {},
}));

vi.mock('../vault.js', () => ({ secretsFor: async () => ({}), open: () => 'access-key' }));
vi.mock('../grids.js', () => ({ gridWsEndpoint: () => 'wss://grid.example/ws' }));
vi.mock('@qaai/storage', () => ({
  artifactKey: (a: { orgId: string; runId: string; name: string }) =>
    `orgs/${a.orgId}/runs/${a.runId}/${a.name}`,
}));

/*
 * A PARTIAL mock, exactly as run.test.ts does it: `gates.js` is real (it depends
 * only on @qaai/shared) so finalisation runs for real, and everything that would
 * open a browser is a stand-in. `pluginFor` returns whatever the test set on
 * `h.execution`, which is how a MUTATION plugin's numbers get into the
 * processor without running Stryker.
 */
vi.mock('@qaai/runner', async () => ({
  ...(await import('../../../../packages/runner/src/gates.js')),
  reasonUnsupported: (type: string) => `${type} is not supported`,
  signInWithProfile: async () => ({
    ok: true,
    storageState: null,
    message: 'signed in',
    expiresAt: null,
  }),
  pluginFor: () => ({
    validate: () => {},
    execute: async (_ctx: unknown, test: { id: string }): Promise<TestExecution> => ({
      testId: test.id,
      status: 'PASSED',
      durationMs: 10,
      steps: [],
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: null,
      retriedAndPassed: false,
      findings: [],
      ...(h.execution ?? {}),
    }),
  }),
}));

vi.mock('./schedule.js', () => ({
  recordMonitorResult: async () => {},
  processScheduleTick: async () => {},
}));

/*
 * `../repo-materialise.js` pulls the GitHub App helpers in, so the mock has to
 * carry them or the real module cannot be linked. They are never reached: the
 * fake project has no repository, which is also the state that makes a MUTATION
 * test SKIP — so the test below sets one, and the materialiser is replaced.
 */
vi.mock('../../../api/src/lib/github-app.js', () => ({
  CHECKS_QUEUE: 'qaai.checks',
  GITHUB_API_HOST: 'api.github.com',
  githubRepoSlug: (repo: string) => repo,
  installationToken: async () => 'ghs_never_used',
  loadAppConfig: () => null,
}));

vi.mock('../repo-materialise.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repo-materialise.js')>();
  return {
    ...actual,
    /*
     * A materialised checkout, without a GitHub. MUTATION is repo-dependent —
     * the processor SKIPS it outright when there is no workspace — so without
     * this every assertion below would be about a skipped test.
     */
    materialiseRepoWorkspace: async () => ({
      kind: 'ready' as const,
      workspace: { root: '/tmp/qaai-mutation-test', source: 'acme/app@abc1234', fileCount: 1 },
      bytes: 1_024,
      skippedLinks: 0,
      cleanup: async () => {},
    }),
  };
});

const { MAX_PERSISTED_SURVIVORS, mutationColumns, processRun } = await import('./run.js');

// ─────────────────────────────────────────────────────────────────────────────
// The stand-in
// ─────────────────────────────────────────────────────────────────────────────

const ORG = 'org1';
const RUN = 'run1';
const RESULT = 'res1';
const TEST = 't1';

interface Captured {
  /** Every `testResult.update` the processor made, in order. */
  resultUpdates: Array<{ id: string; data: Row }>;
  /** `deleteMany` / `createMany` on MutationSurvivor, in the order they landed. */
  survivorOps: string[];
  /** Rows handed to `mutationSurvivor.createMany`. */
  survivorRows: Row[];
}

function install(): Captured {
  const captured: Captured = { resultUpdates: [], survivorOps: [], survivorRows: [] };

  const resultRow = {
    id: RESULT,
    testId: TEST,
    shardIndex: null,
    status: 'SKIPPED',
    retriedAndPassed: false,
    durationMs: 0,
    test: {
      id: TEST,
      name: 'the suite kills its mutants',
      type: 'MUTATION',
      code: '',
      filePath: 'tests/mutation.spec.ts',
      spec: { tool: 'stryker' },
      timeoutMs: 600_000,
      quarantined: false,
      quarantineExpiresAt: null,
      quarantinedAt: null,
      tags: [],
      priority: 'IMPORTANT',
      consecutiveFailures: 0,
      authProfileId: null,
      authProfileRequired: false,
    },
  };

  const run = {
    id: RUN,
    orgId: ORG,
    projectId: 'proj1',
    status: 'QUEUED',
    trigger: 'MANUAL',
    prNumber: null,
    startedAt: null,
    finishedAt: null,
    finalizedAt: null,
    totalCount: 1,
    shardCount: 1,
    baseUrlOverride: null,
    commitSha: 'abc1234',
    passedCount: 0,
    failedCount: 0,
    flakyCount: 0,
    skippedCount: 0,
    quarantinedFailedCount: 0,
    gateResult: null,
    errorMessage: null,
  };

  const resultModel = {
    findMany: async () => [
      {
        testId: TEST,
        status: resultRow.status,
        retriedAndPassed: false,
        durationMs: 10,
        test: {
          name: resultRow.test.name,
          priority: 'IMPORTANT',
          quarantined: false,
          quarantineExpiresAt: null,
        },
        verdict: null,
      },
    ],
    update: async (args: { where: { id: string }; data: Row }) => {
      captured.resultUpdates.push({ id: args.where.id, data: args.data });
      if (typeof args.data.status === 'string') resultRow.status = args.data.status;
      return {};
    },
  };

  const tx = {
    testResult: resultModel,
    step: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    finding: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    artifact: { upsert: async () => ({}) },
    /*
     * Modelled rather than stubbed to a no-op: "are the survivors REPLACED and
     * not appended" and "is the stale detail cleared when a run reports no
     * mutation data" are both questions a swallowing fake cannot answer.
     */
    mutationSurvivor: {
      deleteMany: async () => {
        captured.survivorOps.push('deleteMany');
        return { count: 0 };
      },
      createMany: async (args: { data: Row[] }) => {
        captured.survivorOps.push(`createMany:${args.data.length}`);
        captured.survivorRows.push(...args.data);
        return { count: args.data.length };
      },
    },
  };

  h.prisma = {
    run: {
      findFirst: async () => ({
        ...run,
        environment: { id: 'env1', baseUrl: 'https://staging.example.com' },
        project: {
          id: 'proj1',
          gateRules: [],
          quarantineBudgetPercent: null,
          // A connected repository, because MUTATION cannot run without one.
          repoFullName: 'acme/app',
          repoInstallationId: 99,
          defaultBranch: 'main',
        },
        results: [resultRow],
      }),
      findUnique: async () => ({ ...run }),
      updateMany: async (args: { data: Row }) => {
        Object.assign(run, args.data);
        return { count: 1 };
      },
      update: async (args: { data: Row }) => {
        Object.assign(run, args.data);
        return { ...run };
      },
    },
    testResult: resultModel,
    organization: { findUniqueOrThrow: async () => ({ plan: 'TEAM' }) },
    test: {
      findMany: async () => [],
      count: async () => 1,
      findUnique: async () => ({ consecutiveFailures: 0 }),
      update: async () => ({}),
    },
    testFlakeHistory: { findUnique: async () => null, upsert: async () => ({}) },
    pluginEnablement: { findMany: async () => [] },
    integration: { findFirst: async () => null },
    authProfile: { findFirst: async () => null, update: async () => ({}) },
    visualBaseline: { findFirst: async () => null, upsert: async () => ({}) },
    runShard: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };

  return captured;
}

/** The update that carried the result's outcome — the one `persistExecution` makes. */
function persisted(captured: Captured): Row {
  const found = captured.resultUpdates.find((u) => 'mutationScore' in u.data);
  expect(found, 'persistExecution never updated the result row').toBeTruthy();
  return found!.data;
}

const data = (over: Partial<MutationRunData> = {}): MutationRunData => ({
  score: 72.4,
  detected: 89,
  undetected: 34,
  excluded: 5,
  valid: 123,
  minScore: 60,
  passed: true,
  survivors: [],
  ...over,
});

beforeEach(() => {
  h.execution = null;
  h.log = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) The round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('a mutation run becomes queryable rows', () => {
  it('writes the score, the counts and the threshold onto the result', async () => {
    const captured = install();
    h.execution = { mutation: data() };

    await processRun({ orgId: ORG, runId: RUN });

    expect(persisted(captured)).toMatchObject({
      mutationScore: 72.4,
      mutationDetected: 89,
      mutationUndetected: 34,
      mutationExcluded: 5,
      mutationMinScore: 60,
    });
  });

  it('lands each survivor with its file and line, scoped to the org', async () => {
    const captured = install();
    h.execution = {
      mutation: data({
        survivors: [
          {
            file: 'src/cart.ts',
            line: 42,
            mutator: 'ConditionalExpression',
            detail: 'replaced with true',
            reason: 'survived',
          },
          {
            file: 'src/pricing.ts',
            line: null,
            mutator: 'ArithmeticOperator',
            detail: null,
            reason: 'no-coverage',
          },
        ],
      }),
    };

    await processRun({ orgId: ORG, runId: RUN });

    expect(captured.survivorRows).toEqual([
      {
        orgId: ORG,
        testResultId: RESULT,
        file: 'src/cart.ts',
        line: 42,
        mutator: 'ConditionalExpression',
        detail: 'replaced with true',
        reason: 'survived',
      },
      {
        orgId: ORG,
        testResultId: RESULT,
        file: 'src/pricing.ts',
        // Null, not 0. Line 0 does not exist, and a zero would send a reader to
        // the top of the file with confidence.
        line: null,
        mutator: 'ArithmeticOperator',
        detail: null,
        reason: 'no-coverage',
      },
    ]);
  });

  it('replaces the survivors rather than appending them, so a retry cannot double up', async () => {
    const captured = install();
    h.execution = {
      mutation: data({
        survivors: [
          {
            file: 'src/a.ts',
            line: 1,
            mutator: 'BooleanLiteral',
            detail: null,
            reason: 'survived',
          },
        ],
      }),
    };

    await processRun({ orgId: ORG, runId: RUN });

    // The delete has to come FIRST. The other order appends to whatever the
    // previous attempt at this job left behind.
    expect(captured.survivorOps).toEqual(['deleteMany', 'createMany:1']);
  });

  it('stores at most MAX_PERSISTED_SURVIVORS rows while keeping the count exact', async () => {
    const captured = install();
    const many = Array.from({ length: MAX_PERSISTED_SURVIVORS + 100 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      mutator: 'ArithmeticOperator',
      detail: null,
      reason: 'survived' as const,
    }));
    h.execution = { mutation: data({ undetected: many.length, survivors: many }) };

    await processRun({ orgId: ORG, runId: RUN });

    expect(captured.survivorRows).toHaveLength(MAX_PERSISTED_SURVIVORS);
    // The cap truncates the LIST, never the ARITHMETIC. A cap that also reduced
    // the count would be the storage layer quietly improving a mutation score.
    expect(persisted(captured).mutationUndetected).toBe(many.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Null is not zero
// ─────────────────────────────────────────────────────────────────────────────

describe('a run that measured nothing says so with NULL and never with 0', () => {
  it('writes all five columns as present-and-null when no plugin reported mutation data', async () => {
    const captured = install();
    h.execution = null; // an ordinary E2E-shaped execution: no `mutation` field

    await processRun({ orgId: ORG, runId: RUN });

    const row = persisted(captured);
    // PRESENT, so a re-run clears a previous score rather than leaving it
    // sitting on a result whose plugin reported nothing this time. Prisma reads
    // an absent key as "leave the column alone".
    for (const column of [
      'mutationScore',
      'mutationDetected',
      'mutationUndetected',
      'mutationExcluded',
      'mutationMinScore',
    ]) {
      expect(Object.keys(row), `${column} was omitted from the update`).toContain(column);
      expect(row[column], `${column} was not null`).toBeNull();
    }
    // Said twice on purpose: `toBeNull` would pass for undefined under a
    // loosely typed fake, and 0 is the value that inverts the signal.
    expect(row.mutationScore).not.toBe(0);
  });

  it('still clears stale survivor rows, so detail cannot outlive the number', async () => {
    const captured = install();
    h.execution = null;

    await processRun({ orgId: ORG, runId: RUN });

    // No createMany, but the delete must still have run: otherwise a result
    // whose MUTATION test stopped reporting keeps serving last week's survivors
    // next to a NULL score.
    expect(captured.survivorOps).toEqual(['deleteMany']);
    expect(captured.survivorRows).toEqual([]);
  });

  it('stores a genuine score of 0, distinguishably from absent', async () => {
    const captured = install();
    h.execution = {
      mutation: data({ score: 0, detected: 0, undetected: 123, valid: 123, passed: false }),
    };

    await processRun({ orgId: ORG, runId: RUN });

    const row = persisted(captured);
    // The worst possible result, and it has to read as a result. `toBe(0)`
    // rather than a falsy check: null is falsy too, and the whole point is that
    // these two are not the same row.
    expect(row.mutationScore).toBe(0);
    expect(row.mutationScore).not.toBeNull();
    expect(row.mutationDetected).toBe(0);
    expect(row.mutationUndetected).toBe(123);
  });

  it('keeps "ran but nothing valid to judge" distinct from both', async () => {
    const captured = install();
    // Every mutant failed to build. The tool ran, there was no denominator, and
    // the score is unknowable — which is neither "not measured" nor 0.
    h.execution = {
      mutation: data({
        score: null,
        detected: 0,
        undetected: 0,
        excluded: 12,
        valid: 0,
        passed: false,
      }),
    };

    await processRun({ orgId: ORG, runId: RUN });

    const row = persisted(captured);
    expect(row.mutationScore).toBeNull();
    // The counts are measured facts and are kept: `excluded: 12, score: null`
    // says "twelve mutants, none of them buildable", which an all-null row
    // cannot say.
    expect(row.mutationDetected).toBe(0);
    expect(row.mutationExcluded).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) The rule as a pure function
// ─────────────────────────────────────────────────────────────────────────────

describe('mutationColumns', () => {
  it('returns every column as null for absent data', () => {
    for (const absent of [null, undefined]) {
      expect(mutationColumns(absent)).toEqual({
        mutationScore: null,
        mutationDetected: null,
        mutationUndetected: null,
        mutationExcluded: null,
        mutationMinScore: null,
      });
    }
  });

  it('passes a zero score through as zero', () => {
    expect(mutationColumns(data({ score: 0, detected: 0, undetected: 10 }))).toEqual({
      mutationScore: 0,
      mutationDetected: 0,
      mutationUndetected: 10,
      mutationExcluded: 5,
      mutationMinScore: 60,
    });
  });

  it('never invents a score for a run with no valid mutant', () => {
    expect(
      mutationColumns(data({ score: null, detected: 0, undetected: 0, excluded: 3 })).mutationScore,
    ).toBeNull();
  });
});
