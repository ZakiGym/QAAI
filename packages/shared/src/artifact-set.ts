/**
 * THE GENERATED ARTIFACT SET — what QAAI produces, who owns it, what reviewers
 * change about it, and what QAAI may only ever PROPOSE.
 *
 * ── The three defects this file exists to close ─────────────────────────────
 *
 * ONE. `generatedTestSchema` carried ONE `code` and ONE `filePath`, so a page
 * object, a shared fixture or a dataset file was impossible BY CONSTRUCTION —
 * while five separate prompts in packages/agent/src/ecosystem-prompts.ts tell
 * the model to use page objects. The only shape the schema could express was
 * setup copy-pasted into every spec, which is simultaneously the thing
 * reviewers delete tests for and the thing that makes a suite unmaintainable.
 *
 * TWO. `pushRepo` (apps/api/src/lib/git.ts:143) `git rm`s every tracked file
 * absent from the tree it is handed, so it ERASES a human's edits in the same
 * branch. It does that because it INFERS ownership from absence. Ownership is
 * not inferable: not from a path, not from a file's contents, not from the fact
 * that QAAI once wrote something there. So ownership here is a RECORDED FACT
 * (`GeneratedArtifact` rows) and the absence of a record means NOT OURS — see
 * {@link resolveOwnership} and {@link WRITABLE_BY_OWNERSHIP}, which is the one
 * fact `pushRepo` lacked.
 *
 * THREE. The suite only ever grew. `suite-health.ts` names duplicate clusters
 * and weak assertions and nothing could act on them, because there was no shape
 * for "I would like to change tests that already exist, here is what it would
 * look like, and here is how to put it back". {@link SuiteChangeProposal} is
 * that shape, and its revert record is NOT optional.
 *
 * ── Why the ledger is a row and not a manifest in the customer's repo ───────
 *
 * A manifest (`.qaai/artifacts.json`) is tempting: ownership travels with the
 * code, survives a reinstall, and is reviewable in the PR that creates it. It
 * is also A FILE IN A REPOSITORY AN ATTACKER MAY BE ABLE TO WRITE, and the
 * question it answers is "may QAAI overwrite this file". A manifest as the
 * AUTHORITY means one pull request that adds
 * `{"path":"tests/fixtures/users.ts","ownership":"QAAI_OWNED"}` hands an
 * attacker a write primitive over a human's fixture file on the next generation
 * run. So the database row is the authority and a manifest may only ever be a
 * convenience MIRROR of it — never read back as a fact. Rule 11 of this round,
 * stated as a data-model decision rather than a comment.
 *
 * ── Why the dependency edge is stored on the DEPENDENT ──────────────────────
 *
 * A shared artifact (a page object two specs import) has more than one
 * dependent, so replacing it is a change to every dependent. The edge is
 * recorded as {@link GeneratedArtifact.imports} — what THIS file imports —
 * rather than as a `dependents` list on the shared file, because the import
 * statement is IN the dependent. A `dependents` list is a derived fact that
 * goes stale the moment a spec is rewritten without touching the page object;
 * `imports` is rewritten by the same act that changes it. "Who depends on X" is
 * then a containment query, {@link dependentsOf}.
 *
 * ── Everything here is deterministic ───────────────────────────────────────
 *
 * No model call, no filesystem, no network, no `node:` builtin. Content hashing
 * is an INJECTED {@link ContentDigest}, for the reason `attestation.ts` records:
 * importing `node:crypto` into this package 500s every web page that reads a
 * value from it. The refusal list in {@link artifactSetProblems} is the whole
 * safety argument and it runs in microseconds with no API key, which is the
 * only way a table this consequential stays correct.
 */

import type { DialectId } from './dialect';

// ─── Caps, each one disclosed where it bites ────────────────────────────────

/**
 * Artifacts in one set. A generated test that needs more than this is not a
 * test, and an attacker-supplied set of ten thousand paths is a write loop.
 *
 * Twelve is four times the largest shape any of the five page-object prompts
 * asks for (a spec, a page object, a fixture) and still small enough that a
 * human reviews the whole set in one sitting — which is the point of the set
 * existing at all.
 */
export const MAX_ARTIFACTS_PER_SET = 12;

/** One artifact's content. Past this it is a build output, not a test. */
export const MAX_ARTIFACT_CHARS = 200_000;

/** A repo-relative path. Matches `relativeFilePath` in schemas.ts. */
export const MAX_ARTIFACT_PATH_CHARS = 300;

/**
 * Imports recorded per artifact. A test file with more than this many project
 * imports is not a test file, and the number bounds {@link dependentsOf}'s
 * work per row.
 */
export const MAX_ARTIFACT_IMPORTS = 40;

// ─── Role ───────────────────────────────────────────────────────────────────

/**
 * What one file in a generated set IS.
 *
 * Closed, and the spelling travels in a Prisma enum (`ArtifactRole`) and in
 * stored rows, so renaming a member orphans every row that used it.
 *
 * Ordered by apply order rather than alphabetically, because that is the order
 * that matters: a SPEC that imports a PAGE_OBJECT cannot be written first, and
 * {@link artifactSetProblems} checks the ordering against this list.
 */
export const ARTIFACT_ROLES = [
  /** A shared dataset or table of cases. Imported, never run. */
  'DATASET',
  /** A general-purpose helper: a URL builder, a money formatter, a wait-for. */
  'HELPER',
  /** Setup and teardown as the repository expresses it — a Playwright fixture, a conftest.py, an RSpec `let`. */
  'FIXTURE',
  /** The page/screen object: locators and the actions on them, with no assertions. */
  'PAGE_OBJECT',
  /** The test itself. The only role a runner collects and the only one with assertions. */
  'SPEC',
  /** A stored expectation a spec compares against — a snapshot, an approved payload. */
  'SNAPSHOT',
  /** A fragment a human merges into their own runner config. NEVER written over their config. */
  'CONFIG_FRAGMENT',
] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/**
 * Apply rank, lowest first. A dependency must be on disk before the file that
 * imports it, or the first run of a half-applied set fails on an import error
 * and reads as a broken test rather than a half-applied write.
 *
 * Compiler-enforced, so a seventh role cannot be added without deciding where
 * it goes. The run-time parity against `artifactRoleSchema.options` is in
 * artifact-set.test.ts — one without the other passes while the two disagree.
 */
export const ARTIFACT_ROLE_RANK = {
  DATASET: 0,
  HELPER: 1,
  FIXTURE: 2,
  PAGE_OBJECT: 3,
  SNAPSHOT: 4,
  SPEC: 5,
  CONFIG_FRAGMENT: 6,
} as const satisfies Record<ArtifactRole, number>;

/**
 * Roles more than one spec is expected to import. A change to one of these is a
 * change to every dependent, which is what {@link sharedSurfaceChange} exists
 * to make visible before it is applied.
 *
 * A SPEC is not shared: nothing imports a spec. A SNAPSHOT is not shared
 * either — it belongs to exactly the spec that compares against it, and a
 * snapshot two specs share is a defect in its own right.
 */
export const SHARED_ROLES = {
  DATASET: true,
  HELPER: true,
  FIXTURE: true,
  PAGE_OBJECT: true,
  SNAPSHOT: false,
  SPEC: false,
  CONFIG_FRAGMENT: false,
} as const satisfies Record<ArtifactRole, boolean>;

// ─── Ownership: the recorded fact, and the verdict for a path ───────────────

/**
 * What a ledger ROW can say about a file. Three members, and the third is the
 * one that stops QAAI overwriting human work.
 *
 * This is the Prisma enum (`ArtifactOwnership`). It deliberately has no
 * "nobody recorded anything" member: a row cannot say that there is no row.
 * That state is {@link OWNERSHIP_VERDICTS}' `UNRECORDED`, which exists only in
 * memory, and conflating the two is how a missing record would come to read as
 * a recorded permission.
 */
export const ARTIFACT_OWNERSHIPS = [
  /** QAAI wrote it and the bytes on disk are still the bytes QAAI wrote. */
  'QAAI_OWNED',
  /**
   * QAAI wrote it once and a human has changed it since. QAAI may PROPOSE and
   * may never write. The row is kept rather than deleted precisely so the
   * history — "we generated this, they adopted it" — survives, and so the next
   * generation run cannot mistake it for a file it still owns.
   */
  'HUMAN_EDITED',
  /**
   * A human's file, recorded as such on purpose. The row exists so that "QAAI
   * does not own this" is a FACT rather than the absence of a fact, which is
   * what makes a collision at this path reportable instead of silent.
   */
  'HUMAN_AUTHORED',
] as const;
export type ArtifactOwnership = (typeof ARTIFACT_OWNERSHIPS)[number];

/**
 * What the resolver answers for a path: the three recordable states plus the
 * absence of a record.
 *
 * `UNRECORDED` is the DEFAULT ANSWER and it is not writable. Every path QAAI
 * has never written is UNRECORDED, which means a generator that invents a path
 * inside the customer's `tests/` directory gets a PROPOSED_EDIT and not a
 * write — the fail-closed direction, and the opposite of what `pushRepo` does.
 */
export const OWNERSHIP_VERDICTS = [...ARTIFACT_OWNERSHIPS, 'UNRECORDED'] as const;
export type OwnershipVerdict = (typeof OWNERSHIP_VERDICTS)[number];

/**
 * MAY QAAI WRITE THIS FILE WITHOUT ASKING. The single fact `pushRepo` lacked.
 *
 * Compiler-enforced over every verdict, so a fifth state cannot be added
 * without a decision, and `true` appears exactly once. Read it as the whole
 * security argument of this file: one key is true, and it is true only when the
 * bytes on disk are the bytes QAAI last wrote.
 */
export const WRITABLE_BY_OWNERSHIP = {
  QAAI_OWNED: true,
  HUMAN_EDITED: false,
  HUMAN_AUTHORED: false,
  UNRECORDED: false,
} as const satisfies Record<OwnershipVerdict, boolean>;

// ─── Disposition: what this artifact asks to happen ─────────────────────────

/**
 * What the producer is ASKING FOR, as distinct from what it is ALLOWED.
 *
 * In-memory and in the artifact-set JSON only — deliberately NOT a Prisma enum.
 * A disposition is a request made at one moment against a ledger that may have
 * moved; storing it as a column would create a second, older opinion about
 * whether a write is permitted, and the first thing a second opinion does is
 * diverge. The stored fact is {@link ArtifactOwnership}; the disposition is
 * re-derived from it by {@link dispositionFor} on every apply.
 *
 * Parity for this one lives in artifact-set.test.ts against
 * `artifactDispositionSchema.options`, exactly as `BROWSER_ENGINES` and
 * `UNIQUENESS_SCOPES` do for the same reason: there is no database type for it
 * to drift from.
 */
export const ARTIFACT_DISPOSITIONS = [
  /** No file at this path. QAAI creates it and the ledger records ownership. */
  'NEW',
  /** A file QAAI owns, whose on-disk bytes still match the ledger. Overwritten in place. */
  'UPDATE_OWNED',
  /**
   * A file QAAI does NOT own. CAN NEVER BE WRITTEN — only proposed, as a
   * {@link SuiteChangeProposal} a human approves. This is the member that stops
   * QAAI overwriting a human's fixture file.
   */
  'PROPOSED_EDIT',
] as const;
export type ArtifactDisposition = (typeof ARTIFACT_DISPOSITIONS)[number];

/**
 * May an artifact with this disposition be written to disk by QAAI itself?
 *
 * Compiler-enforced, and the second half of the pair with
 * {@link WRITABLE_BY_OWNERSHIP}: a write needs BOTH a writable disposition and
 * a writable ownership verdict, which is what {@link mayWriteDirectly} checks.
 * One of the two alone is how a stale disposition becomes a permission.
 */
export const WRITABLE_BY_DISPOSITION = {
  NEW: true,
  UPDATE_OWNED: true,
  PROPOSED_EDIT: false,
} as const satisfies Record<ArtifactDisposition, boolean>;

// ─── The artifact and the set ───────────────────────────────────────────────

/*
 * A digest of a string. INJECTED rather than imported for the reason
 * `attestation.ts` records: `node:crypto` in this package 500s every web page
 * that reads a value from `@qaai/shared`.
 *
 * RE-EXPORTED FROM `./requirements`, WHICH DECLARED IT FIRST, rather than
 * declared a second time here. This module originally spelled its own
 * `(input: string) => string` beside that module's `(canonical: string) =>
 * string` — the same type, the same purpose, two names for one question, which
 * is the `ASSERTION_KEY`-versus-`specAssertions` defect this round was warned
 * about arriving in the barrel. Publishing both from `index.ts` surfaced it as
 * TS2308; two unexported copies would have agreed for ever and drifted silently.
 */
export type { ContentDigest } from './requirements';

/** One file in a generated set. */
export interface GeneratedArtifact {
  readonly role: ArtifactRole;
  /** Repo-relative, no `..`, no leading separator. The runner collects by it. */
  readonly path: string;
  readonly content: string;
  readonly disposition: ArtifactDisposition;
  /**
   * The ownership verdict this disposition was derived from, carried alongside
   * it so the write path can refuse an incoherent pair without a second ledger
   * lookup. See {@link artifactSetProblems}' `WRITE_TO_UNOWNED`.
   */
  readonly ownership: OwnershipVerdict;
  /**
   * Repo-relative paths this file imports FROM THE PROJECT — never a package
   * from the registry. The dependency edge, recorded on the dependent side for
   * the reason in this file's header.
   */
  readonly imports: readonly string[];
  /**
   * Digest of the bytes this change was computed against, for UPDATE_OWNED and
   * PROPOSED_EDIT. Null for NEW, and null for nothing else.
   *
   * THE OPTIMISTIC-CONCURRENCY TOKEN, and the thing that makes "never destroy
   * human work" structural rather than hopeful: an UPDATE_OWNED whose
   * `basedOnHash` no longer matches the ledger is a change computed against
   * bytes somebody has since replaced, and applying it would silently discard
   * whatever replaced them.
   */
  readonly basedOnHash: string | null;
  /** Why this file exists, one sentence, shown in review beside the diff. */
  readonly why: string;
}

/**
 * An ordered, multi-file generated output.
 *
 * ORDER IS APPLY ORDER, ascending {@link ARTIFACT_ROLE_RANK}: a dependency is
 * on disk before the file that imports it. A half-applied set in the other
 * order fails its first run on an import error, which reads to a human as a
 * broken generated test rather than as an interrupted write.
 */
export interface ArtifactSet {
  readonly artifacts: readonly GeneratedArtifact[];
  /**
   * The dialect every artifact in the set is written in, when it is known.
   *
   * Null means "we could not tell", never "TypeScript" — the rule
   * `resolveDialect` already lives by, and the reason `CONVERT_SYSTEM`
   * hard-coding Playwright TypeScript is a defect: a Java shop that imports its
   * suite gets a rewrite into a language it does not use and deletes it.
   */
  readonly dialect: DialectId | null;
}

// ─── The ledger ─────────────────────────────────────────────────────────────

/**
 * One recorded fact about one path, as the write path needs to read it. The
 * database shape (`GeneratedArtifact` in schema.prisma) carries more; this is
 * the narrow projection every decision in this file is made from, so a
 * `select` can be narrow and a fake can honour it.
 */
export interface ArtifactLedgerEntry {
  readonly path: string;
  readonly role: ArtifactRole;
  readonly ownership: ArtifactOwnership;
  /** Digest of the bytes QAAI last wrote at this path. */
  readonly contentHash: string;
  /** What that file imports, so {@link dependentsOf} can answer. */
  readonly imports: readonly string[];
}

/**
 * The ownership verdict for a path, with absence of a record answering
 * UNRECORDED.
 *
 * Normalises nothing about the path: a ledger lookup that "helpfully" stripped
 * a `./` prefix or lower-cased a path would make two spellings of one file
 * resolve to two different verdicts, and the permissive one wins by accident.
 * Callers hand it exactly the path the artifact carries, which
 * {@link artifactSetProblems} has already refused if it is not repo-relative.
 */
export function resolveOwnership(
  ledger: readonly ArtifactLedgerEntry[],
  path: string,
): OwnershipVerdict {
  const row = ledger.find((entry) => entry.path === path);
  return row ? row.ownership : 'UNRECORDED';
}

/**
 * The disposition a path EARNS, given what the ledger says and what is on
 * disk.
 *
 * `onDiskHash` is null when nothing is there. The combination "the ledger says
 * we own it and nothing is on disk" resolves to NEW rather than UPDATE_OWNED:
 * somebody deleted the file, and re-creating it is the honest reading, while
 * UPDATE_OWNED would carry a `basedOnHash` for bytes that do not exist.
 *
 * The combination "we own it and the bytes differ from what we wrote" resolves
 * to PROPOSED_EDIT and NOT to UPDATE_OWNED. That is the whole point: a human
 * changed our file, so it is theirs now.
 */
export function dispositionFor(args: {
  readonly verdict: OwnershipVerdict;
  readonly ledgerHash: string | null;
  readonly onDiskHash: string | null;
}): ArtifactDisposition {
  if (!WRITABLE_BY_OWNERSHIP[args.verdict]) return 'PROPOSED_EDIT';
  if (args.onDiskHash === null) return 'NEW';
  if (args.ledgerHash === null) return 'PROPOSED_EDIT';
  return args.onDiskHash === args.ledgerHash ? 'UPDATE_OWNED' : 'PROPOSED_EDIT';
}

/** Both halves of the permission, never one. See {@link WRITABLE_BY_DISPOSITION}. */
export function mayWriteDirectly(artifact: GeneratedArtifact): boolean {
  return (
    WRITABLE_BY_DISPOSITION[artifact.disposition] && WRITABLE_BY_OWNERSHIP[artifact.ownership]
  );
}

/**
 * Everything in the ledger that imports `path` — the dependents a replacement
 * would change.
 *
 * Exact string match for the reason {@link resolveOwnership} gives. A caller
 * that records `./pages/login` in one file and `pages/login` in another gets
 * two answers, which is correct: those are two different import specifiers and
 * only one of them will still resolve after a move.
 */
export function dependentsOf(
  ledger: readonly ArtifactLedgerEntry[],
  path: string,
): readonly ArtifactLedgerEntry[] {
  return ledger.filter((entry) => entry.path !== path && entry.imports.includes(path));
}

// ─── The shared surface, and why UNREADABLE is not SAFE ─────────────────────

/**
 * What a replacement does to the names its dependents import.
 *
 * `UNREADABLE` is not "no removals". It means no export form was recognised in
 * the OLD content, so nothing can be said about what a dependent would lose —
 * and a set that would replace a shared artifact whose surface we cannot read
 * must not be applied blindly. Absence of evidence is not evidence, which is
 * the rule `resolveDialect` already lives by.
 */
export type SharedSurfaceChange =
  | { readonly state: 'UNREADABLE' }
  | { readonly state: 'READ'; readonly removed: readonly string[]; readonly added: readonly string[] };

/**
 * Export forms, deliberately scanner-level and multi-language.
 *
 * NOT a parser, for the reason suite-health.ts gives: the content here is
 * whatever a model or a human last wrote, including files that do not parse,
 * and a parser that throws takes the whole decision down with it. Over-reading
 * a name costs a false "a dependent might break", which is the direction that
 * asks a human to look. Under-reading costs a silent break, which is the
 * direction that does not.
 */
const EXPORT_FORMS: readonly RegExp[] = [
  // JS/TS: export class Foo, export const foo, export function foo, export type Foo
  /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|const|let|var|function|type|interface|enum)\s+(\w+)/g,
  // JS/TS: export { a, b as c }
  /\bexport\s*\{([^}]*)\}/g,
  // Python / Ruby / PHP / Go / Java / Kotlin / C#: a top-level definition is the surface
  /^(?:\s*)(?:public\s+|internal\s+|open\s+)?(?:def|class|module|func|fun)\s+(\w+)/gm,
];

/** Names a dependent could import from this content, as far as a scanner can tell. */
function exportedNames(content: string): readonly string[] {
  const names = new Set<string>();
  for (const form of EXPORT_FORMS) {
    /*
     * `matchAll` and NOT `exec`, and that is the whole reason these module-level
     * /g regexes are safe to share. A /g regex driven by `exec` carries
     * `lastIndex` between calls and would skip the first half of the second file
     * it ever saw; `String.prototype.matchAll` constructs a fresh regex from
     * this one on every call, so nothing is carried.
     *
     * An earlier version of this loop cloned each pattern by hand and said in a
     * comment that it had to. It did not, and a mutation that removed the clone
     * survived every test — which is how the comment was caught claiming a
     * defect it does not prevent. The determinism test in artifact-set.test.ts
     * is kept: it pins the PROPERTY ("two identical calls agree"), which is what
     * stays true if this ever becomes an `exec` loop.
     */
    for (const hit of content.matchAll(form)) {
      const body = hit[1];
      if (!body) continue;
      for (const part of body.split(',')) {
        // `a as b` exports `b`; `type { X }` exports `X`.
        const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
        if (name && /^\w+$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * What replacing `before` with `after` does to the names dependents import.
 *
 * Reported for every shared replacement whether or not anything was removed,
 * because "nothing was removed" is a measurement and "we did not look" is not.
 */
export function sharedSurfaceChange(before: string, after: string): SharedSurfaceChange {
  const old = exportedNames(before);
  if (old.length === 0) return { state: 'UNREADABLE' };
  const next = new Set(exportedNames(after));
  const oldSet = new Set(old);
  return {
    state: 'READ',
    removed: old.filter((name) => !next.has(name)),
    added: [...next].filter((name) => !oldSet.has(name)),
  };
}

// ─── Refusal ────────────────────────────────────────────────────────────────

/**
 * Why a set may not be applied. Closed, so every caller handles every reason
 * and a new one cannot be added as a silent pass.
 */
export const ARTIFACT_SET_PROBLEMS = [
  /** Two artifacts at one path: the second silently wins, and which one is undefined. */
  'DUPLICATE_PATH',
  /** `..`, an absolute path, a backslash, or a Windows drive. A path is not a place to be clever. */
  'PATH_ESCAPE',
  /** A writable disposition against an ownership verdict that forbids writing. */
  'WRITE_TO_UNOWNED',
  /** UPDATE_OWNED or PROPOSED_EDIT with no `basedOnHash`: a change against unknown bytes. */
  'MISSING_BASE_HASH',
  /** NEW with a `basedOnHash`: a creation that claims to know what was already there. */
  'BASE_HASH_ON_NEW',
  /** The ledger has moved since this was computed. Applying it discards whatever moved it. */
  'STALE_BASE',
  /** An import that resolves neither inside the set nor in the ledger. */
  'UNRESOLVED_IMPORT',
  /** A dependency is written after the file that imports it. */
  'APPLY_ORDER',
  /** A shared artifact is replaced and a name its dependents import would disappear. */
  'SHARED_EXPORT_REMOVED',
  /** A shared artifact is replaced and nothing could be read about its surface. */
  'SHARED_SURFACE_UNREADABLE',
  /** Empty, or past {@link MAX_ARTIFACTS_PER_SET}. */
  'SET_SIZE',
  /** Past {@link MAX_ARTIFACT_CHARS}, {@link MAX_ARTIFACT_PATH_CHARS} or {@link MAX_ARTIFACT_IMPORTS}. */
  'ARTIFACT_SIZE',
] as const;
export type ArtifactSetProblemKind = (typeof ARTIFACT_SET_PROBLEMS)[number];

export interface ArtifactSetProblem {
  readonly kind: ArtifactSetProblemKind;
  /** The offending path, so a finding is attributable to a file a human can open. */
  readonly path: string;
  /** One sentence a human can act on. */
  readonly why: string;
}

/**
 * Severity, as a compiler-enforced record: does this problem FORBID applying
 * the set, or only the one artifact?
 *
 * Every member is `true` today and that is a decision rather than an
 * oversight: an artifact set is one logical change, and applying the four files
 * of a five-file set leaves a repository that does not build. A sixth problem
 * added here must choose, which is the whole reason the record exists.
 */
export const PROBLEM_BLOCKS_SET = {
  DUPLICATE_PATH: true,
  PATH_ESCAPE: true,
  WRITE_TO_UNOWNED: true,
  MISSING_BASE_HASH: true,
  BASE_HASH_ON_NEW: true,
  STALE_BASE: true,
  UNRESOLVED_IMPORT: true,
  APPLY_ORDER: true,
  SHARED_EXPORT_REMOVED: true,
  SHARED_SURFACE_UNREADABLE: true,
  SET_SIZE: true,
  ARTIFACT_SIZE: true,
} as const satisfies Record<ArtifactSetProblemKind, boolean>;

/** `..`, absolute, backslash-separated, or a drive letter. */
function pathEscapes(path: string): boolean {
  if (path.length === 0 || path.length > MAX_ARTIFACT_PATH_CHARS) return true;
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (path.includes('\\')) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split('/').includes('..');
}

/**
 * The two facts a full refusal decision needs and a schema cannot have.
 *
 * Both optional and both INJECTED, per rule 8: no filesystem reaches this
 * module. `priorContent` is a reader over the customer's working tree, which is
 * the one input that cannot be derived from the set or the ledger — the ledger
 * stores a DIGEST of what QAAI wrote, never a copy of the customer's file, so
 * that a lost database is not a lost repository.
 */
export interface ArtifactSetContext {
  readonly ledger?: readonly ArtifactLedgerEntry[];
  /**
   * The bytes currently at a repo-relative path, or null when they could not be
   * read. Null is "unavailable" and is treated as a refusal, never as "empty".
   */
  readonly priorContent?: (path: string) => string | null;
}

/**
 * EVERY reason this set may not be applied, in one list.
 *
 * The one place that decides refusal. `artifactSetSchema` in schemas.ts calls
 * it for the ledger-free half and the write path calls it with the ledger for
 * the rest, so there is exactly one implementation of "may this be written"
 * rather than one per caller — which is how `ASSERTION_KEY` and the regex in
 * `specAssertions` came to be two vocabularies for one question.
 *
 * EVERY OMITTED INPUT FAILS CLOSED, which is the property that makes one
 * function safe for both callers. With no `ledger` every path resolves
 * UNRECORDED, so an artifact claiming NEW or UPDATE_OWNED is refused with
 * WRITE_TO_UNOWNED. With no `priorContent` a shared replacement is refused with
 * SHARED_SURFACE_UNREADABLE. A caller that forgets an input gets a refusal, not
 * a write.
 */
export function artifactSetProblems(
  set: ArtifactSet,
  context: ArtifactSetContext = {},
): readonly ArtifactSetProblem[] {
  const ledger = context.ledger ?? [];
  const problems: ArtifactSetProblem[] = [];
  const add = (kind: ArtifactSetProblemKind, path: string, why: string): void => {
    problems.push({ kind, path, why });
  };

  if (set.artifacts.length === 0) {
    add('SET_SIZE', '', 'An artifact set with no artifacts is not a generated test.');
    return problems;
  }
  if (set.artifacts.length > MAX_ARTIFACTS_PER_SET) {
    add(
      'SET_SIZE',
      '',
      `${set.artifacts.length} artifacts, past the cap of ${MAX_ARTIFACTS_PER_SET}. ` +
        'Nothing was applied and nothing was truncated.',
    );
    return problems;
  }

  const seen = new Set<string>();
  const inSet = new Set(set.artifacts.map((a) => a.path));
  const inLedger = new Set(ledger.map((entry) => entry.path));
  let previousRank = -1;

  for (const artifact of set.artifacts) {
    const { path } = artifact;

    if (seen.has(path)) {
      add('DUPLICATE_PATH', path, 'Two artifacts in this set write to the same path.');
    }
    seen.add(path);

    if (pathEscapes(path)) {
      add(
        'PATH_ESCAPE',
        path,
        'Not a repo-relative path. A generated path is written to disk and committed to a PR.',
      );
    }

    if (artifact.content.length > MAX_ARTIFACT_CHARS) {
      add(
        'ARTIFACT_SIZE',
        path,
        `${artifact.content.length} characters, past the cap of ${MAX_ARTIFACT_CHARS}.`,
      );
    }
    if (artifact.imports.length > MAX_ARTIFACT_IMPORTS) {
      add(
        'ARTIFACT_SIZE',
        path,
        `${artifact.imports.length} recorded imports, past the cap of ${MAX_ARTIFACT_IMPORTS}.`,
      );
    }

    // Disposition ⇄ ownership. The refusal rule 5 of this round asks for by
    // name: an artifact that would write to a file QAAI does not own.
    if (WRITABLE_BY_DISPOSITION[artifact.disposition] && !WRITABLE_BY_OWNERSHIP[artifact.ownership]) {
      add(
        'WRITE_TO_UNOWNED',
        path,
        `Disposition ${artifact.disposition} would write a file recorded as ` +
          `${artifact.ownership}. Propose it instead.`,
      );
    }

    // The ownership the artifact CLAIMS against the ownership the ledger
    // RECORDS. A set computed against one ledger and applied against another is
    // exactly how a human's edit gets discarded.
    const recorded = resolveOwnership(ledger, path);
    if (recorded !== artifact.ownership) {
      add(
        'STALE_BASE',
        path,
        `This set was computed when the ledger said ${artifact.ownership}; it now says ` +
          `${recorded}. Recompute it rather than applying it.`,
      );
    }

    if (artifact.disposition === 'NEW' && artifact.basedOnHash !== null) {
      add(
        'BASE_HASH_ON_NEW',
        path,
        'A NEW artifact carries a base hash, so it is not a creation. Resolve the disposition first.',
      );
    }
    if (artifact.disposition !== 'NEW' && artifact.basedOnHash === null) {
      add(
        'MISSING_BASE_HASH',
        path,
        `A ${artifact.disposition} with no base hash is a change computed against unknown bytes.`,
      );
    }

    const ledgerRow = ledger.find((entry) => entry.path === path);
    if (
      artifact.disposition === 'UPDATE_OWNED' &&
      ledgerRow &&
      artifact.basedOnHash !== null &&
      artifact.basedOnHash !== ledgerRow.contentHash
    ) {
      add(
        'STALE_BASE',
        path,
        'The bytes this change was computed against are not the bytes the ledger holds.',
      );
    }

    for (const specifier of artifact.imports) {
      if (inSet.has(specifier) || inLedger.has(specifier)) continue;
      add(
        'UNRESOLVED_IMPORT',
        path,
        `Imports ${specifier}, which is neither in this set nor in the ledger. A set that ` +
          'half-resolves is a test that fails on its first run for a reason that is ours.',
      );
    }

    const rank = ARTIFACT_ROLE_RANK[artifact.role];
    if (rank < previousRank) {
      add(
        'APPLY_ORDER',
        path,
        `A ${artifact.role} is listed after a role that may import it. Order the set by ` +
          'ARTIFACT_ROLE_RANK so a dependency is on disk first.',
      );
    }
    previousRank = Math.max(previousRank, rank);

    // The shared-surface rule. Only for a REPLACEMENT of a shared artifact that
    // actually has dependents — a page object nothing imports yet can be
    // rewritten freely, and saying otherwise would be noise that gets the whole
    // check ignored.
    if (artifact.disposition === 'NEW' || !SHARED_ROLES[artifact.role]) continue;
    const dependents = dependentsOf(ledger, path);
    if (dependents.length === 0) continue;
    const prior = context.priorContent?.(path) ?? null;
    if (prior === null) {
      add(
        'SHARED_SURFACE_UNREADABLE',
        path,
        `${dependents.length} file(s) import this and the bytes it replaces were not supplied, ` +
          'so nothing could be said about what they would lose.',
      );
      continue;
    }
    const change = sharedSurfaceChange(prior, artifact.content);
    if (change.state === 'UNREADABLE') {
      add(
        'SHARED_SURFACE_UNREADABLE',
        path,
        `${dependents.length} file(s) import this and no export form could be read from what it ` +
          'replaces. UNREADABLE is not "nothing was removed".',
      );
      continue;
    }
    if (change.removed.length > 0) {
      add(
        'SHARED_EXPORT_REMOVED',
        path,
        `Removes ${change.removed.join(', ')}, imported by ${dependents
          .map((entry) => entry.path)
          .join(', ')}. Change the dependents in the same set, or propose it.`,
      );
    }
  }

  return problems;
}

// ─── The migration path from one `code` and one `filePath` ──────────────────

/**
 * The single-file shape, as a set of one.
 *
 * THIS IS WHY BOTH SHAPES EXIST. Every producer in the repo — the generator,
 * `inline-edit.ts`, `heal-apply.ts`, the importer — and every consumer —
 * `admit`, `Test.code`, the runner, the cockpit's editor — speaks in one file
 * today. Replacing that shape in one change would mean rewriting all of them in
 * one change, and a keystone that breaks every caller is not a migration path.
 *
 * So: the single-file fields stay AUTHORITATIVE, the set travels beside them,
 * and `generatedTestSchema` refuses a pair that disagrees (see schemas.ts). A
 * consumer that has not been taught about sets keeps working on exactly the
 * bytes it worked on before; a consumer that has been taught calls
 * {@link artifactSetOf} and never branches.
 *
 * `ownership` is `QAAI_OWNED` and `disposition` `NEW`, which is what a freshly
 * generated single file IS. A caller applying it to a path that already exists
 * must re-resolve both through {@link dispositionFor} against the real ledger —
 * this function describes what the producer made, not what the repository will
 * accept.
 */
export function singleFileArtifactSet(args: {
  readonly filePath: string;
  readonly code: string;
  readonly dialect?: DialectId | null;
  readonly why?: string;
}): ArtifactSet {
  return {
    dialect: args.dialect ?? null,
    artifacts: [
      {
        role: 'SPEC',
        path: args.filePath,
        content: args.code,
        disposition: 'NEW',
        ownership: 'QAAI_OWNED',
        imports: [],
        basedOnHash: null,
        why: args.why ?? 'The generated test.',
      },
    ],
  };
}

/** The one SPEC in a set, or null. A set may legitimately have none — a refactor that only extracts a fixture. */
export function specArtifactOf(set: ArtifactSet): GeneratedArtifact | null {
  return set.artifacts.find((artifact) => artifact.role === 'SPEC') ?? null;
}

/**
 * Order a set for application: dependencies first, path-stable within a role.
 *
 * Stable on path rather than on input order, so two runs over the same artifacts
 * produce the same sequence and a diff of two proposals is readable.
 */
export function orderedForApply(set: ArtifactSet): ArtifactSet {
  const artifacts = [...set.artifacts].sort((a, b) => {
    const rank = ARTIFACT_ROLE_RANK[a.role] - ARTIFACT_ROLE_RANK[b.role];
    return rank !== 0 ? rank : a.path.localeCompare(b.path);
  });
  return { ...set, artifacts };
}

// ─── The correction corpus ──────────────────────────────────────────────────

/**
 * WHAT REVIEWERS ALWAYS CHANGE.
 *
 * The diff between the GENERATOR's version of a test and the FIRST HUMAN
 * version of it is free supervision, it has been sitting in `TestVersion.source`
 * since that column existed, and it is read by nothing. The classification is
 * the product: a raw diff blob teaches nothing, because nobody can ask it "do
 * reviewers rewrite our locators, or our assertions?" and get a number.
 *
 * Closed, and a Prisma enum (`CorrectionKind`) because the question is literally
 * `GROUP BY kind`.
 *
 * ── The nine the round named, and the three that were added ────────────────
 *
 * `FORMATTING_ONLY` because a formatter's output is not a reviewer's objection,
 * and without it the top correction in every repository with a pre-commit hook
 * is whitespace — a true number that answers the wrong question.
 *
 * `NAMING_CHANGED` because it is the most common rewrite in any suite and it is
 * the one a house-style profile directly fixes, so leaving it unnamed would hide
 * the evidence that the profile works.
 *
 * `UNCLASSIFIED` because a diff the classifier cannot name must be COUNTED. Both
 * alternatives are lies this product cannot afford: dropping it is a failure
 * suppressed without being counted, and forcing it into the nearest bucket is a
 * measurement that was not measured.
 */
export const CORRECTION_KINDS = [
  'LOCATOR_CHANGED',
  'ASSERTION_STRENGTHENED',
  'ASSERTION_WEAKENED',
  'WAIT_REMOVED',
  'HELPER_SUBSTITUTED',
  'FILE_MOVED',
  'DATA_EXTRACTED',
  'TEST_SPLIT',
  'TEST_DELETED',
  'NAMING_CHANGED',
  'FORMATTING_ONLY',
  'UNCLASSIFIED',
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/**
 * Does this correction say the GENERATOR was wrong about something a prompt or
 * a style profile could fix?
 *
 * Compiler-enforced over every kind, because the whole value of the corpus is
 * the ratio: "9 of your last 10 corrections were locators" is an instruction to
 * change the locator strategy, while "9 of 10 were formatting" is an instruction
 * to run the formatter and stop counting.
 *
 * `ASSERTION_WEAKENED` is `false` on purpose and it is the interesting one: a
 * human weakening our assertion is usually the human being wrong, or the
 * application being under-specified. Feeding it back as a lesson would teach
 * QAAI to assert less, which is the opposite of the product.
 */
export const CORRECTION_IS_ACTIONABLE = {
  LOCATOR_CHANGED: true,
  ASSERTION_STRENGTHENED: true,
  ASSERTION_WEAKENED: false,
  WAIT_REMOVED: true,
  HELPER_SUBSTITUTED: true,
  FILE_MOVED: true,
  DATA_EXTRACTED: true,
  TEST_SPLIT: true,
  TEST_DELETED: false,
  NAMING_CHANGED: true,
  FORMATTING_ONLY: false,
  UNCLASSIFIED: false,
} as const satisfies Record<CorrectionKind, boolean>;

/** How much of a changed line the corpus keeps. A correction is evidence, not a copy of the file. */
export const MAX_CORRECTION_QUOTE_CHARS = 300;

/** Classified items per correction. Past this the diff is a rewrite, and the count says so. */
export const MAX_CORRECTION_ITEMS = 60;

/** One classified change inside one correction. */
export interface CorrectionItem {
  readonly kind: CorrectionKind;
  /** 1-based line in the GENERATED version, when there is one line to blame. */
  readonly line: number | null;
  /**
   * The generated line and the human's replacement, each bounded by
   * {@link MAX_CORRECTION_QUOTE_CHARS}.
   *
   * UNTRUSTED TEXT, both of them. A human "correction" is attacker-influenced
   * input in any deployment where a pull request can be opened, and this corpus
   * is read back into a prompt whose output is written into the repository. So
   * these are DATA: quoted, fenced and length-bounded by
   * `fenceUntrusted` in style-profile.ts wherever they reach a model, and never
   * interpolated raw.
   */
  readonly before: string;
  readonly after: string;
}

/**
 * A query handle that cannot be built without a project.
 *
 * ── Why a brand and not a convention ───────────────────────────────────────
 *
 * The corpus is CUSTOMER TEST CODE. Nothing in it may leave the customer's
 * project boundary, be aggregated across organisations, or be used for anything
 * but that project's own generation. "Remember to pass projectId" is not a
 * boundary — it is a comment that one `where: { orgId }` defeats. So the only
 * way to obtain a where-clause for this corpus is {@link corpusWhere}, and the
 * only way to obtain its argument is {@link corpusScope}, which requires both
 * ids. A cross-project query does not compile.
 *
 * `const … : unique symbol = Symbol(…)` and NOT `declare const`, for the reason
 * principals.ts and provider-catalogue.ts both record: a declared-only symbol
 * is erased, and the brand becomes forgeable by an object literal.
 */
const CORPUS_SCOPE_WITNESS: unique symbol = Symbol('qaai.artifact-set.corpus-scope');

export interface CorpusScope {
  readonly orgId: string;
  readonly projectId: string;
  readonly [CORPUS_SCOPE_WITNESS]: 'PROJECT';
}

/**
 * The only constructor. Both ids are required and neither may be blank.
 *
 * WHITESPACE IS BLANK, and the check is on the TRIMMED length for that reason.
 * It was `length === 0` under this same doc comment, so a scope over two spaces
 * was built, `corpusWhere` asked Prisma for an org whose id is two spaces, and
 * the corpus came back EMPTY — which a caller reads as "this project's
 * reviewers have changed nothing" rather than as a bad id. A null that became
 * zero, in the privacy boundary.
 *
 * The ids are stored AS GIVEN and not trimmed. Refusing a blank id is this
 * function's job; quietly rewriting a non-blank one into a different id is not,
 * and a scope whose `orgId` does not equal what the caller passed is a worse
 * surprise than the one being fixed.
 */
export function corpusScope(orgId: string, projectId: string): CorpusScope {
  if (orgId.trim().length === 0 || projectId.trim().length === 0) {
    throw new Error('corpusScope requires a non-blank orgId and projectId');
  }
  return { orgId, projectId, [CORPUS_SCOPE_WITNESS]: 'PROJECT' };
}

/**
 * The only where-clause. Returns a plain object with BOTH keys, so a Prisma
 * call spreads it and cannot accidentally widen.
 *
 * The brand is dropped on the way out deliberately: the returned object is
 * handed to Prisma, and a symbol key in a `where` is a field Prisma does not
 * know.
 */
export function corpusWhere(scope: CorpusScope): { orgId: string; projectId: string } {
  return { orgId: scope.orgId, projectId: scope.projectId };
}

/** One correction, as the corpus stores and summarises it. */
export interface TestCorrection {
  readonly testId: string;
  /** `TestVersion.version` of the GENERATOR row and of the first HUMAN row after it. */
  readonly generatedVersion: number;
  readonly humanVersion: number;
  /** Distinct kinds present in `items`, for the group-by. Never empty — see {@link classifyCorrection}. */
  readonly kinds: readonly CorrectionKind[];
  readonly items: readonly CorrectionItem[];
  /** The surface key the test was about, when the test declared one. Null is "not declared", not "none". */
  readonly surface: string | null;
  readonly addedLines: number;
  readonly removedLines: number;
  /**
   * How many items the classifier could not name. DISCLOSED rather than
   * hidden: a corpus reporting "100% locator changes" over a diff it mostly
   * failed to read is the lie this field exists to prevent.
   */
  readonly unclassifiedCount: number;
  /**
   * Which version of the classifier produced this. Bumped whenever a detector
   * changes, so a mixed corpus can be read honestly and a reclassification is
   * distinguishable from a new correction.
   */
  readonly classifierVersion: number;
  /**
   * Classified changes {@link MAX_CORRECTION_ITEMS} refused to keep.
   *
   * A CAP THAT BIT, REPORTED AS A COUNT. Without this the corpus would read a
   * 200-line rewrite as sixty tidy corrections and the sixty would look like
   * the whole story — a cap applied without being disclosed, which is one of
   * the lies this product cannot afford. `kinds` is still the DISTINCT set over
   * the kept items only, so a corpus with a non-zero `itemsOmitted` is a row
   * whose kind breakdown is a sample rather than a census.
   */
  readonly itemsOmitted: number;
}

/**
 * Bump this when a detector below changes its mind about anything.
 *
 * Stored on every row. Without it, improving the locator detector silently
 * rewrites the meaning of every historical row, and the trend line — which is
 * the entire point of a corpus — becomes an artefact of our own deploys.
 */
export const CORRECTION_CLASSIFIER_VERSION = 1;

/**
 * The detectors `classifyCorrection` needs, INJECTED.
 *
 * Why injected rather than imported: the assertion vocabulary lives in this
 * package (`dialect.ts`) but `FIXED_SLEEP_PATTERNS` lives in
 * packages/agent/src/ecosystem-prompts.ts, beside the prompt rule it enforces
 * and beside `admit`'s NO_FIXED_SLEEP gate. A second copy of those patterns
 * here is exactly how `ASSERTION_KEY` and the regex in `specAssertions` became
 * two vocabularies for one question — so there is no default, and the caller
 * hands over the one the gate already uses.
 */
export interface CorrectionProbes {
  readonly assertionCount: (code: string) => number;
  /** Assertion lines, normalised enough to compare two versions. */
  readonly assertionLines: (code: string) => readonly string[];
  readonly hasFixedSleep: (code: string) => boolean;
}

/** Locator-ish call shapes, across the dialects this product generates. */
const LOCATOR_FORMS: readonly RegExp[] = [
  /\b(?:getBy|locator|findElement|find_element|querySelector|css|xpath|By\.\w+|page_object)\b/,
  /\b(?:cy\.get|\$\(|\$x\()/,
  /\bdata-(?:testid|test|qa|cy)\b/,
];

/** A helper or page-object call: a named call on an imported object. */
const HELPER_FORMS: readonly RegExp[] = [/\b[a-z]\w*\.[a-z]\w*\s*\(/i, /\b(?:await\s+)?\w+Page\b/];

function normaliseWhitespace(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function quote(line: string): string {
  return normaliseWhitespace(line).slice(0, MAX_CORRECTION_QUOTE_CHARS);
}

/**
 * Classify what a human changed about a generated test. Deterministic, no
 * model, no network.
 *
 * ── The rule that governs every branch ─────────────────────────────────────
 *
 * `kinds` is NEVER EMPTY for a diff that exists. An empty list reads as "the
 * human changed nothing", which is a null that became zero: the corpus would
 * report a clean generation where a reviewer in fact rewrote the file in a way
 * we could not name. So a changed pair that matches no detector is
 * `UNCLASSIFIED`, and `unclassifiedCount` carries the number.
 *
 * ── Line-based, and why that is enough ─────────────────────────────────────
 *
 * String-and-offset level, not AST level, for the reason suite-health.ts gives:
 * the two inputs are whatever a model and a human last wrote, including files
 * that do not parse, and a parser that throws on one of them loses the whole
 * correction. The cost is that a reformat looks like a change to every line it
 * touched — which is exactly what `FORMATTING_ONLY` is for, and it is checked
 * FIRST so a repository with a formatter does not drown the corpus.
 */
export function classifyCorrection(
  args: {
    readonly before: string;
    readonly after: string;
    readonly beforePath: string;
    readonly afterPath: string;
    readonly testId: string;
    readonly generatedVersion: number;
    readonly humanVersion: number;
    readonly surface?: string | null;
  },
  probes: CorrectionProbes,
): TestCorrection {
  const items: CorrectionItem[] = [];
  const beforeLines = args.before.split('\n');
  const afterLines = args.after.split('\n');

  const beforeSet = new Set(beforeLines.map(normaliseWhitespace).filter((l) => l.length > 0));
  const afterSet = new Set(afterLines.map(normaliseWhitespace).filter((l) => l.length > 0));

  const removed = beforeLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const n = normaliseWhitespace(line);
      return n.length > 0 && !afterSet.has(n);
    });
  const added = afterLines
    .map((line) => normaliseWhitespace(line))
    .filter((line) => line.length > 0 && !beforeSet.has(line));

  let omitted = 0;
  const add = (kind: CorrectionKind, line: number | null, before: string, after: string): void => {
    // The cap is COUNTED, not swallowed. See TestCorrection.itemsOmitted.
    if (items.length >= MAX_CORRECTION_ITEMS) {
      omitted += 1;
      return;
    }
    items.push({ kind, line, before: quote(before), after: quote(after) });
  };

  // FORMATTING_ONLY first. Equal ignoring every run of whitespace means the
  // human ran the formatter and changed nothing a prompt could learn from.
  const sameIgnoringWhitespace =
    args.before.replace(/\s+/g, '') === args.after.replace(/\s+/g, '') && args.before !== args.after;
  if (sameIgnoringWhitespace) {
    add('FORMATTING_ONLY', null, 'whitespace', 'whitespace');
  }

  if (args.beforePath !== args.afterPath) {
    add('FILE_MOVED', null, args.beforePath, args.afterPath);
  }

  if (args.after.trim().length === 0 && args.before.trim().length > 0) {
    add('TEST_DELETED', null, 'the generated test', 'an empty file');
  }

  if (!sameIgnoringWhitespace) {
    // Assertion strength, measured through the probe the admission gate uses,
    // so "stronger" means the same thing here and at the gate.
    const beforeAssertions = probes.assertionCount(args.before);
    const afterAssertions = probes.assertionCount(args.after);
    if (afterAssertions > beforeAssertions) {
      add(
        'ASSERTION_STRENGTHENED',
        null,
        `${beforeAssertions} assertion(s)`,
        `${afterAssertions} assertion(s)`,
      );
    } else if (afterAssertions < beforeAssertions) {
      add(
        'ASSERTION_WEAKENED',
        null,
        `${beforeAssertions} assertion(s)`,
        `${afterAssertions} assertion(s)`,
      );
    } else {
      // Same count, different text: the assertion was rewritten rather than
      // added or dropped. Reported as STRENGTHENED only when the text changed,
      // because an unchanged set of assertions is not a correction at all.
      const beforeAsserts = probes.assertionLines(args.before).map(normaliseWhitespace);
      const afterAsserts = new Set(probes.assertionLines(args.after).map(normaliseWhitespace));
      const rewritten = beforeAsserts.filter((line) => !afterAsserts.has(line));
      if (rewritten.length > 0 && rewritten[0] !== undefined) {
        add('ASSERTION_STRENGTHENED', null, rewritten[0], 'rewritten by the reviewer');
      }
    }

    if (probes.hasFixedSleep(args.before) && !probes.hasFixedSleep(args.after)) {
      add('WAIT_REMOVED', null, 'a fixed sleep', 'auto-waiting');
    }

    for (const { line, index } of removed) {
      const replacement = added.find((candidate) => similarShape(line, candidate)) ?? '';
      const normalised = normaliseWhitespace(line);
      if (LOCATOR_FORMS.some((form) => form.test(normalised))) {
        add('LOCATOR_CHANGED', index + 1, line, replacement);
        continue;
      }
      if (
        replacement.length > 0 &&
        HELPER_FORMS.some((form) => form.test(replacement)) &&
        !HELPER_FORMS.some((form) => form.test(normalised))
      ) {
        add('HELPER_SUBSTITUTED', index + 1, line, replacement);
      }
    }

    // DATA_EXTRACTED: literals in the generated version replaced by a reference.
    const beforeLiterals = countLiterals(args.before);
    const afterLiterals = countLiterals(args.after);
    if (beforeLiterals > afterLiterals && afterLiterals >= 0 && beforeLiterals - afterLiterals >= 2) {
      add(
        'DATA_EXTRACTED',
        null,
        `${beforeLiterals} inline literal(s)`,
        `${afterLiterals} inline literal(s)`,
      );
    }

    // TEST_SPLIT: more test declarations after than before.
    const beforeBlocks = countTestBlocks(args.before);
    const afterBlocks = countTestBlocks(args.after);
    if (afterBlocks > beforeBlocks) {
      add('TEST_SPLIT', null, `${beforeBlocks} test(s)`, `${afterBlocks} test(s)`);
    }

    // NAMING_CHANGED: the test's own declared title was rewritten.
    const beforeTitle = firstTestTitle(args.before);
    const afterTitle = firstTestTitle(args.after);
    if (beforeTitle !== null && afterTitle !== null && beforeTitle !== afterTitle) {
      add('NAMING_CHANGED', null, beforeTitle, afterTitle);
    }
  }

  // The rule: a diff that exists is never classified as nothing.
  if (items.length === 0 && (removed.length > 0 || added.length > 0)) {
    add(
      'UNCLASSIFIED',
      removed[0] ? removed[0].index + 1 : null,
      removed[0]?.line ?? '',
      added[0] ?? '',
    );
  }

  const kinds = [...new Set(items.map((item) => item.kind))];
  return {
    testId: args.testId,
    generatedVersion: args.generatedVersion,
    humanVersion: args.humanVersion,
    kinds,
    items,
    surface: args.surface ?? null,
    addedLines: added.length,
    removedLines: removed.length,
    unclassifiedCount: items.filter((item) => item.kind === 'UNCLASSIFIED').length,
    classifierVersion: CORRECTION_CLASSIFIER_VERSION,
    itemsOmitted: omitted,
  };
}

/**
 * MAY THIS CORRECTION BE STORED.
 *
 * False for an identical pair, and that is not a failure: a human who saved a
 * test without changing a byte supervised nothing, and
 * `testCorrectionSchema` refuses `kinds: []` for exactly that reason. The
 * predicate exists so a write path does not have to learn the rule from a
 * parse error — a producer and a validator that disagree about one shape is the
 * defect eight producer-versus-validator pairs were found one at a time for.
 *
 * `kinds` and not `items`: {@link classifyCorrection} guarantees that a diff
 * which exists produces at least one item, so an empty `kinds` means an empty
 * diff, which is the only unstorable case.
 */
export function isRecordableCorrection(correction: TestCorrection): boolean {
  return correction.kinds.length > 0;
}

/** Two lines are "the same statement, rewritten" when they share their leading call shape. */
function similarShape(a: string, b: string): boolean {
  const head = (line: string): string =>
    normaliseWhitespace(line).replace(/['"`][^'"`]*['"`]/g, '""').slice(0, 24);
  return head(a) === head(b);
}

/** Quoted literals, as a proxy for inline test data. Strings only — a number is as likely to be a timeout. */
function countLiterals(code: string): number {
  return [...code.matchAll(/(['"])(?:(?!\1)[^\\\n]|\\.){2,}\1/g)].length;
}

/** `test(`, `it(`, `def test_`, `@Test`, `func Test`, `scenario(` — enough to count, never to parse. */
function countTestBlocks(code: string): number {
  return [
    ...code.matchAll(
      /(?:^|\s)(?:test|it|scenario|Scenario)\s*\(|(?:^|\s)def\s+test_\w+|@Test\b|(?:^|\s)func\s+Test\w+/g,
    ),
  ].length;
}

/** The first declared test title, for NAMING_CHANGED. Null when none is readable. */
function firstTestTitle(code: string): string | null {
  const hit = /(?:test|it|scenario)\s*\(\s*(['"`])([^'"`\n]{1,200})\1/.exec(code);
  if (hit?.[2]) return hit[2];
  const py = /def\s+(test_\w{1,200})/.exec(code);
  return py?.[1] ?? null;
}

/**
 * The group-by, scoped so it cannot cross projects.
 *
 * Takes a {@link CorpusScope} it does not strictly need, and re-checks every
 * row against it: the compile-time brace is {@link corpusWhere}, and this is the
 * run-time belt. A row from another project reaching this function means a
 * caller built a query some other way, and the honest response is to refuse it
 * rather than to average it in.
 *
 * `rowsRejected` is reported rather than silently dropped — a failure
 * suppressed without being counted is one of the lies this product cannot
 * afford.
 */
export function summariseCorrections(
  scope: CorpusScope,
  rows: readonly (TestCorrection & { readonly orgId: string; readonly projectId: string })[],
): {
  readonly byKind: Readonly<Record<CorrectionKind, number>>;
  readonly actionable: number;
  readonly total: number;
  readonly rowsRejected: number;
  readonly unclassified: number;
} {
  const byKind = Object.fromEntries(CORRECTION_KINDS.map((kind) => [kind, 0])) as Record<
    CorrectionKind,
    number
  >;
  let total = 0;
  let rejected = 0;
  let actionable = 0;
  let unclassified = 0;

  for (const row of rows) {
    if (row.orgId !== scope.orgId || row.projectId !== scope.projectId) {
      rejected += 1;
      continue;
    }
    total += 1;
    unclassified += row.unclassifiedCount;
    for (const kind of row.kinds) {
      byKind[kind] += 1;
      if (CORRECTION_IS_ACTIONABLE[kind]) actionable += 1;
    }
  }

  return { byKind, actionable, total, rowsRejected: rejected, unclassified };
}

// ─── Suite-change proposals ─────────────────────────────────────────────────

/**
 * WHAT QAAI MAY ASK TO CHANGE ABOUT TESTS THAT ALREADY EXIST.
 *
 * `suite-health.ts` has named duplicate clusters and weak assertions since it
 * was written and nothing could act on them. This is the vocabulary of the act.
 *
 * ── There is deliberately no DELETE kind ───────────────────────────────────
 *
 * suite-health.ts's rule ONE: nothing in this product deletes a test and
 * nothing is allowed to say that deleting one is safe, because a "duplicate"
 * that differs in one assertion is frequently the only test that catches a
 * regression and a test is not recoverable once it is gone. `safeToDelete` is a
 * field there and it is always false. MERGE_NEAR_DUPLICATES is as far as this
 * vocabulary goes, and a merge keeps every assertion both members made —
 * which is why it is a merge and not a delete.
 */
export const SUITE_CHANGE_KINDS = [
  /** Copy-pasted setup becomes the repository's own fixture mechanism. The reviewers' first complaint. */
  'EXTRACT_FIXTURE',
  /** Locators and actions move behind a page object the specs import. */
  'EXTRACT_PAGE_OBJECT',
  /** Inline data becomes a dataset two or more specs share. */
  'EXTRACT_DATASET',
  /** Two near-duplicates become one test that still makes every assertion both made. */
  'MERGE_NEAR_DUPLICATES',
  /** A `TRANSPORT_ONLY` or `EXISTENCE_ONLY` finding becomes an assertion about the thing that matters. */
  'STRENGTHEN_ASSERTION',
  /** A fixed sleep becomes an awaited condition. */
  'REMOVE_FIXED_SLEEP',
  /** A nth-child CSS chain becomes a role, label or test-id locator. */
  'REPLACE_BRITTLE_LOCATOR',
  /** A copy-pasted case family becomes the repository's own parameterisation idiom. */
  'PARAMETERISE_CASES',
  /** One test asserting four unrelated things becomes four tests. */
  'SPLIT_TEST',
  /** A file moves to the path the repository's own convention puts it at. */
  'MOVE_FILE',
  /** Naming, imports, quotes and structure are brought to the computed house style. */
  'ADOPT_HOUSE_STYLE',
] as const;
export type SuiteChangeKind = (typeof SUITE_CHANGE_KINDS)[number];

/**
 * Does this kind change what a test CHECKS, as opposed to how it is written?
 *
 * Compiler-enforced. It decides the review bar: a change that alters coverage
 * needs the eye of somebody who knows the application, while a rename does not.
 * `MERGE_NEAR_DUPLICATES` is `true` because a merge that drops an assertion is
 * the single most expensive mistake this vocabulary can make.
 */
export const CHANGE_ALTERS_BEHAVIOUR = {
  EXTRACT_FIXTURE: false,
  EXTRACT_PAGE_OBJECT: false,
  EXTRACT_DATASET: false,
  MERGE_NEAR_DUPLICATES: true,
  STRENGTHEN_ASSERTION: true,
  REMOVE_FIXED_SLEEP: true,
  REPLACE_BRITTLE_LOCATOR: true,
  PARAMETERISE_CASES: true,
  SPLIT_TEST: true,
  MOVE_FILE: false,
  ADOPT_HOUSE_STYLE: false,
} as const satisfies Record<SuiteChangeKind, boolean>;

/** Where a proposal is in its life. A Prisma enum: every list in the cockpit filters on it. */
export const SUITE_CHANGE_STATES = [
  'PROPOSED',
  'APPROVED',
  'APPLIED',
  'REVERTED',
  'REJECTED',
  /** A later proposal covers the same files. Kept, so the trail does not vanish. */
  'SUPERSEDED',
  /**
   * Cannot be applied as written — a dependent moved, the base bytes changed,
   * the revert record no longer describes the tree. A separate state from
   * REJECTED because nobody decided it: the world did.
   */
  'BLOCKED',
] as const;
export type SuiteChangeState = (typeof SUITE_CHANGE_STATES)[number];

/**
 * May a proposal in this state still be applied to the working tree?
 *
 * Compiler-enforced, and `APPROVED` is the only `true`. PROPOSED is false on
 * purpose: the gap between proposing and applying is the human, and a state
 * machine where the producer's own state is applyable is not a review.
 */
export const APPLYABLE_STATES = {
  PROPOSED: false,
  APPROVED: true,
  APPLIED: false,
  REVERTED: false,
  REJECTED: false,
  SUPERSEDED: false,
  BLOCKED: false,
} as const satisfies Record<SuiteChangeState, boolean>;

/**
 * HOW TO PUT IT BACK. A refactor nobody can revert will not be approved, so the
 * record is not optional — see `suiteChangeProposalSchema` in schemas.ts, where
 * a proposal missing an entry for a path it touches is refused.
 *
 * `priorContent` is the BYTES, not a hash, and that is the whole point: a hash
 * proves a revert was possible and does not perform one. For a path the
 * proposal CREATES there are no prior bytes, so the entry is
 * `{ existed: false }` — and reverting it means deleting a file QAAI created,
 * which is the only deletion anything in this product may do, because the
 * record says QAAI created it.
 */
export type RevertEntry =
  | { readonly path: string; readonly existed: false }
  | {
      readonly path: string;
      readonly existed: true;
      readonly priorContent: string;
      readonly priorHash: string;
      /** What the ledger said before, so ownership is restored and not re-inferred. */
      readonly priorOwnership: ArtifactOwnership | null;
    };

export interface RevertRecord {
  readonly entries: readonly RevertEntry[];
  /**
   * Every path this proposal touches, independently of `entries`, so a missing
   * entry is detectable rather than invisible. The schema compares the two.
   */
  readonly paths: readonly string[];
}

/** A change to tests that already exist, held for a human. */
export interface SuiteChangeProposal {
  readonly kind: SuiteChangeKind;
  readonly state: SuiteChangeState;
  readonly title: string;
  /** Why, in QAAI's own words, with the finding it acts on named. */
  readonly rationale: string;
  readonly before: ArtifactSet;
  readonly after: ArtifactSet;
  /** Tests and files that import something this proposal changes. */
  readonly dependentTestIds: readonly string[];
  readonly dependentPaths: readonly string[];
  readonly revert: RevertRecord;
}

/**
 * Why a proposal may not be stored or applied. Closed, and every member is a
 * refusal rule 5 of this round asks for.
 */
export const PROPOSAL_PROBLEMS = [
  /** A path in `after` has no entry in the revert record. */
  'REVERT_INCOMPLETE',
  /** An entry claims prior bytes for a path the proposal creates, or the reverse. */
  'REVERT_INCOHERENT',
  /** The revert record names a path the proposal does not touch. */
  'REVERT_OVERREACH',
  /** `after` is identical to `before`: a proposal that proposes nothing. */
  'NO_CHANGE',
  /** A dependent is affected and is not listed, so a reviewer cannot see the blast radius. */
  'DEPENDENT_UNDISCLOSED',
  /** The `after` set itself is unapplyable. See {@link artifactSetProblems}. */
  'SET_REFUSED',
] as const;
export type ProposalProblemKind = (typeof PROPOSAL_PROBLEMS)[number];

export interface ProposalProblem {
  readonly kind: ProposalProblemKind;
  readonly path: string;
  readonly why: string;
}

/**
 * Everything wrong with a proposal, independently of the artifact-set checks.
 *
 * Deliberately NOT a re-implementation of {@link artifactSetProblems}: the
 * caller runs both, and `SET_REFUSED` exists so a proposal carrying an
 * unapplyable set is refused here too rather than relying on every caller to
 * remember the second call.
 */
export function proposalProblems(proposal: SuiteChangeProposal): readonly ProposalProblem[] {
  const problems: ProposalProblem[] = [];
  const add = (kind: ProposalProblemKind, path: string, why: string): void => {
    problems.push({ kind, path, why });
  };

  const touched = new Set(proposal.after.artifacts.map((artifact) => artifact.path));
  for (const artifact of proposal.before.artifacts) touched.add(artifact.path);

  const declared = new Set(proposal.revert.paths);
  const entries = new Map(proposal.revert.entries.map((entry) => [entry.path, entry]));

  for (const path of touched) {
    if (!declared.has(path) || !entries.has(path)) {
      add(
        'REVERT_INCOMPLETE',
        path,
        'This proposal changes this file and the revert record does not say how to put it back.',
      );
    }
  }
  for (const path of declared) {
    if (!touched.has(path)) {
      add('REVERT_OVERREACH', path, 'The revert record names a file this proposal does not change.');
    }
  }

  const beforePaths = new Set(proposal.before.artifacts.map((artifact) => artifact.path));
  for (const entry of proposal.revert.entries) {
    const existedBefore = beforePaths.has(entry.path);
    if (entry.existed && !existedBefore) {
      add(
        'REVERT_INCOHERENT',
        entry.path,
        'The revert record carries prior bytes for a file the proposal creates.',
      );
    }
    if (!entry.existed && existedBefore) {
      add(
        'REVERT_INCOHERENT',
        entry.path,
        'The revert record says this file did not exist, and the before-set carries it.',
      );
    }
  }

  const sameContent =
    proposal.before.artifacts.length === proposal.after.artifacts.length &&
    proposal.before.artifacts.every((artifact, index) => {
      const next = proposal.after.artifacts[index];
      return next !== undefined && next.path === artifact.path && next.content === artifact.content;
    });
  if (sameContent) {
    add('NO_CHANGE', '', 'The after-set is byte-identical to the before-set.');
  }

  return problems;
}

/**
 * The dependents a proposal must disclose, computed from the ledger.
 *
 * Returned rather than asserted, so the producer fills the field from this and
 * the schema can then check that it did. Two steps, because a producer that
 * computes its own blast radius and a validator that trusts it is one step.
 */
export function dependentsAffected(
  proposal: SuiteChangeProposal,
  ledger: readonly ArtifactLedgerEntry[],
): readonly string[] {
  const touched = proposal.after.artifacts
    .filter((artifact) => SHARED_ROLES[artifact.role])
    .map((artifact) => artifact.path);
  const paths = new Set<string>();
  for (const path of touched) {
    for (const dependent of dependentsOf(ledger, path)) paths.add(dependent.path);
  }
  for (const artifact of proposal.after.artifacts) paths.delete(artifact.path);
  return [...paths].sort();
}
