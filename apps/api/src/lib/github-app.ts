/**
 * The GitHub App — a CHECK RUN on the pull request (§7).
 *
 * QAAI already posts a PR comment with a personal access token. A comment is a
 * nice-to-have: it scrolls away, it cannot block a merge, and it belongs to
 * whoever's PAT posted it. A check run is how a tool becomes part of a team's
 * workflow — it sits in the merge box, it can carry an annotation on the exact
 * line that failed, and it can offer a button that re-runs the suite without
 * anyone leaving GitHub.
 *
 * This module is the pure half: JWTs, installation tokens, the HTTP calls, and
 * the payload builders. No Prisma, no Express, no logger — that is what lets
 * both the API (webhooks, re-run button) and the worker (create at run start,
 * complete at run end) import the same code instead of keeping two copies of a
 * judgement call. Same arrangement as lib/bisect.ts and lib/issues.ts.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Read apps/api/src/lib/issues.ts first; this file follows its rules, and they
 * are rules because this repo has already shipped both bugs:
 *
 *  - THE HOST IS A CONSTANT. `GITHUB_API_HOST` is the only host any request in
 *    this file can reach, it is never read from config, and every constructed
 *    URL is re-parsed and re-checked before it is used. A PAT walked out of the
 *    building once because a host came out of a config row.
 *  - EVERY REQUEST IS `redirect: 'manual'`. A 3xx is an error, not a hop:
 *    following one re-sends the Authorization header — an installation token or,
 *    worse, an app JWT — to whatever the Location named.
 *  - REPO SLUGS ARE VALIDATED, NOT INTERPOLATED. `githubRepoSlug()` from
 *    issues.ts is the one parser, so `..` and a foreign host are rejected in
 *    exactly one place. Installation ids and check-run ids are digits or they
 *    are refused; both land in a URL path.
 *  - NO CREDENTIAL IS EVER LOGGED, RETURNED, OR PUT IN A URL. The private key is
 *    unsealed from the vault by name, held for one signature, and never
 *    stringified into an error. Provider text that reaches a human goes through
 *    `redactSecrets()` first, because an error page can echo the request that
 *    carried the token.
 *
 * ── DEGRADING HONESTLY ──────────────────────────────────────────────────────
 * `loadAppConfig()` returns null when the app is not configured, and every
 * caller treats null as "do nothing". No app means the existing PAT comment path
 * in apps/worker/src/processors/notify.ts runs exactly as it did before. A
 * half-configured app (an id with no key) is a CONFIG error with a sentence
 * naming the missing variable — never a silent no-op, because a check that
 * quietly never appears is indistinguishable from a green build.
 */

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
// One repo-slug parser for the whole codebase. It rejects `..`, a foreign host
// and embedded credentials; every path built here starts from its output.
import { githubRepoSlug, redactSecrets } from './issues.js';

export { githubRepoSlug, redactSecrets };

// ─── Contract with the queue ─────────────────────────────────────────────────

/**
 * The checks queue.
 *
 * Spelled here rather than in `QUEUE_NAMES` because that constant and
 * `JobPayloads` live in @qaai/shared, which this change does not own — the same
 * compromise `BISECT_QUEUE` makes, for the same reason, with the same
 * consequence: until the name moves to @qaai/shared, `queueDepths()` in
 * lib/queues.ts will not report this queue's depth on /health/ready.
 */
export const CHECKS_QUEUE = 'qaai.checks';

/**
 * What a checks job does.
 *
 *   started   — create the check run in_progress, so the PR shows QAAI working
 *   completed — conclude it: verdicts, summary, annotations, re-run button
 *   sweep     — the safety net (see below)
 *
 * `sweep` exists because the two places that would naturally enqueue `started`
 * and `completed` — the run processor's start and its finaliser — are in
 * apps/worker/src/processors/run.ts, which this change does not own. Rather than
 * ship a feature that does nothing until someone else edits their file, the
 * sweep finds PR runs on app-installed repos and enqueues the phases itself.
 * It is a repeatable tick like the flake and schedule sweeps, and it becomes
 * redundant — not wrong — the day run.ts enqueues directly.
 */
export type CheckPhase = 'started' | 'completed' | 'sweep';

export interface ChecksJob {
  /** Empty on a sweep, which spans every org by design. */
  orgId: string;
  /** Empty on a sweep. */
  runId: string;
  phase: CheckPhase;
}

/**
 * Where the worker remembers which check run belongs to which QAAI run.
 *
 * Redis rather than a column because `Run` is not this change's to alter. It is
 * a CACHE and is treated as one: every read that misses falls back to asking
 * GitHub for the check run whose `external_id` is the run id, so an evicted key
 * costs one API call rather than a duplicate check on someone's PR.
 */
export const checkStateKey = (runId: string): string => `qaai:check:${runId}`;
export const CHECK_STATE_TTL_SECONDS = 7 * 24 * 3600;

// ─── Pinned host and provider limits ─────────────────────────────────────────

/** Never derived from config. See the security note above. */
export const GITHUB_API_HOST = 'api.github.com';

/** The check's name in the PR's merge box, and the filter used to find it again. */
export const CHECK_NAME = 'QAAI';

/** GitHub's own ceilings. Exceeding any of them is a 422, not a truncation. */
const MAX_OUTPUT_TITLE = 255;
const MAX_OUTPUT_SUMMARY = 65_535;
const MAX_OUTPUT_TEXT = 65_535;
const MAX_ANNOTATION_MESSAGE = 4_000; // GitHub allows 64KB; this stays readable.
const MAX_ANNOTATION_TITLE = 255;
/** GitHub accepts at most 50 annotations per request. More means more requests. */
export const ANNOTATIONS_PER_REQUEST = 50;
/** Two requests' worth. Past this nobody is reading, and the text says so. */
export const MAX_ANNOTATIONS = 100;

/** A provider that has not answered in this long is not going to. */
const REQUEST_TIMEOUT_MS = 15_000;

/** GitHub rejects an app JWT older than 10 minutes; 9 leaves room for clock skew. */
const JWT_LIFETIME_SECONDS = 540;
/** Backdated, because GitHub rejects a JWT whose `iat` is in ITS future. */
const JWT_CLOCK_SKEW_SECONDS = 60;

/** Renew an installation token this long before it expires (they last an hour). */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Carries a message that is already safe to show a human and says what to fix.
 * `kind` decides how a caller reacts: UNCONFIGURED means do nothing at all,
 * CONFIG means this deployment is wrong, PROVIDER means GitHub refused us.
 */
export class GithubAppError extends Error {
  constructor(
    message: string,
    readonly kind: 'UNCONFIGURED' | 'CONFIG' | 'PROVIDER' = 'CONFIG',
  ) {
    super(message);
    this.name = 'GithubAppError';
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * The vault name the app's private key is sealed under.
 *
 * The AAD binds a ciphertext to `<orgId>:<name>`, and a GitHub App is a property
 * of the DEPLOYMENT rather than of any one tenant — installations are per-org,
 * the app itself is not. So the org half is a sentinel that no cuid can ever
 * equal, which keeps the binding meaningful (this ciphertext is the deployment's
 * app key and nothing else) without inventing a fake org row.
 */
export const APP_KEY_VAULT_ORG = '@deployment';
export const APP_KEY_VAULT_NAME = 'github-app:private-key';

/** apps/api/src/lib/vault.ts `open`, and the worker's mirror of it. */
export type Unsealer = (
  ciphertext: string,
  keyVersion: number,
  orgId: string,
  name: string,
) => string;

export interface AppConfig {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * A PEM as it survives a `.env` file.
 *
 * Two shapes reach us and both are the operator doing the reasonable thing:
 * base64 of the whole PEM (one line, no quoting problems), or the PEM itself
 * with its newlines escaped as `\n`. Neither is a security decision — the bytes
 * are identical either way — so accept both rather than making the feature turn
 * on whether someone's shell ate a newline.
 */
export function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('-----BEGIN')) return trimmed.replace(/\\n/g, '\n');

  let decoded = '';
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    return '';
  }
  return decoded.includes('-----BEGIN') ? decoded.trim() : '';
}

/**
 * Read the app's configuration, unsealing the private key through `unseal`.
 *
 * Returns null when nothing is configured — that is the supported state, not an
 * error, and it is what keeps the PAT comment path working untouched. It throws
 * only when configuration is HALF present, because a check run that silently
 * never appears reads to a reviewer as a green build.
 *
 * The key is preferred from the vault (`GITHUB_APP_PRIVATE_KEY_ENC`), which is
 * where a secret belongs. `GITHUB_APP_PRIVATE_KEY` is accepted as a deployment
 * secret in the same class as `STRIPE_SECRET_KEY` and `VAULT_MASTER_KEY`, both
 * of which this repo already reads from the environment — a vault that cannot
 * be populated without first having a vault is not a policy, it is a deadlock.
 */
export function loadAppConfig(unseal: Unsealer, source: EnvLike = process.env): AppConfig | null {
  const appId = (source.GITHUB_APP_ID ?? '').trim();
  const sealedKey = (source.GITHUB_APP_PRIVATE_KEY_ENC ?? '').trim();
  const rawKey = (source.GITHUB_APP_PRIVATE_KEY ?? '').trim();
  const webhookSecret = (source.GITHUB_APP_WEBHOOK_SECRET ?? '').trim();

  if (!appId && !sealedKey && !rawKey) return null;

  if (!appId) {
    throw new GithubAppError(
      'A GitHub App private key is configured but GITHUB_APP_ID is not — set it to the numeric App ID from the app’s settings page.',
    );
  }
  if (!/^\d{1,20}$/.test(appId)) {
    throw new GithubAppError(
      'GITHUB_APP_ID must be the numeric App ID (not the client id or the slug).',
    );
  }

  let privateKeyPem = '';
  if (sealedKey) {
    const keyVersion = Number(source.GITHUB_APP_KEY_VERSION ?? '1');
    try {
      privateKeyPem = normalizePem(
        unseal(
          sealedKey,
          Number.isFinite(keyVersion) ? keyVersion : 1,
          APP_KEY_VAULT_ORG,
          APP_KEY_VAULT_NAME,
        ),
      );
    } catch {
      // Never echo the vault's error: it names the secret and this message can
      // reach a response body.
      throw new GithubAppError(
        'GITHUB_APP_PRIVATE_KEY_ENC could not be unsealed — it must be sealed with this deployment’s VAULT_MASTER_KEY under "@deployment:github-app:private-key".',
      );
    }
  } else {
    privateKeyPem = normalizePem(rawKey);
  }

  if (!privateKeyPem) {
    throw new GithubAppError(
      'The GitHub App private key is missing or unreadable — set GITHUB_APP_PRIVATE_KEY_ENC (vault ciphertext) or GITHUB_APP_PRIVATE_KEY to the .pem GitHub gave you.',
    );
  }

  return { appId, privateKeyPem, webhookSecret };
}

// ─── App JWT ─────────────────────────────────────────────────────────────────

const b64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).toString('base64url');

/**
 * A short-lived RS256 JWT that authenticates as the APP itself.
 *
 * node:crypto rather than a JWT library, deliberately: this is two base64url
 * segments and one `createSign`, and a new dependency in the request path of a
 * credential is a poor trade for saving eight lines.
 *
 * This token is strictly more powerful than an installation token — it can mint
 * one for any installation — so it is created per call, lives nine minutes, is
 * never cached and never leaves this module.
 */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
  const issued = Math.floor(nowMs / 1000) - JWT_CLOCK_SKEW_SECONDS;
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iat: issued, exp: issued + JWT_LIFETIME_SECONDS, iss: appId }),
  )}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();

  let signature: Buffer;
  try {
    signature = signer.sign(privateKeyPem);
  } catch {
    // The caught error is discarded rather than wrapped: OpenSSL failures here
    // are about key material, and this message is shown to a human.
    throw new GithubAppError(
      'The GitHub App private key could not sign — it must be the unencrypted RSA .pem GitHub issued for this app.',
    );
  }

  return `${signingInput}.${b64url(signature)}`;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface GithubResponse {
  status: number;
  json: unknown;
}

/**
 * Build an api.github.com URL, and prove it is one.
 *
 * The host is a literal, so the only way off it would be a path that a URL
 * parser reinterprets. The `..` ban stops that at the source and the re-parse
 * after construction stops anything the ban missed — the SSRF this codebase
 * already fixed got through because one guard looked sufficient.
 */
function apiUrl(path: string): string {
  if (!path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('//')) {
    throw new GithubAppError(`Refusing to call GitHub with a malformed path.`, 'CONFIG');
  }
  const url = `https://${GITHUB_API_HOST}${path}`;
  if (new URL(url).hostname !== GITHUB_API_HOST) {
    throw new GithubAppError('Refusing to send a GitHub credential off api.github.com.', 'CONFIG');
  }
  return url;
}

/** Digits or refused: both of these are interpolated into a URL path. */
function numericId(value: string | number, what: string): string {
  const raw = String(value);
  if (!/^\d{1,20}$/.test(raw)) {
    throw new GithubAppError(`"${redactSecrets(raw)}" is not a valid GitHub ${what}.`, 'CONFIG');
  }
  return raw;
}

/**
 * One request, with the rules that matter applied in one place: the pinned host,
 * no redirect while holding a credential, a hard timeout, and a response that is
 * parsed defensively and never logged.
 */
async function githubJson(
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PATCH';
    token: string;
    body?: unknown;
    fetchImpl?: FetchLike;
  },
): Promise<GithubResponse> {
  const url = apiUrl(path);
  const doFetch = init.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        // The token travels in a header. It must never travel in `path`.
        authorization: `Bearer ${init.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'qaai',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Non-negotiable: a 3xx must surface as an error rather than re-sending
      // the Authorization header to whatever Location names.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? `did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
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

  return { status: response.status, json };
}

function pick(json: unknown, key: string): unknown {
  return json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
}

/** A sentence per failure shape, saying what the operator has to change. */
export function describeFailure(status: number, what: string): string {
  if (status === 401) {
    return `GitHub rejected the app credential (401) while ${what}. Check GITHUB_APP_ID and that the private key belongs to that app.`;
  }
  if (status === 403) {
    return `GitHub refused the request (403) while ${what}. The app needs the "Checks: write" permission — re-accept its permissions on the installation.`;
  }
  if (status === 404) {
    return `GitHub returned 404 while ${what}. The app is probably not installed on that repository any more.`;
  }
  if (status === 422) {
    return `GitHub rejected the check run (422) while ${what}. The head SHA is not on that repository, or an annotation points outside it.`;
  }
  if (status === 429) {
    return `GitHub is rate-limiting QAAI while ${what}. It will be retried.`;
  }
  if (status >= 500) {
    return `GitHub returned ${status} while ${what} — their API is having trouble. It will be retried.`;
  }
  return `GitHub returned an unexpected ${status} while ${what}.`;
}

// ─── Installation tokens ─────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  /** Epoch ms at which this token stops being usable. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Tests only: the cache is process-global and would leak between cases. */
export function _resetTokenCache(): void {
  tokenCache.clear();
}

/**
 * An installation access token, cached until shortly before it expires.
 *
 * GitHub issues these for an hour and rate-limits the mint endpoint, so minting
 * one per check-run update would be both slow and rude. The margin exists
 * because a token that expires in flight fails a check run that had already
 * passed — the cache is refreshed early rather than at the boundary.
 *
 * The token is returned to the caller and held nowhere else. It is never logged,
 * never put in a URL, and never included in an error message.
 */
export async function installationToken(
  cfg: AppConfig,
  installationId: string,
  opts: { fetchImpl?: FetchLike; nowMs?: number } = {},
): Promise<string> {
  const id = numericId(installationId, 'installation id');
  const now = opts.nowMs ?? Date.now();
  const key = `${cfg.appId}:${id}`;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.token;

  const { status, json } = await githubJson(`/app/installations/${id}/access_tokens`, {
    method: 'POST',
    token: appJwt(cfg.appId, cfg.privateKeyPem, now),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (status !== 201) {
    // 404 here is the uninstall case and the caller is expected to forget the
    // installation id rather than retry it forever.
    throw new GithubAppError(
      describeFailure(status, 'minting an installation token'),
      status === 401 || status === 404 ? 'CONFIG' : 'PROVIDER',
    );
  }

  const token = pick(json, 'token');
  const expiresAt = pick(json, 'expires_at');
  if (typeof token !== 'string' || !token) {
    throw new GithubAppError('GitHub returned an installation token QAAI could not read.', 'PROVIDER');
  }

  const parsedExpiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  tokenCache.set(key, {
    token,
    // An unparseable expiry means the shortest safe assumption, not the longest.
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + 5 * 60_000,
  });

  return token;
}

/** Forget a cached token — used when GitHub says the installation is gone. */
export function forgetInstallation(appId: string, installationId: string): void {
  tokenCache.delete(`${appId}:${installationId}`);
}

// ─── What a check run says ───────────────────────────────────────────────────

export interface CheckFailure {
  test: { name: string; filePath: string; code: string | null };
  status: string;
  errorMessage: string | null;
  step: {
    index: number;
    title: string;
    selector: string | null;
    expected: string | null;
    actual: string | null;
    errorMessage: string | null;
    errorStack: string | null;
  } | null;
  verdict: { verdict: string; confidence: number; explanation: string } | null;
  /** A heal proposal exists for this test — "with a fix proposed" is earned. */
  fixProposed: boolean;
}

export interface CheckEvidence {
  run: {
    id: string;
    status: string;
    commitSha: string;
    prNumber: number | null;
    passedCount: number;
    failedCount: number;
    flakyCount: number;
    totalCount: number;
    errorMessage: string | null;
    /** GateResult.passed === false: the gate is blocking this PR. */
    gateBlocking: boolean;
  };
  environment: { name: string; kind: string } | null;
  failures: CheckFailure[];
  /** Cockpit origin, for the link out of the merge box. */
  webUrl: string;
}

const VERDICT_LABEL: Record<string, string> = {
  REAL_BUG: '🐞 likely a real bug',
  INTENDED_CHANGE: '🔁 an intended change',
  FLAKE: '🎲 a flake',
  ENV_ISSUE: '🌐 an environment issue',
};

/** Verdicts that mean "a human should look at the code", not "ignore this". */
const BLOCKING_VERDICTS = new Set(['REAL_BUG']);

/**
 * The sentence the whole feature exists for.
 *
 * "3 failed" makes a reviewer open QAAI. "2 look like real bugs, 1 is an
 * intended change with a fix proposed" lets them act without leaving GitHub — so
 * this reports the triage, and only falls back to counting when triage has not
 * happened yet. An untriaged failure is called untriaged rather than being
 * quietly rolled into one of the buckets: pretending to know is the one thing
 * this must not do.
 */
export function summarizeTriage(failures: readonly CheckFailure[]): string {
  if (failures.length === 0) return 'No failures.';

  const counts = new Map<string, number>();
  let fixes = 0;
  for (const f of failures) {
    const key = f.verdict?.verdict ?? 'UNTRIAGED';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (f.verdict?.verdict === 'INTENDED_CHANGE' && f.fixProposed) fixes += 1;
  }

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts: string[] = [];

  const bugs = counts.get('REAL_BUG') ?? 0;
  if (bugs) parts.push(`${bugs} ${plural(bugs, 'looks like a real bug', 'look like real bugs')}`);

  const intended = counts.get('INTENDED_CHANGE') ?? 0;
  if (intended) {
    const tail = fixes > 0 ? ` with ${plural(fixes, 'a fix', 'fixes')} proposed` : '';
    parts.push(
      `${intended} ${plural(intended, 'is an intended change', 'are intended changes')}${tail}`,
    );
  }

  const flakes = counts.get('FLAKE') ?? 0;
  if (flakes) parts.push(`${flakes} ${plural(flakes, 'is flaky', 'are flaky')}`);

  const env = counts.get('ENV_ISSUE') ?? 0;
  if (env) {
    parts.push(`${env} ${plural(env, 'is an environment issue', 'are environment issues')}`);
  }

  const untriaged = counts.get('UNTRIAGED') ?? 0;
  if (untriaged) {
    parts.push(`${untriaged} ${plural(untriaged, 'is', 'are')} not triaged yet`);
  }

  return `${parts.join(', ')}.`;
}

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required';

/**
 * Which colour the merge box gets.
 *
 * The gate is the authority — if it blocked, this is red, whatever triage
 * thought, because the gate is the rule the org wrote down. Below that, the
 * distinction worth drawing is between a failure someone must act on and a
 * failure QAAI has already explained:
 *
 *   • any untriaged or REAL_BUG failure  → failure
 *   • only flakes / intended changes / env issues → neutral
 *
 * `neutral` rather than `success` is deliberate. A flake is not a pass, and
 * showing green for one teaches people that green means nothing; neutral does
 * not block a merge but does keep the finding visible.
 */
export function conclusionFor(e: CheckEvidence): CheckConclusion {
  if (e.run.status === 'CANCELLED') return 'cancelled';
  // A run that blew up measured nothing. Saying "success" would be a lie and
  // saying "failure" would blame the PR for QAAI's own outage.
  if (e.run.status === 'ERRORED') return 'action_required';

  if (e.run.gateBlocking) return 'failure';
  if (e.failures.length === 0) return 'success';

  const actionable = e.failures.some(
    (f) => !f.verdict || BLOCKING_VERDICTS.has(f.verdict.verdict),
  );
  if (actionable) {
    return e.failures.every((f) => f.status === 'TIMED_OUT') ? 'timed_out' : 'failure';
  }
  return 'neutral';
}

export interface CheckOutput {
  title: string;
  summary: string;
  text: string;
}

const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function fence(text: string): string[] {
  // Guard the fence itself: an error message containing ``` would break out.
  return ['```', text.replace(/```/g, "''`"), '```'];
}

/** The check's title, summary and body. Pure, so the wording is testable. */
export function buildCheckOutput(e: CheckEvidence): CheckOutput {
  const failures = e.failures;
  const title = (
    failures.length === 0
      ? `${e.run.passedCount} passed`
      : `${failures.length} failed — ${summarizeTriage(failures)}`
  ).slice(0, MAX_OUTPUT_TITLE);

  const summaryLines: string[] = [];
  if (e.run.status === 'ERRORED') {
    summaryLines.push(
      '**The run did not finish.** QAAI could not measure this commit, so this check is not a verdict on the change.',
      '',
    );
    if (e.run.errorMessage) summaryLines.push(...fence(e.run.errorMessage.slice(0, 1_000)), '');
  }
  if (e.run.gateBlocking) {
    summaryLines.push('> **The quality gate is blocking this PR.**', '');
  }
  summaryLines.push(
    `**${summarizeTriage(failures)}**`,
    '',
    `| | |`,
    `|---|---|`,
    `| Result | ${e.run.passedCount} passed · ${e.run.failedCount} failed · ${e.run.flakyCount} flaky · ${e.run.totalCount} total |`,
  );
  if (e.environment) {
    summaryLines.push(`| Environment | ${cell(e.environment.name)} (${cell(e.environment.kind)}) |`);
  }
  summaryLines.push(`| Commit | \`${cell(e.run.commitSha.slice(0, 7))}\` |`, '');
  if (e.run.flakyCount > 0) {
    summaryLines.push(
      `_${e.run.flakyCount} test(s) passed only on retry and are counted as flaky._`,
      '',
    );
  }
  summaryLines.push(`[Open the full run in QAAI](${e.webUrl}/runs/${e.run.id})`);

  const textLines: string[] = [];
  for (const f of failures.slice(0, MAX_ANNOTATIONS)) {
    textLines.push(`### ${cell(f.test.name)}`, `\`${cell(f.test.filePath)}\` — ${cell(f.status)}`);
    if (f.verdict) {
      const label = VERDICT_LABEL[f.verdict.verdict] ?? f.verdict.verdict;
      textLines.push(
        '',
        `**Triage: ${label}** (${Math.round(f.verdict.confidence * 100)}% confident)`,
        `> ${f.verdict.explanation.split('\n')[0] ?? ''}`,
      );
      if (f.verdict.verdict === 'INTENDED_CHANGE' && f.fixProposed) {
        textLines.push('> A fix is proposed in QAAI — review it there and it becomes a PR.');
      }
    } else {
      textLines.push('', '_Not triaged yet._');
    }
    if (f.errorMessage) {
      textLines.push('', ...fence(f.errorMessage.split('\n').slice(0, 4).join('\n').slice(0, 800)));
    }
    textLines.push('');
  }
  if (failures.length > MAX_ANNOTATIONS) {
    textLines.push(`_…and ${failures.length - MAX_ANNOTATIONS} more failures. Open the run._`);
  }

  return {
    title,
    summary: summaryLines.join('\n').slice(0, MAX_OUTPUT_SUMMARY),
    text: textLines.join('\n').slice(0, MAX_OUTPUT_TEXT),
  };
}

// ─── Annotations ─────────────────────────────────────────────────────────────

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A repo-relative path GitHub will accept.
 *
 * An annotation on a path outside the repository is a 422 that fails the whole
 * update, so a leading slash or `./` is normalised away and anything still
 * absolute or escaping upward is refused by the caller rather than sent.
 */
export function annotationPath(filePath: string): string | null {
  const trimmed = filePath.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!trimmed || trimmed.includes('..') || /^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Which line to point at — the one thing a PR comment cannot do.
 *
 * In order of how much it is worth: the line the runner's own stack trace named,
 * then the line in the test source that holds the locator that failed, then the
 * line holding the failing step's title. If none of them resolve, line 1, which
 * annotates the file rather than the wrong statement. Guessing a plausible-looking
 * line is worse than annotating the top of the file: a wrong line is read as fact.
 */
export function annotationLine(input: {
  code: string | null;
  filePath: string;
  errorText: string | null;
  selector: string | null;
  stepTitle: string | null;
}): number {
  const lines = input.code ? input.code.split('\n') : null;
  const clamp = (n: number) => Math.max(1, lines ? Math.min(n, lines.length) : n);

  if (input.errorText) {
    const base = input.filePath.split('/').pop() ?? input.filePath;
    // `at /tmp/.qaai-runs/x/checkout.spec.ts:42:9` — the runner writes an
    // absolute path into a workspace that no longer exists, so match on the
    // file NAME and take the line number that follows it.
    const match = new RegExp(`${escapeRegExp(base)}:(\\d+)(?::\\d+)?`).exec(input.errorText);
    const line = match?.[1] ? Number(match[1]) : Number.NaN;
    if (Number.isInteger(line) && line > 0) return clamp(line);
  }

  if (lines) {
    for (const needle of [input.selector, input.stepTitle]) {
      if (!needle || needle.length < 3) continue;
      const index = lines.findIndex((l) => l.includes(needle));
      if (index >= 0) return index + 1;
    }
  }

  return 1;
}

/** REAL_BUG and untriaged are failures; an explained failure is a warning. */
function levelFor(f: CheckFailure): CheckAnnotation['annotation_level'] {
  if (!f.verdict) return 'failure';
  return BLOCKING_VERDICTS.has(f.verdict.verdict) ? 'failure' : 'warning';
}

export function buildAnnotations(e: CheckEvidence): CheckAnnotation[] {
  const out: CheckAnnotation[] = [];

  for (const f of e.failures) {
    const path = annotationPath(f.test.filePath);
    // No usable path means no annotation — and the failure is still in the
    // output text, so nothing is lost except the inline marker.
    if (!path) continue;
    if (out.length >= MAX_ANNOTATIONS) break;

    const errorText = f.step?.errorStack ?? f.step?.errorMessage ?? f.errorMessage;
    const line = annotationLine({
      code: f.test.code,
      filePath: path,
      errorText,
      selector: f.step?.selector ?? null,
      stepTitle: f.step?.title ?? null,
    });

    const message: string[] = [];
    if (f.verdict) {
      const label = VERDICT_LABEL[f.verdict.verdict] ?? f.verdict.verdict;
      message.push(
        `QAAI triage: ${label} (${Math.round(f.verdict.confidence * 100)}% confident)`,
        f.verdict.explanation.split('\n')[0] ?? '',
        '',
      );
    }
    if (f.step) {
      message.push(`Failing step ${f.step.index + 1}: ${f.step.title}`);
      if (f.step.selector) message.push(`Locator: ${f.step.selector}`);
      if (f.step.expected) message.push(`Expected: ${f.step.expected}`);
      if (f.step.actual) message.push(`Actual: ${f.step.actual}`);
      message.push('');
    }
    if (f.errorMessage) message.push(f.errorMessage);

    out.push({
      path,
      start_line: line,
      end_line: line,
      annotation_level: levelFor(f),
      // Annotation text is provider-bound and derived from a customer's test
      // output; run it through the same redactor the issue path uses.
      message: redactSecrets(message.join('\n').trim() || 'This test failed.').slice(
        0,
        MAX_ANNOTATION_MESSAGE,
      ),
      title: `${f.test.name} — ${f.status}`.slice(0, MAX_ANNOTATION_TITLE),
    });
  }

  return out;
}

/** GitHub takes 50 annotations per request; the rest ride on follow-up PATCHes. */
export function chunkAnnotations(
  annotations: readonly CheckAnnotation[],
  size = ANNOTATIONS_PER_REQUEST,
): CheckAnnotation[][] {
  const chunks: CheckAnnotation[][] = [];
  for (let i = 0; i < annotations.length; i += size) {
    chunks.push(annotations.slice(i, i + size));
  }
  return chunks;
}

// ─── The re-run button ───────────────────────────────────────────────────────

/**
 * The requested action GitHub renders as a button on the check.
 *
 * GitHub's limits are 20/40/20 characters and at most three actions; exceeding
 * any of them is a 422 on the whole check run, so the strings are constants and
 * the test asserts their length rather than trusting a future edit.
 */
export const RERUN_ACTION_ID = 'qaai-rerun';

export const RERUN_ACTION = {
  label: 'Re-run with QAAI',
  description: 'Run the QAAI suite on this commit again',
  identifier: RERUN_ACTION_ID,
} as const;

// ─── Check-run calls ─────────────────────────────────────────────────────────

export interface CheckRunRef {
  id: number;
  /** Human-facing link, so a caller can log or store where the check lives. */
  url: string | null;
}

/** The fields both a create and an update accept. */
export interface CheckRunBody {
  status: 'queued' | 'in_progress' | 'completed';
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
  conclusion?: CheckConclusion;
  output?: CheckOutput & { annotations?: CheckAnnotation[] };
  withRerunAction?: boolean;
}

/** A create additionally has to say WHICH commit it is about, and for which run. */
export interface CreateParams extends CheckRunBody {
  headSha: string;
  externalId: string;
  detailsUrl: string;
}

function checkRunRef(json: unknown, what: string): CheckRunRef {
  const id = pick(json, 'id');
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new GithubAppError(`GitHub accepted the check run but did not return its id (${what}).`, 'PROVIDER');
  }
  const url = pick(json, 'html_url');
  return { id, url: typeof url === 'string' ? url : null };
}

/** A 40-hex commit sha, or refused — it is interpolated into a URL path. */
function commitSha(sha: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new GithubAppError(`"${redactSecrets(sha)}" is not a commit SHA.`, 'CONFIG');
  }
  return sha;
}

export async function createCheckRun(
  token: string,
  repo: string,
  params: CreateParams,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CheckRunRef> {
  const slug = githubRepoSlug(repo);
  const { status, json } = await githubJson(`/repos/${slug}/check-runs`, {
    method: 'POST',
    token,
    body: {
      name: CHECK_NAME,
      head_sha: commitSha(params.headSha),
      status: params.status,
      external_id: params.externalId,
      details_url: params.detailsUrl,
      ...(params.startedAt ? { started_at: params.startedAt } : {}),
      ...(params.completedAt ? { completed_at: params.completedAt } : {}),
      ...(params.conclusion ? { conclusion: params.conclusion } : {}),
      ...(params.output ? { output: params.output } : {}),
      ...(params.withRerunAction ? { actions: [RERUN_ACTION] } : {}),
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (status !== 201) {
    throw new GithubAppError(describeFailure(status, 'creating the check run'), 'PROVIDER');
  }
  return checkRunRef(json, 'create');
}

export async function updateCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  params: CheckRunBody,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CheckRunRef> {
  const slug = githubRepoSlug(repo);
  const id = numericId(checkRunId, 'check run id');
  const { status, json } = await githubJson(`/repos/${slug}/check-runs/${id}`, {
    method: 'PATCH',
    token,
    body: {
      name: CHECK_NAME,
      status: params.status,
      ...(params.detailsUrl ? { details_url: params.detailsUrl } : {}),
      ...(params.completedAt ? { completed_at: params.completedAt } : {}),
      ...(params.conclusion ? { conclusion: params.conclusion } : {}),
      ...(params.output ? { output: params.output } : {}),
      ...(params.withRerunAction ? { actions: [RERUN_ACTION] } : {}),
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (status !== 200) {
    throw new GithubAppError(describeFailure(status, 'updating the check run'), 'PROVIDER');
  }
  return checkRunRef(json, 'update');
}

/**
 * Find the check run QAAI already created for a run.
 *
 * The cache in Redis is the fast path; this is what makes losing it harmless.
 * `external_id` carries the QAAI run id, so the match is exact rather than
 * "the most recent check called QAAI" — a re-run and its original are both
 * called QAAI, and picking the wrong one would rewrite a finished check.
 */
export async function findCheckRun(
  token: string,
  repo: string,
  headSha: string,
  externalId: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<CheckRunRef | null> {
  const slug = githubRepoSlug(repo);
  const { status, json } = await githubJson(
    `/repos/${slug}/commits/${commitSha(headSha)}/check-runs?check_name=${CHECK_NAME}&per_page=100`,
    { method: 'GET', token, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
  );

  // A miss must not be fatal: the caller creates a fresh check run instead, and
  // a duplicate check is a far smaller harm than a run that reports nothing.
  if (status !== 200) return null;

  const runs = pick(json, 'check_runs');
  if (!Array.isArray(runs)) return null;

  for (const entry of runs) {
    if (pick(entry, 'external_id') !== externalId) continue;
    const id = pick(entry, 'id');
    if (typeof id !== 'number') continue;
    const url = pick(entry, 'html_url');
    return { id, url: typeof url === 'string' ? url : null };
  }
  return null;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * GitHub signs with `sha256=<hex hmac of the raw body>`.
 *
 * Copied verbatim from apps/api/src/routes/webhooks.ts — deliberately, rather
 * than written afresh. A second, subtly different signature check is how one of
 * the two ends up using `===` and leaking the signature a byte at a time to the
 * only person who is already sending requests. When one of these files can own
 * the other, this should be hoisted into a single exported helper and imported
 * in both places; until then the duplication is the safer of the two mistakes.
 */
export function webhookSignatureMatches(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface InstallationEvent {
  action: string;
  installationId: string | null;
  account: string | null;
  /** Repos this event ADDS, as `owner/name`. */
  added: string[];
  /** Repos this event REMOVES. */
  removed: string[];
  /** True when the whole installation went away or was suspended. */
  revokesAll: boolean;
}

/**
 * Read an `installation` / `installation_repositories` payload.
 *
 * The app has to know which repositories it can see, and the only trustworthy
 * source for that is this event. Every repo name goes through `githubRepoSlug`
 * before it leaves here: these strings end up in database lookups and, later, in
 * URL paths, and they arrive from the network.
 */
export function parseInstallationEvent(payload: unknown): InstallationEvent {
  const action = str(pick(payload, 'action')) ?? '';
  const installation = pick(payload, 'installation');
  const rawId = pick(installation, 'id');
  const installationId =
    typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : null;

  const account = str(pick(pick(installation, 'account'), 'login'));

  const slugs = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const repo of value) {
      const full = str(pick(repo, 'full_name'));
      if (!full) continue;
      try {
        out.push(githubRepoSlug(full));
      } catch {
        // A name this parser refuses is a name we will not query with.
      }
    }
    return out;
  };

  // `installation` carries `repositories`; `installation_repositories` carries
  // the two deltas. Reading all three keeps one parser for both events.
  const listed = slugs(pick(payload, 'repositories'));
  const added = [...listed, ...slugs(pick(payload, 'repositories_added'))];
  const removed = slugs(pick(payload, 'repositories_removed'));

  const revokesAll = ['deleted', 'suspend'].includes(action);

  return {
    action,
    installationId: installationId && /^\d{1,20}$/.test(installationId) ? installationId : null,
    account,
    added: revokesAll ? [] : added,
    removed,
    revokesAll,
  };
}

export interface CheckRunEvent {
  action: string;
  repoFullName: string | null;
  headSha: string | null;
  /** The QAAI run id this check was created for, when we created it. */
  externalId: string | null;
  checkRunId: number | null;
  installationId: string | null;
  /** Set when the reviewer pressed one of our buttons. */
  requestedAction: string | null;
  prNumbers: number[];
}

/** Read a `check_run` / `check_suite` payload. Same defensive rules as above. */
export function parseCheckRunEvent(payload: unknown): CheckRunEvent {
  const checkRun = pick(payload, 'check_run') ?? pick(payload, 'check_suite');

  let repoFullName: string | null = null;
  const rawRepo = str(pick(pick(payload, 'repository'), 'full_name'));
  if (rawRepo) {
    try {
      repoFullName = githubRepoSlug(rawRepo);
    } catch {
      repoFullName = null;
    }
  }

  const rawInstallation = pick(pick(payload, 'installation'), 'id');
  const installationId =
    typeof rawInstallation === 'number' || typeof rawInstallation === 'string'
      ? String(rawInstallation)
      : null;

  const pulls = pick(checkRun, 'pull_requests');
  const prNumbers = Array.isArray(pulls)
    ? pulls
        .map((p) => pick(p, 'number'))
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    : [];

  const id = pick(checkRun, 'id');
  const sha = str(pick(checkRun, 'head_sha'));

  return {
    action: str(pick(payload, 'action')) ?? '',
    repoFullName,
    headSha: sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null,
    externalId: str(pick(checkRun, 'external_id')),
    checkRunId: typeof id === 'number' && Number.isInteger(id) ? id : null,
    installationId: installationId && /^\d{1,20}$/.test(installationId) ? installationId : null,
    requestedAction: str(pick(pick(payload, 'requested_action'), 'identifier')),
    prNumbers,
  };
}

/** Actions that mean "a human asked for this suite to run again". */
export function isRerunRequest(event: CheckRunEvent): boolean {
  if (event.action === 'rerequested') return true;
  return event.action === 'requested_action' && event.requestedAction === RERUN_ACTION_ID;
}
