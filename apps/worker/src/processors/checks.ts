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
const COMMENT_TIMEOUT_MS = 15_000;
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
 * One request to GitHub's issue-comment API, under the rules every credential
 * in this codebase travels by.
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
async function commentRequest(
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
      signal: AbortSignal.timeout(COMMENT_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `did not answer within ${COMMENT_TIMEOUT_MS / 1000}s`
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
    const { status, json, rateLimited } = await commentRequest(
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
  const { status, json, rateLimited } = await commentRequest(
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
  const { status, json, rateLimited } = await commentRequest(
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
