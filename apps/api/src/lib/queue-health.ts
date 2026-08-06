/**
 * Queue health — the operator's answer to "is the worker draining, or dead?"
 * (§5, §11).
 *
 * The problem this exists for: a queue with no live consumer looks exactly like
 * an idle one from every surface we already have. Depth is zero either way once
 * the failed jobs stop being counted, `/metrics` publishes counts but not the
 * reason anything failed, and the failed set itself sits in Redis where nobody
 * looks. So this module builds the one report that distinguishes the two: per
 * queue, what is waiting, what is executing, what has PERMANENTLY failed — and
 * for the failures, the newest one's name, error and timestamp, because "3
 * failed" without a reason is a number an operator cannot act on.
 *
 * ── Why this is a separate module rather than a route handler ───────────────
 *
 * Pure, deliberately: no Redis client, no env, no Express. The route hands it
 * live BullMQ Queue instances; the tests hand it fakes. That is the same seam
 * the metrics registry uses (lib/metrics.ts is tested without a server), and it
 * is what lets the report's SHAPE be pinned by unit tests while the wiring
 * stays three lines in routes/health.ts.
 *
 * ── Why the caller must authenticate, unlike /metrics ───────────────────────
 *
 * /metrics is unauthenticated and pays for that with a hard rule: aggregates
 * over closed vocabularies only, never an org, test, URL or error string. This
 * report deliberately breaks that rule — a failed job's error text is the whole
 * point, and error text can carry anything the processor threw, including a
 * customer's staging URL. So the endpoint that serves it (routes/health.ts,
 * `queueHealthRouter`) requires a session with ADMIN or better, and the error
 * is still cut to its first line here so a stack trace never rides along.
 */

import { QUEUE_NAMES } from '@qaai/shared';
import { BISECT_QUEUE } from './bisect.js';
import { CHECKS_QUEUE } from './github-app.js';

/**
 * Must match RETENTION_QUEUE in apps/worker/src/processors/retention.ts and
 * BACKUP_QUEUE in apps/worker/src/processors/backup.ts — the same duplicated
 * literals, for the same reason, as routes/retention.ts: those processors open
 * Postgres and Redis at import, so the constants cannot be imported from there,
 * and they have not (yet) moved into @qaai/shared. The unit test pins both.
 */
const RETENTION_QUEUE = 'qaai.retention';
const BACKUP_QUEUE = 'qaai.backup';

/**
 * Every queue the worker registers a consumer for — apps/worker/src/index.ts is
 * the source of truth. Deliberately WIDER than `queueDepths()` in lib/queues.ts,
 * which only covers QUEUE_NAMES: bisect, checks, retention and backup live
 * outside the shared constant (each file explains why), and a health report
 * that skipped them would reproduce the exact blind spot this feature removes —
 * those are the queues most likely to die unnoticed, because no customer is
 * staring at a spinner when they do.
 */
export const OPERATOR_QUEUE_NAMES: readonly string[] = [
  ...Object.values(QUEUE_NAMES),
  BISECT_QUEUE,
  CHECKS_QUEUE,
  RETENTION_QUEUE,
  BACKUP_QUEUE,
];

/** The states one summary reads. 'waiting' makes BullMQ count 'paused' too. */
type CountableState = 'waiting' | 'prioritized' | 'delayed' | 'active' | 'failed';

/** The slice of a BullMQ Job a failure summary reads. */
export interface FailedJobLike {
  id?: string;
  name: string;
  failedReason?: string;
  finishedOn?: number;
  attemptsMade: number;
}

/**
 * The slice of a BullMQ Queue this module reads. A real `Queue` satisfies it
 * structurally; the tests satisfy it with fakes and no Redis.
 */
export interface HealthReadableQueue {
  name: string;
  getJobCounts(...types: CountableState[]): Promise<Record<string, number>>;
  getFailed(start: number, end: number): Promise<FailedJobLike[]>;
}

export interface QueueFailure {
  jobId: string | null;
  /** The BullMQ job name — our own constants ('qaai.run', 'tick'), never customer data. */
  name: string;
  /** First line of the failure reason, capped. See failureErrorText. */
  error: string;
  /** ISO timestamp of the failure. Null only if BullMQ never stamped finishedOn. */
  failedAt: string | null;
  attemptsMade: number;
}

export interface QueueCounts {
  /** Jobs in line to run now: BullMQ's wait + paused + prioritized lists. */
  waiting: number;
  /**
   * Scheduled for later — kept apart from `waiting` because the repeatable
   * ticks (schedule, flake, retention, checks) live here between fires, and
   * folding them in would make a healthy idle install read as backed up.
   */
  delayed: number;
  active: number;
  failed: number;
}

export interface QueueHealthRow {
  queue: string;
  /** Null when this queue could not be read — unknown, never zeros standing in. */
  counts: QueueCounts | null;
  newestFailure: QueueFailure | null;
}

export interface QueueHealthReport {
  generatedAt: string;
  queues: QueueHealthRow[];
}

export const MAX_FAILURE_ERROR_CHARS = 300;

/**
 * The one line of an error worth serving.
 *
 * First line only: BullMQ's `failedReason` is `err.message`, but processors
 * that wrap errors routinely produce multi-line messages with a stack attached,
 * and a stack names file paths and — in a browser error — the customer URL that
 * was being visited. The first line is where the human-readable cause lives.
 * Capped as well, because an error built from a response body can be arbitrarily
 * large and this travels to a browser on a 10-second poll.
 */
export function failureErrorText(reason: string | null | undefined): string {
  const firstLine = (reason ?? '').split('\n', 1)[0]!.trim();
  if (!firstLine) return 'failed with no error message';
  return firstLine.length > MAX_FAILURE_ERROR_CHARS
    ? `${firstLine.slice(0, MAX_FAILURE_ERROR_CHARS - 1)}…`
    : firstLine;
}

async function summarize(queue: HealthReadableQueue): Promise<QueueHealthRow> {
  const raw = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active', 'failed');

  const counts: QueueCounts = {
    // 'prioritized' is where the background runs sit (queues.ts stamps flake
    // re-runs and bisect probes with a priority, which moves them off the wait
    // list), and 'paused' is the wait list of a paused queue. Both are jobs in
    // line right now; reporting the wait list alone would show a queue full of
    // background work as empty.
    waiting: (raw.waiting ?? 0) + (raw.paused ?? 0) + (raw.prioritized ?? 0),
    delayed: raw.delayed ?? 0,
    active: raw.active ?? 0,
    failed: raw.failed ?? 0,
  };

  let newestFailure: QueueFailure | null = null;
  if (counts.failed > 0) {
    // getFailed walks the failed set newest-first, so (0, 0) is exactly the
    // most recent failure — one job fetched, not a page of them.
    const [job] = await queue.getFailed(0, 0);
    if (job) {
      newestFailure = {
        jobId: job.id ?? null,
        name: job.name,
        error: failureErrorText(job.failedReason),
        failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        attemptsMade: job.attemptsMade,
      };
    }
  }

  return { queue: queue.name, counts, newestFailure };
}

/**
 * Read every queue, failing alone per queue.
 *
 * A queue whose reads throw yields `counts: null` rather than disappearing or
 * failing the report: vanished rows are how a dead queue went unnoticed in the
 * first place, and one unreadable queue must not blind the operator to the
 * other twelve. (A fully unreachable Redis does not reach this catch — the
 * producer connection retries forever — which is why the route puts a hard
 * timeout around the whole call and answers 503.)
 */
export async function collectQueueHealth(
  queues: readonly HealthReadableQueue[],
): Promise<QueueHealthReport> {
  const rows = await Promise.all(
    queues.map((queue) =>
      summarize(queue).catch(
        (): QueueHealthRow => ({ queue: queue.name, counts: null, newestFailure: null }),
      ),
    ),
  );
  return { generatedAt: new Date().toISOString(), queues: rows };
}
