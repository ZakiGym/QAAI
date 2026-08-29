/**
 * File a failing test as a bug in the customer's tracker (§7).
 *
 * Three providers, one shape: build the issue text from the run, then POST it
 * with a token unsealed from the vault. GitHub and Linear have exactly one API
 * host each; Jira is the only one that may legitimately be self-hosted.
 *
 * SECURITY — everything here is arranged around one fact: the request carries a
 * customer's personal access token in an Authorization header, and the
 * destination is read from a config row that an org admin can edit.
 *
 *  - The API host is a constant per provider (`API_HOST` below). A configured
 *    repo/URL is only ever used to derive a PATH; it can never choose the host.
 *    Jira, which has no single host, is validated instead: https only, no
 *    embedded credentials, no IP literal, no loopback/internal name.
 *  - Every request is `redirect: 'manual'`. A 3xx is an error, not a hop —
 *    following one would re-send the Authorization header to whatever host the
 *    Location pointed at, which is precisely how a PAT walks out of the
 *    building.
 *  - The destination is validated before the caller decrypts anything, so a
 *    repointed integration fails while the token is still ciphertext.
 *  - No token and no response body is ever logged or returned. The only
 *    provider text that reaches the user is a status-derived sentence written
 *    here, plus (for Linear's GraphQL, which reports failure in a 200) a
 *    redacted error message.
 */

/** The subset of IntegrationKind that can receive a bug. */
export const ISSUE_TRACKER_KINDS = ['GITHUB', 'JIRA', 'LINEAR'] as const;
export type IssueTrackerKind = (typeof ISSUE_TRACKER_KINDS)[number];

export function isIssueTrackerKind(kind: string): kind is IssueTrackerKind {
  return (ISSUE_TRACKER_KINDS as readonly string[]).includes(kind);
}

/** How each provider spells its own name. Every user-facing message uses this. */
export const TRACKER_LABEL: Record<IssueTrackerKind, string> = {
  GITHUB: 'GitHub',
  JIRA: 'Jira',
  LINEAR: 'Linear',
};

/**
 * Pinned API hosts. Never derived from config — see the security note above.
 * GitHub Enterprise Server and Jira-behind-a-gateway are deliberately absent:
 * supporting them means letting config choose the host, which is the exact bug
 * this module exists to not have.
 */
const API_HOST: Record<'GITHUB' | 'LINEAR', string> = {
  GITHUB: 'api.github.com',
  LINEAR: 'api.linear.app',
};

const GITHUB_WEB_HOST = 'github.com';

/** Provider-side ceilings. GitHub allows 65536; Jira text fields stop at 32767. */
const MAX_TITLE = 200;
const MAX_BODY = 30_000;
const MAX_ERROR_SNIPPET = 4_000;

/** A provider that has not answered in this long is not going to. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Carries a message that is already safe to show the user and says what to fix.
 * `kind` only decides which HTTP status the route maps it to: CONFIG means the
 * org's integration is wrong, PROVIDER means the tracker refused us.
 */
export class IssueFilingError extends Error {
  constructor(
    message: string,
    readonly kind: 'CONFIG' | 'PROVIDER' = 'CONFIG',
  ) {
    super(message);
    this.name = 'IssueFilingError';
  }
}

/**
 * Anything long enough to be a credential is removed before a provider-authored
 * string is shown or audited. Same rule as the git push handler: provider output
 * can echo the request, and the request carried the token.
 */
export function redactSecrets(text: string): string {
  return text.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * The non-secret half of an issue-tracker integration, as stored on
 * `Integration.config`. The token lives in `configEnc`; `keyVersion` rides along
 * so the vault master key can rotate.
 *
 *   GITHUB  { repo: "owner/name", labels?: string[] }
 *   JIRA    { baseUrl: "https://acme.atlassian.net", projectKey: "QA",
 *             issueType?: "Bug", email?: "bot@acme.com" }
 *   LINEAR  { teamId: "<uuid>", labelIds?: string[] }
 */
export type IssueTrackerConfig =
  | { kind: 'GITHUB'; repo: string; labels: string[]; keyVersion: number }
  | {
      kind: 'JIRA';
      /** Origin (plus context path for Data Center), already validated and normalised. */
      site: string;
      projectKey: string;
      issueType: string;
      /** Set for Jira Cloud, where auth is Basic email:apiToken. Null for a DC PAT. */
      email: string | null;
      keyVersion: number;
    }
  | { kind: 'LINEAR'; teamId: string; labelIds: string[]; keyVersion: number };

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `owner/name` from either a bare slug or a github.com URL.
 *
 * The host check is load-bearing rather than cosmetic: the returned slug is
 * interpolated straight into a path on api.github.com, so a URL pointing at
 * another host must be rejected here and not silently reinterpreted as a path
 * on GitHub's API — an admin who typed the wrong host deserves to be told, and
 * an admin who typed a hostile one must not be obeyed.
 */
export function githubRepoSlug(repo: string): string {
  const raw = repo.trim().replace(/\.git$/, '');
  if (!raw) throw new IssueFilingError('That GitHub integration has no repository configured.');

  let slug = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      // Deliberately does NOT echo `raw`. An unparseable value is exactly
      // where a pasted `https://user:ghp_…@github .com/o/r` ends up, and the
      // parse-failure path is not covered by the response redactor.
      throw new IssueFilingError('That repository URL could not be parsed.');
    }
    if (url.hostname !== GITHUB_WEB_HOST) {
      throw new IssueFilingError(
        `Refusing to file an issue on ${url.hostname}: a GitHub integration may only file on ${GITHUB_WEB_HOST}.`,
      );
    }
    if (url.username || url.password) {
      throw new IssueFilingError(
        'Remove the credentials from the repository URL — the token is stored separately.',
      );
    }
    slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  /*
   * `.` and `..` must be rejected explicitly.
   *
   * The character class contains `.`, so `../..` satisfied the pattern, and the
   * URL parser then resolved the dot segments away — `repos/../../issues`
   * became `POST https://api.github.com/issues`, carrying the PAT. The host was
   * still pinned so no token could leak off-host, but the module's stated
   * invariant is that a configured repo can only ever choose a repo PATH, and
   * without this it was not true.
   */
  const segments = slug.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new IssueFilingError(
      `"${repo}" is not an owner/repository pair — set it to something like "acme/storefront".`,
    );
  }

  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
    throw new IssueFilingError(
      `"${repo}" is not an owner/repository pair — set it to something like "acme/storefront".`,
    );
  }
  return slug;
}

/** Names that must never receive an Authorization header from a server process. */
/**
 * Names that resolve inside a private network and must never receive a token.
 *
 * `.svc`, `.cluster.local`, `.lan` and friends were missing, and that mattered:
 * this API commonly runs in Kubernetes, where `kubernetes.default.svc` is the
 * cluster API server and is reachable from every pod. It passed every check
 * here — with or without a trailing dot — so a Jira integration pointed at it
 * would have received the unsealed credential.
 */
/**
 * The internal-hostname rule lives in @qaai/shared/private-address now.
 *
 * There were THREE implementations of "is this address inside our network":
 * this anchored regex, the worker's action dispatcher, and the plugin sandbox.
 * An attacker needs only the weakest of the three, and the `.svc` lesson in the
 * comment above is exactly the kind of thing that gets learned in one copy and
 * not the others — this one had already been through that once.
 *
 * Re-exported under the original name so callers here and in
 * lib/chat-integrations.ts do not move.
 */
import { isPrivateNetworkName } from '@qaai/shared/private-address';

export { isPrivateNetworkName as isInternalHostname };
/** IPv4 literal or anything with a colon (IPv6, or a port smuggled into a host). */
export function isIpLiteralHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Validate a Jira site and return it normalised.
 *
 * Jira is the one provider we cannot host-pin — Data Center customers run it on
 * their own domain — so it gets the next best thing: https only, no embedded
 * credentials, no IP literal and no internal-only name. A hostname is not proof
 * of where it resolves, so this narrows the blast radius rather than closing it;
 * the redirect ban is what stops the token travelling further than this host.
 */
export function jiraSite(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) throw new IssueFilingError('That Jira integration has no site URL configured.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IssueFilingError(`"${raw}" is not a valid Jira site URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new IssueFilingError(
      'A Jira site URL must be https — the API token travels in the request.',
    );
  }
  if (url.username || url.password) {
    throw new IssueFilingError(
      'Remove the credentials from the Jira site URL — the token is stored separately.',
    );
  }
  if (url.port && url.port !== '443') {
    throw new IssueFilingError('A Jira site URL must use the default https port.');
  }

  /*
   * Strip the trailing dot BEFORE any check.
   *
   * A fully-qualified name may end in a dot, and Node's URL parser keeps it:
   * `new URL('https://localhost./x').hostname === 'localhost.'`. DNS resolves
   * that to exactly the same address. One character therefore defeated every
   * guard below at once — `INTERNAL_HOST` is anchored, so `localhost.`,
   * `foo.local.` and `metadata.google.internal.` all failed to match, while the
   * dot itself satisfied the `includes('.')` single-label check. The result was
   * credentialed SSRF: `https://redis.` was accepted where `https://redis` was
   * correctly refused, and the vault-unsealed Jira credential went with it.
   */
  const host = url.hostname.replace(/\.+$/, '');
  if (isIpLiteralHost(host) || isPrivateNetworkName(host) || !host.includes('.')) {
    throw new IssueFilingError(
      `Refusing to send a Jira token to ${host}: use the public hostname of your Jira site.`,
    );
  }

  // A context path is legitimate on Data Center (…/jira). Traversal in it is not.
  const path = url.pathname.replace(/\/+$/, '');
  if (path.includes('..')) throw new IssueFilingError('That Jira site URL is not valid.');

  // Return the NORMALISED host, not `url.host`, so a trailing dot cannot
  // survive validation and be re-attached to the request that carries the token.
  return `https://${host}${url.port ? `:${url.port}` : ''}${path}`;
}

/**
 * Read `Integration.config` into the typed shape for its provider, failing with
 * a sentence that names the missing field. Runs before the token is unsealed.
 */
export function parseIssueConfig(kind: IssueTrackerKind, config: unknown): IssueTrackerConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  const keyVersion = typeof c.keyVersion === 'number' ? c.keyVersion : 1;

  if (kind === 'GITHUB') {
    return { kind, repo: githubRepoSlug(str(c.repo)), labels: stringArray(c.labels), keyVersion };
  }

  if (kind === 'JIRA') {
    const projectKey = str(c.projectKey).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(projectKey)) {
      throw new IssueFilingError(
        'That Jira integration has no project key — set `projectKey` to something like "QA".',
      );
    }
    return {
      kind,
      site: jiraSite(str(c.baseUrl)),
      projectKey,
      issueType: str(c.issueType) || 'Bug',
      email: str(c.email) || null,
      keyVersion,
    };
  }

  const teamId = str(c.teamId);
  if (!teamId) {
    throw new IssueFilingError(
      'That Linear integration has no team — set `teamId` to the id of the team the issue belongs in.',
    );
  }
  return { kind: 'LINEAR', teamId, labelIds: stringArray(c.labelIds), keyVersion };
}

// ─── The issue body ──────────────────────────────────────────────────────────

/**
 * Everything the issue text is built from. Assembled by the route from the
 * TestResult so this module never touches the database — the same reason
 * buildComment() in the notify processor takes a plain object.
 */
export interface IssueEvidence {
  project: { name: string };
  environment: { name: string; kind: string; baseUrl: string };
  run: { id: string; commitSha: string | null; branch: string | null; prNumber: number | null };
  test: { name: string; filePath: string; type: string; priority: string };
  result: {
    id: string;
    status: string;
    durationMs: number;
    errorMessage: string | null;
    retriedAndPassed: boolean;
    videoKey: string | null;
    traceKey: string | null;
  };
  /** The first failing step, when the runner recorded one. */
  step: {
    index: number;
    title: string;
    selector: string | null;
    expected: string | null;
    actual: string | null;
    errorMessage: string | null;
  } | null;
  verdict: { verdict: string; confidence: number; explanation: string } | null;
  /** Cockpit origin, for the link back to the run. */
  webUrl: string;
  /** API origin, for the trace and video artifacts. */
  apiUrl: string;
}

const VERDICT_LABEL: Record<string, string> = {
  REAL_BUG: '🐞 likely a real bug',
  INTENDED_CHANGE: '🔁 an intended change',
  FLAKE: '🎲 a flake',
  ENV_ISSUE: '🌐 an environment issue',
};

/** A pipe inside a cell would end the column early. */
const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function fence(text: string): string[] {
  // Guard the fence itself: an error message containing ``` would break out.
  return ['```', text.replace(/```/g, "''`"), '```'];
}

export function buildIssue(e: IssueEvidence): { title: string; body: string } {
  const runUrl = `${e.webUrl}/runs/${e.run.id}`;

  const title = `[QAAI] ${e.test.name} — failing on ${e.environment.name}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);

  const commit = e.run.commitSha ? e.run.commitSha.slice(0, 7) : null;
  const where = [e.run.branch, commit && `@ ${commit}`].filter(Boolean).join(' ') || '—';

  const lines: string[] = [
    `**${cell(e.test.name)}** failed in QAAI on **${cell(e.environment.name)}**.`,
    '',
    '| | |',
    '|---|---|',
    `| Test file | \`${cell(e.test.filePath)}\` |`,
    `| Type / priority | ${cell(e.test.type)} / ${cell(e.test.priority)} |`,
    `| Project | ${cell(e.project.name)} |`,
    `| Environment | ${cell(e.environment.name)} (${cell(e.environment.kind)}) — ${cell(e.environment.baseUrl)} |`,
    `| Branch / commit | ${cell(where)} |`,
    `| Result | ${cell(e.result.status)} after ${(e.result.durationMs / 1000).toFixed(1)}s |`,
  ];

  if (e.run.prNumber) lines.push(`| Pull request | #${e.run.prNumber} |`);
  // A test that only passed on retry is not a pass, and whoever picks this up
  // needs to know the failure was intermittent before they try to reproduce it.
  if (e.result.retriedAndPassed) lines.push('| Note | passed on retry — intermittent |');

  lines.push('');

  if (e.verdict) {
    const label = VERDICT_LABEL[e.verdict.verdict] ?? e.verdict.verdict;
    lines.push(
      '### QAAI triage',
      `${label} — ${Math.round(e.verdict.confidence * 100)}% confident`,
      '',
      e.verdict.explanation
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
      '',
    );
  }

  if (e.result.errorMessage) {
    lines.push('### Failure', ...fence(e.result.errorMessage.slice(0, MAX_ERROR_SNIPPET)), '');
  }

  if (e.step) {
    lines.push('### Failing step', `Step ${e.step.index + 1} — ${cell(e.step.title)}`);
    if (e.step.selector) lines.push(`- Locator: \`${cell(e.step.selector)}\``);
    if (e.step.expected) lines.push(`- Expected: ${cell(e.step.expected)}`);
    if (e.step.actual) lines.push(`- Actual: ${cell(e.step.actual)}`);
    if (e.step.errorMessage && e.step.errorMessage !== e.result.errorMessage) {
      lines.push(...fence(e.step.errorMessage.slice(0, 1_000)));
    }
    lines.push('');
  }

  // Artifacts are served through the API so they stay behind the same session
  // and tenancy check as the run — these links open for a signed-in QAAI user,
  // not for the whole internet.
  const evidence = [`- [Open the run in QAAI](${runUrl})`];
  if (e.result.traceKey) {
    evidence.push(
      `- [Playwright trace](${e.apiUrl}/runs/${e.run.id}/artifacts/${e.result.traceKey})`,
    );
  }
  if (e.result.videoKey) {
    evidence.push(`- [Video](${e.apiUrl}/runs/${e.run.id}/artifacts/${e.result.videoKey})`);
  }
  lines.push('### Evidence', ...evidence, '');

  lines.push('---', `_Filed by QAAI · run \`${e.run.id}\` · result \`${e.result.id}\`_`);

  let body = lines.join('\n');
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - 40)}\n\n_…truncated by QAAI._`;

  return { title, body };
}

// ─── Filing ──────────────────────────────────────────────────────────────────

export interface CreatedIssue {
  provider: IssueTrackerKind;
  /** Human-facing issue link on the provider. */
  url: string;
  /** The provider's own identifier: `owner/repo#12`, `QA-12`, `ENG-12`. */
  key: string;
}

/**
 * One POST, with the two rules that matter applied in one place: never follow a
 * redirect (the auth header would go with it) and never let a hung provider hold
 * the request open. Returns the parsed JSON without ever logging it.
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  provider: IssueTrackerKind,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'user-agent': 'qaai' },
      body: JSON.stringify(payload),
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
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} ${reason}. Nothing was filed — try again.`,
      'PROVIDER',
    );
  }

  // Node's fetch hands back the real 3xx here; a spec-strict runtime hands back
  // an opaque-redirect with status 0. Both mean the same thing and neither is
  // followed.
  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} answered with a redirect, and QAAI will not follow one while holding your token. ` +
        'Check the site URL on that integration.',
      'PROVIDER',
    );
  }

  // Read as text and parse defensively: an error page is often HTML, and
  // response.json() would throw something less useful than our own message.
  let json: unknown = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: response.status, json };
}

/** A sentence per failure shape, saying what the user has to change. */
function describeFailure(provider: IssueTrackerKind, status: number): string {
  const name = TRACKER_LABEL[provider];

  if (status === 401) {
    return `${name} rejected the stored token (401). Re-enter the token on the integration in Settings.`;
  }
  if (status === 403) {
    const scope =
      provider === 'GITHUB'
        ? 'the token needs the `repo` scope (or `public_repo`) and write access to issues'
        : provider === 'JIRA'
          ? 'the account needs the "Create issues" permission on that project'
          : 'the API key needs issue-write access to that team';
    return `${name} refused the request (403) — ${scope}.`;
  }
  if (status === 404) {
    const what =
      provider === 'GITHUB'
        ? 'that repository does not exist or the token cannot see it'
        : 'that project does not exist or the account cannot see it';
    return `${name} returned 404 — ${what}. Check the integration's configuration.`;
  }
  // GitHub answers 410 when a repo exists but has its issue tracker turned off.
  if (status === 410 && provider === 'GITHUB') {
    return 'Issues are disabled on that GitHub repository — turn them on, or point the integration at another repo.';
  }
  if (status === 400 || status === 422) {
    return `${name} rejected the issue (${status}). The project, issue type or labels on the integration are probably wrong.`;
  }
  if (status === 429) {
    return `${name} is rate-limiting QAAI (429). Wait a minute and file it again.`;
  }
  if (status >= 500) {
    return `${name} returned ${status} — their API is having trouble. Nothing was filed; try again.`;
  }
  return `${name} returned an unexpected ${status}. Nothing was filed.`;
}

function pick(json: unknown, key: string): unknown {
  return json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : undefined;
}

async function fileOnGithub(
  cfg: Extract<IssueTrackerConfig, { kind: 'GITHUB' }>,
  token: string,
  issue: { title: string; body: string },
): Promise<CreatedIssue> {
  const { status, json } = await postJson(
    // Host is the constant; only the path comes from config.
    `https://${API_HOST.GITHUB}/repos/${cfg.repo}/issues`,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    { title: issue.title, body: issue.body, ...(cfg.labels.length ? { labels: cfg.labels } : {}) },
    'GITHUB',
  );

  if (status !== 201) throw new IssueFilingError(describeFailure('GITHUB', status), 'PROVIDER');

  const url = pick(json, 'html_url');
  const number = pick(json, 'number');
  if (typeof url !== 'string' || typeof number !== 'number') {
    throw new IssueFilingError(
      'GitHub accepted the issue but did not return its link. Check the repository for a new issue before filing again.',
      'PROVIDER',
    );
  }
  return { provider: 'GITHUB', url, key: `${cfg.repo}#${number}` };
}

async function fileOnJira(
  cfg: Extract<IssueTrackerConfig, { kind: 'JIRA' }>,
  token: string,
  issue: { title: string; body: string },
): Promise<CreatedIssue> {
  /*
   * v2 rather than v3 on purpose: v3 only accepts Atlassian Document Format,
   * and v2 takes a plain string description on both Cloud and Data Center. One
   * request shape covers both deployments; the cost is that markdown shows up
   * as literal text in the Jira description.
   */
  const { status, json } = await postJson(
    `${cfg.site}/rest/api/2/issue`,
    {
      // Cloud authenticates an API token as Basic email:token; a Data Center
      // personal access token is a bearer. The presence of an email is what
      // tells the two apart.
      authorization: cfg.email
        ? `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`
        : `Bearer ${token}`,
      accept: 'application/json',
    },
    {
      fields: {
        project: { key: cfg.projectKey },
        summary: issue.title,
        description: issue.body,
        issuetype: { name: cfg.issueType },
      },
    },
    'JIRA',
  );

  if (status !== 201) throw new IssueFilingError(describeFailure('JIRA', status), 'PROVIDER');

  const key = pick(json, 'key');
  if (typeof key !== 'string') {
    throw new IssueFilingError(
      'Jira accepted the issue but did not return its key. Check the project for a new issue before filing again.',
      'PROVIDER',
    );
  }
  return { provider: 'JIRA', url: `${cfg.site}/browse/${key}`, key };
}

const LINEAR_MUTATION = `mutation QaaiFileBug($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;

async function fileOnLinear(
  cfg: Extract<IssueTrackerConfig, { kind: 'LINEAR' }>,
  token: string,
  issue: { title: string; body: string },
): Promise<CreatedIssue> {
  const { status, json } = await postJson(
    `https://${API_HOST.LINEAR}/graphql`,
    {
      // Linear sends personal API keys raw and OAuth access tokens as a bearer.
      // The `lin_oauth_` prefix is the only thing that distinguishes them.
      authorization: token.startsWith('lin_oauth_') ? `Bearer ${token}` : token,
      accept: 'application/json',
    },
    {
      query: LINEAR_MUTATION,
      variables: {
        input: {
          teamId: cfg.teamId,
          title: issue.title,
          description: issue.body,
          ...(cfg.labelIds.length ? { labelIds: cfg.labelIds } : {}),
        },
      },
    },
    'LINEAR',
  );

  if (status !== 200) throw new IssueFilingError(describeFailure('LINEAR', status), 'PROVIDER');

  // GraphQL reports failure inside a 200, so the status check above is not
  // enough — an unknown team id looks exactly like success until you read this.
  const errors = pick(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const message = redactSecrets(String(pick(errors[0], 'message') ?? 'unknown error')).slice(
      0,
      200,
    );
    throw new IssueFilingError(`Linear rejected the issue: ${message}`, 'PROVIDER');
  }

  const created = pick(pick(pick(json, 'data'), 'issueCreate'), 'issue');
  const url = pick(created, 'url');
  const identifier = pick(created, 'identifier');
  if (typeof url !== 'string' || typeof identifier !== 'string') {
    throw new IssueFilingError(
      'Linear accepted the issue but did not return its link. Check the team for a new issue before filing again.',
      'PROVIDER',
    );
  }
  return { provider: 'LINEAR', url, key: identifier };
}

/** Files `issue` on the tracker `cfg` describes. `token` is held only for this call. */
export function createIssue(
  cfg: IssueTrackerConfig,
  token: string,
  issue: { title: string; body: string },
): Promise<CreatedIssue> {
  if (cfg.kind === 'GITHUB') return fileOnGithub(cfg, token, issue);
  if (cfg.kind === 'JIRA') return fileOnJira(cfg, token, issue);
  return fileOnLinear(cfg, token, issue);
}
