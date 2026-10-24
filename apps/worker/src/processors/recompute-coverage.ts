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

/** Why a recompute was asked for. Logged, so a surprising snapshot is traceable. */
export type RecomputeReason = 'source-analysis' | 'crawl' | 'run' | 'tests-changed';

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

  const computed = await compute({
    orgId: job.orgId,
    projectId: job.projectId,
    commitSha: job.commitSha ?? null,
    runId: job.runId ?? null,
    persist: true,
  });

  const { snapshot, unmeasuredKinds } = computed;
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
    headline: describeSnapshot(snapshot, unmeasuredKinds),
  };

  logger.info(outcome, 'coverage recomputed');
  return outcome;
}
