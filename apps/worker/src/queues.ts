/**
 * Worker-side producers. The run processor enqueues triage, and the explore
 * processor enqueues generation, so the worker needs to write to its own queues.
 */

import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import type { GenerateJob, RunJob, TriageJob } from '@qaai/shared';
import { connection } from './context.js';

const generateQueue = new Queue(QUEUE_NAMES.generate, { connection });
const runQueue = new Queue(QUEUE_NAMES.run, { connection });
const triageQueue = new Queue(QUEUE_NAMES.triage, { connection });

export async function enqueueGenerate(job: GenerateJob): Promise<void> {
  await generateQueue.add(QUEUE_NAMES.generate, job, { attempts: 2 });
}

export async function enqueueRun(job: RunJob): Promise<void> {
  await runQueue.add(QUEUE_NAMES.run, job, { jobId: `run-${job.runId}`, attempts: 1 });
}

export async function enqueueTriage(job: TriageJob): Promise<void> {
  await triageQueue.add(QUEUE_NAMES.triage, job, {
    // One triage per result, ever — a retried run job must not re-triage and
    // duplicate verdict rows.
    jobId: `triage-${job.testResultId}`,
    attempts: 2,
  });
}

export async function closeProducers(): Promise<void> {
  await Promise.all([generateQueue.close(), runQueue.close(), triageQueue.close()]);
}
