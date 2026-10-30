/**
 * Runs (§5) — enqueue, read, stream, and the artifact endpoint the cockpit's
 * screenshots and trace viewer load from.
 *
 * POST /runs also decides how much of a suite a run has to execute. Three
 * optional inputs, all off unless asked for, all reasoned about in
 * lib/run-selection.ts and all reported back in the response:
 *
 *   changedPaths  select the tests the diff can reach (lib/impact.ts)
 *   useCache      report which of the skipped tests have a recent clean pass
 *   failFast      stop at the first real failure — now RECORDED on the run row,
 *                 and still not enforced by the run loop. See FAIL_FAST_NOTE.
 *
 * Nothing about the default path changed: a POST that asks for none of them
 * loads the same column, queues the same job and executes the same suite it
 * always has.
 *
 * POST /runs/:runId/rerun-failures is the fourth thing here, and it is the one
 * that makes the other three usable on a real suite: re-running 5,000 tests to
 * re-check the 6 that failed is the reason nobody uses a re-run button twice.
 *
 * WHERE a run executes is decided here too, and it is a branch rather than an
 * option: `Environment.runnerPool` set means the suite is handed to the
 * customer's own agents (lib/runners.ts) and NOTHING is enqueued on our queue;
 * null means the queue, exactly as before. `Run.runnerPool` records which, and
 * it is what stops a run being executed twice, once in each place.
 *
 * ── THREE COLUMNS THAT HAD READERS AND NO WRITER ───────────────────────────
 *
 * `POST /runs` now writes `Run.branch`, `Run.baseUrlOverride` and
 * `Run.selectionSource`. All three had columns, all three had readers, and no
 * create path wrote any of them — so `--branch` and `--base-url` worked on NO
 * SERVER THAT EXISTS (a zod object ignores unknown keys, so both were accepted
 * and dropped, and the CLI read them back off the created run and exited 2
 * rather than report a target the run never used), and a gate had nothing to
 * consult when it was asked whether a 100% pass rate was a claim about the
 * suite or about eleven tests.
 *
 * `baseUrlOverride` decides which host a browser inside QAAI's network opens,
 * so it is classified before it is stored (`checkBaseUrlOverride`), and
 * `selectionSource` may be DECLARED by a caller but only ever NARROWER than
 * what this route works out for itself (`resolveSelectionSource`).
 *
 * ── AND THE LEDGER THE READER COULD NOT SEE ────────────────────────────────
 *
 * `GET /runs/:runId` reports the cross-kind suppression ledger —
 * "47 failures silenced by 3 known issues" — which the CLI's `--suppressions`
 * has been ready to print for a release and had no source for. It is folded
 * from `SuppressionEvent`, the cap is disclosed when it bites, and quarantine
 * is synthesised from the run's own counter rather than counted twice.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  FIXTURE_PREFIX,
  QUEUE_NAMES,
  RUN_SELECTION_SOURCES,
  SUITE_WIDE_SELECTIONS,
  SUPPRESSION_LEDGER_SCAN_CAP,
  createRunSchema,
  summariseSuppressions,
} from '@qaai/shared';
/*
 * The SYNCHRONOUS half of the host guard, imported through the package SUBPATH
 * and never the barrel: private-address.ts reaches for `node:dns` and the
 * barrel is what the web app's bundler consumes.
 *
 * `resolvesPublicly` is deliberately NOT imported. It needs DNS, and a name
 * this process resolves is not the name the browser will resolve — so the
 * resolving check belongs where the connection is opened
 * (`guardProbeHost`/`environmentPreflight`, packages/runner/src/preflight.ts),
 * and this route must not be described as having done it.
 */
import { classifyHost } from '@qaai/shared/private-address';
/*
 * The one definition of "did this run pass" (packages/runner/src/gates.ts).
 * This route is the CLI's only source for it: the CLI ships zero dependencies
 * on purpose and cannot import the module, so it reads the answer off the
 * response instead of computing a copy of it. See `runVerdict` below.
 */
import { quarantineSuppresses, runOutcome } from '@qaai/runner';
import type {
  RunSelectionSource,
  ShardAssignment,
  ShardPlan,
  ShardedRunJob,
  SuppressionKind,
  SuppressionTally,
  TestType,
} from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound, planLimit, unprocessable } from '../lib/errors.js';
import { canStartRun, planFor } from '../lib/plan.js';
import { startRun } from '../lib/start-run.js';
import {
  assessPool,
  createRunnerJobs,
  describeDispatch,
  requirementsForTests,
} from '../lib/runners.js';
import type { RunnerSlice } from '../lib/runners.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { storage } from '../lib/storage.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import { env } from '../env.js';
import { MAX_CHANGED_PATHS } from '../lib/impact.js';
import {
  MAX_CACHE_CANDIDATES,
  MAX_REPORTED_DECISIONS,
  cacheWindowMs,
  describeSelection,
  groupPriorsByTest,
  planCacheReuse,
  planFailFast,
  selectTestsForRun,
} from '../lib/run-selection.js';
import type {
  CacheCandidate,
  CacheDecision,
  PriorPass,
  SelectionReport,
  SelectionResult,
} from '../lib/run-selection.js';

export const runsRouter: Router = Router();

runsRouter.use(requireAuth);

// ─── Build sharding (§5) ─────────────────────────────────────────────────────

/**
 * How many recent results per test to average. Five is enough to smooth a
 * single slow run without dragging in timings from before a rewrite.
 */
const RECENT_RESULTS_PER_TEST = 5;

/**
 * What a test with no timing history is assumed to cost when the suite has no
 * history at all. Only reached on a project's very first sharded run; once any
 * result exists the median of the known tests is a far better guess than a
 * constant, because it is drawn from this suite rather than from an average of
 * every suite in the world.
 */
const UNKNOWN_TEST_COST_MS = 30_000;

/**
 * Recent per-test duration, in ms, for the tests about to run.
 *
 * The query takes the most recent `tests × 5` results rather than five per test,
 * because Prisma cannot limit per group without raw SQL. That approximation is
 * sound here for a specific reason: results are written a whole run at a time,
 * so ordering by `createdAt desc` walks backwards run by run and the window
 * lands on roughly the last five runs of this suite — which is exactly the
 * window wanted. A test that was recently added simply has fewer samples, and a
 * test with none falls back to the median below.
 */
async function recentDurations(testIds: string[]): Promise<Map<string, number>> {
  const rows = await prisma.testResult.findMany({
    where: {
      testId: { in: testIds },
      // Placeholder rows are created up front with durationMs 0; counting them
      // would tell the packer every test is free.
      durationMs: { gt: 0 },
    },
    orderBy: { createdAt: 'desc' },
    take: testIds.length * RECENT_RESULTS_PER_TEST,
    select: { testId: true, durationMs: true },
  });

  const samples = new Map<string, number[]>();
  for (const row of rows) {
    const list = samples.get(row.testId) ?? [];
    if (list.length < RECENT_RESULTS_PER_TEST) list.push(row.durationMs);
    samples.set(row.testId, list);
  }

  const means = new Map<string, number>();
  for (const [testId, list] of samples) {
    means.set(testId, Math.round(list.reduce((a, b) => a + b, 0) / list.length));
  }
  return means;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Split tests across shards so every shard takes about the same wall clock.
 *
 * Longest-processing-time-first: sort by estimated cost descending, then hand
 * each test to whichever shard is currently least loaded. Round-robin — the
 * obvious alternative — balances *counts*, and a suite is never uniform: one
 * 12-minute journey test and thirty 4-second smoke tests round-robined across
 * four shards gives three shards that finish in half a minute and one that
 * takes twelve, so the run still takes twelve. LPT puts the long test down
 * first and fills the gaps around it. It is within 4/3 of optimal, which is as
 * good as this needs to be.
 *
 * Ties break on test id so the same suite splits the same way twice — a run
 * that shards differently every time is one nobody can reason about.
 */
export function packShards(
  testIds: string[],
  costs: Map<string, number>,
  shardCount: number,
  fallbackCostMs: number,
): ShardAssignment[] {
  const shards: ShardAssignment[] = Array.from({ length: shardCount }, (_, index) => ({
    index,
    testIds: [],
    estimatedMs: 0,
  }));

  const ordered = [...testIds].sort((a, b) => {
    const diff = (costs.get(b) ?? fallbackCostMs) - (costs.get(a) ?? fallbackCostMs);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  for (const testId of ordered) {
    let lightest = shards[0]!;
    for (const shard of shards) {
      if (shard.estimatedMs < lightest.estimatedMs) lightest = shard;
    }
    lightest.testIds.push(testId);
    lightest.estimatedMs += costs.get(testId) ?? fallbackCostMs;
  }

  return shards;
}

/**
 * Decide the split for this run, clamped to what the org is actually entitled
 * to. `PLAN_LIMITS.maxParallelWorkers` is the number printed on the pricing
 * page; this is the one place it turns into behaviour.
 */
async function planShards(orgId: string, testIds: string[], requested: number): Promise<ShardPlan> {
  const { limits } = await planFor(orgId);
  const max = limits.maxParallelWorkers;

  // Never more shards than tests: an empty shard is a queue job, a worker slot
  // and a database row that exist to run nothing.
  const granted = Math.max(1, Math.min(requested, max, testIds.length));
  const cappedBy = granted < requested ? (max < requested ? 'plan' : 'tests') : null;

  // Clamped down to one — a free-plan org asking for five. Say so in the
  // response rather than sharding silently-not-at-all; `assignments` is empty
  // because nothing was split, and the run takes the ordinary single-job path.
  if (granted < 2) {
    return {
      requested,
      granted,
      cappedBy,
      maxParallelWorkers: max,
      assignments: [],
      testsWithHistory: 0,
    };
  }

  const costs = await recentDurations(testIds);
  const fallback = median([...costs.values()]) ?? UNKNOWN_TEST_COST_MS;

  return {
    requested,
    granted,
    cappedBy,
    maxParallelWorkers: max,
    assignments: packShards(testIds, costs, granted, fallback),
    testsWithHistory: testIds.filter((id) => costs.has(id)).length,
  };
}

// ─── Result caching (§5) ─────────────────────────────────────────────────────

/** Everything the selection and the cache need to read off a test row. */
interface DetailedTest {
  id: string;
  name: string;
  filePath: string;
  code: string;
  spec: unknown;
  tags: string[];
  feature: string | null;
  priority: 'CRITICAL_PATH' | 'IMPORTANT' | 'NICE_TO_HAVE';
  type: string;
  quarantined: boolean;
}

interface CacheReport {
  requested: boolean;
  /**
   * Whether reuse changed what this run executes. Always false today, and named
   * so that nobody has to infer it — see `note`.
   */
  changesThisRun: boolean;
  windowHours: number;
  considered: number;
  reusable: number;
  note: string;
  results: CacheDecision[];
  resultsTruncated: number;
}

/**
 * Why a cache hit does not (yet) shorten a run.
 *
 * Reuse is only ever offered for a test the diff cannot reach, which is a test
 * impact analysis has already excluded — so the executed set is identical with
 * and without `useCache`, and turning the cache on cannot make this run skip
 * anything it would otherwise have done. What it adds is evidence: "these 31
 * tests are not running AND were green an hour ago on this exact code" is a
 * different claim from "these 31 tests are not running".
 *
 * Presenting that pass as a result OF THIS RUN — a green row in the cockpit, a
 * pass the gate counts — is the part that needs storage: `TestResult.cacheKey`
 * to make the match authoritative instead of reconstructed, and a
 * `reusedFromResultId` so no view can ever render a cached pass as a fresh one.
 * Both are columns, and columns are not this change's to add.
 */
const CACHE_EFFECT_NOTE =
  'Reuse applies only to tests the change cannot reach, which are already excluded from this run — so this did not shorten the run, it recorded what is known about the tests being skipped. Counting a reused pass as a result of this run needs TestResult.cacheKey and a reused-from marker, so that no view can show a cached pass as a fresh one.';

/**
 * What `failFast: true` now does, and what it still does not.
 *
 * It is RECORDED: `Run.failFast` is written from this endpoint, which nothing
 * in the codebase did until now — the column, its migration, the stop endpoint
 * (POST /team/runs/:runId/stop) and the two columns it writes all existed, and
 * the flag that was supposed to arm them was dropped on the floor at the moment
 * the run row was created. So the promise was broken one step earlier than
 * anybody was looking.
 *
 * With the column written, the worker's 60-second sweep
 * (`sweepFailFastStops` in apps/worker/src/processors/schedule.ts) finds a
 * fail-fast run that has already had a real failure and writes
 * `stopRequestedAt` / `stopReason` — the same columns, with the same
 * first-writer-wins UPDATE, that a human pressing stop writes.
 *
 * WHAT IS STILL MISSING, stated here rather than discovered from a run that
 * kept going: the between-tests poll in apps/worker/src/processors/run.ts reads
 * `status` and `finalizedAt` and not `stopRequestedAt`, so the stop request is
 * written and not yet obeyed. `planFailFast` therefore still reports
 * `enforced: false`, and this note travels with it. Accepting a flag and
 * silently doing nothing is how a caller comes to believe their runs stop early
 * when every one of them has been running to the end; saying exactly which half
 * works is the only honest shape while the other half is in another file.
 */
const FAIL_FAST_NOTE =
  'Recorded on the run (Run.failFast), which is new — nothing wrote that column before, so the flag could not have been honoured by anything. The worker sweep now writes Run.stopRequestedAt and Run.stopReason at the first real failure of a fail-fast run, and the run page, the share page and the audit row all render them. The run loop itself does not yet READ stopRequestedAt between tests, so this run will still execute every selected test; `enforced` stays false until that poll in apps/worker/src/processors/run.ts reads the column alongside the cancellation check it already makes.';

/**
 * Which of the skipped tests have a recent clean pass we can stand behind.
 *
 * Two extra queries, both bounded and both only issued when a caller asked for
 * this. The lookup is deliberately narrow: same environment, a run that actually
 * reported, a pass that was not a retry, inside the window.
 */
async function evaluateResultCache(args: {
  selection: SelectionResult | null;
  detailed: DetailedTest[];
  environment: { id: string; baseUrl: string; updatedAt: Date };
  windowHours: number | null | undefined;
}): Promise<CacheReport> {
  const windowMs = cacheWindowMs(args.windowHours);
  const windowHours = Math.round(windowMs / 3_600_000);

  const inert = (note: string): CacheReport => ({
    requested: true,
    changesThisRun: false,
    windowHours,
    considered: 0,
    reusable: 0,
    note,
    results: [],
    resultsTruncated: 0,
  });

  if (!args.selection) {
    return inert(
      'Caching needs `changedPaths`. A previous pass can only stand in for a test the change cannot reach, and with no diff there is no way to know which tests those are, so nothing was reused.',
    );
  }

  const skipped = args.selection.analysis.skip;
  if (skipped.length === 0) {
    return inert(
      `Impact analysis skipped nothing (${args.selection.analysis.reason}), so there was no test a cached pass could speak for.`,
    );
  }
  if (skipped.length > MAX_CACHE_CANDIDATES) {
    // Declining costs nothing: these tests are excluded from the run either way.
    return inert(
      `${skipped.length} skipped tests is past the ${MAX_CACHE_CANDIDATES}-test lookup limit, so no cached evidence was gathered. The tests are excluded from this run regardless — that decision came from impact analysis, not from here.`,
    );
  }

  const byId = new Map(args.detailed.map((test) => [test.id, test]));
  const candidates: CacheCandidate[] = [];
  for (const decision of skipped) {
    const test = byId.get(decision.testId);
    if (!test) continue;
    candidates.push({
      testId: test.id,
      name: test.name,
      testType: test.type,
      code: test.code,
      spec: test.spec,
      quarantined: test.quarantined,
      impactDecision: 'skip',
      lastEditedAt: null,
    });
  }
  if (candidates.length === 0) return inert('No skipped test could be matched to a test row.');

  const candidateIds = candidates.map((c) => c.testId);
  // One clock for the query and for the ageing decision — two calls to now()
  // would let a result be inside the window for one and outside for the other.
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  /*
   * Only passes, only from this environment, only from runs that reported.
   *
   * Every one of these conditions is checked again in run-selection.ts. The
   * duplication is the point: the query is an optimisation that can be edited by
   * someone tuning performance, and the rule about what may be reused must not
   * live somewhere an index change can quietly relax it.
   */
  const priorRows = await prisma.testResult.findMany({
    where: {
      testId: { in: candidateIds },
      status: 'PASSED',
      retriedAndPassed: false,
      createdAt: { gte: windowStart },
      run: {
        environmentId: args.environment.id,
        finishedAt: { not: null },
        status: { in: ['PASSED', 'FAILED'] },
      },
    },
    orderBy: { createdAt: 'desc' },
    // Enough to hold several attempts per test without becoming an unbounded
    // scan. Under-fetching can only cool the cache, never warm it wrongly.
    take: Math.min(candidateIds.length * 4, 2000),
    select: {
      id: true,
      testId: true,
      status: true,
      retriedAndPassed: true,
      durationMs: true,
      createdAt: true,
      run: {
        select: {
          id: true,
          environmentId: true,
          baseUrlOverride: true,
          status: true,
          finishedAt: true,
        },
      },
    },
  });

  // Grouped by `groupPriorsByTest` rather than inline: the inline version got
  // this wrong once in a way that silently emptied the map and turned the whole
  // cache into a no-op, so the loop now lives next to its test.
  const priorsByTest = groupPriorsByTest(
    priorRows.map((row): PriorPass => ({
      resultId: row.id,
      runId: row.run.id,
      testId: row.testId,
      status: row.status,
      retriedAndPassed: row.retriedAndPassed,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
      runStatus: row.run.status,
      runFinishedAt: row.run.finishedAt,
      environmentId: row.run.environmentId,
      // A preview-deploy run pointed somewhere else entirely; its passes belong
      // to that URL, not to this environment's.
      effectiveBaseUrl: row.run.baseUrlOverride ?? args.environment.baseUrl,
      // No column to read it from yet — the reconstruction in run-selection.ts
      // takes over, and is treated as the weaker evidence it is.
      cacheKey: null,
    })),
  );

  /*
   * When each test was last edited. Every path that writes `code` or `spec`
   * writes a TestVersion alongside it — the editor, an applied heal, the agent —
   * so a version row newer than a result is the signal that the test moved
   * underneath that result.
   *
   * Only edits inside the window are fetched, and that is exact rather than
   * approximate: every candidate result is itself inside the window, so an edit
   * older than the window start is necessarily older than the result too.
   */
  const editRows = await prisma.testVersion.findMany({
    where: { testId: { in: candidateIds }, createdAt: { gte: windowStart } },
    select: { testId: true, createdAt: true },
  });
  const lastEdit = new Map<string, Date>();
  for (const row of editRows) {
    const seen = lastEdit.get(row.testId);
    if (!seen || row.createdAt > seen) lastEdit.set(row.testId, row.createdAt);
  }
  for (const candidate of candidates) {
    candidate.lastEditedAt = lastEdit.get(candidate.testId) ?? null;
  }

  const plan = planCacheReuse(candidates, priorsByTest, {
    environmentId: args.environment.id,
    effectiveBaseUrl: args.environment.baseUrl,
    environmentUpdatedAt: args.environment.updatedAt,
    now,
    windowMs,
  });

  return {
    requested: true,
    changesThisRun: false,
    windowHours,
    considered: plan.considered,
    reusable: plan.reusable,
    note: CACHE_EFFECT_NOTE,
    results: plan.decisions.slice(0, MAX_REPORTED_DECISIONS),
    resultsTruncated: Math.max(0, plan.decisions.length - MAX_REPORTED_DECISIONS),
  };
}

// ─── On-prem dispatch (§ runners) ────────────────────────────────────────────

interface OnPremDispatch {
  pool: string;
  /** RunnerJobs actually created. Fewer than the slices only on a retried POST. */
  jobs: number;
  /** Online runners serving the pool at the moment of dispatch. */
  runnersOnline: number;
  /** Null when the pool can take this work. A sentence naming the fix when not. */
  warning: string | null;
}

/**
 * Hand a run to the customer's own agents instead of our queue.
 *
 * One RunnerJob per slice — per shard when the run is sharded, one for the
 * whole run when it is not — carrying what a runner must have before the job is
 * offered to it. `createRunnerJobs` dedupes on `<runId>:<shard>`, so a retried
 * POST cannot double-offer a slice.
 *
 * Then it looks at the pool and reports back. That second half is the whole
 * point: creating the jobs is easy, and a job created into a pool nothing is
 * listening to is exactly as invisible as no job at all.
 */
async function dispatchOnPrem(args: {
  orgId: string;
  runId: string;
  pool: string;
  testIds: string[];
  types: ReadonlyArray<{ id: string; type: TestType }>;
  /** Null when the run is not sharded — one job covering everything. */
  shards: ReadonlyArray<{ index: number; testIds: string[] }> | null;
}): Promise<OnPremDispatch> {
  const typeOf = new Map(args.types.map((row) => [row.id, row.type]));

  /*
   * An id with no row was deleted between the selection query and this one.
   * Dropping it can only UNDER-state what the slice needs, which sends the job
   * to a runner that then reports SKIPPED naming the missing browser or binary
   * — the same honest outcome by a slower path. Over-stating would be the
   * dangerous direction: it would park the slice in the unservable sweep for a
   * requirement no test in it actually has.
   */
  const testsIn = (ids: readonly string[]): Array<{ type: TestType }> =>
    ids.flatMap((id) => {
      const type = typeOf.get(id);
      return type ? [{ type }] : [];
    });

  const slices: RunnerSlice[] = args.shards
    ? args.shards.map((shard) => ({
        shardIndex: shard.index,
        requirements: requirementsForTests(testsIn(shard.testIds)),
      }))
    : [{ shardIndex: null, requirements: requirementsForTests(testsIn(args.testIds)) }];

  const jobs = await createRunnerJobs({
    orgId: args.orgId,
    runId: args.runId,
    pool: args.pool,
    slices,
  });

  /*
   * Revoked runners are fetched too, and filtered inside `assessPool`. It is
   * the same read `skipUnservableJobs` does, deliberately: the sentence shown
   * now and the sentence written fifteen minutes later must be two renderings
   * of one judgement, and that only holds if they are given the same input.
   */
  const fleet = await prisma.runner.findMany({
    select: {
      id: true,
      name: true,
      pools: true,
      capabilities: true,
      lastSeenAt: true,
      revokedAt: true,
    },
  });

  // Per slice, not on the union of their requirements: a run whose k6 shard
  // cannot be served while its browser shard can is not a run that "will not be
  // claimed", and saying so would be the kind of over-warning that teaches
  // people to ignore the field.
  const warnings = [
    ...new Set(
      slices
        .map((slice) => describeDispatch(slice.requirements, args.pool, fleet))
        .filter((warning): warning is string => warning !== null),
    ),
  ];
  const warning = warnings.length > 0 ? warnings.join(' ') : null;

  /*
   * Stamped onto the jobs, not only returned.
   *
   * The 202 reaches whoever made the request; the person who goes looking is on
   * Settings → Runners, where a job's `errorMessage` IS the row. Guarded on
   * QUEUED so a runner that claimed the work in the intervening milliseconds
   * keeps its job untouched, and the reaper and the sweep overwrite it later
   * with whatever is true then.
   */
  if (warning) {
    await prisma.runnerJob.updateMany({
      where: { runId: args.runId, status: 'QUEUED' },
      data: { errorMessage: warning },
    });
  }

  return {
    pool: args.pool,
    jobs,
    runnersOnline: assessPool({ testTypes: [], browsers: [], toolchains: [] }, args.pool, fleet)
      .online,
    warning,
  };
}

// ─── The two fields a caller hands over that decide what a run MEANS ─────────

/**
 * The base URL a caller named, checked before anything is written.
 *
 * ── WHY THIS IS THE HIGHEST-VALUE FIELD IN THE REQUEST ─────────────────────
 *
 * It decides which host a browser inside QAAI's network opens, which is the
 * shape of every SSRF. `createRunSchema` has already refused anything that is
 * not an http(s) URL and anything carrying userinfo; this is the host check,
 * and it is the SYNCHRONOUS one — `classifyHost` reads the host string and
 * answers from the string alone.
 *
 * WHAT IT CATCHES: a loopback, link-local, private or CGNAT literal; an IPv6
 * literal of the same classes; a name QAAI declines to read at all (`0177.0.0.1`,
 * `0x7f.0.0.1`, `2130706433` — every one of them 127.0.0.1 to something in the
 * stack, and a hostname to something else); and a name that resolves inside a
 * private network by construction (`localhost`, a single label, `*.internal`,
 * `*.svc`, `*.cluster.local`).
 *
 * WHAT IT DOES NOT CATCH, and must not be described as catching: a PUBLIC name
 * whose records answer `169.254.169.254`. That needs a resolver, a resolver
 * needs DNS, and a name resolved in this process is not the name the browser
 * will resolve — so the resolving check runs where the connection is opened, in
 * `guardProbeHost` (packages/runner/src/preflight.ts), which refuses the host
 * and BLOCKS the tests that depend on it rather than attempting them. This
 * function makes that refusal arrive in a second instead of after a queue hop,
 * which is the whole of what it is for.
 *
 * THE REFUSAL NAMES THE FIELD AND THE CLASS, NEVER THE HOST. The host is
 * customer-authored text, and this message is read by a CI log, a PR comment
 * and a model's context — the same reason the CLI's refusals carry a path and a
 * code. (routes/api-surface.ts echoes the hostname in its own refusal; that is
 * the older convention and not one to copy.)
 */
function checkBaseUrlOverride(url: string): void {
  // `createRunSchema` parsed it, so this cannot throw — but a bare `new URL`
  // in a route with a `throw` after it is worth being explicit about.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('baseUrlOverride is not a URL this server can open.');
  }

  const host = classifyHost(parsed.hostname);
  if (host.kind === 'ambiguous') {
    throw badRequest(
      'baseUrlOverride names a host QAAI will not read: it is an address written in a form two ' +
        'parsers would disagree about, and the disagreement is the bypass. Use a hostname, or a ' +
        'plain dotted-quad.',
    );
  }
  /*
   * `ambiguous` is handled above and treated exactly as loopback, which is the
   * contract `classifyHost` states. Only `public` is ever a yes.
   */
  if (host.kind === 'address' && host.class !== 'public') {
    throw badRequest(
      `baseUrlOverride points at a ${host.class} address. A run's browser executes inside QAAI's ` +
        'network, so it may only be aimed at a public address. A private address belongs on the ' +
        "Environment, which the customer's own runners read.",
    );
  }
  if (host.kind === 'name' && host.internal) {
    throw badRequest(
      'baseUrlOverride names a host that resolves inside a private network. A run’s browser ' +
        'executes inside QAAI’s network, so it may only be aimed at a public host. A private ' +
        "host belongs on the Environment, which the customer's own runners read.",
    );
  }
}

/**
 * WHAT CHOSE THE TESTS IN THIS RUN — the server's own answer, from the request.
 *
 * ── THE DEFECT THIS CLOSES, WITH THE NUMBER ON IT ──────────────────────────
 *
 * A MIN_PASS_RATE gate over an impact-selected run of 11 tests computes 100%,
 * and the web app's run page and the GitHub check both render that as a pass —
 * a suite-wide claim made from a sliver of the suite, on the one surface where
 * a pull request is actually gated. The CLI and the Action withhold that pass
 * today because they KNOW what they asked for. The server could not: the
 * selection chose the tests and was then discarded.
 *
 * ── THE ORDER IS THE CONTENT ───────────────────────────────────────────────
 *
 * IMPACT first, and only when the analysis was APPLIED — `selectionReport.applied`
 * is "the analysis stood AND it actually ruled something out". An analysis that
 * answered RUN_EVERYTHING, or whose answer was overridden for safety, chose
 * nothing, and labelling that run IMPACT would be the mirror of the lie this
 * column exists to stop: a run reported as narrower than it was, whose gate is
 * then withheld although the whole suite ran.
 *
 * Then EXPLICIT, then SUITE, then FULL_SUITE. A request that carries both an id
 * list and a diff is both, and the narrower label is the honest one — what
 * matters downstream is that neither is suite-wide.
 *
 * `useCache` is deliberately not a source. Reuse does not change which tests
 * the run is ABOUT; it changes how one of them gets its answer, and that is
 * reported in `cache` beside it.
 */
function selectionSourceFor(args: {
  impactApplied: boolean;
  explicitTestIds: boolean;
  suiteId: string | null;
}): RunSelectionSource {
  if (args.impactApplied) return 'IMPACT';
  if (args.explicitTestIds) return 'EXPLICIT';
  if (args.suiteId !== null) return 'SUITE';
  return 'FULL_SUITE';
}

/** What was stored, what the server worked out, and what the caller claimed. */
interface SelectionSourceDecision {
  stored: RunSelectionSource;
  computed: RunSelectionSource;
  declared: RunSelectionSource | null;
  /** Whether `stored` can carry a claim about the WHOLE suite. */
  suiteWide: boolean;
}

/**
 * Reconcile the caller's declaration with the server's own answer.
 *
 * A DECLARATION MAY ONLY NARROW. That is the entire rule, and it is what makes
 * the field safe to accept at all:
 *
 *   · no declaration — the server's answer stands.
 *   · the two agree — nothing to decide.
 *   · the declaration is NOT suite-wide and the server's answer is — the
 *     declaration wins, because the caller knows something this server cannot
 *     see. A CLI that ran the impact analysis itself and sent the resulting ids
 *     arrives looking exactly like a caller who typed them.
 *   · the declaration IS suite-wide and the server's answer is not — REFUSED,
 *     out loud. This is the one case that matters: it is a request to label a
 *     run of 11 tests FULL_SUITE so that a gate scored over its own results can
 *     report a suite pass. A field that accepted it would be worse than no
 *     field at all.
 *
 * `SUITE_WIDE_SELECTIONS` is the test, not a literal comparison against
 * `FULL_SUITE`: when a sixth selection mode arrives that IS suite-wide, this
 * reads it from the vocabulary rather than needing to be remembered.
 *
 * Both values are from a closed vocabulary QAAI owns, so the refusal may name
 * them — unlike a host or a path, naming them echoes nothing a caller authored.
 */
function resolveSelectionSource(
  computed: RunSelectionSource,
  declared: RunSelectionSource | null | undefined,
): SelectionSourceDecision {
  const suiteWide = (source: RunSelectionSource): boolean =>
    SUITE_WIDE_SELECTIONS.includes(source);

  const claim = declared ?? null;
  if (claim === null || claim === computed) {
    return { stored: computed, computed, declared: claim, suiteWide: suiteWide(computed) };
  }
  if (suiteWide(claim) && !suiteWide(computed)) {
    throw badRequest(
      `selectionSource was declared ${claim}, which is a claim about the whole suite, and this ` +
        `request selects ${computed}. A selection may only be declared NARROWER than the one the ` +
        'server works out, never wider: a gate scored over the tests that ran must not be able to ' +
        'report a suite pass because the request said so.',
      { declared: claim, computed },
    );
  }
  return { stored: claim, computed, declared: claim, suiteWide: suiteWide(claim) };
}

runsRouter.post('/', requireRole('MEMBER'), requireScope('runs:write'), async (req, res) => {
  const actor = actorOf(req);
  const input = createRunSchema.parse(req.body);

  /*
   * Before the first query, let alone the first write: this is the field that
   * decides which host a browser opens, and a guard after the row exists is a
   * guard a redelivered dispatch walks straight past.
   */
  if (input.baseUrlOverride != null) checkBaseUrlOverride(input.baseUrlOverride);

  const environment = await prisma.environment.findUnique({
    where: { id: input.environmentId },
    // `runnerPool` is THE switch between the two dispatch paths below. Read
    // here, copied onto the run, and never read through the relation again —
    // an environment edited mid-run must not move a run that is already going.
    select: { id: true, projectId: true, baseUrl: true, updatedAt: true, runnerPool: true },
  });
  if (!environment) throw notFound('Environment');

  /*
   * Free plan caps monthly runs; paid plans are unlimited by design (§9).
   *
   * Asked via canStartRun() rather than reading Organization.plan directly:
   * that field records what was BOUGHT, not what is currently PAID FOR. An org
   * whose card has failed keeps its label — so the UI can say "your Team plan
   * is past due" — but is metered at free limits until it clears. Reading the
   * raw field would hand a cancelled org unlimited runs indefinitely.
   *
   * This early read is a courtesy, not the gate: it refuses before the impact
   * analysis and the cache evaluation below spend queries on a run that cannot
   * happen. `startRun` asks again at the moment the row is written, and that
   * answer is the one that decides.
   */
  const verdict = await canStartRun(actor.orgId);
  if (!verdict.allowed) {
    const { plan } = await planFor(actor.orgId);
    throw planLimit(verdict.reason ?? 'Plan limit reached', {
      limit: 'maxRunsPerMonth',
      plan,
    });
  }

  /*
   * Selection is opt-in twice over. Nothing is ruled out without `changedPaths`,
   * and caching additionally needs `useCache`. A run that asks for neither takes
   * exactly the path it always has — including reading only the `id` column,
   * so a project with a thousand Playwright files does not pay to load every
   * one of them to decide it is running all of them anyway.
   */
  const changedPaths = (input.changedPaths ?? []).map((path) => path.trim()).filter(Boolean);
  const wantsSelection = changedPaths.length > 0;
  const wantsCache = input.useCache === true;

  /**
   * Rows under `fixtures/` are test DATA, not tests — they hold no runnable code.
   * Excluded from both selection paths, so neither "run everything" nor an
   * explicit id list can queue one and report it as a failure.
   */
  const candidateWhere = {
    projectId: environment.projectId,
    disabledAt: null,
    filePath: { not: { startsWith: FIXTURE_PREFIX } },
    ...(input.testIds ? { id: { in: input.testIds } } : {}),
    ...(input.suiteId && !input.testIds ? { suiteId: input.suiteId } : {}),
  };

  /*
   * Loaded only for a run that is going to select. `useCache` on its own does
   * not qualify: reuse is defined against the tests a diff cannot reach, so with
   * no diff there is nothing for these columns to answer, and reading every
   * test's source to conclude that would be a very expensive way to say nothing.
   */
  const detailed: DetailedTest[] | null = wantsSelection
    ? await prisma.test.findMany({
        where: candidateWhere,
        select: {
          id: true,
          name: true,
          filePath: true,
          code: true,
          spec: true,
          tags: true,
          feature: true,
          priority: true,
          type: true,
          quarantined: true,
        },
      })
    : null;

  const runnable: Array<{ id: string }> =
    detailed ?? (await prisma.test.findMany({ where: candidateWhere, select: { id: true } }));

  let testIds = runnable.map((t) => t.id);

  if (testIds.length === 0) {
    throw badRequest('There are no tests to run for that suite or project');
  }

  /*
   * Impact selection (§5). The analysis lives in lib/impact.ts and is unchanged
   * here; what is new is that a caller no longer has to make two round trips and
   * hand the answer back as `testIds` to get it. Most people were never going to
   * do that, which meant the feature existed and nobody used it.
   *
   * The analysis is handed the candidate set rather than the whole project, so
   * it answers the question this endpoint is actually being asked: of the tests
   * this run was about to execute, which can the change reach?
   */
  let selection: SelectionResult | null = null;
  let selectionReport: SelectionReport | null = null;

  if (detailed && wantsSelection) {
    // Latest crawl only. An older FlowMap describes an app that has since moved,
    // and its stale routes would attach tests to features that no longer exist.
    const flowMap = await prisma.flowMap.findFirst({
      where: { projectId: environment.projectId },
      orderBy: { version: 'desc' },
      select: { graph: true, version: true },
    });

    selection = selectTestsForRun({
      changedPaths,
      tests: detailed.map((test) => ({
        id: test.id,
        name: test.name,
        filePath: test.filePath,
        code: test.code,
        spec: test.spec,
        tags: test.tags,
        feature: test.feature,
        priority: test.priority,
      })),
      flowMapGraph: flowMap?.graph ?? null,
    });
    selectionReport = describeSelection(selection, flowMap?.version ?? null);
    testIds = selection.testIds;
  }

  const cacheReport = wantsCache
    ? await evaluateResultCache({
        selection,
        detailed: detailed ?? [],
        environment,
        windowHours: input.cacheWindowHours,
      })
    : null;

  const failFast = planFailFast(input.failFast === true);

  /*
   * WHAT CHOSE THE TESTS, decided here because this is the first line at which
   * all four inputs are known: whether the impact analysis was applied, whether
   * the caller named ids, whether it named a suite, and what it declared.
   *
   * Computed before `startRun` so the value is written in the same statement
   * that creates the run. A column filled in afterwards is a column that is
   * null for every run whose second write failed.
   */
  const selectionSource = resolveSelectionSource(
    selectionSourceFor({
      impactApplied: selectionReport?.applied === true,
      explicitTestIds: (input.testIds ?? []).length > 0,
      suiteId: input.suiteId ?? null,
    }),
    input.selectionSource,
  );

  /*
   * The split, decided before anything is written so the run row, the result
   * rows and the queue jobs all agree about it from the moment they exist.
   *
   * Skipped entirely unless the caller asked for more than one shard, so a run
   * that does not want sharding does not pay a query to find that out. With no
   * plan, every line below collapses to what this endpoint has always done: one
   * job, no shard rows, `shardIndex` null on every result.
   */
  const shardPlan =
    input.shards != null && input.shards > 1
      ? await planShards(actor.orgId, testIds, input.shards)
      : null;
  const grantedShards = shardPlan?.granted ?? 1;
  const sharded = grantedShards > 1;
  const shardOfTest = new Map<string, number>();
  for (const assignment of shardPlan?.assignments ?? []) {
    for (const testId of assignment.testIds) shardOfTest.set(testId, assignment.index);
  }

  /*
   * ── Which side of the firewall executes this ───────────────────────────────
   *
   * `Environment.runnerPool` is the switch, and it is read once, here, then
   * copied onto the run. Everything downstream — the dispatch below, the repair
   * endpoint, the agent's own claim — reads the run's copy, so an environment
   * edited while a run is in flight cannot move that run's work to a different
   * network halfway through.
   *
   * The test types are needed only on this path, to say what a runner must have
   * before the job is offered to it. A cloud run does not pay for the query.
   */
  const onPremPool = environment.runnerPool;
  const onPremTests = onPremPool
    ? await prisma.test.findMany({
        where: { id: { in: testIds } },
        select: { id: true, type: true },
      })
    : [];

  /*
   * Gate, create, count — all three in lib/start-run.ts, which is the only
   * place any of the seven run-creating paths is allowed to bring a Run into
   * existence. `enforce` is the HTTP mode: over cap throws 402 PLAN_LIMIT here,
   * the way this endpoint always has.
   */
  const { run } = await startRun({
    db: prisma,
    orgId: actor.orgId,
    mode: 'enforce',
    unscope: unscoped,
    data: {
      orgId: actor.orgId,
      projectId: environment.projectId,
      environmentId: environment.id,
      suiteId: input.suiteId ?? null,
      trigger: input.trigger,
      triggeredBy: actor.userId || null,
      commitSha: input.commitSha ?? null,
      prNumber: input.prNumber ?? null,
      /*
       * THE BRANCH, WRITTEN. `Run.branch` had a column, a copier in the
       * rerun-failures endpoint, a reader in every reporter and in the Jira
       * issue body, and no create path that wrote it — so every run in every
       * install carried null and a PR check looking a run up by branch found
       * nothing. `createRunSchema` now accepts it through the `gitBranch`
       * validator.
       */
      branch: input.branch ?? null,
      /*
       * THE BASE URL, WRITTEN — and the reason `echoRefusals` in the CLI exists
       * to notice when it is not. Classified above; a private, loopback or
       * unreadable host never reaches this line.
       */
      baseUrlOverride: input.baseUrlOverride ?? null,
      /*
       * WHAT CHOSE THE TESTS. Null meant "unknown" and every run ever created
       * stored null, so a gate had nothing to consult and the run page rendered
       * a sliver's 100% as a suite pass. `selectionSource.stored` and not the
       * raw input: one place decides what this means, and it is the function
       * that also refuses a widened claim.
       */
      selectionSource: selectionSource.stored,
      totalCount: testIds.length,
      shardCount: grantedShards,
      /*
       * THE FLAG, WRITTEN. This line is the fix for "the column, the migration,
       * the endpoint and the user-facing promise all exist; the consumer does
       * not". The consumer could never have existed: `Run.failFast` defaulted
       * to false on every row ever created, so a worker polling it would have
       * found every run in the install asking to run to the end.
       *
       * `failFast.requested` and not `input.failFast`, so the one place that
       * decides what the flag means (`planFailFast`) is also the one place the
       * stored value comes from.
       */
      failFast: failFast.requested,
      // The durable record of which of the two dispatch paths owns this run.
      // Non-null means no queue job was enqueued for it, and the repair
      // endpoint refuses to create runner jobs for anything with it null.
      runnerPool: onPremPool,
      // Results are created upfront as placeholders so the cockpit can render
      // the whole suite immediately with each test pending.
      results: {
        create: testIds.map((testId) => ({
          orgId: actor.orgId,
          testId,
          status: 'SKIPPED' as const,
          // Null unless sharded — the worker reads null as "run everything".
          shardIndex: sharded ? (shardOfTest.get(testId) ?? 0) : null,
        })),
      },
      // The durable record of the split. Written in the same transaction as the
      // run, because a run whose shard rows are missing is a run that can never
      // decide it has finished.
      ...(shardPlan && sharded
        ? {
            shards: {
              create: shardPlan.assignments.map((assignment) => ({
                orgId: actor.orgId,
                index: assignment.index,
                total: grantedShards,
                testCount: assignment.testIds.length,
                estimatedMs: assignment.estimatedMs,
              })),
            },
          }
        : {}),
    },
  });

  /*
   * ── Dispatch, one path or the other and never both ─────────────────────────
   *
   * Enqueueing a run that also has RunnerJobs would execute the suite twice
   * against one environment — once on our workers, once inside the customer's
   * network — with two sets of results racing to finalise a single run. So the
   * branch is a branch, `run.runnerPool` is its record, and the repair endpoint
   * in routes/runners.ts refuses to create jobs for a run where it is null.
   *
   * Until this branch existed nothing in the codebase ever wrote `runnerPool`,
   * so no RunnerJob was ever created, and an enterprise's registered agent
   * long-polled forever against an empty queue while every run quietly executed
   * on QAAI's own workers — the exact opposite of what they bought.
   */
  const onPremDispatch = onPremPool
    ? await dispatchOnPrem({
        orgId: actor.orgId,
        runId: run.id,
        pool: onPremPool,
        testIds,
        types: onPremTests,
        shards: sharded ? (shardPlan?.assignments ?? []) : null,
      })
    : null;

  /*
   * One job per shard, each carrying only its own index. The payload stays ids
   * — the worker re-reads the slice from `TestResult.shardIndex`, so a job that
   * sits in the queue while someone disables a test still does the right thing.
   *
   * `attempts: 1` on a shard, against the queue default of 3. A shard that dies
   * must surface as a shard that died: the run finalises ERRORED naming it, and
   * a human re-runs. Silently retrying a slice while its siblings are already
   * aggregating counts is how a run reports numbers from two different attempts.
   */
  const jobIds = onPremDispatch
    ? []
    : shardPlan && sharded
      ? await Promise.all(
          shardPlan.assignments.map((assignment) => {
            const payload: ShardedRunJob = {
              orgId: actor.orgId,
              runId: run.id,
              shard: { index: assignment.index, count: grantedShards },
            };
            return enqueue(QUEUE_NAMES.run, payload, {
              jobId: `run-${run.id}-shard-${assignment.index}`,
              attempts: 1,
            });
          }),
        )
      : [
          await enqueue(
            QUEUE_NAMES.run,
            { orgId: actor.orgId, runId: run.id },
            {
              // Idempotent on run id: a retried POST cannot double-execute a suite.
              jobId: `run-${run.id}`,
            },
          ),
        ];

  await audit({
    actor,
    action: 'run.create',
    targetType: 'Run',
    targetId: run.id,
    metadata: {
      tests: testIds.length,
      trigger: input.trigger,
      ...(sharded ? { shards: grantedShards } : {}),
      /*
       * Where the tests physically executed is the first thing anyone asks when
       * an on-prem result looks wrong, and six months later this row is the only
       * place that still remembers. The warning is recorded too: "queued against
       * a pool nothing was listening to" is a fact about the dispatch, not about
       * the tests, and it does not survive anywhere else once a runner connects.
       */
      ...(onPremDispatch
        ? {
            dispatch: {
              target: 'on-prem',
              pool: onPremDispatch.pool,
              jobs: onPremDispatch.jobs,
              ...(onPremDispatch.warning ? { unclaimable: onPremDispatch.warning } : {}),
            },
          }
        : {}),
      /*
       * A run that executed 6 of 200 tests is a different event from one that
       * executed 200, and six months later the audit log is the only place that
       * still remembers which this was. The strategy and the counts are recorded
       * for that reason; the per-test reasons stay in the response, because an
       * audit row is not a place to put a thousand sentences.
       */
      ...(selectionReport
        ? {
            selection: {
              strategy: selectionReport.strategy,
              confidence: selectionReport.confidence,
              changedPaths: changedPaths.length,
              skipped: selectionReport.totals.skip,
              of: selectionReport.totals.tests,
            },
          }
        : {}),
      ...(cacheReport
        ? { cache: { considered: cacheReport.considered, reusable: cacheReport.reusable } }
        : {}),
      ...(failFast.requested
        ? { failFast: { recorded: true, enforced: failFast.enforced } }
        : {}),
      /*
       * Always, not only when it is interesting. "What was this run's verdict
       * about?" is asked months later, by somebody holding a green check and a
       * regression that shipped, and FULL_SUITE recorded on every ordinary run
       * is what makes the answer readable — an absent field would be
       * indistinguishable from the runs created before the column existed.
       *
       * `declaredByCaller` only when it differed, because that is the event: a
       * caller told us the selection was narrower than we could see. Named
       * `selectedBy` and not `selection`, which this row already uses for the
       * impact analysis's own strategy and counts.
       */
      selectedBy: {
        stored: selectionSource.stored,
        computed: selectionSource.computed,
        ...(selectionSource.declared !== null && selectionSource.declared !== selectionSource.computed
          ? { declaredByCaller: selectionSource.declared }
          : {}),
      },
    },
  });

  res.status(202).json({
    run,
    /*
     * WHAT THIS RUN'S VERDICT WILL BE ABOUT, reported with the 202 rather than
     * left for the caller to re-derive from the fields it sent.
     *
     * `suiteWide` is the one a gate needs and the one nobody can compute from
     * `stored` without knowing `SUITE_WIDE_SELECTIONS`, so it travels with it.
     * `computed` is kept beside `stored` because they differ exactly when the
     * caller told us something we could not see, and a caller comparing the two
     * is how a mislabelled CI integration gets found.
     */
    selectionSource: {
      stored: selectionSource.stored,
      computed: selectionSource.computed,
      declared: selectionSource.declared,
      suiteWide: selectionSource.suiteWide,
    },
    // `jobId` stays a string for every existing caller; sharded runs add the
    // full list rather than replacing it. An on-prem run has neither: nothing
    // was enqueued on our queue, and reporting an id that names no job would be
    // a worse answer than reporting none.
    ...(jobIds.length > 0 ? { jobId: jobIds[0] } : {}),
    ...(jobIds.length > 1 ? { jobIds } : {}),
    /*
     * Where this run went, and — the part that matters — whether anything is
     * listening there.
     *
     * A run queued against a pool with no live runner is indistinguishable from
     * a run that is executing slowly: same QUEUED status, same empty results,
     * for the fifteen minutes the sweep waits before it will say anything at
     * all. That silence is the bug this whole change exists to close, so the
     * answer travels back with the 202 rather than being something the caller
     * has to go looking for. `warning` is null when the pool is healthy —
     * a warning that fires on the happy path is one people learn to ignore.
     */
    ...(onPremDispatch
      ? {
          dispatch: {
            target: 'on-prem' as const,
            pool: onPremDispatch.pool,
            jobs: onPremDispatch.jobs,
            runnersOnline: onPremDispatch.runnersOnline,
            warning: onPremDispatch.warning,
          },
        }
      : {}),
    /*
     * What this run decided not to do, and why.
     *
     * Present whenever the caller asked for selection, including when the answer
     * was "nothing could be ruled out" — a CI step that sends a diff and gets
     * back a full suite needs to see the sentence explaining which file cost it
     * the saving, or it will assume the feature is broken. A selection nobody
     * can audit is a selection nobody should trust.
     */
    ...(selectionReport
      ? { selection: { ...selectionReport, limits: { maxChangedPaths: MAX_CHANGED_PATHS } } }
      : {}),
    ...(cacheReport ? { cache: cacheReport } : {}),
    /*
     * Echoed, with the two halves kept apart: `recorded` is now true and
     * `enforced` is still false, and that pair is the literal truth rather than
     * a contradiction. See FAIL_FAST_NOTE for which file closes the gap.
     */
    ...(failFast.requested
      ? {
          failFast: {
            ...failFast,
            recorded: true,
            stopChannel: 'Run.stopRequestedAt',
            note: FAIL_FAST_NOTE,
          },
        }
      : {}),
    // Reported whenever the caller asked, including when the answer is "no".
    // Asking for 20 workers on a plan that allows 5 gets 5, and finding that
    // out from a wall-clock that did not improve is a terrible way to learn it.
    ...(shardPlan
      ? {
          sharding: {
            requested: shardPlan.requested,
            granted: shardPlan.granted,
            cappedBy: shardPlan.cappedBy,
            maxParallelWorkers: shardPlan.maxParallelWorkers,
            testsWithHistory: shardPlan.testsWithHistory,
            shards: shardPlan.assignments.map((a) => ({
              index: a.index,
              testCount: a.testIds.length,
              estimatedMs: a.estimatedMs,
            })),
          },
        }
      : {}),
  });
});


// ─── POST /runs/:runId/rerun-failures (§5) ───────────────────────────────────

/**
 * Re-run only what failed.
 *
 * THE DEFECT, VERBATIM: "Re-run only the failures of a previous run — every
 * re-run path re-executes the whole suite, which makes the loop unusable on a
 * 5,000-test suite."
 *
 * Everything needed was already here. `POST /runs` takes `testIds`, the
 * previous run's `TestResult` rows say exactly which tests failed, and nothing
 * joined the two — so the only way to re-check six failures was to spend
 * another 5,000 browser-minutes, and the answer arrived long after anyone was
 * still looking at it. The whole close-the-loop story (fix, re-run, confirm)
 * costs what the slowest part of it costs, and this was the slowest part by
 * three orders of magnitude.
 *
 * ── WHAT IT COPIES FROM THE PREVIOUS RUN, AND WHY EACH ONE MATTERS ──────────
 *
 * The environment, and `baseUrlOverride` with it: re-running the failures of a
 * preview-deploy run against the environment's default URL would be re-running
 * them against a different application, and a green result from that is worse
 * than no result. The commit, the branch and the PR number, because a re-run
 * that loses its CI context cannot be reported back to the check that asked for
 * it. The suite, so the run reads as a run of that suite. And `runnerPool`, so
 * an enterprise's failures re-execute inside the same network the originals did
 * — a re-run that quietly moved the work to QAAI's own workers would be the
 * exact bug the dispatch branch above exists to prevent, arriving by a new door.
 *
 * The TRIGGER is MANUAL even when the parent was a SCHEDULE or a MONITOR. A
 * human asked for this one, and labelling it as a monitor check would corrupt
 * `recordMonitorResult`'s failure streak with a run nobody scheduled.
 *
 * ── A TEST THAT NO LONGER EXISTS ────────────────────────────────────────────
 *
 * Three different things, kept three different things, because each needs a
 * different sentence:
 *
 *   DELETED. `TestResult.test` is `onDelete: Cascade`, so deleting a Test takes
 *   its results with it — the failure cannot be re-run because the evidence of
 *   it is gone too. That is invisible unless something counts: the endpoint
 *   compares `Run.totalCount` (what the run recorded when it started) against
 *   the result rows it can still read, and reports the difference as
 *   `vanishedResults` with the reason. It is NEVER reported as zero failures.
 *
 *   DISABLED. The test row is there and `disabledAt` is set. It must not run —
 *   every other selection path in this file excludes it — so it is excluded
 *   here too, by name, in `excluded`.
 *
 *   NO LONGER RUNNABLE. The test moved under `fixtures/`, which holds test DATA
 *   and no runnable code. Same treatment.
 *
 * If every failure falls into one of those, the response is a 409 naming them
 * rather than an empty run or a 200 that looks like success. A re-run that
 * executes nothing and reports PASSED is the single worst answer available
 * here, and it is the one the obvious implementation gives.
 */
const rerunFailuresBody = z.object({
  /**
   * Whether to include tests that failed and then passed on retry.
   *
   * Off by default, and that is a judgement rather than caution: a
   * `retriedAndPassed` result is the flake radar's input, not a failure anybody
   * is waiting to re-check, and including them by default would make the common
   * case ("re-run my 6 failures") silently re-run 40 tests on a flaky suite.
   */
  includeFlaky: z.boolean().optional(),
  /** Arms `Run.failFast` on the re-run. See FAIL_FAST_NOTE. */
  failFast: z.boolean().optional(),
});

/** One failure that will not be re-run, and the sentence saying why. */
interface ExcludedFailure {
  testId: string;
  name: string;
  why: string;
}

runsRouter.post(
  '/:runId/rerun-failures',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const parsed = rerunFailuresBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const includeFlaky = parsed.data.includeFlaky === true;

    const previous = await prisma.run.findUnique({
      where: { id: String(req.params.runId) },
      select: {
        id: true,
        projectId: true,
        environmentId: true,
        suiteId: true,
        status: true,
        totalCount: true,
        commitSha: true,
        branch: true,
        prNumber: true,
        baseUrlOverride: true,
        runnerPool: true,
      },
    });
    if (!previous) throw notFound('Run');

    /*
     * A run still in flight has no final answer about which tests failed — the
     * results are placeholders being filled in as they execute, so a re-run
     * built from them now would re-run whatever had failed so far and miss the
     * rest. Refused rather than guessed.
     */
    if (previous.status === 'QUEUED' || previous.status === 'RUNNING') {
      throw badRequest(
        `That run is still ${previous.status.toLowerCase()}. Wait for it to finish, or cancel it, before re-running its failures — the result rows are not final yet.`,
      );
    }

    const results = await prisma.testResult.findMany({
      where: { runId: previous.id },
      // Execution order, so the failure that tripped fail-fast comes first and
      // the excluded list reads in the order the run produced it.
      orderBy: { createdAt: 'asc' },
      select: {
        testId: true,
        status: true,
        retriedAndPassed: true,
        test: {
          select: {
            id: true,
            name: true,
            disabledAt: true,
            filePath: true,
            quarantined: true,
            quarantineExpiresAt: true,
          },
        },
      },
    });

    /*
     * Result rows that are no longer there at all. See "A TEST THAT NO LONGER
     * EXISTS" above: the cascade took them with their tests, so the only
     * evidence left that they existed is the count the run recorded when it
     * started. Clamped at zero because a run whose `totalCount` was never set
     * (an older row) must not report a negative.
     */
    const vanishedResults = Math.max(0, previous.totalCount - results.length);

    const failedStatuses = new Set(
      includeFlaky ? ['FAILED', 'TIMED_OUT', 'FLAKY'] : ['FAILED', 'TIMED_OUT'],
    );

    const rerunIds: string[] = [];
    const excluded: ExcludedFailure[] = [];
    let retriedAndPassedSkipped = 0;
    let quarantinedIncluded = 0;

    for (const result of results) {
      if (!failedStatuses.has(result.status)) continue;
      /*
       * A retry that passed is not a failure anybody is waiting to re-check.
       * Counted rather than dropped silently: "6 failures, 3 of which passed on
       * retry and were not re-run" is a different sentence from "3 failures",
       * and a caller that wanted them has `includeFlaky`.
       */
      if (!includeFlaky && result.retriedAndPassed) {
        retriedAndPassedSkipped += 1;
        continue;
      }

      const test = result.test;
      if (test.disabledAt) {
        excluded.push({
          testId: test.id,
          name: test.name,
          why: 'This test has been disabled since the run. Every selection path in this product excludes a disabled test, so re-running it here would be the one place a disabled test still executes.',
        });
        continue;
      }
      if (test.filePath.startsWith(FIXTURE_PREFIX)) {
        excluded.push({
          testId: test.id,
          name: test.name,
          why: `This test has moved under ${FIXTURE_PREFIX}, which holds test DATA and no runnable code. It cannot be executed and must not be queued as a test.`,
        });
        continue;
      }

      if (quarantineSuppresses(test, new Date())) quarantinedIncluded += 1;
      rerunIds.push(test.id);
    }

    /*
     * Nothing to do, and WHICH nothing. The three cases are genuinely
     * different: a run with no failures at all is a question whose answer is
     * "nothing failed", while a run whose every failure has been disabled,
     * deleted or fixtured is a question this endpoint cannot answer and must
     * not answer with a green run.
     */
    if (rerunIds.length === 0) {
      const reasons: string[] = [];
      if (excluded.length > 0) {
        reasons.push(
          `${excluded.length} failing test(s) can no longer run: ${excluded
            .slice(0, 5)
            .map((e) => e.name)
            .join(', ')}`,
        );
      }
      if (vanishedResults > 0) {
        reasons.push(
          `${vanishedResults} of the run's ${previous.totalCount} result(s) no longer exist, because deleting a test deletes its results — whatever those tests did cannot be re-run or even re-read`,
        );
      }
      if (retriedAndPassedSkipped > 0) {
        reasons.push(
          `${retriedAndPassedSkipped} failure(s) passed on retry and were not included; send \`includeFlaky: true\` to re-run them`,
        );
      }

      if (reasons.length === 0) {
        /*
         * 422 and not 409: the request was perfectly coherent and the run
         * simply has no failures. A 409 would read as "try again", and there is
         * nothing to try.
         */
        throw unprocessable(
          'That run recorded no failures, so there is nothing to re-run. Its verdict is on GET /runs/:runId.',
          { reran: 0, vanishedResults },
        );
      }
      throw conflict(
        `None of that run's failures can be re-run. ${reasons.join('. ')}.`,
        { excluded, vanishedResults, retriedAndPassedSkipped },
      );
    }

    const failFast = planFailFast(parsed.data.failFast === true);

    /*
     * Gate, create, count — through `startRun` like every other run-creating
     * path, in `enforce` mode because this is HTTP. A re-run costs the same
     * browser as the original and must take the same toll; the whole reason
     * `startRun` exists is that six of seven paths used to forget.
     */
    const { run } = await startRun({
      db: prisma,
      orgId: actor.orgId,
      mode: 'enforce',
      unscope: unscoped,
      data: {
        orgId: actor.orgId,
        projectId: previous.projectId,
        environmentId: previous.environmentId,
        suiteId: previous.suiteId,
        trigger: 'MANUAL',
        triggeredBy: actor.userId || null,
        commitSha: previous.commitSha,
        branch: previous.branch,
        prNumber: previous.prNumber,
        // The same application, not merely the same environment row. See the
        // header: a preview-deploy run's failures belong to the preview URL.
        baseUrlOverride: previous.baseUrlOverride,
        /*
         * NOT COPIED from the previous run, and that is the point: whatever
         * chose the tests THERE, what chose them HERE is "the failures of that
         * run". Copying `selectionSource` would let a re-run of 6 failures
         * inherit the parent's FULL_SUITE and hand a MIN_PASS_RATE gate a
         * suite-wide claim over six tests — the exact lie the column exists to
         * stop, arriving by the one door that looks like bookkeeping.
         *
         * RERUN_FAILURES is not in `SUITE_WIDE_SELECTIONS`, so it says what
         * this endpoint's own response and the CLI both already say out loud: a
         * re-run of the failures is never a suite pass.
         */
        selectionSource: 'RERUN_FAILURES' satisfies RunSelectionSource,
        totalCount: rerunIds.length,
        failFast: failFast.requested,
        // Never sharded. The point of this endpoint is that the set is small;
        // splitting six tests across four workers spends three queue hops and
        // three browser cold starts to save nothing.
        shardCount: 1,
        runnerPool: previous.runnerPool,
        results: {
          create: rerunIds.map((testId) => ({
            orgId: actor.orgId,
            testId,
            status: 'SKIPPED' as const,
            shardIndex: null,
          })),
        },
      },
    });

    /*
     * One dispatch path or the other, never both — the same branch POST /runs
     * takes, and for the same reason: a run that is both enqueued and offered
     * to on-prem agents executes its tests twice against one environment, with
     * two sets of results racing to finalise it.
     */
    const onPremDispatch = previous.runnerPool
      ? await dispatchOnPrem({
          orgId: actor.orgId,
          runId: run.id,
          pool: previous.runnerPool,
          testIds: rerunIds,
          types: await prisma.test.findMany({
            where: { id: { in: rerunIds } },
            select: { id: true, type: true },
          }),
          shards: null,
        })
      : null;

    const jobId = onPremDispatch
      ? null
      : await enqueue(
          QUEUE_NAMES.run,
          { orgId: actor.orgId, runId: run.id },
          // Idempotent on the NEW run id: a double-clicked re-run button
          // cannot execute the same slice twice.
          { jobId: `run-${run.id}` },
        );

    await audit({
      actor,
      action: 'run.rerun-failures',
      targetType: 'Run',
      targetId: run.id,
      metadata: {
        ofRun: previous.id,
        reran: rerunIds.length,
        ofResults: results.length,
        /*
         * Recorded, because six months later this row is the only place that
         * still remembers the re-run was a SUBSET. A run with 6 results that
         * came from a suite of 5,000 reads as a catastrophically shrunken suite
         * unless something says it was deliberate.
         */
        excluded: excluded.length,
        vanishedResults,
        retriedAndPassedSkipped,
        includeFlaky,
        ...(failFast.requested ? { failFast: { recorded: true } } : {}),
        ...(onPremDispatch ? { dispatch: { target: 'on-prem', pool: onPremDispatch.pool } } : {}),
      },
    });

    res.status(202).json({
      run,
      ...(jobId ? { jobId } : {}),
      /** The previous run this was built from, so the pair is traceable. */
      ofRun: previous.id,
      /** How many tests this run will execute, out of what the original recorded. */
      reran: rerunIds.length,
      ofResults: results.length,
      ofTotal: previous.totalCount,
      /**
       * The three honest absences. Every one is reported even when it is zero,
       * because a caller comparing `reran` against the failures it expected
       * needs somewhere to look, and a field that only appears when it is
       * non-zero is a field nobody writes code against.
       */
      excluded,
      vanishedResults,
      retriedAndPassedSkipped,
      /**
       * Failures suppressed by a quarantine in force. They ARE re-run — the
       * test is not broken-by-decree, its failure is just not allowed to gate —
       * but a caller reading `reran: 6` deserves to know that two of the six
       * cannot turn this run red however they end.
       */
      quarantinedIncluded,
      ...(failFast.requested
        ? {
            failFast: {
              ...failFast,
              recorded: true,
              stopChannel: 'Run.stopRequestedAt',
              note: FAIL_FAST_NOTE,
            },
          }
        : {}),
      ...(onPremDispatch
        ? {
            dispatch: {
              target: 'on-prem' as const,
              pool: onPremDispatch.pool,
              jobs: onPremDispatch.jobs,
              runnersOnline: onPremDispatch.runnersOnline,
              warning: onPremDispatch.warning,
            },
          }
        : {}),
    });
  },
);

runsRouter.get('/', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  const runs = await prisma.run.findMany({
    where: { ...(projectId ? { projectId } : {}) },
    orderBy: { queuedAt: 'desc' },
    take: Math.min(100, Number(req.query.limit ?? 25)),
    include: { environment: { select: { name: true, kind: true } } },
  });
  res.json({ runs });
});

/**
 * Cancel a run.
 *
 * `CANCELLED` has been in the RunStatus enum from the beginning and nothing
 * could produce it — a run in flight was unstoppable, and the cockpit's only
 * control was a Re-run button greyed out with no explanation.
 *
 * This writes the status and returns; the worker checks it between tests and
 * stops. That means cancelling is not instant — it waits for the current test —
 * and the response says so rather than implying the run halted on the spot.
 */
runsRouter.post(
  '/:runId/cancel',
  requireRole('MEMBER'),
  requireScope('runs:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const run = await prisma.run.findUnique({
      where: { id: String(req.params.runId) },
      select: { id: true, status: true },
    });
    if (!run) throw notFound('Run');

    // Cancelling a finished run would rewrite history — the results are real and
    // already reported. Idempotent on an already-cancelled run so a double-click
    // is not an error.
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      if (run.status === 'CANCELLED') {
        res.json({ run, alreadyCancelled: true });
        return;
      }
      throw badRequest(`This run already finished as ${run.status.toLowerCase()}.`);
    }

    const updated = await prisma.run.update({
      where: { id: run.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });

    /*
     * Cancelling a sharded run stops every shard, not the one that happens to
     * be furthest along. The mechanism is unchanged and deliberately indirect:
     * each shard polls the run's status between tests and stops on its own.
     * This marks the shard rows so the cockpit does not show four workers still
     * "running" for however long their current tests take, and so a shard whose
     * job never gets picked up is already terminal when the reaper looks.
     */
    await prisma.runShard.updateMany({
      where: { runId: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });

    await audit({
      actor,
      action: 'run.cancel',
      targetType: 'Run',
      targetId: run.id,
      metadata: { previousStatus: run.status },
    });

    res.json({
      run: updated,
      // A QUEUED run stops before it starts; a RUNNING one finishes its current
      // test first. Saying which is the difference between a user trusting the
      // button and clicking it three more times.
      stopsAfterCurrentTest: run.status === 'RUNNING',
    });
  },
);

// ─── The suppression ledger, reaching the reader ─────────────────────────────

/**
 * How many ledger rows one run's reported ledger is folded from.
 *
 * A BOUND THAT IS REPORTED WHEN IT BITES, never a silent `take`. One row per
 * (kind, cause) per run, so a 200-test outage under three mutes writes three;
 * past this cap a run had thousands of distinct suppressed causes, which is
 * itself the finding, and the answer under-counts out loud rather than claiming
 * to have seen everything.
 *
 * ONE DEFINITION NOW, in packages/shared/src/constants.ts. It was a separate
 * literal here and in apps/worker/src/processors/run.ts — "deliberately the
 * same" — because an app cannot import another app's processor; shared is where
 * both can read it, and `runs.test.ts` pins this surface's total against the
 * finaliser's on every terminal run, so the day one literal moved that test
 * would have been the only thing that knew.
 *
 * The name is kept so this file's own readers do not all have to change.
 */
export const RUN_SUPPRESSION_LEDGER_CAP = SUPPRESSION_LEDGER_SCAN_CAP;

/**
 * Whether a stored `selectionSource` can carry a claim about the WHOLE suite.
 *
 * THREE STATES, because there are three:
 *
 *   true   — the selection is in `SUITE_WIDE_SELECTIONS`.
 *   false  — it is a selection, and it is narrower than the suite.
 *   null   — WE DO NOT KNOW. The column is null on every run written before it
 *            existed, and such a run was not necessarily a full-suite run.
 *            Rendering that as `false` would be a claim nobody measured, and
 *            rendering it as `true` is the exact lie the column was added to
 *            stop: a MIN_PASS_RATE gate over eleven tests reporting 100% as a
 *            suite pass.
 *
 * Null is also the answer for a value OUTSIDE the vocabulary. The column is
 * TEXT with the domain at the producer — deliberately, so a sixth selection
 * mode is a feature rather than a migration — which means a row written by a
 * newer QAAI can hold a name this code has never heard of. "Not one of the
 * suite-wide names I know" is not the same fact as "not suite-wide", and
 * answering `false` there would turn an unreadable row into a measurement.
 *
 * The CAST IS ON THE LIST AND NOT ON THE VALUE: asking whether a string is one
 * of these names is honest, while `value as RunSelectionSource` would assert
 * that whatever is in the column is a member of the domain, which is the one
 * thing this function is here to doubt.
 */
function suiteWideClaim(selectionSource: string | null): boolean | null {
  if (selectionSource === null) return null;
  if (!(RUN_SELECTION_SOURCES as readonly string[]).includes(selectionSource)) return null;
  return (SUITE_WIDE_SELECTIONS as readonly string[]).includes(selectionSource);
}

/** A cap that actually bit, with the count and the reason it bit. */
interface LedgerTruncation {
  limit: number;
  rowsRead: number;
  reason: string;
}

/**
 * This run's suppressions, folded by kind, for `runOutcome`.
 *
 * ── WHY THE FOLD IS IN TYPESCRIPT AND NOT A `groupBy` ──────────────────────
 *
 * The number that matters is DISTINCT SUPPRESSING ROWS, not ledger rows. A
 * `groupBy(['kind'])` with `_count` reports three known issues as three when
 * they silenced one cause each and as ONE when one mute silenced three causes —
 * and the headline sentence is "47 failures suppressed by 3 known issues", so
 * the second number has to be distinct `sourceId`s. Prisma cannot count
 * distinct values inside a group-by. This is the same fold the run finaliser
 * and the digest each do, for the same reason.
 *
 * ── QUARANTINE IS EXCLUDED AT THE SOURCE ───────────────────────────────────
 *
 * `runOutcome` synthesises the quarantine tally from `counts.quarantinedFailed`,
 * which `tallyResult` is the only writer of. Letting a QUARANTINE ledger row
 * through as well would double the one total a release decision reads — one
 * fact in two fields, which is the same defect as two facts in one.
 *
 * ── NO `catch` HERE, DELIBERATELY ──────────────────────────────────────────
 *
 * The finaliser catches, because it must not lose a run's writes over a
 * summary. This is a GET with nothing to lose: a ledger read that fails here
 * fails for the same reason the run read two lines above it would, and
 * inventing a third state ("the ledger exists but could not be read") would
 * give every caller a case to handle that is indistinguishable in the numbers
 * from the two that already exist.
 */
async function suppressionLedgerFor(
  runId: string,
): Promise<{ tallies: SuppressionTally[]; rowsRead: number; truncated: LedgerTruncation | null }> {
  /*
   * `orgId` is absent from the `where` on purpose: the tenant extension adds
   * it, the way it does for every other read in this file. One row over the cap
   * is read so the cap can be REPORTED rather than guessed at.
   */
  const rows = await prisma.suppressionEvent.findMany({
    where: { runId, kind: { not: 'QUARANTINE' } },
    take: RUN_SUPPRESSION_LEDGER_CAP + 1,
    select: { kind: true, sourceId: true, suppressed: true, inForce: true },
  });

  const truncated: LedgerTruncation | null =
    rows.length > RUN_SUPPRESSION_LEDGER_CAP
      ? {
          limit: RUN_SUPPRESSION_LEDGER_CAP,
          rowsRead: RUN_SUPPRESSION_LEDGER_CAP,
          reason:
            `This run has more than ${RUN_SUPPRESSION_LEDGER_CAP} distinct suppressed causes, ` +
            'which is the cap on this read. The counts below are a FLOOR: more was suppressed ' +
            'than they say, and the number of distinct causes is itself the finding.',
        }
      : null;

  const byKind = new Map<
    SuppressionKind,
    { suppressed: number; live: Set<string>; dead: Set<string> }
  >();
  for (const row of rows.slice(0, RUN_SUPPRESSION_LEDGER_CAP)) {
    /*
     * NO CAST. `SuppressionEvent.kind` is a Postgres enum, so Prisma already
     * types it as the union; an assertion here would hide the day the two
     * vocabularies stop agreeing, which is what a drift guard is for.
     */
    const kind: SuppressionKind = row.kind;
    const tally = byKind.get(kind) ?? { suppressed: 0, live: new Set(), dead: new Set() };
    tally.suppressed += row.suppressed;
    // `sourceId` is nullable. A row with none is still ONE suppression,
    // identified by nothing, rather than a row dropped from the count.
    (row.inForce ? tally.live : tally.dead).add(row.sourceId ?? `<unidentified:${kind}>`);
    byKind.set(kind, tally);
  }

  return {
    rowsRead: Math.min(rows.length, RUN_SUPPRESSION_LEDGER_CAP),
    truncated,
    tallies: [...byKind.entries()].map(([kind, tally]) => ({
      kind,
      suppressions: tally.live.size,
      suppressed: tally.suppressed,
      expired: tally.dead.size,
    })),
  };
}

/**
 * The ledger as a reader sees it: five numbers, a complete breakdown, and the
 * cap if it bit.
 *
 * ── THE SENTENCE THIS EXISTS TO MAKE POSSIBLE ──────────────────────────────
 *
 * "47 failures silenced by 3 known issues". The CLI has been able to print it
 * for a release and had no source for it: `--suppressions` read
 * `run.suppressions` off this endpoint and this endpoint did not report one, so
 * the flag printed "UNAVAILABLE" on every server that exists.
 *
 * ── QUARANTINE IS SYNTHESISED FROM THE COUNTER, NOT READ FROM THE LEDGER ───
 *
 * The same rule `runOutcome` states and enforces: `quarantinedFailedCount` is
 * the only writer of that number, and counting it again from a ledger row would
 * double the one total a release decision reads. Each quarantined failure is
 * one quarantined test, so the count of quarantines equals the count of
 * failures they silenced — honest, and the only thing a run's counters can say.
 *
 * `tallies` ARRIVES QUARANTINE-FREE: `suppressionLedgerFor` excludes the kind
 * in its `where`, which is the one place that exclusion is made. There is
 * deliberately no second filter here. A belt-and-braces `.filter(kind !==
 * 'QUARANTINE')` on this line was removed because it could not be killed by a
 * mutation — with the query filter in place it never excludes anything, so it
 * is code connected to nothing, and it HID the query filter from the tests that
 * were supposed to pin it.
 *
 * This is the SECOND place the synthesis itself is written (`runOutcome` has
 * the other, and filters any QUARANTINE tally a caller passes so the two cannot
 * both apply). `runs.test.ts` pins `verdict.suppressedFailures` against
 * `suppressions.failuresSuppressed` for exactly that reason: the two must agree
 * on every terminal run, and a test is the only thing that keeps them agreeing.
 *
 * ── THE FIVE FIELDS ARE THREE OF FIVE KINDS, SO `byKind` IS NOT OPTIONAL ───
 *
 * `knownIssues`, `quarantines` and `waivers` name three of the five suppression
 * kinds. ENV_ISSUE and RETIREMENT can silence a failure too, and a reader
 * handed "12 failures suppressed by 0 known issues, 0 quarantines and 0
 * waivers" would be reading a failure suppressed without being counted. So the
 * complete per-kind breakdown travels with the five, and it names every kind
 * that did anything.
 */
function reportedLedger(
  run: { quarantinedFailedCount: number },
  ledger: { tallies: readonly SuppressionTally[]; rowsRead: number; truncated: LedgerTruncation | null },
): {
  failuresSuppressed: number;
  knownIssues: number;
  quarantines: number;
  waivers: number;
  expiredAndSilencedNothing: number;
  byKind: SuppressionTally[];
  rowsRead: number;
  truncated: LedgerTruncation | null;
} {
  const quarantined = Math.max(0, run.quarantinedFailedCount);
  const summary = summariseSuppressions([
    ...(quarantined > 0
      ? [
          {
            kind: 'QUARANTINE' as const,
            suppressions: quarantined,
            suppressed: quarantined,
            expired: 0,
          },
        ]
      : []),
    ...ledger.tallies,
  ]);

  const of = (kind: SuppressionKind): number =>
    summary.byKind.find((tally) => tally.kind === kind)?.suppressions ?? 0;

  return {
    failuresSuppressed: summary.suppressed,
    knownIssues: of('MUTE'),
    quarantines: of('QUARANTINE'),
    waivers: of('COVERAGE_WAIVER'),
    expiredAndSilencedNothing: summary.expired,
    byKind: summary.byKind,
    rowsRead: ledger.rowsRead,
    truncated: ledger.truncated,
  };
}

/**
 * The run's verdict, computed server-side and returned WITH the run.
 *
 * ── Why this field exists ───────────────────────────────────────────────────
 *
 * The CLI used to derive its exit code itself:
 *
 *     failedCount > 0 || status === 'FAILED' || status === 'ERRORED' || gateBlocked
 *
 * and so did the GitHub check, and the JUnit XML, and the worker, and the
 * on-prem finaliser — five expressions over four different fields. Quarantine
 * was honoured by exactly one of them (the gate), which is how a quarantined
 * test's failure went on failing builds through the counters while being
 * invisible in every gate rule.
 *
 * So the server answers the question and the CLI reads the answer. A new
 * consumer that needs red/green reads `run.verdict.passed`; nothing needs to
 * learn the rule again, and a change to the rule reaches every consumer at
 * once. `verdict` rather than a bare boolean because the REASON travels with
 * it: a run that passed with suppressed failures has to be able to say so.
 */
function runVerdict(
  run: {
    status: string;
    passedCount: number;
    failedCount: number;
    flakyCount: number;
    skippedCount: number;
    quarantinedFailedCount: number;
    gateResult: unknown;
  },
  /**
   * The non-quarantine suppressions this run recorded.
   *
   * Handed in rather than read here, because this function is also called for a
   * run that has not finished — and because `runOutcome` documents an ABSENT
   * list as "this caller has no ledger to read" rather than "nothing was
   * suppressed". This route used to be exactly that caller: it called
   * `runOutcome` with no suppressions at all, so a run that passed because a
   * known issue silenced forty failures reported "Nothing was suppressed." to
   * the CLI, the check and the run page.
   */
  tallies: readonly SuppressionTally[] = [],
): {
  passed: boolean;
  status: string;
  suppressedFailures: number;
  reason: string;
} {
  const gate = run.gateResult as { passed?: boolean } | null | undefined;
  /*
   * A run still in flight has no verdict and must not be given one. `null`
   * `gateResult` means "the gate has not been evaluated", and reading that as
   * `passed: false` would have the CLI's progress line report a failing build
   * halfway through a green run.
   */
  const terminal =
    run.status === 'PASSED' ||
    run.status === 'FAILED' ||
    run.status === 'CANCELLED' ||
    run.status === 'ERRORED';

  if (!terminal) {
    return {
      passed: false,
      status: run.status,
      suppressedFailures: run.quarantinedFailedCount,
      reason: 'The run has not finished, so it has no verdict yet.',
    };
  }

  const outcome = runOutcome({
    counts: {
      passed: run.passedCount,
      failed: run.failedCount,
      flaky: run.flakyCount,
      skipped: run.skippedCount,
      quarantinedFailed: run.quarantinedFailedCount,
      /*
       * ── WHY THIS SURFACE SUBTRACTS TOO ────────────────────────────────────
       *
       * The post-triage re-score (apps/worker/src/processors/checks.ts) now
       * hands `runOutcome` the same number and writes the result to
       * `Run.status`. If this function did not, the API would recompute a
       * verdict from the same row and reach the OPPOSITE answer — the stored
       * status PASSED and this endpoint's `verdict.status` FAILED — which is
       * two surfaces disagreeing about one run, the defect `runOutcome` exists
       * to end.
       *
       * `tallies` arrives quarantine-free (see `suppressionLedgerFor`), so this
       * total is the non-quarantine ledger and nothing else. As in the worker,
       * the claim and the accounting come from ONE read, so `runOutcome`'s
       * `claimed > accounted` shortfall cannot fire here; what bounds the
       * subtraction is `counts.failed`.
       *
       * A pending re-score is NOT a disagreement: the subtraction can only
       * flip a status whose stored `gateResult.passed` is already true, so a
       * run the gate blocked stays blocked until the gate itself is re-scored.
       */
      failedThenSuppressed: tallies.reduce((total, tally) => total + tally.suppressed, 0),
    },
    suppressions: tallies,
    // A terminal run with no gate result was finalised by something that did
    // not evaluate one. Treated as "nothing blocked", which is what the stored
    // status already reflects.
    gatePassed: gate?.passed !== false,
    forcedStatus:
      run.status === 'CANCELLED' ? 'CANCELLED' : run.status === 'ERRORED' ? 'ERRORED' : null,
  });

  return {
    passed: outcome.passed,
    status: outcome.status,
    suppressedFailures: outcome.suppressedFailures,
    reason: outcome.reason,
  };
}

runsRouter.get('/:runId', async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    include: {
      environment: { select: { name: true, kind: true, baseUrl: true } },
      // Empty on an unsharded run, which is every run that did not ask.
      shards: { orderBy: { index: 'asc' } },
      results: {
        include: {
          test: {
            select: {
              id: true,
              name: true,
              type: true,
              priority: true,
              filePath: true,
              quarantined: true,
              // The expiry travels with the flag everywhere, because an
              // expired quarantine GATES AGAIN and a surface showing only the
              // flag would label a gating test as suppressed.
              quarantineExpiresAt: true,
            },
          },
          steps: { orderBy: { index: 'asc' } },
          findings: true,
          verdict: true,
        },
      },
    },
  });
  if (!run) throw notFound('Run');

  /*
   * THE LEDGER, FETCHED FOR THE READER. One indexed read on `runId`, and the
   * reason it is worth a second query on the endpoint the CLI polls: the only
   * other way for a release to learn that 47 of its failures were muted is for
   * somebody to go and look, which is the behaviour this whole vocabulary
   * exists to replace.
   *
   * Reported for a run that has not finished too, and that is not a measurement
   * claim: these rows are written by the run finaliser, so an unfinished run
   * reports what has been recorded SO FAR. The quarantine half is live from the
   * run's own counter.
   */
  const ledger = await suppressionLedgerFor(run.id);

  res.json({
    run: {
      ...run,
      verdict: runVerdict(run, ledger.tallies),
      /*
       * WHETHER THIS RUN'S VERDICT CAN BE READ AS A STATEMENT ABOUT THE SUITE.
       *
       * Derived from `selectionSource` so a reader does not need the
       * vocabulary: the GitHub Action's summary script runs in the customer's
       * CI with nothing installed but the pinned CLI, and cannot import
       * `SUITE_WIDE_SELECTIONS` to work it out.
       *
       * THREE STATES, because there are three. See `suiteWideClaim`.
       */
      selectionSuiteWide: suiteWideClaim(run.selectionSource),
      /*
       * The five numbers `suppressionLines` in the CLI reads, plus the complete
       * per-kind breakdown and the cap if it bit. Present whenever the run is —
       * a field that appears only when something was suppressed is a field a
       * reader cannot tell from a server that does not have one, which is the
       * difference between "nothing was suppressed" and "we did not look".
       */
      suppressions: reportedLedger(run, ledger),
    },
  });
});

/** Live run events for the cockpit's right pane (§8). */
runsRouter.get('/:runId/events', async (req, res) => {
  const actor = actorOf(req);
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: { id: true, status: true },
  });
  if (!run) throw notFound('Run');

  const unsubscribe = subscribe(actor.orgId, run.id, res);
  req.on('close', unsubscribe);
});

/**
 * Artifact reader. Everything is served through the API rather than handing out
 * a bucket URL, so an artifact is subject to the same session and tenancy check
 * as the run it belongs to.
 */
runsRouter.get('/:runId/artifacts/{*key}', async (req, res) => {
  const key = Array.isArray(req.params.key)
    ? req.params.key.join('/')
    : String(req.params.key ?? '');

  const artifact = await prisma.artifact.findUnique({ where: { key } });
  if (!artifact || artifact.runId !== req.params.runId) throw notFound('Artifact');

  if (env.ARTIFACTS_LOCAL) {
    const body = await storage.get(key);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(body);
    return;
  }

  res.redirect(302, await storage.signedUrl(key, 3600));
});

/**
 * JUnit XML for any CI's native reporting (§6).
 *
 * ── Quarantine, which this document used to contradict itself about ─────────
 *
 * Every non-passing, non-skipped result got a `<failure>`, so a quarantined
 * test's failure went red in Jenkins, GitLab, CircleCI, Azure and every other
 * build that parses this — a build the gate had already cleared. These bytes
 * are the one output read by machines nobody here controls, so there is exactly
 * one writer of them (the CLI's `--reporter junit` fetches this endpoint rather
 * than rendering its own) and the rule has to be right here.
 *
 * A suppressed failure is rendered `<skipped>` — the only element in JUnit that
 * means "do not fail the build on this" — and the MESSAGE is what keeps it from
 * being mistaken for a deliberate skip. It opens with QUARANTINED FAILURE and
 * carries the real error, and the run-level count appears as a property, so a
 * human reading the test report in their CI sees the failure and the reason it
 * did not count. A `<skipped/>` with no message would have been the same defect
 * wearing a kinder word.
 *
 * `failures` on the testsuite is `failedCount`, which no longer counts
 * suppressed failures, so the attribute and the elements finally agree.
 */
runsRouter.get('/:runId/junit.xml', async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    include: {
      results: {
        include: {
          test: { select: { name: true, quarantined: true, quarantineExpiresAt: true } },
        },
      },
    },
  });
  if (!run) throw notFound('Run');

  const escape = (v: string) =>
    v.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );

  const now = new Date();
  let suppressed = 0;

  const cases = run.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const name = escape(r.test.name);
      if (r.status === 'PASSED') return `    <testcase name="${name}" time="${time}"/>`;
      if (r.status === 'SKIPPED')
        return `    <testcase name="${name}" time="${time}"><skipped/></testcase>`;

      if (quarantineSuppresses(r.test, now)) {
        suppressed += 1;
        const why = escape(
          `QUARANTINED FAILURE — this test FAILED and its failure is suppressed by quarantine, ` +
            `so it did not fail the build. It is not a skipped test: it ran, and it failed. ` +
            `${r.errorMessage ?? 'failed'}`,
        );
        return (
          `    <testcase name="${name}" time="${time}">` +
          `<skipped message="${why}"/>` +
          `<system-out>${why}</system-out>` +
          `</testcase>`
        );
      }

      return `    <testcase name="${name}" time="${time}"><failure message="${escape(
        r.errorMessage ?? 'failed',
      )}"/></testcase>`;
    })
    .join('\n');

  /*
   * A `<properties>` block rather than an extra attribute on `<testsuite>`.
   * Properties are part of the format every parser already walks; a
   * non-standard attribute is the kind of thing a strict reader rejects, and a
   * JUnit file one CI refuses to parse is worse than one that undercounts.
   */
  const properties =
    `    <properties>\n` +
    `      <property name="qaai.quarantinedFailures" value="${run.quarantinedFailedCount}"/>\n` +
    `      <property name="qaai.quarantinedFailuresInThisDocument" value="${suppressed}"/>\n` +
    `    </properties>`;

  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="qaai" tests="${run.totalCount}" failures="${run.failedCount}" skipped="${run.skippedCount}">\n${properties}\n${cases}\n  </testsuite>\n</testsuites>\n`,
    );
});
