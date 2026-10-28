/**
 * THE REFACTOR ENGINE — the only way a QAAI-managed suite gets SMALLER.
 *
 * `suite-health.ts` has named duplicate clusters and weak assertions since it
 * was written and nothing could act on them, so the only direction a suite
 * could move was bigger. Three operations change that, and each one has a
 * specific way of being quietly wrong:
 *
 *   EXTRACT A FIXTURE. The extracted setup must be semantically identical for
 *   every dependent. A test that relied on a subtle difference in its own setup
 *   now silently tests something else — a green suite over a changed question.
 *   So equivalence is PROVEN before a dependent is included, and a dependent
 *   whose equivalence cannot be proven is EXCLUDED with the reason named. There
 *   is no "probably the same" path.
 *
 *   MERGE NEAR-DUPLICATES. Two tests that look alike may assert different
 *   things, and merging them DELETES COVERAGE while the number stays flat —
 *   the exact dishonesty this product exists to prevent. So the union of the
 *   assertions is preserved BY CONSTRUCTION (neither body is edited, neither is
 *   de-duplicated) and then CHECKED anyway, and a merge that drops one
 *   assertion is refused rather than noted.
 *
 *   STRENGTHEN ASSERTIONS. A stronger assertion can go red because it found a
 *   bug or because QAAI guessed the intent wrong, and those are opposite
 *   outcomes. So a strengthening is RUN before it is applied and the result is
 *   reported: "this stronger assertion passes" and "this stronger assertion
 *   fails" are both useful and are DIFFERENT PROPOSALS. A strengthening nobody
 *   ran is {@link REFACTOR_PROBLEMS}' `STRENGTHENING_UNVERIFIED`, which blocks.
 *
 * ── THE COVERAGE INVARIANT, which is what makes this feature safe ───────────
 *
 * A refactor engine without it is a coverage-deleting machine with a nice name.
 * {@link coverageSurface} computes the covered surface before and after, and a
 * refactor that REDUCES it is refused and reported, full stop. Two properties
 * of the invariant are worth stating because both are easy to get wrong:
 *
 *   It is SET CONTAINMENT, not a count. A refactor that swaps one assertion for
 *   another keeps the count and loses a guarantee, so the test is "every token
 *   present before is present after", never "at least as many as before".
 *
 *   UNREADABLE IS NOT UNCHANGED. If either side of a comparison contains a test
 *   `extractBehavior` could not read end to end, the invariant is UNMEASURABLE
 *   and blocks — it does not pass. That is admission.ts's UNAVAILABLE-is-not-
 *   PASS rule applied to coverage, and without it every refactor of a file with
 *   an unterminated string would report a clean delta over tokens nobody read.
 *
 * ── WHY THE SURFACE IS COMPUTED OVER THE WHOLE ARTIFACT SET ─────────────────
 *
 * This is the one design decision a reviewer should push on. Extracting setup
 * MOVES `page.goto('/checkout')` out of the spec and into a helper, so a
 * surface computed from the spec file alone reports `nav:/checkout` as LOST on
 * every single legitimate extraction — the invariant would refuse exactly the
 * work it exists to protect. The covered surface of a test is therefore
 * computed over all the text that test's run now spans: the helpers it imports,
 * concatenated ahead of the spec, in {@link ARTIFACT_ROLE_RANK} order.
 *
 * Concatenation is sound here precisely because `extractBehavior` is a scanner
 * over text and not a parser — the same property suite-health.ts relies on to
 * survive files that do not parse. The order is load-bearing and not cosmetic:
 * `locatorBindings` is built over the whole source before any token is
 * extracted, so a `const total = page.getByTestId('total')` that moved into the
 * helper still resolves `total.click()` in the spec to `act:click:testid=total`.
 * Helper-last would still work today and would break the moment that function
 * reads top to bottom, so helper-first is pinned by a test.
 *
 * ── ONE ASSERTION VOCABULARY, NOT A THIRD ───────────────────────────────────
 *
 * suite-health.ts already has two vocabularies for "what is an assertion"
 * (`ASSERTION_KEY` for duplicate detection, the regex in `specAssertions` for
 * findings) and the comment above the second one records what their
 * disagreement cost. This module adds NEITHER. Where it needs to know where
 * setup ends it reads `behavior.assertionSites[0].line` — suite-health's own
 * answer — rather than matching `expect(` again, so a change to that lexicon
 * reaches this file for free and cannot drift from it.
 *
 * ── WHAT IS UNTRUSTED HERE, AND WHY IT MATTERS MORE THAN USUAL ──────────────
 *
 * Test names, feature names, file paths and source lines all come out of the
 * customer's repository, and this module's output is CODE WRITTEN BACK INTO
 * THAT REPOSITORY. A test named `') ; drop(); test('` interpolated into a
 * generated string literal is a write primitive. So every untrusted span is
 * escaped at the point of interpolation ({@link codeString},
 * {@link codeComment}, {@link safeIdentifier}), bounded, and NEVER allowed to
 * decide a file path: the one path this module invents is derived from a spec
 * path the artifact-set guards have already refused if it escapes, plus a fixed
 * basename, and is re-checked by {@link pathIsSafe} before it is used.
 *
 * Everything here is deterministic and runs with no model and no API key. The
 * ONE capability that cannot be deterministic is running a strengthened
 * assertion, which is why {@link AssertionVerifier} is injected and why its
 * absence produces a blocked proposal rather than a quiet pass.
 */

import {
  ARTIFACT_ROLE_RANK,
  APPLYABLE_STATES,
  MAX_ARTIFACTS_PER_SET,
  MAX_ARTIFACT_PATH_CHARS,
  dependentsAffected,
  dispositionFor,
  orderedForApply,
  resolveOwnership,
  type ArtifactLedgerEntry,
  type ArtifactSet,
  type ContentDigest,
  type GeneratedArtifact,
  type RevertEntry,
  type SuiteChangeKind,
  type SuiteChangeProposal,
  /*
   * REACHED BY RELATIVE PATH, AND IT MUST NOT STAY THAT WAY.
   *
   * `artifact-set.ts` is not in packages/shared/src/index.ts — the keystone
   * that added it does not own that barrel either — so `@qaai/shared` does not
   * provide `ARTIFACT_ROLES` today; the probe fails at run time, not just at
   * `tsc`. This is the same bind `apps/api/src/routes/suite-health.ts` records
   * above its own relative import, and the same resolution: use the path that
   * works, say so, and name the one-line fix.
   *
   * THE FIX, which belongs in this round's needsFromOtherFiles and not here:
   * add `export * from './artifact-set';` to packages/shared/src/index.ts and
   * change this specifier to '@qaai/shared'. A relative import across a
   * workspace boundary compiles and then bypasses the package's own entry
   * point, which is exactly what repo.ts's comment establishes as the thing to
   * avoid — so this line is a dated loan, not a style.
   */
} from '@qaai/shared';
import type { DialectId } from '@qaai/shared';
import {
  extractBehavior,
  stripComments,
  type SuiteHealthTestInput,
  type TestBehavior,
} from './suite-health.js';

// ─── Caps, each one disclosed where it bites ────────────────────────────────

/**
 * Dependents one fixture extraction may rewrite.
 *
 * NOT a number somebody liked: `artifactSetSchema` caps a set at
 * {@link MAX_ARTIFACTS_PER_SET}, the `after` set holds one rewritten spec per
 * dependent PLUS the extracted helper, so eleven dependents is the largest
 * proposal that can be stored at all. A twelfth would make the proposal
 * unparseable, which reads to a caller as a mysterious validation error rather
 * than as a cap. Dependents past this are reported as a {@link CapHit} with a
 * count and a reason and are left untouched, so their coverage is unaffected.
 */
export const MAX_FIXTURE_DEPENDENTS = MAX_ARTIFACTS_PER_SET - 1;

/**
 * Dependents below which an extraction is not worth proposing. TWO.
 *
 * A "shared" fixture with one user is not shared — it is a rename, and it costs
 * a reviewer the same hour for none of the benefit. One is the number that
 * arrives after exclusions eat a cluster, which is precisely when the proposal
 * should disappear rather than shrink.
 */
export const MIN_FIXTURE_DEPENDENTS = 2;

/**
 * Lines of setup one extraction may hoist.
 *
 * Past this the "setup" is the test. Sized well under the spec files this
 * product generates (the ecosystem prompts ask for a handful of setup lines)
 * and small enough that a reviewer reads the whole helper in the diff.
 */
export const MAX_SETUP_LINES = 60;

/** A proposal title is a label. The schema's own ceiling is 200. */
const MAX_TITLE_CHARS = 200;

/** A rationale is prose a human reads in a review panel. The schema's ceiling is 2000. */
const MAX_RATIONALE_CHARS = 2_000;

/**
 * An untrusted name quoted into generated code or into a rationale.
 *
 * Bounded at the point of interpolation rather than at the point of reading,
 * because the thing that overflows is the OUTPUT: a 4,000-character test name
 * is legal in every runner this product supports and would push a merged test's
 * title past the schema's ceiling, where the proposal stops being storable.
 */
const MAX_QUOTED_NAME_CHARS = 120;

/** A source line quoted back as evidence. Evidence, not a code listing. */
const MAX_QUOTED_LINE_CHARS = 200;

// ─── The coverage invariant ─────────────────────────────────────────────────

/**
 * The behaviour facets {@link TestBehavior} carries, and whether each one
 * counts as COVERAGE.
 *
 * Compiler-enforced over the four facets, so a fifth cannot be added to
 * suite-health.ts without a decision here about whether losing one of its
 * tokens is a coverage regression.
 *
 * `data` is deliberately FALSE, and it is the only false one. A `data:` token
 * is a literal that got typed in — `data:fill:alice@example.com`. Extracting
 * that literal into a dataset file is operation three of this register and
 * changes the token while removing nothing any test checks, so counting data as
 * coverage would refuse exactly the work the engine exists to do. suite-health
 * already scores the facet at 0.05 against assertions' 0.45 for the same
 * reason: it is weak evidence about what a test guarantees.
 */
export const FACET_IN_INVARIANT = {
  routes: true,
  actions: true,
  assertions: true,
  data: false,
} as const satisfies Record<'routes' | 'actions' | 'assertions' | 'data', boolean>;

/** The facets the invariant is computed over, derived so the two cannot disagree. */
export const INVARIANT_FACETS = (
  Object.keys(FACET_IN_INVARIANT) as Array<keyof typeof FACET_IN_INVARIANT>
).filter((facet) => FACET_IN_INVARIANT[facet]);

/** One test whose behaviour could not be read end to end, with suite-health's reason. */
export interface UnreadableTest {
  readonly testId: string;
  readonly filePath: string;
  readonly reason: string;
}

/**
 * The covered surface of a group of tests.
 *
 * `unreadable` is part of the ANSWER rather than a log line: a surface computed
 * over tests we could not read is not a surface, and the caller has to be able
 * to tell the difference without reading a comment.
 */
export interface CoverageSurface {
  readonly tokens: readonly string[];
  readonly unreadable: readonly UnreadableTest[];
}

/**
 * What a refactor did to the covered surface.
 *
 * UNMEASURABLE is a THIRD state and not a flavour of MEASURED, so no caller can
 * read `lost.length === 0` off a comparison that never happened. That is the
 * null-that-became-zero this product cannot afford, in the one place where it
 * would license a coverage-deleting write.
 */
export type CoverageDelta =
  | {
      readonly state: 'UNMEASURABLE';
      readonly why: string;
      readonly unreadable: readonly UnreadableTest[];
    }
  | {
      readonly state: 'MEASURED';
      readonly lost: readonly string[];
      readonly gained: readonly string[];
      readonly kept: number;
    };

/**
 * One group of tests' covered surface, as the union of their behaviour tokens.
 *
 * Takes the tests rather than the behaviours so that the ONE extractor in this
 * codebase is the only thing that decides what a token is. A second tokeniser
 * here would be the `ASSERTION_KEY`-versus-`specAssertions` defect a third
 * time.
 */
export function coverageSurface(tests: readonly SuiteHealthTestInput[]): CoverageSurface {
  const tokens = new Set<string>();
  const unreadable: UnreadableTest[] = [];

  for (const test of tests) {
    let behavior: TestBehavior;
    try {
      behavior = extractBehavior(test);
    } catch (error) {
      /*
       * A throw here is UNREADABLE and not EMPTY. suite-health lists such a
       * test in `unanalyzed`; this module has to go further and refuse, because
       * a report nobody acts on and a write are different stakes.
       */
      unreadable.push({
        testId: test.id,
        filePath: test.filePath,
        reason: `behaviour extraction threw: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (behavior.incomplete) {
      unreadable.push({
        testId: test.id,
        filePath: test.filePath,
        reason: behavior.incompleteReason ?? 'analysis was truncated',
      });
      continue;
    }

    for (const facet of INVARIANT_FACETS) {
      for (const token of behavior[facet]) tokens.add(token);
    }
  }

  return { tokens: [...tokens].sort(), unreadable };
}

/**
 * THE INVARIANT. Every token covered before must still be covered after.
 *
 * Reported in both directions: `gained` is not a pass condition and cannot
 * offset a loss, but a reviewer reading "this merge kept 14 and gained 0" is
 * being told something a bare verdict does not say.
 */
export function coverageDelta(before: CoverageSurface, after: CoverageSurface): CoverageDelta {
  const unreadable = [...before.unreadable, ...after.unreadable];
  if (unreadable.length > 0) {
    return {
      state: 'UNMEASURABLE',
      why:
        `${unreadable.length} test(s) could not be read end to end, so the covered surface ` +
        'before and after cannot be compared. An unmeasured invariant is not a satisfied one.',
      unreadable,
    };
  }

  const afterSet = new Set(after.tokens);
  const beforeSet = new Set(before.tokens);
  const lost = before.tokens.filter((token) => !afterSet.has(token));
  return {
    state: 'MEASURED',
    lost,
    gained: after.tokens.filter((token) => !beforeSet.has(token)),
    kept: before.tokens.length - lost.length,
  };
}

/** Fail-closed: UNMEASURABLE and LOST are both "do not apply this". */
export function coverageRegressed(delta: CoverageDelta): boolean {
  return delta.state === 'UNMEASURABLE' || delta.lost.length > 0;
}

// ─── Refusals, exclusions and caps ──────────────────────────────────────────

/**
 * Why a refactor may not be proposed. Closed, so a new reason cannot arrive as
 * a silent pass.
 */
export const REFACTOR_PROBLEMS = [
  /** A token covered before is not covered after. THE refusal this module exists for. */
  'COVERAGE_LOST',
  /** A test on one side could not be read, so the invariant never ran. */
  'COVERAGE_UNMEASURABLE',
  /** A merge would not make an assertion one of its members made. */
  'ASSERTION_DROPPED',
  /** Fewer than {@link MIN_FIXTURE_DEPENDENTS} survived the equivalence proof. */
  'NOT_ENOUGH_DEPENDENTS',
  /** Comment stripping ended inside a string or comment: the structure is a guess. */
  'SOURCE_UNREADABLE',
  /** A named test block is not in the file the row points at. */
  'TEST_BLOCK_NOT_FOUND',
  /** Two rows claim one path and disagree about its bytes. One of them is stale. */
  'FILES_DISAGREE',
  /** A merge across test types. Two different kinds of run are not one test. */
  'MIXED_TEST_TYPES',
  /** A body returns early, so appending a second body would not run it. */
  'MERGE_EARLY_RETURN',
  /** A body ends or inverts the run some other way. See {@link ABORTING_BODY_FORMS}. */
  'MERGE_BODY_ABORTS',
  /** The test callbacks' parameter lists cannot be unioned without guessing. */
  'MERGE_PARAMS_UNREADABLE',
  /** Not a dialect whose structure this module reads. See {@link DIALECT_IS_JS}. */
  'DIALECT_UNSUPPORTED',
  /** A computed artifact path is not repo-relative. Refused before it reaches a tree. */
  'PATH_UNSAFE',
  /** A file is already at the path this proposal would create. See {@link RefactorContext.knownPaths}. */
  'PATH_OCCUPIED',
  /** This operation creates a file and nobody said what is already in the tree. */
  'TREE_UNKNOWN',
  /** A strengthening nobody ran. Never applied unverified. */
  'STRENGTHENING_UNVERIFIED',
  /** A strengthening that was run and went red. Reported, NOT suppressed. */
  'STRENGTHENING_FAILED',
  /** No refactor was available. Not an error, and not a proposal either. */
  'NOTHING_TO_DO',
] as const;
export type RefactorProblemKind = (typeof REFACTOR_PROBLEMS)[number];

/**
 * Does this problem stop a proposal existing?
 *
 * Compiler-enforced, and `STRENGTHENING_FAILED` is the ONLY `false`. A stronger
 * assertion that goes red is either a real defect in the application or a wrong
 * guess about intent, and a human is the only one who can tell those apart — so
 * suppressing the proposal would be a failure suppressed without being counted.
 * It becomes a proposal that says, in its own title, that it fails.
 */
export const PROBLEM_BLOCKS_REFACTOR = {
  COVERAGE_LOST: true,
  COVERAGE_UNMEASURABLE: true,
  ASSERTION_DROPPED: true,
  NOT_ENOUGH_DEPENDENTS: true,
  SOURCE_UNREADABLE: true,
  TEST_BLOCK_NOT_FOUND: true,
  FILES_DISAGREE: true,
  MIXED_TEST_TYPES: true,
  MERGE_EARLY_RETURN: true,
  MERGE_BODY_ABORTS: true,
  MERGE_PARAMS_UNREADABLE: true,
  DIALECT_UNSUPPORTED: true,
  PATH_UNSAFE: true,
  PATH_OCCUPIED: true,
  TREE_UNKNOWN: true,
  STRENGTHENING_UNVERIFIED: true,
  STRENGTHENING_FAILED: false,
  NOTHING_TO_DO: true,
} as const satisfies Record<RefactorProblemKind, boolean>;

export interface RefactorProblem {
  readonly kind: RefactorProblemKind;
  /** The file a human can open, or '' when the problem is about the set. */
  readonly path: string;
  readonly why: string;
}

/**
 * Why one candidate was LEFT OUT while the refactor went ahead without it.
 *
 * Distinct from a problem on purpose. "I could not prove this dependent's setup
 * is the same, so I did not touch it" is the correct outcome and must not
 * refuse the other four — but it must also never be invisible, because a
 * silently-excluded dependent is a copy-pasted setup block a reviewer is told
 * was cleaned up.
 */
export const EXCLUSION_REASONS = [
  /** The normalised setup text differs. The one thing that could make it unsafe. */
  'SETUP_NOT_IDENTICAL',
  /** No assertion in the test, so where setup ENDS is not knowable. */
  'NO_ASSERTION_BOUNDARY',
  /** Nothing before the first assertion. There is no setup to hoist. */
  'NO_SETUP_BLOCK',
  /** A binding form this module will not guess at: array destructuring, `using`, a bare pattern. */
  'BINDING_UNREADABLE',
  /** The block reads a name declared at file scope, which a helper file would not have. */
  'FREE_IDENTIFIER',
  /** `return` or `throw` inside the block. Hoisting it moves control flow. */
  'SETUP_CHANGES_CONTROL_FLOW',
  /** The callback's parameter list is not a bare identifier or a flat destructuring. */
  'PARAMS_UNREADABLE',
  /** Not in the same directory as the rest, so one import specifier cannot serve them all. */
  'DIFFERENT_DIRECTORY',
  /** The named test block is not in this file, or appears more than once. */
  'BLOCK_NOT_LOCATABLE',
  /** suite-health could not read this test end to end. */
  'BEHAVIOUR_UNREADABLE',
  /** Past {@link MAX_FIXTURE_DEPENDENTS}. The cap, as an exclusion with a name. */
  'OVER_DEPENDENT_CAP',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface RefactorExclusion {
  readonly reason: ExclusionReason;
  readonly testId: string;
  readonly path: string;
  /** One sentence naming the specific thing that could not be proven. */
  readonly why: string;
}

/**
 * A budget that BIT, as a count and a reason.
 *
 * Rule twelve of this round, as a type: a cap applied without being disclosed
 * is a lie, and the shape that stops it is one where the count has nowhere to
 * hide.
 */
export interface CapHit {
  readonly cap: string;
  readonly limit: number;
  readonly dropped: number;
  readonly why: string;
}

/**
 * The assertion sets before and after, which the register asks a merge to state
 * explicitly — and which every operation states, because the question "did this
 * change what the suite checks" has the same answer shape for all three.
 */
export interface AssertionAccounting {
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** Present before, absent after. Non-empty means ASSERTION_DROPPED. */
  readonly dropped: readonly string[];
}

// ─── Verification of a strengthened assertion ───────────────────────────────

/**
 * What happened when a stronger assertion was actually run.
 *
 * UNAVAILABLE is a real member and not an error: no runner wired in, no
 * checkout, a trial that timed out. It is the state the deterministic,
 * key-free, runner-free mode of this module produces, and it BLOCKS — which is
 * the difference between "we did not check" and "it passed".
 */
export type AssertionTrialState = 'PASSED' | 'FAILED' | 'UNAVAILABLE';

export interface AssertionTrial {
  readonly state: AssertionTrialState;
  readonly why: string;
  /** The runner's own output, bounded. Evidence a reviewer can read. */
  readonly detail: readonly string[];
}

/**
 * The capability this module cannot have: running a test.
 *
 * Injected as a narrow interface for the reason rule 8 of this round gives —
 * a module that reaches for a process cannot be tested, and 629 lines of
 * crawler.ts proved it. The worker supplies the execution; this file supplies
 * the question.
 */
export type AssertionVerifier = (args: {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly testId: string;
}) => Promise<AssertionTrial>;

// ─── Inputs and the outcome ─────────────────────────────────────────────────

/**
 * Everything this module needs from the world, injected.
 *
 * `ledger: null` is "we were not handed one" and resolves every path to
 * UNRECORDED, which is the fail-closed direction: a proposal over files QAAI
 * has no record of is a proposal over a human's files, which is exactly what a
 * refactor is.
 */
export interface RefactorContext {
  /** Content hashing, injected for the reason artifact-set.ts records about `node:crypto`. */
  readonly digest: ContentDigest;
  readonly ledger: readonly ArtifactLedgerEntry[] | null;
  /**
   * EVERY repo-relative path that already exists in the working tree, or null
   * when nobody looked.
   *
   * THIS FIELD EXISTS BECAUSE OF A HOLE NEITHER THE LEDGER NOR
   * `artifactSetProblems` CLOSES, and it is worth stating precisely. An
   * extraction INVENTS a path for its helper. Its revert entry is then
   * `{ existed: false }` — a CLAIM that nothing was there — and reverting such
   * an entry DELETES the file, which artifact-set.ts calls "the only deletion
   * anything in this product may do, because the record says QAAI created it".
   * If a human's file was already at that path, the claim is false, the apply
   * overwrites it and the revert deletes it. `artifactSetProblems` cannot catch
   * that: it skips the shared-surface check for a NEW artifact
   * (`if (artifact.disposition === 'NEW' … ) continue`), so prior bytes at a
   * NEW path are never read.
   *
   * So the fact has to be supplied, and NULL IS NOT EMPTY. An operation that
   * creates a file refuses with TREE_UNKNOWN when this is null, rather than
   * assuming a path is free because nobody said otherwise. Merging and
   * strengthening create nothing and are unaffected — they only ever rewrite a
   * path a test row already points at.
   *
   * Computing it needs no model: it is a directory listing.
   */
  readonly knownPaths: readonly string[] | null;
}

/** A test and the file it lives in. `test.code` is the file's bytes at `test.filePath`. */
export interface RefactorSubject {
  readonly test: SuiteHealthTestInput;
}

export interface FixtureExtractionInput {
  /** The tests whose setup looks shared. Order decides which block is canonical. */
  readonly candidates: readonly RefactorSubject[];
  /** The suite-health finding this acts on, quoted into the rationale. */
  readonly finding: string;
}

export interface MergeInput {
  /** Exactly the cluster members to merge. Two or more, all in one file. */
  readonly members: readonly RefactorSubject[];
  readonly finding: string;
}

export interface StrengthenInput {
  readonly subject: RefactorSubject;
  readonly finding: string;
}

/**
 * What an operation produced.
 *
 * `proposal === null` ⟺ at least one problem blocks. That biconditional is
 * pinned by a test over all three operations, because the alternative is a
 * caller that reads a non-null proposal as "safe" while a blocking problem sits
 * beside it in a field nobody destructured.
 */
export interface RefactorOutcome {
  readonly kind: SuiteChangeKind;
  readonly proposal: SuiteChangeProposal | null;
  readonly problems: readonly RefactorProblem[];
  readonly excluded: readonly RefactorExclusion[];
  readonly coverage: CoverageDelta;
  readonly assertions: AssertionAccounting;
  /** Strengthening only. Null for the other two kinds, which run nothing. */
  readonly trial: AssertionTrial | null;
  readonly caps: readonly CapHit[];
  readonly why: string;
}

/** True when something in `problems` stops the proposal existing. */
export function refactorBlocked(outcome: RefactorOutcome): boolean {
  return outcome.problems.some((problem) => PROBLEM_BLOCKS_REFACTOR[problem.kind]);
}

// ─── Untrusted text, at the point of interpolation ──────────────────────────

/**
 * A customer-supplied string, as a JavaScript string LITERAL.
 *
 * `JSON.stringify` and not quote-doubling: it escapes the quote, the backslash
 * and the newline in one pass, which is the set that lets a test name close the
 * literal it is sitting in. U+2028 and U+2029 are then escaped by hand because
 * they are legal inside a JSON string and are LINE TERMINATORS in JavaScript
 * source — a name containing one closes the statement, and it is the single
 * hole a `JSON.stringify`-based escape leaves.
 */
export function codeString(raw: string): string {
  const bounded = raw.slice(0, MAX_QUOTED_NAME_CHARS);
  return JSON.stringify(bounded)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A customer-supplied string as a single-line `//` COMMENT body.
 *
 * A comment is not a safe place for untrusted text by default: a newline ends
 * the comment and everything after it is code, and `*&#47;` ends a block comment
 * the same way. Both are removed rather than escaped, because a comment has no
 * escape syntax to use.
 */
export function codeComment(raw: string): string {
  return raw
    .slice(0, MAX_QUOTED_NAME_CHARS)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\*\//g, '* /')
    .trim();
}

/**
 * A customer-supplied string as a JavaScript IDENTIFIER.
 *
 * Allow-list, never a deny-list: anything outside `[A-Za-z0-9_]` is dropped, a
 * leading digit is prefixed, and an empty result falls back to a fixed name —
 * so there is no input that produces an identifier position containing anything
 * else. A deny-list here would have to enumerate every character that can end
 * an identifier in a language this module writes for.
 */
export function safeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  if (cleaned === '') return fallback;
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Is this a repo-relative path we are willing to write?
 *
 * The same shape `artifactPath` in schemas.ts refuses, re-checked HERE because
 * this module COMPUTES a path rather than receiving one. A validator at the
 * boundary catches a path an attacker sent; it does not catch a path we built
 * by joining a directory we read out of a row, and the second is the one with
 * our name on it.
 */
export function pathIsSafe(path: string): boolean {
  if (path === '' || path.length > MAX_ARTIFACT_PATH_CHARS) return false;
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  /*
   * A NUL and a newline are checked by `includes` rather than by a character
   * class, because a control character in a regex literal is an eslint error
   * (`no-control-regex`) and suppressing a lint rule to keep a one-line guard
   * is the wrong trade when `includes` says the same thing.
   */
  return !path.includes('\n') && !path.includes('\r') && !path.includes('\u0000');
}

/** A source line as evidence, whitespace collapsed and bounded. */
function quoted(line: string): string {
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_QUOTED_LINE_CHARS
    ? `${collapsed.slice(0, MAX_QUOTED_LINE_CHARS)}…`
    : collapsed;
}

/** Bound a rationale at the schema's ceiling, DISCLOSING the truncation. */
function boundedRationale(text: string): string {
  if (text.length <= MAX_RATIONALE_CHARS) return text;
  const note = ' […rationale truncated]';
  return `${text.slice(0, MAX_RATIONALE_CHARS - note.length)}${note}`;
}

/** Bound a title at the schema's ceiling. Titles here are built from fixed prose. */
function boundedTitle(text: string): string {
  return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

// ─── Reading JavaScript structure without a parser ──────────────────────────

/**
 * IS THIS DIALECT ONE WHOSE STRUCTURE THIS MODULE READS.
 *
 * Everything below — the test-block scanner, the binding forms, the callback
 * parameter list, the braced block a merge wraps a body in — is JavaScript.
 * Python's `def`, Go's explicit error returns and Robot's keyword table are
 * different languages, not different spellings, and suite-health.ts records
 * what running a JavaScript understanding over a `.py` file cost: a correct
 * pytest test reported as NO_ASSERTIONS at HIGH severity. A refactor makes that
 * mistake by WRITING, so the answer for anything else is DIALECT_UNSUPPORTED
 * and no proposal at all.
 *
 * A compiler-enforced record over every {@link DialectId} and NOT a set of
 * strings, which is the shape this was written as first and which was WRONG —
 * it held `'playwright-ts'`, a spelling no dialect has, so every operation
 * refused every file and the tests would have agreed with it. A record cannot
 * contain a name that is not a dialect, and a seventeenth dialect cannot be
 * added to dialect.ts without a decision here. The run-time half — that the
 * record's keys are exactly `DIALECT_IDS` — is in refactor.test.ts, because one
 * of the two without the other passes while they disagree.
 */
export const DIALECT_IS_JS = {
  JS_EXPECT: true,
  JS_CHAI: true,
  PY_ASSERT: false,
  PY_UNITTEST: false,
  ROBOT: false,
  JVM: false,
  DOTNET: false,
  RUBY_RSPEC: false,
  RUBY_MINITEST: false,
  GO_TESTING: false,
  PHP_PHPUNIT: false,
  PHP_CODECEPT: false,
  GHERKIN: false,
  RUST: false,
  SWIFT: false,
  ELIXIR: false,
} as const satisfies Record<DialectId, boolean>;

/** Null (no lexicon at all) is NOT JavaScript. Absence of evidence is not evidence. */
function readsAsJavaScript(dialect: DialectId | null): boolean {
  return dialect !== null && DIALECT_IS_JS[dialect];
}

/**
 * BODY-LEVEL FORMS THAT END OR INVERT A RUN, beyond `return`.
 *
 * A merge appends one body after another, so any of these in a member's body
 * means the bodies after it DO NOT RUN — the merge deletes exactly the coverage
 * {@link coverageDelta} exists to protect. And the invariant CANNOT SEE IT: the
 * tokens are all still present in the merged text, because `extractBehavior` is
 * a scanner and not an interpreter. So this has to be a refusal over the TEXT;
 * it is not something the coverage comparison can be asked to catch.
 *
 * Found by adversarial verification of this round with
 * `test.skip(browserName === 'firefox')` — the ordinary Playwright idiom for a
 * platform-gated near-duplicate, which is exactly the shape a duplicate cluster
 * is made of. Before this, such a merge was PROPOSED with a clean delta, and its
 * rationale told the reviewer "every line both tests ran still runs".
 *
 * `test.fail()` is listed for a different reason and it is the worst of them: it
 * does not end the run, it inverts the test's EXPECTED OUTCOME, so the other
 * member's assertions passing turns the merged test into an error.
 *
 * The scan runs over a comment-stripped, string-blanked body, so a mention of
 * one of these in prose or in a locator string is not a refusal. A nested arrow
 * function that throws is one, which is the same conservative over-refusal
 * `MERGE_EARLY_RETURN` already accepts for `return` — and `setupBlockOf`
 * refuses `return` and `throw` TOGETHER, which is the inconsistency that gave
 * this gap away.
 */
const ABORTING_BODY_FORMS = [
  {
    pattern: /\bthrow\b/,
    why: 'throws from its body, so a body appended after it would not run',
  },
  {
    pattern: /\btest\s*\.\s*skip\s*\(/,
    why:
      'calls test.skip() from inside its body, which ends the run at that line — so a body ' +
      'appended after it would not run, on exactly the platforms or conditions the skip names',
  },
  {
    pattern: /\btest\s*\.\s*fixme\s*\(/,
    why: 'calls test.fixme() from inside its body, which ends the run at that line',
  },
  {
    pattern: /\btest\s*\.\s*fail\s*\(/,
    why:
      'calls test.fail(), which INVERTS the expected outcome of the whole test — so the other ' +
      "member's assertions passing would make the merged test an error",
  },
  {
    pattern: /\bthis\s*\.\s*skip\s*\(/,
    why: "calls this.skip(), Mocha's body-level skip, which ends the run at that line",
  },
] as const;

/** Reserved words and globals a hoisted block may reference without owning. */
const AMBIENT_NAMES = new Set([
  'async', 'await', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in',
  'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'typeof', 'instanceof',
  'delete', 'void', 'try', 'catch', 'finally', 'throw', 'yield', 'true', 'false', 'null',
  'undefined', 'class', 'extends', 'super', 'static', 'get', 'set',
  'Promise', 'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Map',
  'Set', 'RegExp', 'Error', 'console', 'process', 'globalThis', 'parseInt', 'parseFloat',
  'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Buffer', 'URL', 'URLSearchParams',
]);

/**
 * The index of the delimiter matching the one at `openIdx`, or -1.
 *
 * STRING-AWARE, which is what makes it safe on real specs: a `}` inside
 * `getByText('}')` or a `)` inside a regex literal would otherwise close the
 * wrong thing and the whole range would be off. Callers hand it
 * comment-stripped text (string CONTENTS survive stripping, so the quote
 * tracking is still needed) and slice the ORIGINAL at the returned offsets,
 * which is the property `stripComments` is built to provide.
 *
 * suite-health.ts has `matchParen`/`matchBrace` and both are module-private, so
 * this is a near-duplicate and should not stay one; the needsFromOtherFiles
 * entry for this round asks for them on a `__internal` export so this function
 * can go. It is one function with one behaviour rather than two vocabularies
 * for one question, so the cost of the overlap is a line of code and not a
 * class of defect.
 */
function matchDelim(source: string, openIdx: number): number {
  const open = source[openIdx];
  if (open === undefined) return -1;
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null;
  if (close === null) return -1;

  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * String CONTENTS blanked, offsets and line breaks preserved — EXCEPT a
 * template literal's `${…}` interpolations, which are code and are kept.
 *
 * Needed for the free-identifier scan and for nothing else: `page.goto('/orders')`
 * would otherwise contribute `orders` as a name the block reads from file
 * scope, and the extraction would be excluded for a reason that is not true.
 * `stripComments` deliberately keeps string contents (locator values live
 * there), so this is the complementary pass and not a second copy of it.
 *
 * THE INTERPOLATION CARVE-OUT IS NOT A REFINEMENT, IT CLOSES A FAIL-OPEN.
 * `` page.goto(`${BASE}/orders`) `` is the normal spelling in generated specs —
 * suite-health.ts's own comment says so — and blanking the whole literal hides
 * `BASE`, a file-scope constant the hoisted block reads and a helper file would
 * not have. The extraction would then be proposed, applied, and fail to
 * compile. Blanking too little costs a false exclusion, which is loud and safe;
 * blanking too much costs a broken write.
 */
function blankStrings(source: string): string {
  const out = source.split('');
  let quote: string | null = null;
  /** Depth of `${…}` nesting inside the template literal we are in. */
  let interpolation = 0;

  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i]!;

    if (quote === null) {
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        out[i] = ' ';
      }
      continue;
    }

    if (ch === '\\') {
      out[i] = ' ';
      if (i + 1 < out.length && out[i + 1] !== '\n') out[i + 1] = ' ';
      i += 1;
      continue;
    }

    if (quote === '`') {
      // `${` opens code; its matching `}` closes it. Everything between is kept.
      if (interpolation === 0 && ch === '$' && out[i + 1] === '{') {
        interpolation = 1;
        i += 1;
        continue;
      }
      if (interpolation > 0) {
        if (ch === '{') interpolation += 1;
        else if (ch === '}') interpolation -= 1;
        continue;
      }
    }

    if (ch === quote) {
      quote = null;
      out[i] = ' ';
      continue;
    }
    if (ch !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/** One `test('name', async (params) => { body })` call, located in the original bytes. */
interface TestBlock {
  readonly name: string;
  /** Offsets into the ORIGINAL source: the whole call, including a trailing `;`. */
  readonly start: number;
  readonly end: number;
  /** The callback's parameter list exactly as written, without its parentheses. */
  readonly params: string;
  /** Offsets of the callback body, excluding its braces. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

const TEST_CALL = /\b(?:test|it)\s*\(/g;

/**
 * Every `test(...)`/`it(...)` block in a file, with its name and body located.
 *
 * `test.only`, `test.skip` and `test.describe` do not match the anchor (a `.`
 * sits between the name and the paren) and are therefore invisible here. That
 * is the conservative direction: an operation that cannot find its block
 * reports BLOCK_NOT_LOCATABLE and declines, rather than rewriting a file whose
 * structure it half-read.
 */
function testBlocks(originalCode: string): { blocks: TestBlock[]; readable: boolean } {
  const stripped = stripComments(originalCode);
  if (stripped.unreliable) return { blocks: [], readable: false };
  const src = stripped.text;
  const blocks: TestBlock[] = [];

  TEST_CALL.lastIndex = 0;
  for (let m = TEST_CALL.exec(src); m; m = TEST_CALL.exec(src)) {
    const open = m.index + m[0].length - 1;
    const close = matchDelim(src, open);
    if (close === -1) break;
    TEST_CALL.lastIndex = close;

    const inner = src.slice(open + 1, close);
    const nameMatch = /^\s*(['"`])([\s\S]*?)\1\s*,/.exec(inner);
    if (!nameMatch) continue; // A name we cannot read is a block we will not rewrite.

    const afterName = open + 1 + nameMatch[0].length;
    const arrow = src.indexOf('=>', afterName);
    if (arrow === -1) continue;

    // The parameter list: `async (a, b) =>`, `(a) =>`, `a =>`, `async () =>`.
    const head = src.slice(afterName, arrow);
    const parenOpen = head.indexOf('(');
    let params: string;
    if (parenOpen === -1) {
      params = head.replace(/\basync\b/, '').trim();
    } else {
      const absoluteOpen = afterName + parenOpen;
      const parenClose = matchDelim(src, absoluteOpen);
      if (parenClose === -1 || parenClose > arrow) continue;
      params = src.slice(absoluteOpen + 1, parenClose);
    }

    const braceOpen = src.indexOf('{', arrow);
    if (braceOpen === -1 || braceOpen > close) continue;
    const braceClose = matchDelim(src, braceOpen);
    if (braceClose === -1) continue;

    let end = close + 1;
    while (end < src.length && /\s/.test(src[end]!)) end += 1;
    if (src[end] === ';') end += 1;

    blocks.push({
      name: nameMatch[2]!,
      start: m.index,
      end,
      params,
      bodyStart: braceOpen + 1,
      bodyEnd: braceClose,
    });
  }

  return { blocks, readable: true };
}

/**
 * The names a callback parameter list BINDS, or null when the form is one this
 * module will not guess at.
 *
 * `({ page, request })` and `(page)` are read. A default value, a rest element,
 * a nested pattern or an array pattern comes back null, because each one means
 * the hoisted block's dependency on its parameters cannot be expressed as a
 * positional argument list without changing what it receives.
 */
function paramNames(params: string): string[] | null {
  const text = params.trim();
  if (text === '') return [];

  if (/^\{[^{}]*\}$/.test(text)) {
    const names: string[] = [];
    for (const part of text.slice(1, -1).split(',')) {
      const piece = part.trim();
      if (piece === '') continue;
      if (piece.startsWith('...') || piece.includes('=')) return null;
      // `page` or `page: p`; the BOUND name is what follows the colon.
      const bound = piece.includes(':') ? piece.slice(piece.indexOf(':') + 1).trim() : piece;
      if (!/^[A-Za-z_$][\w$]*$/.test(bound)) return null;
      names.push(bound);
    }
    return names;
  }

  // `(page)` or `(page, testInfo)`: bare identifiers only.
  const names: string[] = [];
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece === '' || !/^[A-Za-z_$][\w$]*$/.test(piece)) return null;
    names.push(piece);
  }
  return names;
}

/** What a setup block declares, and whether every declaration was readable. */
interface BlockBindings {
  readonly names: string[];
  readonly readable: boolean;
  readonly unreadable: string | null;
}

/**
 * The names a block DECLARES, so a helper can hand them back.
 *
 * `const total = …` and `const { a, b } = …` are read. An array pattern, a
 * nested pattern, a `using` declaration or anything else comes back unreadable
 * — and an unreadable declaration EXCLUDES the dependent, because a helper that
 * returns the wrong names produces a spec that does not compile and a reviewer
 * who concludes the generator is broken.
 */
function blockBindings(strippedBlock: string): BlockBindings {
  const names: string[] = [];
  const re = /\b(const|let|var)\s+/g;

  for (let m = re.exec(strippedBlock); m; m = re.exec(strippedBlock)) {
    const rest = strippedBlock.slice(m.index + m[0].length);
    const ident = /^([A-Za-z_$][\w$]*)\s*(=|;|$)/.exec(rest);
    if (ident) {
      names.push(ident[1]!);
      continue;
    }
    if (rest.startsWith('{')) {
      const close = matchDelim(rest, 0);
      if (close === -1) {
        return { names, readable: false, unreadable: 'an unterminated destructuring pattern' };
      }
      const body = rest.slice(1, close);
      if (body.includes('{') || body.includes('[')) {
        return { names, readable: false, unreadable: 'a nested destructuring pattern' };
      }
      for (const part of body.split(',')) {
        const piece = part.trim();
        if (piece === '') continue;
        if (piece.startsWith('...') || piece.includes('=')) {
          return { names, readable: false, unreadable: `the binding "${quoted(piece)}"` };
        }
        const bound = piece.includes(':') ? piece.slice(piece.indexOf(':') + 1).trim() : piece;
        if (!/^[A-Za-z_$][\w$]*$/.test(bound)) {
          return { names, readable: false, unreadable: `the binding "${quoted(piece)}"` };
        }
        names.push(bound);
      }
      continue;
    }
    return {
      names,
      readable: false,
      unreadable: `a declaration form this module does not read: "${quoted(rest.slice(0, 40))}"`,
    };
  }

  return { names, readable: true, unreadable: null };
}

/**
 * Identifiers a block READS and does not own — the ones a helper file would not
 * have.
 *
 * Property accesses (`page.goto` → `goto`) and object-literal keys (`{ name: …`)
 * are not free reads and are dropped; the key rule is deliberately narrow (only
 * after a `{` or a `,`) so that a ternary's `a ? b : c` is NOT mistaken for a
 * key, which would drop a genuine free read and let an unsafe extraction
 * through. The remaining names are compared against the block's own bindings,
 * the callback's parameters and {@link AMBIENT_NAMES}; anything left means the
 * block depends on file scope and the dependent is excluded.
 */
function freeIdentifiers(strippedBlock: string, owned: ReadonlySet<string>): string[] {
  const text = blankStrings(strippedBlock);
  const free = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;

  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[0];
    if (owned.has(name) || AMBIENT_NAMES.has(name)) continue;

    // A property access is not a free read.
    let before = m.index - 1;
    while (before >= 0 && /[ \t]/.test(text[before]!)) before -= 1;
    if (before >= 0 && text[before] === '.') continue;

    // An object-literal key is not a free read. `{ name: x }` / `{ a, b: y }`.
    let after = m.index + name.length;
    while (after < text.length && /[ \t]/.test(text[after]!)) after += 1;
    if (text[after] === ':' && (text[before] === '{' || text[before] === ',')) continue;

    free.add(name);
  }

  return [...free].sort();
}

/**
 * WHITESPACE COLLAPSED OUTSIDE STRING LITERALS, for the equivalence proof.
 *
 * A blanket `replace(/\s+/g, ' ')` collapses the whitespace INSIDE a literal
 * too, so `fill('4242  4242')` and `fill('4242 4242')` normalise to one string.
 * The dependent that relied on the doubled space is then judged byte-identical
 * to the canonical block, INCLUDED rather than excluded, and rewritten to call a
 * helper that supplies the other value — a test silently asking a different
 * question, which is the one thing {@link extractFixture} promises never to do
 * ("there is no 'probably the same' path"). It is also invisible, because the
 * dependent is then listed as extracted and not as excluded. Found by
 * adversarial verification with a card number; a newline inside a template
 * literal is the same defect.
 *
 * Indentation, the line breaks between statements and the gap around an operator
 * are still collapsed — those are the differences the proof MUST ignore, or the
 * operation never fires and the copy-pasted setup stays copy-pasted.
 *
 * An interpolation is CODE and collapses like code, for the reason
 * {@link blankStrings} gives about `` `${BASE}/orders` ``: the carve-out is
 * where the real identifiers live, and treating it as data would make two blocks
 * that differ only in how they indent an interpolation compare unequal.
 *
 * COMMENTS STAY IN, deliberately rather than by oversight: a setup that differs
 * only by a comment is excluded today, which is the conservative direction, and
 * widening that is a separate decision with its own test. The quote scan
 * therefore runs over text that still holds comments, so an apostrophe in
 * `// don't` opens a literal that never closes. The consequence is that the rest
 * of the block stops collapsing, which can only make two blocks compare
 * UNEQUAL — a false exclusion, which costs a reviewer nothing. Failing towards
 * exclusion is why this is not worth a second comment-stripping pass that would
 * change which dependents are included.
 */
function collapseOutsideStrings(source: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  /** Depth of `${…}` nesting inside the template literal we are in. */
  let interpolation = 0;
  /** A run of code whitespace seen and not yet emitted. */
  let gap = false;

  const emit = (ch: string): void => {
    if (gap) {
      if (out.length > 0) out.push(' ');
      gap = false;
    }
    out.push(ch);
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

    // Code, either outside every literal or inside an interpolation.
    if (quote === null || interpolation > 0) {
      if (/\s/.test(ch)) {
        gap = true;
        continue;
      }
      emit(ch);
      if (quote === null) {
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      } else if (ch === '{') interpolation += 1;
      else if (ch === '}') interpolation -= 1;
      continue;
    }

    // A literal's bytes are DATA and are emitted exactly as written.
    if (ch === '\\') {
      emit(ch);
      if (i + 1 < source.length) {
        out.push(source[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      emit(ch);
      out.push('{');
      i += 1;
      interpolation = 1;
      continue;
    }
    emit(ch);
    if (ch === quote) quote = null;
  }

  return out.join('').trim();
}

/** Setup, located in a test body: the lines before the first assertion. */
interface SetupBlock {
  /** Offsets into the ORIGINAL source. */
  readonly start: number;
  readonly end: number;
  readonly original: string;
  /**
   * Whitespace collapsed OUTSIDE string literals, for the equivalence proof.
   * See {@link collapseOutsideStrings} for why the literals are left alone.
   */
  readonly normalised: string;
  readonly lines: number;
}

/**
 * The setup block of one test: everything in its body before the first
 * assertion suite-health found.
 *
 * The boundary comes from `behavior.assertionSites[0].line` and NOT from a
 * fresh `expect(` match. suite-health.ts already carries two vocabularies for
 * "what is an assertion" and the comment above the second one records what
 * their disagreement cost; a third, in a module that WRITES, would cost more.
 *
 * The block is required to be delimiter-balanced, which is what stops a
 * multi-line call being cut in half — and it is required to be free of `return`
 * and `throw`, because hoisting either moves control flow out of the test.
 */
function setupBlockOf(
  originalCode: string,
  block: TestBlock,
  firstAssertionLine: number,
): { setup: SetupBlock | null; reason: ExclusionReason | null; why: string } {
  const lineStarts: number[] = [0];
  for (let i = 0; i < originalCode.length; i += 1) {
    if (originalCode[i] === '\n') lineStarts.push(i + 1);
  }
  const assertionOffset = lineStarts[firstAssertionLine - 1];
  if (assertionOffset === undefined || assertionOffset <= block.bodyStart) {
    return {
      setup: null,
      reason: 'NO_SETUP_BLOCK',
      why: 'the first assertion is at or before the start of the test body, so nothing precedes it',
    };
  }

  const end = Math.min(assertionOffset, block.bodyEnd);
  const original = originalCode.slice(block.bodyStart, end);
  if (original.trim() === '') {
    return { setup: null, reason: 'NO_SETUP_BLOCK', why: 'there is no setup before the first assertion' };
  }

  const strippedWhole = stripComments(originalCode);
  const strippedBlock = strippedWhole.text.slice(block.bodyStart, end);
  if (!balanced(strippedBlock)) {
    return {
      setup: null,
      reason: 'NO_SETUP_BLOCK',
      why: 'the lines before the first assertion do not close every bracket they open, so the block cannot be moved whole',
    };
  }
  if (/\b(?:return|throw)\b/.test(blankStrings(strippedBlock))) {
    return {
      setup: null,
      reason: 'SETUP_CHANGES_CONTROL_FLOW',
      why: 'the block returns or throws, and hoisting it would move control flow out of the test',
    };
  }

  const lines = original.split('\n').filter((line) => line.trim() !== '').length;
  if (lines > MAX_SETUP_LINES) {
    return {
      setup: null,
      reason: 'NO_SETUP_BLOCK',
      why: `${lines} setup lines, past the cap of ${MAX_SETUP_LINES}: this is the test, not its setup`,
    };
  }

  return {
    setup: {
      start: block.bodyStart,
      end,
      original,
      normalised: collapseOutsideStrings(original),
      lines,
    },
    reason: null,
    why: '',
  };
}

/** Every bracket closed, nothing opened that is not. Strings respected. */
function balanced(source: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let quote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return quote === null && stack.length === 0;
}

// ─── Building a proposal ────────────────────────────────────────────────────

/** The bytes a path held before, so the revert record carries them and not a hash. */
interface PriorFile {
  readonly path: string;
  readonly content: string;
}

/**
 * A proposal, with its revert record and its dispositions derived rather than
 * chosen.
 *
 * A path with prior bytes gets its disposition from `dispositionFor`, so a file
 * a human has touched since QAAI wrote it comes back PROPOSED_EDIT and cannot
 * be written. A path with no prior bytes is NEW with a null `basedOnHash` —
 * the one combination `artifactSetProblems` accepts for a creation, and the
 * reason a new helper file carries `UNRECORDED` ownership and is therefore not
 * directly writable. That is correct: nothing here is applied without approval,
 * which `APPLYABLE_STATES` enforces on the proposal's STATE.
 */
function buildProposal(args: {
  readonly kind: SuiteChangeKind;
  readonly title: string;
  readonly rationale: string;
  readonly priors: readonly PriorFile[];
  readonly after: readonly Omit<GeneratedArtifact, 'disposition' | 'ownership' | 'basedOnHash'>[];
  readonly dependentTestIds: readonly string[];
  readonly ctx: RefactorContext;
}): SuiteChangeProposal {
  const { ctx } = args;
  const ledger = ctx.ledger ?? [];
  const priorByPath = new Map(args.priors.map((prior) => [prior.path, prior.content]));

  const resolve = (
    artifact: Omit<GeneratedArtifact, 'disposition' | 'ownership' | 'basedOnHash'>,
  ): GeneratedArtifact => {
    const prior = priorByPath.get(artifact.path);
    const verdict = resolveOwnership(ledger, artifact.path);
    const ledgerRow = ledger.find((entry) => entry.path === artifact.path);
    const onDiskHash = prior === undefined ? null : ctx.digest(prior);
    /*
     * NO PRIOR BYTES MEANS A CREATION, whatever the ledger says — and this
     * narrow override of `dispositionFor` is deliberate.
     *
     * `dispositionFor` answers PROPOSED_EDIT for an UNRECORDED path before it
     * ever looks at `onDiskHash`, which is right for a path that HOLDS
     * something and leaves a creation at an unrecorded path inexpressible:
     * PROPOSED_EDIT demands a `basedOnHash` and a file that does not exist has
     * no bytes to hash, so `artifactSetProblems` refuses it with
     * MISSING_BASE_HASH. NEW with `basedOnHash: null` is the only pair it
     * accepts for a creation.
     *
     * This is not a way around the ownership model. `ownership` still carries
     * the real verdict (UNRECORDED), so `mayWriteDirectly` is still false and
     * `artifactSetProblems` still reports WRITE_TO_UNOWNED at apply time — the
     * disposition says what is being ASKED FOR and the verdict says what is
     * KNOWN, which is the split artifact-set.ts draws. The precondition that
     * the path is free is checked separately and up front, against
     * {@link RefactorContext.knownPaths}.
     *
     * The clean fix belongs in artifact-set.ts and is in this round's
     * needsFromOtherFiles: `dispositionFor` should answer `PROPOSE_CREATE` (or
     * MISSING_BASE_HASH should not apply to a PROPOSED_EDIT whose path is absent
     * from `before`), so a proposed creation has a name of its own.
     */
    const disposition =
      onDiskHash === null
        ? 'NEW'
        : dispositionFor({
            verdict,
            ledgerHash: ledgerRow?.contentHash ?? null,
            onDiskHash,
          });
    return {
      ...artifact,
      disposition,
      ownership: verdict,
      basedOnHash: disposition === 'NEW' ? null : onDiskHash,
    };
  };

  const before: ArtifactSet = {
    artifacts: args.priors.map((prior) =>
      resolve({
        role: 'SPEC',
        path: prior.path,
        content: prior.content,
        imports: [],
        why: 'The file as it is today, carried so a reviewer reads a diff and not a replacement.',
      }),
    ),
    dialect: null,
  };

  const after = orderedForApply({ artifacts: args.after.map(resolve), dialect: null });

  /*
   * EVERY path either side touches, not just the ones in `after`.
   * `proposalProblems` builds its `touched` set from the union of `before` and
   * `after`, so a record built from `after` alone would come back
   * REVERT_INCOMPLETE the moment an operation reads a file it does not rewrite.
   * No operation does that today; the union costs nothing and the next one
   * will not have to discover this.
   */
  const paths = [
    ...new Set([
      ...after.artifacts.map((artifact) => artifact.path),
      ...before.artifacts.map((artifact) => artifact.path),
    ]),
  ];

  const entries: RevertEntry[] = paths.map((path): RevertEntry => {
    const prior = priorByPath.get(path);
    if (prior === undefined) return { path, existed: false };
    const row = ledger.find((entry) => entry.path === path);
    return {
      path,
      existed: true,
      priorContent: prior,
      priorHash: ctx.digest(prior),
      priorOwnership: row?.ownership ?? null,
    };
  });

  const proposal: SuiteChangeProposal = {
    kind: args.kind,
    /*
     * PROPOSED, always. A refactor touches tests a human wrote, so it is
     * strictly more dangerous than an auto-applied heal — and `APPLYABLE_STATES`
     * has exactly one `true` key, which is APPROVED and not this. The gap
     * between proposing and applying is the review, and a producer that could
     * emit an applyable state would be the review with nobody in it.
     */
    state: 'PROPOSED',
    title: boundedTitle(args.title),
    rationale: boundedRationale(args.rationale),
    before,
    after,
    dependentTestIds: [...args.dependentTestIds],
    dependentPaths: [],
    revert: { entries, paths },
  };

  /*
   * The blast radius is COMPUTED from the ledger and then stored, rather than
   * asserted by the producer. `dependentsAffected` is the keystone's own
   * function; re-deriving it here would be a second opinion that diverges.
   */
  return { ...proposal, dependentPaths: dependentsAffected(proposal, ledger) };
}

/** An outcome with no proposal, for the paths that refuse before building anything. */
function refuse(
  kind: SuiteChangeKind,
  problems: readonly RefactorProblem[],
  extras: Partial<RefactorOutcome> = {},
): RefactorOutcome {
  const first = problems[0];
  return {
    kind,
    proposal: null,
    problems,
    excluded: extras.excluded ?? [],
    coverage: extras.coverage ?? {
      state: 'UNMEASURABLE',
      why: 'the refactor was refused before the covered surface was compared',
      unreadable: [],
    },
    assertions: extras.assertions ?? { before: [], after: [], dropped: [] },
    trial: extras.trial ?? null,
    caps: extras.caps ?? [],
    why: first ? first.why : 'refused',
  };
}

/** The assertion sets either side of a change, from the one extractor. */
function assertionAccounting(
  before: readonly SuiteHealthTestInput[],
  after: readonly SuiteHealthTestInput[],
): AssertionAccounting {
  const collect = (tests: readonly SuiteHealthTestInput[]): string[] => {
    const tokens = new Set<string>();
    for (const test of tests) {
      try {
        for (const token of extractBehavior(test).assertions) tokens.add(token);
      } catch {
        /*
         * Swallowed HERE and only here, because the throw is already reported
         * by `coverageSurface` as an UnreadableTest and becomes
         * COVERAGE_UNMEASURABLE. Counting it twice would read as two defects.
         */
      }
    }
    return [...tokens].sort();
  };

  const beforeTokens = collect(before);
  const afterTokens = collect(after);
  const afterSet = new Set(afterTokens);
  return {
    before: beforeTokens,
    after: afterTokens,
    dropped: beforeTokens.filter((token) => !afterSet.has(token)),
  };
}

/**
 * The invariant and the assertion union, checked together, after an operation
 * has built its `after` text.
 *
 * ONE place, so no operation can forget it. An operation that builds text and
 * does not come through here cannot produce a proposal, because this is also
 * where the problem list that gates `buildProposal` is assembled.
 */
function checkInvariants(args: {
  readonly beforeTests: readonly SuiteHealthTestInput[];
  readonly afterTests: readonly SuiteHealthTestInput[];
  /**
   * Tokens this operation DELIBERATELY rewrote, so their disappearance is the
   * intended effect and not a loss.
   *
   * Exists for exactly one operation: STRENGTHEN_ASSERTION turns
   * `assert:tobetruthy:…` into `assert:tobevisible:…`, so the old token is gone
   * by construction and every strengthening would otherwise refuse itself.
   *
   * IT IS NOT A CALLER-SUPPLIED ALLOWLIST, and the difference matters. The
   * predicate is derived from the assertion SITES the operation actually
   * rewrote, so it can only ever excuse a token the rewrite produced. A
   * predicate a caller could widen would be a way to turn the coverage
   * invariant off, which is the one thing in this module nothing may do. The
   * test `'does not let the expected-change predicate excuse an unrelated
   * loss'` is what keeps that true.
   */
  readonly expectedChange?: (token: string) => boolean;
}): { problems: RefactorProblem[]; coverage: CoverageDelta; assertions: AssertionAccounting } {
  const problems: RefactorProblem[] = [];
  const expected = args.expectedChange ?? ((): boolean => false);
  const coverage = coverageDelta(
    coverageSurface(args.beforeTests),
    coverageSurface(args.afterTests),
  );

  if (coverage.state === 'UNMEASURABLE') {
    problems.push({
      kind: 'COVERAGE_UNMEASURABLE',
      path: coverage.unreadable[0]?.filePath ?? '',
      why: coverage.why,
    });
  } else {
    const lost = coverage.lost.filter((token) => !expected(token));
    if (lost.length > 0) {
      problems.push({
        kind: 'COVERAGE_LOST',
        path: '',
        why:
          `This refactor would stop covering ${lost.length} behaviour token(s): ` +
          `${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ', …' : ''}. ` +
          'A refactor that reduces the covered surface is refused.',
      });
    }
  }

  const assertions = assertionAccounting(args.beforeTests, args.afterTests);
  const dropped = assertions.dropped.filter((token) => !expected(token));
  if (dropped.length > 0) {
    problems.push({
      kind: 'ASSERTION_DROPPED',
      path: '',
      why:
        `${dropped.length} assertion(s) would no longer be made: ` +
        `${dropped.slice(0, 5).join(', ')}. The union of the assertions is not preserved, ` +
        'so this is refused rather than noted.',
    });
  }

  /*
   * `coverage` and `assertions` are returned UNFILTERED on purpose. The
   * predicate decides whether to REFUSE; it does not get to edit the numbers a
   * reviewer reads, because a delta that quietly omitted the tokens an
   * operation chose to call expected would be a cap applied without being
   * disclosed.
   */
  return { problems, coverage, assertions };
}

/**
 * The text a test's behaviour now spans: the artifacts it imports, then the
 * spec itself.
 *
 * See this file's header for why the order is load-bearing — `locatorBindings`
 * runs over the whole source before any token is extracted, so a binding that
 * moved into a helper has to appear before the spec that uses it.
 */
function spanningCode(spec: string, imported: readonly { role: string; content: string }[]): string {
  const ordered = [...imported].sort(
    (a, b) =>
      (ARTIFACT_ROLE_RANK[a.role as keyof typeof ARTIFACT_ROLE_RANK] ?? 0) -
      (ARTIFACT_ROLE_RANK[b.role as keyof typeof ARTIFACT_ROLE_RANK] ?? 0),
  );
  return [...ordered.map((artifact) => artifact.content), spec].join('\n');
}

/** A test row whose `code` is replaced, for measuring the after-side. */
function withCode(test: SuiteHealthTestInput, code: string): SuiteHealthTestInput {
  return { ...test, code };
}

// ─── Shared preconditions ───────────────────────────────────────────────────

/** The dialect of a subject's file, or null when suite-health could not name one. */
function dialectOf(subject: RefactorSubject): DialectId | null {
  try {
    return extractBehavior(subject.test).dialect;
  } catch {
    return null;
  }
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function extensionOf(path: string): string {
  const base = baseOf(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

// ─── Operation one: extract a fixture ───────────────────────────────────────

/**
 * Hoist setup several tests share into one helper the dependents call.
 *
 * ── WHY THE ARTIFACT IS A HELPER AND NOT A `beforeEach` ─────────────────────
 *
 * This looks like a limitation and is a correctness decision. A `beforeEach`
 * runs at a point in the hook order that depends on every OTHER hook the file
 * and its enclosing describes already declare, and nothing in the text tells us
 * what that order is. Moving setup into one changes WHEN it runs relative to
 * hooks we cannot see, which is a behaviour change we cannot prove safe. A
 * called function runs at exactly the point the copied lines ran — the only
 * form whose equivalence to "the lines that were there" is provable from the
 * text alone. The {@link SuiteChangeKind} names the intent (EXTRACT_FIXTURE)
 * and the {@link GeneratedArtifact}'s role names the form (HELPER); a
 * style-profile-driven FIXTURE form is a follow-up, not a silent default.
 *
 * ── WHAT IS PROVEN BEFORE A DEPENDENT IS INCLUDED ───────────────────────────
 *
 * Its setup block normalises to a string IDENTICAL to the canonical one. Not
 * similar: identical, after whitespace collapse. Anything else — a different
 * literal, an extra line, a reordering — is a dependent that relied on a
 * difference in its own setup, which is precisely the test this operation would
 * silently change. It is excluded and the reason is named.
 */
export function extractFixture(
  input: FixtureExtractionInput,
  ctx: RefactorContext,
): RefactorOutcome {
  const kind: SuiteChangeKind = 'EXTRACT_FIXTURE';
  const excluded: RefactorExclusion[] = [];
  const caps: CapHit[] = [];

  const first = input.candidates[0];
  if (first === undefined) {
    return refuse(kind, [
      { kind: 'NOTHING_TO_DO', path: '', why: 'no candidates were handed in' },
    ]);
  }

  const dialect = dialectOf(first);
  if (!readsAsJavaScript(dialect)) {
    return refuse(kind, [
      {
        kind: 'DIALECT_UNSUPPORTED',
        path: first.test.filePath,
        why:
          `This module reads JavaScript structure, and "${first.test.filePath}" resolves to ` +
          `${dialect === null ? 'no dialect' : dialect}. Rewriting it would be a guess in a ` +
          'language QAAI cannot read, which is how a correct test gets reported as broken.',
      },
    ]);
  }

  const directory = dirOf(first.test.filePath);

  /** One candidate, reduced to the facts the equivalence proof needs. */
  interface Candidate {
    readonly subject: RefactorSubject;
    readonly block: TestBlock;
    readonly setup: SetupBlock;
    readonly params: string[];
    readonly bindings: string[];
  }
  const usable: Candidate[] = [];

  for (const subject of input.candidates) {
    const { test } = subject;
    const code = test.code ?? '';
    const exclude = (reason: ExclusionReason, why: string): void => {
      excluded.push({ reason, testId: test.id, path: test.filePath, why });
    };

    if (dirOf(test.filePath) !== directory) {
      exclude(
        'DIFFERENT_DIRECTORY',
        `it lives in "${dirOf(test.filePath)}" and the rest live in "${directory}", so one ` +
          'import specifier cannot serve them all',
      );
      continue;
    }

    let behavior: TestBehavior;
    try {
      behavior = extractBehavior(test);
    } catch (error) {
      exclude(
        'BEHAVIOUR_UNREADABLE',
        `behaviour extraction threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (behavior.incomplete) {
      exclude('BEHAVIOUR_UNREADABLE', behavior.incompleteReason ?? 'analysis was truncated');
      continue;
    }

    const firstAssertion = behavior.assertionSites[0];
    if (firstAssertion === undefined) {
      exclude(
        'NO_ASSERTION_BOUNDARY',
        'this test makes no assertion suite-health can see, so where its setup ENDS is not knowable',
      );
      continue;
    }

    const located = testBlocks(code);
    if (!located.readable) {
      exclude(
        'BLOCK_NOT_LOCATABLE',
        'comment stripping ended inside a string or a comment, so the file structure is a guess',
      );
      continue;
    }
    const matching = located.blocks.filter((block) => block.name === test.name);
    const block = matching[0];
    if (block === undefined || matching.length > 1) {
      exclude(
        'BLOCK_NOT_LOCATABLE',
        matching.length > 1
          ? `${matching.length} blocks in this file are named "${codeComment(test.name)}", so the row does not identify one`
          : `no test block named "${codeComment(test.name)}" is in this file`,
      );
      continue;
    }

    const params = paramNames(block.params);
    if (params === null) {
      exclude(
        'PARAMS_UNREADABLE',
        `the callback's parameter list "${quoted(block.params)}" is not a bare identifier or a flat destructuring`,
      );
      continue;
    }

    const { setup, reason, why } = setupBlockOf(code, block, firstAssertion.line);
    if (setup === null) {
      exclude(reason ?? 'NO_SETUP_BLOCK', why);
      continue;
    }

    const strippedSetup = stripComments(code).text.slice(setup.start, setup.end);
    const bindings = blockBindings(strippedSetup);
    if (!bindings.readable) {
      exclude(
        'BINDING_UNREADABLE',
        `the setup declares ${bindings.unreadable ?? 'something unreadable'}, so a helper cannot hand its names back`,
      );
      continue;
    }

    const owned = new Set([...bindings.names, ...params]);
    const free = freeIdentifiers(strippedSetup, owned);
    if (free.length > 0) {
      exclude(
        'FREE_IDENTIFIER',
        `the setup reads ${free.slice(0, 4).map((name) => `"${name}"`).join(', ')} from file scope, ` +
          'and a helper file would not have it',
      );
      continue;
    }

    usable.push({ subject, block, setup, params, bindings: bindings.names });
  }

  const canonical = usable[0];
  if (canonical === undefined) {
    return refuse(
      kind,
      [
        {
          kind: 'NOT_ENOUGH_DEPENDENTS',
          path: first.test.filePath,
          why: `no candidate's setup could be proven safe to hoist; ${excluded.length} were excluded`,
        },
      ],
      { excluded },
    );
  }

  const equivalent: Candidate[] = [];
  for (const candidate of usable) {
    if (candidate.setup.normalised !== canonical.setup.normalised) {
      excluded.push({
        reason: 'SETUP_NOT_IDENTICAL',
        testId: candidate.subject.test.id,
        path: candidate.subject.test.filePath,
        why:
          'its setup is not byte-identical to the canonical block after whitespace collapse, so it ' +
          'relied on a difference and extracting would silently change what it tests',
      });
      continue;
    }
    // Identical text with a different parameter list would be handed different
    // arguments, which is a different setup wearing the same words.
    if (candidate.params.join(',') !== canonical.params.join(',')) {
      excluded.push({
        reason: 'PARAMS_UNREADABLE',
        testId: candidate.subject.test.id,
        path: candidate.subject.test.filePath,
        why: `its callback binds [${candidate.params.join(', ')}] and the canonical one binds [${canonical.params.join(', ')}]`,
      });
      continue;
    }
    equivalent.push(candidate);
  }

  if (equivalent.length > MAX_FIXTURE_DEPENDENTS) {
    const dropped = equivalent.slice(MAX_FIXTURE_DEPENDENTS);
    for (const candidate of dropped) {
      excluded.push({
        reason: 'OVER_DEPENDENT_CAP',
        testId: candidate.subject.test.id,
        path: candidate.subject.test.filePath,
        why: `past the cap of ${MAX_FIXTURE_DEPENDENTS} dependents; this file was left untouched`,
      });
    }
    caps.push({
      cap: 'MAX_FIXTURE_DEPENDENTS',
      limit: MAX_FIXTURE_DEPENDENTS,
      dropped: dropped.length,
      why:
        `an artifact set holds at most ${MAX_ARTIFACTS_PER_SET} files and one of them is the ` +
        'helper, so the remaining dependents were left untouched rather than silently dropped',
    });
    equivalent.length = MAX_FIXTURE_DEPENDENTS;
  }

  if (equivalent.length < MIN_FIXTURE_DEPENDENTS) {
    return refuse(
      kind,
      [
        {
          kind: 'NOT_ENOUGH_DEPENDENTS',
          path: canonical.subject.test.filePath,
          why:
            `${equivalent.length} dependent(s) survived the equivalence proof and ` +
            `${MIN_FIXTURE_DEPENDENTS} are needed: a shared helper with one caller is a rename`,
        },
      ],
      { excluded, caps },
    );
  }

  // ── The helper file ──────────────────────────────────────────────────────

  const featureSlug = safeIdentifier(canonical.subject.test.feature ?? '', 'shared');
  const helperName = `setUp${featureSlug.charAt(0).toUpperCase()}${featureSlug.slice(1)}`;
  const extension = extensionOf(canonical.subject.test.filePath) || '.ts';
  const helperBase = `${featureSlug}.qaai-setup${extension}`;
  const helperPath = directory === '' ? helperBase : `${directory}/${helperBase}`;

  if (!pathIsSafe(helperPath)) {
    return refuse(
      kind,
      [
        {
          kind: 'PATH_UNSAFE',
          path: helperPath,
          why:
            'the computed helper path is not repo-relative. It is built from a spec path and a ' +
            'sanitised slug, so this is a guard that should never fire — and it fires before a tree is touched.',
        },
      ],
      { excluded, caps },
    );
  }

  /*
   * THE PRECONDITION FOR CLAIMING `{ existed: false }`.
   *
   * This operation is the only one that creates a file, so it is the only one
   * that can claim a path was empty — and that claim is what licenses a revert
   * to DELETE it. The claim has to be checked against a fact, and the absence
   * of the fact is refused rather than read as "the path is free". See
   * {@link RefactorContext.knownPaths} for why neither the ledger nor
   * `artifactSetProblems` closes this.
   */
  if (ctx.knownPaths === null) {
    return refuse(
      kind,
      [
        {
          kind: 'TREE_UNKNOWN',
          path: helperPath,
          why:
            `this proposal would create "${helperPath}" and record that nothing was there, which is ` +
            'what lets a revert delete it. Nobody said what is in the working tree, so the claim ' +
            'cannot be made. Supply knownPaths — it is a directory listing, not a model call.',
        },
      ],
      { excluded, caps },
    );
  }
  if (ctx.knownPaths.includes(helperPath)) {
    return refuse(
      kind,
      [
        {
          kind: 'PATH_OCCUPIED',
          path: helperPath,
          why:
            `a file is already at "${helperPath}". Writing there would overwrite work QAAI does not ` +
            'own, and reverting would delete it.',
        },
      ],
      { excluded, caps },
    );
  }

  const returns = canonical.bindings;
  const signature = canonical.params.join(', ');
  const helperContent =
    `// Generated by QAAI: setup extracted from ${equivalent.length} tests that shared it.\n` +
    `// Reviewed as a proposal before anything was written. See the suite-change proposal.\n` +
    `export async function ${helperName}(${signature}) {\n` +
    `${reindent(canonical.setup.original, '  ')}\n` +
    (returns.length > 0 ? `  return { ${returns.join(', ')} };\n` : '') +
    `}\n`;

  /*
   * The import specifier's extension is LEARNED from the spec's own relative
   * imports rather than assumed, because `./setup.js` and `./setup` are both
   * correct in this repository's own workspaces and the wrong one does not
   * resolve. When there is nothing to learn from, the assumption is DISCLOSED
   * in the rationale instead of being made quietly.
   */
  const observed = observedRelativeExtension(canonical.subject.test.code ?? '');
  const specifierBase = helperBase.slice(0, helperBase.length - extension.length);
  const specifier = `./${specifierBase}${observed ?? ''}`;

  const afterArtifacts: Omit<GeneratedArtifact, 'disposition' | 'ownership' | 'basedOnHash'>[] = [
    {
      role: 'HELPER',
      path: helperPath,
      content: helperContent,
      imports: [],
      why: 'Setup that was copy-pasted into every dependent, hoisted once and called at the same point.',
    },
  ];
  const priors: PriorFile[] = [];
  const beforeTests: SuiteHealthTestInput[] = [];
  const afterTests: SuiteHealthTestInput[] = [];

  for (const candidate of equivalent) {
    const code = candidate.subject.test.code ?? '';
    const callSite =
      returns.length > 0
        ? `  const { ${returns.join(', ')} } = await ${helperName}(${signature});\n`
        : `  await ${helperName}(${signature});\n`;

    const rewritten =
      `import { ${helperName} } from ${codeString(specifier)};\n` +
      code.slice(0, candidate.setup.start) +
      `\n${callSite}` +
      code.slice(candidate.setup.end);

    priors.push({ path: candidate.subject.test.filePath, content: code });
    afterArtifacts.push({
      role: 'SPEC',
      path: candidate.subject.test.filePath,
      content: rewritten,
      imports: [helperPath],
      why: `Calls ${helperName}() where its own copy of the setup used to be.`,
    });

    beforeTests.push(candidate.subject.test);
    afterTests.push(
      withCode(
        candidate.subject.test,
        spanningCode(rewritten, [{ role: 'HELPER', content: helperContent }]),
      ),
    );
  }

  const { problems, coverage, assertions } = checkInvariants({ beforeTests, afterTests });
  if (problems.some((problem) => PROBLEM_BLOCKS_REFACTOR[problem.kind])) {
    return refuse(kind, problems, { excluded, caps, coverage, assertions });
  }

  const rationale =
    `${equivalent.length} tests in ${directory === '' ? 'the repository root' : directory} ` +
    `carried the same ${canonical.setup.lines}-line setup. It is hoisted into ${helperName}() and ` +
    `called at exactly the point each copy ran, so nothing moved relative to any hook.\n\n` +
    `Equivalence was PROVEN: every dependent's setup is byte-identical to the canonical block after ` +
    `whitespace collapse, and every dependent's callback binds the same parameters. ` +
    `${excluded.length} candidate(s) were EXCLUDED rather than assumed equivalent.\n\n` +
    (observed === null
      ? 'The import specifier is extensionless because this spec has no relative import to learn ' +
        'the convention from. That is an assumption, stated here rather than made quietly.\n\n'
      : `The import specifier uses "${observed}", copied from this spec's own relative imports.\n\n`) +
    `suite-health finding: ${codeComment(input.finding)}`;

  const proposal = buildProposal({
    kind,
    title: `Extract shared setup from ${equivalent.length} tests into ${helperName}()`,
    rationale,
    priors,
    after: afterArtifacts,
    dependentTestIds: equivalent.map((candidate) => candidate.subject.test.id),
    ctx,
  });

  return {
    kind,
    proposal,
    problems,
    excluded,
    coverage,
    assertions,
    trial: null,
    caps,
    why: `setup hoisted from ${equivalent.length} tests; ${excluded.length} excluded`,
  };
}

/** Re-indent a block to sit inside a function body, preserving relative shape. */
function reindent(block: string, indent: string): string {
  const lines = block.split('\n').filter((line) => line.trim() !== '');
  const common = lines.reduce((min, line) => {
    const leading = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    return Math.min(min, leading);
  }, Number.POSITIVE_INFINITY);
  const strip = Number.isFinite(common) ? common : 0;
  return lines.map((line) => `${indent}${line.slice(strip)}`).join('\n');
}

/**
 * The extension this file's own relative imports use, or null when it has none.
 *
 * Null is "nothing to learn from" and NOT "extensionless": the caller discloses
 * the assumption rather than presenting a guess as an observation.
 */
function observedRelativeExtension(code: string): string | null {
  const re = /\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const specifier = m[2]!;
    const ext = extensionOf(specifier);
    return ext === '' ? '' : ext;
  }
  return null;
}

// ─── Operation two: merge near-duplicates ───────────────────────────────────

/**
 * Two near-duplicate tests in one file become one test that still makes every
 * assertion both made.
 *
 * ── NEITHER BODY IS EDITED, AND THAT IS THE WHOLE SAFETY ARGUMENT ───────────
 *
 * The tempting merge de-duplicates: drop B's `goto('/checkout')` because A
 * already has one. It is also wrong, because A may have navigated away in
 * between, and the failure is a test that passes while checking the wrong page.
 * So both bodies are kept VERBATIM and in order, each wrapped in a braced block
 * so their `const`/`let` declarations cannot collide. The saving is one test
 * block instead of two — one context, one round of the runner's own fixture
 * setup — and not fewer lines. A merge that needs to edit a body is not
 * proposed.
 *
 * A braced block and not `test.step`: `test.step` is Playwright's and this
 * module writes for five dialects, while `{ … }` is JavaScript's own block
 * scope and needs no import. `var` survives it, which is why a `var` collision
 * is not refused — a redeclared `var` is legal and keeps the last write, the
 * same as it did when the two tests ran in sequence.
 *
 * ── WHAT IS REFUSED ────────────────────────────────────────────────────────
 *
 * A body that `return`s, because appending a second body after it would not run
 * it — the exact shape of "a merge that deletes coverage while the number stays
 * flat". Parameter lists that cannot be unioned. Two rows that disagree about
 * the bytes of the file they share, which means one of them is stale and
 * rewriting from either is a guess.
 */
export function mergeNearDuplicates(input: MergeInput, ctx: RefactorContext): RefactorOutcome {
  const kind: SuiteChangeKind = 'MERGE_NEAR_DUPLICATES';
  const excluded: RefactorExclusion[] = [];

  if (input.members.length < 2) {
    return refuse(kind, [
      {
        kind: 'NOTHING_TO_DO',
        path: input.members[0]?.test.filePath ?? '',
        why: 'a merge needs at least two members',
      },
    ]);
  }

  const first = input.members[0]!;
  const filePath = first.test.filePath;
  const code = first.test.code ?? '';

  for (const member of input.members) {
    if (member.test.filePath !== filePath) {
      return refuse(kind, [
        {
          kind: 'FILES_DISAGREE',
          path: member.test.filePath,
          why:
            `"${member.test.filePath}" is not "${filePath}". A cross-file merge removes a test from ` +
            'one of them, and this vocabulary has no DELETE: merge members must share a file.',
        },
      ]);
    }
    if ((member.test.code ?? '') !== code) {
      return refuse(kind, [
        {
          kind: 'FILES_DISAGREE',
          path: filePath,
          why:
            'two rows claim this path and carry different bytes, so one of them is stale. ' +
            'Rewriting from either would discard whatever the other saw.',
        },
      ]);
    }
    if (member.test.type !== first.test.type) {
      return refuse(kind, [
        {
          kind: 'MIXED_TEST_TYPES',
          path: filePath,
          why: `a ${first.test.type} test and a ${member.test.type} test are two kinds of run, not one test`,
        },
      ]);
    }
  }

  const dialect = dialectOf(first);
  if (!readsAsJavaScript(dialect)) {
    return refuse(kind, [
      {
        kind: 'DIALECT_UNSUPPORTED',
        path: filePath,
        why:
          `This module reads JavaScript structure, and "${filePath}" resolves to ` +
          `${dialect === null ? 'no dialect' : dialect}.`,
      },
    ]);
  }

  const located = testBlocks(code);
  if (!located.readable) {
    return refuse(kind, [
      {
        kind: 'SOURCE_UNREADABLE',
        path: filePath,
        why:
          'comment stripping ended inside a string or a comment, so where each test block begins ' +
          'and ends is a guess. Nothing was rewritten.',
      },
    ]);
  }

  const blocks: TestBlock[] = [];
  const paramUnion: string[] = [];
  for (const member of input.members) {
    const matching = located.blocks.filter((block) => block.name === member.test.name);
    const block = matching[0];
    if (block === undefined || matching.length > 1) {
      return refuse(
        kind,
        [
          {
            kind: 'TEST_BLOCK_NOT_FOUND',
            path: filePath,
            why:
              matching.length > 1
                ? `${matching.length} blocks are named "${codeComment(member.test.name)}", so the row does not identify one`
                : `no test block named "${codeComment(member.test.name)}" is in this file`,
          },
        ],
        { excluded },
      );
    }

    const params = paramNames(block.params);
    if (params === null) {
      return refuse(kind, [
        {
          kind: 'MERGE_PARAMS_UNREADABLE',
          path: filePath,
          why: `the callback's parameter list "${quoted(block.params)}" is not a form this module can union`,
        },
      ]);
    }
    const destructured = block.params.trim().startsWith('{') || block.params.trim() === '';
    if (!destructured) {
      return refuse(kind, [
        {
          kind: 'MERGE_PARAMS_UNREADABLE',
          path: filePath,
          why:
            `"${quoted(block.params)}" is a positional parameter list. Unioning it with another ` +
            'would change which argument each name receives.',
        },
      ]);
    }
    for (const name of params) if (!paramUnion.includes(name)) paramUnion.push(name);

    const body = blankStrings(stripComments(code).text.slice(block.bodyStart, block.bodyEnd));
    if (/\breturn\b/.test(body)) {
      return refuse(kind, [
        {
          kind: 'MERGE_EARLY_RETURN',
          path: filePath,
          why:
            `"${codeComment(block.name)}" returns from its body, so a second body appended after it ` +
            'would not run. That is a merge that deletes coverage, which is refused.',
        },
      ]);
    }

    const aborting = ABORTING_BODY_FORMS.find((form) => form.pattern.test(body));
    if (aborting !== undefined) {
      return refuse(kind, [
        {
          kind: 'MERGE_BODY_ABORTS',
          path: filePath,
          why:
            `"${codeComment(block.name)}" ${aborting.why}. The merged file would still CONTAIN ` +
            'every assertion both members made, so the coverage comparison reads clean while a ' +
            'guarantee is gone — which is why this is refused here, on the text, rather than left ' +
            'to the invariant.',
        },
      ]);
    }

    blocks.push(block);
  }

  // Rewrite in reverse document order so earlier offsets stay valid.
  const ordered = [...blocks].sort((a, b) => a.start - b.start);
  const target = ordered[0]!;

  const mergedName = ordered.map((block) => block.name).join(' + ');
  const mergedBody = ordered
    .map(
      (block) =>
        `  // merged from: ${codeComment(block.name)}\n  {\n` +
        `${reindent(code.slice(block.bodyStart, block.bodyEnd), '    ')}\n  }`,
    )
    .join('\n');
  const mergedBlock =
    `test(${codeString(mergedName)}, async ({ ${paramUnion.join(', ')} }) => {\n${mergedBody}\n});`;

  let rewritten = code;
  for (const block of [...ordered].reverse()) {
    rewritten =
      rewritten.slice(0, block.start) +
      (block === target ? mergedBlock : '') +
      rewritten.slice(block.end);
  }

  const beforeTests = input.members.map((member) => member.test);
  /*
   * ONE after-side row, carrying the merged file. The other rows' tests no
   * longer exist as separate blocks, so measuring them as if they did would
   * count the same file N times — which inflates nothing (tokens are a set) but
   * would hide the case where a member's block failed to make it in.
   */
  const afterTests = [withCode(first.test, rewritten)];

  const { problems, coverage, assertions } = checkInvariants({ beforeTests, afterTests });
  if (problems.some((problem) => PROBLEM_BLOCKS_REFACTOR[problem.kind])) {
    return refuse(kind, problems, { excluded, coverage, assertions });
  }

  const rationale =
    `${ordered.length} near-duplicate tests in ${baseOf(filePath)} become one. Neither body was ` +
    `edited and nothing was de-duplicated: each is wrapped in its own braced block, in document ` +
    `order, so every line both tests ran still runs and their declarations cannot collide. No ` +
    `body returns, throws, or calls test.skip/test.fixme/test.fail — a merge whose first body ` +
    `ends or inverts the run is refused, because appending a second body after one would stop it ` +
    `running while the file still read as covering everything.\n\n` +
    `ASSERTIONS BEFORE (${assertions.before.length}): ${assertions.before.join(', ') || '(none)'}\n` +
    `ASSERTIONS AFTER  (${assertions.after.length}): ${assertions.after.join(', ') || '(none)'}\n` +
    `DROPPED: ${assertions.dropped.length === 0 ? 'none — the union is preserved' : assertions.dropped.join(', ')}\n\n` +
    `Merged names: ${codeComment(mergedName)}\n` +
    `suite-health finding: ${codeComment(input.finding)}`;

  const proposal = buildProposal({
    kind,
    title: `Merge ${ordered.length} near-duplicate tests in ${baseOf(filePath)}`,
    rationale,
    priors: [{ path: filePath, content: code }],
    after: [
      {
        role: 'SPEC',
        path: filePath,
        content: rewritten,
        imports: [],
        why: `${ordered.length} test blocks become one that still makes every assertion each of them made.`,
      },
    ],
    dependentTestIds: input.members.map((member) => member.test.id),
    ctx,
  });

  return {
    kind,
    proposal,
    problems,
    excluded,
    coverage,
    assertions,
    trial: null,
    caps: [],
    why: `${ordered.length} tests merged with the assertion union preserved`,
  };
}

// ─── Operation three: strengthen an assertion ───────────────────────────────

/**
 * The strengthenings this module will write, and nothing else.
 *
 * Each one is DERIVABLE from the test's own text and STRICTLY STRONGER than
 * what it replaces. That is a short list on purpose: suite-health also reports
 * TRANSPORT_ONLY ("this only checks the status code") and VOLATILE_ASSERTION,
 * and the stronger assertion for either one is a claim about the application
 * that is not in the test — "the body should contain an order id", "the total
 * should be $42". Inventing it would be QAAI guessing the intent and calling it
 * a refactor. Those findings are reported by {@link strengthenAssertions} as
 * `notStrengthened` with the reason, which is the honest answer: we can see the
 * weakness and we cannot derive the fix.
 */
export const STRENGTHENINGS = [
  /** `toBeTruthy()`/`toBeDefined()` on a locator → `toBeVisible()`. A locator object is always truthy. */
  'LOCATOR_VISIBILITY',
] as const;
export type Strengthening = (typeof STRENGTHENINGS)[number];

/** The matchers `LOCATOR_VISIBILITY` replaces, and what it replaces them with. */
const TRUTHY_MATCHERS = new Set(['tobetruthy', 'tobedefined']);

/** A weakness seen and deliberately not strengthened, with the reason. */
export interface NotStrengthened {
  readonly line: number | null;
  readonly quote: string;
  readonly why: string;
}

export interface StrengthenOutcome extends RefactorOutcome {
  /** Weaknesses this module can SEE and will not guess a fix for. Reported, never silent. */
  readonly notStrengthened: readonly NotStrengthened[];
  /**
   * The proposal this strengthening WOULD BE once a trial gives it a verdict.
   *
   * A separate field from `proposal` and not a flag beside it, because the
   * difference between them is the whole rule: `proposal` is what a caller may
   * act on, and it is null until the stronger assertion has been RUN.
   * `pending` is what {@link verifyStrengthening} hands the runner. It is not a
   * way around the rule — its `state` is PROPOSED and `APPLYABLE_STATES` has
   * exactly one `true` key, which is APPROVED — but it is a second object
   * shaped like a proposal, so it is named for what it is.
   */
  readonly pending: SuiteChangeProposal | null;
}

/**
 * Propose a strengthening, DETERMINISTICALLY and UNVERIFIED.
 *
 * This is the model-free, runner-free path, and it deliberately does not
 * produce an applyable proposal: `STRENGTHENING_UNVERIFIED` blocks until
 * {@link verifyStrengthening} has actually run the stronger assertion. A
 * strengthening that was not run has an unknown verdict, and "unknown" reported
 * as a refactor is the pass that means "we did not check".
 */
export function strengthenAssertions(
  input: StrengthenInput,
  ctx: RefactorContext,
): StrengthenOutcome {
  const kind: SuiteChangeKind = 'STRENGTHEN_ASSERTION';
  const { test } = input.subject;
  const code = test.code ?? '';
  const notStrengthened: NotStrengthened[] = [];
  const blank = (outcome: RefactorOutcome): StrengthenOutcome => ({
    ...outcome,
    notStrengthened,
    pending: null,
  });

  const dialect = dialectOf(input.subject);
  if (!readsAsJavaScript(dialect)) {
    return blank(
      refuse(kind, [
        {
          kind: 'DIALECT_UNSUPPORTED',
          path: test.filePath,
          why:
            `This module rewrites JavaScript matchers, and "${test.filePath}" resolves to ` +
            `${dialect === null ? 'no dialect' : dialect}.`,
        },
      ]),
    );
  }

  let behavior: TestBehavior;
  try {
    behavior = extractBehavior(test);
  } catch (error) {
    return blank(
      refuse(kind, [
        {
          kind: 'SOURCE_UNREADABLE',
          path: test.filePath,
          why: `behaviour extraction threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]),
    );
  }
  if (behavior.incomplete) {
    return blank(
      refuse(kind, [
        {
          kind: 'SOURCE_UNREADABLE',
          path: test.filePath,
          why: behavior.incompleteReason ?? 'analysis was truncated',
        },
      ]),
    );
  }

  const lines = code.split('\n');
  let rewritten: string[] | null = null;
  const applied: string[] = [];

  /** Prefixes of the assertion tokens this rewrite deliberately replaces. */
  const replacedPrefixes = new Set<string>();

  for (const site of behavior.assertionSites) {
    const matcher = site.matcher.toLowerCase();

    /*
     * A NEGATED truthy matcher is left alone. `expect(x).not.toBeTruthy()` is a
     * claim that something is absent; `not.toBeVisible()` is a DIFFERENT claim,
     * not a stronger one, and swapping it would be QAAI changing what a test
     * checks under the heading of tidying it.
     */
    if (site.negated) continue;

    if (!TRUTHY_MATCHERS.has(matcher)) {
      if (site.kind === 'transport' || site.volatile) {
        notStrengthened.push({
          line: site.line,
          quote: quoted(site.quote),
          why: site.volatile
            ? 'the expected value changes between runs, and a stable replacement is a claim about the ' +
              'application that is not in this test. QAAI will not invent it.'
            : 'strengthening a transport-only assertion means naming what the body should contain, ' +
              'which is not in this test. QAAI will not invent it.',
        });
      }
      continue;
    }

    if (site.target === 'unknown' || site.target.startsWith('var=')) {
      notStrengthened.push({
        line: site.line,
        quote: quoted(site.quote),
        why: `the subject of this assertion resolves to "${site.target}", so there is no evidence it is a locator`,
      });
      continue;
    }

    const index = site.line - 1;
    const line = lines[index];
    if (line === undefined) {
      notStrengthened.push({
        line: site.line,
        quote: quoted(site.quote),
        why: 'the recorded line is outside the source, so the rewrite could not be placed',
      });
      continue;
    }
    const token = matcher === 'tobetruthy' ? 'toBeTruthy' : 'toBeDefined';
    if (!line.includes(`${token}(`)) {
      notStrengthened.push({
        line: site.line,
        quote: quoted(site.quote),
        why: `"${token}(" is not on the line it was reported on, so the assertion spans lines and a one-line rewrite would corrupt it`,
      });
      continue;
    }

    rewritten ??= [...lines];
    rewritten[index] = line.replace(`${token}(`, 'toBeVisible(');
    replacedPrefixes.add(`assert:${matcher}:${site.target}:`);
    applied.push(
      `line ${site.line}: ${token}() → toBeVisible() on ${site.target} — a locator object is ` +
        'always truthy, so the assertion could not fail',
    );
  }

  if (rewritten === null) {
    return blank(
      refuse(
        kind,
        [
          {
            kind: 'NOTHING_TO_DO',
            path: test.filePath,
            why:
              `no derivable strengthening was found; ${notStrengthened.length} weakness(es) were ` +
              'seen and deliberately not guessed at',
          },
        ],
        { excluded: [] },
      ),
    );
  }

  const after = rewritten.join('\n');

  /*
   * A strengthening CHANGES an assertion token by construction —
   * `assert:tobetruthy:role=button[pay]:` becomes `assert:tobevisible:…` — so
   * the old token is gone and every strengthening would otherwise refuse
   * itself. The predicate is built from the sites this loop ACTUALLY rewrote,
   * so it cannot excuse a token the rewrite did not produce: a lost route, a
   * lost action or an assertion that vanished rather than changed still blocks.
   */
  const { problems, coverage, assertions } = checkInvariants({
    beforeTests: [test],
    afterTests: [withCode(test, after)],
    expectedChange: (token) => {
      for (const prefix of replacedPrefixes) if (token.startsWith(prefix)) return true;
      return false;
    },
  });

  /*
   * UNVERIFIED, and therefore BLOCKED. The register's rule, as a problem a
   * caller cannot destructure away: never apply a strengthening unverified.
   */
  const trial: AssertionTrial = {
    state: 'UNAVAILABLE',
    why: 'no verifier was supplied, so this stronger assertion has not been run',
    detail: [],
  };
  const problemsOut: RefactorProblem[] = [
    ...problems,
    {
      kind: 'STRENGTHENING_UNVERIFIED',
      path: test.filePath,
      why:
        'this stronger assertion has not been run. A stronger assertion can go red because it found ' +
        'a bug or because QAAI guessed the intent wrong, and those are opposite outcomes. Run it with ' +
        'verifyStrengthening() before this can be applied.',
    },
  ];

  const rationale =
    `${applied.length} assertion(s) strengthened:\n${applied.map((line) => `  - ${line}`).join('\n')}\n\n` +
    `ASSERTIONS BEFORE (${assertions.before.length}): ${assertions.before.join(', ') || '(none)'}\n` +
    `ASSERTIONS AFTER  (${assertions.after.length}): ${assertions.after.join(', ') || '(none)'}\n\n` +
    (notStrengthened.length > 0
      ? `${notStrengthened.length} further weakness(es) were SEEN AND NOT STRENGTHENED, because the ` +
        `stronger assertion is a claim about the application that is not in this test:\n` +
        notStrengthened.map((item) => `  - line ${item.line ?? '?'}: ${item.why}`).join('\n') +
        '\n\n'
      : '') +
    `VERIFICATION: not run. ${trial.why}.\n\n` +
    `suite-health finding: ${codeComment(input.finding)}`;

  const proposal = buildProposal({
    kind,
    title: `Strengthen ${applied.length} assertion(s) in ${baseOf(test.filePath)} (unverified)`,
    rationale,
    priors: [{ path: test.filePath, content: code }],
    after: [
      {
        role: 'SPEC',
        path: test.filePath,
        content: after,
        imports: [],
        why: 'A matcher that could not fail becomes one that can.',
      },
    ],
    dependentTestIds: [test.id],
    ctx,
  });

  return {
    kind,
    /*
     * The proposal is BUILT and then WITHHELD, because STRENGTHENING_UNVERIFIED
     * blocks — the `proposal === null ⟺ blocked` biconditional this module's
     * callers rely on. It is handed over as `pending`, which
     * `verifyStrengthening` finishes once there is a verdict to put in the
     * title. Building it here rather than there is what keeps one construction
     * of the rewrite: a second one in the verify path could disagree with this
     * one about the bytes it is about to run.
     */
    proposal: null,
    problems: problemsOut,
    excluded: [],
    coverage,
    assertions,
    trial,
    caps: [],
    why: 'a strengthening was computed and has not been run',
    notStrengthened,
    pending: proposal,
  };
}

/**
 * Run the stronger assertion and turn the result into the proposal it earns.
 *
 * PASSED and FAILED are DIFFERENT PROPOSALS and both are produced:
 *
 *   PASSED → a straightforward strengthening. The title says it passes.
 *   FAILED → still a proposal, and its title says it FAILS. This is the case
 *     the register is most careful about: suppressing it would be a failure
 *     suppressed without being counted, and it is frequently the most valuable
 *     output this engine produces — a weak assertion was hiding a real defect.
 *     `STRENGTHENING_FAILED` is therefore the one non-blocking problem in
 *     {@link PROBLEM_BLOCKS_REFACTOR}, so the proposal reaches a human.
 *   UNAVAILABLE → the trial could not run. Still blocked, same as never having
 *     asked.
 */
export async function verifyStrengthening(
  input: StrengthenInput,
  ctx: RefactorContext,
  verifier: AssertionVerifier,
): Promise<StrengthenOutcome> {
  const unverified = strengthenAssertions(input, ctx);
  const { pending } = unverified;
  if (pending === null) return unverified; // Refused before a rewrite was computed.

  const { test } = input.subject;
  const before = test.code ?? '';
  const afterArtifact = pending.after.artifacts.find(
    (artifact) => artifact.path === test.filePath,
  );
  const after = afterArtifact?.content ?? before;

  let trial: AssertionTrial;
  try {
    trial = await verifier({ path: test.filePath, before, after, testId: test.id });
  } catch (error) {
    /*
     * A verifier that THREW did not report a pass. UNAVAILABLE, which blocks —
     * the same rule admission.ts applies to a gate that threw.
     */
    trial = {
      state: 'UNAVAILABLE',
      why: `the verifier threw: ${error instanceof Error ? error.message : String(error)}`,
      detail: [],
    };
  }

  const verdictLine =
    trial.state === 'PASSED'
      ? 'VERIFICATION: this stronger assertion PASSES against the application as it is today.'
      : trial.state === 'FAILED'
        ? 'VERIFICATION: this stronger assertion FAILS. Either the application is wrong here or QAAI ' +
          'guessed the intent wrong, and only a human can tell those apart. Read it as a finding, ' +
          'not as a tidy-up.'
        : `VERIFICATION: could not be run. ${trial.why}.`;

  const rationale = boundedRationale(
    pending.rationale.replace(/VERIFICATION: not run\.[^\n]*\./, verdictLine) +
      (trial.detail.length > 0 ? `\n\n${trial.detail.slice(0, 10).join('\n')}` : ''),
  );

  const title =
    trial.state === 'PASSED'
      ? pending.title.replace(' (unverified)', ' (verified: passes)')
      : trial.state === 'FAILED'
        ? pending.title.replace(' (unverified)', ' (verified: FAILS — read this as a finding)')
        : pending.title;

  const problems: RefactorProblem[] = unverified.problems.filter(
    (problem) => problem.kind !== 'STRENGTHENING_UNVERIFIED',
  );
  if (trial.state === 'UNAVAILABLE') {
    problems.push({
      kind: 'STRENGTHENING_UNVERIFIED',
      path: test.filePath,
      why: `the trial did not produce a verdict: ${trial.why}`,
    });
  }
  if (trial.state === 'FAILED') {
    problems.push({
      kind: 'STRENGTHENING_FAILED',
      path: test.filePath,
      why: `${trial.why} — reported as a proposal rather than suppressed, because a stronger assertion that goes red is frequently a defect we just found`,
    });
  }

  const blocked = problems.some((problem) => PROBLEM_BLOCKS_REFACTOR[problem.kind]);
  return {
    ...unverified,
    proposal: blocked ? null : { ...pending, title: boundedTitle(title), rationale },
    problems,
    trial,
    why: `strengthening ${trial.state.toLowerCase()}`,
  };
}

/**
 * Exposed for refactor.test.ts only.
 *
 * The scanners are where this module is most likely to be subtly wrong, and
 * testing them through a whole operation means a scanner bug reads as a refusal
 * with a plausible reason — which is the failure mode that makes a refusal list
 * decorative.
 */
export const __internal = {
  /*
   * The invariant gate itself, exposed because it is the one thing in this
   * module whose FAILURE path cannot be reached through the public API.
   *
   * All three operations preserve the covered surface BY CONSTRUCTION — a merge
   * copies both bodies verbatim, an extraction moves text into a file the
   * surface spans — so a legal input that makes COVERAGE_LOST fire from the
   * outside is RARE. Testing the gate only through the operations would mostly
   * test that it never fires, which is the shape of a gate that does not work.
   * So the gate is also tested directly against crafted before/after rows (real
   * rows, the real extractor).
   *
   * THIS COMMENT USED TO SAY NO SUCH INPUT EXISTS, AND THAT WAS WRONG. Adversarial
   * verification found one: `locatorBindings` is built over the whole file and
   * the last binding of a name wins, so moving one test's body past another
   * test that binds the same name re-resolves an assertion's target and a token
   * covered before is not covered after. It lives in
   * refactor.coverage.verify.test.ts, which is now what watches this gate
   * refuse a real `mergeNearDuplicates` call — because a gate whose failure
   * path is only ever reached through a test-only export is a gate nobody has
   * seen stop anything. The wiring is pinned by mutation as well as by that
   * test.
   */
  checkInvariants,
  assertionAccounting,
  readsAsJavaScript,
  matchDelim,
  blankStrings,
  balanced,
  testBlocks,
  paramNames,
  blockBindings,
  freeIdentifiers,
  setupBlockOf,
  collapseOutsideStrings,
  reindent,
  observedRelativeExtension,
  spanningCode,
  APPLYABLE_STATES,
};
