/**
 * Tests for the queue-health report — the shape GET /health/queues serves.
 *
 * What is being pinned, and why it is worth a file:
 *
 *  1. THE SHAPE. The runners screen renders this on a poll and fails soft on
 *     anything unexpected, so a drifted field name does not error anywhere —
 *     the queue block just quietly disappears, which is the exact "dead queue
 *     looks idle" blindness the feature exists to remove. The shape test is the
 *     only thing that makes that drift loud.
 *
 *  2. WHAT COUNTS AS WAITING. The background runs (flake confirmation, bisect
 *     probes) are stamped with a priority, which moves them off BullMQ's wait
 *     list into 'prioritized'. A report that read the wait list alone would
 *     show a queue full of background work as empty — asserted directly,
 *     because it is the kind of correction a refactor "simplifies" away.
 *
 *  3. FAILING ALONE. One unreadable queue must neither vanish from the report
 *     nor take the other twelve with it, and its absence of numbers must be
 *     null — an unknown — rather than zeros pretending to be a reading.
 *
 *  4. THE QUEUE LIST. Bisect, checks, retention and backup live outside
 *     QUEUE_NAMES (their files explain why), and each was once — or would have
 *     been — the queue that died unnoticed. The literals are pinned here the
 *     same way retention.test.ts pins 'qaai.retention'.
 *
 * Pure fakes, no Redis: collectQueueHealth takes anything satisfying
 * HealthReadableQueue, which is the same seam the route uses with real BullMQ
 * Queue instances.
 */

import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '@qaai/shared';
import {
  MAX_FAILURE_ERROR_CHARS,
  OPERATOR_QUEUE_NAMES,
  collectQueueHealth,
  failureErrorText,
  type FailedJobLike,
  type HealthReadableQueue,
} from './queue-health.js';

/** A queue whose every read succeeds with the given counts and failed jobs. */
function fakeQueue(
  name: string,
  counts: Partial<Record<string, number>> = {},
  failedJobs: FailedJobLike[] = [],
): HealthReadableQueue & { getFailedCalls: Array<[number, number]> } {
  const getFailedCalls: Array<[number, number]> = [];
  return {
    name,
    getFailedCalls,
    getJobCounts: async () => ({
      waiting: 0,
      prioritized: 0,
      paused: 0,
      delayed: 0,
      active: 0,
      failed: failedJobs.length,
      ...counts,
    }),
    getFailed: async (start, end) => {
      getFailedCalls.push([start, end]);
      return failedJobs.slice(start, end + 1);
    },
  };
}

const failedJob = (over: Partial<FailedJobLike> = {}): FailedJobLike => ({
  id: 'run-abc123',
  name: 'qaai.run',
  failedReason: 'browser crashed before the suite finished',
  finishedOn: Date.UTC(2026, 7, 6, 12, 0, 0),
  attemptsMade: 1,
  ...over,
});

describe('the report shape', () => {
  it('serves exactly the fields the runners screen reads, per queue', async () => {
    const report = await collectQueueHealth([
      fakeQueue('qaai.run', { waiting: 2, active: 1 }, [failedJob()]),
    ]);

    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'queues']);
    expect(report.queues).toHaveLength(1);

    const row = report.queues[0]!;
    expect(Object.keys(row).sort()).toEqual(['counts', 'newestFailure', 'queue']);
    expect(row.queue).toBe('qaai.run');
    expect(row.counts).toEqual({ waiting: 2, delayed: 0, active: 1, failed: 1 });
    expect(row.newestFailure).toEqual({
      jobId: 'run-abc123',
      name: 'qaai.run',
      error: 'browser crashed before the suite finished',
      failedAt: '2026-08-06T12:00:00.000Z',
      attemptsMade: 1,
    });
    // ISO or nothing — the UI feeds this straight into new Date().
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  it('keeps every queue on its own row, in the order given', async () => {
    const report = await collectQueueHealth([
      fakeQueue('qaai.run'),
      fakeQueue('qaai.triage'),
      fakeQueue('qaai.retention'),
    ]);
    expect(report.queues.map((q) => q.queue)).toEqual(['qaai.run', 'qaai.triage', 'qaai.retention']);
  });
});

describe('what counts as waiting', () => {
  it('folds prioritized and paused jobs into waiting', async () => {
    /*
     * The background-run case. queues.ts stamps flake re-runs and bisect probes
     * with a priority, which moves them to the 'prioritized' list; a paused
     * queue parks its wait list under 'paused'. Both are jobs in line right
     * now, and a queue holding forty of them must not report as empty.
     */
    const report = await collectQueueHealth([
      fakeQueue('qaai.run', { waiting: 1, prioritized: 3, paused: 2 }),
    ]);
    expect(report.queues[0]!.counts?.waiting).toBe(6);
  });

  it('keeps delayed jobs out of waiting, because the repeatable ticks live there', async () => {
    // schedule/flake/retention/checks sit 'delayed' between fires on a healthy
    // idle install. Folding them into waiting would make health read as backlog.
    const report = await collectQueueHealth([fakeQueue('qaai.schedule', { delayed: 4 })]);
    expect(report.queues[0]!.counts).toEqual({ waiting: 0, delayed: 4, active: 0, failed: 0 });
  });
});

describe('the newest failure', () => {
  it('asks for exactly the newest failed job and nothing more', async () => {
    // getFailed walks the failed set newest-first; (0, 0) is one job. A page of
    // forty failures serialised onto a 10-second poll would be pure waste.
    const queue = fakeQueue('qaai.run', {}, [failedJob(), failedJob({ id: 'older' })]);
    const report = await collectQueueHealth([queue]);

    expect(queue.getFailedCalls).toEqual([[0, 0]]);
    expect(report.queues[0]!.newestFailure?.jobId).toBe('run-abc123');
  });

  it('does not touch the failed set at all when nothing has failed', async () => {
    const queue = fakeQueue('qaai.notify', { waiting: 1 });
    const report = await collectQueueHealth([queue]);

    expect(queue.getFailedCalls).toEqual([]);
    expect(report.queues[0]!.newestFailure).toBeNull();
  });

  it('survives a failed count with no retrievable job', async () => {
    // The count and the set are read in two round trips; a job cleaned up in
    // between must degrade to "3 failed, no detail", not to a crash.
    const queue = fakeQueue('qaai.run', { failed: 3 }, []);
    const report = await collectQueueHealth([queue]);

    expect(report.queues[0]!.counts?.failed).toBe(3);
    expect(report.queues[0]!.newestFailure).toBeNull();
  });

  it('reports a null timestamp rather than inventing one', async () => {
    const report = await collectQueueHealth([
      fakeQueue('qaai.run', {}, [failedJob({ finishedOn: undefined })]),
    ]);
    expect(report.queues[0]!.newestFailure?.failedAt).toBeNull();
  });

  it('reports a null job id rather than an empty string', async () => {
    const report = await collectQueueHealth([
      fakeQueue('qaai.run', {}, [failedJob({ id: undefined })]),
    ]);
    expect(report.queues[0]!.newestFailure?.jobId).toBeNull();
  });
});

describe('the error text', () => {
  it('keeps the first line only, where the human-readable cause lives', () => {
    // failedReason is err.message, and wrapped errors routinely arrive with a
    // stack attached — which names file paths and, in a browser error, the
    // customer URL that was being visited.
    const reason = 'net::ERR_NAME_NOT_RESOLVED\n    at goto (https://staging.example.com/login)';
    expect(failureErrorText(reason)).toBe('net::ERR_NAME_NOT_RESOLVED');
    expect(failureErrorText(reason)).not.toContain('staging.example.com');
  });

  it('caps a pathological one-liner', () => {
    const text = failureErrorText('x'.repeat(5_000));
    expect(text.length).toBe(MAX_FAILURE_ERROR_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('says so when there is no message, rather than serving an empty string', () => {
    // An empty error row on the screen reads as a rendering bug, not a fact.
    expect(failureErrorText(undefined)).toBe('failed with no error message');
    expect(failureErrorText('')).toBe('failed with no error message');
    expect(failureErrorText('   \nstack')).toBe('failed with no error message');
  });
});

describe('failing alone', () => {
  it('marks an unreadable queue null and leaves the others intact', async () => {
    const broken: HealthReadableQueue = {
      name: 'qaai.checks',
      getJobCounts: async () => {
        throw new Error('LOADING Redis is loading the dataset in memory');
      },
      getFailed: async () => [],
    };
    const report = await collectQueueHealth([fakeQueue('qaai.run', { active: 2 }), broken]);

    expect(report.queues).toHaveLength(2);
    expect(report.queues[0]!.counts?.active).toBe(2);
    // Null, not zeros: zeros are a reading, and this queue was not read. A row
    // that vanished instead would recreate the blindness this report removes.
    expect(report.queues[1]).toEqual({ queue: 'qaai.checks', counts: null, newestFailure: null });
  });

  it('degrades a queue whose failed set is unreadable to its counts', async () => {
    const halfBroken: HealthReadableQueue = {
      name: 'qaai.run',
      getJobCounts: async () => ({ waiting: 0, delayed: 0, active: 0, failed: 2 }),
      getFailed: async () => {
        throw new Error('boom');
      },
    };
    const report = await collectQueueHealth([halfBroken]);
    // Today the whole row degrades to null — the honest reading, since a report
    // that showed counts while silently dropping the failure detail would look
    // healthier than the queue is. Pinned so a change here is a decision.
    expect(report.queues[0]!.counts).toBeNull();
  });
});

describe('the queue list the endpoint reads', () => {
  it('covers every queue in QUEUE_NAMES', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(OPERATOR_QUEUE_NAMES).toContain(name);
    }
  });

  it('covers the four queues that live outside QUEUE_NAMES', () => {
    /*
     * Pinned as literals, mirroring how retention.test.ts pins its queue name:
     * each of these is spelled in at least two files that may not import each
     * other, and a drift means the health report watches a queue that does not
     * exist while the real one dies unwatched.
     */
    for (const name of ['qaai.bisect', 'qaai.checks', 'qaai.retention', 'qaai.backup']) {
      expect(OPERATOR_QUEUE_NAMES).toContain(name);
    }
  });

  it('names each queue once', () => {
    expect(new Set(OPERATOR_QUEUE_NAMES).size).toBe(OPERATOR_QUEUE_NAMES.length);
  });
});
