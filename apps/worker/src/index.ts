/**
 * Worker entrypoint (§5).
 *
 * One BullMQ Worker per queue, each with its own concurrency. The E2E queue is
 * the constrained one — every job launches a browser — so it runs at the
 * configured worker count while the cheap queues run wider.
 */

import { Worker, type Job } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import type {
  CopilotJob,
  EditJob,
  ExploreJob,
  GenerateJob,
  ImportJob,
  NotifyJob,
  ScheduleTickJob,
  RunJob,
  TriageJob,
} from '@qaai/shared';
import { config, connection, logger, prisma } from './context.js';
import {
  ANALYZE_SOURCE_QUEUE,
  DELIVERY_JOB,
  armFlakeTick,
  armScheduleTick,
  closeProducers,
  type AnalyzeSourceJob,
  type DeliveryJob,
} from './queues.js';
import { processAnalyzeSource } from './processors/analyze-source.js';
import { processExplore } from './processors/explore.js';
import { processGenerate } from './processors/generate.js';
import { failRunFromDeadJob, processRun, sweepStalledShardedRuns } from './processors/run.js';
import { processTriage } from './processors/triage.js';
import { processCopilot } from './processors/copilot.js';
import { processEdit } from './processors/edit.js';
import { processDelivery, processNotify } from './processors/notify.js';
import { processScheduleTick } from './processors/schedule.js';
import { processImport } from './processors/import.js';
import { processFlakeTick, type FlakeTickJob } from './processors/flake.js';
import { processBisect } from './processors/bisect.js';
import { armCheckSweep, processChecks } from './processors/checks.js';
import { processDigestTick } from './processors/digest.js';
import {
  RETENTION_QUEUE,
  armRetentionSweep,
  closeRetentionQueue,
  processRetentionTick,
  type RetentionJob,
} from './processors/retention.js';
import {
  BACKUP_QUEUE,
  armBackupSweep,
  closeBackupQueue,
  processBackupTick,
  type BackupTickJob,
} from './processors/backup.js';
import {
  ACTIONS_QUEUE,
  closeActionsQueue,
  dispatchActionsForNotify,
  processActionEvent,
  type ActionEventJob,
} from './processors/actions.js';
import { BISECT_QUEUE, type BisectJob } from '../../api/src/lib/bisect.js';
import { CHECKS_QUEUE, type ChecksJob } from '../../api/src/lib/github-app.js';

const workers: Worker[] = [];

function register<T>(
  name: string,
  concurrency: number,
  // The job rides along for the handlers that need its metadata — the notify
  // queue dispatches on job.name, and a delivery needs to know which attempt
  // it IS (attemptsMade counts finished attempts, so this one is +1). Handlers
  // that only want the payload just don't declare the parameter.
  handler: (payload: T, job: Job<T>) => Promise<void>,
): void {
  const worker = new Worker(
    name,
    async (job: Job<T>) => {
      const started = Date.now();
      logger.info({ queue: name, jobId: job.id }, 'job started');
      try {
        await handler(job.data, job);
        logger.info({ queue: name, jobId: job.id, ms: Date.now() - started }, 'job finished');
      } catch (err) {
        logger.error({ err, queue: name, jobId: job.id }, 'job failed');
        throw err;
      }
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, err) => {
    /*
     * BullMQ fires 'failed' on every attempt, but only the FINAL one leaves the
     * job dead in the failed set with nothing coming back for it — that is the
     * line an operator writes an alert on, so it gets a message of its own with
     * the queue, the job name and the error all in it. The retryable case keeps
     * the old message (and its `attempts` field name) so a transient blip does
     * not page anyone and existing log consumers see what they always saw.
     *
     * `attemptsMade` already counts the attempt that just failed, hence `>=`.
     * A job BullMQ could not even hand back (`job` undefined) is treated as
     * final — there is nothing left that could retry it.
     */
    const allowed = job?.opts.attempts ?? 1;
    if (!job || job.attemptsMade >= allowed) {
      logger.error(
        {
          queue: name,
          jobId: job?.id,
          jobName: job?.name,
          attemptsMade: job?.attemptsMade,
          err: err.message,
        },
        'job failed permanently',
      );
      /*
       * A dead run job leaves a run behind, and somebody has to say so.
       *
       * This is the only place that hears about a job which failed before the
       * processor could finalise anything — a throw in its pre-loop setup, a
       * job BullMQ could not even deserialise. Without this the run stayed at
       * QUEUED or RUNNING forever: the cockpit's elapsed clock never stopped,
       * the gate never resolved, and no `run.finished` notification was
       * enqueued, so the Slack message and the PR comment never arrived. One
       * rotated vault key did that to every run in an org.
       *
       * Only the run queue, and only when BullMQ handed the job back — without
       * `job.data` there is no run id to write to. The write itself is
       * conditional inside `failRunFromDeadJob`, so it can never overwrite a
       * run that already reported. Fire-and-forget with its own catch: this is
       * an event handler, and a rescue that throws must not take the worker's
       * error reporting down with it.
       */
      if (job && name === QUEUE_NAMES.run) {
        // `?? {}` because the destructure is the first thing to touch a payload
        // BullMQ handed back, inside a listener where a throw would take the
        // worker's own error reporting down with it. The guard in
        // `failRunFromDeadJob` handles the missing FIELDS; this handles the
        // missing OBJECT, which would throw one frame earlier than that guard.
        const { orgId, runId } = (job.data ?? {}) as unknown as RunJob;
        void failRunFromDeadJob({ orgId, runId, errorMessage: err.message })
          .then((rescued) => {
            if (rescued) {
              logger.error(
                { queue: name, jobId: job.id, runId },
                'marked the run ERRORED because its job died before it could finalise',
              );
            }
          })
          .catch((rescueErr) =>
            logger.error(
              { err: rescueErr, queue: name, jobId: job.id, runId },
              'could not mark the run terminal after its job died',
            ),
          );
      }
      return;
    }
    logger.error(
      { queue: name, jobId: job.id, attempts: job.attemptsMade, err: err.message },
      'job attempt failed',
    );
  });

  workers.push(worker);
}

// Browser-bound: one job holds a Chromium process for its whole duration.
register<RunJob>(QUEUE_NAMES.run, config.concurrency, processRun);
register<ExploreJob>(
  QUEUE_NAMES.explore,
  Math.max(1, Math.floor(config.concurrency / 2)),
  processExplore,
);
// Network-bound on the LLM, so a wider pool is fine.
register<GenerateJob>(QUEUE_NAMES.generate, config.concurrency * 2, processGenerate);
register<TriageJob>(QUEUE_NAMES.triage, config.concurrency * 2, processTriage);
// A copilot turn can hold a browser for minutes via run_tests, so it is capped
// at the browser-bound concurrency rather than the wider LLM pool.
register<CopilotJob>(QUEUE_NAMES.copilot, config.concurrency, processCopilot);
// Inline edits are interactive — a user is staring at a spinner — so they get
// their own lane rather than queueing behind a long copilot turn.
register<EditJob>(QUEUE_NAMES.edit, config.concurrency * 2, processEdit);
// The notify queue carries two job shapes, told apart by NAME: the fan-out
// (build the message, write one WebhookDelivery row per destination) and the
// per-row delivery jobs it enqueues. Same queue on purpose — a second queue is
// a second thing that can end up produced-but-undrained. The delivery handler
// is given which attempt this is, because the attempt that exhausts the
// retries is the one that must flip the row to FAILED (the dead-letter the
// deliveries endpoint reads).
register<NotifyJob | DeliveryJob>(QUEUE_NAMES.notify, config.concurrency, async (payload, job) => {
  if (job.name === DELIVERY_JOB) {
    await processDelivery(payload as DeliveryJob, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
    });
    return;
  }

  const notify = payload as NotifyJob;
  await processNotify(notify, String(job.id ?? ''));

  /*
   * Event actions ride the same trigger as the chat message, and in this order
   * on purpose: the notification is a person being woken up, the action is a
   * machine being poked, and on a bad day the human should win. The call is
   * an ENQUEUE, not a dispatch — an action that resolves slowly must not hold
   * the notify lane — and it never throws, so a broken action cannot cost a
   * page its delivery.
   */
  await dispatchActionsForNotify(notify);
});
// One repeating sweep rather than a timer per schedule: timers drift, do not
// survive a restart, and a scheduler that quietly stops is worse than none.
//
// The tick also carries the sharded-run sweep. It is wired here rather than
// inside processScheduleTick so the two stay independent — a sharded run left
// open by a dead worker has nothing to do with cron — and so run.ts and
// schedule.ts do not have to import each other.
register<ScheduleTickJob>(QUEUE_NAMES.schedule, 1, async (job) => {
  await processScheduleTick(job);
  // Never fails the tick: the schedules and monitors it just fired are the
  // tick's real work, and a sweep that throws must not cost them their retry.
  await sweepStalledShardedRuns().catch((err) =>
    logger.error({ err }, 'the sharded-run sweep failed'),
  );
  // The nightly digest rides the same minute tick rather than arming a queue of
  // its own: it is a cron sweep over DigestSubscription rows, it claims each
  // subscription's next fire time before building anything, and a digest that
  // throws must not cost the schedules their retry either.
  await processDigestTick().catch((err) => logger.error({ err }, 'the digest sweep failed'));
});
void armScheduleTick().catch((err) => logger.error({ err }, 'could not arm the scheduler'));
register<ImportJob>(QUEUE_NAMES.import, config.concurrency, processImport);

// "Learn my codebase". Cheap and model-free — it reads a stored analysis and
// writes a plan, never a browser and never a token — so it rides the wider
// pool. Without this registration POST /projects/:id/analyze-source answers
// "queued" and the job sits in Redis forever, which is the bisect-queue defect
// exactly; `npm run check:wiring` fails if the line is removed.
register<AnalyzeSourceJob>(ANALYZE_SOURCE_QUEUE, config.concurrency * 2, (payload) =>
  // Wrapped in an arrow so register()'s second argument (the BullMQ Job) is
  // never mistaken for processAnalyzeSource's own deps parameter — that slot is
  // the test seam for injecting a fake project row, and a Job landing in it
  // would be a silent no-op today and a confusing bug the day the two types
  // grow a matching field. Same reasoning as the backup tick below.
  processAnalyzeSource(payload),
);

// The flake sweep: one tick, concurrency 1, its own queue. It shares nothing
// with the scheduler tick deliberately — confirming a flake has nothing to do
// with cron, and a slow sweep of quarantine candidates must not be able to hold
// up a nightly run that is due.
//
// It creates runs on the run queue rather than executing anything itself, so
// this worker stays cheap even while an investigation is in flight.
register<FlakeTickJob>(QUEUE_NAMES.flake, 1, processFlakeTick);
void armFlakeTick().catch((err) => logger.error({ err }, 'could not arm the flake sweep'));

// Build bisect. Each tick only reads the database and enqueues the next probe
// run — the browser work happens on the run queue — so this stays cheap, but it
// must be registered or POST /bisect enqueues into a queue nobody drains and
// every investigation sits at "running" until its deadline expires.
register<BisectJob>(BISECT_QUEUE, config.concurrency, processBisect);

// GitHub check runs. Network-bound on GitHub's API; it never holds a browser.
// Without this registration every check enqueued by routes/github.ts sits in
// Redis and the merge box never shows a result.
register<ChecksJob>(CHECKS_QUEUE, config.concurrency, processChecks);
void armCheckSweep().catch((err) => logger.error({ err }, 'could not arm the check sweep'));

// Artifact retention. Concurrency 1, deliberately: two sweeps running at once
// would race over the same expired rows, and there is never a reason to hurry a
// delete.
//
// This registration and the arming call below are what make the retention
// feature exist at run time. Everything else was already here — the processor,
// its unit tests, the OWNER-only POST /retention/sweep that enqueues onto
// 'qaai.retention' — and none of it was reachable, because no worker drained
// that queue. The endpoint answered "sweep queued" and the job sat in Redis
// forever, which is the same class of bug as the bisect queue that had no
// consumer. `npm run check:wiring` now fails if this line is ever removed.
register<RetentionJob>(RETENTION_QUEUE, 1, processRetentionTick);
// Daily repeatable sweep, de-duplicated by job key, so arming it on every boot
// is safe. Without it the only sweeps that ever happen are the ones an owner
// asks for by hand.
void armRetentionSweep().catch((err) =>
  logger.error({ err }, 'could not arm the retention sweep'),
);

// The nightly database backup ("a backup command nobody runs is not a backup").
// Concurrency 1: two dumps at once would double the load on Postgres for a copy
// of the same data, and the CLI would refuse the second --out anyway. The same
// tick also prunes StripeEventSeen replay-guard rows past Stripe's redelivery
// horizon — the one cleanup that table has.
//
// Wrapped in an arrow so register()'s second argument (the BullMQ Job, which
// the notify queue needs) is never mistaken for processBackupTick's own options
// parameter — that slot is for tests to inject a fake backup runner, and a Job
// object landing in it would be a silent no-op today and a confusing bug the
// day either type grows a matching field.
register<BackupTickJob>(BACKUP_QUEUE, 1, (payload) => processBackupTick(payload));
// Repeatable daily job, de-duplicated by jobId, so arming on every boot is safe
// and a restart cannot double-schedule.
void armBackupSweep().catch((err) => logger.error({ err }, 'could not arm the backup tick'));

// Event actions (§7): fan one observed event out to whatever automation the
// customer registered for it. Registered here rather than riding the notify
// queue because an action's destination is a host we do not control — a slow
// or hostile resolver on one action must not sit in the lane that carries the
// pages. Capped at the browser-bound concurrency for the same reason: each job
// does a DNS lookup per destination, and those are the one thing here that can
// block for seconds.
//
// Wrapped in an arrow so register()'s second argument (the BullMQ Job) is never
// mistaken for processActionEvent's own deps parameter — that slot is the test
// seam for injecting a resolver, and a Job landing in it would be a silent
// no-op today and a confusing bug the day the two types grow a matching field.
// Same reasoning as the backup tick above.
register<ActionEventJob>(ACTIONS_QUEUE, config.concurrency, (payload) =>
  processActionEvent(payload),
);

logger.info(
  {
    concurrency: config.concurrency,
    queues: workers.length,
    llm: config.anthropicApiKey ? 'configured' : 'NO API KEY',
  },
  'qaai worker ready',
);

if (!config.anthropicApiKey) {
  logger.warn(
    'ANTHROPIC_API_KEY is not set — the run queue works, but Explorer, Generator, and Triage jobs will fail',
  );
}

/** Graceful shutdown (§11): let in-flight jobs finish before releasing handles. */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'draining workers');

    await Promise.all(workers.map((w) => w.close()));
    await closeProducers().catch(() => {});
    // retention.ts and backup.ts build their producers lazily and outside
    // queues.ts, so closeProducers() does not know about them. Left open, they
    // hold the process past the shutdown that is supposed to end it.
    await closeRetentionQueue().catch(() => {});
    await closeBackupQueue().catch(() => {});
    await closeActionsQueue().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    connection.disconnect();
    process.exit(0);
  });
}
