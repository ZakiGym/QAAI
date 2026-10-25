/**
 * The scheduler tick (§6) — nightly runs and production monitors.
 *
 * One repeating job sweeps everything that is due rather than one timer per
 * schedule. That is deliberate: per-schedule timers drift, do not survive a
 * restart, and silently stop when a worker is replaced — a scheduler that
 * quietly stops is worse than no scheduler, because the green dashboard is a
 * lie about tests that never ran.
 *
 * Both kinds are idempotent under a double tick: a schedule advances its
 * `nextRunAt` before enqueuing, and a monitor stamps `lastCheckedAt` the same
 * way, so a retry cannot double-fire a run.
 *
 * ── Sharding ────────────────────────────────────────────────────────────────
 * A nightly suite is the single best candidate for a split in the product —
 * nothing is waiting on it, so the only cost of parallelism is worker slots
 * that are otherwise idle at 3am — and until now it was the one path that could
 * not ask for one, because it enqueues directly instead of going through the
 * API's create-run route. It asks now. See `planScheduledShards` below for how
 * the count is inferred, and for why "do not shard" is the answer whenever the
 * inference is unsure.
 */

import { CronExpressionParser } from 'cron-parser';
import { PLAN_LIMITS, parseSurfaceKey } from '@qaai/shared';
import type {
  CrawlAcceptanceState,
  ExploreJob,
  FlowMap,
  ReEnumerationRunState,
  ReEnumerationTriggerKind,
  ScheduleTickJob,
  ShardAssignment,
} from '@qaai/shared';
import {
  FlowDiffRefused,
  diffFlowMaps,
  driftWorthAnnouncing,
  type FlowDiff,
  type FlowDiffSide,
  type TestedRoutes,
} from '@qaai/agent';
/*
 * The ONE definition of "is this test's quarantine in force right now"
 * (packages/runner/src/gates.ts). Imported rather than restated because the
 * fail-fast sweep below is a new reader of the same rule, and a second copy of
 * it is how a quarantined test's failure came to be counted by the run's
 * counters while being invisible to every gate.
 */
import { quarantineSuppresses } from '@qaai/runner';
// The run toll — the plan gate and the usage counter — lives in the API
// workspace because six other places create Runs too and there must be exactly
// one of it. It takes its Prisma client as an argument precisely so this file
// can call it; nothing in it touches the API's env or its tenancy layer.
import { effectivePlan, startRun } from '../../../api/src/lib/start-run.js';
import { logger, prisma } from '../context.js';
import { enqueueRun, enqueueNotify, enqueueExplore } from '../queues.js';
import { advanceClosureCampaigns } from './close-loop.js';

/** Next fire time for a cron expression, or null when it is unparseable. */
function nextFireTime(cron: string, timezone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

// ─── Splitting a scheduled run (§5) ──────────────────────────────────────────
//
// NOTE FOR WHOEVER OWNS packages/shared: everything between here and queueRun
// is a port of the packer in apps/api/src/routes/runs.ts. It is duplicated
// rather than imported because that logic lives inside an Express route module
// in another workspace, and importing it would drag the API's Prisma client and
// middleware into the worker. It belongs in @qaai/shared, called by both. Until
// it moves, a change to one packer is a bug in the other.

/** How many recent results per test to average. Matches the API's packer. */
const RECENT_RESULTS_PER_TEST = 5;

/**
 * The wall clock one shard should aim for.
 *
 * This is the whole auto-sizing rule: predict the suite, divide by this, and
 * that is how many workers to ask for. Four minutes is chosen against the fixed
 * cost of a shard — a queue hop and a browser cold start, a handful of seconds
 * — so a shard always has substantially more work in it than overhead, while a
 * forty-minute nightly still fans out far enough to hit any plan's ceiling.
 */
const TARGET_SHARD_MS = 4 * 60_000;

/**
 * Recent per-test duration, in ms, for the tests about to run.
 *
 * Carries the API packer's one approximation deliberately: it takes the most
 * recent `tests × 5` results rather than five per test, because Prisma cannot
 * limit per group without raw SQL. Results are written a whole run at a time,
 * so ordering by `createdAt desc` walks backwards run by run and the window
 * lands on roughly the last five runs of this suite — which is the window
 * wanted. A newly added test simply has fewer samples.
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
 * each test to whichever shard is currently least loaded. Round-robin balances
 * *counts*, and a suite is never uniform — one 12-minute journey test and
 * thirty 4-second smoke tests round-robined across four shards leaves three
 * shards idle after half a minute and one still running at twelve, so the run
 * still takes twelve. LPT puts the long test down first and fills in around it.
 *
 * Ties break on test id so the same suite splits the same way twice; a nightly
 * that shards differently every night is one nobody can compare against itself.
 */
function packShards(
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
 * The org's parallel-worker ceiling — PLAN_LIMITS, resolved the way billing does.
 *
 * `effectivePlan` is now imported rather than restated: a seeded org's
 * Organization.plan, a past-due subscription dropping to free limits, and an
 * org that never had a subscription at all are all the same three-line rule,
 * and two copies of it is how the run cap ended up enforced in two places out
 * of seven.
 */
async function maxParallelWorkersFor(orgId: string): Promise<number> {
  const [subscription, org] = await Promise.all([
    prisma.subscription.findUnique({ where: { orgId }, select: { plan: true, status: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  ]);

  const { effective } = effectivePlan(subscription, org?.plan ?? null);
  return PLAN_LIMITS[effective].maxParallelWorkers;
}

/**
 * Decide whether this run is worth splitting, and into how many slices.
 *
 * Unlike the API — where a caller asks for a number and the endpoint only
 * clamps it — nobody types a shard count into a cron entry, so the number has
 * to be inferred from what the suite has historically cost.
 *
 * The inference is asymmetric on purpose. Returning null means "run it the way
 * it has always run", which is a behaviour that has shipped for the life of the
 * product; sharding on a bad guess spends worker slots that a monitor will ask
 * for again in fifteen minutes, and on a small plan it can starve the runs
 * someone is actually waiting on. So every uncertain case declines to split.
 *
 * Returns null for "do not shard", or the packed assignments.
 */
async function planScheduledShards(
  orgId: string,
  testIds: string[],
): Promise<ShardAssignment[] | null> {
  // Never more shards than tests: an empty shard is a queue job, a worker slot
  // and a database row that exist to run nothing.
  if (testIds.length < 2) return null;

  const costs = await recentDurations(testIds);
  const fallback = median([...costs.values()]);

  /*
   * No timing history at all — this suite's first scheduled run, or its first
   * since the results were pruned. The API falls back to a flat 30s per test
   * here because a human explicitly asked to shard; nobody asked for this one,
   * and fanning a 200-test suite out to a plan ceiling on the strength of a
   * constant is exactly the guess not worth making. It runs unsharded once and
   * has real numbers to split on from the next tick.
   */
  if (fallback === null) return null;

  const estimatedMs = testIds.reduce((sum, id) => sum + (costs.get(id) ?? fallback), 0);
  const desired = Math.ceil(estimatedMs / TARGET_SHARD_MS);

  // A suite that already finishes inside one shard's target. This is why most
  // monitors will never shard — a 40-second smoke check every 15 minutes is not
  // made better by four browsers — and why nightlies almost always will.
  if (desired < 2) return null;

  const granted = Math.max(
    1,
    Math.min(desired, await maxParallelWorkersFor(orgId), testIds.length),
  );
  if (granted < 2) return null;

  return packShards(testIds, costs, granted, fallback);
}

/**
 * Queue a run of a suite, returning its id and how many shards it was split
 * across. Shared by both paths.
 *
 * Three outcomes rather than two. `null` still means "this suite has nothing to
 * run". `refused` is new: the org is at its monthly run cap, and this path — a
 * cron tick — must not throw about it. A schedule that throws into the queue
 * disappears into BullMQ's failed set and the customer's nightly silently stops
 * firing, which is a worse bug than the unlimited free runs this closes. So the
 * refusal comes back as a value and the tick reports it at warn, alongside the
 * line it already writes when a schedule fires.
 */
type QueuedRun = { id: string; shards: number };

async function queueRun(args: {
  orgId: string;
  projectId: string;
  environmentId: string;
  suiteId: string;
  trigger: 'SCHEDULE' | 'MONITOR';
}): Promise<QueuedRun | { refused: string } | null> {
  const tests = await prisma.test.findMany({
    where: {
      orgId: args.orgId,
      projectId: args.projectId,
      disabledAt: null,
      suiteId: args.suiteId,
      filePath: { not: { startsWith: 'fixtures/' } },
    },
    select: { id: true },
  });
  if (tests.length === 0) return null;
  const testIds = tests.map((t) => t.id);

  /*
   * The split, decided before anything is written so the run row, the result
   * rows and the queue jobs all agree about it from the moment they exist.
   *
   * Caught, not propagated. A schedule that cannot work out how to shard must
   * still fire: a timing query that times out or a plan lookup that hits a
   * database blip drops this run back to the single job it would have been
   * before, because a nightly that did not run at all is far worse than one
   * that took the long route.
   */
  const assignments = await planScheduledShards(args.orgId, testIds).catch((err) => {
    logger.warn(
      { err, orgId: args.orgId, suiteId: args.suiteId },
      'could not plan a shard split; running this one unsharded',
    );
    return null;
  });

  const shardCount = assignments?.length ?? 1;
  const sharded = assignments != null && shardCount > 1;
  const shardOfTest = new Map<string, number>();
  for (const assignment of assignments ?? []) {
    for (const testId of assignment.testIds) shardOfTest.set(testId, assignment.index);
  }

  /*
   * Gate, create, count. Until this call existed, a schedule created its Run
   * directly: a nightly on a FREE account ran an unlimited number of browsers a
   * month, and because the counter never moved, POST /runs never refused that
   * org either. This is the path that made the free tier's only real ceiling
   * decorative.
   */
  const started = await startRun({
    db: prisma,
    orgId: args.orgId,
    mode: 'advisory',
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      suiteId: args.suiteId,
      trigger: args.trigger,
      totalCount: testIds.length,
      shardCount,
      results: {
        create: testIds.map((testId) => ({
          orgId: args.orgId,
          testId,
          status: 'SKIPPED' as const,
          // Null unless sharded — the run processor reads null as "run
          // everything", which is the path every scheduled run took until now.
          shardIndex: sharded ? (shardOfTest.get(testId) ?? 0) : null,
        })),
      },
      // The durable record of the split, written in the same statement as the
      // run: a run whose shard rows are missing is a run that can never decide
      // it has finished, and the processor refuses to execute a slice whose
      // membership it cannot read.
      ...(sharded
        ? {
            shards: {
              create: assignments.map((assignment) => ({
                orgId: args.orgId,
                index: assignment.index,
                total: shardCount,
                testCount: assignment.testIds.length,
                estimatedMs: assignment.estimatedMs,
              })),
            },
          }
        : {}),
    },
  });

  if (!started.created) {
    return { refused: started.quota.reason ?? 'This org is at its monthly run limit.' };
  }
  const run = started.run;

  if (!sharded) {
    await enqueueRun({ orgId: args.orgId, runId: run.id });
    return { id: run.id, shards: 1 };
  }

  /*
   * One job per shard, each carrying only its own index. The payload stays ids:
   * the processor re-reads its slice from `TestResult.shardIndex`, so a job that
   * waits in the queue while someone disables a test still does the right thing.
   */
  const queued = await Promise.allSettled(
    assignments.map((assignment) =>
      enqueueRun({
        orgId: args.orgId,
        runId: run.id,
        shard: { index: assignment.index, count: shardCount },
      }),
    ),
  );

  const lost = assignments.filter((_, i) => queued[i]!.status === 'rejected');
  if (lost.length > 0) {
    /*
     * A slice whose job never reached the queue will never run, and nothing
     * would ever ask after it — the reaper only wakes for a RUNNING shard that
     * went quiet, and a QUEUED shard is deliberately left alone because it may
     * simply be waiting behind a busy pool. Marking these terminal now is what
     * lets the surviving shards finalise: the run reports ERRORED and names the
     * slices whose tests did not execute, instead of sitting open forever with
     * a partial, green-looking result underneath it.
     */
    await prisma.runShard.updateMany({
      where: { orgId: args.orgId, runId: run.id, index: { in: lost.map((a) => a.index) } },
      data: {
        status: 'ABANDONED',
        finishedAt: new Date(),
        errorMessage: 'This shard could not be queued, so the tests in it never ran.',
      },
    });
    logger.error(
      { runId: run.id, shards: lost.map((a) => a.index), of: shardCount },
      'shard jobs could not be queued; their tests will not run',
    );
  }

  if (lost.length === assignments.length) {
    /*
     * Every slice failed, so no shard will ever finish and call the completion
     * rule, and the stalled-run sweep only looks at runs that reached RUNNING.
     * Closing it here is the difference between a visible failure and a row
     * that says QUEUED for the rest of time.
     */
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'ERRORED',
        finishedAt: new Date(),
        finalizedAt: new Date(),
        errorMessage: 'No shard of this run could be queued, so none of its tests ran.',
      },
    });
  }

  return { id: run.id, shards: shardCount };
}

// ─── Fail-fast and the stop request (§5) ─────────────────────────────────────
//
// THE DEFECT, VERBATIM: "Enforce fail-fast and the stop request in the worker —
// the column, the migration, the endpoint and the user-facing promise all exist;
// the consumer does not, so a stop request is ignored."
//
// Four surfaces already promise this. `createRunSchema` accepts `failFast`;
// POST /runs reports it back; `Run.failFast` / `Run.stopRequestedAt` /
// `Run.stopReason` are columns with a migration behind them; and
// POST /team/runs/:runId/stop writes the request and tells the caller the worker
// "checks between tests". Nothing wrote `failFast` onto a run row, and nothing
// anywhere read `stopRequestedAt`.
//
// ── WHY THE PRODUCER IS HERE AND THE CONSUMER IS NOT ────────────────────────
//
// There are two halves to enforcing fail-fast, and they belong in different
// files:
//
//   THE DECISION — "this fail-fast run has already had a real failure, so it
//   should stop" — is a query plus a rule, and it is what this sweep does. It
//   writes `stopRequestedAt` with the same conditional, first-writer-wins
//   UPDATE that POST /team/runs/:runId/stop uses, so a human pressing stop and
//   this sweep tripping on the same run cannot produce two different stories.
//
//   THE STOP ITSELF belongs in the between-tests poll in
//   apps/worker/src/processors/run.ts, which reads `status` and `finalizedAt`
//   and nothing else. That file is owned by another agent this round. The exact
//   change is three lines and it is named in this change's handover; until it
//   lands, this sweep writes a request that the run loop does not yet read, and
//   NOTHING HERE PRETENDS OTHERWISE — `planFailFast` in
//   apps/api/src/lib/run-selection.ts still reports `enforced: false`, and the
//   POST /runs response still says so.
//
// Writing the request anyway is not theatre: the column is what the cockpit, the
// share page and the audit row already render, and the sweep makes a fail-fast
// run SAY that it should have stopped — at the first failure rather than after
// the other 4,999 tests — which is strictly better than the silence it replaces.
//
// ── WHY A 60-SECOND SWEEP AND NOT AN INLINE CHECK ───────────────────────────
//
// An inline check after each test would be instant, and it is the right place
// for it — in run.ts, in the same loop, in the same change that makes the loop
// read the column. A sweep is what can be built from outside that file, and it
// has one genuine advantage worth keeping afterwards: it catches a fail-fast run
// whose worker died holding it, which an inline check by definition cannot.

/**
 * How many runs one sweep may consider.
 *
 * Bounded because this runs inside the 60-second tick alongside the cron
 * schedules and the production monitors: an install with a thousand concurrent
 * fail-fast runs must not be able to turn one tick into a long job that starves
 * them. Only runs that are QUEUED or RUNNING are ever read, so on a healthy
 * install the real number is tiny and the cap never bites.
 */
export const FAIL_FAST_SWEEP_LIMIT = 200;

/**
 * How many of one run's failed results the sweep reads looking for the first
 * REAL one.
 *
 * ── WHY THERE IS A NUMBER HERE AT ALL ──────────────────────────────────────
 *
 * Because the question is not "did anything fail" — the `where` answers that —
 * it is "did anything fail in a way that COUNTS", and whether a failure counts
 * is decided by `failFastTripped`, a function. Quarantine is a property of the
 * Test row and its expiry is compared against the clock, so a `where` clause
 * that tried to express the rule would be a second copy of
 * `quarantineSuppresses` written in Prisma, free to drift from the first. So
 * rows are read and the function is asked, and reading rows needs a bound.
 *
 * ── WHY 25 WAS A LIE AND 200 IS NOT ────────────────────────────────────────
 *
 * The bound was 25, hard-coded and silent. A fail-fast run whose first 25
 * FAILED/TIMED_OUT rows were all quarantined or retried-into-passes was never
 * asked to stop — and because the sweep re-reads the same oldest 25 every sixty
 * seconds, never would be, however many real failures sat at row 26. Nothing
 * counted the truncation and nothing reported it: the run simply ran to the end
 * while the API had told its owner it would not.
 *
 * 200 is the same order as FAIL_FAST_SWEEP_LIMIT and four small columns wide,
 * so it costs one bounded query per run. What matters more than the number is
 * that one row PAST it is fetched, so the sweep can tell "no real failure in
 * this run" from "no real failure in the part of it I looked at" — and when it
 * is the second, it says so and counts it (`undecided`) instead of returning a
 * silence that reads like the first.
 */
export const FAIL_FAST_FAILURE_SCAN_LIMIT = 200;

/** What one sweep did, including the part it could not decide. */
export interface FailFastSweep {
  /** Runs asked to stop. */
  requested: number;
  /**
   * Runs where the scan hit FAIL_FAST_FAILURE_SCAN_LIMIT without finding a real
   * failure, so "not stopped" means "not established", not "nothing to find".
   * Counted because a suppressed failure is still a failure that was not
   * counted, and that is the one thing this sweep may not do silently.
   */
  undecided: number;
}

/** The sentence written onto `Run.stopReason`, read verbatim by three surfaces. */
export function failFastStopReason(testName: string | null): string {
  return testName
    ? `Fail-fast: "${testName}" failed, so the rest of this run was not executed.`
    : 'Fail-fast: a test failed, so the rest of this run was not executed.';
}

/**
 * Does this result trip fail-fast?
 *
 * Deliberately the same shape as `isRealFailure` in
 * apps/api/src/lib/run-selection.ts, and the two conditions are the two ways
 * this could otherwise stop a run it has no business stopping:
 *
 *   A RETRY THAT PASSED is not a failure. `retriedAndPassed` exists because a
 *   test that failed once and passed on retry is flaky, not broken, and halting
 *   a 5,000-test suite on a flake is the single fastest way to make people turn
 *   this feature off.
 *
 *   A QUARANTINED FAILURE is a failure somebody has explicitly switched off.
 *   It does not reach `Run.failedCount`, it does not gate, and it must not stop
 *   a run either — otherwise quarantine would suppress a failure everywhere
 *   except the one place where it ends the build early.
 *
 * TIMED_OUT counts. A test that ran out of time did not pass, and "the suite
 * stopped because something hung" is exactly the signal fail-fast is for.
 */
export function failFastTripped(
  result: {
    status: string;
    retriedAndPassed: boolean;
    test: { quarantined: boolean; quarantineExpiresAt: Date | null };
  },
  now: Date,
): boolean {
  if (result.status !== 'FAILED' && result.status !== 'TIMED_OUT') return false;
  if (result.retriedAndPassed) return false;
  return !quarantineSuppresses(result.test, now);
}

/**
 * Ask every fail-fast run that has already failed to stop.
 *
 * Returns how many requests were written. Never throws: a run whose stop could
 * not be requested is a run that finishes normally, which is the behaviour that
 * has shipped for the life of the product — while a throw here would take the
 * whole scheduler tick down and with it every nightly and every monitor in the
 * install.
 */
async function sweepFailFastStops(now: Date): Promise<FailFastSweep> {
  const sweep: FailFastSweep = { requested: 0, undecided: 0 };
  let candidates: Array<{ id: string; orgId: string }> = [];
  try {
    candidates = await prisma.run.findMany({
      where: {
        failFast: true,
        // Already asked. Idempotent by construction: the row is only ever
        // written once, by whoever gets there first.
        stopRequestedAt: null,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      take: FAIL_FAST_SWEEP_LIMIT,
      select: { id: true, orgId: true },
    });
  } catch (err) {
    logger.error({ err }, 'could not read fail-fast runs this tick');
    return sweep;
  }

  for (const run of candidates) {
    try {
      /*
       * The FIRST real failure, in the order the results were written, because
       * the reason on the row names a test and the test it should name is the
       * one that tripped it. `take` is bounded rather than `findFirst`-with-a
       * -filter on quarantine, because quarantine is a property of the Test row
       * and the suppression rule is a function, not a query — a `where` clause
       * that tried to express it would be a second copy of
       * `quarantineSuppresses` written in Prisma.
       *
       * ONE ROW PAST THE LIMIT, which is the whole fix: it is the difference
       * between a cap and a disclosed cap. See FAIL_FAST_FAILURE_SCAN_LIMIT.
       */
      const page = await prisma.testResult.findMany({
        where: { runId: run.id, status: { in: ['FAILED', 'TIMED_OUT'] } },
        orderBy: { createdAt: 'asc' },
        take: FAIL_FAST_FAILURE_SCAN_LIMIT + 1,
        select: {
          status: true,
          retriedAndPassed: true,
          test: { select: { name: true, quarantined: true, quarantineExpiresAt: true } },
        },
      });
      const truncated = page.length > FAIL_FAST_FAILURE_SCAN_LIMIT;
      const failures = truncated ? page.slice(0, FAIL_FAST_FAILURE_SCAN_LIMIT) : page;

      const tripped = failures.find((result) => failFastTripped(result, now));
      if (!tripped) {
        /*
         * NOT ESTABLISHED, which is not the same as nothing to find, and the
         * difference is counted rather than swallowed. Every row read was a
         * failure that something suppressed, and there are more of them past
         * the limit this sweep agreed to read — so this run is not being left
         * alone because it is healthy.
         *
         * Logged at WARN with both numbers, because the operator-visible
         * symptom otherwise is a fail-fast run that quietly ran to the end.
         */
        if (truncated) {
          sweep.undecided += 1;
          logger.warn(
            {
              runId: run.id,
              orgId: run.orgId,
              scanned: FAIL_FAST_FAILURE_SCAN_LIMIT,
              limit: FAIL_FAST_FAILURE_SCAN_LIMIT,
            },
            'fail-fast undecided: every failure read was suppressed and more exist past the scan limit; this run was NOT asked to stop',
          );
        }
        continue;
      }

      /*
       * Conditional, so the first writer wins and the reason on the row names
       * whoever actually stopped it. This sweep and a person pressing stop in
       * the cockpit can race, and the run must end up with one story — the same
       * claim POST /team/runs/:runId/stop makes, deliberately written the same
       * way.
       *
       * `status` is NOT touched. A fail-fast stop is a FAILED run that chose not
       * to finish; filing it as CANCELLED would hide a broken build behind a
       * word that means "nobody wanted the answer".
       */
      const claimed = await prisma.run.updateMany({
        where: { id: run.id, stopRequestedAt: null, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { stopRequestedAt: now, stopReason: failFastStopReason(tripped.test.name) },
      });
      if (claimed.count === 0) continue;

      sweep.requested += 1;
      logger.warn(
        { runId: run.id, orgId: run.orgId, test: tripped.test.name },
        'fail-fast tripped: stop requested',
      );
    } catch (err) {
      // Per run, so one unreadable run does not cost the other 199 theirs.
      logger.error({ err, runId: run.id }, 'could not request a fail-fast stop for this run');
    }
  }

  return sweep;
}

// ─── Re-enumeration: keeping the denominator fresh (§3.1) ────────────────────
//
// THE DEFECT: THE ONLY CRAWL TRIGGER IN THIS PRODUCT IS A HUMAN CLICKING A
// BUTTON.
//
// Everything above this line can only run a SUITE. `Schedule` runs one on a
// cron, `Monitor` runs one on an interval, and neither has ever been able to
// ask for an enumeration. So the surface we measure against is whatever the
// last person to press Explore happened to reach: the application grows four
// routes, the denominator does not move, the numerator does not move, and
// THE COVERAGE PERCENTAGE RISES. It fails silently and in the flattering
// direction, which for a product whose entire claim is the denominator is the
// worst available failure — and the staleness itself is invisible, because a
// trigger that has never fired and a trigger that found nothing look identical
// from the outside unless somebody stores the difference. `ReEnumerationTrigger
// .lastRunState` defaults to NEVER_RUN for exactly that reason, and nothing in
// this section ever infers "no drift" from a null timestamp.
//
// ── WHAT THIS FILE DOES AND WHAT IT DOES NOT ────────────────────────────────
//
// It is TWO HALVES, a tick apart, because a crawl is not synchronous: it holds
// a browser for minutes and lands on another queue.
//
//   FIRE    `fireReEnumeration` claims the trigger (RUNNING, before enqueuing,
//           the same claim-first order the cron schedules above use) and asks
//           for a crawl.
//   SETTLE  `settleReEnumerations` finds the map that landed, diffs it against
//           the previous one, writes the `SurfaceDriftRecord`, and raises the
//           new-surface event.
//
// THE FOUR TRIGGER KINDS ARE NOT ALL REACHABLE FROM HERE, and this is stated
// rather than discovered. SCHEDULE is driven by this tick, from its own cron.
// CI, DEPLOY and MANUAL are PUSHED — somebody else's build, webhook or click
// has to call in — so `fireReEnumeration` is exported and takes its producer as
// an argument, and the three inbound HTTP doors are named in this change's
// handover. Until they land, a CI or DEPLOY trigger sits at NEVER_RUN, which is
// the honest reading of a door that has not been built: it is NOT "no drift".
//
// ── WHY IT RIDES THIS TICK ──────────────────────────────────────────────────
//
// Same reason the two sweeps below do, and the same 60-second ceiling: a job
// whose own result decides whether it re-queues is the shape of a worker that
// never idles. Both halves are bounded, both disclose their bounds, and both
// are written so they cannot throw — a drift diff that blew up must not take a
// customer's uptime monitor down with it.

/**
 * How many SCHEDULE triggers one tick may consider.
 *
 * Bounded for the reason FAIL_FAST_SWEEP_LIMIT gives, and disclosed the way it
 * is: one row past the limit is fetched, so `ReEnumerationSweep.deferredByCap`
 * can say "at least one more was due and was not looked at" instead of
 * returning a silence that reads like "nothing was due".
 */
export const RE_ENUMERATION_SWEEP_LIMIT = 100;

/**
 * How many RUNNING triggers one tick may settle.
 *
 * Much smaller than the sweep limit, and the asymmetry is the cost: settling
 * reads TWO WHOLE `FlowMap.graph` blobs — a 400-route crawl with its forms and
 * affordances — and diffs them in process. Twenty is a few megabytes and a few
 * hundred milliseconds inside a tick that also owes a customer's nightly suite
 * its 3am slot. A trigger not settled this tick is settled next tick; it stays
 * RUNNING, which is true, and the deferral is counted.
 */
export const RE_ENUMERATION_SETTLE_LIMIT = 20;

/**
 * How long a trigger may sit RUNNING before its run is recorded as FAILED.
 *
 * There has to be a bound, because `enqueueExplore` pins ONE crawl per project
 * by job id: a trigger that fires while another crawl of the same project is in
 * flight has its job silently deduplicated by BullMQ, and without a timeout it
 * would sit RUNNING for ever — which reads on screen as "re-enumerating" and is
 * the staleness lie wearing a progress spinner.
 *
 * An hour, against a default crawl wall clock of fifteen minutes plus queue
 * wait. Generous on purpose: a FAILED run is a notice to a human, and crying
 * wolf at twenty minutes on a large application would train people to ignore it.
 */
export const RE_ENUMERATION_RUN_TIMEOUT_MS = 60 * 60_000;

/**
 * How many `CoverageItem` ROUTE rows are read to establish which routes have a
 * test.
 *
 * AND WHAT HAPPENS WHEN IT BITES, which is the only interesting part. A
 * TRUNCATED tested-route set under-states testedness, which OVER-states
 * `newSurfaceWithoutTests` — it would invent untested new surface out of routes
 * that are tested by a spec sitting at row 5,001. So hitting this limit does
 * not produce a partial answer: testedness comes back NULL, the count comes back
 * NULL, and the reason is on the row. A floor in the alarming direction is the
 * same sin as one in the flattering direction.
 */
export const RE_ENUMERATION_TESTED_ROUTE_LIMIT = 5_000;

/**
 * The audit actions this sweep writes, which is how the event reaches a human
 * today.
 *
 * DECLARED HERE AND NOT IN @qaai/shared, which is where `FLAKE_AUDIT_ACTIONS`
 * and `HEAL_AUDIT_ACTIONS` live and where these belong — that file is owned by
 * another change this round. Same shape of borrowing as `ANALYZE_SOURCE_QUEUE`
 * in queues.ts, and the same handover: move these two strings into
 * packages/shared/src/constants.ts beside the other audit-action maps, so the
 * API's audit-log reader can name what it renders without importing a worker
 * processor.
 */
export const RE_ENUMERATION_AUDIT_ACTIONS = {
  /** New surface with no test against it. THE event — see `driftWorthAnnouncing`. */
  newSurface: 'surface.drift.new_surface_untested',
  /**
   * A comparison that RAN and found no new untested surface.
   *
   * Its own action, and not a silence. "No drift" is only worth reading when
   * somebody can see that the comparison happened, and this is the row that
   * makes a quiet drift feed mean something other than "nobody looked".
   */
  compared: 'surface.drift.compared',
  /** A comparison that could not be made. Recorded so "no drift" is never inferred. */
  uncomparable: 'surface.drift.uncomparable',
} as const;

/** What one tick's re-enumeration work did, including the parts it could not do. */
export interface ReEnumerationSweep {
  /** Crawls asked for. */
  fired: number;
  /** Diffs written, comparable or not. */
  diffed: number;
  /**
   * Diffs whose counts are NULL because the comparison could not be made.
   * Counted SEPARATELY from `diffed` so a tick cannot report twelve diffs and
   * have eleven of them be "we could not tell" — which is the reading a single
   * number would give.
   */
  uncomparable: number;
  /** Diffs that found new surface with no tests, and raised the event. */
  announced: number;
  /** Runs recorded FAILED: the crawl never landed, or the diff could not run. */
  failed: number;
  /**
   * Runs whose crawl is still going. Left RUNNING, which is the true state.
   *
   * NOT folded into `deferredByCap`: a crawl in progress is work happening, and
   * a cap that bit is work refused. Reporting them as one number would make a
   * healthy install look capped and a capped one look busy.
   */
  inFlight: number;
  /**
   * Triggers a cap or a lock kept this tick from firing or settling.
   *
   * The disclosure half of every bound in this section. A trigger deferred is a
   * trigger whose denominator is still stale, so "0 fired" and "0 fired, 14
   * deferred" are completely different facts about an install.
   */
  deferredByCap: number;
  /** Why, named, so the number above is a measurement and not an adjective. */
  capsThatBit: string[];
}

const EMPTY_SWEEP: ReEnumerationSweep = {
  fired: 0,
  diffed: 0,
  uncomparable: 0,
  announced: 0,
  failed: 0,
  inFlight: 0,
  deferredByCap: 0,
  capsThatBit: [],
};

/** A trigger row, in the exact shape the rules below are entitled to read. */
export interface TriggerRow {
  id: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  name: string;
  kind: ReEnumerationTriggerKind;
  enabled: boolean;
  cron: string | null;
  timezone: string | null;
  lastRunState: ReEnumerationRunState;
  lastRunAt: Date | null;
  createdAt: Date;
}

/**
 * Is this SCHEDULE trigger due?
 *
 * ── THE ANCHOR, WHICH IS THE WHOLE RULE ─────────────────────────────────────
 *
 * `Schedule` above carries a `nextRunAt` column and a two-step arming dance:
 * first sight writes `nextRunAt` and fires nothing, so creating a nightly at 2pm
 * does not run it at 2pm. `ReEnumerationTrigger` HAS NO SUCH COLUMN, so dueness
 * is computed from the cron and an anchor, and the choice of anchor IS the
 * arming rule:
 *
 *   lastRunAt   once it has run. The next fire after the last one.
 *   createdAt   before it ever has. A trigger created at 2pm with an `0 3 * * *`
 *               cron is next due at 3am — which is the arming behaviour, for
 *               free and without a column.
 *
 * `new Date(0)` was the obvious alternative and is wrong: every cron's next
 * fire after 1970 is in the deep past, so every trigger would be due the
 * instant it was created and a crawl would start while somebody was still
 * typing the form.
 *
 * RUNNING is NOT due. One crawl per trigger at a time; the settle half owns a
 * RUNNING trigger until it resolves or times out. Without this a trigger with a
 * minutely cron would fire sixty crawls an hour at an application that is
 * answering one.
 */
export function reEnumerationIsDue(
  trigger: Pick<
    TriggerRow,
    'kind' | 'enabled' | 'cron' | 'timezone' | 'lastRunState' | 'lastRunAt' | 'createdAt'
  >,
  now: Date,
): { due: boolean; why: string } {
  if (!trigger.enabled) return { due: false, why: 'the trigger is disabled' };
  if (trigger.kind !== 'SCHEDULE') {
    // CI, DEPLOY and MANUAL are pushed, not polled. Returning false here is not
    // "nothing to do" — it is "this tick is not the thing that fires it".
    return { due: false, why: `a ${trigger.kind} trigger is fired by its caller, not by the tick` };
  }
  if (trigger.lastRunState === 'RUNNING') {
    return { due: false, why: 'a crawl for this trigger is already in flight' };
  }
  if (!trigger.cron) {
    return { due: false, why: 'a SCHEDULE trigger with no cron expression cannot be due' };
  }

  const next = nextFireTime(
    trigger.cron,
    trigger.timezone ?? 'UTC',
    trigger.lastRunAt ?? trigger.createdAt,
  );
  if (!next) return { due: false, why: `the cron expression "${trigger.cron}" is unparseable` };
  return next <= now
    ? { due: true, why: `due since ${next.toISOString()}` }
    : { due: false, why: `next due ${next.toISOString()}` };
}

/**
 * Claim a trigger and ask for a crawl.
 *
 * EXPORTED AND TAKING ITS PRODUCER AS AN ARGUMENT, because the three pushed
 * kinds come in somewhere this file cannot see: a CI step, a deploy webhook, a
 * person pressing a button. All four kinds must claim the trigger the same way
 * or two of them will race and the row will tell two stories.
 *
 * ── THERE ARE TWO IMPLEMENTATIONS OF THAT CLAIM, NOT ONE ────────────────────
 *
 * This comment used to say there was one, and that was wrong about its own
 * repository. `apps/api/src/routes/agent.ts` has its own copy — same `where`,
 * same `data`, same release-on-enqueue-failure — because apps/api does not
 * depend on apps/worker and cannot import a worker processor. So the reason
 * given above for exporting this function with an injectable producer describes
 * a caller that STRUCTURALLY CANNOT EXIST, and the `enqueue` parameter has no
 * caller outside this file's tests.
 *
 * The two copies agree today. They are free to stop agreeing, and the failure
 * is the one the comment was worried about: a deploy webhook and this tick
 * claiming the same row by two slightly different conditions, two crawls fired,
 * two drift records written for one change. Nothing in the build would catch
 * it, because neither copy can see the other.
 *
 * The honest home for the claim is `@qaai/shared`, which both apps already
 * depend on, taking a Prisma delegate and a producer. That edit spans two files
 * this change does not own and is in the handover; until it lands, a change to
 * the claim here is only half a change.
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 *
 * CONDITIONAL AND BEFORE THE ENQUEUE, which is the same order and the same
 * first-writer-wins `updateMany` the cron schedules above use and the fail-fast
 * sweep uses. The condition is the `lastRunAt` that was read, so two ticks — or
 * a tick and a deploy webhook — that see the same row produce ONE crawl. Losing
 * one cycle to a lost race is far better than firing two browsers at the
 * customer's application and writing two drift records for one change.
 *
 * ── maxPages: 0, maxDepth: 0, AND THEY ARE NOT PLACEHOLDERS ─────────────────
 *
 * The explore processor treats a non-positive `maxPages`/`maxDepth` as NO
 * CALLER OVERRIDE and lets `Environment.crawlPolicy` decide, clamped by the
 * plan. That is exactly what a re-enumeration wants: its whole job is to
 * refresh the denominator at the width the customer configured, and a
 * hard-coded 60 here would re-enumerate a 412-route application as 60 routes
 * every night and call the result drift.
 *
 * `autoApprove: false`, always. An unattended crawl that also generated and
 * approved tests is an autopilot nobody asked for.
 */
export async function fireReEnumeration(args: {
  trigger: TriggerRow;
  now: Date;
  /** Injected so the API's producer can drive the same claim. */
  enqueue?: (job: ExploreJob) => Promise<void>;
}): Promise<{ fired: true } | { fired: false; why: string }> {
  const { trigger, now } = args;
  const enqueue = args.enqueue ?? enqueueExplore;

  const claimed = await prisma.reEnumerationTrigger.updateMany({
    where: { id: trigger.id, lastRunAt: trigger.lastRunAt, lastRunState: { not: 'RUNNING' } },
    data: { lastRunState: 'RUNNING', lastRunAt: now },
  });
  if (claimed.count === 0) {
    return { fired: false, why: 'another caller claimed this trigger first' };
  }

  try {
    await enqueue({
      orgId: trigger.orgId,
      projectId: trigger.projectId,
      environmentId: trigger.environmentId,
      requestedBy: `re-enumeration:${trigger.id}`,
      maxPages: 0,
      maxDepth: 0,
      autoApprove: false,
    });
    return { fired: true };
  } catch (err) {
    /*
     * The claim is RELEASED, and this is the one place in this section where a
     * failure rolls back rather than being recorded. A trigger left RUNNING on
     * a crawl that was never queued would wait out
     * RE_ENUMERATION_RUN_TIMEOUT_MS and then be reported as a crawl that failed
     * — which is a fact about the customer's application. A queue that would
     * not take the job is a fact about US, so the row goes back to where it
     * was and the next tick tries again.
     */
    await prisma.reEnumerationTrigger
      .updateMany({
        where: { id: trigger.id, lastRunState: 'RUNNING' },
        data: { lastRunState: trigger.lastRunState, lastRunAt: trigger.lastRunAt },
      })
      .catch(() => {});
    logger.error(
      { err, triggerId: trigger.id, projectId: trigger.projectId },
      'could not queue a re-enumeration crawl; the trigger stays due',
    );
    return { fired: false, why: 'the crawl could not be queued' };
  }
}

/**
 * Which routes in this project have a test written against them, or NULL.
 *
 * Read off `CoverageItem`, which is the registry the rest of the product
 * already measures with, rather than re-extracting routes out of spec files:
 * a second answer to "does this route have a test" is a second number that will
 * eventually disagree with the one on the coverage screen.
 *
 * ── UNCOVERED IS THE ONLY STATUS THAT SUPPORTS THE SENTENCE ─────────────────
 *
 * The sentence being built is "this new route has NO test". Of the five
 * statuses only UNCOVERED asserts that. COVERED and ASSERTED_NOT_RUN have one;
 * WAIVED was deliberately taken out of the denominator by a human; and UNKNOWN
 * means a test navigates to a URL built at run time and MIGHT be the only test
 * covering this route — surface-coverage.ts's rule 2, which this function is a
 * reader of rather than a second opinion about. So anything that is not
 * UNCOVERED is treated as "do not claim this one is untested".
 *
 * ── TWO WAYS IT RETURNS NULL, BOTH OF THEM HONEST ───────────────────────────
 *
 *   NO ROUTE ITEMS AT ALL  coverage has never been computed for this project,
 *                          so there is no testedness to read. Returning an
 *                          empty list instead would report every route in the
 *                          application as untested new surface — true-sounding,
 *                          unfounded, and the loudest possible first
 *                          impression.
 *   THE LIMIT BIT          the set would be partial, which over-states the
 *                          count. See RE_ENUMERATION_TESTED_ROUTE_LIMIT.
 */
async function testedRoutesFor(args: {
  orgId: string;
  projectId: string;
}): Promise<{ tested: TestedRoutes; why: string | null }> {
  const rows = await prisma.coverageItem.findMany({
    where: { orgId: args.orgId, projectId: args.projectId, kind: 'ROUTE' },
    take: RE_ENUMERATION_TESTED_ROUTE_LIMIT + 1,
    select: { key: true, status: true },
  });

  if (rows.length > RE_ENUMERATION_TESTED_ROUTE_LIMIT) {
    return {
      tested: null,
      why:
        `this project has more than ${RE_ENUMERATION_TESTED_ROUTE_LIMIT} route items, so which ` +
        'routes have tests was not established for this diff — the count is NOT zero',
    };
  }
  if (rows.length === 0) {
    return {
      tested: null,
      why:
        'coverage has never been computed for this project, so which routes have tests could ' +
        'not be read — the count is NOT zero',
    };
  }

  const tested: string[] = [];
  for (const row of rows) {
    if (row.status === 'UNCOVERED') continue;
    // `parseSurfaceKey` and not `key.slice(6)`: the `KIND:identity` format has
    // exactly one parser and a route containing a colon must not be shortened
    // by a second one.
    const parsed = parseSurfaceKey(row.key);
    if (parsed?.kind === 'ROUTE') tested.push(parsed.identity);
  }
  return { tested, why: null };
}

/** A stored FlowMap row, read as one side of a diff. */
interface MapRow {
  id: string;
  version: number;
  environmentId: string;
  acceptance: CrawlAcceptanceState | null;
  graph: unknown;
}

function sideOf(row: MapRow): FlowDiffSide {
  return {
    flowMapId: row.id,
    version: row.version,
    environmentId: row.environmentId,
    acceptance: row.acceptance,
    // The graph is a JSON column. `diffFlowMaps` reads it defensively — every
    // array on it is optional on the way in — precisely so a map written by an
    // older crawler narrows the comparison instead of throwing inside this tick.
    map: (row.graph ?? { nodes: [] }) as FlowMap,
  };
}

/**
 * Settle one RUNNING trigger: find the crawl, diff it, record it, raise it.
 *
 * Returns the deltas this one trigger contributed, so the caller's accounting is
 * a sum and not a set of mutations.
 */
async function settleOneTrigger(
  trigger: TriggerRow,
  now: Date,
): Promise<Partial<ReEnumerationSweep>> {
  const firedAt = trigger.lastRunAt;
  if (!firedAt) {
    // RUNNING with no `lastRunAt` cannot happen through `fireReEnumeration`,
    // which writes both in one statement. If it is in the database anyway, the
    // row is corrupt rather than the crawl being slow, and guessing an anchor
    // would diff against whatever map happened to be newest.
    await prisma.reEnumerationTrigger.update({
      where: { id: trigger.id },
      data: {
        lastRunState: 'FAILED',
        lastFailureMessage:
          'This run was recorded as in flight with no start time, so the crawl it asked for cannot be identified.',
        consecutiveFailures: { increment: 1 },
      },
    });
    return { failed: 1 };
  }

  /*
   * THE MAP THIS RUN PRODUCED: the newest one for this environment that landed
   * after we asked.
   *
   * "After we asked" and not "the one our job wrote", because there is no link
   * from an ExploreJob back to a FlowMap row and `enqueueExplore` pins one crawl
   * per project — so if a human pressed Explore in the same minute, BullMQ gave
   * us THEIR crawl and it is, as far as this trigger is concerned, the crawl it
   * asked for. Attributing it is correct; inventing a second crawl would not be.
   *
   * NO `acceptance` FILTER, deliberately, and the reason is worth stating
   * because its absence looks like an oversight. A crawl held as CANDIDATE or
   * REJECTED still RAN: it is the crawl this trigger asked for, and skipping
   * past it to an older accepted map would attribute somebody else's
   * enumeration to this run. Whether it may be COMPARED FROM is a different
   * question and not this query's to answer — `diffFlowMaps` adjudicates both
   * sides and returns NOT_COMPARED for a held current crawl, so the columns
   * below stay NULL and the reason reaches the row. Filtering here instead would
   * make a held crawl look like a crawl that never landed, and this function
   * would then report a timeout that did not happen.
   */
  const current = await prisma.flowMap.findFirst({
    where: { environmentId: trigger.environmentId, createdAt: { gte: firedAt } },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, environmentId: true, acceptance: true, graph: true },
  });

  if (!current) {
    if (now.getTime() - firedAt.getTime() < RE_ENUMERATION_RUN_TIMEOUT_MS) {
      // Still crawling. Left RUNNING, which is the true state, and counted so
      // a tick that settled nothing can say whether it was waiting or stuck.
      return { inFlight: 1 };
    }
    await prisma.reEnumerationTrigger.update({
      where: { id: trigger.id },
      data: {
        lastRunState: 'FAILED',
        /*
         * A CURATED SENTENCE AND NEVER `String(err)`. This column is rendered
         * to the customer, and a crawl failure's message can carry the base URL
         * it was reaching — which on an environment configured with a bypass
         * token or a session in the query string would put a credential on
         * screen. The diagnostic detail goes to the log; the row gets a
         * sentence somebody can act on.
         */
        lastFailureMessage:
          `No crawl of this environment completed within ${Math.round(
            RE_ENUMERATION_RUN_TIMEOUT_MS / 60_000,
          )} minutes of this trigger firing, so the surface was NOT re-enumerated and the ` +
          'denominator is still the previous crawl’s.',
        consecutiveFailures: { increment: 1 },
      },
    });
    logger.warn(
      { triggerId: trigger.id, environmentId: trigger.environmentId, firedAt },
      're-enumeration timed out: no crawl landed, so the denominator is still stale',
    );
    return { failed: 1 };
  }

  /*
   * THE BASELINE: the version immediately before this one.
   *
   * IMMEDIATELY BEFORE, and deliberately not "the newest ACCEPTED one". If the
   * previous crawl was held as a CANDIDATE, the honest answer is
   * UNCOMPARABLE_BASELINE_NOT_ACCEPTED — and `diffFlowMaps` says exactly that.
   * Skipping back to an older accepted map would quietly make the diff span two
   * crawls and report the candidate's additions as this crawl's drift, which is
   * a real number attached to the wrong event.
   */
  const baseline = await prisma.flowMap.findFirst({
    where: { environmentId: trigger.environmentId, version: { lt: current.version } },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, environmentId: true, acceptance: true, graph: true },
  });

  const { tested, why: testedWhy } = await testedRoutesFor(trigger);

  let diff: FlowDiff;
  try {
    diff = diffFlowMaps({
      current: sideOf(current),
      baseline: baseline ? sideOf(baseline) : null,
      tested,
    });
  } catch (err) {
    if (!(err instanceof FlowDiffRefused)) throw err;
    /*
     * Two environments. This cannot happen through the queries above — both
     * filter on `trigger.environmentId` — so reaching here means a FlowMap row
     * carries an environmentId its own index disagrees with. Recorded as FAILED
     * and NOT as a drift record: there is no honest row to write, which is the
     * entire reason `diffFlowMaps` throws instead of returning one.
     */
    await prisma.reEnumerationTrigger.update({
      where: { id: trigger.id },
      data: {
        lastRunState: 'FAILED',
        lastFailureMessage:
          'The two crawls this diff was given belong to different environments, so no ' +
          'comparison was made. Nothing about drift is being claimed.',
        consecutiveFailures: { increment: 1 },
      },
    });
    logger.error({ err, triggerId: trigger.id }, 'refused a cross-environment drift diff');
    return { failed: 1 };
  }

  /*
   * IDEMPOTENT BY (map, trigger). A tick that dies between writing the record
   * and updating the trigger leaves the trigger RUNNING, and the next tick
   * would otherwise write a second identical drift record and raise the event
   * twice. Keyed on the TRIGGER too, because two triggers on one environment —
   * a nightly SCHEDULE and a DEPLOY webhook — may each legitimately record that
   * THEIR run found this change.
   */
  const already = await prisma.surfaceDriftRecord.findFirst({
    where: { currentFlowMapId: current.id, triggerId: trigger.id },
    select: { id: true },
  });

  const counts = diff.counts;
  const comparable = counts !== null;
  /*
   * `as unknown as object`, the same cast explore.ts uses to put a FlowMap in
   * `graph`: Prisma's `InputJsonValue` forbids a NULL MEMBER, and half the point
   * of this payload is that `routesRemoved` is null when removals were refused.
   * The cast carries a deliberate null into a JSONB column rather than papering
   * over a type that does not fit.
   *
   * `testednessUnmeasuredBecause` rides along rather than only being logged:
   * without it, `newSurfaceWithoutTests: null` is a null with no explanation,
   * which a reader has no choice but to render as a blank.
   */
  const detailPayload = diff.detail
    ? ({
        ...diff.detail,
        testednessUnmeasuredBecause: testedWhy,
        why: diff.why,
      } as unknown as object)
    : null;
  if (!already) {
    await prisma.surfaceDriftRecord.create({
      data: {
        orgId: trigger.orgId,
        projectId: trigger.projectId,
        environmentId: trigger.environmentId,
        currentFlowMapId: current.id,
        baselineFlowMapId: diff.baselineFlowMapId,
        comparability: diff.comparability,
        /*
         * SPREAD AND NOT SIX `?? 0`s. Every count on this row is nullable
         * because 0 is the value that means "nothing new is untested", and once
         * written it is indistinguishable from "we never looked". When the diff
         * reports no counts the columns stay NULL and `comparability` carries
         * the reason.
         */
        ...(counts
          ? {
              routesAdded: counts.routesAdded,
              routesRemoved: counts.routesRemoved,
              routesChanged: counts.routesChanged,
              controlsAdded: counts.controlsAdded,
              controlsRemoved: counts.controlsRemoved,
              newSurfaceWithoutTests: counts.newSurfaceWithoutTests,
            }
          : {}),
        /*
         * SPREAD, for the same reason the counts are, and with the same
         * consequence: an omitted `detail` leaves the column NULL, where `{}`
         * would claim an empty diff was computed. The column is nullable with no
         * default precisely so that distinction survives the write.
         */
        ...(detailPayload ? { detail: detailPayload } : {}),
        triggerId: trigger.id,
        // NULL when nothing was compared. A timestamp on a comparison that did
        // not run is how "no drift since the last crawl" gets claimed by a code
        // path that never looked.
        comparedAt: comparable ? now : null,
      },
    });
  }

  await prisma.reEnumerationTrigger.update({
    where: { id: trigger.id },
    data: {
      lastRunState: 'SUCCEEDED',
      lastFlowMapId: current.id,
      lastFailureMessage: null,
      // 0 is honest here, unlike every count on the drift row: this is a tally
      // of events we caused, not a measurement of the customer's application.
      consecutiveFailures: 0,
    },
  });

  /*
   * ── RAISING IT ─────────────────────────────────────────────────────────────
   *
   * An `AuditLog` row, which the API's audit reader already renders, so the
   * event reaches a human on a surface that exists today. The chat and webhook
   * fan-out does NOT happen and nothing here pretends it does: `processNotify`
   * switches on 'monitor.down' and 'run.finished' and returns for anything
   * else, so enqueuing a 'surface.drifted' job would be a job dropped on the
   * floor — theatre, and exactly the class of defect this round is repairing.
   * The handover names the dispatcher case and the `ACTION_EVENT_TYPES` entry
   * that would make it a subscribable event.
   *
   * TWO ACTIONS AND NOT ONE. An uncomparable diff is recorded as its own action
   * rather than as a quiet absence, because "we could not compare these two
   * crawls" is the sentence that stops somebody reading a blank drift feed as a
   * clean bill of health.
   */
  const announce = driftWorthAnnouncing(diff);
  await prisma.auditLog
    .create({
      data: {
        orgId: trigger.orgId,
        action: announce
          ? RE_ENUMERATION_AUDIT_ACTIONS.newSurface
          : comparable
            ? RE_ENUMERATION_AUDIT_ACTIONS.compared
            : RE_ENUMERATION_AUDIT_ACTIONS.uncomparable,
        targetType: 'Environment',
        targetId: trigger.environmentId,
        metadata: {
          triggerId: trigger.id,
          triggerName: trigger.name,
          triggerKind: trigger.kind,
          flowMapId: current.id,
          flowMapVersion: current.version,
          baselineFlowMapId: diff.baselineFlowMapId,
          comparability: diff.comparability,
          newSurfaceWithoutTests: counts?.newSurfaceWithoutTests ?? null,
          why: diff.why,
          testednessUnmeasuredBecause: testedWhy,
        },
      },
    })
    .catch((err: unknown) => {
      // The drift record is already stored, so the measurement survives. A
      // missing audit row costs the notice, not the fact.
      logger.error({ err, triggerId: trigger.id }, 'could not write the drift audit row');
    });

  if (announce) {
    logger.warn(
      {
        triggerId: trigger.id,
        environmentId: trigger.environmentId,
        version: current.version,
        newSurfaceWithoutTests: counts?.newSurfaceWithoutTests ?? null,
      },
      're-enumeration found new surface with no tests',
    );
  }

  return {
    diffed: 1,
    uncomparable: comparable ? 0 : 1,
    announced: announce ? 1 : 0,
  };
}

/**
 * Fire every due SCHEDULE trigger, then settle every RUNNING one.
 *
 * Never throws, for the reason the fail-fast sweep gives: this rides the tick
 * that owes a customer's nightly suite its 3am slot, and a drift diff that blew
 * up must not take that down with it.
 */
export async function sweepReEnumeration(now: Date): Promise<ReEnumerationSweep> {
  const sweep: ReEnumerationSweep = { ...EMPTY_SWEEP, capsThatBit: [] };

  const columns = {
    id: true,
    orgId: true,
    projectId: true,
    environmentId: true,
    name: true,
    kind: true,
    enabled: true,
    cron: true,
    timezone: true,
    lastRunState: true,
    lastRunAt: true,
    createdAt: true,
  } as const;

  // ── Fire ──────────────────────────────────────────────────────────────────
  let candidates: TriggerRow[] = [];
  try {
    candidates = await prisma.reEnumerationTrigger.findMany({
      where: { enabled: true, kind: 'SCHEDULE', lastRunState: { not: 'RUNNING' } },
      // ONE PAST THE LIMIT, which is what makes the cap disclosed rather than
      // merely applied. See RE_ENUMERATION_SWEEP_LIMIT.
      take: RE_ENUMERATION_SWEEP_LIMIT + 1,
      orderBy: { createdAt: 'asc' },
      select: columns,
    });
  } catch (err) {
    logger.error({ err }, 'could not read re-enumeration triggers this tick');
    return sweep;
  }

  if (candidates.length > RE_ENUMERATION_SWEEP_LIMIT) {
    const over = candidates.length - RE_ENUMERATION_SWEEP_LIMIT;
    candidates = candidates.slice(0, RE_ENUMERATION_SWEEP_LIMIT);
    sweep.deferredByCap += over;
    sweep.capsThatBit.push(
      `the re-enumeration sweep limit of ${RE_ENUMERATION_SWEEP_LIMIT} bit; at least ${over} ` +
        'more trigger(s) were not even examined this tick',
    );
  }

  /*
   * ONE CRAWL PER PROJECT PER TICK, and this is a real constraint rather than
   * caution. `enqueueExplore` pins the job id to the project, so a second crawl
   * of the same project in the same tick is silently deduplicated by BullMQ —
   * the trigger would be claimed RUNNING against a job that does not exist and
   * would sit there until it timed out and reported a crawl failure that never
   * happened. Deferring it is the honest alternative: it stays due and fires
   * next tick.
   */
  const projectsFiring = new Set<string>();
  let projectsLocked = 0;

  for (const trigger of candidates) {
    try {
      const { due } = reEnumerationIsDue(trigger, now);
      if (!due) continue;

      if (projectsFiring.has(trigger.projectId)) {
        projectsLocked += 1;
        continue;
      }

      // A crawl of this project already in flight for ANOTHER trigger, from a
      // previous tick. Same deduplication, same deferral.
      const inFlight = await prisma.reEnumerationTrigger.findFirst({
        where: { projectId: trigger.projectId, lastRunState: 'RUNNING' },
        select: { id: true },
      });
      if (inFlight) {
        projectsLocked += 1;
        continue;
      }

      const fired = await fireReEnumeration({ trigger, now });
      if (fired.fired) {
        projectsFiring.add(trigger.projectId);
        sweep.fired += 1;
        logger.info(
          { triggerId: trigger.id, projectId: trigger.projectId, name: trigger.name },
          're-enumeration fired',
        );
      }
    } catch (err) {
      // Per trigger, so one unreadable row does not cost the others theirs.
      logger.error({ err, triggerId: trigger.id }, 'could not fire this re-enumeration trigger');
    }
  }

  if (projectsLocked > 0) {
    sweep.deferredByCap += projectsLocked;
    sweep.capsThatBit.push(
      `${projectsLocked} due trigger(s) were deferred because a crawl of the same project was ` +
        'already in flight — one crawl per project is a queue constraint, not a schedule',
    );
  }

  // ── Settle ────────────────────────────────────────────────────────────────
  let running: TriggerRow[] = [];
  try {
    running = await prisma.reEnumerationTrigger.findMany({
      where: { lastRunState: 'RUNNING' },
      take: RE_ENUMERATION_SETTLE_LIMIT + 1,
      orderBy: { lastRunAt: 'asc' },
      select: columns,
    });
  } catch (err) {
    logger.error({ err }, 'could not read in-flight re-enumerations this tick');
    return sweep;
  }

  if (running.length > RE_ENUMERATION_SETTLE_LIMIT) {
    const over = running.length - RE_ENUMERATION_SETTLE_LIMIT;
    running = running.slice(0, RE_ENUMERATION_SETTLE_LIMIT);
    sweep.deferredByCap += over;
    sweep.capsThatBit.push(
      `the settle limit of ${RE_ENUMERATION_SETTLE_LIMIT} bit; at least ${over} more in-flight ` +
        'run(s) were not diffed this tick',
    );
  }

  for (const trigger of running) {
    try {
      const delta = await settleOneTrigger(trigger, now);
      sweep.fired += delta.fired ?? 0;
      sweep.diffed += delta.diffed ?? 0;
      sweep.uncomparable += delta.uncomparable ?? 0;
      sweep.announced += delta.announced ?? 0;
      sweep.failed += delta.failed ?? 0;
      sweep.inFlight += delta.inFlight ?? 0;
    } catch (err) {
      /*
       * Recorded on the row and not only in the log. A diff that threw is a run
       * that FAILED, and leaving it RUNNING would make it wait out the timeout
       * and then be reported as a crawl that never landed — a different and
       * wrong fact about the customer's application.
       */
      logger.error({ err, triggerId: trigger.id }, 'could not settle this re-enumeration');
      await prisma.reEnumerationTrigger
        .update({
          where: { id: trigger.id },
          data: {
            lastRunState: 'FAILED',
            lastFailureMessage:
              'The crawl completed and the comparison against the previous crawl could not be ' +
              'made, so no drift is being claimed either way.',
            consecutiveFailures: { increment: 1 },
          },
        })
        .catch(() => {});
      sweep.failed += 1;
    }
  }

  return sweep;
}

export async function processScheduleTick(_job: ScheduleTickJob): Promise<void> {
  const now = new Date();

  // ── Cron schedules ────────────────────────────────────────────────────────
  const schedules = await prisma.schedule.findMany({
    where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      environmentId: true,
      suiteId: true,
      name: true,
      cron: true,
      timezone: true,
      nextRunAt: true,
    },
  });

  for (const schedule of schedules) {
    const next = nextFireTime(schedule.cron, schedule.timezone, now);
    if (!next) {
      // An unparseable cron would otherwise be retried every tick forever.
      logger.warn({ scheduleId: schedule.id, cron: schedule.cron }, 'disabling an invalid cron');
      await prisma.schedule.update({ where: { id: schedule.id }, data: { enabled: false } });
      continue;
    }

    // Claim BEFORE enqueuing: if the run fails to queue we lose one cycle,
    // which is far better than firing the same schedule twice.
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { nextRunAt: next, lastRunAt: schedule.nextRunAt ? now : null },
    });

    // A first sight of a schedule only arms it — firing immediately would mean
    // creating a nightly job at 2pm ran it at 2pm.
    if (!schedule.nextRunAt) {
      logger.info({ scheduleId: schedule.id, next }, 'schedule armed');
      continue;
    }

    const queued = await queueRun({ ...schedule, trigger: 'SCHEDULE' });
    if (queued && 'refused' in queued) {
      // Loud, and at warn: a nightly that stopped running is exactly the thing
      // a green dashboard would otherwise lie about.
      logger.warn(
        { scheduleId: schedule.id, orgId: schedule.orgId, reason: queued.refused, next },
        'schedule skipped: the org is at its monthly run limit',
      );
      continue;
    }
    logger.info(
      { scheduleId: schedule.id, runId: queued?.id, shards: queued?.shards, next },
      'schedule fired',
    );
  }

  // ── Monitors ──────────────────────────────────────────────────────────────
  const monitors = await prisma.monitor.findMany({
    where: { enabled: true },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      environmentId: true,
      suiteId: true,
      name: true,
      intervalMinutes: true,
      lastCheckedAt: true,
      lastStatus: true,
      consecutiveFailures: true,
      failureThreshold: true,
    },
  });

  for (const monitor of monitors) {
    const dueAt = monitor.lastCheckedAt
      ? new Date(monitor.lastCheckedAt.getTime() + monitor.intervalMinutes * 60_000)
      : new Date(0);
    if (dueAt > now) continue;

    await prisma.monitor.update({ where: { id: monitor.id }, data: { lastCheckedAt: now } });

    const queued = await queueRun({ ...monitor, trigger: 'MONITOR' });
    if (queued && 'refused' in queued) {
      logger.warn(
        { monitorId: monitor.id, orgId: monitor.orgId, reason: queued.refused },
        'monitor check skipped: the org is at its monthly run limit',
      );
    } else if (queued) {
      logger.info(
        { monitorId: monitor.id, runId: queued.id, shards: queued.shards },
        'monitor check queued',
      );
    }
  }

  /*
   * ── The three sweeps that ride this tick ──────────────────────────────────
   *
   * LAST, and after the cron schedules and the monitors, deliberately. All are
   * work nobody is waiting on, and a nightly suite that fired four seconds late
   * because a closure campaign was measuring is a worse trade than a campaign
   * that measures four seconds later. All are also written so they cannot
   * throw — a stop request that could not be written, a campaign that blew up,
   * or a drift diff that threw, must not take a customer's uptime check down
   * with it.
   *
   * They ride THIS tick rather than getting queues of their own for the reason
   * `ClosureCampaign` spells out: a job whose own result decides whether it
   * re-queues is the shape of a worker that never idles, and this sweep's fixed
   * 60-second cadence is a ceiling that no bug in the stop rules can raise.
   *
   * RE-ENUMERATION IS THE THIRD, and it is the one that moves the DENOMINATOR
   * rather than the numerator: until it existed, nothing in this product
   * re-enumerated without a human, so the surface we measure against went stale
   * and the coverage percentage drifted upwards with nobody told.
   */
  const failFast = await sweepFailFastStops(now);
  const campaigns = await advanceClosureCampaigns(now);
  const reEnumeration = await sweepReEnumeration(now).catch((err: unknown) => {
    // Belt as well as braces: `sweepReEnumeration` catches per trigger and per
    // query, and a throw escaping it anyway must still not cost this install
    // its monitors. Reported as an empty sweep, which is the truth — this tick
    // re-enumerated nothing — and never as a sweep that found no drift.
    logger.error({ err }, 'the re-enumeration sweep failed; nothing was re-enumerated this tick');
    return { ...EMPTY_SWEEP, capsThatBit: [] };
  });

  if (
    failFast.requested > 0 ||
    // Reported on the same line as the stops, because a tick that could not
    // decide a run is a thing an operator has to be able to see without going
    // looking for a warning.
    failFast.undecided > 0 ||
    campaigns.armed > 0 ||
    campaigns.advanced > 0 ||
    campaigns.failed > 0 ||
    reEnumeration.fired > 0 ||
    reEnumeration.diffed > 0 ||
    reEnumeration.failed > 0 ||
    // On the same line as the rest, for the same reason `undecided` is: a cap
    // that deferred fourteen due triggers is an install whose denominators are
    // going stale, and it must be visible without going looking for a warning.
    reEnumeration.deferredByCap > 0
  ) {
    logger.info(
      {
        stopsRequested: failFast.requested,
        stopsUndecided: failFast.undecided,
        ...campaigns,
        reEnumerationFired: reEnumeration.fired,
        reEnumerationDiffed: reEnumeration.diffed,
        reEnumerationUncomparable: reEnumeration.uncomparable,
        reEnumerationAnnounced: reEnumeration.announced,
        reEnumerationFailed: reEnumeration.failed,
        reEnumerationInFlight: reEnumeration.inFlight,
        reEnumerationDeferred: reEnumeration.deferredByCap,
        reEnumerationCaps: reEnumeration.capsThatBit,
      },
      'schedule tick: fail-fast stops requested, closure campaigns advanced, surface re-enumerated',
    );
  }
}

/**
 * Called when a monitor-triggered run finishes: track the streak and alert once
 * the threshold is crossed.
 *
 * Alerting on a streak rather than on every failure is the whole point — a
 * monitor that pages on one blip trains people to mute it.
 */
export async function recordMonitorResult(
  orgId: string,
  runId: string,
  status: string,
): Promise<void> {
  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    select: { suiteId: true, environmentId: true, projectId: true },
  });
  if (!run?.suiteId) return;

  const monitor = await prisma.monitor.findFirst({
    where: {
      orgId,
      projectId: run.projectId,
      suiteId: run.suiteId,
      environmentId: run.environmentId,
      enabled: true,
    },
    select: { id: true, name: true, consecutiveFailures: true, failureThreshold: true },
  });
  if (!monitor) return;

  const failed = status !== 'PASSED';
  const streak = failed ? monitor.consecutiveFailures + 1 : 0;

  await prisma.monitor.update({
    where: { id: monitor.id },
    data: { consecutiveFailures: streak, lastStatus: status as never },
  });

  // Fire exactly on the crossing, not on every failure beyond it.
  if (failed && streak === monitor.failureThreshold) {
    await enqueueNotify({
      orgId,
      event: 'monitor.down',
      payload: { monitorId: monitor.id, name: monitor.name, runId, streak },
    }).catch(() => {});
    logger.warn({ monitorId: monitor.id, streak }, 'monitor threshold crossed');
  }
}
