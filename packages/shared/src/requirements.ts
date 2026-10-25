/**
 * The spec side of the denominator: the surface a HUMAN declared.
 *
 * WHY THIS FILE EXISTS
 *
 * `surface.ts` is the inventory of things that EXIST — a route the repo
 * declares, an endpoint a crawl reached. Every declarer it names reads an
 * artifact a machine produced. That leaves out the oldest and largest record of
 * what an application is supposed to do: the acceptance criteria somebody
 * wrote, and the manual test cases somebody has been running by hand for three
 * years. Neither is in this repo today, in any shape, which makes two questions
 * unaskable:
 *
 *   1. "Which acceptance criterion has no test?" The enterprise question. Xray
 *      and Zephyr answer it against a denominator of human-typed tickets, which
 *      is their entire traceability product. QAAI could not ask it at all,
 *      because there was no Requirement entity to ask it about.
 *   2. "What is specified and not yet built?" A behaviour with a criterion and
 *      no code is the one surface no extractor and no crawl can ever find —
 *      there is nothing to extract and nothing to reach — and it is also the
 *      only surface where a generated test is useful BEFORE the feature lands.
 *
 * THE HONESTY COLUMN, AND WHY IT IS THE POINT OF THE WHOLE FILE
 *
 * A requirement→test link is a CLAIM, and the claims differ enormously in
 * strength. A human pointing at a test and saying "this covers AC-3" and a
 * regex noticing that a spec title contains the string `AC-3` are not the same
 * fact, and a traceability matrix that renders them identically is worse than
 * no matrix: it launders a guess into an audit artifact. So the method is
 * stored ({@link REQUIREMENT_LINK_METHODS}), the confidence a method may claim
 * is CAPPED by the method ({@link clampLinkConfidence}), and the cap is
 * reported when it bites.
 *
 * THE THREE STATES THAT DO THE WORK HERE
 *
 * Exactly as in `surface.ts`, silence and a negative answer are different
 * facts and this file refuses to spell them the same way:
 *
 *   · NOT_SEARCHED vs NOT_LINKED — "no linker has ever run over this
 *     requirement" vs "a linker ran and found nothing". The second is the
 *     product's most valuable output; the first is an admission. Reporting the
 *     first as the second manufactures findings, which is the same sin as
 *     hiding them and is harder to notice.
 *   · NOT_STATED vs NOT_AUTOMATED — a TestRail suite that carries no automation
 *     field at all vs one that says "not automated". Folding the first into the
 *     second inflates the automation backlog, which is a number we would then
 *     be quoting at the customer.
 *   · NOT_COMPARABLE vs UNCHANGED — a stored row with no content hash cannot be
 *     diffed against a re-import. Calling that UNCHANGED means a re-import
 *     silently drops an edit; calling it CHANGED re-opens every link in the
 *     project. It is neither ({@link classifyReimport}).
 *
 * WHAT THIS FILE IS NOT
 *
 * It stores nothing and reads nothing. It is the vocabulary and the arithmetic
 * — the enums the Prisma models mirror, the write-path schemas, and the handful
 * of derivations (`linkStateFrom`, `clampLinkConfidence`, `manualBacklogTotals`)
 * that must have exactly one implementation or the stored column and the rows
 * it summarises will come to disagree. The importers live in packages/agent and
 * apps/worker; the rows live in apps/api/prisma/schema.prisma.
 */

import { z } from 'zod';

// ─── Where a specification came from ─────────────────────────────────────────

/**
 * The systems a requirement or a manual test case can be read out of.
 *
 * One list and not two, deliberately. A tracker (Jira, Linear) and a test
 * management suite (TestRail, Xray) are different products, but the column is
 * answering one question — "whose copy of this is authoritative, and where does
 * a re-import go to ask again?" — and splitting it into two enums would mean
 * two drift guards and two `Record` tables for one fact. {@link
 * TEST_MANAGEMENT_SYSTEMS} narrows it where the distinction matters.
 *
 * MARKDOWN and CSV are not lesser members. A criteria file in the repo is the
 * only source some teams have, it round-trips through code review, and it is
 * the one source QAAI can read with no credentials at all.
 */
export const SPEC_SOURCE_SYSTEMS = [
  'JIRA',
  'LINEAR',
  'AZURE_DEVOPS',
  'GITHUB_ISSUES',
  'XRAY',
  'ZEPHYR',
  'TESTRAIL',
  'QTEST',
  /** A file in the customer's repository — `docs/requirements/*.md` and friends. */
  'MARKDOWN',
  /** An exported sheet. The lowest-ceremony import and often the first one. */
  'CSV',
  /** Typed into QAAI. The only declarer for a requirement that lives in a head. */
  'MANUAL',
] as const;
export type SpecSourceSystem = (typeof SPEC_SOURCE_SYSTEMS)[number];

export const SPEC_SOURCE_SYSTEM_LABELS: Record<SpecSourceSystem, string> = {
  JIRA: 'Jira',
  LINEAR: 'Linear',
  AZURE_DEVOPS: 'Azure DevOps',
  GITHUB_ISSUES: 'GitHub Issues',
  XRAY: 'Xray',
  ZEPHYR: 'Zephyr',
  TESTRAIL: 'TestRail',
  QTEST: 'qTest',
  MARKDOWN: 'a Markdown file in the repository',
  CSV: 'a CSV export',
  MANUAL: 'entered by hand',
};

/**
 * The four that hold a MANUAL TEST SUITE rather than a backlog.
 *
 * Load-bearing for one sentence the product wants to say: "your TestRail suite
 * has 1,840 cases, 210 are automated, here are the other 1,630." A Jira
 * project's issue count is not that number and must never be added to it.
 */
export const TEST_MANAGEMENT_SYSTEMS: readonly SpecSourceSystem[] = [
  'XRAY',
  'ZEPHYR',
  'TESTRAIL',
  'QTEST',
];

// ─── A requirement's lifecycle ───────────────────────────────────────────────

/**
 * The NORMALISED status of a requirement, alongside the source system's own
 * word (which is kept verbatim on the row and never thrown away).
 *
 * Two members exist purely so that this normalisation cannot lie:
 *
 *   · NOT_STATED — the import found no status field. Jira always has one; a
 *     Markdown criteria file usually does not.
 *   · UNMAPPED — there WAS a status and our mapping table does not know the
 *     word. The raw value is on the row for a human to read.
 *
 * Without those two, every unrecognised workflow state in every customer's Jira
 * would land on whichever member we picked as a default — and the default would
 * decide whether the requirement entered the denominator. That is a coverage
 * percentage moved by a mapping table nobody reviewed.
 */
export const REQUIREMENT_STATUSES = [
  /** Written, not agreed. The behaviour may still change completely. */
  'DRAFT',
  /** Agreed and not built. The only state where a test is expected to FAIL. */
  'READY',
  'IN_PROGRESS',
  /** Built. A failing test here is a defect, not a prophecy. */
  'DONE',
  /** Withdrawn. Must not be a coverage gap — see {@link OBSOLETE_STATUSES}. */
  'OBSOLETE',
  /** A status we could not map. `statusRaw` holds what the source said. */
  'UNMAPPED',
  /** The source declared no status at all. Not the same as DRAFT. */
  'NOT_STATED',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_STATUS_LABELS: Record<RequirementStatus, string> = {
  DRAFT: 'draft — not agreed',
  READY: 'agreed, not built',
  IN_PROGRESS: 'being built',
  DONE: 'built',
  OBSOLETE: 'withdrawn',
  UNMAPPED: 'the source system used a status we do not recognise',
  NOT_STATED: 'the source system declared no status',
};

/**
 * Statuses that take a requirement OUT of the coverage denominator.
 *
 * Only the withdrawn one. A withdrawn requirement with no test is not a gap —
 * it is a requirement nobody wants any more — and counting it would produce a
 * gap no work can ever close, which is the shape of target that gets gamed
 * instead of met. The same argument as `EXCLUDED_STATUSES` in surface.ts, and
 * deliberately NOT extended to UNMAPPED or NOT_STATED: dropping the ones we
 * failed to classify would make our own parsing errors raise the percentage.
 */
export const OBSOLETE_STATUSES: readonly RequirementStatus[] = ['OBSOLETE'];

/** Whether this requirement belongs in a coverage denominator at all. */
export function requirementCounts(status: RequirementStatus): boolean {
  return !OBSOLETE_STATUSES.includes(status);
}

/**
 * Whether a test written for this requirement is expected to PASS today.
 *
 * The distinction generation needs and nothing else in the repo can express. A
 * READY requirement's test should fail — the feature is not built — and a
 * generator that treats that failure as a defect will file a bug against an
 * unwritten feature, while a gate that treats it as coverage will go green on a
 * test asserting something that does not exist.
 *
 * UNKNOWN is returned for the two states that are admissions rather than facts,
 * and it is never collapsed into either answer: "we do not know whether this is
 * built" is the true sentence, and a caller that wants to proceed anyway has to
 * say so in its own code rather than inherit a guess from here.
 */
export const REQUIREMENT_TESTABILITIES = ['TESTABLE_NOW', 'NOT_YET_BUILT', 'UNKNOWN'] as const;
export type RequirementTestability = (typeof REQUIREMENT_TESTABILITIES)[number];

export function requirementTestability(status: RequirementStatus): RequirementTestability {
  switch (status) {
    case 'DONE':
      return 'TESTABLE_NOW';
    case 'DRAFT':
    case 'READY':
    case 'IN_PROGRESS':
      return 'NOT_YET_BUILT';
    case 'OBSOLETE':
    case 'UNMAPPED':
    case 'NOT_STATED':
      return 'UNKNOWN';
  }
}

// ─── Acceptance criteria, as rows ────────────────────────────────────────────

/**
 * The shape a criterion was written in, which decides whether a machine can do
 * anything with it.
 *
 * A row per criterion rather than one prose body is the whole point of the
 * entity: "which acceptance criterion has no test?" is a question about rows,
 * and a paragraph containing four criteria is one uncoverable thing instead of
 * four coverable ones. This enum then says how much structure survived the
 * import, because a GIVEN_WHEN_THEN criterion is a test skeleton and an
 * UNSTRUCTURED one is a sentence we split on a full stop and should not pretend
 * otherwise.
 */
export const ACCEPTANCE_CRITERION_FORMATS = [
  /** `Given … When … Then …`, in any casing. Directly generatable. */
  'GIVEN_WHEN_THEN',
  /** A `-` or `*` bullet. One criterion per bullet, which is usually right. */
  'BULLET',
  /** `1.` / `1)` numbering, which usually implies an ordered flow. */
  'NUMBERED',
  /*
   * A Markdown task-list item. Its tick is a claim about PROGRESS and never
   * about coverage, so the box being checked must not be read as "tested".
   *
   * The literal syntax is deliberately not written out here, and neither is
   * the regex below. `tsConstMembers` in apps/api/scripts/check-enums.ts reads
   * this array with a character class that stops at the first closing square
   * bracket, so ONE such bracket anywhere inside this literal — in a member or
   * in a comment — truncates the parse, and the drift guard then compares three
   * of the six members and reports agreement. Observed: it did exactly that
   * when this member's doc comment quoted Markdown's task-list syntax.
   */
  'CHECKBOX',
  /** A row of a table — Xray's and Zephyr's native shape. */
  'TABLE_ROW',
  /**
   * We could find no structure and fell back to sentence splitting. Reported,
   * not hidden: a criterion count derived this way is an estimate, and the
   * report says so rather than printing it next to the exact ones.
   */
  'UNSTRUCTURED',
] as const;
export type AcceptanceCriterionFormat = (typeof ACCEPTANCE_CRITERION_FORMATS)[number];

export const ACCEPTANCE_CRITERION_FORMAT_LABELS: Record<AcceptanceCriterionFormat, string> = {
  GIVEN_WHEN_THEN: 'Given / When / Then',
  BULLET: 'a bullet',
  NUMBERED: 'a numbered step',
  CHECKBOX: 'a checklist item',
  TABLE_ROW: 'a table row',
  UNSTRUCTURED: 'prose we split into sentences — an estimate, not a parse',
};

/**
 * Formats a generator can turn into a test skeleton without inventing the
 * structure itself.
 *
 * `UNSTRUCTURED` is deliberately out. A sentence-split criterion can still be
 * generated FROM, but the structure would be the model's invention rather than
 * the customer's specification, and the report has to be able to say which of
 * the two it is.
 */
export const STRUCTURED_CRITERION_FORMATS: readonly AcceptanceCriterionFormat[] = [
  'GIVEN_WHEN_THEN',
  'BULLET',
  'NUMBERED',
  'CHECKBOX',
  'TABLE_ROW',
];

// ─── How a link was made: the honesty column ─────────────────────────────────

/**
 * How a requirement came to be linked to a test or a surface.
 *
 * Ranked by what each one PROVES, which is also the order of
 * {@link LINK_METHOD_CONFIDENCE_CEILING}:
 *
 *   MANUAL            a person asserted it. The only method that is evidence
 *                     about INTENT rather than about spelling.
 *   ID_IN_ANNOTATION  the test carries a machine-readable tag — a Playwright
 *                     annotation, a `@requirement AC-3` docblock. Nearly as
 *                     strong as MANUAL: somebody typed it on purpose, in a
 *                     place whose only purpose is to say this.
 *   ID_IN_TEST_NAME   the requirement's external id appears in the test's
 *                     title. Usually right and occasionally an accident —
 *                     `PROJ-1` is a substring of `PROJ-10`, and a suite that
 *                     numbers its own cases will collide with a tracker that
 *                     numbers its tickets.
 *   SURFACE_MATCH     the requirement mentions a route and a test touches that
 *                     route. A guess, and the weakest claim in the product: the
 *                     requirement said "the checkout page must …" and some test
 *                     visits /checkout. It is kept because it is the only method
 *                     that works on a suite with no ids anywhere, and it is
 *                     capped hard so it cannot masquerade as traceability.
 *
 * A matrix that renders these identically launders the last one into an audit
 * artifact, which is the specific failure this enum exists to prevent.
 */
export const REQUIREMENT_LINK_METHODS = [
  'MANUAL',
  'ID_IN_ANNOTATION',
  'ID_IN_TEST_NAME',
  'SURFACE_MATCH',
] as const;
export type RequirementLinkMethod = (typeof REQUIREMENT_LINK_METHODS)[number];

export const REQUIREMENT_LINK_METHOD_LABELS: Record<RequirementLinkMethod, string> = {
  MANUAL: 'a person asserted this link',
  ID_IN_ANNOTATION: 'the test declares the requirement id in an annotation',
  ID_IN_TEST_NAME: 'the requirement id appears in the test name',
  SURFACE_MATCH: 'guessed: the requirement names a surface this test touches',
};

/** The one method that is a human assertion rather than a machine's reading. */
export const ASSERTED_LINK_METHODS: readonly RequirementLinkMethod[] = ['MANUAL'];

/** True when a person asserted this link. */
export function linkWasAsserted(method: RequirementLinkMethod): boolean {
  return ASSERTED_LINK_METHODS.includes(method);
}

/**
 * The highest confidence each method is allowed to claim.
 *
 * A `Record` keyed on the union so a fifth method cannot be added without a
 * ceiling — a method with no ceiling would default to whatever the writer
 * passed, and the writer is the thing being constrained.
 *
 * The numbers are judgements and they are written here rather than in four
 * importers so that changing one changes the product rather than one importer.
 * SURFACE_MATCH is capped at 0.5 on purpose: a link that cannot exceed a coin
 * flip cannot be the reason a requirement is reported as covered, which is the
 * behaviour the gate needs ({@link TRACEABLE_LINK_CONFIDENCE}).
 */
export const LINK_METHOD_CONFIDENCE_CEILING: Record<RequirementLinkMethod, number> = {
  MANUAL: 1,
  ID_IN_ANNOTATION: 0.95,
  ID_IN_TEST_NAME: 0.8,
  SURFACE_MATCH: 0.5,
};

/**
 * The confidence at or above which a link may be counted as traceability.
 *
 * Above every method's ceiling but SURFACE_MATCH's, which is the point: a
 * guessed link is reported, named and shown, and does not move the number.
 */
export const TRACEABLE_LINK_CONFIDENCE = 0.6;

/**
 * The confidence a link may be stored with, and whether a cap bit.
 *
 * Returns the cap as a FACT rather than applying it silently. Rule: every
 * budget, take, limit and ceiling that bites has to be reportable as a count
 * and as a reason, because an undisclosed cap on a confidence score is an
 * undisclosed change to the coverage number — a regex claiming 0.99 would make
 * a requirement read as traced by a guess.
 */
export interface ClampedConfidence {
  confidence: number;
  /** True when the caller's value was above this method's ceiling. */
  clamped: boolean;
  /** Null when nothing bit. A sentence a reader can act on when it did. */
  rule: string | null;
}

export function clampLinkConfidence(
  method: RequirementLinkMethod,
  raw: number,
): ClampedConfidence {
  const ceiling = LINK_METHOD_CONFIDENCE_CEILING[method];
  /*
   * NaN is clamped to 0 and reported, not passed through. `Math.min(NaN, x)` is
   * NaN, a NaN confidence survives a `>= TRACEABLE_LINK_CONFIDENCE` comparison
   * as false, and it would reach the database as a Float the UI renders as
   * "NaN" next to an audit claim.
   */
  if (!Number.isFinite(raw)) {
    return {
      confidence: 0,
      clamped: true,
      rule: `${method} supplied a confidence that is not a number; stored as 0`,
    };
  }
  if (raw < 0) {
    return { confidence: 0, clamped: true, rule: `${method} supplied a negative confidence` };
  }
  if (raw <= ceiling) return { confidence: raw, clamped: false, rule: null };
  return {
    confidence: ceiling,
    clamped: true,
    rule:
      `${method} claimed ${raw} and is capped at ${ceiling}: ` +
      `${REQUIREMENT_LINK_METHOD_LABELS[method]}`,
  };
}

// ─── What a link points at ───────────────────────────────────────────────────

/**
 * The two things a requirement can be linked to, as a discriminated union.
 *
 * ── Why a union and not two nullable columns read by hand ───────────────────
 *
 * Because "exactly one of these is set" is the invariant, and a row with both
 * set or neither set is a row every reader will interpret differently. The
 * union makes the valid states the only constructible ones, {@link
 * requirementLinkTargetSchema} is the single write path, and {@link
 * linkTargetOfRow} is the single read path — it returns null for a malformed
 * row rather than picking whichever column happened to be non-null, so a
 * malformed row is reported instead of silently becoming a test link.
 *
 * ── The pattern this copies ─────────────────────────────────────────────────
 *
 * Both halves of the guard `DimensionDetail` carries: {@link
 * REQUIREMENT_LINK_TARGET_KINDS} is derived from a `Record` the compiler
 * refuses to let drift, and requirements.test.ts compares that list against the
 * zod union's own options at run time. Two mechanisms because each catches what
 * the other cannot — eight GateRule kinds were unsaveable by any customer for
 * two slices precisely because only one existed.
 */
export type RequirementLinkTarget =
  | {
      target: 'TEST';
      /** `Test.id`. The automated test that is claimed to cover this. */
      testId: string;
    }
  | {
      target: 'SURFACE';
      /**
       * `CoverageItem.id` — the surface registry's row id, NOT its `key`.
       *
       * The linker knows the key (`ROUTE:/checkout`) and has to resolve it
       * first. A key with no row is a DANGLING REFERENCE in our own extractor,
       * exactly like `dimensionDenominator`'s `undeclaredValues`, and it must
       * be reported as one rather than dropped: a requirement linked to a
       * surface we failed to enumerate is evidence about us.
       */
      coverageItemId: string;
    };

/**
 * Every discriminant {@link RequirementLinkTarget} has, as a run-time value.
 * See the note on the union: the compiler enforces this record, and
 * requirements.test.ts enforces the zod union against it.
 */
const REQUIREMENT_LINK_TARGET_PRESENT: Record<RequirementLinkTarget['target'], true> = {
  TEST: true,
  SURFACE: true,
};

export const REQUIREMENT_LINK_TARGET_KINDS = Object.keys(
  REQUIREMENT_LINK_TARGET_PRESENT,
) as ReadonlyArray<RequirementLinkTarget['target']>;

/**
 * The target of a stored link row, or null when the row names neither target or
 * both.
 *
 * Null is not an error to swallow. A link row with no target is a row that
 * claims a requirement is covered by nothing, and a row with two is a row whose
 * meaning depends on which column the reader looks at first.
 */
export function linkTargetOfRow(row: {
  testId: string | null;
  coverageItemId: string | null;
}): RequirementLinkTarget | null {
  const hasTest = row.testId !== null && row.testId.length > 0;
  const hasSurface = row.coverageItemId !== null && row.coverageItemId.length > 0;
  if (hasTest === hasSurface) return null;
  return hasTest
    ? { target: 'TEST', testId: row.testId as string }
    : { target: 'SURFACE', coverageItemId: row.coverageItemId as string };
}

// ─── NOT_LINKED as a queryable state ────────────────────────────────────────

/**
 * Whether anything is linked to this requirement, and how strong the strongest
 * link is — stored on the requirement, derived from its link rows.
 *
 * ── Why this is a column and not `count(links) === 0` ───────────────────────
 *
 * Because "requirements with no test" is THE report this entity exists to
 * produce, and the absence of rows cannot be indexed, cannot be ordered by, and
 * cannot be distinguished from the absence of a linker. A `LEFT JOIN … WHERE
 * link.id IS NULL` over every requirement in an install answers a different
 * question from the one the customer is asking, because it silently includes
 * every requirement imported five minutes ago that nothing has looked at yet.
 *
 * ── The four states ─────────────────────────────────────────────────────────
 *
 *   NOT_SEARCHED  no linker has run over this requirement. Our silence.
 *   NOT_LINKED    a linker ran and found nothing. The product's output.
 *   INFERRED      links exist and every one was a machine's guess.
 *   ASSERTED      at least one link a person asserted.
 *
 * NOT_SEARCHED is the default on insert rather than a nullable column, because
 * the default then states the truth — "we have not looked yet" — instead of
 * leaving a null every reader has to remember to interpret. Unlike the stored
 * `CoverageItem` columns there are no pre-existing rows to be ambiguous about:
 * this table is new, so the three-state absent/null/value rule has nothing to
 * protect and an explicit member is strictly more legible.
 */
export const REQUIREMENT_LINK_STATES = [
  'NOT_SEARCHED',
  'NOT_LINKED',
  'INFERRED',
  'ASSERTED',
] as const;
export type RequirementLinkState = (typeof REQUIREMENT_LINK_STATES)[number];

export const REQUIREMENT_LINK_STATE_LABELS: Record<RequirementLinkState, string> = {
  NOT_SEARCHED: 'no linker has looked at this yet',
  NOT_LINKED: 'we looked and found no test',
  INFERRED: 'linked only by a machine’s guess',
  ASSERTED: 'a person asserted a link',
};

/** The one state that is a reportable gap. The others are silence or a link. */
export const UNLINKED_STATES: readonly RequirementLinkState[] = ['NOT_LINKED'];

/**
 * The link state for one requirement or criterion, from its link rows.
 *
 * The ONLY place this is derived. `linkState` is stored so it can be indexed,
 * which means it can disagree with the rows it summarises; one derivation
 * called by every writer is the whole defence against that, and it is the same
 * argument `originFromSources` makes for `CoverageItem.origin`.
 *
 * `searched` is a separate argument and not inferred from an empty array,
 * because that inference is precisely the lie: zero links means NOT_LINKED only
 * if something looked.
 */
export function linkStateFrom(
  searched: boolean,
  methods: readonly RequirementLinkMethod[],
): RequirementLinkState {
  if (methods.length === 0) return searched ? 'NOT_LINKED' : 'NOT_SEARCHED';
  return methods.some(linkWasAsserted) ? 'ASSERTED' : 'INFERRED';
}

// ─── Re-import: CHANGED, UNCHANGED, and neither ──────────────────────────────

/**
 * What a re-import found, compared with what is stored.
 *
 * NOT_COMPARABLE is the member that makes the other three safe. A stored row
 * with no content hash — written by an importer that did not hash, or carried
 * in from a CSV — cannot be diffed. Calling it UNCHANGED drops the customer's
 * edit silently; calling it CHANGED re-opens every link on every re-import, so
 * the traceability matrix churns for ever and people stop reading it. Neither
 * is true and the fourth member says so.
 */
export const CONTENT_CHANGE_KINDS = ['NEW', 'UNCHANGED', 'CHANGED', 'NOT_COMPARABLE'] as const;
export type ContentChangeKind = (typeof CONTENT_CHANGE_KINDS)[number];

export const CONTENT_CHANGE_LABELS: Record<ContentChangeKind, string> = {
  NEW: 'not seen before',
  UNCHANGED: 'identical to the stored copy',
  CHANGED: 'the source has been edited since the last import',
  NOT_COMPARABLE: 'the stored copy carries no hash, so no comparison is possible',
};

export interface ContentChange {
  kind: ContentChangeKind;
  /** The sentence an import report prints. Always written, never defaulted. */
  detail: string;
}

/**
 * Classify a re-import.
 *
 * `previousHash` distinguishes three inputs and not two: undefined for a row
 * that does not exist yet (NEW), null or empty for a row that exists and was
 * never hashed (NOT_COMPARABLE), and a string for a real comparison.
 */
export function classifyReimport(
  previousHash: string | null | undefined,
  nextHash: string,
): ContentChange {
  if (previousHash === undefined) {
    return { kind: 'NEW', detail: 'no row for this external id exists yet' };
  }
  if (previousHash === null || previousHash.length === 0) {
    return {
      kind: 'NOT_COMPARABLE',
      detail:
        'the stored row has no content hash, so "changed" and "unchanged" are both unprovable; ' +
        'the hash is written now and the next import can compare',
    };
  }
  return previousHash === nextHash
    ? { kind: 'UNCHANGED', detail: 'the content hash matches the stored one' }
    : { kind: 'CHANGED', detail: 'the content hash differs from the stored one' };
}

/**
 * The canonical text a requirement's content hash is taken over.
 *
 * ── Why this function exists and the hash does not ──────────────────────────
 *
 * Canonicalisation is the part that goes wrong, and it is pure: which fields
 * count, in what order, with what whitespace treatment, and with criteria in
 * their declared order rather than whatever order a REST page returned them in.
 * Hashing is ten lines of someone else's cryptography. So this module owns the
 * first and takes the second as an injected {@link ContentDigest}: there is no
 * `node:crypto` import anywhere in this file, because `packages/shared/src/
 * index.ts` is what the web app's bundler consumes and a Node builtin in the
 * barrel breaks every page that imports a value from @qaai/shared (see the note
 * on `plugin-manifest.ts`, which is kept OUT of the barrel for exactly this).
 *
 * ── The rules, each of which is a false CHANGED we would otherwise ship ─────
 *
 *   1. Field order is FIXED here, not taken from object key order.
 *   2. `\r\n` and `\r` become `\n`. A tracker's web editor and its REST API
 *      disagree about line endings on the same unedited ticket.
 *   3. Trailing whitespace per line is stripped and the whole value trimmed.
 *      Nothing else is touched: collapsing interior whitespace would make an
 *      edit that only changes indentation invisible, and in a Gherkin criterion
 *      indentation is structure.
 *   4. Criteria keep their declared order and are separated by a character no
 *      criterion can contain, so two criteria cannot be rearranged into the
 *      same canonical text as one.
 *   5. The STATUS IS NOT IN THE HASH. A ticket moving from READY to DONE is not
 *      an edit to the specification, and hashing it would re-open every link in
 *      a project on the day its sprint closed.
 */
export interface RequirementContentInput {
  externalId: string;
  title: string;
  body: string;
  /** In the order the source declared them. */
  criteria: readonly string[];
}

/** A character no tracker will emit inside a field, used as the field separator. */
const CANONICAL_SEPARATOR = '\u001f';

function canonicaliseText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

export function requirementCanonicalText(input: RequirementContentInput): string {
  return [
    canonicaliseText(input.externalId),
    canonicaliseText(input.title),
    canonicaliseText(input.body),
    ...input.criteria.map(canonicaliseText),
  ].join(CANONICAL_SEPARATOR);
}

/**
 * A hash of a canonical string. Injected rather than imported — see the note on
 * {@link requirementCanonicalText}, and rule 8 of this codebase: a module's I/O
 * and its cryptography are adapters, and a module that reaches for them
 * directly cannot be tested without them.
 */
export type ContentDigest = (canonical: string) => string;

/** The content hash of a requirement, under a caller-supplied digest. */
export function requirementContentHash(
  input: RequirementContentInput,
  digest: ContentDigest,
): string {
  return digest(requirementCanonicalText(input));
}

// ─── The manual suite nobody can read today ──────────────────────────────────

/**
 * Whether a manual test case has been automated, according to the suite that
 * holds it.
 *
 * NOT_STATED is the member that makes the backlog number honest. TestRail's
 * automation field is optional and most installs leave it empty; folding empty
 * into NOT_AUTOMATED would let us quote a backlog of 1,630 cases at a customer
 * whose suite never claimed anything about 1,400 of them. The two counts are
 * reported separately by {@link manualBacklogTotals} and never summed.
 *
 * CANNOT_AUTOMATE is the team's own waiver, and it is theirs rather than ours:
 * the difference from `SurfaceExercisability.UNEXERCISABLE` is that this is a
 * decision the customer recorded, not a limit our harness has.
 */
export const MANUAL_TEST_AUTOMATION_STATUSES = [
  'NOT_AUTOMATED',
  'AUTOMATION_PLANNED',
  'AUTOMATED',
  /** The team recorded that this will always be run by a human. */
  'CANNOT_AUTOMATE',
  'OBSOLETE',
  /** The suite carries no automation field for this case. Not a claim. */
  'NOT_STATED',
] as const;
export type ManualTestAutomationStatus = (typeof MANUAL_TEST_AUTOMATION_STATUSES)[number];

export const MANUAL_TEST_AUTOMATION_LABELS: Record<ManualTestAutomationStatus, string> = {
  NOT_AUTOMATED: 'run by hand',
  AUTOMATION_PLANNED: 'automation planned',
  AUTOMATED: 'automated',
  CANNOT_AUTOMATE: 'the team recorded that this stays manual',
  OBSOLETE: 'withdrawn',
  NOT_STATED: 'the suite does not say',
};

/** The statuses that are a unit of work: the automation backlog. */
export const AUTOMATION_BACKLOG_STATUSES: readonly ManualTestAutomationStatus[] = [
  'NOT_AUTOMATED',
  'AUTOMATION_PLANNED',
];

/**
 * The automation backlog, as counts that add up to the total.
 *
 * Every field is a count and the division is checkable, exactly as
 * `SurfaceKindTotals` is. `notStated` is its own field and is NOT in `backlog`:
 * the whole purpose of this function is that a reader cannot accidentally quote
 * "cases to automate" as a number that includes cases nobody classified.
 */
export interface ManualBacklogTotals {
  total: number;
  /** NOT_AUTOMATED + AUTOMATION_PLANNED. The number with work behind it. */
  backlog: number;
  automated: number;
  cannotAutomate: number;
  obsolete: number;
  /** Cases whose suite said nothing. Counted, never added to `backlog`. */
  notStated: number;
  /**
   * `automated / (automated + backlog)`, or null when that is zero.
   *
   * Null rather than 0 or 100: a suite with nothing but NOT_STATED cases has no
   * automation ratio, and printing either number would be a claim about the
   * customer's suite made from its silence.
   */
  automatedPercent: number | null;
  /** The sentence the report prints beside the number. */
  rule: string;
}

export function manualBacklogTotals(
  statuses: readonly ManualTestAutomationStatus[],
): ManualBacklogTotals {
  const count = (status: ManualTestAutomationStatus): number =>
    statuses.filter((candidate) => candidate === status).length;

  const backlog = statuses.filter((status) => AUTOMATION_BACKLOG_STATUSES.includes(status)).length;
  const automated = count('AUTOMATED');
  const denominator = automated + backlog;

  return {
    total: statuses.length,
    backlog,
    automated,
    cannotAutomate: count('CANNOT_AUTOMATE'),
    obsolete: count('OBSOLETE'),
    notStated: count('NOT_STATED'),
    automatedPercent:
      denominator <= 0 ? null : Math.round((automated / denominator) * 1000) / 10,
    rule:
      `${automated} automated of ${denominator} cases that state a position; ` +
      `${count('NOT_STATED')} case(s) say nothing and are counted nowhere in that ratio, ` +
      `${count('CANNOT_AUTOMATE')} are recorded as permanently manual and ` +
      `${count('OBSOLETE')} are withdrawn`,
  };
}

// ─── The write path ──────────────────────────────────────────────────────────

/*
 * WHY THESE SCHEMAS LIVE HERE AND NOT IN schemas.ts
 *
 * Every other write-path schema in this package is in `schemas.ts`, and that is
 * still the right home for the API's request bodies. These four are different:
 * they are the contract between SIX importers that are being written in
 * parallel against this vocabulary, and a vocabulary whose enums are in one
 * file and whose only legal way to write them is in another is how eight
 * GateRule kinds shipped unsaveable. Keeping the list and its guard in one file
 * means a member added here with no schema arm fails the parity test in this
 * module's own test file rather than in somebody else's.
 *
 * `zod` is already a dependency of this package and `schemas.ts` is already in
 * the barrel, so this adds nothing to what the web bundler eats.
 */

const externalId = z.string().trim().min(1).max(200);
const evidenceSentence = z.string().trim().min(1).max(1_000);

/** One acceptance criterion, as a row. */
export const acceptanceCriterionSchema = z.object({
  /**
   * Position within the requirement, from 0. Part of the identity: criterion 3
   * of PROJ-1 is a thing a test links to, and re-importing must not renumber it
   * silently, so the importer compares text at an ordinal and reports a move
   * rather than treating it as a delete plus an insert.
   */
  ordinal: z.number().int().min(0).max(10_000),
  text: z.string().trim().min(1).max(5_000),
  format: z.enum(ACCEPTANCE_CRITERION_FORMATS),
  /**
   * The source system's own id for this criterion, when it has one. Xray and
   * Zephyr do; a Markdown bullet does not, and null is the honest answer rather
   * than a synthesised id that changes when a bullet is inserted above it.
   */
  externalId: externalId.nullable().default(null),
});
export type AcceptanceCriterionInput = z.infer<typeof acceptanceCriterionSchema>;

/** One requirement, as an importer presents it. */
export const requirementSchema = z.object({
  externalId,
  sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS),
  title: z.string().trim().min(1).max(500),
  /** Prose. Empty string is legal: plenty of tickets are a title and a list. */
  body: z.string().max(100_000).default(''),
  status: z.enum(REQUIREMENT_STATUSES),
  /**
   * The source system's own word for the status, kept verbatim.
   *
   * Required when `status` is UNMAPPED and null is legal otherwise — because
   * UNMAPPED with nothing to show is indistinguishable from a bug in our
   * mapping table, which is the same argument `SurfaceExercise.rule` makes for
   * REFUSED. Enforced by the refinement below rather than by convention.
   */
  statusRaw: z.string().trim().min(1).max(200).nullable().default(null),
  url: z.string().trim().url().max(2_000).nullable().default(null),
  criteria: z.array(acceptanceCriterionSchema).max(500).default([]),
});

export const requirementImportSchema = requirementSchema.refine(
  (row) => row.status !== 'UNMAPPED' || row.statusRaw !== null,
  {
    message:
      'status UNMAPPED with no statusRaw is indistinguishable from a bug in our mapping table',
    path: ['statusRaw'],
  },
);
export type RequirementInput = z.infer<typeof requirementSchema>;

/**
 * What a link points at. The run-time half of {@link RequirementLinkTarget}.
 *
 * A discriminated union and not an object with two nullable fields, so "exactly
 * one target" is unrepresentable-if-wrong rather than checked by a refinement
 * somebody can forget to call.
 */
export const requirementLinkTargetSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('TEST'), testId: z.string().min(1).max(64) }),
  z.object({ target: z.literal('SURFACE'), coverageItemId: z.string().min(1).max(64) }),
]);

/**
 * One link.
 *
 * `confidence` is accepted in 0–1 and then CLAMPED by the method — the schema
 * cannot do it, because the ceiling depends on another field, and a `.transform`
 * that silently lowered the number would be the undisclosed cap this file
 * exists to refuse. Callers run {@link clampLinkConfidence} and store its
 * `rule` in `evidence` when it bit.
 */
export const requirementLinkSchema = z.object({
  method: z.enum(REQUIREMENT_LINK_METHODS),
  confidence: z.number().min(0).max(1),
  target: requirementLinkTargetSchema,
  /**
   * Which criterion this link is about, when it is about one.
   *
   * Null means the link is to the requirement as a whole, which is what a
   * ticket-id-in-a-test-name proves and all it proves. A guess promoted to
   * criterion granularity would make "which acceptance criterion has no test?"
   * answer with a link nobody made.
   */
  criterionOrdinal: z.number().int().min(0).max(10_000).nullable().default(null),
  evidence: evidenceSentence,
});
export type RequirementLinkInput = z.infer<typeof requirementLinkSchema>;

/** One manual test case, as a test-management suite presents it. */
export const manualTestCaseSchema = z.object({
  externalId,
  sourceSystem: z.enum(SPEC_SOURCE_SYSTEMS),
  title: z.string().trim().min(1).max(500),
  /**
   * The steps as ROWS, in order. Prose in one blob cannot be counted, cannot be
   * matched against a generated test's steps, and cannot show a human which
   * step a conversion dropped.
   */
  steps: z
    .array(
      z.object({
        ordinal: z.number().int().min(0).max(1_000),
        action: z.string().trim().min(1).max(2_000),
        /** The expected result of THIS step, when the suite records per-step ones. */
        expected: z.string().trim().min(1).max(2_000).nullable().default(null),
      }),
    )
    .max(500)
    .default([]),
  /** The case-level expected result. Null when the suite only has per-step ones. */
  expectedResult: z.string().trim().min(1).max(10_000).nullable().default(null),
  automationStatus: z.enum(MANUAL_TEST_AUTOMATION_STATUSES),
  /**
   * When a human last ran it, as the suite reports it.
   *
   * Null is "the suite does not say", which is NOT "never run" — a case with no
   * execution history and a case the suite has no field for look identical in a
   * CSV export, and one of them is a finding.
   */
  lastExecutedAt: z.date().nullable().default(null),
  url: z.string().trim().url().max(2_000).nullable().default(null),
});
export type ManualTestCaseInput = z.infer<typeof manualTestCaseSchema>;
