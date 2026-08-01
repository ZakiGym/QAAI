/**
 * Check runs — the worker half (§7).
 *
 * The judgement lives in apps/api/src/lib/github-app.ts: what the check says,
 * which conclusion it draws, which line an annotation points at. This file does
 * the parts that need a database and a queue, and nothing else — the same split
 * bisect uses, and for the same reason: the sentence a reviewer reads in the
 * merge box has to be produced by the code the API's tests exercise, not by a
 * second copy of it that drifted.
 *
 * ── The lifecycle ───────────────────────────────────────────────────────────
 *   started   → create the check in_progress, so the PR shows QAAI working
 *   completed → conclude it with the triage verdicts and annotations on the
 *               failing lines, plus a button that re-runs the suite
 *
 * ── The sweep, and why it exists ────────────────────────────────────────────
 * The natural place to enqueue those two phases is the run processor: one line
 * where a run starts, one where it finalises. `apps/worker/src/processors/run.ts`
 * is not this change's file. Rather than ship a feature that does nothing until
 * someone else edits their file, a repeatable tick finds PR runs on
 * app-installed repos and enqueues the phases itself — the same shape as the
 * flake and schedule sweeps that already run here. When run.ts does enqueue
 * directly, the sweep finds nothing left to do and becomes redundant rather
 * than wrong.
 *
 * ── Which way this fails ────────────────────────────────────────────────────
 * Toward reporting. A missing app is a SKIP with a sentence naming what to
 * configure, never a failed job. A lost cache entry costs one API call, not a
 * duplicate check. An annotation that cannot be placed is dropped while the
 * failure it describes stays in the summary. What must never happen is a run
 * that produced findings and reported none of them, so every "give up" path
 * here logs the reason at a level someone will see.
 */

import { Queue } from 'bullmq';
import {
  CHECKS_QUEUE,
  CHECK_STATE_TTL_SECONDS,
  GithubAppError,
  buildAnnotations,
  buildCheckOutput,
  checkStateKey,
  chunkAnnotations,
  conclusionFor,
  createCheckRun,
  findCheckRun,
  forgetInstallation,
  installationToken,
  loadAppConfig,
  updateCheckRun,
  type AppConfig,
  type CheckEvidence,
  type CheckFailure,
  type ChecksJob,
} from '../../../api/src/lib/github-app.js';
import { connection, logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';

// ─── Producers ───────────────────────────────────────────────────────────────

const checksQueue = new Queue(CHECKS_QUEUE, { connection });

export async function enqueueCheck(job: ChecksJob, delayMs = 0): Promise<void> {
  await checksQueue.add(CHECKS_QUEUE, job, {
    // One job per run per phase: a redelivered webhook or an overlapping sweep
    // must not put two check runs on the same pull request.
    jobId: `check-${job.runId}-${job.phase}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    ...(delayMs > 0 ? { delay: delayMs } : {}),
  });
}

/**
 * Arm the sweep. A BullMQ repeatable job survives restarts and de-duplicates by
 * key, so calling this on every boot is safe and means the sweep exists as long
 * as a worker does.
 */
export async function armCheckSweep(): Promise<void> {
  await checksQueue.add(
    'sweep',
    { orgId: '', runId: '', phase: 'sweep' } satisfies ChecksJob,
    {
      repeat: { every: 60_000 },
      jobId: 'qaai-check-sweep',
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Read once. The private key is unsealed from the vault on first use and held
 * in memory for the life of the process — it is needed for every JWT, and
 * re-unsealing it per job means more code paths touching the plaintext, not
 * fewer.
 *
 * `undefined` means "not looked at yet", `null` means "no app configured", which
 * is a supported state and not an error: without an app the PR comment posted by
 * apps/worker/src/processors/notify.ts is still the feedback, exactly as before.
 */
let cachedConfig: AppConfig | null | undefined;

function appConfig(): AppConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    cachedConfig = loadAppConfig(openSecret);
  } catch (err) {
    // Half-configured. A missing credential is a skip with an actionable
    // sentence, never a failed job — but it is logged at error, because a check
    // that silently never appears reads to a reviewer as a green build.
    cachedConfig = null;
    logger.error(
      { reason: err instanceof Error ? err.message : 'unknown' },
      'the GitHub App is half-configured; PR checks are disabled and QAAI will keep posting PR comments instead',
    );
  }
  return cachedConfig;
}

// ─── Where the check run id is remembered ────────────────────────────────────

interface CheckState {
  id: number;
  /** True once the check has been concluded; stops the sweep re-reporting it. */
  done: boolean;
}

/**
 * Redis, not a column, because `Run` is not this change's to alter — and it is
 * treated as the cache it is. Every read that misses falls back to asking GitHub
 * for the check run whose `external_id` is this run's id, so an evicted key
 * costs one API call rather than a second check on somebody's pull request.
 */
async function readState(runId: string): Promise<CheckState | null> {
  try {
    const raw = await connection.get(checkStateKey(runId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckState>;
    return typeof parsed.id === 'number' ? { id: parsed.id, done: parsed.done === true } : null;
  } catch {
    // A cache that cannot be read is a cache miss, never an error: losing the
    // report is the one outcome that is not acceptable.
    return null;
  }
}

async function writeState(runId: string, state: CheckState): Promise<void> {
  try {
    await connection.set(
      checkStateKey(runId),
      JSON.stringify(state),
      'EX',
      CHECK_STATE_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err, runId }, 'could not cache the check run id; the next update will re-find it');
  }
}

// ─── Reading the run ─────────────────────────────────────────────────────────

/** A run in one of these has nothing left to report; anything else is still moving. */
const TERMINAL = new Set(['PASSED', 'FAILED', 'CANCELLED', 'ERRORED']);

/**
 * Everything a check needs, in one read.
 *
 * `Test.code` comes along because it is what turns a stack trace into a line
 * number when the trace names a workspace that no longer exists — see
 * `annotationLine`. It is fetched only for the tests that actually failed.
 */
async function loadRun(orgId: string, runId: string) {
  return prisma.run.findFirst({
    where: { id: runId, orgId },
    select: {
      id: true,
      status: true,
      commitSha: true,
      prNumber: true,
      passedCount: true,
      failedCount: true,
      flakyCount: true,
      totalCount: true,
      errorMessage: true,
      gateResult: true,
      startedAt: true,
      finishedAt: true,
      project: { select: { id: true, repoFullName: true, repoInstallationId: true } },
      environment: { select: { name: true, kind: true } },
      results: {
        where: { status: { in: ['FAILED', 'TIMED_OUT'] } },
        select: {
          status: true,
          errorMessage: true,
          test: { select: { id: true, name: true, filePath: true, code: true } },
          verdict: { select: { verdict: true, confidence: true, explanation: true } },
          steps: {
            where: { status: 'FAILED' },
            orderBy: { index: 'asc' },
            take: 1,
            select: {
              index: true,
              title: true,
              selector: true,
              expected: true,
              actual: true,
              errorMessage: true,
              errorStack: true,
            },
          },
        },
      },
    },
  });
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

async function buildEvidence(orgId: string, run: LoadedRun): Promise<CheckEvidence> {
  const testIds = run.results.map((r) => r.test.id);

  /*
   * "…with a fix proposed" has to be earned.
   *
   * The claim is only made when a heal actually exists and is still waiting for
   * a decision — an already-rejected proposal is not a fix on offer, and telling
   * a reviewer there is one they can take costs them the trip to find out there
   * is not.
   */
  const healedTestIds = new Set<string>();
  if (testIds.length > 0) {
    const heals = await prisma.healProposal.findMany({
      where: { orgId, testId: { in: testIds }, state: 'PROPOSED' },
      select: { testId: true },
    });
    for (const heal of heals) healedTestIds.add(heal.testId);
  }

  const failures: CheckFailure[] = run.results.map((r) => {
    const step = r.steps[0] ?? null;
    return {
      test: { name: r.test.name, filePath: r.test.filePath, code: r.test.code },
      status: r.status,
      errorMessage: r.errorMessage,
      step: step
        ? {
            index: step.index,
            title: step.title,
            selector: step.selector,
            expected: step.expected,
            actual: step.actual,
            errorMessage: step.errorMessage,
            errorStack: step.errorStack,
          }
        : null,
      verdict: r.verdict
        ? {
            verdict: r.verdict.verdict,
            confidence: r.verdict.confidence,
            explanation: r.verdict.explanation,
          }
        : null,
      fixProposed: healedTestIds.has(r.test.id),
    };
  });

  const gate = (run.gateResult ?? null) as { passed?: boolean } | null;

  return {
    run: {
      id: run.id,
      status: run.status,
      commitSha: run.commitSha ?? '',
      prNumber: run.prNumber,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      flakyCount: run.flakyCount,
      totalCount: run.totalCount,
      errorMessage: run.errorMessage,
      gateBlocking: gate?.passed === false,
    },
    environment: run.environment,
    failures,
    webUrl: process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000',
  };
}

/**
 * Can this run reach GitHub as a check at all?
 *
 * Every "no" here is a skip with a reason, never a throw. A run on a repo where
 * the app is not installed is the normal case for most customers, and it must
 * cost nothing.
 */
function checkTarget(
  run: LoadedRun,
): { repo: string; installationId: string; headSha: string } | null {
  const repo = run.project.repoFullName;
  const installationId = run.project.repoInstallationId;
  if (!repo || !installationId || !run.commitSha) return null;
  return { repo, installationId, headSha: run.commitSha };
}

// ─── Phases ──────────────────────────────────────────────────────────────────

const detailsUrl = (runId: string) =>
  `${process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000'}/runs/${runId}`;

/**
 * A GitHub failure that means "stop asking".
 *
 * 401 and 404 on an installation are configuration, not weather: retrying them
 * burns the queue's backoff and never succeeds. The installation id is dropped
 * from the token cache so a re-install is picked up without a restart.
 */
function isPermanent(err: unknown): boolean {
  return err instanceof GithubAppError && err.kind !== 'PROVIDER';
}

async function tokenFor(cfg: AppConfig, installationId: string): Promise<string> {
  try {
    return await installationToken(cfg, installationId);
  } catch (err) {
    if (isPermanent(err)) forgetInstallation(cfg.appId, installationId);
    throw err;
  }
}

async function phaseStarted(cfg: AppConfig, job: ChecksJob): Promise<void> {
  const run = await loadRun(job.orgId, job.runId);
  if (!run) return;

  const target = checkTarget(run);
  if (!target) return;

  // Already concluded by the time this job ran — a short suite beats the queue
  // often enough that this is the common case, not an edge one. Go straight to
  // the real report rather than posting an in_progress check nobody will see.
  if (TERMINAL.has(run.status)) {
    await enqueueCheck({ ...job, phase: 'completed' });
    return;
  }

  const existing = await readState(run.id);
  if (existing) return;

  const token = await tokenFor(cfg, target.installationId);

  // Ask GitHub before creating: a lost cache entry must not cost a duplicate
  // check on someone's pull request.
  const found = await findCheckRun(token, target.repo, target.headSha, run.id);
  if (found) {
    await writeState(run.id, { id: found.id, done: false });
    return;
  }

  const created = await createCheckRun(token, target.repo, {
    headSha: target.headSha,
    externalId: run.id,
    detailsUrl: detailsUrl(run.id),
    status: 'in_progress',
    startedAt: (run.startedAt ?? new Date()).toISOString(),
    output: {
      title: `Running ${run.totalCount} test(s)`,
      summary: `QAAI is running this suite against ${run.environment?.name ?? 'the target environment'}.\n\n[Watch it in QAAI](${detailsUrl(run.id)})`,
      text: '',
    },
  });

  await writeState(run.id, { id: created.id, done: false });
  logger.info({ runId: run.id, repo: target.repo, checkRunId: created.id }, 'check run created');
}

async function phaseCompleted(cfg: AppConfig, job: ChecksJob): Promise<void> {
  const run = await loadRun(job.orgId, job.runId);
  if (!run) return;

  const target = checkTarget(run);
  if (!target) return;

  if (!TERMINAL.has(run.status)) {
    // The run is still going. Come back rather than concluding early: a check
    // that says "failed" about a run still on its first test is worse than a
    // check that is late.
    await enqueueCheck({ ...job, phase: 'completed' }, 30_000);
    return;
  }

  const evidence = await buildEvidence(job.orgId, run);
  const output = buildCheckOutput(evidence);
  const annotations = buildAnnotations(evidence);
  const [firstBatch = [], ...rest] = chunkAnnotations(annotations);

  const token = await tokenFor(cfg, target.installationId);

  // The cache first, then GitHub. Either answer is the same check run; only the
  // cost differs, and neither is allowed to be "create a second one".
  const cached = await readState(run.id);
  const existingId =
    cached?.id ?? (await findCheckRun(token, target.repo, target.headSha, run.id))?.id ?? null;

  const params = {
    detailsUrl: detailsUrl(run.id),
    status: 'completed' as const,
    completedAt: (run.finishedAt ?? new Date()).toISOString(),
    conclusion: conclusionFor(evidence),
    output: { ...output, annotations: firstBatch },
    // The button. A reviewer who thinks a failure is a flake can settle it from
    // the merge box instead of finding whoever knows how to re-run CI.
    withRerunAction: true,
  };

  const ref = existingId
    ? await updateCheckRun(token, target.repo, existingId, params)
    : await createCheckRun(token, target.repo, {
        ...params,
        headSha: target.headSha,
        externalId: run.id,
      });

  // GitHub takes 50 annotations per request; the rest ride on follow-up PATCHes
  // against the check run that now exists.
  for (const batch of rest) {
    await updateCheckRun(token, target.repo, ref.id, {
      status: 'completed',
      conclusion: params.conclusion,
      completedAt: params.completedAt,
      output: { ...output, annotations: batch },
    });
  }

  await writeState(run.id, { id: ref.id, done: true });
  logger.info(
    {
      runId: run.id,
      repo: target.repo,
      checkRunId: ref.id,
      conclusion: params.conclusion,
      annotations: annotations.length,
    },
    'check run completed',
  );
}

/**
 * The safety net: find PR runs that should have a check and give them one.
 *
 * Bounded on both ends — a two-hour window and a row cap — because this ticks
 * every minute forever and a sweep that grows with the runs table is a sweep
 * that eventually stops finishing. Runs older than the window have had their
 * chance; their check is still reachable through POST /github/checks/:runId.
 */
const SWEEP_WINDOW_MS = 2 * 3600_000;
const SWEEP_LIMIT = 100;

async function phaseSweep(): Promise<void> {
  const since = new Date(Date.now() - SWEEP_WINDOW_MS);

  const runs = await prisma.run.findMany({
    where: {
      queuedAt: { gt: since },
      prNumber: { not: null },
      commitSha: { not: null },
      project: { repoFullName: { not: null }, repoInstallationId: { not: null } },
    },
    orderBy: { queuedAt: 'desc' },
    take: SWEEP_LIMIT,
    select: { id: true, orgId: true, status: true },
  });

  for (const run of runs) {
    const state = await readState(run.id);
    if (state?.done) continue;

    const phase = TERMINAL.has(run.status) ? 'completed' : 'started';
    // Enqueue rather than act: the job id de-duplicates, so a sweep that
    // overlaps with a direct enqueue from run.ts collapses onto one job.
    await enqueueCheck({ orgId: run.orgId, runId: run.id, phase });
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function processChecks(job: ChecksJob): Promise<void> {
  const cfg = appConfig();
  if (!cfg) {
    // No app: nothing to do, and nothing is broken. The PAT comment path in
    // notify.ts is untouched and remains the PR feedback.
    return;
  }

  if (job.phase === 'sweep') {
    await phaseSweep();
    return;
  }

  if (!job.orgId || !job.runId) return;

  try {
    if (job.phase === 'started') await phaseStarted(cfg, job);
    else await phaseCompleted(cfg, job);
  } catch (err) {
    /*
     * A permanent failure is not retried, but it IS recorded.
     *
     * The app being uninstalled, the key not matching, Checks:write never
     * granted — every one of those makes the check silently absent, and absent
     * looks exactly like green. So it is logged at error with the sentence that
     * says what to fix, and the job stops rather than burning three attempts on
     * something that will never succeed.
     */
    if (isPermanent(err)) {
      logger.error(
        { runId: job.runId, phase: job.phase, reason: (err as GithubAppError).message },
        'the GitHub check could not be posted and will not be retried',
      );
      return;
    }
    throw err;
  }
}
