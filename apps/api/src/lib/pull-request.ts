/**
 * The loop's last mile: a pull request in the CUSTOMER'S repository.
 *
 * ─── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * `HealProposal.prUrl` was documented as "PR opened when the repo is connected"
 * and NOTHING WROTE IT — a doc comment that contradicted the code under it.
 * `pushRepo` (./git.ts) writes a branch and stops there, so everything QAAI
 * produced ended in the database or on an unmerged ref, and nothing it produced
 * ever reached a reviewer by the path reviewers actually use. A test suite whose
 * fixes never arrive as a reviewable change is a suite that produces findings
 * and has nowhere to put them.
 *
 * ─── WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────
 *
 * It is the DECISION and the RECORD. It is not the HTTP client: every byte that
 * leaves the process leaves through {@link GitHost}, an interface the caller
 * supplies. That is rule 8 of this round and it is also the only way this file
 * is testable — 629 lines of crawler.ts had almost no tests because its network
 * was a top-level `fetch`. GitHub is the implementation that exists; the shape
 * is the one the later GitLab and Bitbucket work implements, which is why
 * nothing below says "github" outside a comment.
 *
 * ─── OPENING A PR IS AN OUTWARD-FACING WRITE ────────────────────────────────
 *
 * Into somebody else's repository, with their token, under their name. Five
 * properties hold, and each one is a defect this file exists to not have:
 *
 *  1. IT HAPPENS ONLY ON A PATH THE CUSTOMER ENABLED. There is no implicit
 *     default: {@link OpenPullRequestInput.integrationId} names a row the
 *     customer created, and the caller has already checked `Integration.enabled`
 *     — see {@link PullRequestStore.loadTarget}, which is where that check
 *     lives, because a store that could not refuse would make "enabled" a field
 *     nobody reads.
 *
 *  2. IT IS IDEMPOTENT. `PullRequestRecord.@@unique([orgId, causeKey])` is the
 *     constraint, and THE CLAIM IS AN INSERT, NOT A CHECK — the same shape
 *     `RunFailureCluster` uses in the triage processor, and for the same reason:
 *     two concurrent CI steps really do both look for a record and both find
 *     none. The first INSERT wins the cause; the loser reports
 *     `ALREADY_RECORDED` and opens nothing. A retried CI step cannot open a
 *     second PR.
 *
 *  3. THE TARGET IS OURS. `repo`, `branch` and `baseRef` are the three fields
 *     that decide WHERE the write lands, and not one of them can hold a
 *     sentence: the repo slug comes off the integration row, and the branch is
 *     composed by {@link branchNameFor}, whose parameters are a member of a
 *     closed union and 64 hex characters. There is no overload of it that takes
 *     text. That is the proof by construction the round asked for — not "we
 *     validate the branch", but "there is no way to express a branch built out
 *     of test output".
 *
 *  4. THE TITLE AND BODY CARRY UNTRUSTED TEXT, FENCED AND BOUNDED. A failure
 *     message, a page's text and a model's own words are all data. They go
 *     through `fence()` (packages/agent/src/untrusted.ts), which neutralises our
 *     own delimiters and DISCLOSES what it cut. The title is composed from
 *     QAAI's records alone — see {@link PR_TITLE}. Nothing in either can change
 *     where the PR lands, because where it lands is decided by (3).
 *
 *  5. NO CREDENTIAL REACHES THE BODY, THE RECORD OR A LOG. Not truncated, not
 *     hashed, not on an error path. `failureNote` is OUR prose keyed off a
 *     closed refusal vocabulary and NEVER the host's response body, which can
 *     echo the request that carried the token. {@link scrubCredentials} is the
 *     second line of that defence and it is counted, because a body that was
 *     silently edited must not pass as a faithful quote.
 *
 * ─── RE-MEASURE ON MERGE ────────────────────────────────────────────────────
 *
 * A merged PR changes the thing the coverage number is measured over, so
 * {@link recordPullRequestMerged} takes a {@link Remeasure} it cannot be
 * constructed without. A function that returned "you should re-measure" and
 * trusted a caller to do it is how five honesty columns got a writer and no
 * reader.
 */

import { createHash } from 'node:crypto';
import { PR_RECORD_STATES, openPullRequestSchema } from '@qaai/shared';
import type { GitIntegrationKind, PrPurpose, PrRecordState } from '@qaai/shared';
/*
 * Reached by SUBPATH rather than through the barrel, exactly as lib/sso.ts and
 * routes/api-surface.ts reach it: `private-address.ts` imports `node:dns`, and
 * `packages/shared/src/index.ts` is consumed by the web app's bundler.
 */
import { classifyHost, resolvesPublicly } from '@qaai/shared/private-address';
import type { LookupFn } from '@qaai/shared/private-address';
import { FENCE_CLOSE, FENCE_OPEN, fence, spanProvenance } from '@qaai/agent';
import type { FenceDisclosure, UntrustedSpan } from '@qaai/agent';
/*
 * ONE implementation of "anything long enough to be a credential comes out".
 * ./issues.ts has held it since the tracker work and the rule is identical here
 * — provider output echoes the request, and the request carried the token. A
 * second copy in this file is how this repo ended up with three answers to "is
 * this host private", two of which were wrong.
 */
import { redactSecrets } from './issues.js';

// ─────────────────────────────────────────────────────────────────────────────
// The cause, and the branch composed from it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The idempotence key: sha256 of `purpose | projectId | identity`.
 *
 * The same construction `causeKeyFor` uses in routes/issues.ts, including its
 * refusal: a `projectId` containing the separator would make
 * `("a|b", "c")` and `("a", "b|c")` hash alike, and two different causes
 * sharing one key is one PR where there should be two — or, worse, a heal's PR
 * adopted as a campaign's.
 *
 * It is a HASH and not a name because the identity is sometimes a 12-hex
 * cluster key, sometimes a test id and sometimes a campaign id, and a column
 * that held whichever of those it happened to be could not be compared.
 */
export function prCauseKey(purpose: PrPurpose, projectId: string, identity: string): string {
  if (projectId.includes('|')) {
    throw new Error(
      'prCauseKey: a projectId containing "|" would be ambiguous against the cause identity',
    );
  }
  if (identity.length === 0) {
    throw new Error('prCauseKey: a cause with no identity cannot be made idempotent');
  }
  return createHash('sha256').update(`${purpose}|${projectId}|${identity}`).digest('hex');
}

/**
 * The branch segment per purpose.
 *
 * A `satisfies Record<PrPurpose, string>`, so a fifth purpose added to
 * `PR_PURPOSES` is a COMPILE ERROR here rather than a branch named
 * `qaai/undefined/<key>` pushed into a customer's repository. That is the
 * compiler-enforced presence record this round asks for on any union with a
 * write path, and this union has the most outward-facing write path in the
 * product.
 */
export const PR_PURPOSE_BRANCH_SEGMENT = {
  HEAL: 'heal',
  GENERATED_TESTS: 'tests',
  RETIREMENT: 'retire',
  CLOSURE_CAMPAIGN: 'closure',
} satisfies Record<PrPurpose, string>;

/** Every branch QAAI opens lives under this, so a customer can see ours at a glance. */
export const PR_BRANCH_PREFIX = 'qaai';

/**
 * How much of the cause key the branch carries.
 *
 * 12, to match the cluster key the cockpit already shows — the link in the UI
 * and the segment in the branch are then the same string for a heal, which is
 * what makes "which failure is this branch about" answerable without a query.
 * The full 64 characters live on the record; the branch is a human-readable
 * handle, not the identity.
 */
export const PR_BRANCH_KEY_CHARS = 12;

/**
 * The branch name, composed from QAAI's own records and NOTHING ELSE.
 *
 * THE PROOF IS THE SIGNATURE. `purpose` is a member of a closed union and
 * `causeKey` is 64 lowercase hex characters, checked here rather than trusted:
 * there is no parameter a failure message, a page's text, a customer's source
 * or a model's output could be passed as. A reviewer asking "could test output
 * steer this branch?" does not have to read the body of the function.
 *
 * It throws on a malformed key rather than normalising one. A branch is the
 * TARGET of an outward write, and a target that quietly accepted a key it had
 * to repair is a target somebody else got to choose a character of.
 */
export function branchNameFor(args: { purpose: PrPurpose; causeKey: string }): string {
  if (!/^[0-9a-f]{64}$/.test(args.causeKey)) {
    throw new Error('branchNameFor: a cause key is 64 lowercase hex characters');
  }
  const segment = PR_PURPOSE_BRANCH_SEGMENT[args.purpose];
  return `${PR_BRANCH_PREFIX}/${segment}/${args.causeKey.slice(0, PR_BRANCH_KEY_CHARS)}`;
}

/**
 * The PR title per purpose, composed from a count and a hex handle.
 *
 * `satisfies Record<PrPurpose, …>` for the same reason as the branch segment,
 * and a FUNCTION of (count, handle) rather than a template a caller fills in:
 * `outwardText(200)` in the shared schema REFUSES a title carrying a control
 * character or a fence marker, which means a title built out of a test's name
 * is a title that intermittently fails validation depending on what the
 * customer called their test. Composing it from a number and 12 hex characters
 * cannot fail, and cannot say anything somebody else chose.
 */
export const PR_TITLE = {
  HEAL: (_count: number, handle: string) => `QAAI: fix the test failing under cause ${handle}`,
  GENERATED_TESTS: (count: number, handle: string) =>
    `QAAI: ${count} generated test file(s) for ${handle}`,
  RETIREMENT: (count: number, handle: string) =>
    `QAAI: retire ${count} test file(s) whose surface is gone (${handle})`,
  CLOSURE_CAMPAIGN: (count: number, handle: string) =>
    `QAAI: close ${count} coverage gap(s) from campaign ${handle}`,
} satisfies Record<PrPurpose, (count: number, handle: string) => string>;

// ─────────────────────────────────────────────────────────────────────────────
// The body: our sentences, their text, fenced and counted.
// ─────────────────────────────────────────────────────────────────────────────

/** Named paths in the body. Past this the list is a file listing, not a summary. */
export const MAX_BODY_PATHS = 25;

/** Per span. A PR body is the one place a long quote belongs, and it still ends. */
export const BODY_SPAN_CHARS = 4_000;

/**
 * `openPullRequestSchema` caps the body at 60,000. This is lower, because the
 * schema's ceiling is a refusal and this is a budget: a body assembled right up
 * to the validator's limit is a body one extra path makes invalid.
 */
export const MAX_BODY_CHARS = 50_000;

export interface PullRequestBody {
  readonly body: string;
  /** One per span, as `fence` reported it. The quote's missing half, out loud. */
  readonly disclosures: readonly FenceDisclosure[];
  /** How many credential-shaped runs came out of the fenced spans. */
  readonly credentialsScrubbed: number;
  /** Paths named in the body, and how many there were in all. */
  readonly pathsNamed: number;
  readonly pathsTotal: number;
  /** Preserved paths named, and how many there were in all. */
  readonly preservedNamed: number;
  readonly preservedTotal: number;
  /** True when {@link MAX_BODY_CHARS} bit. A cap that bit is a cap we report. */
  readonly truncated: boolean;
}

/**
 * Replace every credential-shaped run inside the fenced spans, and COUNT the
 * replacements.
 *
 * ── WHY THE MARKERS ARE HELD OUT ─────────────────────────────────────────────
 *
 * `redactSecrets` removes any run of 20 or more `[A-Za-z0-9_-]` characters, and
 * `END-QAAI-UNTRUSTED-DATA` is twenty-three of them. Scrubbing a fenced block
 * naively therefore REDACTS OUR OWN CLOSING DELIMITER — and a fence whose
 * closer has been replaced by `[redacted]` is a fence that no longer closes,
 * which is the exact failure the fence exists to prevent. So the two markers are
 * swapped for placeholders that are too short to match, the scrub runs, and the
 * markers go back. Found by running it, not by reading it.
 *
 * The count is returned rather than logged: a body that was silently edited
 * must not pass as a faithful quote of what the run printed.
 */
export function scrubCredentials(text: string): { text: string; removed: number } {
  const OPEN_SLOT = '\u0000O\u0000';
  const CLOSE_SLOT = '\u0000C\u0000';
  const held = text.split(FENCE_OPEN).join(OPEN_SLOT).split(FENCE_CLOSE).join(CLOSE_SLOT);

  let removed = 0;
  const scrubbed = held
    .split('\n')
    .map((line) => {
      const next = redactSecrets(line);
      if (next !== line) removed += 1;
      return next;
    })
    .join('\n');

  return {
    text: scrubbed.split(OPEN_SLOT).join(FENCE_OPEN).split(CLOSE_SLOT).join(FENCE_CLOSE),
    removed,
  };
}

/**
 * Assemble the body.
 *
 * `spans` are {@link UntrustedSpan}s the CALLER made, and the provenance is
 * theirs to declare — this module fences, bounds, scrubs and discloses, it does
 * not decide what kind of text it was handed. That split matters: a fence whose
 * header says `TEST FILE FROM THE SUITE BEING IMPORTED` over a model's own
 * sentence is a header that lies in the one line a reader is most likely to
 * believe, and `UNTRUSTED_PROVENANCES` has no member for model output yet. See
 * the handover for the one-member addition that closes it; until it lands, a
 * caller with nothing honest to label a span cannot pass one, which is the
 * correct degradation rather than a mislabelled quote.
 */
export function buildPullRequestBody(args: {
  purpose: PrPurpose;
  /** The 64-hex cause key. Only its handle is rendered. */
  causeKey: string;
  filePaths: readonly string[];
  preservedPaths: readonly string[];
  spans?: readonly UntrustedSpan[];
}): PullRequestBody {
  const handle = args.causeKey.slice(0, PR_BRANCH_KEY_CHARS);
  const named = args.filePaths.slice(0, MAX_BODY_PATHS);
  const preserved = args.preservedPaths.slice(0, MAX_BODY_PATHS);

  const lines: string[] = [
    'QAAI opened this pull request.',
    '',
    `**Purpose** \`${args.purpose}\` · **Cause** \`${handle}\``,
    '',
    `**Files written** ${args.filePaths.length}`,
  ];
  for (const path of named) lines.push(`- \`${path}\``);
  if (args.filePaths.length > named.length) {
    lines.push(`- …and ${args.filePaths.length - named.length} more, all of them in the diff.`);
  }

  /*
   * The preserved list is here because its absence was a defect. `pushRepo` used
   * to infer ownership from absence and `git rm` every tracked file that was not
   * in its tree, which erased human edits made on the same branch. It now
   * refuses those paths and reports them, and a reviewer is entitled to see what
   * was LEFT ALONE — "QAAI did not touch these three files of yours" is the
   * sentence that makes the rest of the diff trustworthy.
   */
  lines.push('', `**Files left alone because a human owns them** ${args.preservedPaths.length}`);
  for (const path of preserved) lines.push(`- \`${path}\``);
  if (args.preservedPaths.length > preserved.length) {
    lines.push(`- …and ${args.preservedPaths.length - preserved.length} more.`);
  }

  const disclosures: FenceDisclosure[] = [];
  let credentialsScrubbed = 0;
  for (const span of args.spans ?? []) {
    const fenced = fence(span, { maxChars: BODY_SPAN_CHARS });
    const scrubbed = scrubCredentials(fenced.block);
    credentialsScrubbed += scrubbed.removed;
    disclosures.push(fenced.disclosure);
    lines.push('', `**${spanProvenance(span)}** — quoted, not acted on:`, '', scrubbed.text);
  }

  for (const disclosure of disclosures) {
    if (disclosure.charsNotShown > 0 || disclosure.fenceMarkersNeutralised > 0) {
      lines.push(
        '',
        `_${disclosure.provenance}: ${disclosure.charsShown} of ${disclosure.charsInSpan} ` +
          `character(s) quoted (${disclosure.charsNotShown} not shown, limit ` +
          `${disclosure.limitApplied}); ${disclosure.fenceMarkersNeutralised} QAAI fence marker(s) ` +
          `in the payload were replaced._`,
      );
    }
  }
  if (credentialsScrubbed > 0) {
    lines.push(
      '',
      `_${credentialsScrubbed} line(s) of the quoted text had a credential-shaped value removed ` +
        `before this body was written._`,
    );
  }

  let body = lines.join('\n');
  const truncated = body.length > MAX_BODY_CHARS;
  if (truncated) {
    // Said out loud, in our own words, with the number. A body that stopped
    // mid-sentence with no note reads as the whole story.
    body = `${body.slice(0, MAX_BODY_CHARS - 120)}\n\n_…this description was cut at ${MAX_BODY_CHARS} characters by QAAI. The diff is complete._`;
  }

  return {
    body,
    disclosures,
    credentialsScrubbed,
    pathsNamed: named.length,
    pathsTotal: args.filePaths.length,
    preservedNamed: preserved.length,
    preservedTotal: args.preservedPaths.length,
    truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The injected host.
// ─────────────────────────────────────────────────────────────────────────────

export interface PullRequestTarget {
  /** `owner/repo`, from the integration's own configuration. */
  readonly repo: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface HostPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
}

/**
 * Why a host would not open it.
 *
 * A CLOSED VOCABULARY, and that is the whole design. The alternative — carrying
 * the host's own message — puts attacker-influenceable text (an error body is
 * chosen by whoever is answering) into `PullRequestRecord.failureNote`, a column
 * a human reads and other prompts may quote, and an error body routinely echoes
 * the request that carried the token.
 */
export const HOST_REFUSALS = [
  /** The stored token was rejected. */
  'UNAUTHENTICATED',
  /** Authenticated, and not allowed to open a PR here. */
  'FORBIDDEN',
  /** The repository does not exist, or the token cannot see it. */
  'NOT_FOUND',
  /** The head branch is not on the remote — the push did not happen or was rejected. */
  'BRANCH_MISSING',
  /** A PR for this head already exists. Recoverable: we adopt it. */
  'ALREADY_EXISTS',
  'RATE_LIMITED',
  'UNREACHABLE',
  /** The host answered with a redirect, which QAAI will not follow while holding a token. */
  'REFUSED_REDIRECT',
  'UNKNOWN',
] as const;
export type HostRefusal = (typeof HOST_REFUSALS)[number];

/** Our sentence per refusal. `Record`, so a new member cannot render `undefined`. */
export const HOST_REFUSAL_LABELS: Record<HostRefusal, string> = {
  UNAUTHENTICATED:
    'the git host rejected the stored token — re-enter it on that integration in Settings',
  FORBIDDEN: 'the stored token is not allowed to open a pull request in that repository',
  NOT_FOUND: 'the git host could not find that repository, or the token cannot see it',
  BRANCH_MISSING: 'the branch is not on the remote, so there was nothing to open a pull request from',
  ALREADY_EXISTS: 'a pull request for that branch already exists',
  RATE_LIMITED: 'the git host is rate-limiting QAAI — nothing was opened, and it can be retried',
  UNREACHABLE: 'the git host did not answer',
  REFUSED_REDIRECT:
    'the git host answered with a redirect, and QAAI will not follow one while holding your token',
  UNKNOWN: 'the git host refused the request for a reason QAAI does not recognise',
};

export type HostOpenResult =
  | { readonly ok: true; readonly pr: HostPullRequest }
  | { readonly ok: false; readonly refusal: HostRefusal };

/**
 * The git host, INJECTED.
 *
 * An interface rather than a bare function pair so an implementation can be a
 * class holding an unsealed token for the duration of one call without its
 * `this` being detached at the call site.
 *
 * `apiHost` and `apiHostFromCustomerConfig` are declared rather than inferred
 * because the SSRF question differs per provider and the host is the only one
 * that knows: github.com has exactly one API host and QAAI pins it, while a
 * self-hosted GitLab's host comes out of a config row an org admin can edit.
 * {@link openPullRequest} classifies the second kind before anything connects.
 */
export interface GitHost {
  readonly provider: GitIntegrationKind;
  readonly apiHost: string;
  readonly apiHostFromCustomerConfig: boolean;
  openPullRequest(args: {
    target: PullRequestTarget;
    title: string;
    body: string;
  }): Promise<HostOpenResult>;
  /** Used to ADOPT a PR that already exists for this head, so a retry cannot open a second. */
  findOpenPullRequest(target: PullRequestTarget): Promise<HostPullRequest | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The injected store, audit sink and re-measurement.
// ─────────────────────────────────────────────────────────────────────────────

export interface PullRequestRecordRow {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly purpose: string;
  readonly causeKey: string;
  readonly state: PrRecordState;
  readonly number: number | null;
  readonly url: string | null;
}

/** What the caller must already have established about the destination. */
export interface PullRequestTargetRecord {
  readonly integrationId: string;
  readonly provider: GitIntegrationKind;
  /** `owner/repo` off the integration row. */
  readonly repo: string;
  /** The branch QAAI pushed. Composed by {@link branchNameFor}; re-checked here. */
  readonly branch: string;
  /** The integration's configured default branch. */
  readonly baseRef: string;
  /**
   * TRUE only when the customer turned pull requests on for this project.
   *
   * A field and not an assumption: "it happens only on a path the customer
   * explicitly enabled" has to be a value somebody wrote, and a store that
   * could not say `false` would make the setting unreadable.
   */
  readonly pullRequestsEnabled: boolean;
}

/**
 * The persistence QAAI needs, as NARROW METHODS rather than a Prisma client.
 *
 * ── WHY NOT A PRISMA DELEGATE ───────────────────────────────────────────────
 *
 * Because a fake that ignores `select` makes deleting a field from a query
 * undetectable, and two defects have already survived a slice behind one. These
 * methods take exactly the arguments they need and return exactly the columns
 * named above, so there is no `select` for a fake to be blind to — the projection
 * is in the TYPE, and dropping a column from it is a compile error at every
 * reader. The Prisma implementation is five queries in the route; the exact text
 * is in this round's handover.
 */
export interface PullRequestStore {
  /** The destination, or null when the integration is missing or disabled. */
  loadTarget(args: {
    orgId: string;
    projectId: string;
    integrationId: string;
  }): Promise<PullRequestTargetRecord | null>;
  /**
   * The record that already claims this cause, or null.
   *
   * A READ and not a probe through {@link PullRequestStore.claim}. An earlier
   * draft of this file reused `claim` to answer the same question, which INSERTS
   * on the miss — so a merge webhook for a branch QAAI never pushed would have
   * minted a REQUESTED record for a PR that does not exist. A read-only question
   * gets a read-only method.
   */
  findByCauseKey(args: { orgId: string; causeKey: string }): Promise<PullRequestRecordRow | null>;
  /**
   * INSERT a record in REQUESTED, which is how the cause is claimed.
   *
   * `created: false` means `@@unique([orgId, causeKey])` refused it and carries
   * the row that won, so the loser can report what already exists rather than
   * guessing. Returning the winner is load-bearing: a `false` with no row would
   * make a concurrent claim indistinguishable from a vanished one.
   */
  claim(args: {
    orgId: string;
    projectId: string;
    provider: GitIntegrationKind;
    integrationId: string;
    repo: string;
    branch: string;
    baseRef: string;
    purpose: PrPurpose;
    causeKey: string;
    filePaths: readonly string[];
    preservedPaths: readonly string[];
    openedBy: string | null;
  }): Promise<{ created: true; row: PullRequestRecordRow } | { created: false; row: PullRequestRecordRow }>;
  /** Move a claimed row off REQUESTED. `failureNote` is ours; never a host body. */
  settle(args: {
    id: string;
    state: PrRecordState;
    number?: number | null;
    url?: string | null;
    failureNote?: string | null;
  }): Promise<PullRequestRecordRow>;
  /**
   * Copy the url onto the heal that asked for it.
   *
   * `HealProposal.prUrl` is the denormalised copy the heal list renders without
   * a join, and `prRecordId` points at the row that owns the idempotence key.
   * Both, or neither: a url with no record id is a PR whose second apply cannot
   * find it.
   */
  attachToHeal(args: { healId: string; prRecordId: string; url: string }): Promise<void>;
}

export interface AuditSink {
  record(entry: {
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * The coverage re-measurement a merge owes.
 *
 * REQUIRED on the merge path, not optional and not a returned obligation. A
 * merged PR changes the code the denominator is measured over, and a module that
 * handed its caller a note saying so would be the fifth honesty column with a
 * writer and no reader.
 */
export interface Remeasure {
  recompute(args: { orgId: string; projectId: string; reason: string }): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening it.
// ─────────────────────────────────────────────────────────────────────────────

export const PR_OUTCOMES = [
  /** The host opened it and the record holds its url. */
  'OPENED',
  /** This cause already had a record. Nothing was sent. */
  'ALREADY_RECORDED',
  /**
   * The host already had a PR for this head and QAAI adopted it rather than
   * opening a second. The recoverable half of idempotence: our record can be
   * lost (a crash between the push and the claim) while the host's PR is not.
   */
  'ADOPTED_EXISTING',
  /** QAAI refused before connecting. `refusalPaths` says which field. */
  'REFUSED',
  /** The host refused. `HOST_REFUSAL_LABELS` says what to change. */
  'HOST_FAILED',
  /** The destination did not pass {@link classifyHost} / {@link resolvesPublicly}. */
  'DESTINATION_REFUSED',
] as const;
export type PrOutcome = (typeof PR_OUTCOMES)[number];

export interface OpenPullRequestInput {
  orgId: string;
  projectId: string;
  purpose: PrPurpose;
  /** The cause identity, pre-hashed by {@link prCauseKey}. */
  causeKey: string;
  integrationId: string;
  /** Paths QAAI wrote on the branch, from `PushResult`. */
  filePaths: readonly string[];
  /** Paths QAAI refused to write because a human owns them, from `PushResult.filesKept`. */
  preservedPaths: readonly string[];
  /** Untrusted evidence for the body. Fenced; see {@link buildPullRequestBody}. */
  spans?: readonly UntrustedSpan[];
  /** The `HealProposal` to write `prUrl` back onto, when this is a heal's PR. */
  healId?: string | null;
  /** The user whose action this was, for the record and the audit row. */
  actorUserId?: string | null;
}

export interface OpenPullRequestResult {
  readonly outcome: PrOutcome;
  readonly record: PullRequestRecordRow | null;
  readonly url: string | null;
  /** One sentence, safe to show, never carrying host prose or a credential. */
  readonly note: string;
  /** zod PATHS, capped, when the outcome is REFUSED. Never zod messages. */
  readonly refusalPaths: readonly string[];
  /** How many issues there were in all, so a capped list cannot read as the whole list. */
  readonly refusalTotal: number;
  readonly hostRefusal: HostRefusal | null;
  /** The body's disclosures, so a caller can report what the quote left out. */
  readonly body: PullRequestBody | null;
}

/** zod paths and codes, capped. See rule 16: a path is ours, a message is not. */
const MAX_REFUSAL_PATHS = 10;
function refusalPathsOf(error: {
  issues: readonly { path: readonly PropertyKey[]; code: string }[];
}): { paths: string[]; total: number } {
  return {
    paths: error.issues
      .slice(0, MAX_REFUSAL_PATHS)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'} [${issue.code}]`),
    total: error.issues.length,
  };
}

function refused(
  paths: string[],
  total: number,
  note: string,
  body: PullRequestBody | null = null,
): OpenPullRequestResult {
  return {
    outcome: 'REFUSED',
    record: null,
    url: null,
    note,
    refusalPaths: paths,
    refusalTotal: total,
    hostRefusal: null,
    body,
  };
}

/**
 * Open one pull request for one cause, or say exactly why not.
 *
 * It never throws for a refusal. Every arm returns a {@link PrOutcome} and a
 * sentence, because the two callers are a background processor and a CI-driven
 * route: a throw in the first loses the reason, and in the second turns a
 * recoverable "your token expired" into a 500.
 */
export async function openPullRequest(
  deps: {
    store: PullRequestStore;
    host: GitHost;
    audit: AuditSink;
    /** Injected so the resolver is a test's to control. Defaults to node's. */
    lookup?: LookupFn;
  },
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const target = await deps.store.loadTarget({
    orgId: input.orgId,
    projectId: input.projectId,
    integrationId: input.integrationId,
  });
  if (!target) {
    return refused(
      ['integrationId [custom]'],
      1,
      'That git integration is missing or disabled, so nothing was sent.',
    );
  }

  /*
   * THE EXPLICIT-ENABLEMENT GATE, and it is first for a reason: a customer who
   * has not turned pull requests on must not have their token used, their repo
   * resolved or a row written about a PR that was never going to happen.
   */
  if (!target.pullRequestsEnabled) {
    return refused(
      ['pullRequestsEnabled [custom]'],
      1,
      'Pull requests are not enabled for this project, so QAAI pushed the branch and opened nothing. Turn them on in Settings → Source control.',
    );
  }

  if (target.provider !== deps.host.provider) {
    /*
     * A GitLab integration must not be driven by the GitHub host. Cheap to
     * check and the failure it prevents is a token sent to the wrong company.
     */
    return refused(
      ['integrationId [custom]'],
      1,
      'That integration belongs to a different git host than the one QAAI was asked to use.',
    );
  }

  /*
   * ── THE DESTINATION, CLASSIFIED BEFORE ANYTHING CONNECTS ──────────────────
   *
   * Only when the host is CUSTOMER-NAMED. api.github.com is QAAI's own constant
   * and resolving it on every PR would add a DNS round trip and a new way to
   * fail to a destination that cannot be repointed. A self-hosted host comes out
   * of a config row an org admin edits, and that one is checked.
   *
   * `resolvesPublicly` is a CHECK AND NOT A PIN — the connecting code resolves
   * the name again, so a resolver that answers differently the second time can
   * still steer the request. That limitation is the module's own and is repeated
   * here so this call site does not read as a guarantee.
   */
  if (deps.host.apiHostFromCustomerConfig) {
    const shape = classifyHost(deps.host.apiHost);
    if (shape.kind === 'ambiguous' || (shape.kind === 'name' && shape.internal)) {
      return {
        outcome: 'DESTINATION_REFUSED',
        record: null,
        url: null,
        note: 'That integration points at a host QAAI will not connect to while holding your token.',
        refusalPaths: ['integrationId [custom]'],
        refusalTotal: 1,
        hostRefusal: null,
        body: null,
      };
    }
    const verdict = await resolvesPublicly(deps.host.apiHost, deps.lookup);
    if (!verdict.ok) {
      return {
        outcome: 'DESTINATION_REFUSED',
        record: null,
        url: null,
        // Our own sentence. `verdict.reason` names the host and the address class
        // and is safe, but it is not needed to act and this field is read by
        // people who should not be shown internal addressing.
        note: 'That integration points at a host QAAI will not connect to while holding your token.',
        refusalPaths: ['integrationId [custom]'],
        refusalTotal: 1,
        hostRefusal: null,
        body: null,
      };
    }
  }

  /*
   * The branch is RE-COMPOSED here and not taken from the caller. A caller that
   * passed its own branch string would be the one hole in "the target is ours",
   * and the whole point of `branchNameFor` is that there is no way to express a
   * branch built out of somebody else's text.
   */
  let branch: string;
  try {
    branch = branchNameFor({ purpose: input.purpose, causeKey: input.causeKey });
  } catch {
    return refused(['causeKey [custom]'], 1, 'That cause key is not one QAAI composed.');
  }
  if (branch !== target.branch) {
    return refused(
      ['branch [custom]'],
      1,
      'The branch QAAI pushed is not the branch this cause composes, so nothing was opened.',
    );
  }

  const handle = input.causeKey.slice(0, PR_BRANCH_KEY_CHARS);
  const built = buildPullRequestBody({
    purpose: input.purpose,
    causeKey: input.causeKey,
    filePaths: input.filePaths,
    preservedPaths: input.preservedPaths,
    spans: input.spans,
  });
  const title = PR_TITLE[input.purpose](input.filePaths.length, handle);

  /*
   * THE VALIDATOR THE WRITE PATH ACTUALLY RUNS, and the one the keystone wrote
   * for exactly this call: shape-constrained target fields, a bounded title, a
   * bounded body, no overlap between written and preserved paths. Ending the
   * check anywhere earlier would be asserting a value's spelling rather than
   * that it can be stored.
   */
  const parsed = openPullRequestSchema.safeParse({
    projectId: input.projectId,
    purpose: input.purpose,
    causeKey: input.causeKey,
    integrationId: target.integrationId,
    repo: target.repo,
    branch,
    baseRef: target.baseRef,
    title,
    body: built.body,
    filePaths: [...input.filePaths],
    preservedPaths: [...input.preservedPaths],
  });
  if (!parsed.success) {
    const { paths, total } = refusalPathsOf(parsed.error);
    return refused(
      paths,
      total,
      `QAAI refused to open this pull request: ${total} field(s) did not validate, the first ${paths.length} at ${paths.join(', ')}.`,
      built,
    );
  }

  // ── The claim. The INSERT is the decision. ─────────────────────────────────
  let claimed = await deps.store.claim({
    orgId: input.orgId,
    projectId: input.projectId,
    provider: target.provider,
    integrationId: target.integrationId,
    repo: target.repo,
    branch,
    baseRef: target.baseRef,
    purpose: input.purpose,
    causeKey: input.causeKey,
    filePaths: input.filePaths,
    preservedPaths: input.preservedPaths,
    openedBy: input.actorUserId ?? null,
  });

  if (!claimed.created) {
    const existing = claimed.row;

    /*
     * ── A DECLINED PULL REQUEST IS NOT A PERMANENT STOP ──────────────────────
     *
     * THE DEFECT. `@@unique([orgId, causeKey])` is owned by the record whatever
     * its state, and this returned ALREADY_RECORDED for every one of them — so a
     * cause whose pull request a reviewer CLOSED WITHOUT MERGING could never get
     * a second one. For ever. The product's answer to "fix the review comments
     * and send it again" was a note saying a pull request already exists, about
     * a pull request nobody can open.
     *
     * CLOSED and FAILED do not claim an open review, so the cause is free again
     * and the row is REUSED rather than a second one inserted: one record per
     * cause keeps `@@unique` meaningful and keeps one audit trail per cause.
     *
     * THE THREE THAT STILL STOP A RETRY, and each for its own reason:
     *   · OPEN — there is a live review; a second PR for one cause is the defect
     *     the constraint exists to prevent;
     *   · MERGED — it landed, and re-opening would propose the change again;
     *   · REQUESTED — "we were about to", and "about to" plus a second attempt
     *     is exactly how two PRs get opened for one cause. A REQUESTED row that
     *     never settles is visible and recoverable; a duplicate pull request in
     *     a customer's repository is not.
     */
    const reopenable = existing.state === 'CLOSED' || existing.state === 'FAILED';
    if (!reopenable) {
      return {
        outcome: 'ALREADY_RECORDED',
        record: existing,
        url: existing.url,
        note:
          existing.url === null
            ? `This cause already has a pull-request record (${existing.state}), so nothing was opened a second time.`
            : `This cause already has a pull request: ${existing.url}`,
        refusalPaths: [],
        refusalTotal: 0,
        hostRefusal: null,
        body: built,
      };
    }

    /*
     * Back to REQUESTED, with the previous attempt's number, url and failure
     * note CLEARED. Leaving the old url on a row that is being retried is two
     * facts in one field: a reader could not tell the closed pull request from
     * the one about to be opened.
     */
    claimed = {
      created: true,
      row: await deps.store.settle({
        id: existing.id,
        state: 'REQUESTED',
        number: null,
        url: null,
        failureNote: null,
      }),
    };
  }

  const prTarget: PullRequestTarget = { repo: target.repo, branch, baseRef: target.baseRef };
  const sent = await deps.host.openPullRequest({
    target: prTarget,
    title: parsed.data.title,
    body: parsed.data.body,
  });

  let pr: HostPullRequest | null = null;
  let adopted = false;
  if (sent.ok) {
    pr = sent.pr;
  } else if (sent.refusal === 'ALREADY_EXISTS') {
    // The host has one and our record did not. Adopt it; opening another is the
    // one outcome that cannot be undone from here.
    pr = await deps.host.findOpenPullRequest(prTarget);
    adopted = pr !== null;
  }

  if (pr === null) {
    const refusal: HostRefusal = sent.ok ? 'UNKNOWN' : sent.refusal;
    const note = `QAAI pushed the branch and could not open the pull request: ${HOST_REFUSAL_LABELS[refusal]}.`;
    const record = await deps.store.settle({
      id: claimed.row.id,
      state: 'FAILED',
      // OUR prose, keyed off a closed vocabulary. Never the host's body.
      failureNote: note,
    });
    await deps.audit.record({
      action: 'pull-request.failed',
      targetType: 'PullRequestRecord',
      targetId: record.id,
      metadata: {
        projectId: input.projectId,
        purpose: input.purpose,
        causeKey: input.causeKey,
        repo: target.repo,
        branch,
        baseRef: target.baseRef,
        hostRefusal: refusal,
      },
    });
    return {
      outcome: 'HOST_FAILED',
      record,
      url: null,
      note,
      refusalPaths: [],
      refusalTotal: 0,
      hostRefusal: refusal,
      body: built,
    };
  }

  const record = await deps.store.settle({
    id: claimed.row.id,
    state: pr.state === 'MERGED' ? 'MERGED' : pr.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    number: pr.number,
    url: pr.url,
  });

  if (input.healId) {
    /*
     * The write-back that closes the original defect. It is deliberately AFTER
     * the record is settled: a `HealProposal.prUrl` pointing at a PR with no
     * record would be a url whose idempotence key nobody holds, so the second
     * apply of that heal would open another.
     */
    await deps.store.attachToHeal({
      healId: input.healId,
      prRecordId: record.id,
      url: pr.url,
    });
  }

  await deps.audit.record({
    action: adopted ? 'pull-request.adopted' : 'pull-request.opened',
    targetType: 'PullRequestRecord',
    targetId: record.id,
    metadata: {
      projectId: input.projectId,
      purpose: input.purpose,
      causeKey: input.causeKey,
      repo: target.repo,
      branch,
      baseRef: target.baseRef,
      number: pr.number,
      url: pr.url,
      // Counts and paths, never file contents — and the caps that bit, disclosed.
      fileCount: input.filePaths.length,
      preservedCount: input.preservedPaths.length,
      pathsNamedInBody: built.pathsNamed,
      bodyTruncated: built.truncated,
      credentialsScrubbed: built.credentialsScrubbed,
      spansQuoted: built.disclosures.length,
      healId: input.healId ?? null,
    },
  });

  return {
    outcome: adopted ? 'ADOPTED_EXISTING' : 'OPENED',
    record,
    url: pr.url,
    note: adopted
      ? `A pull request for this branch already existed, so QAAI adopted it rather than opening a second: ${pr.url}`
      : `Opened ${pr.url}`,
    refusalPaths: [],
    refusalTotal: 0,
    hostRefusal: null,
    body: built,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merging it — where the loop closes.
// ─────────────────────────────────────────────────────────────────────────────

export const MERGE_OUTCOMES = [
  'MERGED',
  /** Already recorded as merged. Idempotent; nothing re-measured. */
  'ALREADY_MERGED',
  /** No record claims this cause, so this merge is not one of ours. */
  'NOT_OURS',
] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

export interface MergeResult {
  readonly outcome: MergeOutcome;
  readonly record: PullRequestRecordRow | null;
  /**
   * Whether the coverage re-measurement actually ran.
   *
   * TWO FACTS, TWO FIELDS. `outcome: 'MERGED'` says the state was recorded and
   * this says the number was re-measured, and they can differ — the state write
   * commits and the queue can be down. Folding them into one would make a merge
   * whose coverage was never recomputed indistinguishable from one that was,
   * which is a coverage number reported as measured when it was not.
   */
  readonly remeasured: boolean;
  readonly note: string;
}

/**
 * Record a merge and RE-MEASURE.
 *
 * The order is load-bearing in the same way the apply paths' verification order
 * is: the state is written first, because a re-measurement that ran against a
 * merge nobody recorded leaves a coverage number whose cause cannot be found,
 * while a recorded merge whose re-measurement failed leaves a stale number with
 * `remeasured: false` beside it — visible, and recoverable by the next run.
 *
 * `causeKey` and not a PR number, because the number is the host's identity and
 * the cause is ours: a webhook replayed after the integration was re-created
 * still finds the right row.
 */
export async function recordPullRequestMerged(
  deps: { store: PullRequestStore; audit: AuditSink; remeasure: Remeasure },
  args: {
    orgId: string;
    causeKey: string;
    /**
     * No `projectId`, deliberately. The row's own `projectId` is what the
     * re-measurement is scoped to, and a caller-supplied one could disagree with
     * it — a webhook's payload is attacker-influenceable, and a coverage
     * recompute pointed at the wrong project by a field nobody cross-checked is
     * a number that moves for no reason anybody can trace.
     */
    mergedBy?: string | null;
  },
): Promise<MergeResult> {
  const existing = await deps.store.findByCauseKey({
    orgId: args.orgId,
    causeKey: args.causeKey,
  });

  if (!existing) {
    return {
      outcome: 'NOT_OURS',
      record: null,
      remeasured: false,
      note: 'No QAAI pull-request record claims that cause, so nothing was changed.',
    };
  }
  if (existing.state === 'MERGED') {
    return {
      outcome: 'ALREADY_MERGED',
      record: existing,
      remeasured: false,
      note: 'That pull request was already recorded as merged, so nothing was re-measured a second time.',
    };
  }

  const record = await deps.store.settle({ id: existing.id, state: 'MERGED' });

  let remeasured = false;
  let note = `Recorded ${record.url ?? record.branch} as merged.`;
  try {
    await deps.remeasure.recompute({
      orgId: record.orgId,
      projectId: record.projectId,
      reason: `pull request ${record.branch} merged`,
    });
    remeasured = true;
    note += ' Coverage is being re-measured over the merged code.';
  } catch {
    /*
     * NOT re-thrown and NOT swallowed. The merge is recorded and the number is
     * stale, and `remeasured: false` is the field that says so. Throwing here
     * would roll the merge back out of the record while the customer's
     * repository has it, which is the one state nobody can reconcile.
     */
    note +=
      ' The coverage re-measurement could not be queued, so the coverage number does not yet include this merge.';
  }

  await deps.audit.record({
    action: 'pull-request.merged',
    targetType: 'PullRequestRecord',
    targetId: record.id,
    metadata: {
      projectId: record.projectId,
      purpose: record.purpose,
      causeKey: record.causeKey,
      repo: record.repo,
      branch: record.branch,
      number: record.number,
      mergedBy: args.mergedBy ?? null,
      // On the record next to the merge, because "merged" and "re-measured" are
      // different claims.
      remeasured,
    },
  });

  return { outcome: 'MERGED', record, remeasured, note };
}

/** Every state a record can hold, re-exported so a reader has one import. */
export { PR_RECORD_STATES };
