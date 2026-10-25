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
import { PLAN_LIMITS } from '@qaai/shared';
import type { ScheduleTickJob, ShardAssignment } from '@qaai/shared';
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
import { enqueueRun, enqueueNotify } from '../queues.js';
import { advanceClosureCampaigns } from './close-loop.js';

/** Next fire time for a cron expression, or null when it is unparseable. */
function nextFireTime(cron: string, timezone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone })
      .next()
      .toDate();
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

  const granted = Math.max(1, Math.min(desired, await maxParallelWorkersFor(orgId), testIds.length));
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
   * ── The two sweeps that ride this tick ────────────────────────────────────
   *
   * LAST, and after the cron schedules and the monitors, deliberately. Both are
   * work nobody is waiting on, and a nightly suite that fired four seconds late
   * because a closure campaign was measuring is a worse trade than a campaign
   * that measures four seconds later. Both are also written so they cannot
   * throw — a stop request that could not be written, or a campaign that blew
   * up, must not take a customer's uptime check down with it.
   *
   * They ride THIS tick rather than getting queues of their own for the reason
   * `ClosureCampaign` spells out: a job whose own result decides whether it
   * re-queues is the shape of a worker that never idles, and this sweep's fixed
   * 60-second cadence is a ceiling that no bug in the stop rules can raise.
   */
  const failFast = await sweepFailFastStops(now);
  const campaigns = await advanceClosureCampaigns(now);

  if (
    failFast.requested > 0 ||
    // Reported on the same line as the stops, because a tick that could not
    // decide a run is a thing an operator has to be able to see without going
    // looking for a warning.
    failFast.undecided > 0 ||
    campaigns.armed > 0 ||
    campaigns.advanced > 0 ||
    campaigns.failed > 0
  ) {
    logger.info(
      { stopsRequested: failFast.requested, stopsUndecided: failFast.undecided, ...campaigns },
      'schedule tick: fail-fast stops requested and closure campaigns advanced',
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
