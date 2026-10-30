/**
 * `enqueueVerifyHeal` and `enqueueMutantClosure` — the two producers this round
 * adds to apps/worker/src/queues.ts.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Because a BullMQ JOB ID IS A REDIS KEY and nothing else in the suite can see
 * these two. `verifyHealJobOptions` is pinned in processors/verify-heal.test.ts
 * — but a producer that spread it and then overwrote `removeOnFail`, or that
 * ignored it entirely, would be undetectable. Exactly the hole
 * queues.analyze-source.test.ts was written for, which this file follows.
 *
 * MEASURED, against this repo's own Redis and this repo's own BullMQ, with a
 * real Worker driving the first job to each terminal state:
 *
 *   both flags, first job completed  → second add LANDS (waiting: 1)
 *   both flags, first job FAILED     → second add LANDS (waiting: 1)
 *   removeOnComplete only, failed    → second add SILENTLY DROPPED
 *                                      (failed: 1, waiting: 0), and `add()`
 *                                      still returns the id, so the caller
 *                                      cannot tell
 *   neither flag, first completed    → second add SILENTLY DROPPED
 *
 * For `verify-heal` a dropped enqueue means A HEAL NOTHING EVER RE-MEASURES:
 * the first verification of a heal fails transiently and that heal is then
 * unverifiable for ever, with no error anywhere. For `mutant-closure` it means
 * a run's mutation report that can never be closed. Both are the lie this
 * product cannot afford — a failure suppressed without being counted.
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

const {
  VERIFY_HEAL_QUEUE,
  MUTANT_CLOSURE_QUEUE,
  enqueueVerifyHeal,
  enqueueMutantClosure,
} = await import('./queues.js');
const { verifyHealJobOptions } = await import('./processors/verify-heal.js');

const HEAL_JOB = { orgId: 'org_1', healId: 'heal_1', reason: 'APPLY' as const };
const CLOSURE_JOB = { orgId: 'org_1', runId: 'run_1', reason: 'RUN_FINISHED' as const };

beforeEach(() => {
  h.queueAdds.length = 0;
});

describe('enqueueVerifyHeal', () => {
  it('adds the job to its own queue, payload intact', async () => {
    await enqueueVerifyHeal(HEAL_JOB);
    expect(h.queueAdds).toHaveLength(1);
    expect(h.queueAdds[0]?.queue).toBe(VERIFY_HEAL_QUEUE);
    expect(h.queueAdds[0]?.name).toBe(VERIFY_HEAL_QUEUE);
    // The REASON travels, because it is what decides whether the grace period
    // applies: an APPLY job IS the apply path's own start and must not be
    // refused for racing itself.
    expect(h.queueAdds[0]?.data).toEqual(HEAL_JOB);
  });

  /*
   * Asserted against `verifyHealJobOptions` rather than against three literals,
   * because the thing that must not drift is the producer and the module that
   * owns the reasoning having different answers. Re-inlining the options here,
   * however correct they looked, would turn this red.
   */
  it('uses the options the owning module declares, so the two cannot drift', async () => {
    await enqueueVerifyHeal(HEAL_JOB);
    expect(h.queueAdds[0]?.opts).toMatchObject(verifyHealJobOptions('heal_1'));
  });

  it('removes the job on completion AND on failure, or the next verification is dropped', async () => {
    await enqueueVerifyHeal(HEAL_JOB);
    expect(h.queueAdds[0]?.opts.removeOnComplete).toBe(true);
    // The one that was measured to matter: with this missing, a FAILED first
    // verification keeps the id in Redis and the heal is never re-measured.
    expect(h.queueAdds[0]?.opts.removeOnFail).toBe(true);
  });

  it('asks for one attempt, because a retry costs the customer a Run', async () => {
    // The processor decides from the ROW and reads everything fresh, so the
    // hole sweep's next enqueue is a better answer than a retry — and a retry
    // storm here means a verification Run per attempt against the plan toll.
    await enqueueVerifyHeal(HEAL_JOB);
    expect(h.queueAdds[0]?.opts.attempts).toBe(1);
  });

  it('locks per HEAL, not per org or per test', async () => {
    await enqueueVerifyHeal(HEAL_JOB);
    await enqueueVerifyHeal({ ...HEAL_JOB, healId: 'heal_2' });
    expect(h.queueAdds.map((a) => a.opts.jobId)).toEqual(['verify-heal-heal_1', 'verify-heal-heal_2']);
  });
});

describe('enqueueMutantClosure', () => {
  it('adds the job to its own queue, payload intact', async () => {
    await enqueueMutantClosure(CLOSURE_JOB);
    expect(h.queueAdds).toHaveLength(1);
    expect(h.queueAdds[0]?.queue).toBe(MUTANT_CLOSURE_QUEUE);
    expect(h.queueAdds[0]?.data).toEqual(CLOSURE_JOB);
  });

  it('locks per RUN, and the id is DASH-separated because BullMQ refuses a colon', async () => {
    /*
     * MEASURED: `mutant-closure:run_1` throws `Error: Custom Id cannot contain
     * :` inside `Job.validateOptions`, so every closure request would have
     * failed — a feature that cannot be asked for. Every other id in queues.ts
     * is dash-separated: `run-<id>`, `triage-<resultId>`,
     * `bisect-<id>-<step>`, `deliver-<id>`, `verify-heal-<id>`.
     */
    await enqueueMutantClosure(CLOSURE_JOB);
    expect(h.queueAdds[0]?.opts.jobId).toBe('mutant-closure-run_1');
    expect(String(h.queueAdds[0]?.opts.jobId)).not.toContain(':');
  });

  it('removes the job on completion AND on failure, or the report can never be re-asked', async () => {
    await enqueueMutantClosure(CLOSURE_JOB);
    expect(h.queueAdds[0]?.opts.removeOnComplete).toBe(true);
    expect(h.queueAdds[0]?.opts.removeOnFail).toBe(true);
  });

  it('asks for one attempt, because the processor writes one audit row per run', async () => {
    await enqueueMutantClosure(CLOSURE_JOB);
    expect(h.queueAdds[0]?.opts.attempts).toBe(1);
  });
});

describe('every per-entity id in this file carries both removal flags', () => {
  it('holds for the two producers this round added', async () => {
    /*
     * A loop rather than two more cases, because the rule is about the SHAPE:
     * a per-entity job id with a fixed string in it is a permanent Redis lock
     * unless both flags are present. The ids deliberately left permanent —
     * `run-<id>`, `triage-<resultId>`, `bisect-<id>-<step>`, `deliver-<id>` —
     * are one-shot-per-entity things where that is exactly what is wanted, and
     * neither of these two is: a heal can need re-measuring and a run's
     * mutation report can need re-closing.
     */
    await enqueueVerifyHeal(HEAL_JOB);
    await enqueueMutantClosure(CLOSURE_JOB);
    for (const add of h.queueAdds) {
      expect(typeof add.opts.jobId).toBe('string');
      expect(add.opts.removeOnComplete).toBe(true);
      expect(add.opts.removeOnFail).toBe(true);
    }
  });
});
