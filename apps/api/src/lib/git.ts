/**
 * Push a materialised repo to a customer's git remote.
 *
 * isomorphic-git rather than shelling out to `git`: no git binary has to exist
 * in the container, HTTPS+token auth works identically across GitHub, GitLab and
 * Bitbucket, and — the reason that matters most — the token is supplied through
 * an `onAuth` callback instead of being interpolated into a remote URL. A
 * `git push https://<token>@host/...` would leak the credential into process
 * listings, shell history and git's own logs; this cannot.
 *
 * The push is always to an explicit branch and never forced, so it can add to a
 * customer's repo but not rewrite its history.
 *
 * ── THE DEFECT THIS FILE USED TO HAVE, AND IT ERASED HUMAN WORK ─────────────
 *
 * The deletion pass below used to `git remove` EVERY tracked file absent from
 * the tree it was handed, on the reasoning that "what QAAI no longer has is a
 * test QAAI deleted". That reasoning INFERS OWNERSHIP FROM ABSENCE, and the
 * inference is wrong in the one case that matters: a human's own test file in
 * the same branch is absent from QAAI's tree because QAAI never had it, and it
 * was deleted. The same inference ran on the write side — every file in the
 * tree was written over whatever was at that path, so an engineer's edit to a
 * generated test was replaced by the database's older copy without a word.
 *
 * "Your tests are yours" is this product's promise, and that made it false.
 *
 * ── THE RULE NOW, AND IT IS STRUCTURAL ─────────────────────────────────────
 *
 * OWNERSHIP IS A RECORDED FACT. It is supplied by {@link PushOptions.ownership}
 * — a narrow, injected reader over the `GeneratedArtifact` ledger — and the
 * ABSENCE of a record answers `UNRECORDED`, which is not writable. There is
 * exactly one authority on whether a verdict permits a write,
 * `WRITABLE_BY_OWNERSHIP` in packages/shared/src/artifact-set.ts, whose only
 * `true` key is `QAAI_OWNED`; {@link mayQaaiReplace} is this file's one door to
 * it and both the write pass and the delete pass go through it.
 *
 * SO WITH NO LEDGER NOTHING IS DELETED AND NOTHING EXISTING IS OVERWRITTEN.
 * That is a real behaviour change and it is the fail-closed direction: a push
 * with no ownership reader CREATES the files that are not there and refuses the
 * rest, rather than guessing. Every refusal and every preserved file is
 * REPORTED as a count with a reason (see {@link PushResult}), because a cap or
 * a refusal that bit without being disclosed reads to a caller as "that is all
 * there was".
 *
 * AND THE REMOTE'S OWN BYTES COME BACK. A refused write carries the content
 * that is at that path on the branch, bounded, so the caller can reconcile the
 * two versions instead of discovering the divergence the next time it tries.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
/*
 * `destinationDecision` — THE ONE RULE about where QAAI may write a generated
 * file, consulted here at the last door before bytes are staged. This file used
 * to ask only "does QAAI own this path"; see `FORBIDDEN_DESTINATION` in
 * {@link PRESERVE_REASONS} for the hole that left.
 */
import { destinationDecision } from '@qaai/shared';
import type { DestinationRefusalReason, GitIntegrationKind } from '@qaai/shared';
/*
 * Reached by a RELATIVE PATH ACROSS THE WORKSPACE BOUNDARY, which is a defect
 * and is recorded as one — the same one `routes/agent.ts` carries for
 * `suite-health.js` and `routes/retention.ts` for its neighbour, and the
 * specifier resolves identically under tsc and tsx.
 *
 * `packages/shared/src/index.ts` has no `export * from './artifact-set'`, so
 * this vocabulary is not reachable through `@qaai/shared` yet, and the obvious
 * one-line fix DOES NOT COMPILE as written: `artifact-set.ts` and
 * `requirements.ts` both export a type named `ContentDigest`, and
 * `requirements` is already in that barrel — a star export is TS2308 on it.
 * The exact working edit is in this round's handover.
 *
 * The alternative was a second three-member ownership vocabulary in this file,
 * and two notions of "may QAAI write here" is how the permissive one comes to
 * win by accident. One authority, reached awkwardly, beats two reached neatly.
 */
import {
  WRITABLE_BY_DISPOSITION,
  WRITABLE_BY_OWNERSHIP,
  dispositionFor,
} from '../../../../packages/shared/src/artifact-set.js';
import type {
  ContentDigest,
  OwnershipVerdict,
} from '../../../../packages/shared/src/artifact-set.js';
import type { RepoTree } from './repo-export.js';

/**
 * The username each provider expects alongside a personal access token. The
 * token is the password in every case; only this literal differs.
 */
const TOKEN_USERNAME: Record<GitIntegrationKind, string> = {
  GITHUB: 'x-access-token',
  GITLAB: 'oauth2',
  BITBUCKET: 'x-token-auth',
};

const HOST: Record<GitIntegrationKind, string> = {
  GITHUB: 'github.com',
  GITLAB: 'gitlab.com',
  BITBUCKET: 'bitbucket.org',
};

/**
 * `owner/repo` → the provider's https clone URL.
 *
 * A full https URL is allowed but its host is pinned to the provider. This is
 * load-bearing security, not tidiness: isomorphic-git sends an unauthenticated
 * `/info/refs` first and retries with `Authorization: Basic <user:PAT>` on a 401,
 * so any host that answers 401 would be handed the plaintext token. Resolving the
 * URL therefore has to fail *before* the token is ever decrypted.
 */
export function repoHttpsUrl(kind: GitIntegrationKind, repo: string): string {
  if (/^https:\/\//.test(repo)) {
    let url: URL;
    try {
      url = new URL(repo);
    } catch {
      throw new Error('Not a valid repository URL');
    }
    if (url.hostname !== HOST[kind]) {
      throw new Error(
        `Refusing to push to ${url.hostname}: a ${kind} integration may only push to ${HOST[kind]}`,
      );
    }
    if (url.username || url.password) {
      throw new Error('Remove the credentials from the repository URL — the token is stored separately');
    }
    return `https://${url.host}${url.pathname.replace(/\.git$/, '')}.git`;
  }
  return `https://${HOST[kind]}/${repo.replace(/\.git$/, '')}.git`;
}

/**
 * The recorded-ownership reader, INJECTED.
 *
 * One method, taking the repo-relative path EXACTLY as the tree and the branch
 * spell it. It normalises nothing, for the reason `resolveOwnership` gives: a
 * lookup that helpfully stripped a `./` or lower-cased a path would make two
 * spellings of one file resolve to two verdicts, and the permissive one would
 * win by accident.
 *
 * An interface rather than a bare function so the implementation can be a class
 * over a Prisma query without its `this` being detached at the call site, which
 * is the mistake `admit` records about its own injected gates.
 */
export interface RepoOwnership {
  /** The whole recorded fact about one path. See {@link OwnershipRecord}. */
  readonly recordFor: (path: string) => OwnershipRecord;
  /**
   * The digest the ledger's `contentHash` values were computed with — sha256
   * hex in production.
   *
   * Supplied BY THE LEDGER READER and not chosen here, because only the reader
   * knows how its own hashes were made. A comparison against a digest computed
   * by a different function never matches, which fails closed but for the wrong
   * reason: every file on the branch would be reported as one a human changed.
   */
  readonly digest: ContentDigest;
}

/**
 * What the ledger RECORDS about one path, as both passes below read it.
 *
 * `UNRECORDED` with a null hash for a path with no row, and that is the answer
 * that keeps a human's file safe — never a default of "ours".
 */
export interface OwnershipRecord {
  readonly verdict: OwnershipVerdict;
  /**
   * Digest of the bytes QAAI LAST WROTE at this path, as the ledger holds it
   * (`GeneratedArtifact.contentHash`, which is NOT NULL).
   *
   * Null is reachable only for an UNRECORDED path, and null is NOT "any bytes
   * will do": a writable verdict with no hash is a comparison that cannot be
   * made, and a check that could not run is never a pass.
   */
  readonly contentHash: string | null;
  /**
   * Repo-relative paths THIS file imports from the project, as the ledger holds
   * them (`GeneratedArtifact.imports`).
   *
   * Read for exactly ONE thing — the coherence rule in {@link PRESERVE_REASONS}
   * — and never for ownership. The edge is stored on the DEPENDENT because the
   * import statement is in the dependent, which is why this is a containment
   * query over the records this push already holds rather than a second lookup.
   */
  readonly imports: readonly string[];
}

/**
 * WHY QAAI LEFT A PATH ON THE BRANCH ALONE.
 *
 * Six reasons, because they are six different facts about the repository. A
 * single boolean here would report the last five as the first, which is the lie
 * "we do not own this" told about a file we do — and the four that are not
 * NOT_OURS are the ones a human has to act on.
 */
export const PRESERVE_REASONS = [
  /** The ledger does not record it as ours: UNRECORDED, HUMAN_EDITED or HUMAN_AUTHORED. */
  'NOT_OURS',
  /**
   * The ledger records it as ours AND THE BYTES ON THE BRANCH ARE NOT THE BYTES
   * QAAI WROTE.
   *
   * This is the reason this file's whole promise turns on, and it is not a
   * hypothetical. `ledgerRowsFor` (apps/worker/src/processors/generate.ts:441)
   * mints `ownership: 'QAAI_OWNED'` from the generated SET ALONE — it has no
   * parameter through which the customer's repository could be consulted, and
   * the generate processor materialises no workspace — so a path a human has
   * owned for months can carry a QAAI_OWNED row that NOTHING EVER LOOKED AT.
   *
   * The verdict alone therefore authorises nothing. The recorded hash is what
   * makes QAAI_OWNED mean "we wrote the bytes that are there", which is what
   * `ARTIFACT_OWNERSHIPS` and `WRITABLE_BY_OWNERSHIP` in
   * packages/shared/src/artifact-set.ts have always SAID it means — and what
   * this file used to assert without checking.
   *
   * It is also the ONLY place an edit a human made IN THE REPOSITORY can be
   * noticed at all: the QAAI_OWNED → HUMAN_EDITED flip in routes/agent.ts needs
   * a human `TestVersion`, and editing a file in git never produces one.
   */
  'BYTES_DIVERGED',
  /**
   * The ledger records it as ours and the comparison COULD NOT BE MADE — the
   * branch's bytes could not be read, or no hash is recorded to compare them
   * against. Unavailable is never a pass.
   */
  'COMPARISON_UNAVAILABLE',
  /**
   * The ledger records it as ours, the bytes match, and A FILE ON THE OTHER END
   * OF AN IMPORT EDGE IS BEING REFUSED IN THIS SAME PUSH — either one that
   * imports it, or one it imports.
   *
   * Writing it anyway is the partial write. Both directions produce the same
   * uncompilable branch: a page object whose method was renamed landing beside a
   * spec that still calls the old name, or a spec written against the new name
   * landing beside the page object that still has the old one. The commit is
   * atomic in git's terms and incoherent in the suite's — a breakage nobody
   * would attribute to a sync.
   *
   * WHAT THIS DOES NOT COVER, said plainly: a file QAAI is not touching at all.
   * This rule is about THIS PUSH'S OWN DECISIONS. A surface change that breaks a
   * file nobody is rewriting is caught earlier, by `SHARED_MEMBER_REMOVED` in
   * packages/agent/src/artifacts.ts and `SHARED_EXPORT_REMOVED` in
   * artifact-set.ts — the two checks that hold the old bytes and the new ones
   * side by side, which this file does not.
   */
  'DEPENDENT_REFUSED',
  /**
   * A deletion, refused because a file that imports it is STAYING on the
   * branch. The mirror of DEPENDENT_REFUSED: removing a page object out from
   * under a spec that still imports it leaves the same uncompilable suite.
   */
  'DEPENDENT_REMAINS',
  /**
   * THE PATH IS SOMEWHERE QAAI MUST NEVER WRITE, whatever the ledger says.
   *
   * ── THE HOLE THIS CLOSES, AND WHY OWNERSHIP COULD NOT CLOSE IT ─────────────
   *
   * Every other reason here answers "may QAAI replace what is at this path".
   * None of them answers "may QAAI put a file at this path AT ALL", and the two
   * are different questions with different answers: a path that is NOT on the
   * branch is a CREATE, and a CREATE was allowed unconditionally by the loop
   * below — "there is nothing there to destroy" — so `node_modules/.bin/payload`
   * and `.github/workflows/release.yml` were writes this function would have
   * made, staged and pushed without asking anything. The ledger cannot refuse
   * them either: QAAI generated those paths, so a row claiming them is exactly
   * what it would hold.
   *
   * It delegates to `destinationDecision` in packages/shared/src/artifact-set.ts
   * — the SAME function `admit`, `artifactSetProblems`, `safeRepoPath` and
   * `directoryForRole` consult — so there is one answer in this product to
   * where a generated file may go, and this is the last door it is asked at
   * rather than a second opinion written at the door.
   *
   * WHAT IT IS NOT: a permission. `destinationDecision` is three-state and
   * UNDECIDED means the layout half was not measured; this push has no measured
   * layout to hand it and never claims one, so the rule can only ever REFUSE
   * here. Writing the file remains something the OWNERSHIP reasons above
   * authorise, and both are asked.
   */
  'FORBIDDEN_DESTINATION',
] as const;
export type PreserveReason = (typeof PRESERVE_REASONS)[number];

/**
 * ONE SENTENCE A HUMAN CAN ACT ON, per reason.
 *
 * Compiler-enforced over {@link PRESERVE_REASONS}, so a seventh reason cannot
 * reach a caller as `undefined` — a refusal with no explanation on it reads to
 * whoever is looking at the branch as nothing having happened, which is the
 * shape of a failure suppressed without being counted.
 */
const WHY_PRESERVED = {
  NOT_OURS: (subject: PreservedSubject): string =>
    subject.record.verdict === 'UNRECORDED'
      ? 'Nothing in the ownership ledger claims this path, so QAAI has no recorded permission ' +
        'to replace what is on the branch. Record it as QAAI_OWNED, or propose the change for ' +
        'review.'
      : `The ledger records this path as ${subject.record.verdict}, so it is a human's file and ` +
        'QAAI may only ever propose a change to it.',
  BYTES_DIVERGED: (): string =>
    'The ledger records this path as ours, but the bytes on the branch are NOT the bytes QAAI ' +
    'wrote there. Three things produce that, and this refusal does not distinguish them: somebody ' +
    'changed the file in the repository; the ledger row was recorded for a path QAAI had never ' +
    'written; or a previous push wrote a newer version and its `ledgerRefresh` was never written ' +
    'back. In all three the file is treated as theirs until the two versions are reconciled, and ' +
    'the branch version is returned with this refusal so they can be.',
  COMPARISON_UNAVAILABLE: (): string =>
    'The ledger records this path as ours and the comparison could not be made: the branch bytes ' +
    'could not be read, or no hash is recorded to compare them against. Unchecked is not ' +
    'permission.',
  DEPENDENT_REFUSED: (subject: PreservedSubject): string =>
    `A file on the other end of an import edge from ${subject.path} is being refused in this same ` +
    'push, so writing this one would leave the branch holding half of one change — a shared file ' +
    'beside an old caller of it, or a new caller beside the old shared file. The whole connected ' +
    'group is withheld rather than part of it.',
  DEPENDENT_REMAINS: (subject: PreservedSubject): string =>
    `QAAI no longer holds ${subject.path} and may not delete it: a file that imports it is ` +
    'staying on the branch, and removing it would leave that file importing nothing.',
  /*
   * THE RULE'S OWN SENTENCE, FORWARDED RATHER THAN REWRITTEN. `destinationDecision`
   * already names the directory and says what it is ("node_modules" is
   * dependencies installed by a package manager), and composing a second
   * sentence here would be this file's own opinion about a question it does not
   * own — the shape of every duplicated vocabulary in this codebase.
   *
   * The null branch is not reachable from the one place that sets this reason,
   * which records the refusal and the sentence together. It says so rather than
   * inventing a reason, because a refusal whose cause is "unknown" is still
   * more honest than a refusal carrying the wrong cause.
   */
  FORBIDDEN_DESTINATION: (subject: PreservedSubject): string =>
    subject.destinationRefusal ??
    'QAAI may not write a file at this path, and the rule that refused it did not reach this ' +
      'report. Treat it as refused and raise it: a destination refusal with no reason on it is a ' +
      'bug in QAAI, not a fact about your repository.',
} as const satisfies Record<PreserveReason, (subject: PreservedSubject) => string>;

/** What {@link WHY_PRESERVED} needs about the path it is explaining, and nothing more. */
interface PreservedSubject {
  readonly path: string;
  readonly record: OwnershipRecord;
  /**
   * `destinationDecision`'s own sentence when it REFUSED this path, and null
   * when it did not refuse it.
   *
   * NULL IS NOT "ALLOWED" AND IS NOT A PASS. The rule is three-state and this
   * push supplies no measured layout, so an ordinary path comes back UNDECIDED —
   * meaning the deny list was checked and the layout question was not asked at
   * all. Null here says only "the destination rule is not what refused this
   * path"; whether the path may be written is answered by the ownership reasons
   * above.
   */
  readonly destinationRefusal: string | null;
}

/**
 * THE ONE DOOR to the write permission, for both passes below.
 *
 * It delegates to `WRITABLE_BY_OWNERSHIP`, whose only `true` key is
 * `QAAI_OWNED`, so there is no second opinion in this file about what ownership
 * permits — and a fourth verdict added to that vocabulary cannot reach this
 * file as a silent `undefined`, because the record is compiler-enforced over
 * every member at its declaration.
 */
export function mayQaaiReplace(verdict: OwnershipVerdict): boolean {
  return WRITABLE_BY_OWNERSHIP[verdict];
}

/**
 * WHICH DESTINATION REFUSALS ABORT THE WHOLE PUSH INSTEAD OF REFUSING ONE FILE.
 *
 * ── WHY THIS RECORD EXISTS AT ALL ──────────────────────────────────────────
 *
 * `destinationDecision` answers one question — may QAAI write here — and this
 * file has TWO ways of saying no, which are not interchangeable:
 *
 *   `false`  the path is refused, counted on {@link PushResult.filesRefused}
 *            with the rule's own sentence, and the rest of the push proceeds.
 *            A test under `node_modules/` is a mistake about ONE file and the
 *            other forty files in the batch are fine.
 *   `true`   the path is not a repo-relative path at all. That is NOT a fact
 *            about one file: `safeJoin` already throws on it and the throw
 *            aborts the push, and this file's own comment says why that is
 *            deliberate — "a push that skipped the offending path and reported
 *            a count would be deciding, on its own, that a repository laid out
 *            through links is one it may half-sync". Routing it into the
 *            per-file list would DOWNGRADE an abort to a count, which is a
 *            failure suppressed without being counted wearing the costume of a
 *            failure counted.
 *
 * So a `true` member is deliberately NOT handled by the loop below; it falls
 * through to `safeJoin`, which is the stronger refusal and the existing owner
 * of that question. This record is what stops that from being a hole somebody
 * has to notice: a fourth `DestinationRefusalReason` cannot be added without
 * choosing which of the two this file does with it.
 */
const DESTINATION_REFUSAL_ABORTS_PUSH = {
  MALFORMED_PATH: true,
  FORBIDDEN_DIRECTORY: false,
  OUTSIDE_LEARNED_LAYOUT: false,
} as const satisfies Record<DestinationRefusalReason, boolean>;

/**
 * BOTH HALVES OF THE PERMISSION FOR ONE PATH THAT IS ON THE BRANCH, and there
 * is no third opinion in this file.
 *
 * It delegates to `dispositionFor` — the SAME function the apply path in
 * packages/agent/src/artifacts.ts uses — so "the ledger says ours and the bytes
 * disagree" resolves to PROPOSED_EDIT in both places or in neither, and then to
 * `WRITABLE_BY_DISPOSITION`. {@link mayQaaiReplace} stays the ownership half's
 * one door so the result can say WHICH of the two refused.
 *
 * `branchBytes` is NULL for "could not be read" and never for "not there":
 * every caller has already established that the path IS tracked. A path that is
 * not on the branch is a CREATE and asks this nothing, because there is nothing
 * there to destroy — which is the entire question.
 */
export function replaceDecision(args: {
  readonly record: OwnershipRecord;
  readonly branchBytes: string | null;
  readonly digest: ContentDigest;
}): { readonly allowed: boolean; readonly reason: PreserveReason | null } {
  if (!mayQaaiReplace(args.record.verdict)) return { allowed: false, reason: 'NOT_OURS' };
  if (args.branchBytes === null || args.record.contentHash === null) {
    return { allowed: false, reason: 'COMPARISON_UNAVAILABLE' };
  }
  const disposition = dispositionFor({
    verdict: args.record.verdict,
    ledgerHash: args.record.contentHash,
    onDiskHash: args.digest(args.branchBytes),
  });
  return WRITABLE_BY_DISPOSITION[disposition]
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'BYTES_DIVERGED' };
}

/**
 * How many refused writes and preserved deletions are NAMED in the result.
 *
 * Two hundred: enough that a normal divergence is listed in full, small enough
 * that a pathological one does not become a megabyte of audit metadata. Past it
 * the COUNT is still exact — `refusedCount` and `keptCount` are totals, not the
 * length of the list — so a cap that bit is a disclosed number rather than a
 * silently short list.
 */
export const MAX_REPORTED_PATHS = 200;

/**
 * How many refused writes carry the REMOTE's bytes back, and how much of each.
 *
 * Pulling the branch's own version back is what makes this a reconciliation
 * rather than a refusal, but it is customer source arriving in an API response,
 * so it is bounded twice and both bounds are disclosed per file
 * ({@link RefusedWrite.remoteTruncated}) and in total
 * ({@link PushResult.contentsOmitted}).
 */
export const MAX_PULLED_BACK_FILES = 50;
export const MAX_PULLED_BACK_CHARS = 100_000;

/** Why a path in QAAI's tree was not written to the branch. */
export interface RefusedWrite {
  readonly path: string;
  /**
   * The verdict that refused it. `UNRECORDED` is by far the commonest and means
   * exactly what it says: nothing in the ledger claims this path, so QAAI has
   * no recorded permission to replace what is there.
   *
   * IT IS NOT THE WHOLE REASON, and reading it as one is the defect this file
   * carried: a refusal can carry `QAAI_OWNED` here and still be a refusal,
   * because the bytes on the branch are not the bytes that verdict is about.
   * {@link RefusedWrite.reason} is the fact; this is one input to it.
   */
  readonly verdict: OwnershipVerdict;
  /** WHICH of the five facts refused it. See {@link PRESERVE_REASONS}. */
  readonly reason: PreserveReason;
  /** One sentence a human can act on. */
  readonly why: string;
  /**
   * The bytes currently on the branch, so the caller can reconcile rather than
   * re-discover the divergence. NULL means they were not read — either the
   * per-call budget was spent or the file could not be read — and never "the
   * file is empty".
   */
  readonly remoteContent: string | null;
  /** Characters of the remote file not included in `remoteContent`. */
  readonly remoteTruncated: number;
}

/** A tracked file absent from QAAI's tree that was NOT deleted, and why. */
export interface PreservedFile {
  readonly path: string;
  readonly verdict: OwnershipVerdict;
  /** WHICH of the five facts preserved it. See {@link PRESERVE_REASONS}. */
  readonly reason: PreserveReason;
}

export interface PushOptions {
  kind: GitIntegrationKind;
  repo: string;
  /** Plaintext PAT. Held only for the duration of this call. */
  token: string;
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
  /**
   * The recorded ownership ledger for this project.
   *
   * OPTIONAL, AND ITS ABSENCE IS NOT FREE. With no reader every path on the
   * branch resolves `UNRECORDED`, so nothing already there is overwritten and
   * nothing at all is deleted — the push adds the files that do not exist and
   * reports every other one as a refusal. `ownershipKnown: false` comes back on
   * the result so a caller cannot read that outcome as a clean sync.
   *
   * THE PRODUCTION CALLER NOW SUPPLIES IT. `POST /projects/:id/git/push` in
   * routes/projects.ts builds it from `GeneratedArtifact` and writes
   * {@link PushResult.ledgerRefresh} back, so the create-only behaviour below is
   * no longer what a customer gets.
   *
   * It stays OPTIONAL rather than becoming required, and that is a decision
   * about what the degraded mode is worth, not an oversight. A caller that
   * cannot say what QAAI owns — a dry run, a future caller reached before a
   * ledger exists — must still have one behaviour, and the safe one is this:
   * create what is absent, refuse everything else, and say `ownershipKnown:
   * false` so the outcome cannot be read as a clean sync. That path is held by
   * tests in git.test.ts on purpose. Requiring the field would delete the only
   * tested answer to "what happens when ownership is unknown" and replace it
   * with a compile error at the call site that is least likely to think about it.
   */
  ownership?: RepoOwnership;
}

export interface PushResult {
  commitSha: string;
  branch: string;
  /** The repo URL, with no credential in it — safe to show and to log. */
  repoUrl: string;
  /**
   * How many files QAAI's tree held. UNCHANGED from the original field, and
   * deliberately NOT renamed: it is what the audit row and the HTTP response
   * have always reported. It is the size of the INTENT, which is why the three
   * counts below exist — `fileCount` never meant "files changed" and now there
   * is somewhere honest to say so.
   */
  fileCount: number;
  /** Files actually written to the working tree, created or replaced. */
  filesWritten: number;
  /** Of those, the ones that did not exist on the branch at all. */
  filesCreated: number;
  /** Paths QAAI holds and did not write, at most {@link MAX_REPORTED_PATHS} named. */
  filesRefused: readonly RefusedWrite[];
  /** The exact total, whether or not every one is named above. */
  refusedCount: number;
  /** Tracked files QAAI deleted — recorded as ours, and gone from our tree. */
  filesDeleted: readonly string[];
  /**
   * Tracked files absent from our tree that were KEPT, at most
   * {@link MAX_REPORTED_PATHS} named. Under the old behaviour every one of
   * these was erased.
   */
  filesKept: readonly PreservedFile[];
  /** The exact total, whether or not every one is named above. */
  keptCount: number;
  /** Refusals whose remote bytes were not read back, because a budget bit. */
  contentsOmitted: number;
  /**
   * THE LEDGER UPDATE THIS PUSH OWES, one entry per path actually written.
   *
   * `GeneratedArtifact.contentHash` is written ONCE, by `ledgerRowsFor`, and
   * updated by nothing — so without this the hash recorded for a path stays the
   * digest of the FIRST version QAAI ever generated for it. The second update
   * QAAI pushed would then be refused as BYTES_DIVERGED against bytes QAAI
   * itself wrote: a correct refusal with a false reason on it.
   *
   * So it is RETURNED rather than remembered: a caller that supplies an
   * `ownership` reader must write these back. NOT capped, deliberately, and it
   * is the one list here that is not — a truncated report is a disclosed count,
   * while a truncated obligation is an obligation silently half-met.
   */
  ledgerRefresh: readonly { readonly path: string; readonly contentHash: string }[];
  /**
   * FALSE when no ownership reader was supplied. A caller that reports a push
   * without reading this is reporting a create-only sync as a full one.
   */
  ownershipKnown: boolean;
  /**
   * False when the branch did not exist yet. Nothing on it could then be
   * refused or preserved, and a reader must not take the empty lists above as
   * evidence that a populated branch was examined and found to agree.
   */
  basedOnRemote: boolean;
}

/**
 * Guard: a tree path must stay inside the workspace, AFTER the filesystem has
 * been consulted and not only after the string has been.
 *
 * The lexical half — `resolve(join(root, p))` under `root` — answers "does this
 * string stay inside the workspace". It cannot answer the question that decides
 * where the bytes land: a directory component that is a SYMLINK puts the write
 * wherever it points, and `checkout` recreates the symlinks the branch holds
 * because git stores one as a file mode (120000) and isomorphic-git honours it.
 * A customer branch tracking `e2e` as a link would otherwise have every spec
 * QAAI writes under it land outside the workspace entirely — and a branch is
 * attacker-influenced in a real deployment.
 *
 * So the deepest EXISTING ancestor is resolved with `realpathSync` and checked
 * too, and so is the target itself when it is already a link. `root` is
 * resolved the same way, because `mkdtemp` under `/var/folders` on macOS is
 * itself reached through a `/private/var` symlink: comparing one resolved path
 * against one unresolved one would refuse every path on that platform.
 *
 * It THROWS rather than returning a verdict, and the throw aborts the whole
 * push. That is the fail-closed direction and it is deliberate — a push that
 * skipped the offending path and reported a count would be deciding, on its
 * own, that a repository laid out through links is one it may half-sync.
 */
function safeJoin(root: string, relPath: string): string {
  const full = resolve(join(root, relPath));
  const refuse = (): never => {
    throw new Error(`Refusing to write outside the repo workspace: ${relPath}`);
  };
  if (!full.startsWith(resolve(root) + sep)) refuse();

  const realRoot = fs.realpathSync(resolve(root));
  const inside = (candidate: string): boolean =>
    candidate === realRoot || candidate.startsWith(realRoot + sep);

  /*
   * The target itself, when something is already there. `lstatSync` and not
   * `statSync`: `stat` follows the link and would report the directory it
   * points at, which is the very thing being tested for.
   */
  try {
    if (fs.lstatSync(full).isSymbolicLink() && !inside(fs.realpathSync(full))) refuse();
  } catch {
    // Nothing at the path yet, which is the ordinary case for a create.
  }

  // Up to the deepest ancestor that exists, then resolve that one.
  let probe = dirname(full);
  for (;;) {
    try {
      if (!inside(fs.realpathSync(probe))) refuse();
      return full;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing to write outside')) throw err;
      const parent = dirname(probe);
      // Reached the filesystem root without finding an existing ancestor, which
      // cannot happen under a workspace that exists — but a loop that could not
      // end is worse than a refusal.
      if (parent === probe) refuse();
      probe = parent;
    }
  }
}

/**
 * Fetch the remote branch (when it exists) so the commit builds on top of it,
 * then write the files QAAI is RECORDED as owning, delete the ones it owns and
 * no longer holds, commit and push. Returns without a network write on failure
 * — callers surface a message that never contains the token.
 *
 * Nothing QAAI does not own is written or deleted, whatever is in `tree`. See
 * the module header for why that is a recorded fact and never an inference, and
 * {@link PushResult} for everything the two passes refused or preserved.
 */
export async function pushRepo(tree: RepoTree, opts: PushOptions): Promise<PushResult> {
  const url = repoHttpsUrl(opts.kind, opts.repo);
  const dir = await mkdtemp(join(tmpdir(), 'qaai-push-'));

  // The token never touches the URL, argv, or disk — only this callback.
  const onAuth = () => ({ username: TOKEN_USERNAME[opts.kind], password: opts.token });

  try {
    await git.init({ fs, dir, defaultBranch: opts.branch });
    await git.addRemote({ fs, dir, remote: 'origin', url });

    // Start from the remote branch when it already exists, so a push adds a
    // commit rather than being rejected as a non-fast-forward.
    let basedOnRemote = false;
    try {
      await git.fetch({
        fs,
        http,
        dir,
        remote: 'origin',
        ref: opts.branch,
        depth: 1,
        singleBranch: true,
        onAuth,
      });
      await git.checkout({ fs, dir, ref: opts.branch, force: true });
      basedOnRemote = true;
    } catch {
      // No such branch yet (or an empty repo) — this becomes the first commit.
    }

    /*
     * Everything the branch already tracks, read ONCE. The two passes below
     * both need it and `listFiles` is a tree walk, so asking twice would be two
     * readings that could disagree about what exists.
     *
     * An empty set when the branch is new, which is what makes every path in
     * the tree a CREATE: there is nothing there to belong to anybody.
     */
    const tracked = basedOnRemote
      ? new Set(await git.listFiles({ fs, dir, ref: 'HEAD' }).catch(() => [] as string[]))
      : new Set<string>();


    /*
     * `UNRECORDED`, a null hash and no imports for every path when no reader was
     * supplied. Written as ONE explicit fallback rather than an `??` at each
     * use, so there is a single place where "no ledger" turns into a recorded
     * fact and it is the fail-closed one.
     */
    const recordFor = (relPath: string): OwnershipRecord =>
      opts.ownership
        ? opts.ownership.recordFor(relPath)
        : { verdict: 'UNRECORDED', contentHash: null, imports: [] };
    /*
     * The digest the LEDGER's hashes were computed with, or a refusal. With no
     * reader there is nothing to compare against, so the function is never
     * reached: `replaceDecision` refuses on the verdict first.
     */
    const digest: ContentDigest = opts.ownership
      ? opts.ownership.digest
      : () => {
          throw new Error('unreachable: no ownership reader, so no hash is ever compared');
        };

    /*
     * EVERY RECORD THIS PUSH WILL NEED, read once, for the union of QAAI's tree
     * and the branch. Both coherence rules below are containment queries over
     * `imports`, and a record fetched twice is two readings that could disagree
     * about one path.
     */
    const records = new Map<string, OwnershipRecord>();
    for (const relPath of [...tree.keys(), ...tracked]) {
      if (!records.has(relPath)) records.set(relPath, recordFor(relPath));
    }
    /*
     * The REVERSE index, built once.
     *
     * The edge is recorded on the dependent (`imports`), so "who imports this"
     * is a containment query — and asking it by scanning every record, inside a
     * loop over every decision, inside a loop that runs to a fixpoint, is cubic
     * in the size of the branch. A push over a repository with a few thousand
     * tracked files would have spent minutes deciding and reported nothing about
     * why. One pass to invert it, then O(1) lookups.
     */
    const importersByTarget = new Map<string, string[]>();
    for (const [path, record] of records) {
      for (const imported of record.imports) {
        if (imported === path) continue;
        const list = importersByTarget.get(imported);
        if (list) list.push(path);
        else importersByTarget.set(imported, [path]);
      }
    }
    /** Every path that imports `target`, among the paths this push can see. */
    const importersOf = (target: string): readonly string[] =>
      importersByTarget.get(target) ?? [];

    // ── Pass 1: decide for every path, THEN write ──
    /*
     * TWO STEPS AND NOT ONE, which is a change from deciding and writing in the
     * same loop. The coherence rule is about the SET of decisions — a page
     * object may not be written when a spec that imports it is refused — and a
     * loop that writes as it decides cannot see a refusal that has not happened
     * yet. By then the file is already staged.
     *
     * A path that is not on the branch is a CREATE and needs no permission:
     * there is nothing there to destroy, which is the entire question the gate
     * answers. A path that IS on the branch needs a recorded QAAI_OWNED AND the
     * recorded bytes, and the absence of either refuses it.
     */
    interface WriteDecision {
      readonly path: string;
      readonly content: string;
      readonly onBranch: boolean;
      /** The branch's own bytes, or null when they could not be read. */
      readonly branchBytes: string | null;
      readonly record: OwnershipRecord;
      /** See {@link PreservedSubject.destinationRefusal}. Null is not a pass. */
      readonly destinationRefusal: string | null;
      allowed: boolean;
      reason: PreserveReason | null;
    }

    const decisions: WriteDecision[] = [];
    for (const [relPath, content] of tree) {
      const record = records.get(relPath) ?? recordFor(relPath);
      const onBranch = tracked.has(relPath);
      /*
       * ── WHERE, BEFORE WHETHER ──────────────────────────────────────────────
       *
       * Asked FIRST and asked of every path, because it is the only question in
       * this loop that a CREATE cannot skip. The branch below used to allow
       * every untracked path unconditionally — "there is nothing there to
       * destroy" — which is true and is not the whole question: a first write
       * to `node_modules/.bin/payload.spec.ts` destroys nothing and is still a
       * write QAAI must never make.
       *
       * NO LAYOUT IS PASSED, and that is not an omission. This function holds a
       * git checkout and a ledger; it has not measured the repository's test
       * conventions and must not guess at them. So the deny list is the whole
       * question asked here, `destinationDecision` answers UNDECIDED for every
       * ordinary path, and UNDECIDED is NOT treated as permission — it falls
       * through to the ownership rule, which is where this function's
       * permission has always come from. The layout half is enforced upstream,
       * at `admit`/`artifactSetProblems`, where the measurement exists.
       *
       * A MALFORMED PATH IS NOT HANDLED HERE, BY DECISION AND NOT BY OMISSION:
       * see {@link DESTINATION_REFUSAL_ABORTS_PUSH}. It reaches `safeJoin`,
       * which throws and aborts the whole push — the stronger of this file's
       * two refusals, and the one its own comment argues for.
       */
      const destination = destinationDecision({ path: relPath });
      const destinationRefusal =
        destination.verdict === 'REFUSED' &&
        !DESTINATION_REFUSAL_ABORTS_PUSH[destination.reason]
          ? destination.why
          : null;
      if (destinationRefusal !== null) {
        decisions.push({
          path: relPath,
          content,
          onBranch,
          /*
           * Not read, and not readable in the general case: a refused
           * destination may be a path the checkout has nothing at. The refusal
           * carries the RULE's sentence rather than the branch's bytes, and
           * `contentsOmitted` counts it below like any other refusal whose
           * bytes did not come back.
           */
          branchBytes: null,
          record,
          destinationRefusal,
          allowed: false,
          reason: 'FORBIDDEN_DESTINATION',
        });
        continue;
      }
      if (!onBranch) {
        decisions.push({
          path: relPath,
          content,
          onBranch,
          branchBytes: null,
          record,
          destinationRefusal,
          allowed: true,
          reason: null,
        });
        continue;
      }
      /*
       * Read from the WORKING TREE, which `checkout` has already populated from
       * the branch — not from `tree`, which is the version being judged.
       *
       * Read for EVERY tracked path and not only for the ones about to be
       * refused, because the bytes are now an INPUT to the decision rather than
       * only evidence in the report. {@link MAX_PULLED_BACK_FILES} still bounds
       * what reaches the caller, which is what that budget was always about.
       */
      const branchBytes = await readFile(safeJoin(dir, relPath), 'utf8').catch(() => null);
      /*
       * Unlike pass 2 this reads every tracked path it sees, and that is bounded
       * by QAAI'S OWN FILE COUNT rather than by the branch's: `tree` holds what
       * QAAI generated, which is hundreds of files, while `tracked` holds the
       * customer's entire repository. The bytes are needed twice over — once for
       * the decision and once for the reconciliation the refusal carries — so
       * reading them here rather than twice is the cheaper of the two.
       */
      const outcome = replaceDecision({ record, branchBytes, digest });
      decisions.push({
        path: relPath,
        content,
        onBranch,
        branchBytes,
        record,
        destinationRefusal,
        allowed: outcome.allowed,
        reason: outcome.reason,
      });
    }

    /*
     * ── COHERENCE, IN BOTH DIRECTIONS, TO A FIXPOINT ───────────────────────
     *
     * An import edge breaks a suite in BOTH directions and the rule has to say
     * so, which the first version of it did not:
     *
     *   · A SHARED file whose importer is refused may not land. The importer
     *     keeps calling the old member, so a page object with a renamed method
     *     arrives beside a spec that calls the name it no longer has.
     *   · A DEPENDENT whose shared file is refused may not land either. It was
     *     written against the new member, so it arrives calling a name the page
     *     object on the branch does not have yet. Withdrawing only the shared
     *     file leaves exactly this, with three specs calling `addItem()` on a
     *     `CartPage` that still offers `addToCart()`.
     *
     * So an allowed decision adjacent to a refused one — either way along the
     * edge — is withdrawn, and the pass repeats because withdrawing one creates
     * new adjacencies: a base page object is two edges from the spec, and one
     * round would ship the base and withhold the middle.
     *
     * ONLY PATHS THAT HAVE A DECISION ARE NODES. Two specs that merely share a
     * page object QAAI is NOT touching are not adjacent, so one spec's refusal
     * does not withhold an unrelated spec's unrelated update. Bounded by the
     * number of decisions: each round withdraws at least one, or ends.
     */
    const withdraw = (decision: WriteDecision, reason: PreserveReason): void => {
      decision.allowed = false;
      decision.reason = reason;
    };
    for (let round = 0; round < decisions.length; round += 1) {
      const refusedPaths = new Set(decisions.filter((d) => !d.allowed).map((d) => d.path));
      let changed = false;
      for (const decision of decisions) {
        if (!decision.allowed) continue;
        const breaks =
          // Something that imports this file is refused.
          importersOf(decision.path).some((importer) => refusedPaths.has(importer)) ||
          // Something this file imports is refused.
          decision.record.imports.some((imported) => refusedPaths.has(imported));
        if (breaks) {
          withdraw(decision, 'DEPENDENT_REFUSED');
          changed = true;
        }
      }
      if (!changed) break;
    }

    // ── Pass 1b: write the allowed decisions, report the rest ──
    const refused: RefusedWrite[] = [];
    const ledgerRefresh: { path: string; contentHash: string }[] = [];
    let filesWritten = 0;
    let filesCreated = 0;
    let contentsOmitted = 0;
    let pulledBack = 0;

    for (const decision of decisions) {
      if (!decision.allowed) {
        /*
         * The branch's own bytes come back with the refusal, bounded, so the
         * caller can reconcile the two versions instead of re-discovering the
         * divergence on the next push.
         */
        let remoteContent: string | null = null;
        let remoteTruncated = 0;
        if (decision.branchBytes === null) {
          contentsOmitted += 1;
        } else if (pulledBack < MAX_PULLED_BACK_FILES) {
          pulledBack += 1;
          remoteContent = decision.branchBytes.slice(0, MAX_PULLED_BACK_CHARS);
          remoteTruncated = decision.branchBytes.length - remoteContent.length;
        } else {
          contentsOmitted += 1;
        }

        const reason = decision.reason ?? 'NOT_OURS';
        refused.push({
          path: decision.path,
          verdict: decision.record.verdict,
          reason,
          why: WHY_PRESERVED[reason](decision),
          remoteContent,
          remoteTruncated,
        });
        continue;
      }

      const target = safeJoin(dir, decision.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, decision.content, 'utf8');
      await git.add({ fs, dir, filepath: decision.path });
      filesWritten += 1;
      if (!decision.onBranch) filesCreated += 1;
      /*
       * The obligation, per written path. Computed from the bytes WRITTEN and
       * not from the ledger's own value, which is exactly what has gone stale.
       * Skipped with no reader, because there is no ledger to refresh.
       */
      if (opts.ownership) {
        ledgerRefresh.push({ path: decision.path, contentHash: digest(decision.content) });
      }
    }

    // ── Pass 2: delete only what QAAI is recorded as owning, and only what nothing needs ──
    /*
     * Why this pass exists at all: without it the branch accumulates
     * remote ∪ tree, so a test deleted in QAAI lingers and keeps running in the
     * customer's CI. Why it is gated: it used to delete every tracked file
     * absent from the tree, which erases a human's own test in the same branch.
     *
     * The gate is {@link replaceDecision} and nothing else — one door, shared
     * with pass 1, so a file QAAI does not own or whose bytes it did not write
     * cannot be reached by this loop. There is no second condition and no `||`
     * for a future edit to widen by accident.
     */
    const deleted: string[] = [];
    const kept: PreservedFile[] = [];
    /*
     * Counted in the loop rather than derived from set arithmetic afterwards.
     * `kept` is capped at {@link MAX_REPORTED_PATHS} and this is not, so a
     * branch with a thousand human files reports the exact number it preserved
     * and names two hundred of them — a cap that bit, disclosed as a count. The
     * same split is applied to `refused` below.
     */
    let keptCount = 0;
    const keep = (relPath: string, record: OwnershipRecord, reason: PreserveReason): void => {
      keptCount += 1;
      if (kept.length < MAX_REPORTED_PATHS) {
        kept.push({ path: relPath, verdict: record.verdict, reason });
      }
    };

    /** Deletion candidates, decided before any of them is applied. */
    const candidates: { path: string; record: OwnershipRecord }[] = [];
    for (const relPath of tracked) {
      if (tree.has(relPath)) continue;
      const record = records.get(relPath) ?? recordFor(relPath);
      /*
       * THE BYTES ARE READ ONLY WHEN THE VERDICT ALREADY PERMITS A DELETE, and
       * what decides that is `replaceDecision` itself rather than a second copy
       * of the ownership rule in this loop.
       *
       * `tracked` is EVERY file the branch holds — the customer's whole source
       * tree and not only their tests — so reading each one to decide a deletion
       * nobody is proposing would turn every push into a full read of the
       * checkout. A NOT_OURS verdict needs no bytes to refuse, and it is the
       * answer for almost every path on a real branch.
       */
      const probe = replaceDecision({ record, branchBytes: null, digest });
      if (probe.reason === 'NOT_OURS') {
        keep(relPath, record, 'NOT_OURS');
        continue;
      }
      const branchBytes = await readFile(safeJoin(dir, relPath), 'utf8').catch(() => null);
      const outcome = replaceDecision({ record, branchBytes, digest });
      if (!outcome.allowed) {
        keep(relPath, record, outcome.reason ?? 'NOT_OURS');
        continue;
      }
      candidates.push({ path: relPath, record });
    }

    /*
     * ── THE MIRROR OF THE COHERENCE RULE, ALSO TO A FIXPOINT ───────────────
     *
     * Removing a page object out from under a spec that still imports it leaves
     * the same uncompilable suite as writing a renamed one beside it. A path is
     * deletable only when NOTHING THAT REMAINS imports it, and what remains
     * grows every time a candidate is withdrawn — so the pass is repeated until
     * it stops changing.
     */
    const doomed = new Set(candidates.map((candidate) => candidate.path));
    for (let round = 0; round < candidates.length; round += 1) {
      let changed = false;
      for (const candidate of candidates) {
        if (!doomed.has(candidate.path)) continue;
        const remainingImporter = importersOf(candidate.path).find((path) => !doomed.has(path));
        if (remainingImporter !== undefined) {
          doomed.delete(candidate.path);
          keep(candidate.path, candidate.record, 'DEPENDENT_REMAINS');
          changed = true;
        }
      }
      if (!changed) break;
    }

    for (const candidate of candidates) {
      if (!doomed.has(candidate.path)) continue;
      await git.remove({ fs, dir, filepath: candidate.path });
      await rm(safeJoin(dir, candidate.path), { force: true }).catch(() => {});
      deleted.push(candidate.path);
    }
    const commitSha = await git.commit({
      fs,
      dir,
      message: opts.message,
      author: { name: opts.authorName, email: opts.authorEmail },
    });

    await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: opts.branch,
      remoteRef: opts.branch,
      // Never force: QAAI may add to a customer's repo, never rewrite it.
      force: false,
      onAuth,
    });

    return {
      commitSha,
      branch: opts.branch,
      repoUrl: url,
      fileCount: tree.size,
      filesWritten,
      filesCreated,
      filesRefused: refused.slice(0, MAX_REPORTED_PATHS),
      refusedCount: refused.length,
      filesDeleted: deleted,
      filesKept: kept,
      keptCount,
      contentsOmitted,
      ledgerRefresh,
      ownershipKnown: opts.ownership !== undefined,
      basedOnRemote,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
