/**
 * `enqueueAnalyzeSource` — the worker's producer of `qaai.analyze-source`.
 *
 * It had no test, and it was the half of the bug nothing could see: the job id
 * is keyed on the PROJECT, the queue it is added to sets no
 * `defaultJobOptions`, and neither removal flag was passed. A BullMQ job id is
 * a Redis key, so the first completed analysis pinned that key for ever and
 * every later analysis of the project was dropped — no error, no failed job,
 * nothing on any screen. The function's own comment said "one analysis per
 * project in flight"; the code meant one per project EVER.
 *
 * `enqueueExplore`, in the same file, was fixed for exactly this and carries the
 * long comment about it. Its list of ids deliberately left permanent —
 * `run-<id>`, `triage-<resultId>`, `bisect-<id>-<step>`, `deliver-<id>` — does
 * not include this one. It was missed rather than decided, which is why this
 * file exists: the next person to read the producer should find the rule
 * asserted, not described.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueueAdd {
  queue: string;
  name: string;
  data: unknown;
  opts: Record<string, unknown>;
}

const h = vi.hoisted((): { queueAdds: QueueAdd[] } => ({ queueAdds: [] }));

vi.mock('./context.js', () => ({
  config: { concurrency: 2 },
  connection: {},
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: {},
}));

// Records every add() with its options — the options being the whole subject.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(
      public queueName: string,
      _opts: unknown,
    ) {}
    async add(name: string, data: unknown, opts: Record<string, unknown>): Promise<{ id: string }> {
      h.queueAdds.push({ queue: this.queueName, name, data, opts });
      return { id: typeof opts.jobId === 'string' ? opts.jobId : name };
    }
    async close(): Promise<void> {}
  },
}));

const { ANALYZE_SOURCE_QUEUE, enqueueAnalyzeSource } = await import('./queues.js');
const { analyzeSourceJobOptions } = await import('@qaai/shared');

const JOB = {
  orgId: 'org_1',
  projectId: 'proj_1',
  requestedBy: 'user_1',
  autoApprove: false,
};

beforeEach(() => {
  h.queueAdds.length = 0;
});

describe('enqueueAnalyzeSource', () => {
  it('adds the job to its own queue, payload intact', async () => {
    await enqueueAnalyzeSource(JOB);
    expect(h.queueAdds).toHaveLength(1);
    expect(h.queueAdds[0]?.queue).toBe(ANALYZE_SOURCE_QUEUE);
    expect(h.queueAdds[0]?.name).toBe(ANALYZE_SOURCE_QUEUE);
    expect(h.queueAdds[0]?.data).toEqual(JOB);
  });

  /*
   * Asserted against the shared options rather than against four literals,
   * because the defect was never one wrong value — it was that this producer
   * and the API's endpoint each had their own copy and the copies disagreed.
   * Re-inlining options here, however correct they looked, would turn this red.
   */
  it('uses the options the API’s producer uses, so the two cannot drift', async () => {
    await enqueueAnalyzeSource(JOB);
    expect(h.queueAdds[0]?.opts).toEqual(analyzeSourceJobOptions('proj_1'));
  });

  it('removes the job on completion AND on failure, so the id cannot swallow the next analysis', async () => {
    await enqueueAnalyzeSource(JOB);
    expect(h.queueAdds[0]?.opts.removeOnComplete).toBe(true);
    expect(h.queueAdds[0]?.opts.removeOnFail).toBe(true);
  });

  it('asks for one attempt, because the processor creates a FlowMap and a TestPlan', async () => {
    await enqueueAnalyzeSource(JOB);
    expect(h.queueAdds[0]?.opts.attempts).toBe(1);
  });

  it('locks per project', async () => {
    await enqueueAnalyzeSource(JOB);
    await enqueueAnalyzeSource({ ...JOB, projectId: 'proj_2' });
    expect(h.queueAdds.map((a) => a.opts.jobId)).toEqual([
      'analyze-source-proj_1',
      'analyze-source-proj_2',
    ]);
  });
});
