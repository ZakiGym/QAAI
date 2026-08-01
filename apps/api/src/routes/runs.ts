/**
 * Runs (§5) — enqueue, read, stream, and the artifact endpoint the cockpit's
 * screenshots and trace viewer load from.
 */

import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX, QUEUE_NAMES, createRunSchema } from '@qaai/shared';
import type { ShardAssignment, ShardPlan, ShardedRunJob } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, planLimit } from '../lib/errors.js';
import { canStartRun, planFor } from '../lib/plan.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { storage } from '../lib/storage.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import { env } from '../env.js';

export const runsRouter: Router = Router();

runsRouter.use(requireAuth);

/** First day of the current UTC month — the usage-metering period key (§9). */
function currentPeriod(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ─── Build sharding (§5) ─────────────────────────────────────────────────────

/**
 * Sharding is opt-in per run.
 *
 * Parsed separately from `createRunSchema` rather than added to it: that schema
 * is the shared contract the CLI, the GitHub Action and the web app all compile
 * against, and a zod object ignores unknown keys, so `shards` arrives on the
 * body untouched and is validated here. Absent or 1 means the run behaves
 * exactly as it always has — one job, one worker, no shard rows.
 */
const shardRequestSchema = z.object({
  shards: z.number().int().min(1).max(50).nullish(),
});

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

runsRouter.post('/', requireRole('MEMBER'), requireScope('runs:write'), async (req, res) => {
  const actor = actorOf(req);
  const input = createRunSchema.parse(req.body);
  const shardInput = shardRequestSchema.parse(req.body);

  const environment = await prisma.environment.findUnique({
    where: { id: input.environmentId },
    select: { id: true, projectId: true },
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
   */
  const verdict = await canStartRun(actor.orgId);
  if (!verdict.allowed) {
    const { plan } = await planFor(actor.orgId);
    throw planLimit(verdict.reason ?? 'Plan limit reached', {
      limit: 'maxRunsPerMonth',
      plan,
    });
  }

  /**
   * Rows under `fixtures/` are test DATA, not tests — they hold no runnable code.
   * Excluded from both selection paths, so neither "run everything" nor an
   * explicit id list can queue one and report it as a failure.
   */
  const runnable = await prisma.test.findMany({
    where: {
      projectId: environment.projectId,
      disabledAt: null,
      filePath: { not: { startsWith: FIXTURE_PREFIX } },
      ...(input.testIds ? { id: { in: input.testIds } } : {}),
      ...(input.suiteId && !input.testIds ? { suiteId: input.suiteId } : {}),
    },
    select: { id: true },
  });
  const testIds = runnable.map((t) => t.id);

  if (testIds.length === 0) {
    throw badRequest('There are no tests to run for that suite or project');
  }

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
    shardInput.shards != null && shardInput.shards > 1
      ? await planShards(actor.orgId, testIds, shardInput.shards)
      : null;
  const grantedShards = shardPlan?.granted ?? 1;
  const sharded = grantedShards > 1;
  const shardOfTest = new Map<string, number>();
  for (const assignment of shardPlan?.assignments ?? []) {
    for (const testId of assignment.testIds) shardOfTest.set(testId, assignment.index);
  }

  const run = await prisma.run.create({
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

  await prisma.usageRecord.upsert({
    where: { orgId_metric_period: { orgId: actor.orgId, metric: 'runs', period: currentPeriod() } },
    create: { orgId: actor.orgId, metric: 'runs', period: currentPeriod(), quantity: 1n },
    update: { quantity: { increment: 1n } },
  });

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
  const jobIds =
    shardPlan && sharded
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
    },
  });

  res.status(202).json({
    run,
    // `jobId` stays a string for every existing caller; sharded runs add the
    // full list rather than replacing it.
    jobId: jobIds[0],
    ...(jobIds.length > 1 ? { jobIds } : {}),
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
