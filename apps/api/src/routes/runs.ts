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
 *   failFast      stop at the first real failure — accepted, not yet enforced
 *
 * Nothing about the default path changed: a POST that asks for none of them
 * loads the same column, queues the same job and executes the same suite it
 * always has.
 *
 * WHERE a run executes is decided here too, and it is a branch rather than an
 * option: `Environment.runnerPool` set means the suite is handed to the
 * customer's own agents (lib/runners.ts) and NOTHING is enqueued on our queue;
 * null means the queue, exactly as before. `Run.runnerPool` records which, and
 * it is what stops a run being executed twice, once in each place.
 */

import { Router } from 'express';
import { FIXTURE_PREFIX, QUEUE_NAMES, createRunSchema } from '@qaai/shared';
import type { ShardAssignment, ShardPlan, ShardedRunJob, TestType } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, notFound, planLimit } from '../lib/errors.js';
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
    priorRows.map(
      (row): PriorPass => ({
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
      }),
    ),
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
    runnersOnline: assessPool(
      { testTypes: [], browsers: [], toolchains: [] },
      args.pool,
      fleet,
    ).online,
    warning,
  };
}

runsRouter.post('/', requireRole('MEMBER'), requireScope('runs:write'), async (req, res) => {
  const actor = actorOf(req);
  const input = createRunSchema.parse(req.body);

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
      totalCount: testIds.length,
      shardCount: grantedShards,
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
      ...(failFast.requested ? { failFast: { enforced: failFast.enforced } } : {}),
    },
  });

  res.status(202).json({
    run,
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
    // Echoed even though it changed nothing, precisely because it changed
    // nothing: silently accepting a flag is how a caller comes to believe their
    // runs stop early when every one of them has been running to the end.
    ...(failFast.requested ? { failFast } : {}),
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
  res.json({ run });
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

/** JUnit XML for any CI's native reporting (§6). */
runsRouter.get('/:runId/junit.xml', async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    include: { results: { include: { test: { select: { name: true } } } } },
  });
  if (!run) throw notFound('Run');

  const escape = (v: string) =>
    v.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );

  const cases = run.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const name = escape(r.test.name);
      if (r.status === 'PASSED') return `    <testcase name="${name}" time="${time}"/>`;
      if (r.status === 'SKIPPED')
        return `    <testcase name="${name}" time="${time}"><skipped/></testcase>`;
      return `    <testcase name="${name}" time="${time}"><failure message="${escape(
        r.errorMessage ?? 'failed',
      )}"/></testcase>`;
    })
    .join('\n');

  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="qaai" tests="${run.totalCount}" failures="${run.failedCount}" skipped="${run.skippedCount}">\n${cases}\n  </testsuite>\n</testsuites>\n`,
    );
});
