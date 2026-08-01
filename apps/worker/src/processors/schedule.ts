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
import type { Plan, ScheduleTickJob, ShardAssignment } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { enqueueRun, enqueueNotify } from '../queues.js';

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
 * A subscription in a non-paying state falls back to FREE limits.
 *
 * The same rule as apps/api/src/lib/plan.ts, restated because that module
 * imports the API's tenancy-scoped Prisma client and cannot be loaded here.
 */
const PAYING_STATUSES = new Set(['active', 'trialing']);

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

/** The org's parallel-worker ceiling — PLAN_LIMITS, resolved the way billing does. */
async function maxParallelWorkersFor(orgId: string): Promise<number> {
  const [subscription, org] = await Promise.all([
    prisma.subscription.findUnique({ where: { orgId }, select: { plan: true, status: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  ]);

  // With no Subscription row, Organization.plan is the answer: a seeded org, a
  // self-hosted install and an enterprise contract signed offline all have it
  // set and never went through Stripe checkout.
  const plan: Plan = subscription?.plan ?? org?.plan ?? 'FREE';
  const paying = subscription ? PAYING_STATUSES.has(subscription.status) : false;

  // An org that stopped paying keeps its plan label but is metered at free
  // limits. An org that never had a subscription is not "not paying".
  const effective: Plan = !subscription || paying || plan === 'FREE' ? plan : 'FREE';
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
 */
async function queueRun(args: {
  orgId: string;
  projectId: string;
  environmentId: string;
  suiteId: string;
  trigger: 'SCHEDULE' | 'MONITOR';
}): Promise<{ id: string; shards: number } | null> {
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

  const run = await prisma.run.create({
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
    select: { id: true },
  });

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
    if (queued) {
      logger.info(
        { monitorId: monitor.id, runId: queued.id, shards: queued.shards },
        'monitor check queued',
      );
    }
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
