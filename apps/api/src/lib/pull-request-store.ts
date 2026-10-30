/**
 * The half of the pull-request record nothing could write: the CLOSE.
 *
 * ─── WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN ───────────────────────────
 *
 * A second `PullRequestStore`. The Prisma one already exists — `pullRequestStore`
 * and `pullRequestAudit` in ./git.ts — and it is the one `POST
 * /agent/heals/:healId/pull-request` already drives. A second implementation
 * would be a second opinion about which repository, which branch and which base
 * ref an outward-facing write may name, and that is the exact shape of defect
 * the PR path is built to not have. Everything below takes the EXISTING store as
 * an injected {@link PullRequestStore} and adds only what had no code at all.
 *
 * ─── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `recordPullRequestMerged` (./pull-request.ts) had no caller anywhere in this
 * repository, and there was no function at all for the other way a pull request
 * ends. GitHub sends ONE event for both — `pull_request` with `action: 'closed'`
 * — and `merged` is the boolean that separates them. Nothing read it, so a
 * record written by the open path sat at OPEN for ever: a reviewer closing a
 * QAAI pull request without merging left a row claiming an open review that no
 * longer existed, which is a thing reported as true that was not measured.
 *
 * ─── AND WHAT MOVING IT TO CLOSED DOES *NOT* FIX ───────────────────────────
 *
 * It does not release the cause. `claim` in ./git.ts inserts against
 * `@@unique([orgId, causeKey])` and `openPullRequest` reports ALREADY_RECORDED
 * for ANY existing row regardless of its state, so after this file lands a
 * closed-unmerged cause still cannot get a second pull request — it just says
 * so out loud (`(CLOSED)` in the note) instead of silently. Making a CLOSED row
 * re-openable is a change to `openPullRequest`/`claim`, which this round's file
 * ownership puts elsewhere; the exact edit is in this round's handover. The
 * honest record comes first, because a row that lies about the state of a
 * customer's repository is worse than a row that is stuck.
 *
 * ─── THE HEAD REF IS UNTRUSTED TEXT AND IT STILL HAS TO FIND A ROW ─────────
 *
 * A webhook payload is attacker-influenceable: the repository is somebody
 * else's, the branch name is whatever was pushed, and the delivery can be
 * replayed. So {@link qaaiBranchShape} is a SHAPE GATE and not a sanitiser — a
 * ref that is not one `branchNameFor` could have produced is refused before any
 * query runs, and the only thing the surviving string is ever used for is an
 * EQUALITY comparison against the `branch` column QAAI itself wrote.
 * {@link findRecordByBranch} refuses an ambiguous match rather than picking one,
 * because guessing which row a customer's branch name meant is how a merge gets
 * recorded against the wrong cause.
 */

import { PR_RECORD_STATES } from '@qaai/shared';
import type { PrRecordState } from '@qaai/shared';
import {
  PR_BRANCH_KEY_CHARS,
  PR_BRANCH_PREFIX,
  PR_PURPOSE_BRANCH_SEGMENT,
} from './pull-request.js';
import type { AuditSink, PullRequestRecordRow, PullRequestStore } from './pull-request.js';

// ─────────────────────────────────────────────────────────────────────────────
// The shape gate: is this ref one QAAI could have composed?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The longest ref worth looking at, so a 40KB `head.ref` cannot reach a regex.
 *
 * Every branch QAAI composes is `qaai/<segment>/<12 hex>` and the longest
 * segment is 8 characters, so the real ceiling is well under 30. 128 is the
 * bound on the INPUT rather than a claim about the output: it exists so the
 * length check happens before any pattern matching, which is the half of a
 * redos-shaped risk that is free to remove.
 */
export const MAX_INSPECTED_REF_CHARS = 128;

/**
 * The branch grammar, derived from the purpose table rather than retyped.
 *
 * `PR_PURPOSE_BRANCH_SEGMENT` is `satisfies Record<PrPurpose, string>`, so a
 * fifth purpose is a compile error there — and because this gate reads the same
 * object, the new purpose's branches become recognisable here in the same
 * change. A hand-written `(heal|tests|retire|closure)` would have left the new
 * purpose's pull requests permanently unreconcilable, and the symptom would have
 * been a merge quietly reported as "not one of ours".
 */
const SEGMENT_ALTERNATION = Object.values(PR_PURPOSE_BRANCH_SEGMENT).join('|');

const QAAI_BRANCH_RE = new RegExp(
  `^${PR_BRANCH_PREFIX}/(?:${SEGMENT_ALTERNATION})/[0-9a-f]{${PR_BRANCH_KEY_CHARS}}$`,
);

/**
 * The ref, if it is one of ours, or null.
 *
 * ANCHORED AND TOTAL. There is no normalisation step: a ref that needed
 * repairing to match is a ref somebody else chose a character of, which is the
 * same rule `branchNameFor` applies on the way out. `refs/heads/` is NOT
 * stripped either — GitHub's `pull_request.head.ref` is the bare branch name,
 * and accepting both spellings here would mean two strings resolve to one row
 * while only one of them can ever equal the stored column.
 */
export function qaaiBranchShape(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  if (ref.length === 0 || ref.length > MAX_INSPECTED_REF_CHARS) return null;
  return QAAI_BRANCH_RE.test(ref) ? ref : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving the record from the branch.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The columns the resolver reads, and only those.
 *
 * Narrower than `PullRequestRecordRow` on purpose: this query's whole job is to
 * turn a branch into the `causeKey` that the real store then works in terms of.
 * Everything a caller does afterwards goes through
 * {@link PullRequestStore.findByCauseKey}, which owns the full projection — so
 * there is one place that knows what a record row is, and this is not a second
 * one.
 */
export interface BranchResolution {
  readonly id: string;
  readonly projectId: string;
  readonly causeKey: string;
  readonly branch: string;
  /** Narrowed; an unrecognised stored value is refused rather than assumed. */
  readonly state: PrRecordState | null;
}

/** The narrow Prisma surface the resolver needs, declared rather than imported. */
export interface PullRequestLookupDb {
  pullRequestRecord: {
    findMany(args: unknown): Promise<
      ReadonlyArray<{
        id: string;
        projectId: string;
        causeKey: string;
        branch: string;
        state: string;
      }>
    >;
  };
}

export type BranchLookup =
  | { readonly kind: 'FOUND'; readonly row: BranchResolution }
  | { readonly kind: 'NONE' }
  /**
   * Two or more rows claim this branch. NOTHING is chosen.
   *
   * The branch carries only the first {@link PR_BRANCH_KEY_CHARS} of the cause
   * key, so two causes in one org CAN collide on it — astronomically rarely, and
   * "rare" is not "never" for a value that decides which record a merge is
   * written against. `matched` is reported so the operator sees a real number
   * rather than a shrug.
   */
  | { readonly kind: 'AMBIGUOUS'; readonly matched: number };

/**
 * How many rows the resolver will look at. Two is enough to detect ambiguity.
 *
 * `take: 2` and not `take: 1`: a `findFirst` would have silently returned
 * whichever row the planner reached first and the collision above would have
 * been invisible.
 */
const BRANCH_LOOKUP_TAKE = 2;

/**
 * Find the record a QAAI branch belongs to.
 *
 * ── WHY THE REPOSITORY IS NOT IN THE FILTER ────────────────────────────────
 *
 * `Integration.config.repo` is stored in two spellings — `owner/repo` and
 * `https://github.com/owner/repo`, which is why the webhook's own integration
 * lookup matches both — and `PullRequestRecord.repo` holds whichever one that
 * org configured. A filter on it would therefore match NOTHING for half the
 * customers, and the symptom would be every real merge reported as "not one of
 * ours": a failure suppressed without being counted. The scope that is actually
 * sound is `orgId` (QAAI resolved it from the integration row, the payload did
 * not choose it) plus a branch QAAI composed, plus the refusal to guess when two
 * rows answer.
 */
export async function findRecordByBranch(
  db: PullRequestLookupDb,
  args: { orgId: string; branch: string },
): Promise<BranchLookup> {
  const rows = await db.pullRequestRecord.findMany({
    where: { orgId: args.orgId, branch: args.branch },
    select: { id: true, projectId: true, causeKey: true, branch: true, state: true },
    take: BRANCH_LOOKUP_TAKE,
  });
  if (rows.length === 0) return { kind: 'NONE' };
  if (rows.length > 1) return { kind: 'AMBIGUOUS', matched: rows.length };

  const row = rows[0]!;
  /*
   * An unrecognised `state` becomes NULL and is not passed through, for the
   * reason `narrowPrRecord` in ./git.ts gives: the column is TEXT with its
   * domain at the producer, so a row written by a future version must not read
   * as a state this version understands. NULL then falls through
   * {@link recordPullRequestClosed}'s transition table and changes nothing,
   * which is the arm that cannot make anything worse.
   */
  const state = (PR_RECORD_STATES as readonly string[]).includes(row.state)
    ? (row.state as PrRecordState)
    : null;
  return {
    kind: 'FOUND',
    row: { id: row.id, projectId: row.projectId, causeKey: row.causeKey, branch: row.branch, state },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Closing it without a merge.
// ─────────────────────────────────────────────────────────────────────────────

export const CLOSE_OUTCOMES = [
  /** The record moved from REQUESTED or OPEN to CLOSED. */
  'CLOSED',
  /** Already CLOSED. Idempotent — a redelivered webhook writes nothing. */
  'ALREADY_CLOSED',
  /**
   * The row says MERGED and the event says closed-without-merging.
   *
   * REFUSED, not applied. GitHub sends `closed` for a merge too, so the two
   * events differ only by a boolean in the payload — and a replay, a
   * hand-crafted delivery or a bug that dropped `merged` would otherwise
   * overwrite a merge QAAI had already recorded and re-measured coverage for.
   * Downgrading MERGED to CLOSED is a measured fact replaced by a weaker one.
   */
  'WOULD_DOWNGRADE_MERGE',
  /** The row is FAILED, or holds a state this version does not know. Nothing to close. */
  'NOT_CLOSEABLE',
  /** No record claims that cause. */
  'NOT_OURS',
] as const;
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number];

export interface CloseResult {
  readonly outcome: CloseOutcome;
  readonly record: PullRequestRecordRow | null;
  readonly note: string;
}

/**
 * Record that a pull request was closed WITHOUT being merged.
 *
 * The mirror of `recordPullRequestMerged`, and deliberately NOT a re-measuring
 * path: nothing landed in the customer's trunk, so the code the coverage
 * denominator is measured over did not change. Re-measuring here would write a
 * snapshot whose cause a reader could not find — the number would move on a
 * close, which is the kind of unexplained movement that makes a coverage figure
 * stop being believed.
 *
 * `causeKey` and not a PR number, for the reason the merge path gives: the
 * number is the host's identity and the cause is ours.
 */
export async function recordPullRequestClosed(
  deps: { store: PullRequestStore; audit: AuditSink },
  args: {
    orgId: string;
    causeKey: string;
    /** Who closed it, when the event said. NULL is "we were not told". */
    closedBy?: string | null;
  },
): Promise<CloseResult> {
  const existing = await deps.store.findByCauseKey({ orgId: args.orgId, causeKey: args.causeKey });
  if (!existing) {
    return {
      outcome: 'NOT_OURS',
      record: null,
      note: 'No QAAI pull-request record claims that cause, so nothing was changed.',
    };
  }
  if (existing.state === 'CLOSED') {
    return {
      outcome: 'ALREADY_CLOSED',
      record: existing,
      note: 'That pull request was already recorded as closed, so nothing was changed.',
    };
  }
  if (existing.state === 'MERGED') {
    return {
      outcome: 'WOULD_DOWNGRADE_MERGE',
      record: existing,
      note: 'That pull request is already recorded as merged, and a merge is not replaced by a close.',
    };
  }
  if (existing.state !== 'REQUESTED' && existing.state !== 'OPEN') {
    return {
      outcome: 'NOT_CLOSEABLE',
      record: existing,
      note: `That pull-request record is ${existing.state}, which is not a state a close changes.`,
    };
  }

  /*
   * REQUESTED is closeable and that matters: it is the row the open path writes
   * BEFORE it calls the host, so a crash between the insert and the API call
   * leaves one. A close event for that branch is the evidence that whatever the
   * host did with the request is over, and leaving the row at REQUESTED would
   * leave "we were about to" standing for ever.
   */
  const record = await deps.store.settle({ id: existing.id, state: 'CLOSED' });

  await deps.audit.record({
    action: 'pull-request.closed',
    targetType: 'PullRequestRecord',
    targetId: record.id,
    metadata: {
      projectId: record.projectId,
      purpose: record.purpose,
      causeKey: record.causeKey,
      repo: record.repo,
      branch: record.branch,
      number: record.number,
      closedBy: args.closedBy ?? null,
      /*
       * The state it came FROM, because the two are different stories: an OPEN
       * row closing is a reviewer declining a change QAAI proposed, and a
       * REQUESTED row closing is a reconciliation of a request whose outcome
       * QAAI never saw.
       */
      previousState: existing.state,
      /*
       * Said on the row, because its absence is the thing a reader would
       * otherwise assume. Nothing merged, so nothing was re-measured, and a
       * close that quietly left the coverage number alone must not be
       * indistinguishable from one that moved it.
       */
      remeasured: false,
    },
  });

  return {
    outcome: 'CLOSED',
    record,
    note: `Recorded ${record.url ?? record.branch} as closed without being merged. Nothing was merged, so the coverage number was not re-measured.`,
  };
}
