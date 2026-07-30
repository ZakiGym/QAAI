/**
 * Worker entrypoint (§5).
 *
 * One BullMQ Worker per queue, each with its own concurrency. The E2E queue is
 * the constrained one — every job launches a browser — so it runs at the
 * configured worker count while the cheap queues run wider.
 */

import { Worker, type Job } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import type { CopilotJob, ExploreJob, GenerateJob, RunJob, TriageJob } from '@qaai/shared';
import { config, connection, logger, prisma } from './context.js';
import { closeProducers } from './queues.js';
import { processExplore } from './processors/explore.js';
import { processGenerate } from './processors/generate.js';
import { processRun } from './processors/run.js';
import { processTriage } from './processors/triage.js';
import { processCopilot } from './processors/copilot.js';

const workers: Worker[] = [];

function register<T>(
  name: string,
  concurrency: number,
  handler: (payload: T) => Promise<void>,
): void {
  const worker = new Worker(
    name,
    async (job: Job<T>) => {
      const started = Date.now();
      logger.info({ queue: name, jobId: job.id }, 'job started');
      try {
        await handler(job.data);
        logger.info({ queue: name, jobId: job.id, ms: Date.now() - started }, 'job finished');
      } catch (err) {
        logger.error({ err, queue: name, jobId: job.id }, 'job failed');
        throw err;
      }
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
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
    await prisma.$disconnect().catch(() => {});
    connection.disconnect();
    process.exit(0);
  });
}
