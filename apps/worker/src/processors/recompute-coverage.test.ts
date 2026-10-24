/**
 * Tests for the coverage recompute trigger and processor.
 *
 * Written around the ways this can be WRONG rather than around its lines,
 * because every one of them is a way the product lies rather than a way it
 * crashes:
 *
 *   • a 20-shard run writing 20 snapshot rows, so the trend the CI gate reads
 *     is a stack of duplicates and its delta means nothing;
 *   • two different projects coalescing onto one job, so one project's number
 *     silently never updates;
 *   • a job id retained after a failure, which freezes a project's number
 *     forever with no error anywhere;
 *   • a recompute that throws taking a finished run down with it;
 *   • an empty denominator reported as 0%, a written-but-never-run test counted
 *     as covered, an UNKNOWN item called a gap, an axis we do not measure
 *     scored at zero, or the caveats dropped — the five rules, each of which is
 *     a sentence the product must never be caught saying.
 *
 * The computation itself (`computeCoverage`) is injected. It opens Postgres on
 * import and is proven in apps/api; a unit test that loads it is an integration
 * test wearing a disguise.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceKind, SurfaceSnapshot, SurfaceSnapshotTotals } from '@qaai/shared';
// Type-only, so this test never loads the API module the processor defers.
import type { ComputeOptions } from '../../../api/src/lib/coverage-store.js';

// The worker's context opens Postgres, Redis and the LLM at import time, so it
// is replaced wholesale; `h.prisma` and `h.log` are read per test.
const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    log: Array<{ level: string; msg: string; obj: unknown }>;
    queueAdds: Array<{ queue: string; name: string; data: unknown; opts: Record<string, unknown> }>;
    addThrows: Error | null;
  } => ({ prisma: {}, log: [], queueAdds: [], addThrows: null }),
);

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    config: {},
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  };
});

// A Queue stand-in that records every add() with its options, so the coalescing
// test can assert the one fact BullMQ's dedupe rests on: a stable job id.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(
      public queueName: string,
      _opts: unknown,
    ) {}
    async add(name: string, data: unknown, opts: Record<string, unknown>): Promise<{ id: string }> {
      if (h.addThrows) throw h.addThrows;
      h.queueAdds.push({ queue: this.queueName, name, data, opts });
      return { id: typeof opts.jobId === 'string' ? opts.jobId : name };
    }
    async close(): Promise<void> {}
  },
}));

const {
  RECOMPUTE_ATTEMPTS,
  apiEnvGap,
  RECOMPUTE_COVERAGE_QUEUE,
  RECOMPUTE_WINDOW_MS,
  _resetComputeCache,
  describeSnapshot,
  enqueueRecomputeCoverage,
  processRecomputeCoverage,
  recomputeJobId,
  recomputeJobOptions,
  requestRecompute,
} = await import('./recompute-coverage.js');

type Totals = Partial<SurfaceSnapshotTotals>;

function totals(over: Totals = {}): SurfaceSnapshotTotals {
  return {
    percent: 50,
    denominator: 10,
    covered: 5,
    assertedNotRun: 2,
    uncovered: 3,
    unknown: 0,
    waived: 0,
    byKind: [],
    declaredNeverReached: 0,
    reachedNeverDeclared: 0,
    ...over,
  };
}

function snapshot(over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    id: 'snap_1',
    projectId: 'proj_1',
    createdAtIso: '2026-10-23T00:00:00.000Z',
    commitSha: null,
    totals: totals(),
    inputs: { analysisId: null, flowMapVersion: null, testCount: 0, runId: null },
    caveats: [],
    fingerprint: 'abc.def',
    ...over,
  };
}

/** A stub `computeCoverage` that records what it was asked for. */
function stubCompute(result?: {
  snapshot?: SurfaceSnapshot;
  unmeasuredKinds?: SurfaceKind[];
  snapshotId?: string | null;
}) {
  const calls: ComputeOptions[] = [];
  const compute = vi.fn(async (options: ComputeOptions) => {
    calls.push(options);
    return {
      entries: [],
      uncovered: [],
      snapshot: result?.snapshot ?? snapshot(),
      unmeasuredKinds: result?.unmeasuredKinds ?? [],
      snapshotId: result?.snapshotId ?? 'snap_1',
    };
  });
  return { compute, calls };
}

beforeEach(() => {
  h.prisma = {};
  h.log = [];
  h.queueAdds = [];
  h.addThrows = null;
  _resetComputeCache();
});

// ─── Coalescing: one write per project per window ────────────────────────────

describe('coalescing by project', () => {
  it('gives every trigger for one project the same job id, so BullMQ keeps one', async () => {
    const ids = new Set([
      recomputeJobId('proj_1'),
      recomputeJobId('proj_1'),
      recomputeJobId('proj_1'),
    ]);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe('recompute-coverage-proj_1');
  });

  it('does NOT coalesce two different projects', () => {
    expect(recomputeJobId('proj_1')).not.toBe(recomputeJobId('proj_2'));
  });

  it('keys on the project alone — not the reason, the run or the commit', async () => {
    await requestRecompute({ reason: 'crawl', orgId: 'org_1', projectId: 'proj_1' });
    await requestRecompute({ reason: 'tests-changed', orgId: 'org_1', projectId: 'proj_1' });
    h.prisma = {
      run: { findFirst: async () => ({ projectId: 'proj_1', commitSha: 'deadbee' }) },
    };
    await requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_1' });

    expect(h.queueAdds).toHaveLength(3);
    expect(new Set(h.queueAdds.map((a) => a.opts.jobId))).toEqual(
      new Set(['recompute-coverage-proj_1']),
    );
    // All three landed on the queue index.ts registers a consumer for.
    expect(new Set(h.queueAdds.map((a) => a.queue))).toEqual(new Set([RECOMPUTE_COVERAGE_QUEUE]));
  });

  it('collapses a 20-shard run onto one job id', async () => {
    h.prisma = {
      run: { findFirst: async () => ({ projectId: 'proj_1', commitSha: 'c0ffee1' }) },
    };
    for (let shard = 0; shard < 20; shard += 1) {
      await requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_1' });
    }
    expect(h.queueAdds).toHaveLength(20);
    expect(new Set(h.queueAdds.map((a) => a.opts.jobId)).size).toBe(1);
  });

  it('delays the job, which is what makes the window a window', async () => {
    await enqueueRecomputeCoverage({ orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' });
    expect(h.queueAdds[0]?.opts.delay).toBe(RECOMPUTE_WINDOW_MS);
    expect(RECOMPUTE_WINDOW_MS).toBeGreaterThan(0);
  });

  /*
   * The trap this guards: a job id is a Redis key. A completed — or FAILED —
   * job retained under `recompute-coverage-<projectId>` means every later add()
   * for that project collapses onto the corpse and the number freezes with no
   * error logged anywhere.
   */
  it('removes the job on completion AND on failure, so the key never blocks the next window', () => {
    const opts = recomputeJobOptions('proj_1');
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  it('retries, which is only safe because the snapshot row is written last', () => {
    expect(recomputeJobOptions('proj_1').attempts).toBe(RECOMPUTE_ATTEMPTS);
    expect(RECOMPUTE_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
});

// ─── Resolving a run into a project ──────────────────────────────────────────

describe('the run trigger', () => {
  it('resolves the project and the commit from the run row', async () => {
    h.prisma = {
      run: { findFirst: async () => ({ projectId: 'proj_7', commitSha: 'abc1234' }) },
    };
    const job = await requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_9' });
    expect(job).toEqual({
      orgId: 'org_1',
      projectId: 'proj_7',
      reason: 'run',
      commitSha: 'abc1234',
      runId: 'run_9',
    });
    // The commit travels so the stored snapshot can say what it measured.
    expect(h.queueAdds[0]?.data).toMatchObject({ commitSha: 'abc1234', runId: 'run_9' });
  });

  it('reads the run scoped by org — the worker drains every tenant', async () => {
    const seen: Array<Record<string, unknown>> = [];
    h.prisma = {
      run: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          seen.push(args.where);
          return { projectId: 'proj_7', commitSha: null };
        },
      },
    };
    await requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_9' });
    expect(seen[0]).toEqual({ id: 'run_9', orgId: 'org_1' });
  });

  it('skips quietly when the run row is gone, instead of enqueuing a projectless job', async () => {
    h.prisma = { run: { findFirst: async () => null } };
    const job = await requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_9' });
    expect(job).toBeNull();
    expect(h.queueAdds).toHaveLength(0);
    expect(h.log.some((l) => l.level === 'warn')).toBe(true);
  });
});

// ─── A recompute must never cost a run its result ────────────────────────────

describe('requestRecompute never throws', () => {
  it('swallows a producer failure and says the number is now stale', async () => {
    h.addThrows = new Error('Redis is down');
    const job = await requestRecompute({ reason: 'crawl', orgId: 'org_1', projectId: 'proj_1' });
    expect(job).toBeNull();
    const line = h.log.find((l) => l.level === 'error');
    expect(line?.msg).toMatch(/stale/);
  });

  it('swallows a database failure while resolving a run', async () => {
    h.prisma = {
      run: {
        findFirst: async () => {
          throw new Error('connection terminated');
        },
      },
    };
    await expect(
      requestRecompute({ reason: 'run', orgId: 'org_1', runId: 'run_9' }),
    ).resolves.toBeNull();
    expect(h.log.some((l) => l.level === 'error')).toBe(true);
  });
});

// ─── The processor ───────────────────────────────────────────────────────────

describe('processRecomputeCoverage', () => {
  it('PERSISTS — the whole point of the job is that a trend exists', async () => {
    const { compute, calls } = stubCompute();
    await processRecomputeCoverage(
      { orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' },
      { compute },
    );
    expect(calls[0]).toMatchObject({ orgId: 'org_1', projectId: 'proj_1', persist: true });
  });

  it('carries the commit and run through to the snapshot inputs', async () => {
    const { compute, calls } = stubCompute();
    await processRecomputeCoverage(
      {
        orgId: 'org_1',
        projectId: 'proj_1',
        reason: 'run',
        commitSha: 'abc1234',
        runId: 'run_9',
      },
      { compute },
    );
    expect(calls[0]).toMatchObject({ commitSha: 'abc1234', runId: 'run_9' });
  });

  it('normalises a missing commit to null rather than undefined', async () => {
    const { compute, calls } = stubCompute();
    await processRecomputeCoverage(
      { orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' },
      { compute },
    );
    expect(calls[0]?.commitSha).toBeNull();
    expect(calls[0]?.runId).toBeNull();
  });

  /*
   * A project with no source analysis and no crawl has nothing to measure. That
   * is a valid state, not a failure: the job must resolve, and it must report a
   * null percentage rather than inventing a zero.
   */
  it('does not fail a project with nothing to measure', async () => {
    const { compute } = stubCompute({
      snapshot: snapshot({
        totals: totals({
          percent: null,
          denominator: 0,
          covered: 0,
          assertedNotRun: 0,
          uncovered: 0,
        }),
      }),
    });
    const outcome = await processRecomputeCoverage(
      { orgId: 'org_1', projectId: 'proj_1', reason: 'source-analysis' },
      { compute },
    );
    expect(outcome.percent).toBeNull();
    expect(outcome.denominator).toBe(0);
    expect(outcome.headline).toMatch(/not measured yet/);
  });

  it('propagates a failed computation, so BullMQ records it instead of logging a success', async () => {
    const compute = vi.fn((_options: ComputeOptions) =>
      Promise.reject(new Error('inventory read failed')),
    );
    await expect(
      processRecomputeCoverage(
        { orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' },
        { compute },
      ),
    ).rejects.toThrow('inventory read failed');
    // And nothing claimed a number was computed.
    expect(h.log.some((l) => l.msg === 'coverage recomputed')).toBe(false);
  });

  it('reports every state separately in the log line it writes', async () => {
    const { compute } = stubCompute({
      snapshot: snapshot({
        totals: totals({
          percent: 40,
          denominator: 10,
          covered: 4,
          assertedNotRun: 3,
          uncovered: 2,
          unknown: 1,
        }),
        caveats: ['the crawl stopped at 60 pages'],
      }),
      unmeasuredKinds: ['COMPONENT_STATE'] as SurfaceKind[],
    });
    await processRecomputeCoverage(
      { orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' },
      { compute },
    );
    const line = h.log.find((l) => l.msg === 'coverage recomputed');
    expect(line).toBeDefined();
    expect(line?.obj).toMatchObject({
      percent: 40,
      covered: 4,
      assertedNotRun: 3,
      uncovered: 2,
      unknown: 1,
      caveats: ['the crawl stopped at 60 pages'],
      unmeasuredKinds: ['COMPONENT_STATE'],
    });
  });
});

// ─── The five rules, as the log line states them ─────────────────────────────

describe('describeSnapshot honours the five rules', () => {
  it('rule 1: an empty denominator is "not measured yet", never 0% and never 100%', () => {
    const line = describeSnapshot(
      snapshot({
        totals: totals({
          percent: null,
          denominator: 0,
          covered: 0,
          assertedNotRun: 0,
          uncovered: 0,
        }),
      }),
      [],
    );
    expect(line).toMatch(/not measured yet/);
    expect(line).not.toMatch(/\b0%/);
    expect(line).not.toMatch(/\b100%/);
  });

  it('rule 1, the other empty denominator: everything waived says so', () => {
    const line = describeSnapshot(
      snapshot({
        totals: totals({
          percent: null,
          denominator: 0,
          covered: 0,
          assertedNotRun: 0,
          uncovered: 0,
          waived: 4,
        }),
      }),
      [],
    );
    expect(line).toMatch(/not measured yet/);
    expect(line).toMatch(/waived/);
  });

  it('rule 2: ASSERTED_NOT_RUN gets its own count and is not folded into covered', () => {
    const line = describeSnapshot(
      snapshot({ totals: totals({ covered: 5, assertedNotRun: 7 }) }),
      [],
    );
    expect(line).toMatch(/5 covered/);
    expect(line).toMatch(/7 asserted-but-never-run/);
    expect(line).not.toMatch(/12 covered/);
  });

  it('rule 3: UNKNOWN is reported apart from uncovered, and labelled not-a-gap', () => {
    const line = describeSnapshot(snapshot({ totals: totals({ uncovered: 3, unknown: 4 }) }), []);
    expect(line).toMatch(/3 uncovered/);
    expect(line).toMatch(/4 unknown \(not a gap\)/);
    expect(line).not.toMatch(/7 uncovered/);
  });

  it('rule 4: an unmeasured axis is NAMED, not scored at zero', () => {
    const line = describeSnapshot(snapshot(), [
      'COMPONENT_STATE',
      'BACKGROUND_JOB',
    ] as SurfaceKind[]);
    expect(line).toMatch(/COMPONENT_STATE/);
    expect(line).toMatch(/BACKGROUND_JOB/);
    expect(line).toMatch(/not measured at all/);
    // No axis is handed a score. `\b0%` rather than `0%` so the headline's own
    // "50%" cannot satisfy the assertion by accident.
    expect(line).not.toMatch(/\b0%/);
    // And no percentage is printed anywhere in the axes clause.
    expect(/axis\/axes not measured at all: [^·]*%/.test(line)).toBe(false);
  });

  it('rule 5: caveats are carried in full, not counted and not dropped', () => {
    const caveats = [
      'the crawl stopped at 60 pages',
      'no source analysis has been stored for this project',
    ];
    const line = describeSnapshot(snapshot({ caveats }), []);
    for (const caveat of caveats) expect(line).toContain(caveat);
  });

  it('says so when there are no caveats, rather than leaving the reader to assume', () => {
    expect(describeSnapshot(snapshot({ caveats: [] }), [])).toMatch(/no caveats recorded/);
  });

  it('prints a real percentage with its denominator, so the division is checkable', () => {
    const line = describeSnapshot(
      snapshot({ totals: totals({ percent: 42.9, denominator: 14, covered: 6 }) }),
      [],
    );
    expect(line).toMatch(/42\.9% of 14 measured surface item\(s\) covered/);
  });
});

// ─── The guard on the deferred import ────────────────────────────────────────

/*
 * Importing the computation pulls in apps/api/src/env.ts, which calls
 * process.exit(1) on a bad env. A worker deployment that was never given
 * SESSION_SECRET would therefore DISAPPEAR on its first recompute, taking every
 * in-flight run in every org with it — caused by a variable the worker has
 * never otherwise needed. These assert the pre-flight that turns that into a
 * failed job.
 */
describe('apiEnvGap', () => {
  const key32 = Buffer.alloc(32, 7).toString('base64');

  it('names SESSION_SECRET when it is missing', () => {
    expect(apiEnvGap({ VAULT_MASTER_KEY: key32 })).toMatch(/SESSION_SECRET/);
  });

  it('names SESSION_SECRET when it is present but too short for the API schema', () => {
    expect(apiEnvGap({ SESSION_SECRET: 'short', VAULT_MASTER_KEY: key32 })).toMatch(
      /SESSION_SECRET/,
    );
  });

  /*
   * The worker's own context.ts only checks that VAULT_MASTER_KEY is non-empty,
   * so a value that boots the worker can still exit the API's parser. That
   * asymmetry is the whole reason this case is checked rather than assumed.
   */
  it('names VAULT_MASTER_KEY when it is not 32 bytes of base64', () => {
    expect(apiEnvGap({ SESSION_SECRET: 'x'.repeat(32), VAULT_MASTER_KEY: 'nope' })).toMatch(
      /VAULT_MASTER_KEY/,
    );
  });

  it('allows the import when both are satisfied', () => {
    expect(apiEnvGap({ SESSION_SECRET: 'x'.repeat(32), VAULT_MASTER_KEY: key32 })).toBeNull();
  });

  it('refuses an empty environment rather than letting the import decide', () => {
    expect(apiEnvGap({})).not.toBeNull();
  });
});

// ─── The queue name the consumer registers for ──────────────────────────────

describe('wiring', () => {
  /*
   * check:wiring reads these two literals out of the source and fails if the
   * producer and the consumer disagree. This asserts the same thing in the unit
   * suite, where it fails in a second instead of in CI.
   */
  it('matches the literal apps/worker/src/index.ts registers a consumer for', () => {
    expect(RECOMPUTE_COVERAGE_QUEUE).toBe('qaai.recompute-coverage');
  });

  it('enqueues onto that queue under that name', async () => {
    await enqueueRecomputeCoverage({ orgId: 'org_1', projectId: 'proj_1', reason: 'crawl' });
    expect(h.queueAdds[0]).toMatchObject({
      queue: 'qaai.recompute-coverage',
      name: 'qaai.recompute-coverage',
    });
  });
});
