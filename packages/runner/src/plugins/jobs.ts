/**
 * Background jobs, crons and queue consumers as a test type (§4 JOBS).
 *
 * `SURFACE_KINDS` has counted `BACKGROUND_JOB` — "a queue consumer, cron entry
 * or webhook receiver" — since the surface inventory was built, and nothing in
 * this product could execute one. That is the worst shape a denominator can
 * have: COUNTABLE AND UNCOVERABLE. Every nightly rollup, every scheduled mail,
 * every retry path sat in the "uncovered" column with no way out of it, so the
 * number was honest and useless in the same breath.
 *
 * This plugin is the way out: enqueue a job, wait for the consumer, assert the
 * effect.
 *
 * ── The four assertions that make it worth having ───────────────────────────
 *
 * "The consumer ran" is the least interesting thing to know about a queue, and
 * a plugin that only asserted it would be a worse version of an API test. The
 * defects that actually happen in async code are:
 *
 *   EXACTLY_ONCE   the job ran once, not twice. A consumer that runs twice
 *                  sends two emails and bills two charges, and the second one
 *                  is invisible in every log that only records "processed".
 *   IDEMPOTENT     a REDELIVERY produces no SECOND effect. Every real queue
 *                  redelivers — at-least-once is the default almost everywhere
 *                  — so a non-idempotent consumer is not an edge case, it is a
 *                  scheduled outage.
 *   DEAD_LETTER    a failing job lands where the customer's policy says, after
 *                  the attempts their policy allows. A job that fails and
 *                  vanishes is indistinguishable from one that succeeded.
 *   SCHEDULED      a cron fires inside its window. Not "fired at some point":
 *                  a nightly job that runs at 11:00 is a broken nightly job.
 *
 * ── A TIMEOUT IS NOT A FAILURE, and this is the whole discipline ────────────
 *
 * The wait for a consumer is BOUNDED, because an unbounded one would hang a
 * run. When that bound expires we do not know what happened: the consumer may
 * be slow, the worker may be scaled to zero, or the job may genuinely never be
 * picked up. Reporting that as FAILED would make QAAI blame the customer's
 * application for QAAI's OWN timeout — and it would do so in the one place a
 * customer cannot check cheaply, which is how a false failure survives.
 *
 * So an expired wait is an UNKNOWN outcome: SKIPPED, with `notRun.kind` of
 * NOT_RUN and a sentence naming the budget that bit and how to raise it.
 * BLOCKED_BY_ENV would be a stronger claim than we can support (the
 * environment may be perfectly fine and merely slow), and NOT_RUN is the
 * honest weakest reading: no evidence in either direction. See
 * {@link WaitOutcome}.
 *
 * ── Injected surfaces (rule 8) ──────────────────────────────────────────────
 *
 * There is no Redis, no SQS and no clock to wait on in a test here, so the
 * queue, the effect probe and the clock are all injected. The logic is tested
 * against fakes with no sleeping at all, and the one real adapter is thin.
 */

import { z } from 'zod';
import type {
  ConsoleEntry,
  ExecutableTest,
  RunContext,
  StepResult,
  TestExecution,
} from '@qaai/shared';

// ─── The assertion axis ──────────────────────────────────────────────────────

/** The four things worth asserting about an async consumer. See the header. */
export const JOB_ASSERTIONS = [
  'EXACTLY_ONCE',
  'IDEMPOTENT',
  'DEAD_LETTER',
  'SCHEDULED',
] as const;
export type JobAssertion = (typeof JOB_ASSERTIONS)[number];

/**
 * The compiler-enforced presence record this codebase requires beside a
 * vocabulary with a write path, paired with the run-time parity test in
 * jobs.test.ts.
 *
 * Both halves, because eight GateRule kinds shipped unsaveable for two slices
 * when only one of them existed: the zod enum accepted a kind that no branch
 * honoured, and `check:wiring` cannot see that. Here the compiler refuses to
 * let this record drift from the union, and the test refuses to let either
 * drift from `jobAssertionSchema.options` — and a third test asserts every
 * member actually reaches a branch in `runAssertion`, which is the failure the
 * other two cannot catch.
 */
export const JOB_ASSERTION_PRESENCE: Record<JobAssertion, true> = {
  EXACTLY_ONCE: true,
  IDEMPOTENT: true,
  DEAD_LETTER: true,
  SCHEDULED: true,
};

export const JOB_ASSERTION_LABELS: Record<JobAssertion, string> = {
  EXACTLY_ONCE: 'Ran exactly once',
  IDEMPOTENT: 'Redelivery causes no second effect',
  DEAD_LETTER: 'A failing job reaches the dead-letter queue',
  SCHEDULED: 'A scheduled job fires in its window',
};

// ─── The spec ────────────────────────────────────────────────────────────────

export const jobAssertionSchema = z.enum(JOB_ASSERTIONS);

export const jobsTestSpecSchema = z.object({
  /** The queue or topic the job goes on. */
  queue: z.string().min(1).max(200),
  /** The job/handler name the consumer dispatches on. */
  job: z.string().min(1).max(200),
  /** The job's argument. Not secret — secrets go through `ctx.secrets`. */
  payload: z.unknown().optional(),
  /**
   * A stable id, so a redelivery is the SAME job rather than a second one.
   *
   * Optional because many queues mint their own; when absent the adapter's id
   * is used and the IDEMPOTENT assertion reports what it actually redelivered.
   */
  jobId: z.string().min(1).max(200).optional(),
  assertions: z.array(jobAssertionSchema).min(1),
  /**
   * How long to wait for the consumer before reporting UNKNOWN.
   *
   * A bound, not a deadline on the customer's app. When it expires the result
   * is NOT a failure — see the file header and {@link waitFor}.
   */
  waitMs: z.number().int().min(100).max(600_000).default(30_000),
  /** How often to re-ask the queue while waiting. */
  pollIntervalMs: z.number().int().min(10).max(60_000).default(250),
  /**
   * The customer's own dead-letter policy, for the DEAD_LETTER assertion.
   *
   * Required by that assertion and meaningless without it: "should this job
   * have been dead-lettered after 3 attempts or 10?" is a question only the
   * customer can answer, and a default would assert our guess about their
   * system and call it their bug.
   */
  deadLetter: z
    .object({
      /** Attempts the policy allows before the job is dead-lettered. */
      maxAttempts: z.number().int().min(1).max(100),
      /** Where it must land. */
      queue: z.string().min(1).max(200),
    })
    .optional(),
  /**
   * The window a scheduled job must fire inside, for the SCHEDULED assertion.
   *
   * An ISO instant and a tolerance, rather than a cron expression: QAAI is not
   * in a position to re-implement cron parsing and then assert its own parse
   * against the customer's scheduler. The caller states the instant it expects.
   */
  schedule: z
    .object({
      expectedAt: z.string().datetime(),
      toleranceMs: z.number().int().min(0).max(86_400_000),
    })
    .optional(),
});
export type JobsTestSpec = z.infer<typeof jobsTestSpecSchema>;

// ─── The injected queue surface ──────────────────────────────────────────────

/** One delivery attempt of one job, as the queue reports it. */
export interface JobDelivery {
  /** 1 for the first attempt. */
  attempt: number;
  status: 'SUCCEEDED' | 'FAILED' | 'IN_PROGRESS';
  /** When the consumer started it, ISO. Null when the queue does not say. */
  startedAt: string | null;
}

export interface DeadLetterEntry {
  queue: string;
  /** Attempts made before the job was dead-lettered. */
  attempts: number;
  reason: string | null;
}

/**
 * The queue, as this plugin needs it.
 *
 * Narrow on purpose: these six methods are satisfiable by BullMQ, SQS, Sidekiq,
 * Celery, Cloud Tasks and a Postgres-backed table, which is the point. A richer
 * interface would have been one vendor's API with the serial numbers filed off,
 * and the second adapter would not have fitted it.
 */
export interface JobQueueSurface {
  /** Put the job on the queue. Returns the id deliveries are tracked by. */
  enqueue(request: {
    queue: string;
    job: string;
    payload: unknown;
    jobId: string | null;
  }): Promise<{ jobId: string }>;
  /**
   * Every delivery attempt the queue has recorded for this job.
   *
   * An EMPTY array means "the queue has no record yet", which is not the same
   * as "it was never delivered" — that distinction is what keeps a slow
   * consumer from being reported as a broken one.
   */
  deliveries(jobId: string): Promise<JobDelivery[]>;
  /** Re-deliver the same job id, the way an at-least-once queue would. */
  redeliver(jobId: string): Promise<void>;
  /** The dead-letter record, or null when the job is not dead-lettered. */
  deadLetter(jobId: string): Promise<DeadLetterEntry | null>;
  /**
   * When the scheduler last fired this job name, ISO, or null when it has no
   * record. Null is UNKNOWN, never "it did not fire".
   */
  lastScheduledFireAt(job: string): Promise<string | null>;
  /**
   * Make the next delivery of this job fail, for the DEAD_LETTER assertion.
   *
   * Returns false when the queue cannot be asked to do that — a real SQS
   * cannot — and the assertion then reports UNAVAILABLE rather than failing the
   * customer for our inability to inject a fault.
   */
  injectFailure(jobId: string): Promise<boolean>;
}

/**
 * The customer-visible effect the job is supposed to have.
 *
 * This is the assertion that matters and the one only the customer can define:
 * a row written, a mail queued, a file produced. `count` is a number rather
 * than a boolean because IDEMPOTENT is a statement about the effect happening
 * ONCE, and a boolean cannot tell one from two.
 */
export interface JobEffectProbe {
  observe(): Promise<{ count: number; detail?: string | null }>;
}

/** Injected so tests do not sleep and a cancelled run stops waiting. */
export interface JobClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realJobClock: JobClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

/** Everything `runJobsTest` needs from the outside world. */
export interface JobsDeps {
  queue: JobQueueSurface;
  effect: JobEffectProbe;
  clock?: JobClock;
}

// ─── The bounded wait ────────────────────────────────────────────────────────

/**
 * What a bounded wait can conclude. Three outcomes, not two.
 *
 * `EXPIRED` is the one this file exists to get right. It is NOT `NOT_MET`: the
 * condition may be about to become true, and the difference between "your
 * consumer did not run" and "we stopped looking after 30 seconds" is the
 * difference between the customer's bug and ours.
 */
export type WaitOutcome = 'MET' | 'EXPIRED' | 'CANCELLED';

export interface WaitResult {
  outcome: WaitOutcome;
  /** How long we actually waited, for the disclosure sentence. */
  waitedMs: number;
  /** How many times the predicate was asked. */
  polls: number;
}

/**
 * Poll until the predicate holds, the budget expires, or the run is cancelled.
 *
 * Exported and tested directly with a fake clock: it is the honesty-critical
 * primitive of this plugin, and a bug in it turns slow consumers into reported
 * defects across every JOBS test at once.
 *
 * The predicate is asked ONCE before any sleeping, so a job that was already
 * processed does not pay a poll interval — and, more to the point, a wait of 0
 * elapsed ms can still return MET rather than EXPIRED.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  budgetMs: number,
  pollIntervalMs: number,
  signal: AbortSignal,
  clock: JobClock,
): Promise<WaitResult> {
  const startedAt = clock.now();
  let polls = 0;

  for (;;) {
    if (signal.aborted) {
      return { outcome: 'CANCELLED', waitedMs: clock.now() - startedAt, polls };
    }

    polls += 1;
    if (await predicate()) {
      return { outcome: 'MET', waitedMs: clock.now() - startedAt, polls };
    }

    const elapsed = clock.now() - startedAt;
    if (elapsed >= budgetMs) {
      return { outcome: 'EXPIRED', waitedMs: elapsed, polls };
    }

    // Never sleep past the budget: a 250ms interval on a 100ms remainder would
    // report having waited 350ms against a 100ms budget, and the disclosure
    // sentence has to be true about the number it prints.
    await clock.sleep(Math.min(pollIntervalMs, budgetMs - elapsed), signal);
  }
}

/**
 * The sentence an expired wait is reported with.
 *
 * Exported so the test can assert its exact content: rule 10 requires a cap
 * that bit to be reported as a count AND a reason, and this is both. It says
 * plainly that the outcome is unknown, which is the part a reader needs in
 * order not to go looking for a bug that may not exist.
 */
export function expiredWaitWhy(
  what: string,
  budgetMs: number,
  waitedMs: number,
  polls: number,
): string {
  return (
    `UNKNOWN, not failed: QAAI waited ${waitedMs}ms (${polls} poll(s)) for ${what} and the ` +
    `${budgetMs}ms waitMs budget expired first. The consumer may be slow, scaled to zero, or ` +
    'genuinely not running — this run cannot tell which, so nothing is asserted about your ' +
    'application either way. Raise `waitMs` to find out.'
  );
}

// ─── Step recording ──────────────────────────────────────────────────────────

/**
 * An assertion's verdict.
 *
 * Four states and not two, for the same reason the wait has three outcomes: an
 * assertion we could not evaluate must not be scored in either direction.
 */
export type AssertionVerdict = 'MET' | 'UNMET' | 'UNKNOWN' | 'UNAVAILABLE';

export interface AssertionResult {
  assertion: JobAssertion;
  verdict: AssertionVerdict;
  /** Printable verbatim. On UNKNOWN it names the budget that bit. */
  detail: string;
}

class StepRecorder {
  readonly steps: StepResult[] = [];

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  /**
   * Record an assertion.
   *
   * UNKNOWN and UNAVAILABLE are both SKIPPED steps with the reason in the
   * title, because `error` on a StepResult means "this failed" and neither of
   * them did. Only UNMET is a failure, and only UNMET is a statement about the
   * customer's application.
   */
  record(result: AssertionResult, startedAtMs: number): void {
    const label = JOB_ASSERTION_LABELS[result.assertion];
    const status: StepResult['status'] =
      result.verdict === 'MET' ? 'PASSED' : result.verdict === 'UNMET' ? 'FAILED' : 'SKIPPED';
    const title =
      result.verdict === 'MET'
        ? label
        : `${label} — ${result.verdict}: ${result.detail}`;

    const index = this.steps.length;
    this.ctx.logger.step({ testId: this.testId, index, title, status });
    this.steps.push({
      index,
      title,
      status,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      screenshotKey: null,
      error:
        result.verdict === 'UNMET'
          ? {
              message: result.detail,
              stack: null,
              selector: null,
              expected: null,
              actual: null,
            }
          : null,
    });
  }
}

// ─── The assertions ──────────────────────────────────────────────────────────

/** Deliveries that got as far as running. IN_PROGRESS is not one of them. */
function settled(deliveries: readonly JobDelivery[]): JobDelivery[] {
  return deliveries.filter((d) => d.status === 'SUCCEEDED' || d.status === 'FAILED');
}

/**
 * Run one assertion.
 *
 * Exported so each assertion is tested on its own against a fake queue, which
 * is how the UNKNOWN paths get covered at all — they are unreachable through a
 * real queue that happens to be fast.
 */
export async function runAssertion(
  assertion: JobAssertion,
  spec: JobsTestSpec,
  jobId: string,
  deps: Required<JobsDeps>,
  signal: AbortSignal,
): Promise<AssertionResult> {
  const { queue, effect, clock } = deps;

  switch (assertion) {
    case 'EXACTLY_ONCE': {
      const wait = await waitFor(
        async () => settled(await queue.deliveries(jobId)).length > 0,
        spec.waitMs,
        spec.pollIntervalMs,
        signal,
        clock,
      );
      if (wait.outcome !== 'MET') {
        return {
          assertion,
          verdict: wait.outcome === 'CANCELLED' ? 'UNAVAILABLE' : 'UNKNOWN',
          detail:
            wait.outcome === 'CANCELLED'
              ? 'The run was cancelled while waiting for the consumer.'
              : expiredWaitWhy(
                  `"${spec.job}" to be consumed off "${spec.queue}"`,
                  spec.waitMs,
                  wait.waitedMs,
                  wait.polls,
                ),
        };
      }

      /*
       * A second delivery can only arrive AFTER the first, so a check made the
       * instant the first one lands would pass on a consumer that runs twice.
       * The queue is re-read once the full budget has had a chance to elapse —
       * this is the one assertion where waiting out the budget is the test.
       */
      const quiet = await waitFor(
        async () => settled(await queue.deliveries(jobId)).length > 1,
        Math.min(spec.waitMs, 5_000),
        spec.pollIntervalMs,
        signal,
        clock,
      );

      const runs = settled(await queue.deliveries(jobId)).length;
      if (quiet.outcome === 'MET' || runs > 1) {
        return {
          assertion,
          verdict: 'UNMET',
          detail:
            `"${spec.job}" was consumed ${runs} times for one enqueue. A consumer that runs ` +
            'twice does its side effect twice.',
        };
      }
      /*
       * CANCELLED IS NOT A PASS, and this branch is here because it was. The
       * quiet window IS the measurement for this assertion — a second delivery
       * can only arrive after the first, so "no second one arrived" is a claim
       * about a period of time we watched. A cancelled wait returns after 0ms,
       * and reporting MET on it said "Consumed once, and no second delivery
       * arrived in 0ms": a pass on a window that was never observed.
       *
       * The duplicate check above runs FIRST, so a duplicate that HAD already
       * landed is still reported as UNMET — cancellation suppresses the pass,
       * never the evidence. IDEMPOTENT below has made this distinction since it
       * was written; the asymmetry was the defect.
       */
      if (quiet.outcome === 'CANCELLED') {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail:
            'The run was cancelled while watching for a second delivery, so "exactly once" was ' +
            'not established. One delivery was seen and no duplicate had arrived yet — which is ' +
            'not the same as none arriving.',
        };
      }
      return {
        assertion,
        verdict: 'MET',
        detail: `Consumed once, and no second delivery arrived in ${quiet.waitedMs}ms.`,
      };
    }

    case 'IDEMPOTENT': {
      const before = await effect.observe();
      if (before.count === 0) {
        /*
         * Nothing to be idempotent ABOUT. Reporting MET here would be the
         * emptiest kind of green: "redelivery caused no second effect" is
         * trivially true when the first delivery caused no first effect, and
         * it would hide the actual problem.
         */
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            'The effect probe saw no first effect, so a redelivery could not be shown to cause ' +
            'a second one. Either the consumer has not run yet (raise `waitMs`, or assert ' +
            'EXACTLY_ONCE first) or the probe is not looking at what this job writes.',
        };
      }

      await queue.redeliver(jobId);

      const grew = await waitFor(
        async () => (await effect.observe()).count > before.count,
        spec.waitMs,
        spec.pollIntervalMs,
        signal,
        clock,
      );

      if (grew.outcome === 'MET') {
        const after = await effect.observe();
        return {
          assertion,
          verdict: 'UNMET',
          detail:
            `Redelivering the same job took the effect from ${before.count} to ${after.count}. ` +
            'Every at-least-once queue redelivers, so this duplicates in production.',
        };
      }
      if (grew.outcome === 'CANCELLED') {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'The run was cancelled while watching for a duplicate effect.',
        };
      }
      /*
       * The budget expiring is the PASS here, and uniquely so: we were waiting
       * for a duplicate and none arrived. It is still disclosed, because "no
       * duplicate within 30s" is a weaker claim than "idempotent" and the
       * reader is entitled to know which one they got.
       */
      return {
        assertion,
        verdict: 'MET',
        detail:
          `Redelivered the same job and the effect stayed at ${before.count} for ` +
          `${grew.waitedMs}ms. Note this is "no duplicate within the budget", not a proof.`,
      };
    }

    case 'DEAD_LETTER': {
      const policy = spec.deadLetter;
      if (!policy) {
        // Not a failure and not a pass: the customer never said where a failing
        // job should land, so there is no claim to check.
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail:
            'This assertion needs your dead-letter policy. Set `deadLetter.maxAttempts` and ' +
            '`deadLetter.queue` — QAAI will not guess how many attempts your system allows.',
        };
      }

      const injected = await queue.injectFailure(jobId);
      if (!injected) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail:
            'This queue adapter cannot make a delivery fail on demand, so the dead-letter path ' +
            'was not exercised. Nothing is claimed about it either way.',
        };
      }

      const landed = await waitFor(
        async () => (await queue.deadLetter(jobId)) !== null,
        spec.waitMs,
        spec.pollIntervalMs,
        signal,
        clock,
      );

      if (landed.outcome === 'EXPIRED') {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail: expiredWaitWhy(
            `a failing "${spec.job}" to reach "${policy.queue}"`,
            spec.waitMs,
            landed.waitedMs,
            landed.polls,
          ),
        };
      }
      if (landed.outcome === 'CANCELLED') {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail: 'The run was cancelled while waiting for the dead-letter record.',
        };
      }

      const entry = (await queue.deadLetter(jobId))!;
      const problems: string[] = [];
      if (entry.queue !== policy.queue) {
        problems.push(`it landed in "${entry.queue}", not "${policy.queue}"`);
      }
      if (entry.attempts !== policy.maxAttempts) {
        problems.push(
          `it was tried ${entry.attempts} time(s), but your policy allows ${policy.maxAttempts}`,
        );
      }
      return problems.length > 0
        ? { assertion, verdict: 'UNMET', detail: problems.join('; ') }
        : {
            assertion,
            verdict: 'MET',
            detail: `Dead-lettered to "${entry.queue}" after ${entry.attempts} attempt(s).`,
          };
    }

    case 'SCHEDULED': {
      const window = spec.schedule;
      if (!window) {
        return {
          assertion,
          verdict: 'UNAVAILABLE',
          detail:
            'This assertion needs the window you expect. Set `schedule.expectedAt` and ' +
            '`schedule.toleranceMs`.',
        };
      }

      const firedAt = await queue.lastScheduledFireAt(spec.job);
      if (firedAt === null) {
        /*
         * The scheduler has no record. That is UNKNOWN and emphatically not
         * "it did not fire" — plenty of schedulers keep no history at all, and
         * a null that became a failure here would report every one of them as
         * a broken cron.
         */
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail:
            `Your scheduler reports no last-fire time for "${spec.job}", so whether it fired ` +
            'in the window is unknown. This is not evidence that it did not fire.',
        };
      }

      const actual = Date.parse(firedAt);
      if (Number.isNaN(actual)) {
        return {
          assertion,
          verdict: 'UNKNOWN',
          detail: `Your scheduler reported "${firedAt}", which is not a parseable instant.`,
        };
      }

      const expected = Date.parse(window.expectedAt);
      const driftMs = Math.abs(actual - expected);
      return driftMs <= window.toleranceMs
        ? {
            assertion,
            verdict: 'MET',
            detail: `Fired at ${firedAt}, ${driftMs}ms from the expected instant (tolerance ${window.toleranceMs}ms).`,
          }
        : {
            assertion,
            verdict: 'UNMET',
            detail:
              `Fired at ${firedAt}, which is ${driftMs}ms from ${window.expectedAt} — outside ` +
              `the ${window.toleranceMs}ms window.`,
          };
    }
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

/**
 * Run a jobs test against an injected queue and effect probe.
 *
 * The status rule, which is the whole point of this plugin:
 *
 *   · any UNMET            → FAILED. A real statement about the application.
 *   · all MET              → PASSED.
 *   · nothing MET or UNMET → SKIPPED with `notRun`, because nothing was
 *                            measured. A result with only UNKNOWNs in it is
 *                            not a pass, and this is the line a hurried
 *                            implementation crosses.
 *   · a mix of MET and UNKNOWN → PASSED, with the unknowns disclosed on the
 *                            result. What was measured was fine; what was not
 *                            measured says so in its own step.
 */
export async function runJobsTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: JobsTestSpec,
  deps: JobsDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const recorder = new StepRecorder(ctx, test.id);
  const notes: ConsoleEntry[] = [];
  const resolved: Required<JobsDeps> = {
    queue: deps.queue,
    effect: deps.effect,
    clock: deps.clock ?? realJobClock,
  };

  const base = {
    testId: test.id,
    network: [],
    console: notes,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;

  let jobId: string;
  try {
    const enqueued = await resolved.queue.enqueue({
      queue: spec.queue,
      job: spec.job,
      payload: spec.payload,
      jobId: spec.jobId ?? null,
    });
    jobId = enqueued.jobId;
  } catch (err) {
    /*
     * Could not even enqueue. BLOCKED_BY_ENV rather than FAILED: a queue we
     * cannot reach is an environment gap, and recording it as a failing test
     * would put a red mark on the customer's consumer code on the strength of
     * a broken connection string.
     */
    const why = `Could not enqueue "${spec.job}" on "${spec.queue}": ${errorText(err)}`;
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: [],
      notRun: { kind: 'BLOCKED_BY_ENV', why },
      errorMessage: why,
    };
  }

  const results: AssertionResult[] = [];
  for (const assertion of spec.assertions) {
    const stepStartedAt = Date.now();
    let result: AssertionResult;
    try {
      result = await runAssertion(assertion, spec, jobId, resolved, ctx.signal);
    } catch (err) {
      // An adapter that threw told us nothing about the application.
      result = {
        assertion,
        verdict: 'UNAVAILABLE',
        detail: `The queue adapter failed while checking this: ${errorText(err)}`,
      };
    }
    results.push(result);
    recorder.record(result, stepStartedAt);
  }

  const unmet = results.filter((r) => r.verdict === 'UNMET');
  const met = results.filter((r) => r.verdict === 'MET');
  const unmeasured = results.filter(
    (r) => r.verdict === 'UNKNOWN' || r.verdict === 'UNAVAILABLE',
  );

  for (const r of unmeasured) {
    notes.push({
      level: 'warn',
      text: `${JOB_ASSERTION_LABELS[r.assertion]} was not measured — ${r.verdict}: ${r.detail}`,
      at: new Date().toISOString(),
    });
  }

  const unmeasuredNote =
    unmeasured.length > 0
      ? ` ${unmeasured.length} of ${results.length} assertion(s) were NOT measured: ` +
        unmeasured.map((r) => `${r.assertion} (${r.verdict})`).join(', ') +
        '.'
      : '';

  if (unmet.length > 0) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      errorMessage: `${unmet.map((r) => r.detail).join(' | ')}${unmeasuredNote}`,
    };
  }

  if (met.length === 0) {
    /*
     * Everything came back UNKNOWN or UNAVAILABLE. This is the result that
     * must never be PASSED: a green JOBS test that measured nothing is exactly
     * the "no drift since the last crawl, because the comparison did not run"
     * lie wearing a queue for a hat.
     */
    const why =
      `None of this test's ${results.length} assertion(s) could be measured, so nothing is ` +
      `claimed about "${spec.job}" on "${spec.queue}". ` +
      unmeasured.map((r) => `${r.assertion}: ${r.detail}`).join(' | ');
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      /*
       * NOT_RUN, the weakest of the four kinds, and deliberately not
       * BLOCKED_BY_ENV: a timed-out wait does not establish that the
       * environment was broken, and claiming it did would be a stronger
       * statement than the evidence supports. UNSUPPORTED would be wrong for
       * the opposite reason — this deployment supports the type fine.
       */
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    errorMessage: unmeasuredNote.trim() || null,
  };
}

// ─── The real adapter ────────────────────────────────────────────────────────

/**
 * The deps this plugin uses in production.
 *
 * Not built, and reported as not built. A customer's queue is reached through
 * their own broker — Redis for BullMQ and Sidekiq, an AWS client for SQS, a
 * table for a Postgres queue — and each of those is a connection this
 * environment does not have and a credential that belongs on an Environment
 * row rather than in `process.env` (rule 4).
 *
 * The honest shape is this: the logic above is complete and tested, and the
 * transport reports UNAVAILABLE until an adapter is configured. A stub that
 * returned "one successful delivery and one effect" would make every assertion
 * in this file pass against nothing at all, which is worse than having no
 * plugin — it would move the coverage number on the strength of a fake.
 */
export const unavailableJobQueue: JobQueueSurface = {
  enqueue() {
    return Promise.reject(
      new Error(
        'No job-queue adapter is configured for this environment. QAAI can assert that a ' +
          'consumer ran exactly once, is idempotent on redelivery, dead-letters per your ' +
          'policy and fires in its window — but it needs a broker connection on the ' +
          'Environment to do it. Nothing was measured.',
      ),
    );
  },
  deliveries() {
    return Promise.resolve([]);
  },
  redeliver() {
    return Promise.reject(new Error('No job-queue adapter is configured.'));
  },
  deadLetter() {
    return Promise.resolve(null);
  },
  lastScheduledFireAt() {
    return Promise.resolve(null);
  },
  injectFailure() {
    return Promise.resolve(false);
  },
};

/**
 * An effect probe that cannot see anything.
 *
 * `count: 0` would be a lie of the exact kind rule 10 names — a null that
 * became a zero — so it is not that: `detail` says there is no probe, and
 * IDEMPOTENT reads a zero count as UNKNOWN rather than as "no effect
 * happened". The two are only safe together, which is why they are written
 * together.
 */
export const unavailableEffectProbe: JobEffectProbe = {
  observe() {
    return Promise.resolve({
      count: 0,
      detail: 'No effect probe is configured, so nothing was observed. This is not "no effect".',
    });
  },
};

let deps: JobsDeps = { queue: unavailableJobQueue, effect: unavailableEffectProbe };

/** Install queue/effect/clock surfaces. Returns the previous set, so a test restores. */
export function setJobsDeps(next: JobsDeps): JobsDeps {
  const previous = deps;
  deps = next;
  return previous;
}

export const jobsPlugin = {
  type: 'JOBS' as const,

  validate(test: ExecutableTest): void {
    const parsed = jobsTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Jobs test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * Two assertions need a policy the spec may not carry. Caught HERE rather
     * than at run time on purpose: a DEAD_LETTER assertion with no policy is
     * an UNAVAILABLE result, and a test author who gets that back after
     * queueing a run has waited to be told about a typo. `validate` runs before
     * anything is enqueued.
     */
    const spec = parsed.data;
    const missing: string[] = [];
    if (spec.assertions.includes('DEAD_LETTER') && !spec.deadLetter) {
      missing.push('DEAD_LETTER needs `deadLetter.maxAttempts` and `deadLetter.queue`');
    }
    if (spec.assertions.includes('SCHEDULED') && !spec.schedule) {
      missing.push('SCHEDULED needs `schedule.expectedAt` and `schedule.toleranceMs`');
    }
    if (missing.length > 0) {
      throw new Error(`Jobs test "${test.name}" is incomplete — ${missing.join('; ')}.`);
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runJobsTest(ctx, test, jobsTestSpecSchema.parse(test.spec), deps);
  },
};
