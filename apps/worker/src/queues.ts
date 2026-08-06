/**
 * Worker-side producers. The run processor enqueues triage, and the explore
 * processor enqueues generation, so the worker needs to write to its own queues.
 */

import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import type { CopilotJob, GenerateJob, NotifyJob, ShardedRunJob, TriageJob } from '@qaai/shared';
// Pure module — types, constants and the search, no Prisma and no Express. That
// is what makes it importable here; apps/api/src/lib/plan.ts and vault.ts are
// duplicated instead precisely because they are not.
import { BISECT_QUEUE, MAX_BISECT_TICKS, type BisectJob } from '../../api/src/lib/bisect.js';
import { connection } from './context.js';

const generateQueue = new Queue(QUEUE_NAMES.generate, { connection });
const runQueue = new Queue(QUEUE_NAMES.run, { connection });
const triageQueue = new Queue(QUEUE_NAMES.triage, { connection });
const copilotQueue = new Queue(QUEUE_NAMES.copilot, { connection });
const notifyQueue = new Queue(QUEUE_NAMES.notify, { connection });
const scheduleQueue = new Queue(QUEUE_NAMES.schedule, { connection });
const flakeQueue = new Queue(QUEUE_NAMES.flake, { connection });
const bisectQueue = new Queue(BISECT_QUEUE, { connection });

/**
 * Priority for a run nobody is waiting on: the flake radar's confirmation
 * re-runs, and a bisect's probes.
 *
 * BullMQ processes jobs with NO priority ahead of prioritised ones, so simply
 * stamping a priority is what keeps ten re-runs of one suspect test behind every
 * CI run, schedule and monitor check. The number is arbitrary; that it exists at
 * all is the point.
 *
 * It matters more for bisect than for flake. A bisect is asked for while a build
 * is red, which is exactly when the run queue is busiest with the runs people
 * are actually waiting on — and the answer to "what broke this" is worth having
 * in ten minutes, not at the cost of everyone else's ten minutes.
 */
const BACKGROUND_RUN_PRIORITY = 100;

export async function enqueueGenerate(job: GenerateJob): Promise<void> {
  await generateQueue.add(QUEUE_NAMES.generate, job, { attempts: 2 });
}

/**
 * Queue a run, or one slice of one.
 *
 * `ShardedRunJob` widens the parameter rather than adding a second function:
 * every existing caller passes `{ orgId, runId }`, which has no `shard`, and
 * gets byte-identical options to before — same job id, same single attempt.
 *
 * The job id is what makes a slice idempotent. Unsharded runs keep `run-<id>`,
 * so a retried enqueue still cannot double-execute a suite; a shard gets
 * `run-<id>-shard-<n>`, so its siblings are distinct jobs while a redelivery of
 * that same slice collapses onto the one job (and is then arbitrated properly
 * by `claimShard` in the run processor).
 *
 * `attempts: 1` for both, and for the same reason the API gives: a shard that
 * dies must surface as a shard that died, so the run finalises ERRORED naming
 * it. Retrying a slice while its siblings are already aggregating counts is how
 * a run reports numbers from two different attempts.
 *
 * `background` marks a run that exists only to measure something (§5 flake
 * confirmation). It changes nothing about how the run executes — only where it
 * sits in the queue.
 */
export async function enqueueRun(
  job: ShardedRunJob,
  opts: { background?: boolean } = {},
): Promise<void> {
  const shard = job.shard ?? null;
  await runQueue.add(QUEUE_NAMES.run, job, {
    jobId: shard ? `run-${job.runId}-shard-${shard.index}` : `run-${job.runId}`,
    attempts: 1,
    ...(opts.background ? { priority: BACKGROUND_RUN_PRIORITY } : {}),
  });
}

export async function enqueueTriage(job: TriageJob): Promise<void> {
  await triageQueue.add(QUEUE_NAMES.triage, job, {
    // One triage per result, ever — a retried run job must not re-triage and
    // duplicate verdict rows.
    jobId: `triage-${job.testResultId}`,
    attempts: 2,
  });
}

/**
 * Advance a bisect by one step, later.
 *
 * The processor calls this on itself. A bisect is mostly waiting — for a probe
 * run to reach a browser, execute, and finalise — and a job that sleeps through
 * that occupies a worker slot for the whole investigation and loses everything
 * when the process restarts. A delayed job costs a Redis key.
 *
 * `step` is in the job id, so a redelivered tick collapses onto the one job
 * instead of forking the investigation into two racing searches; and it is
 * bounded by MAX_BISECT_TICKS, so a bug in the step logic runs out rather than
 * re-enqueueing forever.
 *
 * `attempts: 1`, deliberately. Every step reads its state back from the database
 * (the probe runs and the audit rows), so BullMQ retrying a failed tick buys
 * nothing that the NEXT tick would not do better — and a retry storm here means
 * several ticks queueing probe runs for the same commit at once.
 */
export async function enqueueBisect(job: BisectJob, delayMs = 0): Promise<void> {
  // `>` and not `>=`: the processor concludes when it SEES step MAX_BISECT_TICKS,
  // so that tick has to be allowed to run. Refusing it here would strand the
  // investigation one step short of the ceiling with no report ever written.
  if (job.step > MAX_BISECT_TICKS) return;
  await bisectQueue.add(BISECT_QUEUE, job, {
    jobId: `bisect-${job.bisectId}-${job.step}`,
    attempts: 1,
    ...(delayMs > 0 ? { delay: delayMs } : {}),
  });
}

export async function enqueueCopilot(job: CopilotJob): Promise<void> {
  await copilotQueue.add(QUEUE_NAMES.copilot, job, { attempts: 1 });
}

/**
 * Outbound notification. Fire-and-forget by design: a PR comment that fails to
 * post must never fail the run that produced it.
 */
export async function enqueueNotify(job: NotifyJob): Promise<void> {
  await notifyQueue.add(QUEUE_NAMES.notify, job, { attempts: 3 });
}

/**
 * One webhook/chat POST, addressed by its WebhookDelivery row (§7).
 *
 * The notify processor no longer sends inline: it writes a PENDING row per
 * destination and enqueues one of these per row, so a failed send is retried by
 * the QUEUE — with backoff, without holding a worker slot through the wait, and
 * surviving a worker restart — rather than by sleeping in-process. The job
 * carries ids only (see the header of packages/shared/src/jobs.ts); the
 * processor re-reads the row and the integration, so an admin who fixes a bad
 * webhook URL mid-retry gets the retry delivered to the fixed URL.
 *
 * These ride the notify queue under their own job NAME rather than a queue of
 * their own: the queue already has a consumer, and a second queue is a second
 * thing that can end up produced-but-undrained (the bisect lesson check:wiring
 * exists for).
 *
 * The job id pins idempotency to the row: a redelivered or retried notify job
 * that re-enqueues the same delivery collapses onto the one job instead of
 * double-posting.
 */
export const DELIVERY_JOB = 'notify.deliver';

/**
 * Attempts per delivery. With the exponential backoff below (1m base) the five
 * attempts spread over ~15 minutes — long enough to ride out a Slack blip,
 * short enough that a page about a red build is not an hour late. After the
 * last one the row is marked FAILED and nothing retries it again.
 */
export const DELIVERY_ATTEMPTS = 5;

export interface DeliveryJob {
  orgId: string;
  /** The WebhookDelivery row this job exists to fulfil and record into. */
  deliveryId: string;
}

export async function enqueueDelivery(job: DeliveryJob): Promise<void> {
  await notifyQueue.add(DELIVERY_JOB, job, {
    jobId: `deliver-${job.deliveryId}`,
    attempts: DELIVERY_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

/**
 * Arm the scheduler sweep. A BullMQ repeatable job survives restarts and
 * de-duplicates by key, so calling this on every boot is safe and means the
 * sweep exists as long as a worker does.
 */
export async function armScheduleTick(): Promise<void> {
  await scheduleQueue.add(
    'tick',
    { at: new Date().toISOString() },
    {
      repeat: { every: 60_000 },
      jobId: 'qaai-schedule-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

/**
 * Arm the flake sweep (§5). Same repeatable-job reasoning as the scheduler, at a
 * slower cadence: an investigation advances by one re-run per tick, and a
 * measurement nobody is waiting on has no business ticking every minute.
 */
export async function armFlakeTick(): Promise<void> {
  await flakeQueue.add(
    'tick',
    { at: new Date().toISOString() },
    {
      repeat: { every: 5 * 60_000 },
      jobId: 'qaai-flake-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

export async function closeProducers(): Promise<void> {
  await Promise.all([
    generateQueue.close(),
    runQueue.close(),
    triageQueue.close(),
    copilotQueue.close(),
    flakeQueue.close(),
    bisectQueue.close(),
  ]);
}
