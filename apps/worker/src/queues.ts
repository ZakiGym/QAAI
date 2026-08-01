/**
 * Worker-side producers. The run processor enqueues triage, and the explore
 * processor enqueues generation, so the worker needs to write to its own queues.
 */

import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import type { CopilotJob, GenerateJob, NotifyJob, ShardedRunJob, TriageJob } from '@qaai/shared';
import { connection } from './context.js';

const generateQueue = new Queue(QUEUE_NAMES.generate, { connection });
const runQueue = new Queue(QUEUE_NAMES.run, { connection });
const triageQueue = new Queue(QUEUE_NAMES.triage, { connection });
const copilotQueue = new Queue(QUEUE_NAMES.copilot, { connection });
const notifyQueue = new Queue(QUEUE_NAMES.notify, { connection });
const scheduleQueue = new Queue(QUEUE_NAMES.schedule, { connection });
const flakeQueue = new Queue(QUEUE_NAMES.flake, { connection });

/**
 * Priority for a run nobody is waiting on — today, the flake radar's
 * confirmation re-runs.
 *
 * BullMQ processes jobs with NO priority ahead of prioritised ones, so simply
 * stamping a priority is what keeps ten re-runs of one suspect test behind every
 * CI run, schedule and monitor check. The number is arbitrary; that it exists at
 * all is the point.
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
  ]);
}
