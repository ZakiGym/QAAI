/**
 * LEARNING FROM HUMAN CORRECTIONS — the free supervision this product has been
 * throwing away since `TestVersion.source` existed.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * The diff between the GENERATOR's version of a test and the FIRST HUMAN
 * version of it says exactly what reviewers always rewrite. It has been sitting
 * in the database for the life of the product and is read by NOTHING. So QAAI
 * writes CSS locators into a suite whose reviewers replace every one of them
 * with a role locator, every week, for ever, and the only record of it is a
 * `git log` nobody aggregates.
 *
 * `artifact-set.ts` owns the SHAPE: `CORRECTION_KINDS`, `classifyCorrection`,
 * `summariseCorrections`, and the `CorpusScope` brand that makes the project
 * boundary a compile error rather than a comment. This file is the part that
 * lives in the agent package because it needs the agent package's vocabularies:
 *
 *  - `CorrectionProbes` is INJECTED on purpose — `FIXED_SLEEP_PATTERNS` lives
 *    in ecosystem-prompts.ts beside the prompt rule it enforces and beside the
 *    admission gate's NO_FIXED_SLEEP check, and the assertion lexicon lives in
 *    `dialect.ts`. {@link correctionProbes} is the one place that wires both to
 *    the classifier, so "stronger assertion" means the same thing here, at the
 *    gate, and in the heal guard.
 *  - the locator vocabulary that answers "they replaced a CSS locator with WHAT"
 *    is `locatorStrategyOf` in style-learner.ts, imported rather than copied.
 *
 * ── The two honest rules this file exists to hold ──────────────────────────
 *
 * ONE. A CORPUS BELOW A STATED SIZE PRODUCES `INSUFFICIENT_DATA`, never a
 * confident pattern from three examples. {@link MIN_CORPUS_SIZE} is the floor,
 * it is stated in the briefing text rather than applied silently, and the
 * counts are still reported underneath — because the counts are facts even
 * when the conclusion is not available yet.
 *
 * TWO. AN ASSERTION A HUMAN WEAKENED IS A SIGNAL AND NOT AN INSTRUCTION. A
 * reviewer who deletes a true failing assertion is usually the reviewer being
 * wrong, or the application being under-specified. Feeding that back would
 * teach QAAI to assert less, which is the opposite of the product. So
 * `CORRECTION_IS_ACTIONABLE.ASSERTION_WEAKENED` is `false` in the keystone, and
 * here {@link PATTERN_SOURCE_KIND} is typed over
 * {@link ActionableCorrectionKind} — a pattern sourced from a non-actionable
 * kind DOES NOT COMPILE. Weakenings are reported in their own field, which
 * {@link correctionBriefing} never reads.
 *
 * ── PRIVACY, AND IT IS STRUCTURAL ──────────────────────────────────────────
 *
 * This corpus is customer test code. Nothing in it may leave the customer's
 * project boundary or be aggregated across organisations. Every function here
 * that touches rows takes a {@link CorpusScope}, which `corpusScope(orgId,
 * projectId)` is the only way to build, and re-checks every row at run time —
 * reporting `rowsRejected` rather than averaging a stranger's row in. A query
 * that could cross projects does not compile; a row that crossed anyway is
 * counted and refused.
 *
 * ── UNTRUSTED TEXT ─────────────────────────────────────────────────────────
 *
 * A "human correction" is attacker-influenced input wherever a pull request can
 * be opened, and this file's output is read back into a prompt whose output is
 * written into the repository. Every quote that leaves here goes through
 * `fenceUntrusted`; nothing in a quote decides a file path, a command, a git
 * ref or whether a gate passes. No model is called from this file.
 */

import {
  countAssertions,
  findAssertions,
  resolveDialect,
  type DialectId,
} from '@qaai/shared';
/*
 * ── IMPORTED BY RELATIVE PATH ACROSS THE WORKSPACE BOUNDARY, UNDER PROTEST ──
 *
 * `artifact-set.ts` and `style-profile.ts` are this round's keystone and neither
 * is in `packages/shared/src/index.ts`. The barrel's own comment records this
 * failure three times: a module lands as public vocabulary, `schemas.ts` reaches
 * it by a relative path INSIDE the package, `check:wiring`'s `package-exports`
 * ratchet therefore reads it as REACHED, and the shut front door surfaces as
 * TS2305 in the first sibling package that needs it.
 *
 * `packages/agent/src/boundaries.ts` carries the same block for the same reason
 * and sets the precedent: take the relative path, say so, and put the fix in the
 * handover verbatim. The alternative is a second copy of `classifyCorrection`
 * and `corpusScope` in this package — two implementations of the project
 * boundary, one of which eventually forgets `projectId`.
 *
 * THE FIX IS TWO LINES IN A FILE THIS CHANGE DOES NOT OWN:
 *
 *     export * from './style-profile';
 *     export * from './artifact-set';
 *
 * added to `packages/shared/src/index.ts` after `./dialect` and `./ecosystems`.
 * The moment they land, this block and the one in style-learner.ts collapse into
 * the `@qaai/shared` import above; no other line changes.
 */
import {
  CORRECTION_IS_ACTIONABLE,
  CORRECTION_KINDS,
  MAX_CORRECTION_QUOTE_CHARS,
  classifyCorrection,
  isRecordableCorrection,
  summariseCorrections,
  type CorpusScope,
  type CorrectionKind,
  type CorrectionProbes,
  type TestCorrection,
} from '@qaai/shared';
import { fenceUntrusted, type LocatorStrategy } from '@qaai/shared';
import { findsFixedSleep } from './ecosystem-prompts.js';
import { locatorStrategyOf } from './style-learner.js';

// ─── The probes, wired once ─────────────────────────────────────────────────

/**
 * THE ONE WIRING OF THE CLASSIFIER'S DETECTORS.
 *
 * `classifyCorrection` takes its detectors injected and has no default, which
 * was deliberate: a second copy of `FIXED_SLEEP_PATTERNS` or of the assertion
 * lexicon in the shared package is how two vocabularies for one question get
 * created, and then "the reviewer strengthened the assertion" means one thing
 * to the corpus and another to the admission gate.
 *
 * A NON-NULL DIALECT IS REQUIRED, and that is the honest half. `resolveDialect`
 * returns null for "I cannot read this test", and a probe built over a null
 * dialect would count zero assertions in a Go file and report every reviewer
 * edit as `ASSERTION_WEAKENED`. A caller holding null must refuse the pairing —
 * see {@link correctionFromVersions} and `DIALECT_UNREADABLE` — never pass a
 * guess.
 */
export function correctionProbes(dialectId: DialectId): CorrectionProbes {
  return {
    assertionCount: (code) => countAssertions(code, dialectId),
    assertionLines: (code) => findAssertions(code, dialectId).map((hit) => hit.quote),
    hasFixedSleep: (code) => findsFixedSleep(code),
  };
}

// ─── Pairing a generated version with the first human version ───────────────

/**
 * The values `TestVersion.source` has carried since the column existed. A plain
 * String in Prisma, so this is the list and nothing enforces it at the
 * database — which is exactly why a reader must not treat an unknown value as
 * one of these.
 */
export const TEST_VERSION_SOURCES = ['GENERATOR', 'HEAL', 'HUMAN', 'IMPORT'] as const;
export type TestVersionSource = (typeof TEST_VERSION_SOURCES)[number];

/**
 * Did QAAI write this version?
 *
 * Compiler-enforced over every source. `IMPORT` is `false` and it is the one
 * worth explaining: an imported suite is the customer's own pre-existing test,
 * so a diff between it and a later human edit is not supervision OF OUR
 * GENERATION — it is two humans editing a human's file, and recording it as a
 * correction would teach the generator from code it never wrote.
 */
export const SOURCE_IS_OURS = {
  GENERATOR: true,
  HEAL: true,
  HUMAN: false,
  IMPORT: false,
} as const satisfies Record<TestVersionSource, boolean>;

/** A `TestVersion` row, as this module needs it. Narrow on purpose. */
export interface VersionRow {
  readonly id: string;
  readonly version: number;
  readonly code: string;
  /** The raw column. A value outside {@link TEST_VERSION_SOURCES} is UNKNOWN, not HUMAN. */
  readonly source: string;
}

/** Why a pair could not be built. Closed, because each one means something different. */
export const PAIRING_REFUSALS = [
  /** No version QAAI wrote. Nothing to be corrected; usually an imported suite. */
  'NO_VERSION_OF_OURS',
  /** Nobody has touched it yet. Not a failure — the common case for a new test. */
  'NO_HUMAN_VERSION',
  /** The only human version predates everything we wrote. A regeneration over a human's work. */
  'HUMAN_BEFORE_OURS',
  /** `resolveDialect` could not read the test, so no probe may be built over it. */
  'DIALECT_UNREADABLE',
  /** One of the two versions is larger than {@link MAX_VERSION_CHARS}. */
  'CODE_TOO_LARGE',
  /** The reviewer saved the file without changing a byte. Supervised nothing. */
  'NO_CHANGE',
] as const;
export type PairingRefusal = (typeof PAIRING_REFUSALS)[number];

/**
 * Per-version ceiling, equal to `MAX_ARTIFACT_CHARS`.
 *
 * `classifyCorrection` is line-based over both versions at once, so the cost is
 * linear in the pair. Refused rather than truncated: half a file diffed against
 * a whole one produces a hundred spurious `removed` lines, and a corpus full of
 * those is a measurement that was not measured.
 */
export const MAX_VERSION_CHARS = 200_000;

/** One generated-versus-human pair, with the attribution a reader needs. */
export interface CorrectionPairing {
  readonly correction: TestCorrection;
  /**
   * WHICH MACHINE VERSION THE REVIEWER ACTUALLY EDITED.
   *
   * The round said "the GENERATOR v1 and the first HUMAN version", and that is
   * right until a HEAL lands between them. Diffing v1 against the human version
   * then attributes the healer's rewrite to the reviewer — a measurement nobody
   * made, in the direction that flatters us (the healer's locator fix would read
   * as a reviewer preference). So the LAST version we wrote before the first
   * human one is the `before`, and this field says which it was.
   */
  readonly oursSource: Extract<TestVersionSource, 'GENERATOR' | 'HEAL'>;
  readonly oursVersionId: string;
  readonly humanVersionId: string;
  /**
   * Could a file move have been observed at all?
   *
   * `TestVersion` has no path column, so a rename is invisible unless the caller
   * supplies both paths. False means "we did not look", NOT "the file did not
   * move" — and a `FILE_MOVED` count over rows where this was false would be a
   * pass that means "we did not check".
   */
  readonly pathMoveObservable: boolean;
}

export type PairingResult =
  | { readonly ok: true; readonly pairing: CorrectionPairing }
  | { readonly ok: false; readonly refusal: PairingRefusal; readonly why: string };

/**
 * Build one correction out of a test's version history.
 *
 * Deterministic, no model, no network. Every refusal is NAMED rather than
 * returning an empty correction, because an empty correction reads as "the
 * reviewer changed nothing" — a null that became zero, and the exact lie the
 * keystone's "a diff that exists is never classified as nothing" rule exists to
 * stop one level down.
 */
export function correctionFromVersions(args: {
  readonly testId: string;
  readonly versions: readonly VersionRow[];
  /** The test's path when we wrote it, and after the reviewer. Both or neither. */
  readonly oursPath?: string | null;
  readonly humanPath?: string | null;
  readonly surface?: string | null;
  /** Hints for `resolveDialect`. Null members are "unknown", never a default. */
  readonly filePath?: string | null;
  readonly ecosystemId?: string | null;
}): PairingResult {
  const ordered = [...args.versions].sort((a, b) => a.version - b.version);
  const firstOurs = ordered.find((row) => isOurs(row.source));
  if (!firstOurs) {
    return {
      ok: false,
      refusal: 'NO_VERSION_OF_OURS',
      why: 'no GENERATOR or HEAL version exists, so there is nothing of ours to be corrected.',
    };
  }

  /*
   * The first human version AFTER something we wrote, not the first human
   * version in the history.
   *
   * An imported suite that we later regenerated and a human then edited has a
   * HUMAN row at v1, a GENERATOR row at v2 and a HUMAN row at v3. Taking the
   * first HUMAN row would refuse that history as HUMAN_BEFORE_OURS and throw
   * away the one real correction in it — a failure suppressed without being
   * counted, over the exact history the migration wedge produces.
   */
  const human = ordered.find((row) => row.source === 'HUMAN' && row.version > firstOurs.version);
  if (!human) {
    const anyHuman = ordered.some((row) => row.source === 'HUMAN');
    return anyHuman
      ? {
          ok: false,
          refusal: 'HUMAN_BEFORE_OURS',
          why:
            'every human version precedes everything we wrote. That is a regeneration over a ' +
            "human's work, not supervision of ours, and recording it would teach the generator " +
            'from itself.',
        }
      : {
          ok: false,
          refusal: 'NO_HUMAN_VERSION',
          why:
            'no HUMAN version exists yet. Not a failure: this is the common case for a new test.',
        };
  }

  /*
   * The LAST version we wrote before that human one. See
   * `CorrectionPairing.oursSource`: if a HEAL landed between the generation and
   * the review, the reviewer edited the HEALED file, and diffing v1 would
   * attribute the healer's rewrite to the reviewer — in the direction that
   * flatters us, since a healer's locator fix would read as a reviewer
   * preference for the locator we already chose.
   */
  const ours = [...ordered]
    .reverse()
    .find((row) => isOurs(row.source) && row.version < human.version);
  if (!ours) {
    return {
      ok: false,
      refusal: 'HUMAN_BEFORE_OURS',
      why: 'no version of ours precedes the first human version after it.',
    };
  }
  if (ours.code.length > MAX_VERSION_CHARS || human.code.length > MAX_VERSION_CHARS) {
    return {
      ok: false,
      refusal: 'CODE_TOO_LARGE',
      why:
        `one of the two versions is over ${MAX_VERSION_CHARS} characters. Refused rather than ` +
        'truncated: half a file diffed against a whole one invents a hundred changed lines.',
    };
  }

  const dialectId = resolveDialect({
    filePath: args.filePath ?? null,
    ecosystemId: args.ecosystemId ?? null,
  });
  if (dialectId === null) {
    return {
      ok: false,
      refusal: 'DIALECT_UNREADABLE',
      why:
        'the assertion dialect could not be resolved, so no assertion probe may be built. A ' +
        'probe over a guessed dialect counts zero assertions in every file it cannot read and ' +
        'reports every reviewer edit as ASSERTION_WEAKENED.',
    };
  }

  /*
   * BOTH paths or neither, and the pair is carried as one value rather than as
   * a boolean beside two nullables. One path supplied would make `beforePath
   * !== afterPath` depend on which half the caller happened to know, and
   * `FILE_MOVED` would then be an artefact of the caller's query.
   */
  const oursPath = args.oursPath ?? null;
  const humanPath = args.humanPath ?? null;
  const paths =
    oursPath !== null && oursPath.length > 0 && humanPath !== null && humanPath.length > 0
      ? { ours: oursPath, human: humanPath }
      : null;
  const path = args.filePath ?? '';

  const correction = classifyCorrection(
    {
      before: ours.code,
      after: human.code,
      beforePath: paths ? paths.ours : path,
      afterPath: paths ? paths.human : path,
      testId: args.testId,
      generatedVersion: ours.version,
      humanVersion: human.version,
      /*
       * An EMPTY surface becomes NULL, and that is a floor and not a nicety.
       * `testCorrectionSchema` declares `surface: z.string().min(1)...
       * .nullable()`, so a producer that passed `''` straight through would
       * write zero rows for a whole run behind one parse error — which is the
       * producer-versus-validator shape eight of these were found one at a
       * time for, every one of them a ceiling. This one is the floor.
       */
      surface: args.surface !== null && args.surface !== undefined && args.surface.length > 0
        ? args.surface
        : null,
    },
    correctionProbes(dialectId),
  );

  /*
   * THE RULE IS ASKED OF ITS OWNER, NOT RE-SPELLED HERE.
   *
   * `isRecordableCorrection` is the recordability predicate that sits beside
   * `testCorrectionSchema`'s `kinds.min(1)` in artifact-set.ts. This read used
   * to be an inline `correction.kinds.length === 0`, which is the same test
   * today and is exactly how `ASSERTION_KEY` and the regex in
   * `specAssertions` became two vocabularies for one question: nothing made
   * the copies move together, and the producer and the validator drift apart
   * silently. Calling the predicate means a change to what counts as
   * recordable cannot leave this refusal behind.
   */
  if (!isRecordableCorrection(correction)) {
    return {
      ok: false,
      refusal: 'NO_CHANGE',
      why:
        'the two versions are byte-identical, so the reviewer supervised nothing. ' +
        '`testCorrectionSchema` refuses an empty `kinds` for the same reason.',
    };
  }

  return {
    ok: true,
    pairing: {
      correction,
      oursSource: ours.source === 'HEAL' ? 'HEAL' : 'GENERATOR',
      oursVersionId: ours.id,
      humanVersionId: human.id,
      pathMoveObservable: paths !== null,
    },
  };
}

/** A source string from the database, read conservatively: unknown is not ours. */
function isOurs(source: string): boolean {
  return (
    (TEST_VERSION_SOURCES as readonly string[]).includes(source) &&
    SOURCE_IS_OURS[source as TestVersionSource]
  );
}

// ─── What the corpus says, as a signal the generator can act on ─────────────

/**
 * A correction kind the product is allowed to LEARN from.
 *
 * Derived from `CORRECTION_IS_ACTIONABLE` rather than restated, so the two
 * cannot disagree. This is what makes rule TWO a compile error:
 * {@link PATTERN_SOURCE_KIND} is typed over this, so a pattern sourced from
 * `ASSERTION_WEAKENED` or `TEST_DELETED` does not compile — not "is filtered
 * out at run time", which is a guard somebody can delete.
 */
export type ActionableCorrectionKind = {
  [K in CorrectionKind]: (typeof CORRECTION_IS_ACTIONABLE)[K] extends true ? K : never;
}[CorrectionKind];

/**
 * WHAT A PROJECT'S REVIEWERS KEEP DOING, in the vocabulary the generator acts
 * on.
 *
 * One per actionable kind that implies a change to how we write. Each is a
 * sentence a prompt can state: "reviewers in this project replace CSS locators
 * with role locators", "reviewers extract setup into a helper".
 *
 * NOT `CorrectionPattern`, which is already taken: `triage.ts` publishes that
 * name through this package's barrel for a from->to VERDICT override, a
 * different thing entirely. Two unrelated shapes under one name in one barrel
 * is TS2308, and the collision would have landed the moment this module was
 * re-exported — so the name is distinct here rather than aliased there.
 */
export const REVIEWER_PATTERNS = [
  'PREFER_LOCATOR_STRATEGY',
  'EXTRACT_SETUP',
  'EXTRACT_DATASET',
  'SPLIT_TESTS',
  'RENAME_TESTS',
  'MOVE_FILES',
  'DROP_FIXED_SLEEP',
  'ASSERT_MORE',
] as const;
export type ReviewerPattern = (typeof REVIEWER_PATTERNS)[number];

/**
 * Which correction kind each pattern is computed from.
 *
 * The value type is {@link ActionableCorrectionKind}, which is rule TWO as a
 * type: putting `ASSERTION_WEAKENED` here is a compile error, so QAAI cannot
 * learn to assert less because a reviewer once deleted a true failing
 * assertion. `FORMATTING_ONLY` and `UNCLASSIFIED` are excluded by the same
 * mechanism — a formatter's output is not a reviewer's objection, and a diff we
 * could not name is not a lesson.
 */
export const PATTERN_SOURCE_KIND = {
  PREFER_LOCATOR_STRATEGY: 'LOCATOR_CHANGED',
  EXTRACT_SETUP: 'HELPER_SUBSTITUTED',
  EXTRACT_DATASET: 'DATA_EXTRACTED',
  SPLIT_TESTS: 'TEST_SPLIT',
  RENAME_TESTS: 'NAMING_CHANGED',
  MOVE_FILES: 'FILE_MOVED',
  DROP_FIXED_SLEEP: 'WAIT_REMOVED',
  ASSERT_MORE: 'ASSERTION_STRENGTHENED',
} as const satisfies Record<ReviewerPattern, ActionableCorrectionKind>;

/** What the generator is told to do about each pattern. Our words, not the corpus's. */
export const PATTERN_INSTRUCTION: Record<ReviewerPattern, string> = {
  PREFER_LOCATOR_STRATEGY: 'reviewers here rewrite the locators we generate',
  EXTRACT_SETUP: 'reviewers here replace our inline setup with a call to an existing helper',
  EXTRACT_DATASET: 'reviewers here pull our inline literals out into shared data',
  SPLIT_TESTS: 'reviewers here split the tests we generate into smaller ones',
  RENAME_TESTS: 'reviewers here rewrite the test titles we generate',
  MOVE_FILES: 'reviewers here move the files we generate to a different path',
  DROP_FIXED_SLEEP: 'reviewers here delete the fixed waits we generate',
  ASSERT_MORE: 'reviewers here add assertions to the tests we generate',
};

/**
 * Corrections needed before any pattern may be stated.
 *
 * Ten, and it is a judgement call made in the honest direction. Three
 * corrections that all changed a locator is a coincidence a reviewer would
 * laugh at; the cost of waiting is that a new project gets the ecosystem
 * default for a few weeks, which is a convention somebody follows. The cost of
 * not waiting is a confidently wrong instruction in every prompt.
 */
export const MIN_CORPUS_SIZE = 10;

/** Rows carrying a kind before it may be called a pattern. */
export const MIN_PATTERN_ROWS = 3;

/** And that many rows must be this share of the corpus. Both halves, as everywhere here. */
export const MIN_PATTERN_SHARE = 0.4;

/**
 * A locator migration needs this share of the locator changes before it is
 * named as a TARGET. Below it the pattern still fires — reviewers demonstrably
 * rewrite our locators — but with no target, which is the honest statement.
 */
export const MIN_MIGRATION_SHARE = 0.5;

/** Rows naming one surface before "reviewers delete what we generate here" is stated. */
export const MIN_SURFACE_DELETIONS = 2;

/**
 * Rows read in one summary.
 *
 * The caller orders by `createdAt` DESC, so the cap drops the OLDEST rows —
 * reviewer behaviour changes and a four-year-old correction is not evidence
 * about this quarter's reviewers. Whatever it dropped is reported as
 * `rowsOmitted`, because a cap applied without being disclosed turns "40% of
 * corrections are locators" into a number over a window nobody can see.
 */
export const MAX_CORPUS_ROWS = 2_000;

/** Quotes kept per pattern, for the briefing. Evidence, not a code listing. */
export const MAX_PATTERN_EXAMPLES = 3;

/**
 * Whether the corpus can support a conclusion. Three states, and the first is
 * the one this module exists to be able to say.
 */
export const SIGNAL_STATES = ['INSUFFICIENT_DATA', 'NO_PATTERN', 'PATTERN'] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

/** A row as the corpus stores it: a correction plus the two ids that scope it. */
export type ScopedCorrection = TestCorrection & {
  readonly orgId: string;
  readonly projectId: string;
};

export interface LocatorMigration {
  /** Null is "the quote did not name a strategy", never a default. */
  readonly from: LocatorStrategy | null;
  readonly to: LocatorStrategy | null;
  readonly items: number;
}

export interface PatternFinding {
  readonly pattern: ReviewerPattern;
  readonly sourceKind: ActionableCorrectionKind;
  readonly rows: number;
  /** `rows / corpusSize`, so the fraction travels with the claim. */
  readonly share: number;
  /**
   * The specific form, when one reached {@link MIN_MIGRATION_SHARE} — "CSS →
   * ROLE". Null means the pattern is real and its target is not established,
   * which is a different statement from "there is no target".
   */
  readonly detail: string | null;
  /** Bounded quotes from the corpus. UNTRUSTED; rendered only fenced. */
  readonly examples: readonly string[];
}

/** Surfaces whose generated tests reviewers keep deleting. Reported, never acted on alone. */
export interface SurfaceDeletion {
  /** UNTRUSTED customer text. Bounded and rendered only fenced. */
  readonly surface: string;
  readonly rows: number;
}

export interface CorrectionSignal {
  /**
   * Whether a STYLE pattern may be stated. It describes {@link patterns} only:
   * {@link surfacesDeleted} is a separate channel with its own floor, and a
   * corpus can legitimately be NO_PATTERN about how we write while being very
   * clear about where we should stop writing.
   */
  readonly state: SignalState;
  /** Rows in scope and inside {@link MAX_CORPUS_ROWS}. The denominator for every share. */
  readonly corpusSize: number;
  /** Rows from another project or org. REFUSED AND COUNTED, never averaged in. */
  readonly rowsRejected: number;
  /** Rows {@link MAX_CORPUS_ROWS} refused to read. A cap, counted. */
  readonly rowsOmitted: number;
  /**
   * Rows whose own `itemsOmitted` is non-zero: their kind breakdown is a SAMPLE
   * of a rewrite, not a census of it. Surfaced because the keystone went to the
   * trouble of recording it per row and a summary that drops it re-creates the
   * lie the column was added to prevent.
   */
  readonly rowsSampled: number;
  /**
   * Classifier versions present. More than one means the corpus was classified
   * by two different detectors, so a trend across it is partly an artefact of
   * our own deploys — which is why the column exists and why this is reported.
   */
  readonly classifierVersions: readonly number[];
  readonly byKind: Readonly<Record<CorrectionKind, number>>;
  readonly actionable: number;
  readonly unclassified: number;
  readonly patterns: readonly PatternFinding[];
  readonly locatorMigrations: readonly LocatorMigration[];
  /**
   * WEAKENINGS, REPORTED SEPARATELY AND NEVER FED BACK.
   *
   * A human who deleted one of our assertions is telling us something — usually
   * that the application is under-specified, sometimes that the assertion was
   * wrong — and it belongs in front of a person. It is NOT a style preference,
   * {@link correctionBriefing} does not read this field, and
   * {@link PATTERN_SOURCE_KIND} cannot be given a kind that would make it one.
   */
  readonly weakenings: {
    readonly rows: number;
    /** UNTRUSTED. Bounded. For a human-facing page, not for a prompt. */
    readonly examples: readonly string[];
  };
  /**
   * Surfaces where reviewers keep deleting what we generate.
   *
   * Reported separately from {@link patterns} because `TEST_DELETED` is not
   * actionable in the keystone's sense: no prompt change fixes it. The honest
   * action is to ASK before generating there again — and the surface STAYS IN
   * THE COVERAGE DENOMINATOR either way, because a surface we stopped testing
   * is uncovered, not out of scope. Shrinking the denominator because reviewers
   * reject our tests would make the coverage number go up for the worst
   * possible reason.
   */
  readonly surfacesDeleted: readonly SurfaceDeletion[];
  /** Why the state is what it is, in one sentence, for a log and for the briefing. */
  readonly why: string;
}

/**
 * Turn a project's correction rows into a signal the generator can act on.
 *
 * SCOPED, and the scope is re-checked here as well as at the query. The
 * compile-time brace is `corpusWhere`, which cannot be built without both ids;
 * this is the run-time belt, and a row that arrived from another project is
 * COUNTED and refused rather than averaged in. `rowsRejected` is asserted
 * against `summariseCorrections`' own count in the tests, so the two cannot
 * drift into disagreeing about what "in scope" means.
 */
export function summariseCorpus(
  scope: CorpusScope,
  rows: readonly ScopedCorrection[],
): CorrectionSignal {
  // The keystone owns byKind / actionable / unclassified / rowsRejected. Called
  // rather than re-implemented: two group-bys over one table is how the
  // dashboard and the prompt come to report different numbers.
  const base = summariseCorrections(scope, rows);

  const inScope = rows.filter(
    (row) => row.orgId === scope.orgId && row.projectId === scope.projectId,
  );
  const read = inScope.slice(0, MAX_CORPUS_ROWS);
  const corpusSize = read.length;

  const classifierVersions = [...new Set(read.map((row) => row.classifierVersion))].sort(
    (a, b) => a - b,
  );

  const migrations = locatorMigrationsOf(read);
  const patterns = corpusSize >= MIN_CORPUS_SIZE ? patternsOf(read, corpusSize, migrations) : [];

  const weakeningRows = read.filter((row) => row.kinds.includes('ASSERTION_WEAKENED'));
  const surfacesDeleted = surfaceDeletionsOf(read);

  const state: SignalState =
    corpusSize < MIN_CORPUS_SIZE ? 'INSUFFICIENT_DATA' : patterns.length > 0 ? 'PATTERN' : 'NO_PATTERN';

  return {
    state,
    corpusSize,
    rowsRejected: base.rowsRejected,
    rowsOmitted: Math.max(0, inScope.length - read.length),
    rowsSampled: read.filter((row) => row.itemsOmitted > 0).length,
    classifierVersions,
    byKind: base.byKind,
    actionable: base.actionable,
    unclassified: base.unclassified,
    patterns,
    locatorMigrations: migrations,
    weakenings: {
      rows: weakeningRows.length,
      examples: quotesFor(weakeningRows, 'ASSERTION_WEAKENED'),
    },
    surfacesDeleted,
    why: whyFor(state, corpusSize, patterns.length),
  };
}

function whyFor(state: SignalState, corpusSize: number, patterns: number): string {
  switch (state) {
    case 'INSUFFICIENT_DATA':
      return (
        `${corpusSize} correction(s) in this project; ${MIN_CORPUS_SIZE} is the floor. Counts are ` +
        'reported below and no pattern is stated, because three examples of anything is a ' +
        'coincidence and a confidently wrong instruction costs every prompt.'
      );
    case 'NO_PATTERN':
      return (
        `${corpusSize} correction(s) read and no kind reached ${MIN_PATTERN_ROWS} row(s) at ` +
        `${Math.round(MIN_PATTERN_SHARE * 100)}% of the corpus. Reviewers here change different ` +
        'things each time, which is a real answer and not a gap.'
      );
    case 'PATTERN':
      return `${patterns} pattern(s) reached the floor over ${corpusSize} correction(s).`;
  }
}

function patternsOf(
  rows: readonly ScopedCorrection[],
  corpusSize: number,
  migrations: readonly LocatorMigration[],
): readonly PatternFinding[] {
  const findings: PatternFinding[] = [];
  for (const pattern of REVIEWER_PATTERNS) {
    const sourceKind = PATTERN_SOURCE_KIND[pattern];
    const carrying = rows.filter((row) => row.kinds.includes(sourceKind));
    if (carrying.length < MIN_PATTERN_ROWS) continue;
    const share = carrying.length / corpusSize;
    if (share < MIN_PATTERN_SHARE) continue;
    findings.push({
      pattern,
      sourceKind,
      rows: carrying.length,
      share,
      detail: pattern === 'PREFER_LOCATOR_STRATEGY' ? dominantMigration(migrations) : null,
      examples: quotesFor(carrying, sourceKind),
    });
  }
  return findings.sort((a, b) => b.rows - a.rows || a.pattern.localeCompare(b.pattern));
}

/**
 * Which locator strategy reviewers move us FROM and TO.
 *
 * `locatorStrategyOf` is style-learner.ts's, imported rather than copied: the
 * profile answers "what does this repository locate with" and this answers
 * "what did the reviewer change ours into", and they have to be the same seven
 * patterns or the two halves of this round disagree about what a role locator
 * is.
 *
 * A quote that names no strategy yields `null`, which is kept as its own entry
 * rather than dropped. An `after` of `''` is the classifier saying it found no
 * replacement line, and counting that as "migrated to nothing" would make
 * `MIN_MIGRATION_SHARE` compare a real target against an absence.
 */
export function locatorMigrationsOf(
  rows: readonly ScopedCorrection[],
): readonly LocatorMigration[] {
  const counts = new Map<string, LocatorMigration & { items: number }>();
  for (const row of rows) {
    for (const item of row.items) {
      if (item.kind !== 'LOCATOR_CHANGED') continue;
      const from = locatorStrategyOf(item.before);
      const to = item.after.length === 0 ? null : locatorStrategyOf(item.after);
      const key = `${from ?? '?'}>${to ?? '?'}`;
      const existing = counts.get(key);
      if (existing) counts.set(key, { ...existing, items: existing.items + 1 });
      else counts.set(key, { from, to, items: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.items - a.items ||
      `${a.from ?? ''}${a.to ?? ''}`.localeCompare(`${b.from ?? ''}${b.to ?? ''}`),
  );
}

/**
 * The migration worth naming, or null.
 *
 * Only a migration with BOTH ends known and at least
 * {@link MIN_MIGRATION_SHARE} of every locator item behind it. Below that the
 * pattern still fires with `detail: null`: "reviewers rewrite our locators" is
 * established, "they always move to role locators" is not, and stating the
 * second from the evidence for the first is how a prompt comes to insist on a
 * strategy the repository does not use.
 */
function dominantMigration(migrations: readonly LocatorMigration[]): string | null {
  const total = migrations.reduce((sum, migration) => sum + migration.items, 0);
  if (total === 0) return null;
  const top = migrations.find((migration) => migration.from !== null && migration.to !== null);
  if (!top || top.items / total < MIN_MIGRATION_SHARE) return null;
  return `${String(top.from)} → ${String(top.to)} (${top.items} of ${total} locator change(s))`;
}

/**
 * Surfaces whose generated tests reviewers delete.
 *
 * `surface: null` is "the test declared no surface", NOT "no surface", so those
 * rows are excluded from this tally rather than bucketed under an empty string
 * — an empty-string surface would show up in the briefing as a rule about a
 * page that does not exist.
 */
function surfaceDeletionsOf(rows: readonly ScopedCorrection[]): readonly SurfaceDeletion[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.kinds.includes('TEST_DELETED')) continue;
    if (row.surface === null || row.surface.length === 0) continue;
    const surface = row.surface.slice(0, 200);
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, rowCount]) => rowCount >= MIN_SURFACE_DELETIONS)
    .map(([surface, rowCount]) => ({ surface, rows: rowCount }))
    .sort((a, b) => b.rows - a.rows || a.surface.localeCompare(b.surface));
}

/** Bounded quotes of one kind, for evidence. UNTRUSTED; only ever rendered fenced. */
function quotesFor(
  rows: readonly ScopedCorrection[],
  kind: CorrectionKind,
): readonly string[] {
  const quotes: string[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      if (item.kind !== kind) continue;
      quotes.push(
        `${item.before} → ${item.after.length > 0 ? item.after : '(no replacement line found)'}`.slice(
          0,
          MAX_CORRECTION_QUOTE_CHARS * 2,
        ),
      );
      if (quotes.length >= MAX_PATTERN_EXAMPLES) return quotes;
    }
  }
  return quotes;
}

// ─── Putting the signal in front of a model ─────────────────────────────────

/**
 * THE ONLY SANCTIONED RENDERING OF A CORRECTION SIGNAL INTO A PROMPT.
 *
 * Deterministic and model-free: this is text a model RECEIVES, not text a model
 * produced, so it works with no API key — which is the whole requirement.
 *
 * Five properties, each of which would be a defect if it were missing:
 *
 *  - INSUFFICIENT_DATA renders as a single honest line and NO pattern. A
 *    briefing that hedged ("reviewers may prefer role locators") would be a
 *    rule a model follows.
 *  - Every stated pattern carries its fraction inline, for the same reason
 *    `styleProfileBriefing` does: a model told "9 of 10 corrections rewrote our
 *    locators" behaves differently from one told "use role locators", and so
 *    does the human reading the prompt in a trace.
 *  - EVERY CAP IS DISCLOSED. `rowsOmitted`, `rowsSampled` and a mixed
 *    `classifierVersions` are all stated, because each one means the percentages
 *    above them describe a window rather than a census.
 *  - WEAKENINGS ARE NOT READ. This function never touches `signal.weakenings`.
 *    That is rule TWO, and the type system holds the other half of it.
 *  - Every quote from the corpus is fenced. Our instructions are OUR words over
 *    a closed vocabulary; the quotes are the reviewer's, and a reviewer is
 *    attacker-influenced input wherever a pull request can be opened.
 */
export function correctionBriefing(signal: CorrectionSignal): string {
  const lines: string[] = [];

  /*
   * INSUFFICIENT_DATA returns here and says ONE honest line, and that includes
   * saying nothing about `surfacesDeleted`: below the corpus floor every
   * channel is below it, and "reviewers always delete what we write for /admin"
   * drawn from two rows out of four is the same coincidence in a different
   * field. The counts stay on the signal for a human-facing page.
   */
  if (signal.state === 'INSUFFICIENT_DATA') {
    return (
      'WHAT REVIEWERS IN THIS PROJECT CHANGE: not established. ' +
      `${signal.corpusSize} correction(s) have been recorded and ${MIN_CORPUS_SIZE} is the ` +
      'floor, so no preference is stated. Follow the repository conventions above and the ' +
      'ecosystem defaults; do not infer a reviewer preference from nothing.'
    );
  }

  if (signal.state === 'NO_PATTERN') {
    /*
     * No STYLE pattern, which does not end the briefing: the surface channel
     * and the caveats below are separate findings with separate floors, and an
     * early return here was a real defect — a project whose reviewers delete
     * every /admin smoke test we write, but who change something different
     * about every other test, got told nothing at all.
     */
    lines.push(
      'WHAT REVIEWERS IN THIS PROJECT CHANGE: no single thing. ' +
        `${signal.corpusSize} correction(s) were read and no kind of change reached ` +
        `${MIN_PATTERN_ROWS} corrections at ${Math.round(MIN_PATTERN_SHARE * 100)}% of the ` +
        'corpus. Follow the repository conventions above.',
    );
  } else {
    lines.push(
      'WHAT REVIEWERS IN THIS PROJECT ALWAYS CHANGE, measured from what they did to tests we ' +
        `wrote (${signal.corpusSize} correction(s)). Write the test they would not have to ` +
        'rewrite. Each fraction is the evidence.',
    );
    for (const finding of signal.patterns) {
      lines.push(
        `- ${PATTERN_INSTRUCTION[finding.pattern]} ` +
          `(${finding.rows} of ${signal.corpusSize} corrections)` +
          (finding.detail ? `: ${finding.detail}` : ''),
      );
    }
  }

  if (signal.surfacesDeleted.length > 0) {
    lines.push(
      'SURFACES WHERE REVIEWERS DELETED WHAT WE GENERATED. Do not generate a smoke test for ' +
        'these without a specific reason to; a deletion is not a reason to stop MEASURING the ' +
        'surface, only to stop writing the same test for it.',
      fenceUntrusted({
        label: 'SURFACE KEYS FROM THE CUSTOMER PROJECT',
        text: signal.surfacesDeleted
          .map((entry) => `${entry.surface} (${entry.rows} deletion(s))`)
          .join('\n'),
      }),
    );
  }

  const disclosures: string[] = [];
  if (signal.rowsOmitted > 0) {
    disclosures.push(
      `${signal.rowsOmitted} older correction(s) were not read (the ${MAX_CORPUS_ROWS}-row cap), ` +
        'so the fractions above describe a window and not the whole history',
    );
  }
  if (signal.rowsSampled > 0) {
    disclosures.push(
      `${signal.rowsSampled} correction(s) were large enough that only part of the diff was ` +
        'classified, so their kind breakdown is a sample',
    );
  }
  if (signal.classifierVersions.length > 1) {
    disclosures.push(
      `the corpus was classified by ${signal.classifierVersions.length} different versions of ` +
        'the classifier, so part of any trend in it is ours and not the reviewers\'',
    );
  }
  if (signal.unclassified > 0) {
    disclosures.push(
      `${signal.unclassified} change(s) could not be named at all and are counted as ` +
        'unclassified rather than bucketed',
    );
  }
  if (disclosures.length > 0) {
    lines.push(`CAVEATS ON THE NUMBERS ABOVE: ${disclosures.join('; ')}.`);
  }

  const examples = signal.patterns.flatMap((finding) =>
    finding.examples.map((quote) => `${finding.pattern}: ${quote}`),
  );
  if (examples.length > 0) {
    lines.push(
      'WHAT THE REVIEWERS ACTUALLY WROTE, as evidence for the rules above:',
      fenceUntrusted({
        label: 'REVIEWER EDITS FROM THE CUSTOMER REPOSITORY',
        text: examples.join('\n'),
      }),
    );
  }

  return lines.join('\n');
}

/**
 * Every correction kind, for a caller that renders the breakdown. Re-exported
 * so a dashboard does not have to reach past this module into the shared one
 * for the key order — and so the order it renders is the order the keystone
 * declares.
 */
export const CORRECTION_KIND_ORDER: readonly CorrectionKind[] = CORRECTION_KINDS;
