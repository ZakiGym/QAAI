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
 *               failing lines, plus a button that re-runs the suite, and then
 *               write the same verdict into ONE pull-request comment
 *
 * ── Why a comment as well as a check ────────────────────────────────────────
 * A check run is a coloured dot in the merge box and a page you have to click
 * through to. What a reviewer actually reads — in the timeline, in the email,
 * on their phone — is a comment: what failed, which tests by name, whether the
 * gate blocked, and where to look. So `completed` posts one, built from the
 * SAME `buildCheckOutput()` the check itself renders, because two descriptions
 * of one run are two chances to disagree about it.
 *
 * The comment obeys three rules, and they are the whole difference between a
 * bot people read and a bot people mute:
 *
 *   ONE per pull request. It is found by a hidden marker and EDITED in place;
 *   a new comment per push is why bots get muted. Editing sends no
 *   notification, so a re-run is quiet by construction.
 *
 *   Nothing to say, nothing said. A clean run on a PR that has no comment yet
 *   posts none at all — the green tick is the report. A clean run on a PR that
 *   DOES have one still edits it, because a stale red comment above a green
 *   check is worse than either.
 *
 *   The comment never fails the check. It is posted after the check is
 *   concluded and its state written, so a missing `Pull requests: write`, a
 *   deleted comment or a rate limit costs the comment and never the verdict.
 *
 * ── The gate, re-scored ─────────────────────────────────────────────────────
 * `completed` also scores the quality gate AGAIN before it reports anything.
 * `Run.gateResult` is written by the run finaliser, which runs before triage —
 * so the rule every new project gets, `BLOCK_ON_VERDICT REAL_BUG`, was scored
 * at a moment when no verdict row existed, found no REAL_BUG verdicts, and came
 * back as a pass on a run with real failures. The merge box was green over a
 * broken build by construction. See the section above `rescoreRunGate` for what
 * the re-score may and may not do, and the sweep below for how it arrives after
 * triage rather than before it.
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
 * The sweep has a SECOND pass, and it is not about checks at all: it re-scores
 * the gate of a terminal run that has no check to post — no pull request, no
 * installation, no GitHub app configured in this deployment — because four of
 * the measurement rules are assembled only by the re-score and need no diff.
 * Without it a customer running the suite from their own CI through
 * packages/cli, which is the primary install, read "not measured" on a
 * `MIN_COVERAGE` rule on every run they would ever do. That pass needs no app,
 * so it runs before the GitHub half's configuration check. See
 * `sweepRescoreWithoutCheck` for what it costs and what it still does not reach.
 *
 * ── Which way this fails ────────────────────────────────────────────────────
 * Toward reporting. A missing app is a SKIP with a sentence naming what to
 * configure, never a failed job. A lost cache entry costs one API call, not a
 * duplicate check. An annotation that cannot be placed is dropped while the
 * failure it describes stays in the summary. What must never happen is a run
 * that produced findings and reported none of them, so every "give up" path
 * here logs the reason at a level someone will see.
 */

import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import {
  CHECKS_QUEUE,
  CHECK_STATE_TTL_SECONDS,
  GITHUB_API_HOST,
  GithubAppError,
  buildAnnotations,
  buildCheckOutput,
  checkStateKey,
  chunkAnnotations,
  conclusionFor,
  createCheckRun,
  describeFailure,
  findCheckRun,
  forgetInstallation,
  githubRepoSlug,
  installationToken,
  loadAppConfig,
  redactSecrets,
  updateCheckRun,
  type AppConfig,
  type CheckConclusion,
  type CheckEvidence,
  type CheckFailure,
  type CheckOutput,
  type ChecksJob,
} from '../../../api/src/lib/github-app.js';
/*
 * The one question "is this test's quarantine in force right now" is allowed to
 * be answered by, from the module that owns the rule (see its header). Reading
 * `Test.quarantined` raw here would keep honouring a quarantine that ran out —
 * an expired one suppresses nothing, so its failure has to gate again and has
 * to read as a plain failure in the merge box.
 */
import {
  DEFAULT_GATE_RULES,
  QUARANTINE_NAMES_SCANNED,
  evaluateGates,
  gateAwaitsTriage,
  quarantineHealthFrom,
  quarantineSuppresses,
  rescoreGate,
  runOutcome,
  untriagedBlockers,
  type GateInput,
} from '@qaai/runner';
/*
 * The impact analysis, imported rather than re-implemented. It maps a diff to
 * the routes it touches; `patchCoverage` joins those routes to the coverage
 * inventory. Both are pure functions over data this file reads, which is why a
 * worker may import them from the API package — `lib/impact.ts` pulls in
 * @qaai/shared and nothing else.
 */
import { analyzeImpact, patchCoverage, type PatchCoverageRow } from '../../../api/src/lib/impact.js';
/*
 * `parseNotRun` reads the typed not-run tag back off `TestResult.errorMessage`.
 * It is the only way to classify a row written before `TestResult.notRunKind`
 * existed, and the gate rules need the classification to keep a test nobody
 * could attempt out of a pass rate.
 */
import { parseNotRun } from '@qaai/shared';
import type {
  FindingKind,
  FindingSeverity,
  GateResult,
  GateRule,
  PerformanceMetric,
} from '@qaai/shared';
import { connection, logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';

// ─── Producers ───────────────────────────────────────────────────────────────

const checksQueue = new Queue(CHECKS_QUEUE, { connection });

export async function enqueueCheck(
  job: ChecksJob,
  delayMs = 0,
  /**
   * An extra component of the job id, for the one case that legitimately needs
   * the SAME phase to run twice on one run: the gate was re-scored after triage
   * and the check has to be re-reported.
   *
   * Without it the de-duplication below would swallow the second report — a
   * completed job keeps its id, so re-adding `check-<run>-completed` is a no-op
   * and the merge box would keep showing the pre-triage verdict forever. The
   * suffix is the gate's generation, so each generation re-reports exactly once
   * and a loop is impossible: a generation only exists because the gate changed.
   */
  jobKey?: string,
): Promise<void> {
  await checksQueue.add(CHECKS_QUEUE, job, {
    // One job per run per phase: a redelivered webhook or an overlapping sweep
    // must not put two check runs on the same pull request.
    jobId: `check-${job.runId}-${job.phase}${jobKey ? `-${jobKey}` : ''}`,
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
      /*
       * READ, not inferred.
       *
       * `suppressedFailuresIn` can subtract `failedCount` from the number of
       * FAILED/TIMED_OUT results it was handed, and that subtraction is exact
       * today — both numbers come off the same row. It is exact only because
       * the `results.where` below selects precisely the statuses the run
       * counters call failures. Add a status to that filter, or narrow it to a
       * shard, and the subtraction starts reporting a suppression count that
       * nothing suppressed, in a surface whose whole job is to be believed.
       * The column cannot drift that way, so the column is selected.
       */
      quarantinedFailedCount: true,
      /*
       * Selected for `runOutcome`, which the post-triage re-score has to call:
       * a gate that now blocks has to be able to write the run's status through
       * the ONE function allowed to answer "did this run pass", and that
       * function takes every counter. Leaving `skippedCount` out would mean
       * passing it a zero and letting the one source of truth be fed a number
       * that is not the row's.
       */
      skippedCount: true,
      totalCount: true,
      errorMessage: true,
      gateResult: true,
      startedAt: true,
      finishedAt: true,
      project: {
        select: {
          id: true,
          repoFullName: true,
          repoInstallationId: true,
          /*
           * The project's OWN rules, because the re-score must reach the same
           * verdict the finaliser would have reached with the verdicts in hand.
           * Scoring the re-run against `DEFAULT_GATE_RULES` would quietly
           * replace a customer's gate with ours.
           */
          gateRules: true,
          quarantineBudgetPercent: true,
        },
      },
      environment: { select: { name: true, kind: true } },
      results: {
        where: { status: { in: ['FAILED', 'TIMED_OUT'] } },
        select: {
          status: true,
          errorMessage: true,
          /*
           * `quarantined` AND `quarantineExpiresAt` travel together, always.
           * The flag alone is not the answer — expiry deliberately does not
           * clear it, so the reason survives — and a reader that takes the flag
           * on its own labels a failure "quarantined, so it did not fail this
           * check" when it did fail the check. Both columns go to
           * `quarantineSuppresses`, which is the only thing allowed to decide.
           */
          test: {
            select: {
              id: true,
              name: true,
              filePath: true,
              code: true,
              quarantined: true,
              quarantineExpiresAt: true,
            },
          },
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

async function buildEvidence(
  orgId: string,
  run: LoadedRun,
  /**
   * The gate as re-scored after triage, when it was. Passed in rather than
   * re-read off the row: the write and this read would otherwise be two
   * round-trips that can disagree, and the merge box has to show the verdict
   * this job just computed.
   */
  rescored?: GateResult | null,
  /** The run's status after the re-score, when the re-score changed it. */
  status?: string | null,
): Promise<CheckEvidence> {
  const testIds = run.results.map((r) => r.test.id);
  /*
   * One instant for the whole check, not one per failure. Two tests whose
   * quarantines expire inside the same millisecond must be labelled the same
   * way, and a per-row `new Date()` is a check that can disagree with itself.
   */
  const now = new Date();

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
      /*
       * Per failure, so the check can name WHICH test was suppressed instead of
       * printing a count and leaving a reviewer to guess. Always set — `false`
       * is an answer — because `gatingFailures` only trusts the per-failure
       * flags when at least one of them is true, and a producer that supplied
       * them for some rows and not others would hand it a half-truth.
       */
      quarantined: quarantineSuppresses(r.test, now),
    };
  });

  /*
   * The re-scored gate wins when there is one. `conclusionFor` keys the merge
   * box off `gateBlocking` before it looks at anything else, so this is the
   * line that makes a post-triage BLOCK actually hold a merge.
   */
  const gate = (rescored ?? run.gateResult ?? null) as { passed?: boolean } | null;

  return {
    run: {
      id: run.id,
      status: status ?? run.status,
      commitSha: run.commitSha ?? '',
      prNumber: run.prNumber,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      flakyCount: run.flakyCount,
      quarantinedFailedCount: run.quarantinedFailedCount,
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

// ─── The pull-request comment ────────────────────────────────────────────────

/**
 * How the one comment is found again.
 *
 * An HTML comment renders as nothing, survives an edit, and is matched exactly
 * rather than by guessing which comment "looks like ours" — a title match would
 * adopt a human's comment that happened to quote us, and editing a person's
 * comment is unforgivable. It is versioned so a future format change can decide
 * whether to adopt or replace the old one.
 */
export const PR_COMMENT_MARKER = '<!-- qaai:run-report:v1 -->';

/** GitHub's ceiling is 65536 characters; stop short of it and say so. */
const MAX_COMMENT_CHARS = 60_000;
/** Failing tests are worth expanding by default until the list is a wall. */
const FAILURES_SHOWN_EXPANDED = 5;
/** A cache miss walks the PR's comments. Bounded: 3 pages, oldest first. */
const COMMENT_SCAN_PAGES = 3;
const COMMENTS_PER_PAGE = 100;
const GITHUB_TIMEOUT_MS = 15_000;
/**
 * Long enough to outlive the pull request it belongs to in the normal case, so
 * the marker scan below runs about once per PR rather than once per push.
 */
const PR_COMMENT_TTL_SECONDS = 30 * 24 * 3600;

/*
 * There is deliberately no "turn the comment off" setting.
 *
 * One already exists and it is GitHub's: an installation that is not granted
 * `Pull requests: write` gets the check and no comment, which is exactly the
 * knob a team would want and is discoverable on the screen where they already
 * manage the app. A second switch in an environment variable would be a way to
 * make QAAI silent that nobody can see from GitHub.
 */

/** Per pull request, not per run: the comment outlives every individual run. */
const prCommentKey = (repo: string, prNumber: number) =>
  `qaai:check:comment:${repo.toLowerCase()}:${prNumber}`;

interface CommentState {
  id: number;
  /** Hash of the body we last wrote, so an unchanged report costs no request. */
  hash: string;
}

const hashOf = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32);

async function readCommentState(repo: string, prNumber: number): Promise<CommentState | null> {
  try {
    const raw = await connection.get(prCommentKey(repo, prNumber));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CommentState>;
    return typeof parsed.id === 'number' && typeof parsed.hash === 'string'
      ? { id: parsed.id, hash: parsed.hash }
      : null;
  } catch {
    // A cache that cannot be read is a cache miss. The marker scan below is the
    // fallback, and it is correct on its own — this only makes it rare.
    return null;
  }
}

async function writeCommentState(
  repo: string,
  prNumber: number,
  state: CommentState,
): Promise<void> {
  try {
    await connection.set(
      prCommentKey(repo, prNumber),
      JSON.stringify(state),
      'EX',
      PR_COMMENT_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ err, repo, pr: prNumber }, 'could not cache the PR comment id; the next run will re-find it by its marker');
  }
}

/**
 * Repos we have been told, in so many words, that we may not comment on.
 *
 * A 403 that is not a rate limit means the App was never granted
 * `Pull requests: write`, or the conversation is locked. Both are answered by a
 * human, not by a retry, so the pair is remembered for an hour: long enough to
 * stop every run on a busy repo re-asking and being refused, short enough that
 * accepting the permission starts working without a deploy. Keyed per REPO —
 * one locked conversation must not silence an entire installation.
 */
const commentRefusedUntil = new Map<string, number>();
const COMMENT_REFUSAL_MS = 3600_000;

const refusalKey = (installationId: string, repo: string) =>
  `${installationId}:${repo.toLowerCase()}`;

function commentingRefused(installationId: string, repo: string, nowMs = Date.now()): boolean {
  const until = commentRefusedUntil.get(refusalKey(installationId, repo));
  if (until === undefined) return false;
  if (until > nowMs) return true;
  commentRefusedUntil.delete(refusalKey(installationId, repo));
  return false;
}

/** Tests only: this map is process-global and would leak between cases. */
export function _resetCommentRefusals(): void {
  commentRefusedUntil.clear();
}

interface CommentReply {
  status: number;
  json: unknown;
  /** True when GitHub is throttling us — 429, or a 403 that is a rate limit. */
  rateLimited: boolean;
}

/**
 * One request to GitHub, under the rules every credential in this codebase
 * travels by.
 *
 * It was `commentRequest` and served the issue-comment API alone. The
 * post-triage gate re-score needs the pull request's changed FILES — patch
 * coverage has to know which routes a diff touches — and the choice there was
 * between a second hand-rolled fetch and one helper used by both. A second copy
 * of the credential rules is how one of them comes to relax a rule, so there is
 * one helper and the read path uses it too.
 *
 * This repeats `githubJson` from lib/github-app.ts — the host is a pinned
 * constant, a 3xx is an error rather than a hop that would re-send the
 * Authorization header, the request is bounded, the body is parsed defensively
 * and the token is never logged, put in a path, or included in an error. The
 * duplication is deliberate and temporary: that helper is module-private and
 * lib/github-app.ts is not this change's file. DELETE THIS the moment
 * `githubJson` is exported, and call it instead. A copy that relaxed one of
 * those rules is how an installation token leaves the building, so the rules
 * are repeated in full rather than approximated.
 */
async function githubRequest(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; token: string; body?: unknown },
): Promise<CommentReply> {
  if (!path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('//')) {
    throw new GithubAppError('Refusing to call GitHub with a malformed path.', 'CONFIG');
  }
  const url = `https://${GITHUB_API_HOST}${path}`;
  if (new URL(url).hostname !== GITHUB_API_HOST) {
    throw new GithubAppError('Refusing to send a GitHub credential off api.github.com.', 'CONFIG');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'qaai',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `did not answer within ${GITHUB_TIMEOUT_MS / 1000}s`
        : 'was unreachable';
    throw new GithubAppError(`GitHub ${reason}.`, 'PROVIDER');
  }

  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new GithubAppError(
      'GitHub answered with a redirect, and QAAI will not follow one while holding a credential.',
      'PROVIDER',
    );
  }

  let json: unknown = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  /*
   * A secondary rate limit answers 403, not 429, and looks exactly like "you
   * lack the permission" unless the headers are read. Getting this wrong in
   * either direction is expensive: treat throttling as a permission failure and
   * the repo goes quiet for an hour; treat a permission failure as throttling
   * and every run retries three times to be refused three times.
   */
  const remaining = response.headers.get('x-ratelimit-remaining');
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (remaining === '0' || response.headers.get('retry-after') !== null));

  return { status: response.status, json, rateLimited };
}

const field = (json: unknown, key: string): unknown =>
  json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;

/** Digits or refused: this is interpolated into a URL path. */
function pathNumber(value: number, what: string): string {
  if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new GithubAppError(`"${redactSecrets(String(value))}" is not a valid GitHub ${what}.`, 'CONFIG');
  }
  return String(value);
}

/** GitHub's own words for a refusal. Provider text is redacted before it is kept. */
function providerReason(json: unknown): string {
  const message = field(json, 'message');
  return typeof message === 'string' ? redactSecrets(message).slice(0, 200) : 'no reason given';
}

/**
 * A refusal that is about this REPOSITORY — the app was never granted
 * `Pull requests: write`, or the conversation is locked. Worth remembering, so
 * every push does not re-ask and get refused again.
 *
 * Deliberately not the same thing as a 404. A pull request that was deleted,
 * or a repository QAAI has been removed from, says nothing about whether the
 * next pull request can be commented on, and silencing a repo for an hour over
 * one vanished PR would be the bug this class exists to avoid.
 */
class CommentRefused extends GithubAppError {
  constructor(message: string) {
    super(message, 'CONFIG');
    this.name = 'CommentRefused';
  }
}

/**
 * A sentence naming what to change, for the comment specifically.
 *
 * `describeFailure` is reused for everything it gets right — timeouts, 5xx,
 * throttling — but its 403 says "the app needs Checks: write", which is the
 * correct advice for a check run and the wrong advice here. An operator acting
 * on it would re-accept a permission they already have and still see no
 * comment.
 */
function describeCommentFailure(status: number, what: string, json: unknown): string {
  const reason = providerReason(json);
  if (status === 403) {
    return `GitHub refused (403) while ${what}: ${reason}. The app needs the "Pull requests: write" permission — re-accept its permissions on the installation — or the conversation is locked.`;
  }
  if (status === 404) {
    return `GitHub returned 404 while ${what}: ${reason}. The pull request or the repository is gone, or the app is no longer installed on it.`;
  }
  if (status === 410) {
    return `GitHub returned 410 while ${what}: ${reason}. That conversation no longer exists.`;
  }
  return `${describeFailure(status, what)} (${reason})`;
}

/**
 * Turn a refused request into the right kind of error.
 *
 * Throttling and outages are weather and are re-thrown for the queue to retry;
 * a 403 that is not throttling is a permission a human has to grant, and is
 * remembered per repo; anything else is permanent for this pull request alone.
 */
function commentError(status: number, what: string, json: unknown, rateLimited: boolean): GithubAppError {
  const message = describeCommentFailure(status, what, json);
  if (status === 403 && !rateLimited) return new CommentRefused(message);
  return new GithubAppError(message, rateLimited || status >= 500 ? 'PROVIDER' : 'CONFIG');
}

/**
 * Walk the pull request's comments for our marker.
 *
 * Only on a cache miss — a new PR, an evicted key, a worker that has never seen
 * this repo. Bounded at three pages because an unbounded scan of a
 * thousand-comment thread on every run is its own outage, and because the
 * consequence of not finding it is one extra comment on a PR that already has
 * three hundred, which nobody will notice.
 */
async function findMarkedComment(
  token: string,
  repo: string,
  prNumber: number,
): Promise<{ id: number; body: string } | null> {
  const slug = githubRepoSlug(repo);
  const pr = pathNumber(prNumber, 'pull request number');

  for (let page = 1; page <= COMMENT_SCAN_PAGES; page += 1) {
    const { status, json, rateLimited } = await githubRequest(
      `/repos/${slug}/issues/${pr}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
      { method: 'GET', token },
    );

    if (status !== 200) {
      throw commentError(status, 'reading the pull request’s comments', json, rateLimited);
    }
    if (!Array.isArray(json)) return null;

    for (const entry of json) {
      const body = field(entry, 'body');
      const id = field(entry, 'id');
      if (typeof body !== 'string' || !body.includes(PR_COMMENT_MARKER)) continue;
      if (typeof id !== 'number' || !Number.isInteger(id)) continue;
      return { id, body };
    }

    // A short page is the last page.
    if (json.length < COMMENTS_PER_PAGE) return null;
  }
  return null;
}

async function createComment(
  token: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const slug = githubRepoSlug(repo);
  const pr = pathNumber(prNumber, 'pull request number');
  const { status, json, rateLimited } = await githubRequest(
    `/repos/${slug}/issues/${pr}/comments`,
    { method: 'POST', token, body: { body } },
  );

  if (status !== 201) {
    throw commentError(status, 'posting the pull-request comment', json, rateLimited);
  }
  const id = field(json, 'id');
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new GithubAppError('GitHub accepted the comment but did not return its id.', 'PROVIDER');
  }
  return id;
}

/**
 * Edit the comment in place. `false` means it is gone — somebody deleted it, or
 * the pull request it lived on was, and the caller posts a fresh one rather
 * than treating a deletion as an error. Deleting a bot's comment is a normal
 * thing for a person to do.
 */
async function updateComment(
  token: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<boolean> {
  const slug = githubRepoSlug(repo);
  const id = pathNumber(commentId, 'comment id');
  const { status, json, rateLimited } = await githubRequest(
    `/repos/${slug}/issues/comments/${id}`,
    { method: 'PATCH', token, body: { body } },
  );

  if (status === 200) return true;
  if (status === 404 || status === 410) return false;

  throw commentError(status, 'updating the pull-request comment', json, rateLimited);
}

// ─── A link for a reviewer who has no QAAI login ─────────────────────────────

/**
 * A link a reviewer without a QAAI login can open — where one can honestly be
 * had.
 *
 * The share surface (RunShare, `GET /share/:token`) is another change's, and it
 * is deliberately built so that a link CANNOT be recovered from the database:
 * the row holds an HMAC of the token, keyed on SESSION_SECRET, and the raw
 * string is shown exactly once at mint. That is the right design, and it means
 * this processor has two options and only two.
 *
 * It could mint its own link. It does not, and the reasons are worth writing
 * down so nobody re-derives the idea as an improvement:
 *
 *   • Minting publishes a customer's run — screenshots, assertions, error text —
 *     to whoever holds a URL. That is a decision a person makes on the run page,
 *     not one a queue makes on every push.
 *   • The hash is keyed on SESSION_SECRET. The worker is not required to hold
 *     the API's copy of it, and nothing here can prove the two match. A
 *     mismatch produces a link that looks right in the comment and answers 404
 *     forever — a broken public URL pasted into a customer's pull request.
 *
 * So it reads. If a share row ever carries a directly usable URL, this finds it
 * and the comment links it; until then the comment says, once, that such a link
 * can be made — which is true, actionable, and publishes nothing.
 *
 * The lookup is duck-typed on purpose. `prisma.runShare` is typed only after
 * the client is regenerated against the migration, and this file must compile
 * and run on a deployment that has neither.
 */
const SHARE_DELEGATE = 'runShare';
/** Fields a future change might store a ready-made public URL in. */
const SHARE_URL_FIELDS = ['publicUrl', 'url', 'shareUrl'] as const;

interface ShareLink {
  /** Does this deployment have share links at all? */
  available: boolean;
  /** A URL to publish, when one can be read without minting anything. */
  url: string | null;
}

const NO_SHARE: ShareLink = { available: false, url: null };

type MaybeDelegate = { findFirst?: (args: unknown) => Promise<unknown> };

/**
 * `absent` — no such model here. `opaque` — the model exists and its rows carry
 * no usable URL, which is today's expected answer and stops the query below
 * running again for the life of the process.
 */
let shareState: 'unknown' | 'absent' | 'opaque' | 'readable' = 'unknown';

async function shareLinkFor(orgId: string, runId: string, webUrl: string): Promise<ShareLink> {
  if (shareState === 'absent') return NO_SHARE;
  if (shareState === 'opaque') return { available: true, url: null };

  const delegate = (prisma as unknown as Record<string, MaybeDelegate | undefined>)[
    SHARE_DELEGATE
  ];
  if (typeof delegate?.findFirst !== 'function') {
    shareState = 'absent';
    return NO_SHARE;
  }

  try {
    // No `select`: the columns belong to the other change, and asking for one
    // that does not exist is an error where reading the row is not.
    const row = (await delegate.findFirst({
      where: { runId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })) as Record<string, unknown> | null;

    // No row yet says nothing about the shape of one, so the probe stays open.
    if (!row) return { available: true, url: null };

    // Tenancy. The worker's client is unscoped by design, so this is the check
    // that a share row from another org can never be linked into this org's
    // pull request.
    if (typeof row.orgId === 'string' && row.orgId !== orgId) {
      return { available: true, url: null };
    }
    const expiresAt = row.expiresAt;
    if (expiresAt instanceof Date && expiresAt.getTime() <= Date.now()) {
      return { available: true, url: null };
    }

    for (const key of SHARE_URL_FIELDS) {
      const value = row[key];
      // Pinned to this deployment's own origin: a URL out of a database row is
      // a link QAAI would be vouching for in a customer's pull request.
      if (typeof value === 'string' && value.startsWith(`${webUrl}/`)) {
        shareState = 'readable';
        return { available: true, url: value };
      }
    }

    // The expected outcome: a row exists and holds only a hash. Stop asking.
    shareState = 'opaque';
    return { available: true, url: null };
  } catch (err) {
    // A model that exists with a shape this does not understand. Say so once,
    // name the constant to change, and carry on without the link.
    logger.warn(
      { err, delegate: SHARE_DELEGATE },
      'could not read the share link for this run; PR comments will link to the cockpit only',
    );
    shareState = 'absent';
    return NO_SHARE;
  }
}

// ─── What the comment says ───────────────────────────────────────────────────

const CONCLUSION_ICON: Record<CheckConclusion, string> = {
  success: '✅',
  failure: '❌',
  neutral: '⚠️',
  cancelled: '⏹️',
  timed_out: '⏱️',
  action_required: '🚨',
};

/**
 * Is there anything here a reviewer needs told?
 *
 * Only used to decide whether to CREATE a first comment. Once one exists it is
 * always updated, green or not — leaving yesterday's red comment at the top of
 * a PR that now passes is the worse failure of the two.
 */
export function worthCommenting(e: CheckEvidence): boolean {
  return e.failures.length > 0 || e.run.gateBlocking || e.run.status === 'ERRORED';
}

/**
 * The one line a reviewer reads before deciding whether to read the rest.
 *
 * Counts only. `buildCheckOutput().title` carries the triage sentence as well,
 * which is right for a check — where the title is the only line GitHub shows in
 * the merge box — and wrong here, because the summary directly underneath opens
 * with that same sentence in bold. Two copies an inch apart read as a stutter,
 * and the heading is what has to survive being rendered on a phone.
 */
function headline(e: CheckEvidence): string {
  if (e.run.status === 'CANCELLED') return 'run cancelled';
  if (e.run.status === 'ERRORED') return 'the run did not finish';
  if (e.failures.length === 0) return `${e.run.passedCount} passed`;
  return `${e.failures.length} failed, ${e.run.passedCount} passed`;
}

/**
 * The comment body.
 *
 * Assembled from `buildCheckOutput()` rather than written afresh: the triage
 * sentence, the counts table and the per-failure detail are the check's own
 * words, and a comment that phrased them differently would eventually
 * contradict the check sitting six inches above it. What this adds is what a
 * comment can do and a check cannot — the marker that makes it one comment
 * forever, and a link a reviewer without a QAAI login can open.
 */
export function buildPrComment(
  e: CheckEvidence,
  output: CheckOutput,
  share: ShareLink = NO_SHARE,
): string {
  const icon = CONCLUSION_ICON[conclusionFor(e)] ?? '•';
  const head = [PR_COMMENT_MARKER, `### ${icon} QAAI — ${headline(e)}`, '', output.summary];

  const tail: string[] = [];
  if (share.url) {
    tail.push(
      '',
      `[Open this run without signing in](${share.url}) — read-only, for reviewers without a QAAI account.`,
    );
  } else if (share.available && e.failures.length > 0) {
    // Not a link, because QAAI will not publish a customer's run on its own
    // initiative — but the reviewer who needs one should know it takes a click.
    tail.push(
      '',
      '<sub>Need to show this to someone without a QAAI login? Create a read-only link from the run page.</sub>',
    );
  }
  tail.push(
    '',
    '<sub>QAAI edits this one comment on every run for this pull request, rather than posting another.</sub>',
  );

  const details = output.text.trim()
    ? [
        '',
        `<details${e.failures.length <= FAILURES_SHOWN_EXPANDED ? ' open' : ''}>`,
        `<summary><b>Failing tests (${e.failures.length})</b></summary>`,
        // GitHub only renders Markdown inside a <details> after a blank line.
        '',
        output.text,
        '</details>',
      ]
    : [];

  const full = [...head, ...details, ...tail].join('\n');
  if (full.length <= MAX_COMMENT_CHARS) return full;

  // Too long for a comment. Drop the failure list whole rather than slicing it
  // mid-code-fence, and say where the rest went — a truncated body that renders
  // as broken markup reads as a bug in QAAI, not as a long list.
  const trimmed = [
    ...head,
    '',
    `_The failure list was too long to fit in a comment — ${e.failures.length} failing tests are on the run page and on the check._`,
    ...tail,
  ].join('\n');
  return trimmed.length <= MAX_COMMENT_CHARS ? trimmed : trimmed.slice(0, MAX_COMMENT_CHARS);
}

// ─── Posting it ──────────────────────────────────────────────────────────────

/**
 * Put the run's verdict in the pull request's timeline, exactly once.
 *
 * Every early return here is a deliberate silence, and each one is the right
 * answer to a normal Tuesday: not a pull request, a repo that already refused
 * us, a green run with nothing to correct, a body byte-for-byte identical to
 * the one already there.
 */
async function syncPrComment(
  cfg: AppConfig,
  target: { repo: string; installationId: string },
  evidence: CheckEvidence,
  output: CheckOutput,
  orgId: string,
): Promise<void> {
  const prNumber = evidence.run.prNumber;
  // A check on a plain push has no timeline to comment in; the check IS the
  // report there.
  if (prNumber === null || prNumber <= 0) return;
  if (commentingRefused(target.installationId, target.repo)) return;

  const token = await tokenFor(cfg, target.installationId);

  const cached = await readCommentState(target.repo, prNumber);
  let existing: CommentState | null = cached;
  if (!existing) {
    const found = await findMarkedComment(token, target.repo, prNumber);
    existing = found ? { id: found.id, hash: hashOf(found.body) } : null;
  }

  if (!existing && !worthCommenting(evidence)) {
    // A passing run on a pull request QAAI has never had to complain about.
    // The check's green tick already says this; a comment saying it again is
    // exactly the noise that gets a bot muted.
    return;
  }

  const body = buildPrComment(
    evidence,
    output,
    await shareLinkFor(orgId, evidence.run.id, evidence.webUrl),
  );
  const hash = hashOf(body);

  if (existing && existing.hash === hash) {
    // The same run, reported twice — a re-post, or the sweep and run.ts landing
    // on the same job. Editing would change nothing but the comment's
    // timestamp, so don't.
    await writeCommentState(target.repo, prNumber, existing);
    return;
  }

  if (existing) {
    if (await updateComment(token, target.repo, existing.id, body)) {
      await writeCommentState(target.repo, prNumber, { id: existing.id, hash });
      logger.info(
        { runId: evidence.run.id, repo: target.repo, pr: prNumber, commentId: existing.id },
        'updated the PR comment in place',
      );
      return;
    }
    logger.info(
      { repo: target.repo, pr: prNumber, commentId: existing.id },
      'the QAAI PR comment was deleted; posting a fresh one',
    );
  }

  const id = await createComment(token, target.repo, prNumber, body);
  await writeCommentState(target.repo, prNumber, { id, hash });
  logger.info(
    { runId: evidence.run.id, repo: target.repo, pr: prNumber, commentId: id },
    'posted the PR comment',
  );
}

/**
 * The comment must never cost the check.
 *
 * By the time this runs the check is concluded and its state is written, so the
 * only question left is what a failure here means. A refusal is remembered and
 * logged with GitHub's own sentence — which names the missing permission — and
 * swallowed. Throttling and outages are RE-THROWN, because the queue's backoff
 * is the correct handling for those and dropping the comment on the first 429
 * would be exactly the "log it and give up" this file exists to avoid; the
 * retry re-PATCHes the same check with the same content, which is a no-op, and
 * then tries the comment again.
 */
async function commentAfterCheck(
  cfg: AppConfig,
  target: { repo: string; installationId: string },
  evidence: CheckEvidence,
  output: CheckOutput,
  orgId: string,
): Promise<void> {
  try {
    await syncPrComment(cfg, target, evidence, output, orgId);
  } catch (err) {
    if (!isPermanent(err)) throw err;

    // Only a refusal about the repository is remembered. A pull request that
    // was deleted mid-run says nothing about the next one, and silencing the
    // repo for an hour over it would turn one vanished PR into an hour of
    // missing reports.
    if (err instanceof CommentRefused) {
      commentRefusedUntil.set(
        refusalKey(target.installationId, target.repo),
        Date.now() + COMMENT_REFUSAL_MS,
      );
    }

    logger.warn(
      {
        runId: evidence.run.id,
        repo: target.repo,
        pr: evidence.run.prNumber,
        reason: (err as GithubAppError).message,
      },
      'QAAI could not comment on this pull request — the check still carries the result. Grant the app "Pull requests: write" if the comment is wanted.',
    );
  }
}

// ─── Re-scoring the gate, now that the verdicts exist ────────────────────────
//
// THE DEFECT. `Run.gateResult` is written by the run finaliser, which runs
// BEFORE triage. The rule every new project gets is `BLOCK_ON_VERDICT REAL_BUG`
// — and at finalisation no TriageVerdict row exists, so the rule found no
// REAL_BUG verdicts and the gate came back `passed: true` on a run with real
// failures. The default gate could not see the verdicts it is named after, and
// the gate chip said PASS beside "2 failed".
//
// WHY HERE. This processor already runs after the run is terminal, already owns
// the sentence a reviewer reads in the merge box, and already keys the check's
// conclusion off `gateBlocking`. Re-scoring anywhere else would mean a second
// place that decides red or green, which is the defect packages/runner/gates.ts
// exists to have ended.
//
// WHAT IT IS ALLOWED TO DO. Supersede the stored gate, and — through
// `runOutcome`, the one function allowed to answer it — write the run's
// terminal status when the new gate changes that answer. What it may NOT do is
// flip a build that already reported a pass to a failure quietly: every write
// carries `rescored.reason`, which names the flip, and logs it at warn.
//
// WHICH WAY IT FAILS. Toward the stored gate. Every query here is inside one
// try/catch; a failure logs and leaves finalisation's gate in place, because a
// check that cannot be posted is better than a check that reports a verdict
// assembled from half the inputs.

/** Results read for the re-score. A suite larger than this is capped, and says so. */
const RESCORE_RESULTS_SCANNED = 5_000;
/** Findings read for the re-score. `+1` is fetched so truncation is detectable. */
const RESCORE_FINDINGS_SCANNED = 500;
/** Tests read to attribute the diff. Only read when a patch-coverage rule exists. */
const RESCORE_TESTS_SCANNED = 2_000;
/** Coverage rows read for the patch-coverage join. */
const RESCORE_COVERAGE_ITEMS_SCANNED = 5_000;
/** GitHub's page size for a pull request's files, and how many pages to walk. */
const PR_FILES_PER_PAGE = 100;
const PR_FILES_PAGES = 3;

/** The code the performance plugin files a blown Core Web Vitals budget under. */
const VITAL_BREACH_PREFIX = 'performance.budget-exceeded.';

/**
 * The project's rules, or the documented default when it has written none.
 *
 * The same fallback the finaliser applies, because a re-score that used a
 * different rule list from the one that produced the stored gate would report a
 * change of mind that was really a change of question.
 */
function rulesFor(raw: unknown): GateRule[] {
  return Array.isArray(raw) && raw.length > 0 ? (raw as GateRule[]) : DEFAULT_GATE_RULES;
}

const needs = (rules: readonly GateRule[], ...kinds: Array<GateRule['kind']>): boolean =>
  rules.some((rule) => kinds.includes(rule.kind));

/**
 * The pull request's changed files.
 *
 * Bounded at three pages of 100, and the bound is REPORTED rather than silently
 * applied: `truncated` makes patch coverage report "not measured" instead of
 * dividing by the first 300 files of a 900-file diff. Any refusal — the app was
 * never granted `Pull requests: read`, the PR is gone — is a null, which is also
 * "not measured". Neither one is allowed to look like a clean changed surface.
 */
async function pullRequestPaths(
  token: string,
  repo: string,
  prNumber: number,
): Promise<{ paths: string[]; truncated: boolean } | null> {
  const slug = githubRepoSlug(repo);
  const pr = pathNumber(prNumber, 'pull request number');
  const paths: string[] = [];

  for (let page = 1; page <= PR_FILES_PAGES; page += 1) {
    const { status, json } = await githubRequest(
      `/repos/${slug}/pulls/${pr}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`,
      { method: 'GET', token },
    );
    if (status !== 200 || !Array.isArray(json)) return null;

    for (const entry of json) {
      const filename = field(entry, 'filename');
      if (typeof filename === 'string' && filename.length > 0) paths.push(filename);
      /*
       * A rename lands in the diff as the NEW filename plus a
       * `previous_filename`. Both are collected: the old path is what the
       * coverage inventory still has a row for, and dropping it would make
       * every rename look like a pure addition.
       */
      const previous = field(entry, 'previous_filename');
      if (typeof previous === 'string' && previous.length > 0) paths.push(previous);
    }

    if (json.length < PR_FILES_PER_PAGE) {
      return { paths: [...new Set(paths)], truncated: false };
    }
  }

  // Three full pages means there is at least one more we did not read.
  return { paths: [...new Set(paths)], truncated: true };
}

/** The suite's quarantine health, as the finaliser computes it. */
async function quarantineHealth(
  orgId: string,
  projectId: string,
  budgetPercent: number | null,
  now: Date,
): Promise<GateInput['quarantine']> {
  const [totalTests, inForce, rows] = await Promise.all([
    prisma.test.count({ where: { orgId, projectId, disabledAt: null } }),
    // The suppressions in force, counted in the DATABASE: the row list below is
    // capped and counting from it would make the budget stop working on exactly
    // the suites it exists to catch.
    prisma.test.count({
      where: {
        orgId,
        projectId,
        disabledAt: null,
        quarantined: true,
        OR: [{ quarantineExpiresAt: null }, { quarantineExpiresAt: { gt: now } }],
      },
    }),
    prisma.test.findMany({
      where: { orgId, projectId, disabledAt: null, quarantined: true },
      select: { id: true, name: true, quarantinedAt: true, quarantineExpiresAt: true },
      take: QUARANTINE_NAMES_SCANNED,
      orderBy: { quarantinedAt: 'asc' },
    }),
  ]);

  return quarantineHealthFrom({ totalTests, quarantinedCount: inForce, budgetPercent, rows, now });
}

/**
 * The run's results, with the human override beating the model's verdict.
 *
 * Reads one past the cap so truncation is a fact rather than a guess: EVERY
 * rule's arithmetic divides by this list, so a capped read would compute a pass
 * rate, a flake rate and a verdict count over a subset nobody chose. The caller
 * refuses to re-score at all in that case — see `rescoreRunGate`.
 */
async function resultsFor(orgId: string, runId: string, now: Date) {
  return prisma.testResult.findMany({
    where: { runId, orgId },
    take: RESCORE_RESULTS_SCANNED + 1,
    select: {
      testId: true,
      status: true,
      durationMs: true,
      retriedAndPassed: true,
      /*
       * The two places a not-run reason is written, both read, because they
       * answer for different rows. `notRunKind` is the queryable column and the
       * tag on `errorMessage` is what every row written before it carries — a
       * reader holding both prefers the column (see `NOT_RUN_KINDS` in
       * @qaai/shared). Without them a test the environment blocked arrives here
       * indistinguishable from a test that ran and did not pass, and lands in
       * the pass rate's denominator.
       */
      notRunKind: true,
      errorMessage: true,
      mutationScore: true,
      mutationDetected: true,
      mutationUndetected: true,
      mutationExcluded: true,
      test: {
        select: {
          name: true,
          priority: true,
          /*
           * The test TYPE, and the only honest way to count what measured the
           * Core Web Vitals. "Zero breaches" from a run with no PERFORMANCE
           * test in it is a fact about the suite, not about the pages, so the
           * vitals rule has to be able to tell those apart.
           */
          type: true,
          quarantined: true,
          quarantineExpiresAt: true,
        },
      },
      verdict: { select: { verdict: true, reviewState: true, overriddenTo: true } },
    },
  }).then((rows) =>
    rows.map((row) => ({
      row,
      gate: {
        testId: row.testId,
        testName: row.test.name,
        status: row.status,
        priority: row.test.priority,
        // The suppression as it stands NOW, expiry included — not the column.
        quarantined: quarantineSuppresses(row.test, now),
        retriedAndPassed: row.retriedAndPassed,
        /*
         * NULL stays null. "Not recorded" is a fifth state and it is not
         * NOT_RUN: a plugin that returned SKIPPED with a plain sentence made no
         * claim about why, and writing one here would put a classification into
         * a gate's denominator that nothing produced.
         */
        notRun: row.notRunKind ?? parseNotRun(row.errorMessage)?.kind ?? null,
        // A human override beats the model, always. Same rule as the finaliser.
        verdict: effectiveVerdict(row.verdict),
        durationMs: row.durationMs,
      },
    })),
  );
}

/**
 * The verdict that counts: a human's override, or the model's answer.
 *
 * One function because two readers in this file ask it — the re-score's results
 * and the untriaged guard — and the run finaliser applies the same rule to the
 * same column in apps/worker/src/processors/run.ts. A reader that forgot the
 * override would score a gate against a verdict a person had already corrected.
 */
function effectiveVerdict(
  verdict: { verdict: string; reviewState: string; overriddenTo: string | null } | null,
): GateInput['results'][number]['verdict'] {
  if (!verdict) return null;
  const chosen =
    verdict.reviewState === 'OVERRIDDEN' ? (verdict.overriddenTo ?? verdict.verdict) : verdict.verdict;
  return chosen as GateInput['results'][number]['verdict'];
}

/**
 * The findings this run recorded, with every exclusion counted.
 *
 * Muted findings never gate (`Finding.mutedAt` says so in the schema) and
 * neither do findings from a test whose quarantine is in force — the same rule
 * the rest of this file applies to that test's failure. Both are COUNTED, so
 * the gate detail can say "4 criticals, 11 muted" rather than "4 criticals".
 */
async function findingsFor(orgId: string, runId: string, now: Date) {
  const rows = await prisma.finding.findMany({
    where: { orgId, testResult: { runId } },
    // One past the cap, so truncation is a fact rather than a guess.
    take: RESCORE_FINDINGS_SCANNED + 1,
    select: {
      kind: true,
      severity: true,
      code: true,
      location: true,
      mutedAt: true,
      testResult: {
        select: {
          test: { select: { name: true, quarantined: true, quarantineExpiresAt: true } },
        },
      },
    },
  });

  const truncated = rows.length > RESCORE_FINDINGS_SCANNED;
  const kept = truncated ? rows.slice(0, RESCORE_FINDINGS_SCANNED) : rows;

  const findings: Array<{
    kind: FindingKind;
    severity: FindingSeverity;
    code: string;
    location: string;
    testName: string | null;
  }> = [];
  let excludedMuted = 0;
  let excludedQuarantined = 0;
  const breaches: Array<{ metric: PerformanceMetric; location: string; message: string }> = [];

  for (const row of kept) {
    if (row.mutedAt !== null) {
      excludedMuted += 1;
      continue;
    }
    if (quarantineSuppresses(row.testResult.test, now)) {
      excludedQuarantined += 1;
      continue;
    }
    findings.push({
      kind: row.kind,
      severity: row.severity,
      code: row.code,
      location: row.location,
      testName: row.testResult.test.name,
    });
    /*
     * Core Web Vitals reach a gate as the breach the product PERSISTS, not as a
     * number. The performance plugin keeps the median it measured in a step
     * title and files the breach as this finding, so the metric name is read off
     * the finding's code — a stable identifier the plugin constructs — and not
     * regexed out of a human sentence. See the `MAX_VITAL_BREACHES` docstring.
     */
    if (row.kind === 'PERFORMANCE' && row.code.startsWith(VITAL_BREACH_PREFIX)) {
      breaches.push({
        metric: row.code.slice(VITAL_BREACH_PREFIX.length) as PerformanceMetric,
        location: row.location,
        message: row.code,
      });
    }
  }

  return { findings, truncated, excludedMuted, excludedQuarantined, breaches };
}

/** The latest stored coverage snapshot, as a gate rule needs it. */
async function coverageFor(projectId: string): Promise<GateInput['coverage']> {
  const snapshot = await prisma.coverageSnapshot.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { percent: true, denominator: true, covered: true, createdAt: true, commitSha: true },
  });
  if (!snapshot) return undefined;
  return {
    // NULL stays null all the way to the rule, which reports UNMEASURED. A zero
    // denominator has no percentage and 0% would be a claim about the customer's
    // app made from our extractor finding nothing.
    percent: snapshot.percent,
    denominator: snapshot.denominator,
    covered: snapshot.covered,
    measuredAtIso: snapshot.createdAt.toISOString(),
    commitSha: snapshot.commitSha,
  };
}

/**
 * Patch coverage: the diff's routes joined to the coverage inventory.
 *
 * Returns undefined — "not measured" — rather than an empty answer whenever any
 * input is missing: no pull request, no changed files, a refused GitHub read.
 * `patchCoverage` itself returns `measured: false` for the cases where the diff
 * IS readable and still cannot be scoped (a lockfile, an unattributable file),
 * with the reason in its caveats.
 */
async function patchCoverageFor(args: {
  orgId: string;
  projectId: string;
  prNumber: number | null;
  commitSha: string | null;
  token: string;
  repo: string;
  coverageCommitSha: string | null;
  coverageMeasuredAtIso: string | null;
}): Promise<GateInput['patch']> {
  if (args.prNumber === null) return undefined;

  const diff = await pullRequestPaths(args.token, args.repo, args.prNumber);
  if (!diff) return undefined;

  const [tests, items] = await Promise.all([
    /*
     * The suite the attribution is corroborated against. Capped, and the cap
     * fails SAFE: fewer known tokens and routes means `attribute()` demotes
     * more paths, which makes patch coverage report "not measured" rather than
     * a percentage over a surface it half recognised.
     */
    prisma.test.findMany({
      where: { orgId: args.orgId, projectId: args.projectId, disabledAt: null },
      take: RESCORE_TESTS_SCANNED,
      select: {
        id: true,
        name: true,
        filePath: true,
        code: true,
        spec: true,
        tags: true,
        feature: true,
        priority: true,
      },
    }),
    prisma.coverageItem.findMany({
      where: { projectId: args.projectId, retiredAt: null },
      take: RESCORE_COVERAGE_ITEMS_SCANNED + 1,
      select: { key: true, status: true, label: true },
    }),
  ]);

  /*
   * The attribution is the product's own, not a second copy of it: the same
   * `analyzeImpact` that decides which tests to run decides which routes this
   * diff touches, so a gate and a selection can never disagree about one diff.
   */
  const routeRows = items.slice(0, RESCORE_COVERAGE_ITEMS_SCANNED) as PatchCoverageRow[];
  const analysis = analyzeImpact({
    /*
     * The inventory's routes, so a changed page NOTHING tests can still be
     * attributed to its route. Without them `attribute()` demotes a route the
     * suite has never visited, and the one case this gate exists to catch — a
     * diff that adds an untested page — comes back "unattributable". See
     * `ImpactInput.knownRoutes`.
     */
    knownRoutes: routeRows.flatMap((row) => {
      const identity = row.key.startsWith('ROUTE:') ? row.key.slice('ROUTE:'.length) : null;
      return identity ? [identity] : [];
    }),
    changedPaths: diff.paths,
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      filePath: test.filePath,
      code: test.code,
      spec: test.spec,
      tags: test.tags,
      feature: test.feature,
      priority: test.priority,
    })),
  });

  const truncatedInventory = items.length > RESCORE_COVERAGE_ITEMS_SCANNED;
  return patchCoverage({
    attributions: analysis.attributions,
    rows: routeRows,
    diffCommitSha: args.commitSha,
    inventoryCommitSha: args.coverageCommitSha,
    inventoryMeasuredAtIso: args.coverageMeasuredAtIso,
    diffTruncated: diff.truncated,
    changedPathCount: diff.paths.length,
    inventoryTruncated: truncatedInventory,
  });
}

/**
 * Score the gate again against everything that is now known, and persist it if
 * it changed.
 *
 * Returns the gate the check should report. `null` means the stored one stands —
 * either nothing changed, or the inputs could not be read, and both of those
 * leave finalisation's answer in place rather than inventing one.
 */
async function rescoreRunGate(args: {
  /** Null when this deployment has no GitHub app. Only patch coverage needs it. */
  cfg: AppConfig | null;
  orgId: string;
  run: LoadedRun;
  /**
   * The repository this run can reach as a check, when it can reach one.
   *
   * NULL IS A SUPPORTED CASE and it is the common one: a run from
   * packages/cli in somebody's CI has no pull request and no installation, and
   * four of the measurement rules — `MIN_COVERAGE`, `MAX_FINDINGS`,
   * `MIN_MUTATION_SCORE`, `MAX_VITAL_BREACHES` — need neither. Requiring a
   * target here is what made those four reportable only on a GitHub-app pull
   * request, so a customer who configured `MIN_COVERAGE` and installs the
   * product the way the README does read "not measured" on every run. The two
   * patch rules DO need a diff, and they say so themselves when it is absent.
   */
  target: { repo: string; installationId: string } | null;
}): Promise<{ gate: GateResult | null; status: string | null }> {
  const { orgId, run } = args;

  /*
   * A cancelled or errored run measured nothing, and `runOutcome` already says
   * so: re-scoring it would replace "nobody wanted this answer" with a gate
   * verdict about a suite that never finished.
   */
  if (run.status === 'CANCELLED' || run.status === 'ERRORED') return { gate: null, status: null };

  try {
    const now = new Date();
    const rules = rulesFor(run.project.gateRules);

    const results = await resultsFor(orgId, run.id, now);
    /*
     * A suite larger than the cap is not re-scored. There is no honest way to
     * score a pass rate over the first 5,000 of 6,000 results, and the
     * finalisation gate at least divided by the whole run.
     */
    if (results.length > RESCORE_RESULTS_SCANNED) {
      logger.warn(
        { runId: run.id, cap: RESCORE_RESULTS_SCANNED },
        'this run has more results than the re-score reads, so the gate was not re-scored; the gate finalisation wrote stands',
      );
      return { gate: null, status: null };
    }
    const input: GateInput = { results: results.map((r) => r.gate) };

    input.quarantine = await quarantineHealth(
      orgId,
      run.project.id,
      run.project.quarantineBudgetPercent ?? null,
      now,
    );

    if (needs(rules, 'MAX_FINDINGS', 'MAX_VITAL_BREACHES')) {
      const read = await findingsFor(orgId, run.id, now);
      input.findings = {
        findings: read.findings,
        truncated: read.truncated,
        excludedMuted: read.excludedMuted,
        excludedQuarantined: read.excludedQuarantined,
      };
      /*
       * `performanceTests` is the honesty field: zero means no performance test
       * ran, so "no breaches" would be a fact about the suite rather than about
       * the pages, and the rule reports UNMEASURED.
       */
      input.vitals = {
        performanceTests: results.filter((r) => r.row.test.type === 'PERFORMANCE').length,
        breaches: read.breaches,
        /*
         * The same cap, reported to the same standard. The breaches are read off
         * the findings list, so when that list was capped the breach count is a
         * floor — and a vitals rule that cleared on a floor would be the exact
         * silent pass the `MAX_FINDINGS` truncation guard exists to refuse.
         */
        truncated: read.truncated,
      };
    }

    if (needs(rules, 'MIN_MUTATION_SCORE')) {
      const measured = results.filter((r) => hasMutation(r.row));
      input.mutation = {
        resultsWithData: measured.length,
        detected: sum(measured.map((r) => r.row.mutationDetected ?? 0)),
        undetected: sum(measured.map((r) => r.row.mutationUndetected ?? 0)),
        excluded: sum(measured.map((r) => r.row.mutationExcluded ?? 0)),
      };
    }

    const wantsCoverage = needs(rules, 'MIN_COVERAGE');
    const wantsPatch = needs(rules, 'MIN_PATCH_COVERAGE', 'NO_NEW_UNCOVERED_ROUTES');
    const coverage = wantsCoverage || wantsPatch ? await coverageFor(run.project.id) : undefined;
    if (wantsCoverage) input.coverage = coverage;

    /*
     * Patch coverage, and ONLY patch coverage, needs GitHub. With no app or no
     * installation there is no diff to join, so `input.patch` stays absent and
     * the two patch rules report what is true — that nobody measured the
     * changed surface. The other four rules are scored either way, which is the
     * whole point of not requiring a target.
     */
    if (wantsPatch && args.cfg && args.target) {
      input.patch = await patchCoverageFor({
        orgId,
        projectId: run.project.id,
        prNumber: run.prNumber,
        commitSha: run.commitSha,
        token: await tokenFor(args.cfg, args.target.installationId),
        repo: args.target.repo,
        coverageCommitSha: coverage?.commitSha ?? null,
        coverageMeasuredAtIso: coverage?.measuredAtIso ?? null,
      });
    }

    const decision = rescoreGate({ stored: run.gateResult, next: evaluateGates(rules, input), at: now });
    if (!decision.gate) return { gate: null, status: null };

    /*
     * The status comes from `runOutcome` and from nowhere else. A gate that now
     * blocks means the run did not pass, and leaving `Run.status` at PASSED
     * while the gate says BLOCK would be a sixth place deciding red or green —
     * the exact defect packages/runner/src/gates.ts was written to end.
     */
    const outcome = runOutcome({
      counts: {
        passed: run.passedCount,
        failed: run.failedCount,
        flaky: run.flakyCount,
        skipped: run.skippedCount,
        quarantinedFailed: run.quarantinedFailedCount,
      },
      gatePassed: decision.gate.passed,
      forcedStatus: null,
    });

    /*
     * Guarded on the status we read. A cancel that arrived while this was
     * running is terminal and may not be relabelled; neither may an ERRORED
     * run, which measured nothing.
     */
    const wrote = await prisma.run.updateMany({
      where: { id: run.id, orgId, status: { in: ['PASSED', 'FAILED'] } },
      /*
       * The cast Prisma's `Json` input requires of a typed interface — the same
       * one `finalizeRun` applies to the same column, and the same rule
       * coverage-store.ts documents for `SurfaceKindTotals`. Written as the
       * narrowest cast that compiles rather than `any`.
       */
      data: { gateResult: decision.gate as unknown as object, status: outcome.status },
    });
    if (wrote.count === 0) {
      logger.info(
        { runId: run.id },
        'the run left PASSED/FAILED before the gate could be re-scored; the stored gate stands',
      );
      return { gate: null, status: null };
    }

    const line = {
      runId: run.id,
      generation: decision.generation,
      previousPassed: decision.previousPassed,
      nowPassed: decision.gate.passed,
      status: outcome.status,
      /*
       * Logged because it is the count of evaluations this scoring did not
       * recompute and kept — the environment line the finaliser appends, above
       * all. A re-score that moved one silently is how an unattemptable run's
       * BLOCK came to be cleared.
       */
      carriedForward: decision.carriedForward,
      reason: decision.reason,
    };
    /*
     * A green that goes red is a warn, not an info. It is the one transition
     * that costs a team trust, so it is logged at a level somebody reads, with
     * the sentence that says why.
     */
    if (decision.reversedGreen) {
      logger.warn(line, 'the gate was re-scored after triage and now BLOCKS a run that had reported a pass');
    } else {
      logger.info(line, 'the gate was re-scored after triage');
    }

    return { gate: decision.gate, status: outcome.status };
  } catch (err) {
    /*
     * Toward the stored gate, every time. The re-score is an improvement on the
     * finalisation gate, not a precondition for reporting one, and a check that
     * cannot be posted is strictly worse than a check carrying the older
     * verdict — which is at least a verdict the product computed.
     */
    logger.warn(
      { err, runId: run.id },
      'the gate could not be re-scored after triage; the check reports the gate finalisation wrote',
    );
    return { gate: null, status: null };
  }
}

/** Did this result report mutation columns at all? NULL is not zero. */
function hasMutation(row: {
  mutationScore: number | null;
  mutationDetected: number | null;
  mutationUndetected: number | null;
  mutationExcluded: number | null;
}): boolean {
  return (
    row.mutationScore !== null ||
    row.mutationDetected !== null ||
    row.mutationUndetected !== null ||
    row.mutationExcluded !== null
  );
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

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

  /*
   * Score the gate again BEFORE the check is built. The stored gate was written
   * by the finaliser, before any triage verdict existed, so the default
   * `BLOCK_ON_VERDICT REAL_BUG` rule had nothing to find — see the section
   * header above `rescoreRunGate`. Non-fatal by construction: it returns null
   * and the check reports the stored gate.
   */
  const rescore = await rescoreRunGate({ cfg, orgId: job.orgId, run, target });

  const evidence = await buildEvidence(job.orgId, run, rescore.gate, rescore.status);
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

  // The check is the verdict, so its state is written before anything else is
  // attempted: whatever the comment does next, the sweep must not come back and
  // re-report a run that has already been reported.
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

  // And then the part a reviewer actually reads.
  await commentAfterCheck(cfg, target, evidence, output, job.orgId);
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

async function phaseSweep(cfg: AppConfig | null): Promise<void> {
  const since = new Date(Date.now() - SWEEP_WINDOW_MS);
  /** Runs the check half has already dealt with this tick. */
  const seen = new Set<string>();

  if (cfg) {
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
      seen.add(run.id);
      const state = await readState(run.id);
      if (state?.done) {
        await rescoreAfterTriage(cfg, run.id, run.orgId);
        continue;
      }

      const phase = TERMINAL.has(run.status) ? 'completed' : 'started';
      // Enqueue rather than act: the job id de-duplicates, so a sweep that
      // overlaps with a direct enqueue from run.ts collapses onto one job.
      await enqueueCheck({ orgId: run.orgId, runId: run.id, phase });
    }
  }

  await sweepRescoreWithoutCheck(cfg, since, seen);
}

/**
 * The re-score, for the runs that will never have a check.
 *
 * ── Why this is here, and why that is borrowed ground ───────────────────────
 *
 * Four of the measurement rules — `MIN_COVERAGE`, `MAX_FINDINGS`,
 * `MIN_MUTATION_SCORE`, `MAX_VITAL_BREACHES` — are scored from inputs that only
 * `rescoreRunGate` assembles, and both of its callers used to need a GitHub-app
 * pull request. So a customer who installs the product the way the README
 * does — `packages/cli` in their own CI, no app, no PR — configured
 * `MIN_COVERAGE 80` and read "not measured" on every run they would ever do.
 * None of those four rules needs a diff.
 *
 * This loop is not where the measurement BELONGS. It belongs beside
 * finalisation, where every run passes exactly once and nothing has to be swept
 * for: `evaluateRunGates` in apps/worker/src/processors/run.ts assembles only
 * `results` and `quarantine`, and teaching it the other four is the real fix.
 * Until then this is reachable from the file that already owns the re-score, and
 * a feature that works for the primary install beats one that waits for another
 * file to be edited — the same trade, with the same reasoning, as the check
 * sweep above it.
 *
 * WHAT IT COSTS, bounded on every side: only terminal runs, only inside the
 * same two-hour window, only the first `SWEEP_LIMIT`, and only those whose
 * stored gate is still PROVISIONAL — which is also why `failedCount > 0` is a
 * sound prefilter rather than an optimisation that drops work: a gate awaits
 * triage only when a failure that GATES has no verdict, and such a failure is
 * counted in `failedCount` (a quarantined one is not, and does not reach the
 * rule either).
 *
 * WHAT IT DOES NOT COVER, said plainly because it is the remaining half of the
 * defect. Only a PROVISIONAL gate is swept, and a gate is provisional only while
 * a `BLOCK_ON_VERDICT` rule has an untriaged failure to wait for. So a run with
 * no failures, and a project whose rule list holds no verdict rule at all, are
 * never re-scored: their `MIN_COVERAGE` stays whatever the finalisation gate
 * said — "not measured", with the reason naming the read that did not happen.
 * Only run.ts can close that, by assembling the four inputs where every run
 * passes once. Re-scoring every terminal run from a sweep instead would pay five
 * reads a minute per run for two hours to find out nothing had changed.
 */
async function sweepRescoreWithoutCheck(
  cfg: AppConfig | null,
  since: Date,
  seen: Set<string>,
): Promise<void> {
  const runs = await prisma.run.findMany({
    where: {
      queuedAt: { gt: since },
      status: { in: ['PASSED', 'FAILED'] },
      failedCount: { gt: 0 },
    },
    orderBy: { queuedAt: 'desc' },
    take: SWEEP_LIMIT,
    select: { id: true, orgId: true, gateResult: true },
  });

  for (const run of runs) {
    if (seen.has(run.id)) continue;
    // The provisional test before `loadRun`, so a tick over a hundred settled
    // runs costs one query rather than a hundred and one.
    if (!gateAwaitsTriage(run.gateResult)) continue;
    await rescoreAfterTriage(cfg, run.id, run.orgId);
  }
}

/**
 * The failures a verdict rule could still be waiting on, read narrowly.
 *
 * ── Why not a `count`, which is what this was ───────────────────────────────
 *
 * It counted `status in (FAILED, TIMED_OUT) AND verdict IS NULL` with no
 * quarantine filter and no priority filter, while the RULE it was waiting for
 * excludes quarantined results and applies `onlyPriorities`. So a run with one
 * untriaged CRITICAL_PATH failure beside one untriaged quarantined or IMPORTANT
 * failure stayed PROVISIONAL FOR EVER: the moment the critical one was triaged
 * the rule stopped waiting, and the guard never did. Its own test asserted the
 * guard existed, not that it waited on the same thing.
 *
 * So the judgement is `untriagedBlockers` in packages/runner/src/gates.ts — the
 * function the rule itself uses — and this reads the rows it needs. Narrow on
 * purpose: a row that is neither a failure nor carries a verdict can be neither
 * an offender nor untriaged, so the predicate over these rows is the predicate
 * over the whole run, computed from the failures rather than from 5,000 results.
 *
 * Read one past the cap, so `truncated` is a fact rather than a guess. A guard
 * that answered "nothing is waiting" from the first 5,000 of 6,000 failures
 * would be a cap deciding a gate, which is the same mistake as a pass rate
 * computed over a capped read — and the caller refuses rather than deciding.
 */
async function untriagedCandidates(
  orgId: string,
  runId: string,
  now: Date,
): Promise<{ rows: GateInput['results']; truncated: boolean }> {
  const rows = await prisma.testResult.findMany({
    where: {
      runId,
      orgId,
      OR: [{ status: { in: ['FAILED', 'TIMED_OUT'] } }, { verdict: { isNot: null } }],
    },
    take: RESCORE_RESULTS_SCANNED + 1,
    select: {
      testId: true,
      status: true,
      test: {
        select: { name: true, priority: true, quarantined: true, quarantineExpiresAt: true },
      },
      verdict: { select: { verdict: true, reviewState: true, overriddenTo: true } },
    },
  });

  return {
    truncated: rows.length > RESCORE_RESULTS_SCANNED,
    rows: rows.slice(0, RESCORE_RESULTS_SCANNED).map((row) => ({
      testId: row.testId,
      testName: row.test.name,
      status: row.status,
      priority: row.test.priority,
      quarantined: quarantineSuppresses(row.test, now),
      /*
       * Neither field is read by `untriagedBlockers`, and both are filled with
       * the honest value rather than a plausible one: nothing here retried, and
       * no not-run reason was read, so nothing here may claim one.
       */
      retriedAndPassed: false,
      notRun: null,
      verdict: effectiveVerdict(row.verdict),
      durationMs: 0,
    })),
  };
}

/**
 * The other half of re-scoring: the runs whose gate was already written.
 *
 * ── Why this is not just done in `phaseCompleted` ───────────────────────────
 *
 * It IS done there. But triage is a queue of its own, and a short suite reaches
 * terminal and gets its check long before the triage jobs for its failures have
 * run — so on most real runs `phaseCompleted` re-scores a gate whose verdicts
 * still do not exist, computes the same UNMEASURED answer, writes nothing, and
 * nothing ever asks again. The sweep is where "ask again" lives, which is what
 * it already is for every other phase.
 *
 * ── Why it is cheap ─────────────────────────────────────────────────────────
 *
 * Two guards, in this order. A gate that is not PROVISIONAL is not re-scored at
 * all — once the verdict rule has an answer there is nothing to wait for. And a
 * run the verdict rules are still waiting on is not re-scored either: re-scoring
 * would produce the same UNMEASURED answer, so a project with no triage running
 * (no model key, triage switched off) costs one narrow read of that run's
 * failures per sweep tick rather than the several reads of a full scoring.
 *
 * That read is the exchange this guard makes on purpose. It used to be a single
 * `count`, which was cheaper and answered a different question than the rule —
 * and a guard that waits on the wrong thing does not hold a gate open for a
 * minute, it holds it open until the sweep window closes.
 *
 * ── And the runs with no check to re-report ─────────────────────────────────
 *
 * `target` may be null here. A run with no pull request, or on a repo where the
 * app is not installed, still gets its gate re-scored — four of the measurement
 * rules need no diff — and simply has no check to re-report afterwards.
 */
async function rescoreAfterTriage(
  cfg: AppConfig | null,
  runId: string,
  orgId: string,
): Promise<void> {
  const run = await loadRun(orgId, runId);
  if (!run || !TERMINAL.has(run.status)) return;
  if (!gateAwaitsTriage(run.gateResult)) return;

  const rules = rulesFor(run.project.gateRules);
  const candidates = await untriagedCandidates(orgId, runId, new Date());
  if (candidates.truncated) {
    logger.warn(
      { runId, cap: RESCORE_RESULTS_SCANNED },
      'this run has more failing results than the triage guard reads, so whether the gate is still waiting could not be decided; the gate finalisation wrote stands',
    );
    return;
  }
  if (untriagedBlockers(rules, candidates.rows).length > 0) return;

  const target = checkTarget(run);
  const rescore = await rescoreRunGate({ cfg, orgId, run, target });
  if (!rescore.gate) return;

  const generation = rescore.gate.rescored?.generation ?? 2;

  if (!target) {
    // Nothing to re-report: the gate and the run's status are the report.
    logger.info(
      { runId, generation },
      'the gate was re-scored after triage; this run has no check to re-report',
    );
    return;
  }

  /*
   * Re-report, through the phase that already owns the reporting. The job id
   * carries the generation, so this cannot loop: the next sweep tick finds a
   * gate that is no longer provisional and does nothing.
   */
  await enqueueCheck({ orgId, runId, phase: 'completed' }, 0, `g${generation}`);
  logger.info(
    { runId, generation },
    'the gate was re-scored after triage; the check will be re-reported',
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function processChecks(job: ChecksJob): Promise<void> {
  const cfg = appConfig();

  /*
   * The sweep runs WITHOUT a GitHub app, and that is the change that makes the
   * measurement rules reachable for the install most customers have. Its check
   * half is still behind `cfg` — nothing talks to GitHub without an app — but
   * its re-score half needs no app at all, and returning here used to mean that
   * a deployment with no app never scored `MIN_COVERAGE` on any run, ever.
   */
  if (job.phase === 'sweep') {
    await phaseSweep(cfg);
    return;
  }

  if (!cfg) {
    // No app: nothing to report, and nothing is broken. The PAT comment path in
    // notify.ts is untouched and remains the PR feedback.
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
