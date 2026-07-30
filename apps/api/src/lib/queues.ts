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
  opts: { jobId?: string; delayMs?: number; attempts?: number } = {},
): Promise<string> {
  const job = await queueFor(name).add(name, payload, {
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(opts.attempts ? { attempts: opts.attempts } : {}),
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
