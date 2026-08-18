/**
 * Build bisect — the worker half.
 *
 * The judgement lives in apps/api/src/lib/bisect.ts: which commit is suspect,
 * whether the test is steady enough to bisect at all, where to probe next. This
 * file does the parts that need a database and a queue, and nothing else. It is
 * written that way on purpose — the decision to accuse a commit has to be the
 * same code the API's tests exercise, not a second copy of it that drifted.
 *
 * ── One step per job ────────────────────────────────────────────────────────
 * A bisect is almost entirely waiting. A probe means creating a real Run and
 * letting the real run queue execute it, which takes as long as the test takes.
 * So a tick does at most one thing and then re-enqueues itself with a delay:
 *
 *   read history → decide → (queue a probe | conclude) → maybe re-enqueue
 *
 * Nothing is held in memory between ticks. Every tick re-derives the whole state
 * from two durable sources, which is what makes a worker restart mid-bisect a
 * non-event:
 *
 *   • the probe runs, tagged `bisect:<testId>:<bisectId>` on `triggeredBy`
 *   • the audit rows, which carry the plan and, at the end, the report
 *
 * That also means probe results are folded straight back into the history the
 * next tick analyses. The binary search state is not tracked — it is *implied*
 * by the timeline, because a probed commit stops being unknown. A retried tick
 * therefore resumes exactly where the last one stopped rather than starting a
 * second search alongside the first.
 *
 * ── Which way it fails ──────────────────────────────────────────────────────
 * Toward saying less. A probe whose repeats disagree turns that commit MIXED,
 * and the next tick's analysis refuses on it. A probe that cannot be reached, a
 * budget that runs out, a deadline that passes — all of them conclude with the
 * narrowed RANGE and no suspect. The one outcome this must never produce is a
 * commit sha with thin evidence behind it, because that sha becomes a name.
 */

import { maskDeep } from '@qaai/shared';
import {
  BISECT_AUDIT_ACTIONS,
  BISECT_AUDIT_TARGET,
  DEFAULT_DEADLINE_MINUTES,
  BISECT_TICK_DELAY_MS,
  MAX_BISECT_TICKS,
  MAX_TIMELINE_RUNS,
  DEFAULT_WINDOW_DAYS,
  analyzeHistory,
  bisectTag,
  nextProbe,
  parseBisectTag,
  shortSha,
  timelineForReport,
  type BisectJob,
  type BisectReport,
  type BisectRunRow,
  type CommitNode,
  type HistoryAnalysis,
  type ProbePlan,
} from '../../../api/src/lib/bisect.js';
// One toll for every path that creates a Run: the plan gate and the usage
// counter. It lives in the API workspace and takes its Prisma client as an
// argument so this file can call the same implementation POST /runs does.
import { startRun } from '../../../api/src/lib/start-run.js';
import { logger, prisma } from '../context.js';
import { enqueueBisect, enqueueRun } from '../queues.js';

/** Runs that will never change again. Everything else is still in flight. */
const TERMINAL = new Set(['PASSED', 'FAILED', 'CANCELLED', 'ERRORED']);

const DEADLINE_MINUTES = Number(
  process.env.QAAI_BISECT_DEADLINE_MINUTES ?? DEFAULT_DEADLINE_MINUTES,
);

export async function processBisect(job: BisectJob): Promise<void> {
  const { orgId, bisectId, testId } = job;

  // Already over. A redelivered tick, or a second one racing the conclusion.
  if (await concluded(orgId, bisectId)) return;

  const test = await prisma.test.findFirst({
    where: { id: testId, orgId, projectId: job.projectId },
    select: { id: true, name: true },
  });
  if (!test) {
    await conclude(job, refusal(job, 'The test was deleted while the bisect was running.'));
    return;
  }

  const rows = await loadHistory(job);
  const analysis = analyzeHistory(rows, { bisectId });
  const probes = probeState(rows, bisectId);
  // Never claim probes that did not happen. A tick can reach the deadline branch
  // before it ever queued one.
  const source: BisectReport['source'] = probes.runIds.length > 0 ? 'history+probes' : 'history';

  /*
   * Phase 1 settled it. On the first tick that means the answer was already in
   * the recorded results and nothing ran; on a later tick it means the probes
   * folded back into the history and closed the gap — including the case where
   * a probe's repeats disagreed, which turns that commit MIXED and makes the
   * analysis refuse. Either way the report has to say which, so `source` is
   * taken from whether any probe run exists, not from which tick this is.
   */
  if (analysis.status !== 'NEEDS_PROBES') {
    const stored = await readStoredPlan(job);
    await conclude(
      job,
      report(job, analysis, {
        source,
        probeRunIds: probes.runIds,
        ...(stored ? { plan: stored } : {}),
      }),
    );
    return;
  }

  const plan = await readOrWritePlan(job, analysis);

  // ── Deadline and tick ceiling ─────────────────────────────────────────────
  const requestedAt = Date.parse(job.requestedAt);
  const expired =
    Number.isFinite(requestedAt) && Date.now() - requestedAt > DEADLINE_MINUTES * 60_000;
  if (expired || job.step >= MAX_BISECT_TICKS) {
    // Stop the work too. A cancelled investigation must not leave probe runs
    // behind that execute an hour after its report was written.
    await cancelInFlight(job, probes.inFlightRunIds);
    await conclude(
      job,
      report(job, analysis, {
        source,
        status: 'INCONCLUSIVE',
        summary:
          `The search ran out of time after ${DEADLINE_MINUTES} minutes with ` +
          `${probes.probedCommits.size} of ${plan.budget} probes done. ` +
          rangeSentence(analysis) +
          ' Its remaining probe runs were cancelled.',
        probeRunIds: probes.runIds,
        plan,
      }),
    );
    return;
  }

  // ── Something is still executing: come back later ─────────────────────────
  if (probes.inFlightRunIds.length > 0) {
    await enqueueBisect({ ...job, step: job.step + 1 }, BISECT_TICK_DELAY_MS);
    return;
  }

  // ── Budget ────────────────────────────────────────────────────────────────
  if (probes.probedCommits.size >= plan.budget) {
    await conclude(
      job,
      report(job, analysis, {
        source,
        status: 'INCONCLUSIVE',
        summary:
          `The ${plan.budget}-probe budget is spent. ` +
          rangeSentence(analysis) +
          ' Re-running it against more commits would need a wider budget, not a better guess.',
        probeRunIds: probes.runIds,
        plan,
      }),
    );
    return;
  }

  // ── Choose the next commit ────────────────────────────────────────────────
  const candidates = analysis.boundary.unknown;
  const reachable = candidates.map((node) => canProbe(node, probes.probedCommits));
  const step = nextProbe({ greenAt: -1, redAt: candidates.length }, reachable);

  if (step.kind !== 'probe') {
    /*
     * `converged` cannot happen here — analyzeHistory returns ANSWERED the
     * moment the gap is empty, and this line is only reached while it is not —
     * so both non-probe outcomes mean the same thing in practice: the search
     * cannot take another step. It is reported as a range either way rather than
     * asserted away, because the alternative to a wrong branch here is a bisect
     * that stops without saying anything.
     */
    await conclude(
      job,
      report(job, analysis, {
        source,
        status: 'INCONCLUSIVE',
        summary:
          'No commit left in the range can be re-run: each one either was never deployed to a ' +
          'URL QAAI recorded, or was probed and produced no usable result. ' +
          rangeSentence(analysis),
        probeRunIds: probes.runIds,
        plan,
      }),
    );
    return;
  }

  const target = candidates[step.index]!;
  const probe = await queueProbe(job, target, plan);
  if (probe.queued === 0) {
    await conclude(
      job,
      report(job, analysis, {
        source,
        status: 'INCONCLUSIVE',
        summary: probe.refused
          ? // Named rather than folded into "could not be queued": one of these
            // is an outage and the other is a bill, and telling them apart is
            // the difference between filing a ticket and clicking Upgrade.
            `${probe.refused} The search stopped at ${shortSha(target.commitSha)} without probing it. ` +
            rangeSentence(analysis)
          : `The probe at ${shortSha(target.commitSha)} could not be queued, so the search stopped ` +
            `where it was. ` +
            rangeSentence(analysis),
        probeRunIds: probes.runIds,
        plan,
      }),
    );
    return;
  }

  logger.info(
    {
      bisectId,
      testId,
      commit: target.commitSha,
      runs: probe.queued,
      probe: probes.probedCommits.size + 1,
      budget: plan.budget,
    },
    'queued a bisect probe',
  );
  await enqueueBisect({ ...job, step: job.step + 1 }, BISECT_TICK_DELAY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every run of the project in the window, with this test's result attached.
 *
 * Runs that never executed this test are included on purpose. They are the only
 * record that a commit existed at all, and — through `baseUrlOverride` — the only
 * record of a URL that serves it, which is what decides whether it can be probed.
 */
async function loadHistory(job: BisectJob): Promise<BisectRunRow[]> {
  const { orgId, projectId, testId } = job;

  const [from, to] = await Promise.all([
    job.fromRunId
      ? prisma.run.findFirst({
          where: { id: job.fromRunId, orgId, projectId },
          select: { queuedAt: true },
        })
      : null,
    job.toRunId
      ? prisma.run.findFirst({
          where: { id: job.toRunId, orgId, projectId },
          select: { queuedAt: true },
        })
      : null,
  ]);

  // An unknown run id narrows nothing rather than throwing: the report says
  // which window was used, and a wrong window is visible in the timeline.
  const gte = from?.queuedAt ?? new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000);
  const lte = to?.queuedAt ?? undefined;

  const runs = await prisma.run.findMany({
    where: { orgId, projectId, queuedAt: { gte, ...(lte ? { lte } : {}) } },
    // Newest first with a `take`, so the ceiling drops the OLDEST runs. Dropping
    // recent ones would hide the red side, which is the half we need most.
    orderBy: { queuedAt: 'desc' },
    take: MAX_TIMELINE_RUNS,
    select: {
      id: true,
      commitSha: true,
      status: true,
      triggeredBy: true,
      queuedAt: true,
      environmentId: true,
      baseUrlOverride: true,
      results: {
        where: { testId },
        select: { status: true, retriedAndPassed: true },
        take: 1,
      },
    },
  });

  return runs.map((run) => ({
    runId: run.id,
    commitSha: run.commitSha,
    runStatus: run.status,
    triggeredBy: run.triggeredBy,
    queuedAt: run.queuedAt,
    environmentId: run.environmentId,
    baseUrlOverride: run.baseUrlOverride,
    result: run.results[0]
      ? { status: run.results[0].status, retriedAndPassed: run.results[0].retriedAndPassed }
      : null,
  }));
}

interface ProbeState {
  /** Commits this investigation has already spent a probe on. */
  probedCommits: Set<string>;
  runIds: string[];
  inFlightRunIds: string[];
}

function probeState(rows: readonly BisectRunRow[], bisectId: string): ProbeState {
  const probedCommits = new Set<string>();
  const runIds: string[] = [];
  const inFlightRunIds: string[] = [];

  for (const row of rows) {
    const tag = parseBisectTag(row.triggeredBy);
    if (!tag || tag.bisectId !== bisectId) continue;
    runIds.push(row.runId);
    if (row.commitSha) probedCommits.add(row.commitSha);
    if (!TERMINAL.has(row.runStatus)) inFlightRunIds.push(row.runId);
  }

  return { probedCommits, runIds, inFlightRunIds };
}

/**
 * Can this commit still be probed?
 *
 * Two conditions, and the second is the one that stops an infinite search: a
 * commit we already spent a probe on but which STILL has no verdict (every run
 * errored, or was cancelled) is not going to acquire one by being probed again
 * with the same budget. Excluding it lets the search move on, or run out of
 * reachable commits and say so.
 */
function canProbe(node: CommitNode, probedCommits: ReadonlySet<string>): boolean {
  if (node.pinnedBaseUrl === null) return false;
  return !probedCommits.has(node.commitSha);
}

// ─────────────────────────────────────────────────────────────────────────────
// Probing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue `plan.repeats` runs of the one test at one commit.
 *
 * `baseUrlOverride` is the whole point. QAAI does not build commits — it runs
 * tests against a URL — so a probe is only meaningful against a URL that serves
 * this commit and nothing else. `analyzeHistory` has already refused to plan a
 * probe at a commit with no such URL; this asserts it again rather than trusting
 * the caller, because the failure mode is a run labelled with a commit sha it
 * never actually tested.
 *
 * A probe is `plan.repeats` real runs, and a bisect can be dozens of probes, so
 * this was the single largest way an org could spend browsers it had not paid
 * for — it created Runs directly and neither asked the plan nor counted them.
 * It asks now, in `advisory` mode: a bisect tick that threw would take the whole
 * investigation down into the queue's failed set with nothing written, whereas a
 * refusal is something the report can say out loud.
 *
 * @returns how many runs were queued, and — if the plan cut the probe short —
 * why, so the caller can put the reason in the conclusion rather than reporting
 * a mysterious "could not be queued". 0 queued means the probe did not happen.
 */
async function queueProbe(
  job: BisectJob,
  node: CommitNode,
  plan: ProbePlan,
): Promise<{ queued: number; refused?: string }> {
  if (!node.pinnedBaseUrl || !node.environmentId) return { queued: 0 };

  const { orgId, projectId, testId, bisectId } = job;
  let queued = 0;

  for (let i = 0; i < plan.repeats; i++) {
    const started = await startRun({
      db: prisma,
      orgId,
      mode: 'advisory',
      data: {
        orgId,
        projectId,
        environmentId: node.environmentId,
        trigger: 'MANUAL',
        triggeredBy: bisectTag(testId, bisectId),
        commitSha: node.commitSha,
        baseUrlOverride: node.pinnedBaseUrl,
        totalCount: 1,
        // The placeholder result is how the run processor learns which test to
        // execute, and it is what keeps the counts honest if the run dies first.
        results: { create: [{ orgId, testId, status: 'SKIPPED' as const }] },
      },
    });

    if (!started.created) {
      // Stop here rather than hammering the same refusal `repeats` times. What
      // was queued already stands: a short probe is a probe with fewer samples,
      // which the next tick's analysis handles the same way it handles a run
      // that errored.
      logger.warn(
        { bisectId, orgId, commit: node.commitSha, queued, of: plan.repeats },
        'bisect probe cut short: the org is at its monthly run limit',
      );
      return { queued, refused: started.quota.reason ?? 'This org is at its monthly run limit.' };
    }
    const run = started.run;

    try {
      await enqueueRun({ orgId, runId: run.id }, { background: true });
      queued += 1;
    } catch (err) {
      // A run row with no job would keep this tick waiting on it until the
      // deadline. Kill it now so it counts as a discarded sample instead.
      await prisma.run
        .update({
          where: { id: run.id },
          data: {
            status: 'ERRORED',
            finishedAt: new Date(),
            errorMessage: 'The bisect probe run could not be queued.',
          },
        })
        .catch(() => {});
      logger.error({ err, bisectId, runId: run.id }, 'could not queue a bisect probe run');
    }
  }

  return { queued };
}

async function cancelInFlight(job: BisectJob, runIds: readonly string[]): Promise<void> {
  if (runIds.length === 0) return;
  await prisma.run
    .updateMany({
      where: { id: { in: [...runIds] }, orgId: job.orgId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    })
    .catch((err) => logger.error({ err, bisectId: job.bisectId }, 'could not cancel probe runs'));
}

// ─────────────────────────────────────────────────────────────────────────────
// The durable record
// ─────────────────────────────────────────────────────────────────────────────

async function concluded(orgId: string, bisectId: string): Promise<boolean> {
  const row = await prisma.auditLog.findFirst({
    where: {
      orgId,
      targetType: BISECT_AUDIT_TARGET,
      targetId: bisectId,
      action: BISECT_AUDIT_ACTIONS.concluded,
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The plan, written once and read back on every later tick.
 *
 * The budget and the repeats MUST NOT be recomputed per tick. Both are derived
 * from the size of the unknown range, and that range shrinks with every probe —
 * so a recomputed budget would grow a little more room each time it was checked,
 * and the bound would never bind.
 */
async function readStoredPlan(job: BisectJob): Promise<ProbePlan | null> {
  const existing = await prisma.auditLog.findFirst({
    where: {
      orgId: job.orgId,
      targetType: BISECT_AUDIT_TARGET,
      targetId: job.bisectId,
      action: BISECT_AUDIT_ACTIONS.planned,
    },
    orderBy: { createdAt: 'asc' },
    select: { metadata: true },
  });
  return readPlan(existing?.metadata);
}

async function readOrWritePlan(job: BisectJob, analysis: HistoryAnalysis): Promise<ProbePlan> {
  const stored = await readStoredPlan(job);
  if (stored) return stored;

  const plan = analysis.plan!;
  await writeAudit(job, BISECT_AUDIT_ACTIONS.planned, {
    bisectId: job.bisectId,
    testId: job.testId,
    projectId: job.projectId,
    plan,
    // Why probes are needed at all, so the plan row reads on its own.
    reason: analysis.summary,
  });
  return plan;
}

/** Defensive: the column is Json, so nothing about its shape is guaranteed. */
function readPlan(metadata: unknown): ProbePlan | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const plan = (metadata as { plan?: unknown }).plan;
  if (!plan || typeof plan !== 'object') return null;
  const p = plan as Partial<ProbePlan>;
  if (typeof p.budget !== 'number' || typeof p.repeats !== 'number') return null;
  if (!Array.isArray(p.candidates)) return null;
  return {
    candidates: p.candidates,
    fullBudget: typeof p.fullBudget === 'number' ? p.fullBudget : p.budget,
    budget: p.budget,
    repeats: p.repeats,
    repeatsReason: typeof p.repeatsReason === 'string' ? p.repeatsReason : '',
  };
}

async function writeAudit(
  job: BisectJob,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Widened to `object` for the Json column, exactly as apps/api/src/lib/audit.ts
  // does. Masking first is not optional: a report embeds run ids and commit
  // shas, and a future field could embed a URL with a token in it.
  const masked: object = maskDeep(metadata);

  try {
    await prisma.auditLog.create({
      data: {
        orgId: job.orgId,
        userId: job.requestedBy || null,
        action,
        targetType: BISECT_AUDIT_TARGET,
        targetId: job.bisectId,
        metadata: masked,
      },
    });
  } catch (err) {
    // Loud, but never fatal. The alternative — throwing — would retry the tick
    // and queue a second set of probe runs for the same commit.
    logger.error({ err, bisectId: job.bisectId, action }, 'bisect audit write failed');
  }
}

async function conclude(job: BisectJob, result: BisectReport): Promise<void> {
  await writeAudit(job, BISECT_AUDIT_ACTIONS.concluded, {
    bisectId: job.bisectId,
    testId: job.testId,
    projectId: job.projectId,
    report: result,
  });
  logger.info(
    {
      bisectId: job.bisectId,
      testId: job.testId,
      status: result.status,
      suspect: result.suspectCommit,
      confidence: result.confidence,
      probes: result.probes.used,
    },
    'bisect concluded',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

function rangeSentence(analysis: HistoryAnalysis): string {
  const { lastGreen, firstRed, unknown } = analysis.boundary;
  if (!lastGreen || !firstRed) return 'No range was established.';
  return (
    `The break is somewhere in the ${unknown.length + 1} commits from ` +
    `${shortSha(unknown[0]?.commitSha ?? firstRed.commitSha)} through ` +
    `${shortSha(firstRed.commitSha)} — the test passed at ${shortSha(lastGreen.commitSha)} and ` +
    `fails at ${shortSha(firstRed.commitSha)}. That range is the answer; no single commit is accused.`
  );
}

interface ReportOverrides {
  source: BisectReport['source'];
  status?: BisectReport['status'];
  summary?: string;
  probeRunIds?: string[];
  /**
   * The plan as it was WRITTEN, not as this tick would recompute it. The range
   * shrinks with every probe, so a recomputed budget reads smaller than the one
   * actually spent and the report would understate its own cost.
   */
  plan?: ProbePlan;
}

function report(job: BisectJob, analysis: HistoryAnalysis, over: ReportOverrides): BisectReport {
  const status = over.status ?? analysis.status;
  const commits = analysis.timeline.commits;
  const probedCommits = commits.filter((c) => c.probed);
  // A probe whose repeats disagreed. It stops the search, and it is the single
  // most important number in the report: it means the test moved under us.
  const ambiguous = probedCommits.filter((c) => c.verdict === 'MIXED').length;

  const caveats = [...analysis.caveats];
  if (over.status === 'INCONCLUSIVE' && analysis.status !== 'INCONCLUSIVE') {
    caveats.push(
      'The search was stopped before it converged, so the range below has not been narrowed as ' +
        'far as the evidence could take it.',
    );
  }
  if (ambiguous > 0) {
    caveats.push(
      `${ambiguous} probe${ambiguous === 1 ? '' : 's'} produced both a pass and a failure at one ` +
        'commit. That is the test moving under the search, not a commit boundary.',
    );
  }

  const suspect = status === 'ANSWERED' ? analysis.suspect : null;

  return {
    bisectId: job.bisectId,
    testId: job.testId,
    status,
    suspectCommit: suspect?.commitSha ?? null,
    lastGoodCommit: analysis.lastGood?.commitSha ?? null,
    confidence: status === 'ANSWERED' ? analysis.confidence : 'none',
    summary: over.summary ?? analysis.summary,
    source: over.source,
    flake: analysis.flake,
    probes: {
      budget: over.plan?.budget ?? analysis.plan?.budget ?? 0,
      used: probedCommits.length,
      repeats: over.plan?.repeats ?? analysis.plan?.repeats ?? 0,
      ambiguous,
      runIds: over.probeRunIds ?? [],
    },
    boundary: {
      lastGreen: analysis.boundary.lastGreen?.commitSha ?? null,
      firstRed: analysis.boundary.firstRed?.commitSha ?? null,
      unknownBetween: analysis.boundary.unknown.length,
      priorRegressions: analysis.boundary.priorRegressions,
    },
    timeline: timelineForReport(commits),
    caveats,
  };
}

/** A refusal that has no history behind it — the test vanished mid-flight. */
function refusal(job: BisectJob, summary: string): BisectReport {
  return {
    bisectId: job.bisectId,
    testId: job.testId,
    status: 'REFUSED',
    suspectCommit: null,
    lastGoodCommit: null,
    confidence: 'none',
    summary,
    source: 'history',
    flake: {
      repeatedCommits: 0,
      disagreeingCommits: 0,
      ratePercent: 0,
      measured: false,
      usableSamples: 0,
    },
    probes: { budget: 0, used: 0, repeats: 0, ambiguous: 0, runIds: [] },
    boundary: { lastGreen: null, firstRed: null, unknownBetween: 0, priorRegressions: 0 },
    timeline: [],
    caveats: [],
  };
}
