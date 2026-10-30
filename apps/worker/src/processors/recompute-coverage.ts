/**
 * Recompute the dark-surface number whenever one of its inputs changes.
 *
 * Everything else in this feature answers the question correctly ONCE. This is
 * the file that decides whether the answer is still true an hour later, and the
 * failure mode it exists to prevent is specific and worse than a missing
 * feature: a stored snapshot is what the trend is drawn from and what the CI
 * gate compares a pull request against. Left unrecomputed, the product does not
 * go blank — it goes confidently stale. It says "43 uncovered routes" about a
 * repository that added fourteen last week, and it says the gate is green
 * because the number it compared against was measured before the change.
 *
 * ── WHAT CHANGES THE NUMBER ─────────────────────────────────────────────────
 *
 * Three inputs, no more:
 *
 *   the DENOMINATOR  the source analysis (CodebaseSnapshot) and the crawl
 *                    (FlowMap). Either one landing changes what we claim the
 *                    application's surface IS.
 *   the NUMERATOR    the Test rows, and their executions. A test being written
 *                    moves an item to ASSERTED_NOT_RUN; a run executing it is
 *                    the only thing that can move it to COVERED.
 *
 * So the triggers are: a crawl finishing, a source analysis landing, a run
 * finishing, and tests being created or deleted. Every one of them is wired
 * from apps/worker/src/index.ts rather than from inside the five processors
 * that cause them — index.ts is where this wave's registrations live, and a
 * feature that needs an edit in five files other people are editing this wave
 * is a feature that arrives half-wired. (Same reasoning, and the same shape, as
 * `actionJobsFromNotify` in processors/actions.ts.) One trigger does NOT live in
 * the worker at all — see THE TRIGGER THAT IS NOT HERE, below.
 *
 * ── STAMPEDE: COALESCE BY PROJECT, NOT DEBOUNCE PER TRIGGER ─────────────────
 *
 * A sharded run finishes once per shard, so a 20-shard suite completing fires
 * twenty times within seconds; a crawl and a run can finish in the same breath.
 * The expensive part is not the CPU — it is that every recompute WRITES a
 * CoverageSnapshot row, and twenty rows measuring one event make the trend a
 * stack of duplicates and the gate's delta meaningless.
 *
 * The fix is a coalesce, not a lock: every trigger for a project enqueues the
 * SAME job id (`recompute-coverage-<projectId>`) with a delay, so BullMQ keeps
 * the first job and silently returns it for the other nineteen. One write per
 * window per project, whatever happened inside the window. It is coalescing
 * rather than per-trigger debouncing because the triggers are not interesting
 * individually — "the inputs moved" is the whole signal, and the computation
 * re-reads every input from the database anyway, so the last writer's data is
 * what gets measured no matter which trigger opened the window.
 *
 * Two details that look like boilerplate and are not:
 *
 *   • `removeOnComplete` AND `removeOnFail` must both be set. A BullMQ job id
 *     is a Redis key: a retained completed — or worse, FAILED — job keeps that
 *     key, and every later `add()` for the project collapses onto the corpse.
 *     That would not log an error anywhere. It would silently freeze the number
 *     for one project forever, which is this feature's worst bug wearing a
 *     cleanup setting's clothes.
 *   • a straggler is accepted. A shard that finishes more than
 *     RECOMPUTE_WINDOW_MS after its siblings opens a second window and writes a
 *     second snapshot. That is a duplicate row, not a wrong number, and the
 *     alternative (re-arming the delay on every trigger) means a project whose
 *     runs never stop never recomputes at all.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 *
 * A recompute that lands before the write it depends on measures the previous
 * surface and stores it as current. So the enqueue happens AFTER the processor
 * that does the writing returns (explore.ts commits its FlowMap row before it
 * returns; generate.ts and import.ts commit their Test rows the same way), and
 * the window's delay is a second line of defence on top of that.
 *
 * ── WHY THE COMPUTATION IS IMPORTED LAZILY, AND WHAT SHOULD MOVE ────────────
 *
 * `computeCoverage` lives in apps/api/src/lib/coverage-store.ts, and there must
 * never be a second copy of it: two implementations of one division is two
 * coverage numbers, and the day they disagree the product is finished. So this
 * file imports that one.
 *
 * It cannot do so statically. That module reaches for the API's
 * tenancy-extended Prisma singleton (a second connection pool, and the API's
 * env schema, which calls process.exit on anything it does not like) and for
 * `toCoverageInputs` in apps/api/src/routes/coverage.ts — an Express router
 * module that opens its own Redis connection at import time. A static import
 * would make every worker boot, including boots that never recompute anything,
 * depend on all of it. The exact same wall is documented at the top of
 * apps/api/src/lib/start-run.ts, which the worker DOES import: that module takes
 * its Prisma client as a parameter precisely so it can be shared.
 *
 * So the import is deferred into `loadComputeCoverage()`, which runs at most
 * once per process and only when a recompute actually happens, and is refused
 * outright when the API's env would reject this process — see `apiEnvGap`,
 * which exists because that env module exits the process rather than throwing.
 * The handover note is loud: `computeCoverage` should take its client as a parameter the way
 * `startRun` does, and `toCoverageInputs` should move into the already-pure
 * apps/api/src/lib/impact.ts beside the route extractors it is built from. Then
 * this lazy import becomes an ordinary one and the deferral disappears.
 *
 * ── THE TRIGGER THAT IS NOT HERE ────────────────────────────────────────────
 *
 * A SOURCE ANALYSIS LANDING is not a worker event. `processAnalyzeSource` only
 * READS the stored CodebaseSnapshot; the row itself is written by
 * POST /projects/:id/source in apps/api/src/routes/source.ts. The analyze-source
 * completion is hooked anyway — it is the nearest in-worker signal and it costs
 * one coalesced job — but a repository imported without anyone then asking for a
 * plan still needs an enqueue at that create. Same for test DELETION, which
 * happens in apps/api/src/routes/projects.ts. Both files belong to other waves;
 * both are named in the handover rather than edited here.
 *
 * ── WHAT THIS FILE MAY NEVER DO ─────────────────────────────────────────────
 *
 * It reports the number, so the five rules bind it as hard as they bind the
 * screen: a null percent is logged as "not measured yet" and never as a number
 * (rule 1); ASSERTED_NOT_RUN is logged as its own count, never folded into
 * covered (rule 2); UNKNOWN is logged apart from uncovered and never called a
 * gap (rule 3); the unmeasured axes are NAMED rather than reported as zero
 * (rule 4); and the caveats are logged in full rather than counted (rule 5). A
 * log line is where an operator looks when a customer disputes the number, and
 * a log that flatters us is the same lie as a dashboard that does.
 */

import { Queue } from 'bullmq';
import type { SurfaceKind, SurfaceSnapshot } from '@qaai/shared';
/*
 * THE RETIREMENT DENOMINATOR RULE, asked of the one function allowed to answer.
 *
 * A retired test's surface STAYS in the denominator and goes back to UNCOVERED,
 * so the percentage falls. This file reports the percentage, so it is the file
 * most able to publish the flattering version of that arithmetic by accident —
 * which is why the rule is imported rather than restated. See
 * `describeAppliedRetirements`.
 */
import { retirementDenominatorEffect } from '@qaai/shared';
import type { DenominatorEffect } from '@qaai/shared';
import { connection, logger, prisma } from '../context.js';
/*
 * TYPE-ONLY, and load-bearing. `verbatimModuleSyntax` erases an `import type`
 * entirely, so this line couples the two modules at typecheck time and not at
 * run time — which is the whole point of the lazy loader below. Changing it to
 * a value import re-couples the worker's boot to the API's module graph.
 */
import type { ComputeOptions, ComputedCoverage } from '../../../api/src/lib/coverage-store.js';

/**
 * Its own queue, declared beside its processor.
 *
 * NOT in `QUEUE_NAMES` (packages/shared/src/constants.ts), for the same reason
 * and in the same shape as RETENTION_QUEUE, BACKUP_QUEUE and ACTIONS_QUEUE:
 * that file has an owner and this wave is not it, and the pattern does not
 * require an entry — `npm run check:wiring` reads this literal and pins it to
 * the `register(...)` call in index.ts, so the producer and the consumer cannot
 * drift apart without CI saying so.
 *
 * It does mean the API cannot enqueue onto it through its own typed `enqueue()`
 * helper, which is keyed on `JobPayloads`. That matters only for the two
 * API-side triggers named in the header, and it is in the handover note.
 */
export const RECOMPUTE_COVERAGE_QUEUE = 'qaai.recompute-coverage';

/**
 * The coalescing window.
 *
 * Long enough that a sharded run's twenty completions land inside one window
 * (they arrive within seconds of each other), short enough that nobody watching
 * the dashboard after a crawl thinks it is broken. It is also the ordering
 * slack described in the header: thirty seconds is a lot of margin on a row
 * that was committed before the enqueue was even made.
 *
 * It is NOT a correctness guarantee, and nothing here pretends it is. The
 * synchronous answer is still `POST /surface/:projectId/recompute`, which is
 * what the CI gate uses when it needs the number for THIS commit right now.
 */
export const RECOMPUTE_WINDOW_MS = 30_000;

/**
 * Two attempts, which is safe here and is worth the sentence because "a write
 * job with retries" usually is not.
 *
 * `computeCoverage` persists in one pass whose LAST action is creating the
 * CoverageSnapshot row. So a throw means no snapshot was written, and a retry
 * cannot duplicate one; the item upserts it may have got through are
 * idempotent by key, and a retried pass completes them. A failure here is
 * nearly always a lost database connection, which is exactly what a second
 * attempt fixes.
 */
export const RECOMPUTE_ATTEMPTS = 2;

/**
 * Why a recompute was asked for. Logged, so a surprising snapshot is traceable.
 *
 * `close-loop` is the sixth, and unlike the other five nobody asked for it: it
 * is the closure campaign re-measuring itself (processors/close-loop.ts). It is
 * a distinct reason rather than being filed under one of the others precisely
 * because it is the only one that is NOT caused by a change to the inputs — the
 * loop measures to find out whether its own work moved the number, and a
 * snapshot written for that purpose has to be distinguishable in the trend from
 * one written because a crawl landed.
 */
export type RecomputeReason =
  | 'source-analysis'
  | 'crawl'
  | 'run'
  | 'tests-changed'
  | 'close-loop';

/**
 * Ids and a reason only — the same rule as every other payload in this system
 * (see the header of packages/shared/src/jobs.ts). Nothing measured travels on
 * the job: the processor re-reads every input, so a job that waited out its
 * window measures the surface as it is when it runs rather than as it was when
 * something noticed.
 */
export interface RecomputeCoverageJob {
  orgId: string;
  projectId: string;
  reason: RecomputeReason;
  /** Recorded on the snapshot, so a release can be audited months later. */
  commitSha?: string | null;
  /** The run that triggered this, when one did. */
  runId?: string | null;
}

/**
 * What a caller tells us, which is deliberately less than the job needs.
 *
 * A run job carries `{ orgId, runId }` and no project — resolving one from the
 * other is a database read, and it happens HERE rather than at the five call
 * sites in index.ts so that the coalescing key is always a project id. A
 * recompute keyed on a run id would not coalesce two different runs of the same
 * project, which is half the stampede.
 */
export type RecomputeTrigger =
  | { reason: 'source-analysis' | 'crawl' | 'tests-changed'; orgId: string; projectId: string }
  | { reason: 'run'; orgId: string; runId: string };

/** The computation, as the processor sees it. Injected in tests. */
export type ComputeCoverageFn = (options: ComputeOptions) => Promise<ComputedCoverage>;

export interface RecomputeCoverageDeps {
  /**
   * The real one is `computeCoverage` from apps/api/src/lib/coverage-store.ts,
   * loaded lazily (see the header). Tests pass a stub, because the real one
   * opens Postgres on import and a unit test that does that is an integration
   * test in a disguise.
   */
  compute?: ComputeCoverageFn;
  /** The producer. Injected so the trigger tests do not need a live Redis. */
  enqueue?: (job: RecomputeCoverageJob) => Promise<void>;
}

// ─── The producer ────────────────────────────────────────────────────────────

/**
 * The coalescing key. One in-flight recompute per project, by construction.
 *
 * Note what is NOT in it: the reason, the commit, the run. Including any of them
 * would give each trigger its own job and defeat the whole mechanism — twenty
 * shards of one run share a run id but a crawl and a run do not share anything
 * except the project they changed.
 */
export function recomputeJobId(projectId: string): string {
  return `recompute-coverage-${projectId}`;
}

/**
 * Exported so the test can assert the settings the coalesce actually rests on —
 * the job id, the window, and the two removals — rather than asserting that a
 * function was called.
 */
export function recomputeJobOptions(projectId: string): {
  jobId: string;
  delay: number;
  attempts: number;
  removeOnComplete: boolean;
  removeOnFail: boolean;
} {
  return {
    jobId: recomputeJobId(projectId),
    delay: RECOMPUTE_WINDOW_MS,
    attempts: RECOMPUTE_ATTEMPTS,
    // Both true, and the header says why at length: a retained job of either
    // kind holds the job id and silently freezes this project's number.
    removeOnComplete: true,
    removeOnFail: true,
  };
}

let recomputeQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection — same shape and same reason as processors/backup.ts and
 * processors/actions.ts. (`queues.ts` builds its producers at import time; that
 * file is not this wave's to change.)
 */
function queue(): Queue {
  recomputeQueue ??= new Queue(RECOMPUTE_COVERAGE_QUEUE, { connection });
  return recomputeQueue;
}

export async function enqueueRecomputeCoverage(job: RecomputeCoverageJob): Promise<void> {
  await queue().add(RECOMPUTE_COVERAGE_QUEUE, job, recomputeJobOptions(job.projectId));
}

export async function closeRecomputeCoverageQueue(): Promise<void> {
  if (recomputeQueue) await recomputeQueue.close();
  recomputeQueue = null;
}

/**
 * Ask for a recompute. Resolves what the trigger did not know, and NEVER
 * throws.
 *
 * The never-throwing is the contract, not politeness. Every caller is a
 * `finally` block wrapped around somebody else's job: a run that executed 400
 * tests, a crawl that held a browser for five minutes. If this function could
 * throw, a Redis blip would convert a finished run into a failed job — and
 * worse, a throw from a `finally` REPLACES the error the job actually failed
 * with, so a crawl that died of a real bug would be reported as a queue
 * problem. It returns the job it enqueued, or null, and says which in the log.
 *
 * A project that cannot be resolved (a run row that was deleted under us) is a
 * null and a warn, not an error: there is nothing to measure and nobody to tell.
 */
export async function requestRecompute(
  trigger: RecomputeTrigger,
  deps: RecomputeCoverageDeps = {},
): Promise<RecomputeCoverageJob | null> {
  try {
    const job = await jobForTrigger(trigger);
    if (!job) return null;
    await (deps.enqueue ?? enqueueRecomputeCoverage)(job);
    logger.debug(
      { projectId: job.projectId, reason: job.reason, jobId: recomputeJobId(job.projectId) },
      'coverage recompute requested',
    );
    return job;
  } catch (err) {
    logger.error(
      { err, trigger },
      'could not request a coverage recompute; the stored snapshot is now stale until the next trigger',
    );
    return null;
  }
}

/**
 * Turn a trigger into a job, reading the Run row when that is the only place the
 * project id lives.
 *
 * The commit comes off the run as well, because a snapshot that records which
 * commit it measured is the difference between a number you can defend in a
 * meeting and a number you cannot — and the run is the only trigger that knows
 * one.
 */
async function jobForTrigger(trigger: RecomputeTrigger): Promise<RecomputeCoverageJob | null> {
  if (trigger.reason !== 'run') {
    return { orgId: trigger.orgId, projectId: trigger.projectId, reason: trigger.reason };
  }

  const run = await prisma.run.findFirst({
    where: { id: trigger.runId, orgId: trigger.orgId },
    select: { projectId: true, commitSha: true },
  });
  if (!run) {
    logger.warn(
      { runId: trigger.runId, orgId: trigger.orgId },
      'no run row for a finished run job; skipping the coverage recompute',
    );
    return null;
  }

  return {
    orgId: trigger.orgId,
    projectId: run.projectId,
    reason: 'run',
    commitSha: run.commitSha,
    runId: trigger.runId,
  };
}

// ─── The delta, which is what makes a loop able to stop ─────────────────────

/**
 * The movement between two stored measurements, in PERCENTAGE POINTS.
 *
 * It lives here, beside the code that writes the snapshot, rather than in the
 * loop that reads it — because the number and its predecessor are both known at
 * exactly this point and nowhere else, and a consumer that re-derived the delta
 * would be re-reading the trend to recompute something the writer already had.
 * The closure loop's settle rule (`decideTick` in processors/close-loop.ts) is
 * the first consumer; a CI gate's "coverage dropped" check is the obvious next
 * one, and it must not have to implement this arithmetic a second time.
 *
 * ── NULL IS NOT ZERO, AND HERE IS WHERE THAT MATTERS MOST ───────────────────
 *
 * Three of the four combinations of (previous, current) are not a delta at all,
 * and collapsing any of them to 0 breaks a loop that stops on a small delta:
 *
 *   previous NULL, current NULL   nothing was measurable then or now. A delta
 *                                 of 0 would read as "the number has settled",
 *                                 which is a loop deciding it has finished
 *                                 because it never started.
 *   previous NULL, current set    the FIRST measurement. There is no movement
 *                                 to report; reporting `current - 0` would
 *                                 claim a jump from zero coverage that never
 *                                 happened.
 *   previous set, current NULL    the project became unmeasurable — the crawl
 *                                 was deleted, the analysis went away. That is
 *                                 a REGRESSION in what we can see, not a
 *                                 movement in coverage, and it must not be
 *                                 reported as one.
 *
 * So the only case that produces a number is both-set, and `why` names which
 * of the four happened so the sentence on a campaign row is never "delta:
 * null".
 */
export interface CoverageDelta {
  /** Signed. Positive is improvement. Null means there is no delta to report. */
  points: number | null;
  why: string;
}

export function coverageDelta(previous: number | null, current: number | null): CoverageDelta {
  if (previous === null && current === null) {
    return {
      points: null,
      why: 'Not measured before and not measured now: the surface denominator is empty, so there is no percentage and therefore no movement. This is not a delta of zero.',
    };
  }
  if (previous === null) {
    return {
      points: null,
      why: `First measurement at ${current}%. There is no previous snapshot to compare against, so no movement is reported.`,
    };
  }
  if (current === null) {
    return {
      points: null,
      why: `Coverage was ${previous}% and is now not measurable at all — the source analysis or the crawl this project was measured from has gone. That is a loss of visibility, not a change in coverage.`,
    };
  }
  const rounded = Math.round((current - previous) * 100) / 100;
  /*
   * `=== 0 ? 0 : rounded` is not superstition: float noise on two equal
   * percentages rounds to NEGATIVE zero, and -0 is what would then be stored in
   * the Float column and interpolated into a sentence. "Down 0 point(s)" is a
   * small lie, and `JSON.stringify(-0)` is "0" while the database keeps -0, so
   * it is a small lie that disagrees with itself across the wire.
   */
  const points = rounded === 0 ? 0 : rounded;
  return {
    points,
    why:
      points === 0
        ? `Unchanged at ${current}%.`
        : `${points > 0 ? 'Up' : 'Down'} ${Math.abs(points)} point(s), from ${previous}% to ${current}%.`,
  };
}

// ─── Applied retirements, beside the percentage they lowered ─────────────────

/**
 * How many APPLIED retirements one recompute reads.
 *
 * A disclosure and not a gate: past it the counts are a floor and `capped`
 * says so. Unlike the exclusion list in processors/explore.ts, a truncated read
 * here cannot cause a wrong decision — nothing branches on it — it can only
 * under-report how much coverage a set of retirements removed, which is why it
 * is reported rather than refused.
 */
export const APPLIED_RETIREMENT_SCAN_CAP = 500;

/** One APPLIED `RetirementProposal`, as the recompute reads it. */
export interface AppliedRetirementRow {
  id: string;
  testId: string;
  surfacesReturnedToUncovered: readonly string[];
  surfacesStillCovered: readonly string[];
  /** The honesty column. FALSE on an APPLIED row is a defect, not a state. */
  surfacesReopened: boolean;
}

/**
 * What the retirements applied to this project did to the number beside them.
 *
 * ── THE LIE THIS EXISTS TO MAKE IMPOSSIBLE ──────────────────────────────────
 *
 * A retirement that quietly RAISED the coverage percentage. The surface a
 * retired test covered does NOT leave the denominator: the application still
 * has it and now nothing tests it, so the numerator falls and the number goes
 * DOWN. Every other arrangement of this arithmetic invites a caller to shrink
 * the denominator instead, because shrinking it is what makes the figure come
 * out flattering and nobody questions a number that moved the way they wanted
 * — and that would make "delete the failing tests" the fastest way to hit a
 * coverage target.
 *
 * `denominatorDelta` is the literal `0` and `effect` is ASKED of
 * `retirementDenominatorEffect` rather than written here, so the rule cannot be
 * restated differently by this file than by the proposal writer or the apply
 * endpoint.
 */
export interface AppliedRetirementDisclosure {
  /** APPLIED proposals read. 0 means we looked; it is not "not measured". */
  applied: number;
  /** Surfaces that lost their only live cover, across every applied retirement. */
  surfacesReturnedToUncovered: number;
  /** Surfaces another live test still reaches. What makes the first believable. */
  surfacesStillCovered: number;
  /**
   * APPLIED retirements whose surfaces were never re-opened.
   *
   * A DEFECT AND NOT A STATE, which is why it is counted separately and named
   * in the disclosure rather than folded into the total: each one is a test
   * that stopped running while its surface stayed COVERED, which is a coverage
   * percentage flattered by exactly that many items. Reported rather than
   * repaired here — repairing it silently would destroy the evidence that the
   * apply path has a hole in it, and the apply path is the only thing entitled
   * to write that column.
   */
  surfacesNotReopened: number;
  /** From the keystone. Can never be LEAVES_DENOMINATOR. */
  effect: DenominatorEffect;
  /** ALWAYS zero. A retired test's surface stays in the measurement. */
  denominatorDelta: 0;
  /** TRUE when the scan cap bit, so every count above is a floor. */
  capped: boolean;
  /** The sentence an operator reads. Never only a count. */
  disclosure: string;
}

/**
 * Describe the applied retirements. Pure, so the arithmetic is testable without
 * a database — which matters because the one thing it must never do is produce
 * a positive `denominatorDelta`.
 */
export function describeAppliedRetirements(
  rows: readonly AppliedRetirementRow[],
  capped = false,
): AppliedRetirementDisclosure {
  /*
   * ASKED, not assumed. `retirementDenominatorEffect` is handed the union of
   * every applied retirement's surfaces so that the `effect` on this report is
   * the same value the proposal and the apply path carry — one rule, one
   * answer, in all three places. A hardcoded `'RETURNS_TO_UNCOVERED'` here
   * would be a fourth copy of the rule and the one a reader would trust.
   */
  const covers = new Set<string>();
  const elsewhere = new Set<string>();
  for (const row of rows) {
    for (const itemId of row.surfacesReturnedToUncovered) covers.add(itemId);
    for (const itemId of row.surfacesStillCovered) {
      covers.add(itemId);
      elsewhere.add(itemId);
    }
  }
  const effect = retirementDenominatorEffect({
    covers: [...covers].sort(),
    alsoCoveredElsewhere: [...elsewhere].sort(),
  });

  const notReopened = rows.filter((row) => !row.surfacesReopened).length;
  const returned = effect.surfacesReturnedToUncovered.length;
  const stillCovered = effect.surfacesStillCovered.length;

  return {
    applied: rows.length,
    surfacesReturnedToUncovered: returned,
    surfacesStillCovered: stillCovered,
    surfacesNotReopened: notReopened,
    effect: effect.effect,
    denominatorDelta: 0,
    capped,
    disclosure:
      rows.length === 0
        ? 'No retirement has been applied to this project, so no surface has been returned to UNCOVERED by one.'
        : `${rows.length} applied retirement(s) returned ${returned} surface(s) to UNCOVERED (${stillCovered} stay covered by another live test). ` +
          'The denominator is UNCHANGED — the application still has those surfaces and now nothing tests them, so the percentage went DOWN, not up.' +
          (notReopened > 0
            ? ` ${notReopened} of them never re-opened their surfaces, which means the percentage above is flattered by that much: a DEFECT in the apply path, reported here rather than repaired.`
            : '') +
          (capped
            ? ` More than ${APPLIED_RETIREMENT_SCAN_CAP} applied retirements exist, so every count here is a floor.`
            : ''),
  };
}

// ─── Reporting the result honestly ───────────────────────────────────────────

/** The part of a snapshot a log line (and a test) cares about. */
export interface RecomputeOutcome {
  projectId: string;
  reason: RecomputeReason;
  /** Null when `persist` was somehow refused; otherwise the row that was written. */
  snapshotId: string | null;
  /** NULL — never 0, never 100 — when there was nothing to divide. Rule 1. */
  percent: number | null;
  denominator: number;
  covered: number;
  /** Its own number. A test that has never executed is not covered. Rule 2. */
  assertedNotRun: number;
  uncovered: number;
  /** Reported apart from `uncovered`, and never as a gap. Rule 3. */
  unknown: number;
  waived: number;
  /** Named, not scored. Rule 4. */
  unmeasuredKinds: SurfaceKind[];
  /** In full, next to the figure. Rule 5. */
  caveats: string[];
  /**
   * The previous PERSISTED snapshot's percentage, and the movement since it.
   *
   * Both nullable, and both read from the stored trend rather than from
   * anything in flight: the question a delta answers is "has the number this
   * product REPORTS moved?", and the number it reports is the one in the
   * CoverageSnapshot table. `deltaPoints` is null whenever there is no delta to
   * report — see `coverageDelta` for the three ways that happens and why none
   * of them is zero.
   */
  previousPercent: number | null;
  deltaPoints: number | null;
  deltaWhy: string;
  /**
   * What the retirements applied to this project did to this number.
   *
   * Reported on every recompute, including as `applied: 0` — "we looked and
   * none" is a measurement and a missing field would not be. This is the READ
   * PATH for `RetirementProposal.surfacesReturnedToUncovered` and
   * `surfacesReopened`: columns the apply endpoint writes, and until now
   * nothing read, which means nothing could have noticed a retirement whose
   * surfaces stayed COVERED.
   */
  retirements: AppliedRetirementDisclosure;
  headline: string;
}

/**
 * The one sentence an operator reads.
 *
 * Written as a function so it is testable on its own, because the ways it can
 * be wrong are the ways the product can be wrong: printing 0% for an empty
 * denominator, counting a written-but-never-run test as covered, calling an
 * UNKNOWN item a gap, scoring an axis we do not measure, or dropping the
 * caveats that say what the number could not see.
 */
export function describeSnapshot(
  snapshot: SurfaceSnapshot,
  unmeasured: readonly SurfaceKind[],
): string {
  const t = snapshot.totals;

  // Rule 1. An empty denominator is not a score; it is an absence of one, and
  // the sentence has to say which absence.
  const headline =
    t.percent === null
      ? t.waived > 0
        ? `not measured yet — every measured surface item on this project is waived (${t.waived}), so there is nothing to divide`
        : 'not measured yet — no measured surface items exist for this project yet (no source analysis and no crawl have landed, or neither found anything)'
      : `${t.percent}% of ${t.denominator} measured surface item(s) covered`;

  // Rules 2 and 3: each state keeps its own name. Nothing is summed into
  // "covered" and nothing unknown is called a gap.
  const states =
    `${t.covered} covered · ${t.assertedNotRun} asserted-but-never-run · ` +
    `${t.uncovered} uncovered · ${t.unknown} unknown (not a gap) · ${t.waived} waived`;

  // Rule 4: name them. "0% of your component states are covered" is a lie
  // about the customer's app; "we do not measure component states" is a fact
  // about ours.
  const axes =
    unmeasured.length > 0
      ? `${unmeasured.length} axis/axes not measured at all: ${[...unmeasured].join(', ')}`
      : 'every declared axis has an extractor';

  // Rule 5: in full. A caveat behind a tooltip is a caveat nobody read, and a
  // caveat dropped from a log is one nobody can retrieve.
  const caveats =
    snapshot.caveats.length > 0
      ? `caveats: ${snapshot.caveats.join(' | ')}`
      : 'no caveats recorded';

  return `${headline} · ${states} · ${axes} · ${caveats}`;
}

// ─── The lazy import of the one true computation ─────────────────────────────

let cachedCompute: ComputeCoverageFn | null = null;

/**
 * The guard that stops a missing env var from killing the worker.
 *
 * Importing the computation drags in apps/api/src/env.ts, which validates the
 * API's whole schema and — on any failure — calls `process.exit(1)`. Loading it
 * from here therefore converts "this deployment did not give the worker
 * SESSION_SECRET" into "the worker process vanishes mid-recompute, taking every
 * in-flight run in every org with it". That is a far worse outcome than a
 * recompute that does not happen, and it would be triggered by a variable the
 * worker has never needed for anything else.
 *
 * So the two variables the API requires and the worker's own `context.ts` does
 * NOT are checked first, and a gap refuses the import. The job then fails
 * loudly, with the variable named, and everything else in the worker keeps
 * running. This whole function disappears the day the computation takes its
 * Prisma client as a parameter and stops living behind that env module.
 *
 * Deliberately NOT a copy of the API's schema: it checks the two fields whose
 * absence is plausible in a worker-only environment, and the error says that it
 * is a pre-flight rather than the authority.
 */
export function apiEnvGap(env: Record<string, string | undefined> = process.env): string | null {
  // min(32) in apps/api/src/env.ts. The worker never reads it.
  if ((env.SESSION_SECRET ?? '').length < 32) {
    return 'SESSION_SECRET is missing or shorter than 32 characters';
  }
  // 32 bytes of base64 in apps/api/src/env.ts; the worker only checks non-empty,
  // so a value that satisfies the worker can still exit the API's parser.
  let keyBytes = 0;
  try {
    keyBytes = Buffer.from(env.VAULT_MASTER_KEY ?? '', 'base64').length;
  } catch {
    keyBytes = 0;
  }
  if (keyBytes !== 32) return 'VAULT_MASTER_KEY is not 32 bytes of base64';
  return null;
}

/**
 * Resolve `computeCoverage`, once per process, on first use.
 *
 * The warn is deliberate and fires once: it is the only visible trace that this
 * worker just pulled the API's Express/Prisma module graph into itself, and the
 * line names the fix so the person reading it does not have to find this comment.
 */
async function loadComputeCoverage(): Promise<ComputeCoverageFn> {
  if (cachedCompute) return cachedCompute;

  const gap = apiEnvGap();
  if (gap) {
    throw new Error(
      `Refusing to load the coverage computation from apps/api: ${gap}. That module's env parser calls process.exit(1), so importing it here would kill the worker and every in-flight run rather than failing this job. Give the worker the API's env, or move computeCoverage to a package that takes its Prisma client as a parameter (see apps/api/src/lib/start-run.ts).`,
    );
  }

  logger.warn(
    { module: 'apps/api/src/lib/coverage-store.ts' },
    'loading the coverage computation from apps/api — it should take its Prisma client as a parameter (like lib/start-run.ts) and move to a package; until then this opens a second connection pool in the worker',
  );
  const mod = await import('../../../api/src/lib/coverage-store.js');
  cachedCompute = mod.computeCoverage;
  return cachedCompute;
}

/** Test seam: forget the cached module so one test's stub cannot leak into the next. */
export function _resetComputeCache(): void {
  cachedCompute = null;
}

// ─── The processor ───────────────────────────────────────────────────────────

/**
 * Measure, and store the measurement.
 *
 * `persist: true` is the entire reason this job exists — a GET recomputes
 * without writing, so nothing a human does creates a trend. This is what gives
 * the CI gate something to compare against.
 *
 * A project with nothing to measure is NOT an error. No source analysis and no
 * crawl means an empty inventory, which means a zero denominator, which means a
 * null percentage — a valid, honest state that still deserves a stored row,
 * because "we looked at commit abc123 and could see nothing" is a fact worth
 * having in the trend when somebody later asks why the number appeared from
 * nowhere.
 */
export async function processRecomputeCoverage(
  job: RecomputeCoverageJob,
  deps: RecomputeCoverageDeps = {},
): Promise<RecomputeOutcome> {
  const compute = deps.compute ?? (await loadComputeCoverage());

  /*
   * Read BEFORE the computation, not after, and that ordering is the whole
   * correctness of the delta: `compute` with `persist: true` writes a new
   * CoverageSnapshot row as its last action, so a "previous snapshot" query
   * issued afterwards would find the row this very job just wrote and report a
   * delta of the number against itself — zero, always, on every project.
   *
   * A null here is an ordinary first measurement, and `coverageDelta` says so
   * rather than treating the absence as 0%.
   */
  const previous = await prisma.coverageSnapshot.findFirst({
    where: { projectId: job.projectId },
    orderBy: { createdAt: 'desc' },
    select: { percent: true },
  });

  const computed = await compute({
    orgId: job.orgId,
    projectId: job.projectId,
    commitSha: job.commitSha ?? null,
    runId: job.runId ?? null,
    persist: true,
  });

  /*
   * ── THE RETIREMENTS, READ BESIDE THE NUMBER THEY LOWERED ──────────────────
   *
   * THE PRODUCTION READ PATH for the three columns the apply endpoint writes.
   * Without it, `surfacesReopened` was written by one endpoint and consulted by
   * nothing — so an APPLIED retirement whose surfaces stayed COVERED would have
   * flattered this percentage with nothing in the product able to say so.
   *
   * APPLIED only. A PROPOSED retirement has disabled nothing and re-opened
   * nothing, and counting one here would report a decision nobody has made as
   * coverage already lost. A positive state list rather than a `notIn`, for the
   * reason triage.ts gives about the same table: a `notIn` quietly adopts every
   * state a later round adds.
   */
  const appliedRows = await prisma.retirementProposal.findMany({
    where: { projectId: job.projectId, state: 'APPLIED' },
    orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
    take: APPLIED_RETIREMENT_SCAN_CAP + 1,
    select: {
      id: true,
      testId: true,
      surfacesReturnedToUncovered: true,
      surfacesStillCovered: true,
      surfacesReopened: true,
    },
  });
  const retirements = describeAppliedRetirements(
    appliedRows.slice(0, APPLIED_RETIREMENT_SCAN_CAP),
    appliedRows.length > APPLIED_RETIREMENT_SCAN_CAP,
  );

  const { snapshot, unmeasuredKinds } = computed;
  const delta = coverageDelta(previous?.percent ?? null, snapshot.totals.percent);
  const outcome: RecomputeOutcome = {
    projectId: job.projectId,
    reason: job.reason,
    snapshotId: computed.snapshotId,
    percent: snapshot.totals.percent,
    denominator: snapshot.totals.denominator,
    covered: snapshot.totals.covered,
    assertedNotRun: snapshot.totals.assertedNotRun,
    uncovered: snapshot.totals.uncovered,
    unknown: snapshot.totals.unknown,
    waived: snapshot.totals.waived,
    unmeasuredKinds,
    caveats: snapshot.caveats,
    previousPercent: previous?.percent ?? null,
    deltaPoints: delta.points,
    deltaWhy: delta.why,
    retirements,
    headline: describeSnapshot(snapshot, unmeasuredKinds),
  };

  /*
   * The retirement defect is logged at ERROR and on its own line, not folded
   * into the info above. An APPLIED retirement with `surfacesReopened: false`
   * is a test that stopped running while its surface stayed COVERED — this
   * percentage is flattered by that much, and an operator reading a dispute
   * about the number has to be able to find the sentence.
   */
  if (retirements.surfacesNotReopened > 0) {
    logger.error(
      {
        projectId: job.projectId,
        surfacesNotReopened: retirements.surfacesNotReopened,
        applied: retirements.applied,
      },
      'applied retirement(s) never re-opened their surfaces; this coverage percentage is flattered by that many items',
    );
  }

  logger.info(outcome, 'coverage recomputed');
  return outcome;
}
