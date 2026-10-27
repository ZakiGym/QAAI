/**
 * The options one queue's two producers share.
 *
 * `analyzeSourceJobOptions` exists because the API and the worker each produce
 * `qaai.analyze-source` and each had the opposite half of one bug: the API
 * inherited the queue's default of three attempts onto a processor that creates
 * a FlowMap version and a TestPlan, and the worker pinned a per-project job id
 * while retaining the finished job, so the key outlived the run and every later
 * analysis of that project was dropped.
 *
 * Both halves are asserted here rather than at the two call sites, because the
 * point of the function is that there is one answer. A test per producer would
 * pass with two different answers in it.
 */

import { describe, expect, it } from 'vitest';
import { ANALYZE_SOURCE_ATTEMPTS, analyzeSourceJobOptions } from './jobs.js';

describe('analyzeSourceJobOptions', () => {
  /*
   * The processor calls `flowMap.create` and `testPlan.create` — plain creates,
   * not upserts. A second attempt does not re-do the work, it duplicates it,
   * and the person is left approving one of two identical plans. Nothing about
   * that is visible as an error: both attempts "succeed".
   */
  it('allows exactly one attempt, because the processor writes rows it cannot de-duplicate', () => {
    expect(analyzeSourceJobOptions('proj_1').attempts).toBe(1);
    expect(ANALYZE_SOURCE_ATTEMPTS).toBe(1);
  });

  /*
   * THE SWALLOW. A BullMQ job id is a Redis key, and this one is keyed on the
   * PROJECT rather than on a one-shot entity like a run or a result. A retained
   * completed — or FAILED — job keeps that key and every later `add()` for the
   * project collapses onto the corpse: the API still answers 202
   * `{ queued: true }`, the audit row still records `source.analyze`, and no
   * plan is ever proposed. Both flags, or the id is a permanent lock rather
   * than an in-flight one.
   */
  it('removes the job on completion AND on failure, so the id cannot outlive the run', () => {
    const opts = analyzeSourceJobOptions('proj_1');
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  it('keys the id on the project, which is what makes the two flags mandatory', () => {
    expect(analyzeSourceJobOptions('proj_1').jobId).toBe('analyze-source-proj_1');
    expect(analyzeSourceJobOptions('proj_2').jobId).toBe('analyze-source-proj_2');
  });

  /*
   * One analysis per project IN FLIGHT is the intended lock, so two projects
   * must never coalesce onto each other — that would be the same swallow with
   * a wider blast radius.
   */
  it('gives two projects two different ids', () => {
    expect(analyzeSourceJobOptions('proj_1').jobId).not.toBe(
      analyzeSourceJobOptions('proj_2').jobId,
    );
  });

  it('returns a fresh object, so a caller cannot mutate the next caller’s options', () => {
    const first = analyzeSourceJobOptions('proj_1');
    const before = first.attempts;
    first.attempts = before + 98;
    first.jobId = 'mutated';
    const second = analyzeSourceJobOptions('proj_1');
    expect(second.attempts).toBe(before);
    expect(second.jobId).toBe('analyze-source-proj_1');
  });
});
