/**
 * Queue producers (§5). The API only ever enqueues; the worker owns consumption.
 *
 * One shared ioredis connection: BullMQ opens its own blocking connections per
 * Worker, but a producer needs exactly one, and creating a client per enqueue
 * exhausts Redis connections under load.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { QUEUE_NAMES } from '@qaai/shared';
import type { JobPayloads } from '@qaai/shared';
import { env } from '../env.js';
import { logger } from './logger.js';
import { OPERATOR_QUEUE_NAMES } from './queue-health.js';

const connection = new IORedis(env.REDIS_URL, {
  // BullMQ requires this; without it a job can be silently dropped when Redis
  // is briefly unreachable instead of retrying.
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => logger.error({ err }, 'redis connection error'));

const queues = new Map<string, Queue>();

function queueFor(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Keep a window of history for the admin panel without unbounded growth.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    queues.set(name, queue);
  }
  return queue;
}

export async function enqueue<K extends keyof JobPayloads>(
  name: K,
  payload: JobPayloads[K],
  // `attempts` overrides the queue default (3). A job whose processor is not
  // idempotent — like import, which inserts rows — must pass attempts:1 so a
  // transient failure does not silently re-run and double its writes.
  //
  // `removeOnComplete`/`removeOnFail` exist for one case and must be passed
  // TOGETHER with a `jobId` that is keyed on something long-lived — a project
  // rather than a run. The queue default retains a completed job for 24 hours,
  // and a retained job keeps its id as a Redis key, so every later `add()`
  // under that id is dropped and this function still returns an id and still
  // logs "job enqueued". Setting both turns the id from a permanent lock into
  // an in-flight-only one. See `analyzeSourceJobOptions` in
  // packages/shared/src/jobs.ts for the whole argument.
  opts: {
    jobId?: string;
    delayMs?: number;
    attempts?: number;
    removeOnComplete?: boolean;
    removeOnFail?: boolean;
  } = {},
): Promise<string> {
  const job = await queueFor(name).add(name, payload, {
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(opts.attempts ? { attempts: opts.attempts } : {}),
    ...(opts.removeOnComplete === undefined
      ? {}
      : { removeOnComplete: opts.removeOnComplete }),
    ...(opts.removeOnFail === undefined ? {} : { removeOnFail: opts.removeOnFail }),
  });
  logger.info({ queue: name, jobId: job.id }, 'job enqueued');
  return String(job.id);
}

export async function queueDepths(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of Object.values(QUEUE_NAMES)) {
    out[name] = await queueFor(name).getWaitingCount();
  }
  return out;
}

/**
 * One Queue handle per queue the worker drains, for the queue-health report.
 *
 * Reuses `queueFor`'s cached instances and the single shared connection, so the
 * health endpoint costs no sockets beyond what enqueuing already pays. Wider
 * than `queueDepths()` above deliberately: that one predates the bisect, checks
 * and retention queues and only sees QUEUE_NAMES, and those three are exactly
 * the queues most likely to die unnoticed — nobody is watching a spinner when
 * a retention sweep stops being consumed.
 */
export function operatorQueues(): Queue[] {
  return OPERATOR_QUEUE_NAMES.map((name) => queueFor(name));
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await connection.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  connection.disconnect();
}
