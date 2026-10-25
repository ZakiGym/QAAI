/**
 * The jobs plugin, and the one lie it must never tell.
 *
 * The wait for a consumer is bounded, because an unbounded one would hang a
 * run. When the bound expires nothing is known: the consumer may be slow, the
 * worker may be scaled to zero, or the job may genuinely never be picked up.
 * Reporting that as FAILED would make QAAI blame the customer's application for
 * QAAI's OWN timeout — in the one place a customer cannot cheaply check, which
 * is how a false failure survives to become a support ticket.
 *
 * So the heaviest block here is "an expired wait is UNKNOWN, not FAILED", and
 * the counter-tests matter as much: a consumer that really runs twice, really
 * duplicates on redelivery, or really misses its window must still fail, or
 * UNKNOWN becomes a way to make every async bug disappear.
 *
 * Every wait in this file runs on a FAKE CLOCK. Nothing sleeps.
 */

import { describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import {
  JOB_ASSERTIONS,
  JOB_ASSERTION_LABELS,
  JOB_ASSERTION_PRESENCE,
  expiredWaitWhy,
  jobAssertionSchema,
  jobsPlugin,
  jobsTestSpecSchema,
  realJobClock,
  runAssertion,
  runJobsTest,
  unavailableEffectProbe,
  unavailableJobQueue,
  waitFor,
} from './jobs.js';
import type {
  DeadLetterEntry,
  JobClock,
  JobDelivery,
  JobEffectProbe,
  JobQueueSurface,
  JobsTestSpec,
} from './jobs.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A clock that never sleeps.
 *
 * `sleep` ADVANCES the clock instead of waiting, so a 30-second budget is
 * exhausted in microseconds and the EXPIRED paths — unreachable through a real
 * queue that happens to be fast — are the easiest ones to test.
 */
function fakeClock(): JobClock & { elapsed: () => number } {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    elapsed: () => now - 1_000_000,
  };
}

interface FakeQueueOptions {
  /** Deliveries, re-read on every poll; a function models a consumer arriving. */
  deliveries?: (poll: number) => JobDelivery[];
  deadLetter?: (poll: number) => DeadLetterEntry | null;
  lastFire?: string | null;
  canInjectFailure?: boolean;
  enqueueThrows?: Error;
}

function fakeQueue(options: FakeQueueOptions = {}): JobQueueSurface & {
  redelivered: number;
  polls: number;
} {
  const state = { redelivered: 0, polls: 0, dlqPolls: 0 };
  return {
    get redelivered() {
      return state.redelivered;
    },
    get polls() {
      return state.polls;
    },
    enqueue: async () => {
      if (options.enqueueThrows) throw options.enqueueThrows;
      return { jobId: 'job_1' };
    },
    deliveries: async () => {
      state.polls += 1;
      return options.deliveries?.(state.polls) ?? [];
    },
    redeliver: async () => {
      state.redelivered += 1;
    },
    deadLetter: async () => {
      state.dlqPolls += 1;
      return options.deadLetter?.(state.dlqPolls) ?? null;
    },
    lastScheduledFireAt: async () => options.lastFire ?? null,
    injectFailure: async () => options.canInjectFailure ?? true,
  };
}

/** An effect probe whose count the test controls. */
function fakeEffect(counts: number[]): JobEffectProbe & { reads: number } {
  const state = { reads: 0 };
  return {
    get reads() {
      return state.reads;
    },
    observe: async () => {
      const value = counts[Math.min(state.reads, counts.length - 1)] ?? 0;
      state.reads += 1;
      return { count: value };
    },
  };
}

const ok = (attempt: number): JobDelivery => ({
  attempt,
  status: 'SUCCEEDED',
  startedAt: new Date().toISOString(),
});

function makeCtx(signal?: AbortSignal): RunContext & { logged: string[] } {
  const logged: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://localhost:3000',
    secrets: {},
    storageState: null,
    artifacts: {
      put: async () => 'key',
      putFile: async () => 'key',
      get: async () => null,
      putPersistent: async () => 'key',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: (event) => logged.push(`${event.status} ${event.title}`),
    },
    signal: signal ?? new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    logged,
  };
}

function makeTest(spec: unknown, name = 'the welcome mail is sent once'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    type: 'E2E', // JOBS is not in TEST_TYPES yet — see registry.test.ts.
    code: '',
    filePath: 'jobs/welcome-mail.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

function makeSpec(overrides: Record<string, unknown> = {}): JobsTestSpec {
  return jobsTestSpecSchema.parse({
    queue: 'mail',
    job: 'welcome',
    assertions: ['EXACTLY_ONCE'],
    waitMs: 1_000,
    pollIntervalMs: 100,
    ...overrides,
  });
}

function outline(execution: TestExecution): string[] {
  return execution.steps.map((step) => `${step.status} ${step.title}`);
}

const noSignal = new AbortController().signal;

// ─── The vocabulary guard ────────────────────────────────────────────────────

describe('the assertion vocabulary cannot drift from the schema or the branches', () => {
  it('keeps the presence record, the list and the zod enum one set', () => {
    // The compiler enforces the record; this enforces the run-time half. Eight
    // GateRule kinds shipped unsaveable because only one of the two existed.
    expect(Object.keys(JOB_ASSERTION_PRESENCE).sort()).toEqual([...JOB_ASSERTIONS].sort());
    expect([...jobAssertionSchema.options].sort()).toEqual([...JOB_ASSERTIONS].sort());
    for (const assertion of JOB_ASSERTIONS) {
      expect(JOB_ASSERTION_LABELS[assertion], assertion).toBeTruthy();
    }
  });

  it('gives every assertion a branch that reaches a verdict', async () => {
    /*
     * The failure the other two guards cannot catch: a kind the schema accepts
     * and `runAssertion` silently falls through. A fall-through would return
     * undefined here, so this is the test that would have caught the GateRule
     * defect.
     */
    const spec = makeSpec({
      assertions: [...JOB_ASSERTIONS],
      deadLetter: { maxAttempts: 3, queue: 'mail-dlq' },
      schedule: { expectedAt: new Date().toISOString(), toleranceMs: 1000 },
    });
    for (const assertion of JOB_ASSERTIONS) {
      const result = await runAssertion(
        assertion,
        spec,
        'job_1',
        { queue: fakeQueue(), effect: fakeEffect([0]), clock: fakeClock() },
        noSignal,
      );
      expect(result, assertion).toBeDefined();
      expect(result.assertion, assertion).toBe(assertion);
      expect(['MET', 'UNMET', 'UNKNOWN', 'UNAVAILABLE'], assertion).toContain(result.verdict);
    }
  });
});

// ─── The bounded wait ────────────────────────────────────────────────────────

describe('waitFor', () => {
  it('asks the predicate once before sleeping, so an already-true condition costs nothing', async () => {
    const clock = fakeClock();
    const result = await waitFor(async () => true, 30_000, 250, noSignal, clock);

    expect(result.outcome).toBe('MET');
    expect(result.polls).toBe(1);
    expect(result.waitedMs).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it('reports EXPIRED, which is a THIRD outcome and not a false', async () => {
    const result = await waitFor(async () => false, 1_000, 250, noSignal, fakeClock());

    expect(result.outcome).toBe('EXPIRED');
    expect(result.outcome).not.toBe('MET');
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
  });

  it('never sleeps past the budget, so the disclosed number is true', async () => {
    /*
     * A 250ms interval against a 100ms remainder would report "waited 1150ms"
     * on a 1000ms budget. The disclosure sentence prints that number, so it
     * has to be a number that happened.
     */
    const result = await waitFor(async () => false, 1_050, 400, noSignal, fakeClock());
    expect(result.waitedMs).toBe(1_050);
  });

  it('stops on cancellation and says so, rather than reporting a timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitFor(async () => false, 30_000, 250, controller.signal, fakeClock());

    expect(result.outcome).toBe('CANCELLED');
  });

  it('becomes MET when the condition turns true partway through', async () => {
    let calls = 0;
    const result = await waitFor(
      async () => {
        calls += 1;
        return calls >= 3;
      },
      10_000,
      100,
      noSignal,
      fakeClock(),
    );

    expect(result.outcome).toBe('MET');
    expect(result.polls).toBe(3);
  });
});

describe('the expired-wait sentence is a count AND a reason', () => {
  it('says UNKNOWN, names the budget, and says the outcome is not evidence', () => {
    const why = expiredWaitWhy('"welcome" to be consumed', 30_000, 30_000, 121);

    expect(why).toMatch(/^UNKNOWN, not failed/);
    expect(why).toMatch(/waited 30000ms \(121 poll\(s\)\)/);
    expect(why).toMatch(/30000ms waitMs budget expired/);
    expect(why).toMatch(/nothing is asserted about your application either way/);
    expect(why).toMatch(/Raise `waitMs`/);
  });
});

// ─── A timeout is never a failure ────────────────────────────────────────────

describe('a consumer that never arrived is UNKNOWN, never FAILED', () => {
  it('reports UNKNOWN for EXACTLY_ONCE when the wait expires', async () => {
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      { queue: fakeQueue({ deliveries: () => [] }), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.verdict).not.toBe('UNMET');
    expect(result.detail).toMatch(/UNKNOWN, not failed/);
  });

  it('makes the whole test SKIPPED with notRun, not FAILED, when nothing was measured', async () => {
    /*
     * The headline. A run that timed out waiting must not put a red mark on
     * the customer's consumer code — and it must not be PASSED either, because
     * it measured nothing at all.
     */
    const execution = await runJobsTest(
      makeCtx(),
      makeTest({}),
      makeSpec(),
      { queue: fakeQueue({ deliveries: () => [] }), effect: fakeEffect([0]), clock: fakeClock() },
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.status).not.toBe('FAILED');
    expect(execution.status).not.toBe('PASSED');
    // NOT_RUN and deliberately not BLOCKED_BY_ENV: a timed-out wait does not
    // establish that the environment was broken.
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.notRun?.why).toMatch(/None of this test's 1 assertion\(s\) could be measured/);
    // The budget that bit travels into the reason, so the reader can act.
    expect(execution.notRun?.why).toMatch(/1000ms waitMs budget expired/);
    // And the step is SKIPPED with no error object, because nothing failed.
    expect(execution.steps[0]!.status).toBe('SKIPPED');
    expect(execution.steps[0]!.error).toBeNull();
  });

  it('does not let an UNKNOWN turn a measured pass into a failure', async () => {
    // A mix of MET and UNKNOWN is a pass for what was measured, with the rest
    // disclosed — not a failure, and not silence.
    const execution = await runJobsTest(
      makeCtx(),
      makeTest({}),
      makeSpec({
        assertions: ['EXACTLY_ONCE', 'SCHEDULED'],
        schedule: { expectedAt: new Date().toISOString(), toleranceMs: 1_000 },
      }),
      {
        queue: fakeQueue({ deliveries: (poll) => (poll >= 1 ? [ok(1)] : []), lastFire: null }),
        effect: fakeEffect([1]),
        clock: fakeClock(),
      },
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toMatch(/1 of 2 assertion\(s\) were NOT measured/);
    expect(execution.errorMessage).toMatch(/SCHEDULED \(UNKNOWN\)/);
    expect(execution.console.some((c) => /was not measured/.test(c.text))).toBe(true);
  });

  it('reports BLOCKED_BY_ENV when the queue could not even be reached', async () => {
    // A broken connection string is not a failing consumer.
    const execution = await runJobsTest(
      makeCtx(),
      makeTest({}),
      makeSpec(),
      {
        queue: fakeQueue({ enqueueThrows: new Error('ECONNREFUSED 127.0.0.1:6379') }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
    expect(execution.notRun?.why).toMatch(/ECONNREFUSED/);
    expect(execution.steps).toEqual([]);
  });
});

// ─── EXACTLY_ONCE ────────────────────────────────────────────────────────────

describe('EXACTLY_ONCE', () => {
  it('passes on one delivery and says no second one arrived', async () => {
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      { queue: fakeQueue({ deliveries: () => [ok(1)] }), effect: fakeEffect([1]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('MET');
    expect(result.detail).toMatch(/Consumed once, and no second delivery arrived/);
  });

  it('FAILS on a consumer that ran twice, which is the defect it exists for', async () => {
    /*
     * The counter-test. A consumer that runs twice sends two emails and bills
     * two charges, and the second one is invisible in any log that only
     * records "processed".
     */
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      {
        queue: fakeQueue({ deliveries: () => [ok(1), ok(2)] }),
        effect: fakeEffect([2]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/was consumed 2 times for one enqueue/);
  });

  it('does NOT pass when the run was cancelled during the quiet window', async () => {
    /*
     * The quiet window IS the measurement here: a second delivery can only
     * arrive after the first, so "no second one arrived" is a claim about a
     * stretch of time we watched. Cancellation returns from that wait after 0ms,
     * and this reported MET — "Consumed once, and no second delivery arrived in
     * 0ms" — a pass on a window nobody observed. IDEMPOTENT below has
     * distinguished CANCELLED from EXPIRED since it was written; the asymmetry
     * was the defect.
     */
    const controller = new AbortController();
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      {
        queue: fakeQueue({
          deliveries: () => {
            // Cancelled the moment the first delivery is seen, so the first wait
            // returns MET and the quiet wait is entered already aborted.
            controller.abort();
            return [ok(1)];
          },
        }),
        effect: fakeEffect([1]),
        clock: fakeClock(),
      },
      controller.signal,
    );

    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.detail).toMatch(/cancelled while watching for a second delivery/);
    expect(result.detail).toMatch(/not the same as none arriving/);
  });

  it('still FAILS a duplicate that had already landed when the run was cancelled', async () => {
    // Cancellation suppresses the PASS, never the evidence. A second delivery
    // already on the record is a fact about the consumer whatever we do next.
    const controller = new AbortController();
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      {
        queue: fakeQueue({
          deliveries: () => {
            controller.abort();
            return [ok(1), ok(2)];
          },
        }),
        effect: fakeEffect([2]),
        clock: fakeClock(),
      },
      controller.signal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/was consumed 2 times for one enqueue/);
  });

  it('does not count an IN_PROGRESS delivery as a run', async () => {
    // "Started" is not "ran". Counting it would report a single slow consumer
    // as a double delivery the moment a retry was mid-flight.
    const result = await runAssertion(
      'EXACTLY_ONCE',
      makeSpec(),
      'job_1',
      {
        queue: fakeQueue({
          deliveries: () => [ok(1), { attempt: 2, status: 'IN_PROGRESS', startedAt: null }],
        }),
        effect: fakeEffect([1]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('MET');
  });
});

// ─── IDEMPOTENT ──────────────────────────────────────────────────────────────

describe('IDEMPOTENT', () => {
  it('FAILS when redelivering the same job duplicates the effect', async () => {
    // Every at-least-once queue redelivers, so this is a scheduled outage
    // rather than an edge case.
    const queue = fakeQueue();
    const result = await runAssertion(
      'IDEMPOTENT',
      makeSpec({ assertions: ['IDEMPOTENT'] }),
      'job_1',
      { queue, effect: fakeEffect([1, 2, 2]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/took the effect from 1 to 2/);
    expect(queue.redelivered).toBe(1);
  });

  it('passes when the effect stays put, and discloses that it is not a proof', async () => {
    const result = await runAssertion(
      'IDEMPOTENT',
      makeSpec({ assertions: ['IDEMPOTENT'] }),
      'job_1',
      { queue: fakeQueue(), effect: fakeEffect([1]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('MET');
    expect(result.detail).toMatch(/stayed at 1/);
    // "No duplicate within the budget" is a weaker claim than "idempotent",
    // and the reader is entitled to know which one they got.
    expect(result.detail).toMatch(/not a proof/);
  });

  it('reports UNKNOWN rather than a hollow pass when there was no first effect', async () => {
    /*
     * "Redelivery caused no second effect" is trivially true when the first
     * delivery caused no first effect. Scoring that MET would be the emptiest
     * green in the product and would hide the real problem.
     */
    const result = await runAssertion(
      'IDEMPOTENT',
      makeSpec({ assertions: ['IDEMPOTENT'] }),
      'job_1',
      { queue: fakeQueue(), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.verdict).not.toBe('MET');
    expect(result.detail).toMatch(/no first effect/);
  });
});

// ─── DEAD_LETTER ─────────────────────────────────────────────────────────────

describe('DEAD_LETTER', () => {
  const withPolicy = () =>
    makeSpec({
      assertions: ['DEAD_LETTER'],
      deadLetter: { maxAttempts: 3, queue: 'mail-dlq' },
    });

  it('passes when the job lands in the policy’s queue after the policy’s attempts', async () => {
    const result = await runAssertion(
      'DEAD_LETTER',
      withPolicy(),
      'job_1',
      {
        queue: fakeQueue({
          deadLetter: () => ({ queue: 'mail-dlq', attempts: 3, reason: 'SMTP 550' }),
        }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('MET');
  });

  it('FAILS when it lands in the wrong queue', async () => {
    const result = await runAssertion(
      'DEAD_LETTER',
      withPolicy(),
      'job_1',
      {
        queue: fakeQueue({ deadLetter: () => ({ queue: 'misc-dlq', attempts: 3, reason: null }) }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/landed in "misc-dlq", not "mail-dlq"/);
  });

  it('FAILS when the attempt count disagrees with the policy', async () => {
    // A job dead-lettered after one attempt on a three-attempt policy means
    // the retries are not happening, which is a real defect and not a detail.
    const result = await runAssertion(
      'DEAD_LETTER',
      withPolicy(),
      'job_1',
      {
        queue: fakeQueue({ deadLetter: () => ({ queue: 'mail-dlq', attempts: 1, reason: null }) }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/tried 1 time\(s\), but your policy allows 3/);
  });

  it('reports UNAVAILABLE when the adapter cannot inject a failure', async () => {
    // A real SQS cannot be told to fail a delivery. That is our inability, so
    // nothing is claimed about the customer's dead-letter path either way.
    const result = await runAssertion(
      'DEAD_LETTER',
      withPolicy(),
      'job_1',
      {
        queue: fakeQueue({ canInjectFailure: false }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.detail).toMatch(/cannot make a delivery fail on demand/);
  });

  it('reports UNKNOWN when the job never reached the dead-letter queue in the budget', async () => {
    const result = await runAssertion(
      'DEAD_LETTER',
      withPolicy(),
      'job_1',
      { queue: fakeQueue({ deadLetter: () => null }), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.verdict).not.toBe('UNMET');
  });

  it('refuses to guess a policy, reporting UNAVAILABLE instead', async () => {
    const result = await runAssertion(
      'DEAD_LETTER',
      makeSpec({ assertions: ['DEAD_LETTER'] }),
      'job_1',
      { queue: fakeQueue(), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.detail).toMatch(/will not guess how many attempts/);
  });
});

// ─── SCHEDULED ───────────────────────────────────────────────────────────────

describe('SCHEDULED', () => {
  const at = '2026-10-25T03:00:00.000Z';

  it('passes when the job fired inside its window', async () => {
    const result = await runAssertion(
      'SCHEDULED',
      makeSpec({
        assertions: ['SCHEDULED'],
        schedule: { expectedAt: at, toleranceMs: 60_000 },
      }),
      'job_1',
      {
        queue: fakeQueue({ lastFire: '2026-10-25T03:00:30.000Z' }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('MET');
    expect(result.detail).toMatch(/30000ms from the expected instant/);
  });

  it('FAILS when a nightly job fired hours late', async () => {
    // "Fired at some point" is not the assertion. A nightly job that runs at
    // 11:00 is a broken nightly job.
    const result = await runAssertion(
      'SCHEDULED',
      makeSpec({
        assertions: ['SCHEDULED'],
        schedule: { expectedAt: at, toleranceMs: 60_000 },
      }),
      'job_1',
      {
        queue: fakeQueue({ lastFire: '2026-10-25T11:00:00.000Z' }),
        effect: fakeEffect([0]),
        clock: fakeClock(),
      },
      noSignal,
    );

    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toMatch(/outside the 60000ms window/);
  });

  it('treats a scheduler with no history as UNKNOWN, not as "it did not fire"', async () => {
    /*
     * A null that became a failure here would report every history-less
     * scheduler in the world as a broken cron. Rule 10: a null must not become
     * a verdict.
     */
    const result = await runAssertion(
      'SCHEDULED',
      makeSpec({
        assertions: ['SCHEDULED'],
        schedule: { expectedAt: at, toleranceMs: 60_000 },
      }),
      'job_1',
      { queue: fakeQueue({ lastFire: null }), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.verdict).not.toBe('UNMET');
    expect(result.detail).toMatch(/not evidence that it did not fire/);
  });

  it('treats an unparseable instant as UNKNOWN rather than as a miss', async () => {
    const result = await runAssertion(
      'SCHEDULED',
      makeSpec({
        assertions: ['SCHEDULED'],
        schedule: { expectedAt: at, toleranceMs: 60_000 },
      }),
      'job_1',
      { queue: fakeQueue({ lastFire: 'last tuesday' }), effect: fakeEffect([0]), clock: fakeClock() },
      noSignal,
    );

    expect(result.verdict).toBe('UNKNOWN');
    expect(result.detail).toMatch(/not a parseable instant/);
  });
});

// ─── Whole-test status ───────────────────────────────────────────────────────

describe('the status of the test as a whole', () => {
  it('FAILS when one assertion is UNMET even though others passed', async () => {
    const execution = await runJobsTest(
      makeCtx(),
      makeTest({}),
      makeSpec({ assertions: ['EXACTLY_ONCE', 'IDEMPOTENT'] }),
      {
        queue: fakeQueue({ deliveries: () => [ok(1)] }),
        effect: fakeEffect([1, 2, 2]),
        clock: fakeClock(),
      },
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/took the effect from 1 to 2/);
    expect(outline(execution)).toEqual([
      'PASSED Ran exactly once',
      expect.stringMatching(/^FAILED Redelivery causes no second effect — UNMET/),
    ]);
  });

  it('survives an adapter that throws, reporting UNAVAILABLE rather than a failure', async () => {
    // An adapter that threw told us nothing about the application.
    const queue = fakeQueue();
    queue.deliveries = async () => {
      throw new Error('redis connection lost');
    };
    const execution = await runJobsTest(makeCtx(), makeTest({}), makeSpec(), {
      queue,
      effect: fakeEffect([0]),
      clock: fakeClock(),
    });

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.steps[0]!.title).toMatch(/UNAVAILABLE: The queue adapter failed/);
    expect(execution.steps[0]!.error).toBeNull();
  });

  it('streams every step to the cockpit with the right status', async () => {
    const ctx = makeCtx();
    await runJobsTest(ctx, makeTest({}), makeSpec(), {
      queue: fakeQueue({ deliveries: () => [ok(1)] }),
      effect: fakeEffect([1]),
      clock: fakeClock(),
    });

    expect(ctx.logged).toEqual(['PASSED Ran exactly once']);
  });
});

// ─── validate ────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('rejects DEAD_LETTER with no policy BEFORE anything is enqueued', () => {
    /*
     * Caught at validate rather than at run time on purpose: an author who
     * gets UNAVAILABLE back has waited for a whole run to be told about a
     * missing field.
     */
    expect(() =>
      jobsPlugin.validate(makeTest({ queue: 'mail', job: 'welcome', assertions: ['DEAD_LETTER'] })),
    ).toThrow(/DEAD_LETTER needs `deadLetter.maxAttempts`/);
  });

  it('rejects SCHEDULED with no window', () => {
    expect(() =>
      jobsPlugin.validate(makeTest({ queue: 'mail', job: 'welcome', assertions: ['SCHEDULED'] })),
    ).toThrow(/SCHEDULED needs `schedule.expectedAt`/);
  });

  it('rejects an unknown assertion', () => {
    expect(() =>
      jobsPlugin.validate(makeTest({ queue: 'mail', job: 'welcome', assertions: ['EVENTUALLY'] })),
    ).toThrow(/invalid spec/);
  });

  it('rejects a spec with no assertions, which would measure nothing', () => {
    expect(() =>
      jobsPlugin.validate(makeTest({ queue: 'mail', job: 'welcome', assertions: [] })),
    ).toThrow(/invalid spec/);
  });

  it('accepts a complete spec', () => {
    expect(() =>
      jobsPlugin.validate(
        makeTest({
          queue: 'mail',
          job: 'welcome',
          assertions: ['EXACTLY_ONCE', 'IDEMPOTENT', 'DEAD_LETTER'],
          deadLetter: { maxAttempts: 3, queue: 'mail-dlq' },
        }),
      ),
    ).not.toThrow();
  });
});

// ─── The production adapter is honestly absent ───────────────────────────────

describe('the unconfigured adapter reports UNAVAILABLE rather than faking a pass', () => {
  it('refuses to enqueue, with a sentence naming what it would have asserted', async () => {
    await expect(
      unavailableJobQueue.enqueue({ queue: 'mail', job: 'welcome', payload: null, jobId: null }),
    ).rejects.toThrow(/No job-queue adapter is configured/);
  });

  it('never reports a zero count as "no effect happened"', () => {
    /*
     * Rule 10: a null that became a 0. A probe that said `count: 0` with no
     * caveat would let IDEMPOTENT read "no duplicate" off a probe that cannot
     * see anything — so the detail says so, and IDEMPOTENT reads a zero as
     * UNKNOWN. The two are only safe together.
     */
    return unavailableEffectProbe.observe().then((observed) => {
      expect(observed.count).toBe(0);
      expect(observed.detail).toMatch(/This is not "no effect"/);
    });
  });

  it('wires into a plugin whose unconfigured run measures nothing and says so', async () => {
    const execution = await jobsPlugin.execute(
      makeCtx(),
      makeTest({ queue: 'mail', job: 'welcome', assertions: ['EXACTLY_ONCE'] }),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.status).not.toBe('PASSED');
    expect(execution.notRun?.kind).toBe('BLOCKED_BY_ENV');
  });
});

describe('the real clock', () => {
  it('resolves its sleep, and resolves early when the run is cancelled', async () => {
    // The one place a real timer is exercised: a cancelled run must not sit on
    // a 30-second sleep before noticing.
    const controller = new AbortController();
    const started = Date.now();
    const pending = realJobClock.sleep(30_000, controller.signal);
    controller.abort();
    await pending;

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(realJobClock.now()).toBeGreaterThan(0);
  });
});
