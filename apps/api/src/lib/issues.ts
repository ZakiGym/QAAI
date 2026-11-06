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
 * HOW MUCH OF A PROVIDER'S ANSWER THIS MODULE WILL READ.
 *
 * NEW IN THIS CHANGE, and said plainly because the handover that asked for the
 * change claimed this file already had a response cap to reuse. IT DID NOT:
 * `sendJson` called `await response.text()` with no ceiling at all. The
 * requirement surfaced only because `pinnedRequest` makes `maxBytes` mandatory
 * rather than defaulting it, which is the entire argument for making it
 * mandatory.
 *
 * 64 KiB is chosen against what this file actually READS, not guessed: a Jira
 * create answers a three-field object (`id`, `key`, `self`), an edit answers 204
 * with no body at all, and a Jira error collection (`errorMessages` plus
 * `errors`) is a few hundred bytes. So the cap is orders of magnitude above any
 * real answer and `truncated` cannot fire on one — and a body that DOES hit it
 * is reported as a provider failure rather than parsed, because a truncated body
 * handed to `JSON.parse` fails and then reads as "Jira did not return a key",
 * which is a different bug with a different fix.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

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
import * as dns from 'node:dns';
import { classifyAddress, classifyHost, isPrivateNetworkName } from '@qaai/shared/private-address';
import {
  EGRESS_REFUSAL_SENTENCE,
  guardUrl,
  refusalForCaller,
  resolveEgressPolicy,
} from '@qaai/shared';
import type { EgressGuardIo, EgressGuardVerdict, EgressPermit } from '@qaai/shared';
/*
 * BY PATH, AND NOT FROM THE BARREL. `pinned-request.ts` imports `node:http` and
 * `node:https`, and `packages/shared/src/index.ts` is imported by `apps/web`.
 * `private-address.ts` (which imports `node:dns`) is kept out of the barrel for
 * the same reason.
 *
 * THE SPELLING IS THE ONE THIS WORKSPACE ALREADY USES, checked rather than
 * invented: `@qaai/shared/pinned-request` does NOT resolve — MEASURED, "Package
 * subpath './pinned-request' is not defined by exports" — because the exports
 * map lists only `.`, `./constants`, `./private-address`, `./plugin-manifest`
 * and `./action-events`. The non-barrel module this app already reaches for,
 * `sealed.ts`, is reached by relative path with a `.js` specifier from
 * `lib/vault.ts` and `lib/kms.ts`, so that is what this does too. No
 * package.json changes.
 */
import { pinnedRequest } from '../../../../packages/shared/src/pinned-request.js';

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
 *
 * ── WHAT THIS FUNCTION DECIDES, WHICH IS LESS THAN IT LOOKS ────────────────
 *
 * NOTHING ABOUT WHERE THE HOST POINTS. `isPrivateNetworkName` is a PATTERN
 * MATCH — `INTERNAL_HOST.test(host) || !host.includes('.')` — so it refuses the
 * names an attacker would have to be careless to use and accepts every name
 * they would actually register. MEASURED on this tree:
 * `jiraSite('https://jira.attacker.test/')` returns
 * `https://jira.attacker.test`, and `classifyHost('jira.attacker.test')` is
 * `{kind:'name', internal:false}` — which is not a verdict, it is the statement
 * that NOTHING HAS BEEN DECIDED. One A record pointing at 169.254.169.254 and
 * the vault-unsealed Jira credential goes to the cloud metadata service.
 *
 * This function is therefore KEPT AS IT IS and is not the control. It runs at
 * PARSE time, before the token is unsealed, which is a property worth keeping:
 * a repointed integration fails while the credential is still ciphertext. The
 * control is {@link sendToJira}, which RESOLVES the host and classifies every
 * address it answers with before any byte leaves the process.
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
 * WHY ONE REASON TO CONNECT BY NAME IS NOT THE SAME AS ANOTHER.
 *
 * CONSTANT_HOST is GitHub and Linear. `API_HOST` is a compile-time constant, no
 * config can influence it, and the module header states the rule: a configured
 * repo or URL may only ever derive a PATH. There is no rebinding window to
 * close, because the name is ours and not the attacker's.
 *
 * OBSERVE_MODE is the brake, armed on purpose. An OBSERVED permit authorises NO
 * addresses — `decideEgress` refuses to issue a pin on an observed refusal — so
 * `pinnedRequest` refuses it with NOT_PINNED, and it is right to: borrowing a
 * pin nobody issued would be a worse lie than the hole OBSERVE deliberately
 * leaves open. Connecting by name is exactly what OBSERVE promises, which is
 * also what `LoginHostApproval`'s OBSERVED arm decides in
 * `packages/runner/src/login.ts`. It is COUNTED — see
 * {@link trackerByNameSends} — because a mode that does not count is an off
 * switch with a reassuring name.
 */
export type TrackerByNameReason = 'CONSTANT_HOST' | 'OBSERVE_MODE';

/**
 * HOW ONE REQUEST IS OPENED — stated by every caller, never defaulted.
 *
 * A UNION AND NOT AN OPTIONAL `permit` PARAMETER, deliberately. An optional
 * parameter is forgotten silently and the request then goes out by name, which
 * is the defect this change closes arriving by a shorter route: for four rounds
 * `sendToJira` read `verdict.ok`, threw the permit away, and called global
 * `fetch(url)`, which resolves the name again.
 */
type SendRoute =
  | { readonly kind: 'PINNED'; readonly permit: EgressPermit }
  | { readonly kind: 'BY_NAME'; readonly why: TrackerByNameReason };

const BY_NAME_SENDS: Record<TrackerByNameReason, number> = {
  CONSTANT_HOST: 0,
  OBSERVE_MODE: 0,
};

/**
 * HOW MANY REQUESTS WENT OUT BY NAME, AND WHY.
 *
 * Process-local and monotonic, which is all an operator needs from it: the
 * question it answers is "is this install sending Jira credentials over an
 * unpinned connection, and is that because somebody armed the brake". A
 * non-zero OBSERVE_MODE is that answer. CONSTANT_HOST is the denominator — a
 * count of refusals with no denominator is the kind of number that gets quoted
 * at a customer and cannot be defended.
 *
 * Carries NO host and no URL: a per-host tally on this path would be an
 * inventory of every tracker hostname an install talks to, and the host belongs
 * on the persisted `EgressDecisionTally` where an operator needs it.
 */
export function trackerByNameSends(): Readonly<Record<TrackerByNameReason, number>> {
  return { ...BY_NAME_SENDS };
}

/** What either transport hands back, before this module decides what it means. */
interface RawAnswer {
  readonly status: number;
  readonly text: string;
  /** True when {@link MAX_RESPONSE_BYTES} bit. Never dropped: see `sendJson`. */
  readonly truncated: boolean;
  /** A 3xx a spec-strict runtime reports opaquely instead of as a status. */
  readonly opaqueRedirect: boolean;
}

/**
 * THE PINNED TRANSPORT: the addresses the guard classified, and no second
 * resolution of the name.
 *
 * `pinnedRequest` builds an `http`/`https` Agent with `pinnedLookup(permit)`,
 * so the socket goes to a classified address while the NAME stays in the
 * request — Host, SNI and the certificate check all keep working. It never
 * follows a redirect and that is not configurable, which is the same rule
 * `redirect: 'manual'` buys on the by-name path.
 *
 * ── THE REFUSALS, MAPPED ONTO SENTENCES THIS FILE ALREADY SAYS ──────────────
 *
 * Nothing more helpful is added, because a message that distinguished "the
 * pinned address refused the connection" from "that name does not resolve"
 * would turn a Jira integration into a port scanner with a readable report,
 * filed by whoever can edit the integration row.
 *
 *   TIMED_OUT         the existing deadline sentence, unchanged.
 *   TRANSPORT_FAILED  the existing "was unreachable" sentence. A REFUSED PIN
 *                     surfaces here too — `pinnedLookup` calls back with an
 *                     Error rather than an empty success — and it is right that
 *                     the two read alike to a caller.
 *   the other four    {@link EGRESS_REFUSAL_SENTENCE}, the file's one refusal
 *                     sentence, because these are facts about OUR permit and
 *                     not about the provider: calling them "unreachable" would
 *                     be a small lie in the one place a reader checks. The
 *                     constant is used directly rather than through
 *                     `refusalForCaller`, which needs a `GuardVerdict` there is
 *                     none of here; it is the same string by construction and
 *                     `issues.test.ts` asserts so.
 *
 * `operatorDetail` is deliberately DROPPED rather than attached: it may name
 * the host and the transport's own words, and this error reaches whoever
 * supplied the URL.
 */
async function openPinned(
  url: string,
  headers: Record<string, string>,
  body: string,
  method: 'POST' | 'PATCH' | 'PUT',
  provider: IssueTrackerKind,
  permit: EgressPermit,
): Promise<RawAnswer> {
  const result = await pinnedRequest(permit, url, {
    method,
    headers,
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  });

  if (result.ok) {
    return {
      status: result.response.status,
      text: result.response.text,
      truncated: result.response.truncated,
      opaqueRedirect: false,
    };
  }

  if (result.refusal === 'TIMED_OUT') {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s. Nothing was filed — try again.`,
      'PROVIDER',
    );
  }
  if (result.refusal === 'TRANSPORT_FAILED') {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} was unreachable. Nothing was filed — try again.`,
      'PROVIDER',
    );
  }
  throw new IssueFilingError(EGRESS_REFUSAL_SENTENCE);
}

/**
 * THE BY-NAME TRANSPORT: global `fetch`, which resolves the name itself.
 *
 * Unchanged from what every provider used to get, and kept for the two reasons
 * {@link TrackerByNameReason} names. The send is counted here rather than where
 * the route is chosen, so the number is a count of REQUESTS THAT WENT OUT and
 * not of decisions that might still have refused.
 */
async function openByName(
  url: string,
  headers: Record<string, string>,
  body: string,
  method: 'POST' | 'PATCH' | 'PUT',
  provider: IssueTrackerKind,
  why: TrackerByNameReason,
): Promise<RawAnswer> {
  BY_NAME_SENDS[why] += 1;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
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

  // Read as text and parse defensively: an error page is often HTML, and
  // response.json() would throw something less useful than our own message.
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  /*
   * THE CAP, APPLIED TO WHAT IS PARSED — AND NOT TO WHAT WAS BUFFERED.
   *
   * By the time `text()` resolves, `fetch` has already read the whole body into
   * memory, so this bounds the parse and NOT the allocation. That is a real
   * remaining gap on the two constant-host providers and it is named rather
   * than implied: closing it means reading `response.body` as a stream, which
   * is a change to the GitHub and Linear paths and not to the one this round
   * is about. The PINNED path has no such gap — `pinnedRequest` destroys the
   * response at the cap.
   */
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES;

  return {
    status: response.status,
    text,
    truncated,
    // Node's fetch hands back the real 3xx; a spec-strict runtime hands back an
    // opaque-redirect with status 0. Both mean the same thing.
    opaqueRedirect: response.type === 'opaqueredirect',
  };
}

/**
 * One request, with the rules that matter applied in one place: connect to the
 * addresses the guard pinned, never follow a redirect (the auth header would go
 * with it), never let a hung provider hold the request open, and never report a
 * capped body as a whole one. Returns the parsed JSON without ever logging it.
 *
 * THE METHOD AND THE ROUTE ARE PARAMETERS AND THE FUNCTION IS STILL ONE
 * FUNCTION. Editing an issue needs PATCH on GitHub and PUT on Jira, and the
 * obvious shortcut — a second `patchJson` next to this one — is how this repo
 * ended up with three implementations of "is this host private", two of which
 * were wrong. Every line below is a refusal that has to hold for an edit exactly
 * as it holds for a create, and for a pinned request exactly as for a by-name
 * one: the Authorization header must not follow a 3xx, the timeout must bound
 * the request, and the response body must never be logged.
 */
async function sendJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  provider: IssueTrackerKind,
  method: 'POST' | 'PATCH' | 'PUT',
  route: SendRoute,
): Promise<{ status: number; json: unknown }> {
  const sent = { ...headers, 'content-type': 'application/json', 'user-agent': 'qaai' };
  const body = JSON.stringify(payload);

  const answer =
    route.kind === 'PINNED'
      ? await openPinned(url, sent, body, method, provider, route.permit)
      : await openByName(url, sent, body, method, provider, route.why);

  if ((answer.status >= 300 && answer.status < 400) || answer.opaqueRedirect) {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} answered with a redirect, and QAAI will not follow one while holding your token. ` +
        'Check the site URL on that integration.',
      'PROVIDER',
    );
  }

  /*
   * A CAPPED BODY IS NOT AN ANSWER. Parsing it would fail, `json` would be
   * null, and the caller would report "Jira accepted the issue but did not
   * return its key" — a sentence that sends somebody to look at their Jira
   * project for a ticket, about a request whose answer we simply did not read.
   */
  if (answer.truncated) {
    throw new IssueFilingError(
      `${TRACKER_LABEL[provider]} answered with more than ${MAX_RESPONSE_BYTES / 1024} KiB, which QAAI will not read. ` +
        'Nothing was filed — try again.',
      'PROVIDER',
    );
  }

  let json: unknown = null;
  try {
    json = answer.text ? JSON.parse(answer.text) : null;
  } catch {
    json = null;
  }

  return { status: answer.status, json };
}

/** GitHub and Linear: the host is a compile-time constant. See {@link TrackerByNameReason}. */
const CONSTANT_HOST_ROUTE: SendRoute = { kind: 'BY_NAME', why: 'CONSTANT_HOST' };

// ─── The egress guard, at the one seam a customer-named host is reached ──────

/**
 * MAY WE OPEN A REQUEST TO THIS JIRA SITE, AND TO WHICH ADDRESS.
 *
 * ── Why only Jira, when three providers share one `sendJson` ───────────────
 *
 * Because only Jira's host comes from config. `API_HOST` above is a
 * compile-time constant per provider and the module header states the rule it
 * exists to keep: "a configured repo/URL is only ever used to derive a PATH; it
 * can never choose the host." Resolving `api.github.com` through this guard
 * would add a DNS round trip and a new failure mode to a destination no
 * customer can influence, and it would put a real resolver inside
 * `apps/api/src/routes/issues.test.ts`, which stubs `fetch` and would then
 * depend on the network. So the guard is applied exactly where the attack
 * surface is.
 *
 * ── It is a PORT, and the real one is built lazily ─────────────────────────
 *
 * Same shape as `defaultLoginEgressGuard` in `packages/runner/src/login.ts`
 * and `defaultCrawlEgressIo` in `packages/agent/src/crawler.ts`: a
 * one-function interface so a unit test decides without a resolver, and a
 * `default…` builder so no production path can reach the send without one.
 */
export type TrackerEgressGuard = (url: string) => Promise<EgressGuardVerdict>;

/**
 * WHAT THIS CONTROL NOW DOES, AND WHAT IT STILL DOES NOT. A COMMENT IS WHAT THE
 * NEXT REVIEWER TRUSTS INSTEAD OF READING THE CODE, SO IT HAS TO BE TRUE.
 *
 * ── THE PIN IS NOW ENFORCED AT THE SOCKET ───────────────────────────────────
 *
 * `guardUrl` hands back a PINNED ADDRESS SET, and the pin is the half that
 * turns a check into a control: whoever opens the connection must connect to
 * those addresses and must not resolve the name again. Until this change the
 * Jira path got a permit, THREW IT AWAY, and called global `fetch(url)` by name
 * — which resolves independently. It no longer does. {@link sendToJira} threads
 * the permit to `pinnedRequest`, which builds an `http`/`https` Agent with
 * `pinnedLookup(permit)`, so the socket goes to a classified address while the
 * NAME stays in the request.
 *
 * ── THE PARAGRAPH THAT USED TO BE HERE, AND WHY IT WAS WRONG ────────────────
 *
 * It said: "There is no supported way to hand global `fetch` a resolver", and
 * three modules carried the same sentence. The MEASUREMENT behind it is real and
 * reproduces on Node v25.6.1 — `fetch(url, { agent: new http.Agent({ lookup }) })`
 * answers 200 with the lookup called ZERO times, the agent silently ignored,
 * which is the worst kind of failure because it looks like it worked. THE
 * CONCLUSION WAS WRONG: `http.request({ host, port, path, lookup })` answers 200
 * with the lookup called ONCE, Node core, no dependency change. A true
 * measurement with a false conclusion closed the question for four rounds, and
 * that is the shape of comment this file now exists as a warning about.
 *
 * `undici`'s `{ dispatcher: new undici.Agent({ connect: { lookup } }) }` also
 * works and would have kept `fetch`, and it is NOT used: `undici` resolves only
 * out of the dev tree (an optional dependency of `@electron/get`, under a
 * devDependency of apps/desktop) and no package.json declares it, so it would
 * be ABSENT under `npm ci --omit=dev`.
 *
 * ── WHAT IS STILL NOT CLOSED ────────────────────────────────────────────────
 *
 *  1. GITHUB AND LINEAR STILL CONNECT BY NAME, on purpose. `API_HOST` is a
 *     compile-time constant and no config can influence it, so there is no
 *     rebinding window an attacker can open — the name is ours. They are not
 *     guarded and not pinned, and {@link TrackerByNameReason} says so.
 *  2. OBSERVE MODE STILL CONNECTS BY NAME, with the rebinding window open,
 *     because that is what OBSERVE means. It is counted by
 *     {@link trackerByNameSends}, so it is a measurable state and not a silent
 *     one. ENFORCE is the default.
 *  3. The by-name path still BUFFERS an unbounded response body before the cap
 *     is applied to the parse — see the note in `openByName`.
 *  4. `jiraSite` is still a PATTERN MATCH and decides nothing about where a
 *     host points; the guard plus the pin is what decides. That division is
 *     unchanged and is described on `jiraSite` itself.
 */
export const TRACKER_PIN_LIMITATION =
  'The Jira host is resolved, every address it answers with is classified, and the request is ' +
  'opened to those addresses only — the name is not resolved a second time. GitHub and Linear ' +
  'still connect by name, because their host is a compile-time constant; so does a permit issued ' +
  'in OBSERVE mode, which authorises no address and is counted instead.';

/**
 * THE REAL GUARD.
 *
 * `TRACKER_CALL` is not a label. `EGRESS_CONTEXT_RULES` keys the allowlist and
 * the third-party rule off the context, and this one has
 * `targetsApplicationUnderTest: false` and `allowlistApplies: false` — so a
 * private, loopback, reserved or link-local address is refused in EVERY
 * deployment and cannot be allowlisted, because "add your internal host to the
 * allowlist" would be advice to build an SSRF with paperwork. That is the same
 * answer `jiraSite` already gives by pattern for the names it can recognise, so
 * no Jira integration that works today stops working: an integration pointed at
 * `jira.internal` is refused before this change and after it.
 *
 * `policy` is `unknown` because that is how `Environment.egressPolicy` reads
 * out of its JSONB column. An issue-tracker integration is org-level and has no
 * environment, so today every caller passes nothing — and nothing falls through
 * `resolveEgressPolicy` to the HOSTED policy, PUBLIC ONLY, which is the
 * strictest reading. An absent policy must never be an open one.
 */
export async function defaultTrackerEgressGuard(policy?: unknown): Promise<TrackerEgressGuard> {
  const resolved = resolveEgressPolicy(policy);
  const io: EgressGuardIo = {
    classifyHost: (host) => classifyHost(host),
    classifyAddress: (address) => classifyAddress(address),
    /*
     * EVERY address the name has, not the first: a record set mixing one
     * routable address with 169.254.169.254 is not a misconfiguration, it is
     * the attack written down. `verbatim: true` so the OS does not reorder and
     * hide one.
     */
    lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true, family: 0 }),
    now: () => new Date(),
    /*
     * `performance.now()` and NOT `Date.now()`: the wall clock is spoken for
     * (it stamps `PinnedResolution.pinnedAt`), and an NTP step backwards
     * mid-refusal would make the elapsed time negative, the pad negative and
     * therefore zero — a refusal that skipped its pad is the timing oracle the
     * floor exists to close.
     */
    monotonicMs: () => performance.now(),
    delay: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
  };
  return (url) => guardUrl({ url, context: 'TRACKER_CALL', policy: resolved, io });
}

/**
 * THE ONLY WAY A JIRA REQUEST IS MADE, so a fourth caller cannot forget the
 * guard.
 *
 * `fileOnJira` and the JIRA branch of {@link updateIssue} both go through here.
 * Putting the guard at the two call sites instead would be two places to
 * remember and `apps/api/src/routes/repro.ts` already proves how that ends — it
 * holds a THIRD copy of this request, duplicated on purpose, and it is named in
 * the handover because it needs this same door.
 *
 * ── The refusal is ONE SENTENCE, and that is deliberate ────────────────────
 *
 * {@link refusalForCaller} returns {@link EGRESS_REFUSAL_SENTENCE} for all
 * seventeen refusals. A message that distinguished "that is a link-local
 * address" from "that host did not resolve" from "that host is not on the
 * allowlist" would turn a Jira integration into a port scanner with a readable
 * report, filed by whoever can edit the integration row. The operator's copy —
 * the class, the address and the refusal code — stays in
 * `verdict.operatorDetail` and is deliberately NOT thrown.
 */
async function sendToJira(
  cfg: Extract<IssueTrackerConfig, { kind: 'JIRA' }>,
  path: string,
  headers: Record<string, string>,
  payload: unknown,
  method: 'POST' | 'PUT',
  egress?: TrackerEgressGuard,
): Promise<{ status: number; json: unknown }> {
  const url = `${cfg.site}${path}`;
  const guard = egress ?? (await defaultTrackerEgressGuard());
  const verdict = await guard(url);
  if (!verdict.ok) {
    /*
     * REFUSED BEFORE THE REQUEST, and the token is already unsealed by the time
     * we are here — so "refused" has to mean nothing was sent, not that a send
     * failed. There is no arm of this branch that falls through to `sendJson`;
     * an exception handler that reaches the transport anyway is the defect
     * pattern worth hunting in one's own work.
     */
    throw new IssueFilingError(refusalForCaller(verdict).sentence);
  }
  return sendJson(url, headers, payload, 'JIRA', method, routeFor(verdict.permit));
}

/**
 * THE PERMIT, READ RATHER THAN DISCARDED. This function is the whole fix.
 *
 * `verdict.ok` was the only thing this path used to look at. The permit beside
 * it carried the addresses the guard had just classified, and throwing it away
 * meant the socket resolved the name a second time — which an adversary measured
 * end to end on this very path: two DNS queries, no cache between them, a public
 * address to the guard and 127.0.0.1 to the transport, and the Jira credential
 * arriving at a loopback server as `POST /rest/api/2/issue` with the
 * authorization header on it. No timing precision, 100% reliable.
 *
 * ── THE THREE ARMS, AND WHY NONE OF THEM IS A FALLBACK ──────────────────────
 *
 * PINNED with addresses  the request goes to those addresses and nowhere else.
 *
 * OBSERVED               by name, counted. The policy would have refused and the
 *                        mode is OBSERVE, so the connection happens exactly as it
 *                        did before this control existed. Taking the integration
 *                        away from an operator who armed the brake would be the
 *                        silent behaviour change the brake exists to avoid, and
 *                        `pinnedRequest` cannot be used here anyway: an OBSERVED
 *                        permit authorises no address and it refuses one with
 *                        NOT_PINNED.
 *
 * PINNED with NO address REFUSED. A pin that authorises nothing is as dangerous
 *                        as no pin, because `pinnedLookup` answers nothing for an
 *                        empty set and a resolver that answers nothing falls back
 *                        to the system one — the rebinding window this pin exists
 *                        to close, reopened by an empty success.
 *                        `approvalFor` in `packages/runner/src/login.ts` refuses
 *                        the same case for the same reason. It is a broken
 *                        permit, not a mode, so it gets the refusal sentence and
 *                        not the OBSERVE count.
 */
function routeFor(permit: EgressPermit): SendRoute {
  if (permit.kind === 'OBSERVED') return { kind: 'BY_NAME', why: 'OBSERVE_MODE' };
  if (permit.pinned.addresses.length === 0) throw new IssueFilingError(EGRESS_REFUSAL_SENTENCE);
  return { kind: 'PINNED', permit };
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
  const { status, json } = await sendJson(
    // Host is the constant; only the path comes from config.
    `https://${API_HOST.GITHUB}/repos/${cfg.repo}/issues`,
    {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    { title: issue.title, body: issue.body, ...(cfg.labels.length ? { labels: cfg.labels } : {}) },
    'GITHUB',
    'POST',
    CONSTANT_HOST_ROUTE,
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
  egress?: TrackerEgressGuard,
): Promise<CreatedIssue> {
  /*
   * v2 rather than v3 on purpose: v3 only accepts Atlassian Document Format,
   * and v2 takes a plain string description on both Cloud and Data Center. One
   * request shape covers both deployments; the cost is that markdown shows up
   * as literal text in the Jira description.
   */
  const { status, json } = await sendToJira(
    cfg,
    '/rest/api/2/issue',
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
    'POST',
    egress,
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
  const { status, json } = await sendJson(
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
    'POST',
    CONSTANT_HOST_ROUTE,
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

// ─── Editing one already on the board ────────────────────────────────────────

/**
 * What an edit may change. Both optional, and at least one is required — see
 * `updateIssue`.
 */
export interface IssuePatch {
  title?: string;
  body?: string;
}

/**
 * A sentence per failure shape for an EDIT, where the target existing is the
 * interesting case.
 *
 * Separate from `describeFailure` because 404 means something different: on a
 * create it means the project or repo is wrong, and on an edit it means the
 * TICKET is gone — somebody deleted it, or moved it to another repo — which the
 * caller has to be able to tell apart, because the honest answer to the second
 * is "file a new one", not "fix your integration".
 */
function describeEditFailure(provider: IssueTrackerKind, status: number): string {
  const name = TRACKER_LABEL[provider];
  if (status === 404 || status === 410) {
    return `${name} no longer has that issue (${status}) — it was deleted or moved. The ticket QAAI recorded for this cause cannot be rewritten.`;
  }
  if (status === 403) {
    return `${name} refused the edit (403) — the stored token can see that issue but cannot change it.`;
  }
  return describeFailure(provider, status);
}

/**
 * The issue NUMBER out of a GitHub key.
 *
 * `CreatedIssue.key` is `owner/repo#12`, so the number is derivable and the
 * repo on it is NOT used: the path is built from `cfg.repo`, exactly as the
 * create path builds it, because a key read back out of the database must never
 * be able to choose where a request carrying the customer's token is sent. A
 * key that does not parse is a refusal rather than a guess.
 */
function githubIssueNumber(key: string): number {
  const match = /#(\d+)$/.exec(key);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(number) || number <= 0) {
    throw new IssueFilingError(
      `QAAI recorded "${key}" as the GitHub issue for this cause and cannot read an issue number out of it, so the ticket text could not be rewritten.`,
    );
  }
  return number;
}

/** The Jira / Linear key, with nothing in it that could redirect a request. */
function plainKey(key: string, provider: IssueTrackerKind): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-\d{1,12}$/.test(key)) {
    throw new IssueFilingError(
      `QAAI recorded "${key}" as the ${TRACKER_LABEL[provider]} issue for this cause and it is not a key QAAI can address, so the ticket text could not be rewritten.`,
    );
  }
  return key;
}

const LINEAR_UPDATE_MUTATION = `mutation QaaiEditBug($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { identifier } }
}`;

/**
 * Rewrite the title and/or body of an issue that is already on the board.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The filing path is one ticket per CAUSE, and a cause does not stop growing
 * when the ticket is created: the same broken dependency takes out four more
 * tests next week, they join the same ticket, and the ticket still lists the
 * three tests that were known at filing time. Nobody reading it can tell that
 * it now covers seven, so somebody files a second ticket — the forty-tickets
 * defect, arriving by a different door. `createIssue` could only create, so the
 * re-file path reported `providerBodyRefreshed: false` and meant it.
 *
 * ── What it refuses ─────────────────────────────────────────────────────────
 *
 * Everything the create path refuses, because it goes through the same
 * `sendJson`: the host is the pinned constant (or, for Jira, the already
 * validated `cfg.site`), a 3xx is an error rather than a hop while the
 * Authorization header is in flight, the request is bounded, and no response
 * body is logged or returned. The provider's own identifier is parsed into a
 * number or a key shape rather than interpolated raw, so a value read back out
 * of the database cannot steer the path.
 *
 * An empty patch THROWS rather than issuing a no-op request: a caller that
 * believes it refreshed a ticket and sent nothing is the caller that reports
 * `providerBodyRefreshed: true` about a ticket it never touched.
 */
export async function updateIssue(
  cfg: IssueTrackerConfig,
  token: string,
  key: string,
  patch: IssuePatch,
  /**
   * The egress guard, injected. OPTIONAL so every existing caller keeps
   * compiling and keeps getting the real guard — `sendToJira` builds
   * {@link defaultTrackerEgressGuard} when nobody supplies one, which is what
   * makes it impossible to reach the Jira transport without a decision. A test
   * supplies its own and never touches a resolver.
   */
  egress?: TrackerEgressGuard,
): Promise<void> {
  const title = patch.title === undefined ? undefined : patch.title.slice(0, MAX_TITLE);
  const body = patch.body === undefined ? undefined : patch.body.slice(0, MAX_BODY);
  if (title === undefined && body === undefined) {
    throw new IssueFilingError('An issue edit has to change the title, the body, or both.');
  }

  if (cfg.kind === 'GITHUB') {
    const { status } = await sendJson(
      // Host is the constant and the path comes from config, never from `key`.
      `https://${API_HOST.GITHUB}/repos/${cfg.repo}/issues/${githubIssueNumber(key)}`,
      {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      { ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }) },
      'GITHUB',
      'PATCH',
      CONSTANT_HOST_ROUTE,
    );
    if (status !== 200)
      throw new IssueFilingError(describeEditFailure('GITHUB', status), 'PROVIDER');
    return;
  }

  if (cfg.kind === 'JIRA') {
    // v2 like the create path, so one request shape covers Cloud and Data
    // Center. A successful edit answers 204 with no body.
    const { status } = await sendToJira(
      cfg,
      `/rest/api/2/issue/${plainKey(key, 'JIRA')}`,
      {
        authorization: cfg.email
          ? `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`
          : `Bearer ${token}`,
        accept: 'application/json',
      },
      {
        fields: {
          ...(title === undefined ? {} : { summary: title }),
          ...(body === undefined ? {} : { description: body }),
        },
      },
      'PUT',
      egress,
    );
    if (status !== 204 && status !== 200) {
      throw new IssueFilingError(describeEditFailure('JIRA', status), 'PROVIDER');
    }
    return;
  }

  const { status, json } = await sendJson(
    `https://${API_HOST.LINEAR}/graphql`,
    {
      authorization: token.startsWith('lin_oauth_') ? `Bearer ${token}` : token,
      accept: 'application/json',
    },
    {
      query: LINEAR_UPDATE_MUTATION,
      variables: {
        /*
         * The identifier QAAI stored (`ENG-12`), not a UUID. Linear resolves an
         * issue identifier wherever it takes an issue `id`, and the identifier
         * is what `CreatedIssue.key` carries because it is also what a human
         * reads. If a future Linear requires the UUID this returns a GraphQL
         * error, which the caller reports as a refresh that did not happen —
         * never as one that did.
         */
        id: plainKey(key, 'LINEAR'),
        input: {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { description: body }),
        },
      },
    },
    'LINEAR',
    'POST',
    CONSTANT_HOST_ROUTE,
  );

  if (status !== 200) throw new IssueFilingError(describeEditFailure('LINEAR', status), 'PROVIDER');

  // GraphQL reports failure inside a 200, and an unknown issue id looks exactly
  // like success until you read this.
  const errors = pick(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const message = redactSecrets(String(pick(errors[0], 'message') ?? 'unknown error')).slice(
      0,
      200,
    );
    throw new IssueFilingError(`Linear refused the edit: ${message}`, 'PROVIDER');
  }

  // `success: false` with no `errors` array is Linear's other way of saying no.
  if (pick(pick(pick(json, 'data'), 'issueUpdate'), 'success') !== true) {
    throw new IssueFilingError(
      'Linear accepted the request but did not confirm the edit, so the ticket text may be unchanged.',
      'PROVIDER',
    );
  }
}

/** Files `issue` on the tracker `cfg` describes. `token` is held only for this call. */
export function createIssue(
  cfg: IssueTrackerConfig,
  token: string,
  issue: { title: string; body: string },
  /** See {@link updateIssue}'s own `egress` parameter: optional, real by default. */
  egress?: TrackerEgressGuard,
): Promise<CreatedIssue> {
  if (cfg.kind === 'GITHUB') return fileOnGithub(cfg, token, issue);
  if (cfg.kind === 'JIRA') return fileOnJira(cfg, token, issue, egress);
  return fileOnLinear(cfg, token, issue);
}
