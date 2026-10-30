/**
 * Worker-side producers. The run processor enqueues triage, and the explore
 * processor enqueues generation, so the worker needs to write to its own queues.
 */

import { Queue } from 'bullmq';
import { analyzeSourceJobOptions, QUEUE_NAMES } from '@qaai/shared';
import type {
  CopilotJob,
  ExploreJob,
  GenerateJob,
  JobPayloads,
  NotifyJob,
  ShardedRunJob,
  TriageJob,
} from '@qaai/shared';
// Pure module — types, constants and the search, no Prisma and no Express. That
// is what makes it importable here; apps/api/src/lib/plan.ts and vault.ts are
// duplicated instead precisely because they are not.
import { BISECT_QUEUE, MAX_BISECT_TICKS, type BisectJob } from '../../api/src/lib/bisect.js';
import { connection } from './context.js';
/*
 * The per-heal job options and the payload type, from the module that owns the
 * decision they encode.
 *
 * `verifyHealJobOptions` is in processors/verify-heal.ts because the ARGUMENT
 * for both removal flags is about that processor's entity — a heal nothing ever
 * re-measures — and because its own test pins the exact options object. The
 * queue NAME stays here beside its producer; the OPTIONS stay beside the
 * reasoning. verify-heal.ts imports nothing from this file, so there is no
 * cycle.
 */
import { verifyHealJobOptions, type VerifyHealJob } from './processors/verify-heal.js';

/**
 * "Learn my codebase": read the stored source analysis and propose a plan.
 *
 * NOT in `QUEUE_NAMES` (packages/shared) only because this wave does not own
 * that file — the same reason and the same shape as RETENTION_QUEUE in
 * processors/retention.ts and BISECT_QUEUE in the API's lib/bisect.ts. The
 * literal is exported so the API's producer and the worker's consumer can share
 * one constant instead of two strings that drift.
 *
 * It lives HERE rather than in the processor so that processors/analyze-source.ts
 * can import `enqueueGenerate` from this module without the two files forming an
 * import cycle around a module-level `new Queue(...)`.
 */
export const ANALYZE_SOURCE_QUEUE = 'qaai.analyze-source';

/**
 * One "learn this project's codebase" job.
 *
 * Ids only, like every other payload (see the header of
 * packages/shared/src/jobs.ts): the analysis itself is a large blob written by
 * the ingest pass, and a job that carried a copy would be generating a plan
 * against a snapshot that may already be stale by the time it runs.
 */
export interface AnalyzeSourceJob {
  orgId: string;
  projectId: string;
  /** Who asked, for the audit row and the plan's provenance. */
  requestedBy: string;
  /** Skip the approval screen and generate straight away (onboarding only). */
  autoApprove?: boolean;
}

/**
 * THE CAPABILITY PREFLIGHT: "which of the nineteen test types can this image
 * actually execute?"
 *
 * ── THE LIE THIS QUEUE EXISTS TO KILL ──────────────────────────────────────
 *
 * The worker image has no k6, no Lighthouse, no Stryker, no Maestro, no Firefox
 * and no WebKit. The plugins for those types do not crash — they degrade to
 * SKIPPED and say so politely, once, in a result row nothing aggregates. So a
 * pass rate could be computed over tests that CANNOT FAIL, and a coverage
 * percentage could count obligations this deployment has no way of
 * discharging. `processors/preflight.ts` answers that for all nineteen and
 * writes a `DeploymentCapability` row each; this is how it gets asked.
 *
 * ── WHY A QUEUE AND NOT A STARTUP CALL ─────────────────────────────────────
 *
 * Because A CACHED `AVAILABLE` FOR A BINARY THAT HAS SINCE VANISHED IS A LIE
 * ABOUT THE IMAGE. Somebody rebuilds the container without k6 and a row
 * written at boot keeps vouching for it until the process restarts. So the
 * probe is a repeatable job on a short cadence, the rows carry their own
 * `checkedAt`, and the AGE of the answer is part of the answer.
 *
 * NOT in `QUEUE_NAMES` for the same reason as `ANALYZE_SOURCE_QUEUE` above and
 * `RETENTION_QUEUE`: this wave does not own packages/shared/src/constants.ts.
 * The literal is exported so a producer and the consumer share one constant
 * instead of two strings that drift.
 */
export const PREFLIGHT_QUEUE = 'qaai.preflight';

/**
 * The suppression expiry sweep.
 *
 * ── WHY A SWEEP AND NOT ONLY THE READ-TIME CHECK ───────────────────────────
 *
 * `isInForce` already refuses an expired suppression at every read, so an
 * expiry takes effect with nobody doing anything — that is the design and this
 * sweep does not change it. What the read-time check CANNOT do is tell anyone.
 * An expiry that arrives as a surprise outage teaches a team to set the next one
 * for a year, which is how "temporary" mutes become permanent; and a
 * `RetirementProposal` nobody reviewed would sit PROPOSED for ever, pretending
 * to be a decision somebody is about to make.
 *
 * So the sweep's job is the part that needs a clock of its own: move the
 * expired proposals to EXPIRED, and report the mutes that are about to stop
 * suppressing to the humans who own them.
 *
 * NOT in `QUEUE_NAMES` for the same reason as `ANALYZE_SOURCE_QUEUE` above and
 * `RETENTION_QUEUE`: this wave does not own packages/shared/src/constants.ts.
 */
export const SUPPRESSION_QUEUE = 'qaai.suppression';

/**
 * "Re-measure this heal."
 *
 * ── WHY IT IS A QUEUE AT ALL ────────────────────────────────────────────────
 *
 * Because `startHealVerification` existed THREE TIMES — in
 * apps/api/src/routes/agent.ts, in processors/triage.ts, and as the one
 * implementation in processors/verify-heal.ts that nothing imported. Two of
 * those copies each wrote the same four columns inline afterwards, which is how
 * `verifiedAt` came to be stamped on one path and not the other. One queue, one
 * consumer, one writer.
 *
 * And because of the heal nothing would ever have checked: both apply paths
 * document that a crash between their code transaction and their verification
 * start leaves `verifyState` NULL, which is honest and means the patch sits in
 * a customer's test with nothing that will re-measure it — invisible to
 * `verifyAppliedHeals`, whose query is `where: { verifyState: 'PENDING' }`. A
 * job survives a worker restart; an inline call does not.
 *
 * NOT in `QUEUE_NAMES`, for the same reason as `ANALYZE_SOURCE_QUEUE` above and
 * `RETENTION_QUEUE`. What the API's apply path needed was not that list but a
 * `JobPayloads` entry — `enqueue` in apps/api/src/lib/queues.ts is keyed on
 * that interface — and `'qaai.verify-heal': VerifyHealJob` is now in
 * packages/shared/src/jobs.ts beside the payload and the job options. So the
 * API produces to this queue and its third copy of the start is gone.
 *
 * `satisfies` is what keeps the two strings one fact: renaming the queue here
 * without renaming the payload key, or the reverse, is a compile error rather
 * than a producer publishing into a queue nothing drains.
 */
export const VERIFY_HEAL_QUEUE = 'qaai.verify-heal' satisfies keyof JobPayloads;

/**
 * "This run's mutation report named missing assertions — turn them into work."
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The mutation plugin NAMES EACH MISSING ASSERTION: it flips `>` to `>=` on
 * line 84 of src/cart.ts, the suite still passes, and a `MutationSurvivor` row
 * records exactly that. `packages/agent/src/mutant-closure.ts` turns those rows
 * into ranked, de-duplicated, fenced work — and had NO PRODUCTION CALLER, so
 * the most precise instruction this product ever generates went into a table,
 * scored a percentage, and stopped.
 *
 * Per RUN and not per result: a mutation report is per test result, but the
 * thing a developer fixes is "nothing asserts the boundary in cart.ts", which
 * spans results. One job per run also means the grouping sees the whole report
 * rather than a slice of it, which is what makes the de-duplication honest.
 *
 * NOT in `QUEUE_NAMES`, for the same reason as `VERIFY_HEAL_QUEUE` above.
 */
export const MUTANT_CLOSURE_QUEUE = 'qaai.mutant-closure';

/**
 * One capability probe.
 *
 * `deploymentKey` carries the sentinel `<self>` for this image and
 * `pool:<name>` for a customer's own runner pool, which is why it is a FIELD
 * rather than being assumed: a cloud worker and an on-prem pool have different
 * binaries installed, and one set of rows for both would report the cloud's
 * missing k6 as the customer's.
 *
 * Ids and flags only, like every other payload (see the header of
 * packages/shared/src/jobs.ts). There is nothing to carry: the probe reads the
 * filesystem it is running on, which is the whole point of running it there.
 */
export interface PreflightJob {
  /** `'<self>'` for this image. A runner pool passes `pool:<name>`. */
  deploymentKey?: string;
  /** Null for the cloud image, which belongs to no org. A pool belongs to one. */
  orgId?: string | null;
  /** Bypass the freshness window. The sweep never does; an operator can. */
  force?: boolean;
}

const generateQueue = new Queue(QUEUE_NAMES.generate, { connection });
const preflightQueue = new Queue(PREFLIGHT_QUEUE, { connection });
const suppressionQueue = new Queue(SUPPRESSION_QUEUE, { connection });
const verifyHealQueue = new Queue(VERIFY_HEAL_QUEUE, { connection });
const mutantClosureQueue = new Queue(MUTANT_CLOSURE_QUEUE, { connection });
const exploreQueue = new Queue(QUEUE_NAMES.explore, { connection });
const analyzeSourceQueue = new Queue(ANALYZE_SOURCE_QUEUE, { connection });
const runQueue = new Queue(QUEUE_NAMES.run, { connection });
const triageQueue = new Queue(QUEUE_NAMES.triage, { connection });
const copilotQueue = new Queue(QUEUE_NAMES.copilot, { connection });
const notifyQueue = new Queue(QUEUE_NAMES.notify, { connection });
const scheduleQueue = new Queue(QUEUE_NAMES.schedule, { connection });
const flakeQueue = new Queue(QUEUE_NAMES.flake, { connection });
const bisectQueue = new Queue(BISECT_QUEUE, { connection });

/**
 * Priority for a run nobody is waiting on: the flake radar's confirmation
 * re-runs, and a bisect's probes.
 *
 * BullMQ processes jobs with NO priority ahead of prioritised ones, so simply
 * stamping a priority is what keeps ten re-runs of one suspect test behind every
 * CI run, schedule and monitor check. The number is arbitrary; that it exists at
 * all is the point.
 *
 * It matters more for bisect than for flake. A bisect is asked for while a build
 * is red, which is exactly when the run queue is busiest with the runs people
 * are actually waiting on — and the answer to "what broke this" is worth having
 * in ten minutes, not at the cost of everyone else's ten minutes.
 */
const BACKGROUND_RUN_PRIORITY = 100;

export async function enqueueGenerate(job: GenerateJob): Promise<void> {
  await generateQueue.add(QUEUE_NAMES.generate, job, { attempts: 2 });
}

/**
 * Queue a crawl from inside the worker.
 *
 * The only producer today is the closure loop's re-crawl
 * (processors/close-loop.ts): the denominator it is trying to move is partly
 * made of what a crawl reached, so a campaign measuring against a six-week-old
 * FlowMap is closing gaps in an application that has since changed. Until now
 * the only way to ask for a crawl was POST /projects/:id/explore, which means
 * a human.
 *
 * `attempts: 1`, and the job id pins one crawl per project in flight. Both for
 * the same reason `enqueueAnalyzeSource` above gives, and the reason is stronger
 * here: the Explorer WRITES — a FlowMap version and a TestPlan — so a retry does
 * not re-do the work, it duplicates it, and the customer ends up with two
 * identical plans to approve and a FlowMap version that moved twice for one
 * crawl. Everything the processor needs is read fresh from the database, so the
 * next deliberate crawl is always a better answer than a retry of this one.
 *
 * The job id is per PROJECT and not per request, which also means a loop that
 * asks twice gets one crawl — the belt to close-loop's own `recrawlQueuedAt`
 * brace.
 *
 * ── WHY THE TWO REMOVE OPTIONS ARE LOAD-BEARING AND NOT HOUSEKEEPING ────────
 *
 * MEASURED, against this repo's own Redis and this repo's own BullMQ, because a
 * claim about a queue's semantics is worth nothing asserted from memory:
 *
 *   jobId 'fixed', no remove options → add, drain to completed, add again
 *     → counts {completed: 1, waiting: 0}, and the SECOND add returns a Job
 *       object carrying the new data. Nothing was enqueued. The caller cannot
 *       tell.
 *   the same with removeOnComplete
 *     → counts {completed: 0, waiting: 1}, and the waiting job holds the new
 *       data.
 *
 * So a retained terminal job with this id SILENTLY SWALLOWS every later crawl
 * of that project, for as long as the key lives in Redis. The lock the comment
 * above describes is meant to be "one crawl per project IN FLIGHT"; without
 * these two lines it is "one crawl per project EVER", which was survivable
 * while the only producer was a human pressing a button and is not survivable
 * now. `fireReEnumeration` in processors/schedule.ts claims the trigger RUNNING
 * and then enqueues through here: the first nightly re-enumeration would run,
 * every one after it would be dropped with no error, each trigger would sit
 * RUNNING until RE_ENUMERATION_RUN_TIMEOUT_MS and then be recorded FAILED — a
 * crawl that never landed, reported as a fact about the customer's
 * application. "The denominator goes stale and nobody is told" is the defect
 * this whole round exists to remove, and this was a new way to produce it.
 *
 * The cost is that an explore job's own failure leaves Redis rather than
 * sitting in the failed set. That is the right trade here and only here: the
 * explore processor records its outcome in the DATABASE — the Run row, the
 * FlowMap, and the trigger's `lastRunState`/`lastFailureMessage` — so the
 * failure is still readable, whereas a swallowed enqueue is readable nowhere.
 * No other producer in this file is changed: `run-<id>`, `triage-<resultId>`,
 * `bisect-<id>-<step>` and `deliver-<id>` are ids of a one-shot-per-entity
 * thing, where permanent de-duplication is exactly what is wanted.
 */
export async function enqueueExplore(job: ExploreJob): Promise<void> {
  await exploreQueue.add(QUEUE_NAMES.explore, job, {
    jobId: `explore-${job.projectId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/**
 * Queue a source analysis.
 *
 * `attempts: 1` because the job WRITES — a FlowMap version and a TestPlan — so
 * a retry does not re-do the work, it duplicates it, and the user ends up
 * approving one of two identical plans. Everything the processor needs is read
 * fresh from the database, so the next deliberate run is always a better answer
 * than a retry of this one.
 *
 * The job id pins one analysis per project IN FLIGHT, and it only means that
 * because of the two removal flags `analyzeSourceJobOptions` carries with it.
 * Without them this function read as a lock and behaved as a permanent one: the
 * id is a Redis key, the queue above sets no `defaultJobOptions`, so BullMQ
 * retained the first completed job for ever and silently dropped every later
 * analysis of that project. Exactly the defect `enqueueExplore` above was fixed
 * for — and this producer was not on the list of ids that comment says were
 * deliberately left permanent, because it was simply missed.
 *
 * The options come from packages/shared rather than from here: the API's
 * endpoint is the other producer of this queue, it is the one real traffic goes
 * through, and it had inherited `attempts: 3` onto this non-idempotent
 * processor. Two producers whose retry and de-duplication semantics disagree is
 * how one install duplicates plans while another proposes none.
 */
export async function enqueueAnalyzeSource(job: AnalyzeSourceJob): Promise<void> {
  await analyzeSourceQueue.add(
    ANALYZE_SOURCE_QUEUE,
    job,
    analyzeSourceJobOptions(job.projectId),
  );
}

/**
 * Queue a run, or one slice of one.
 *
 * `ShardedRunJob` widens the parameter rather than adding a second function:
 * every existing caller passes `{ orgId, runId }`, which has no `shard`, and
 * gets byte-identical options to before — same job id, same single attempt.
 *
 * The job id is what makes a slice idempotent. Unsharded runs keep `run-<id>`,
 * so a retried enqueue still cannot double-execute a suite; a shard gets
 * `run-<id>-shard-<n>`, so its siblings are distinct jobs while a redelivery of
 * that same slice collapses onto the one job (and is then arbitrated properly
 * by `claimShard` in the run processor).
 *
 * `attempts: 1` for both, and for the same reason the API gives: a shard that
 * dies must surface as a shard that died, so the run finalises ERRORED naming
 * it. Retrying a slice while its siblings are already aggregating counts is how
 * a run reports numbers from two different attempts.
 *
 * `background` marks a run that exists only to measure something (§5 flake
 * confirmation). It changes nothing about how the run executes — only where it
 * sits in the queue.
 */
export async function enqueueRun(
  job: ShardedRunJob,
  opts: { background?: boolean } = {},
): Promise<void> {
  const shard = job.shard ?? null;
  await runQueue.add(QUEUE_NAMES.run, job, {
    jobId: shard ? `run-${job.runId}-shard-${shard.index}` : `run-${job.runId}`,
    attempts: 1,
    ...(opts.background ? { priority: BACKGROUND_RUN_PRIORITY } : {}),
  });
}

export async function enqueueTriage(job: TriageJob): Promise<void> {
  await triageQueue.add(QUEUE_NAMES.triage, job, {
    // One triage per result, ever — a retried run job must not re-triage and
    // duplicate verdict rows.
    jobId: `triage-${job.testResultId}`,
    attempts: 2,
  });
}

/**
 * Advance a bisect by one step, later.
 *
 * The processor calls this on itself. A bisect is mostly waiting — for a probe
 * run to reach a browser, execute, and finalise — and a job that sleeps through
 * that occupies a worker slot for the whole investigation and loses everything
 * when the process restarts. A delayed job costs a Redis key.
 *
 * `step` is in the job id, so a redelivered tick collapses onto the one job
 * instead of forking the investigation into two racing searches; and it is
 * bounded by MAX_BISECT_TICKS, so a bug in the step logic runs out rather than
 * re-enqueueing forever.
 *
 * `attempts: 1`, deliberately. Every step reads its state back from the database
 * (the probe runs and the audit rows), so BullMQ retrying a failed tick buys
 * nothing that the NEXT tick would not do better — and a retry storm here means
 * several ticks queueing probe runs for the same commit at once.
 */
export async function enqueueBisect(job: BisectJob, delayMs = 0): Promise<void> {
  // `>` and not `>=`: the processor concludes when it SEES step MAX_BISECT_TICKS,
  // so that tick has to be allowed to run. Refusing it here would strand the
  // investigation one step short of the ceiling with no report ever written.
  if (job.step > MAX_BISECT_TICKS) return;
  await bisectQueue.add(BISECT_QUEUE, job, {
    jobId: `bisect-${job.bisectId}-${job.step}`,
    attempts: 1,
    ...(delayMs > 0 ? { delay: delayMs } : {}),
  });
}

export async function enqueueCopilot(job: CopilotJob): Promise<void> {
  await copilotQueue.add(QUEUE_NAMES.copilot, job, { attempts: 1 });
}

/**
 * Ask for one heal to be re-measured.
 *
 * ── THE JOB ID IS A REDIS KEY, AND BOTH FLAGS ARE LOAD-BEARING ──────────────
 *
 * The options come from `verifyHealJobOptions`, which carries `removeOnComplete`
 * AND `removeOnFail` together. With only the first, a job that FAILED keeps its
 * id in the failed set and every later enqueue for that heal is silently
 * dropped for as long as the key lives in Redis — `add()` still returns a Job
 * and the caller cannot tell. Here that means A HEAL NOTHING EVER RE-MEASURES,
 * which is the exact defect this queue exists to close: the first verification
 * of a heal fails on a transient error, and the heal is then unverifiable for
 * ever with no record of why.
 *
 * `attempts: 1`, deliberately. The processor decides from the ROW, not the
 * payload, and everything it needs is read fresh — so the next deliberate
 * enqueue (the hole sweep's, five minutes later) is always a better answer than
 * a retry of this one, and a retry storm here means a verification Run per
 * attempt against the customer's own plan toll.
 */
export async function enqueueVerifyHeal(job: VerifyHealJob): Promise<void> {
  await verifyHealQueue.add(VERIFY_HEAL_QUEUE, job, {
    ...verifyHealJobOptions(job.healId),
    attempts: 1,
  });
}

/**
 * One "turn this run's surviving mutants into work" job.
 *
 * Ids only, like every other payload (see the header of
 * packages/shared/src/jobs.ts). The survivor rows are read fresh: a job
 * carrying a copy would be grouping a snapshot the run processor's own
 * delete-then-create may already have replaced.
 */
export interface MutantClosureJob {
  orgId: string;
  runId: string;
  /** Why this was asked for, for the log line. */
  reason: 'RUN_FINISHED' | 'OPERATOR';
}

/**
 * Ask for a run's mutation report to be turned into closure items.
 *
 * ONE JOB PER RUN, with BOTH removal flags, and the second flag is the one that
 * matters: a per-run id with only `removeOnComplete` keeps a FAILED job's id in
 * Redis, so a re-requested closure for that run — after the operator fixes
 * whatever broke — is silently dropped for ever. The report would then never
 * exist for that run and nothing would say so.
 *
 * MEASURED, against this repo's own BullMQ, with the first job driven to each
 * terminal state by a real Worker:
 *
 *   both flags, first job completed  → second add LANDS (waiting: 1)
 *   both flags, first job FAILED     → second add LANDS (waiting: 1)
 *   removeOnComplete only, failed    → second add is SILENTLY DROPPED
 *                                      (failed: 1, waiting: 0) and `add()`
 *                                      still returns the id
 *   neither flag, first completed    → second add is SILENTLY DROPPED
 *
 * ── A DASH AND NOT A COLON, AND IT IS NOT COSMETIC ──────────────────────────
 *
 * This id was written `mutant-closure:${runId}` and BullMQ REFUSES it:
 * `Error: Custom Id cannot contain :` (bullmq Job.validateOptions). The throw
 * happens inside `add`, so every closure request would have failed — which is
 * the loud direction, but it is still a feature that cannot be asked for. Every
 * other id in this file is dash-separated for the same reason: `run-<id>`,
 * `triage-<resultId>`, `bisect-<id>-<step>`, `deliver-<id>`.
 *
 * `attempts: 1`: the processor writes one audit row per run, keyed on the run,
 * and everything it reads is read fresh, so the next deliberate request beats a
 * retry of this one.
 */
export async function enqueueMutantClosure(job: MutantClosureJob): Promise<void> {
  await mutantClosureQueue.add(MUTANT_CLOSURE_QUEUE, job, {
    jobId: `mutant-closure-${job.runId}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/**
 * Outbound notification. Fire-and-forget by design: a PR comment that fails to
 * post must never fail the run that produced it.
 */
export async function enqueueNotify(job: NotifyJob): Promise<void> {
  await notifyQueue.add(QUEUE_NAMES.notify, job, { attempts: 3 });
}

/**
 * One webhook/chat POST, addressed by its WebhookDelivery row (§7).
 *
 * The notify processor no longer sends inline: it writes a PENDING row per
 * destination and enqueues one of these per row, so a failed send is retried by
 * the QUEUE — with backoff, without holding a worker slot through the wait, and
 * surviving a worker restart — rather than by sleeping in-process. The job
 * carries ids only (see the header of packages/shared/src/jobs.ts); the
 * processor re-reads the row and the integration, so an admin who fixes a bad
 * webhook URL mid-retry gets the retry delivered to the fixed URL.
 *
 * These ride the notify queue under their own job NAME rather than a queue of
 * their own: the queue already has a consumer, and a second queue is a second
 * thing that can end up produced-but-undrained (the bisect lesson check:wiring
 * exists for).
 *
 * The job id pins idempotency to the row: a redelivered or retried notify job
 * that re-enqueues the same delivery collapses onto the one job instead of
 * double-posting.
 */
export const DELIVERY_JOB = 'notify.deliver';

/**
 * Attempts per delivery. With the exponential backoff below (1m base) the five
 * attempts spread over ~15 minutes — long enough to ride out a Slack blip,
 * short enough that a page about a red build is not an hour late. After the
 * last one the row is marked FAILED and nothing retries it again.
 */
export const DELIVERY_ATTEMPTS = 5;

export interface DeliveryJob {
  orgId: string;
  /** The WebhookDelivery row this job exists to fulfil and record into. */
  deliveryId: string;
}

export async function enqueueDelivery(job: DeliveryJob): Promise<void> {
  await notifyQueue.add(DELIVERY_JOB, job, {
    jobId: `deliver-${job.deliveryId}`,
    attempts: DELIVERY_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

/**
 * Ask for a capability probe now.
 *
 * The job id pins ONE probe per deployment key in flight, with both removal
 * flags — the lesson `enqueueExplore` above paid for: a retained terminal job
 * with a fixed id silently swallows every later enqueue for as long as the key
 * lives in Redis, which would turn "one probe per deployment in flight" into
 * "one probe per deployment EVER" and freeze the capability set at whatever the
 * image held the first time a worker booted. That is precisely the stale
 * `AVAILABLE` this feature exists to prevent.
 *
 * `attempts: 1`: the probe is idempotent and cheap, so the next scheduled sweep
 * is always a better answer than a retry of this one — and a retry storm here
 * means nineteen `--version` subprocesses per attempt.
 *
 * ── THE COLON, AND WHY THE KEY IS REWRITTEN ────────────────────────────────
 *
 * `deploymentKey` carries `pool:<name>` for a customer's own runner pool, and
 * BullMQ REFUSES that id: `Job.validateOptions` throws `Custom Id cannot
 * contain :` for any id containing a colon whose `split(':')` is not exactly
 * three segments (node_modules/bullmq/dist/cjs/classes/job.js — the three-part
 * case is a compatibility carve-out for repeatable jobs, not a licence).
 * `preflight-pool:acme` is two segments, so EVERY runner-pool probe threw and
 * no pool's capabilities were ever recorded.
 *
 * So the colon is replaced rather than the key being renamed. It is a Redis
 * key, not a datum: the only property it needs is that two deployment keys
 * cannot collide, and `-` for `:` preserves that because `:` is the only
 * character this sentinel vocabulary uses it for. Rewriting the KEY would
 * change the de-duplication identity of in-flight `<self>` probes, which is a
 * decision about the preflight feature rather than about this producer.
 */
export async function enqueuePreflight(job: PreflightJob = {}): Promise<void> {
  await preflightQueue.add(PREFLIGHT_QUEUE, job, {
    jobId: `preflight-${(job.deploymentKey ?? '<self>').replace(/:/g, '-')}`,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/**
 * Arm the capability sweep.
 *
 * Every fifteen minutes, which is deliberately shorter than it looks like it
 * needs to be: `CAPABILITY_FRESH_MS` is ten minutes, so each sweep finds the
 * rows stale and re-probes, and the stored `checkedAt` is never more than a
 * quarter of an hour behind the image. A daily sweep would mean a container
 * rebuilt at 09:00 keeps vouching for a binary it no longer has until the next
 * morning, and every coverage figure computed in between would have counted
 * obligations nothing could discharge.
 *
 * It is cheap enough to mean it: a `stat` per PATH entry plus at most one
 * `--version` per binary with a declared version window.
 *
 * Armed on every boot, de-duplicated by `jobId`, so a restart cannot
 * double-schedule — the same contract as the scheduler and flake sweeps.
 */
export async function armPreflightSweep(): Promise<void> {
  await preflightQueue.add(
    'tick',
    {},
    {
      repeat: { every: 15 * 60_000 },
      jobId: 'qaai-preflight-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

/**
 * Arm the scheduler sweep. A BullMQ repeatable job survives restarts and
 * de-duplicates by key, so calling this on every boot is safe and means the
 * sweep exists as long as a worker does.
 */
export async function armScheduleTick(): Promise<void> {
  await scheduleQueue.add(
    'tick',
    { at: new Date().toISOString() },
    {
      repeat: { every: 60_000 },
      jobId: 'qaai-schedule-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

/**
 * Arm the flake sweep (§5). Same repeatable-job reasoning as the scheduler, at a
 * slower cadence: an investigation advances by one re-run per tick, and a
 * measurement nobody is waiting on has no business ticking every minute.
 */
export async function armFlakeTick(): Promise<void> {
  await flakeQueue.add(
    'tick',
    { at: new Date().toISOString() },
    {
      repeat: { every: 5 * 60_000 },
      jobId: 'qaai-flake-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

/**
 * Arm the suppression expiry sweep. Same repeatable-job reasoning as the
 * scheduler, at the flake sweep's cadence: an expiry that is five minutes late
 * being ANNOUNCED has already taken effect at every read, so nothing is
 * suppressed in the meantime and there is nothing to gain from ticking every
 * minute.
 *
 * `removeOnComplete` AND `removeOnFail`, both, like every arm above: a fixed
 * `jobId` is a Redis key, and a repeatable job whose failed record is kept
 * under that key is a job that never runs again.
 */
export async function armSuppressionSweep(): Promise<void> {
  await suppressionQueue.add(
    'tick',
    { at: new Date().toISOString() },
    {
      repeat: { every: 5 * 60_000 },
      jobId: 'qaai-suppression-tick',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

export async function closeProducers(): Promise<void> {
  await Promise.all([
    generateQueue.close(),
    runQueue.close(),
    triageQueue.close(),
    copilotQueue.close(),
    flakeQueue.close(),
    bisectQueue.close(),
    analyzeSourceQueue.close(),
    exploreQueue.close(),
    preflightQueue.close(),
    suppressionQueue.close(),
    verifyHealQueue.close(),
    mutantClosureQueue.close(),
  ]);
}
