/**
 * The dimensions — the axes a coverage number is allowed to be broken down on,
 * and the one shape every one of them answers in.
 *
 * WHY THIS FILE EXISTS
 *
 * `surface.ts` built the denominator and `coverage-tiers.ts` built the ladder,
 * and between them they can say "61% navigated, 34% passing" about a list of
 * routes, endpoints, forms and auth surfaces. What neither can say is anything
 * BELOW an item. Three sentences the product cannot currently produce, each of
 * which is a measurement a customer already believes they are buying:
 *
 *   1. A ROUTE IS ONE SLOT WHATEVER STATE IT IS IN. `coverage.ts` folds every
 *      state of a route into one entry with the comment "because coverage is a
 *      property of the route". It is not. An untested empty state, an untested
 *      403, an untested pagination boundary are not uncovered — they are
 *      INVISIBLE, and invisible raises the percentage while uncovered lowers it.
 *   2. A FORM IS ONE BOOLEAN. It counts as exercised if any test mentions its
 *      submit label or one field label near a `.fill()`. So `required`,
 *      `semantic` and every boundary case are counted by nobody.
 *   3. COVERAGE IS TYPE-BLIND. A PERFORMANCE test marks a route fully visited
 *      exactly as an E2E does, so "routes with an ACCESSIBILITY test: 3 of 14"
 *      is unsayable. Nineteen test types, one boolean.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURAL ────────────────────────
 *
 * A DIMENSION WITH NO EXTRACTOR MUST RENDER AS "UNMEASURED", NEVER AS 0%.
 *
 * That is the same rule `SurfaceKindTotals.measured` and
 * `MEASURED_SURFACE_KINDS` already encode one level up, and it is restated here
 * because this round adds up to thirteen axes at once and the failure is
 * silent: "0% of your component states are covered" is a lie about the
 * customer's application assembled out of our own silence, where "we do not
 * measure component states" is a true and useful fact about our product. So
 * every {@link DimensionMeasurement} carries `unmeasured` AND
 * `unmeasuredReason`, the reason is a closed vocabulary rather than a sentence
 * somebody forgot to write, and {@link unmeasuredDimension} is a constructor
 * that cannot produce a zero.
 *
 * ── THE SECOND RULE: NEVER SUM TWO DIMENSIONS ───────────────────────────────
 *
 * This product has already shipped a headline that added routes + journeys +
 * forms + controls into one fraction, which made controls roughly 80% of the
 * figure and let a code comment naming four labels move the quoted number from
 * 2% to 11%. Thirteen axes is thirteen chances to do it again. So there is no
 * function in this file that takes two measurements and returns one percentage,
 * and {@link DimensionMeasurement} has no `percent` field — the figure is read
 * off its own ladder at a named rung by {@link dimensionPercentAt}, against its
 * own denominator, or it is not read at all.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It measures nothing and reads nothing. It is the vocabulary, the cell-kind to
 * dimension mapping, the measurement shape, the two honest constructors, the
 * rollup scope key and the snapshot comparability rule, so that six dimension
 * modules written in parallel mean the same thing by "a cell". Cell IDENTITY is
 * not redefined here: `dimensionCellIdentity` in surface.ts is the one format,
 * and a second one would make two dimensions silently uncomparable.
 */

import type { TestType } from './constants';
import { TEST_TYPES } from './constants';
import { COVERAGE_TIER_RANK, coverageLadder } from './coverage-tiers';
import type { CoverageLadder, CoverageTier } from './coverage-tiers';
import { SURFACE_KINDS, coveragePercent } from './surface';
import type { SurfaceDimensionKind, SurfaceKind } from './surface';

// ─── The axes ────────────────────────────────────────────────────────────────

/**
 * The dimensions a coverage report may be broken down on.
 *
 * Thirteen, and every one of them is a register item from the round that
 * introduced this file rather than a speculative axis: three for the states a
 * route can be in, two for what is inside a form, two for components, one for
 * the test type a surface owes, three for the matrix a run varies over, and two
 * for the surfaces nothing crawls.
 *
 * Declared as an `as const` ARRAY, not derived from the descriptor record
 * below, for the same three reasons `COVERAGE_TIERS` is: `z.enum` needs the
 * tuple, `apps/api/scripts/check-enums.ts` reads this file's SOURCE with a
 * regex over `export const NAME = ` and cannot see an `Object.keys`, and the
 * records below are keyed on the union so the COMPILER refuses a fourteenth
 * dimension with no descriptor. An enum the drift guard cannot see is the exact
 * hole that script was written to close.
 */
export const COVERAGE_DIMENSIONS = [
  /** The states a route can be in: default, loading, empty, slow, interstitial. */
  'PAGE_STATE',
  /** The 4xx/5xx and validation-failure states of a route. */
  'ERROR_STATE',
  /** The same surface under a different fixture shape: none, one, many, boundary. */
  'DATA_VARIANT',
  /** One input of one form. */
  'FORM_FIELD',
  /** One validation rule derived from one field. */
  'VALIDATION_RULE',
  /** One exported component. */
  'COMPONENT',
  /** One component in one named state. */
  'COMPONENT_STATE',
  /** One surface and one test type it owes a test of. */
  'TEST_TYPE',
  /** One surface at one device, viewport or locale. */
  'DEVICE_LOCALE',
  /** One surface under one observed feature-flag combination. */
  'FLAG_COMBINATION',
  /** One surface as seen by one role. */
  'ROLE_CELL',
  /** One scheduled job, queue consumer or webhook receiver. */
  'BACKGROUND_JOB',
  /** One outbound email or notification template. */
  'NOTIFICATION',
] as const;
export type CoverageDimensionKind = (typeof COVERAGE_DIMENSIONS)[number];

/**
 * Every dimension, as a run-time presence record.
 *
 * The compile-time half of the two-mechanism guard this codebase requires for a
 * vocabulary with a write path: a fourteenth member of the array breaks THIS
 * line until somebody adds it, and `coverage-dimensions.test.ts` compares
 * `coverageDimensionSchema.options` against the array at run time. Eight
 * `GateRule` kinds shipped unsaveable for two slices because only one of the
 * two existed, and `check:wiring` cannot see that class of defect.
 */
const COVERAGE_DIMENSION_PRESENT: Record<CoverageDimensionKind, true> = {
  PAGE_STATE: true,
  ERROR_STATE: true,
  DATA_VARIANT: true,
  FORM_FIELD: true,
  VALIDATION_RULE: true,
  COMPONENT: true,
  COMPONENT_STATE: true,
  TEST_TYPE: true,
  DEVICE_LOCALE: true,
  FLAG_COMBINATION: true,
  ROLE_CELL: true,
  BACKGROUND_JOB: true,
  NOTIFICATION: true,
};

/** The presence record as a list, for the run-time parity assertions. */
export const COVERAGE_DIMENSION_KINDS = Object.keys(
  COVERAGE_DIMENSION_PRESENT,
) as ReadonlyArray<CoverageDimensionKind>;

// ─── Why a cell was not measured ─────────────────────────────────────────────

/**
 * WHY A CELL CARRIES NO MEASUREMENT. Five reasons, and they are five different
 * findings with five different remedies.
 *
 * A closed vocabulary and not a sentence, because the report GROUPS by it and
 * because the grouping is the actionable half: "we have no extractor for this
 * axis" is work for us, "the crawl never enumerated these states" is a crawl to
 * re-run, "a cap bit" is a budget to raise, and "held out" is a conversation
 * with the team. A free-text reason makes all four look like the same shrug,
 * and an ABSENT reason makes an unmeasured cell indistinguishable from an
 * uncovered one — which is the single most expensive mistake available in this
 * file, because it moves the percentage down for a reason the customer cannot
 * act on and did not cause.
 */
export const DIMENSION_UNMEASURED_REASONS = [
  /**
   * QAAI has no extractor for this axis in this build. The cells may not even
   * be enumerable yet. NOT a gap in the customer's testing.
   */
  'NO_EXTRACTOR',
  /**
   * The extractor exists and the cell set was never enumerated for this
   * subject — no crawl recorded the states of this route, no reader read this
   * form's constraints. So the DENOMINATOR is unknown, not the numerator.
   */
  'NOT_ENUMERATED',
  /**
   * The extractor ran and could not decide. A computed selector, a runtime URL,
   * a constraint the source path cannot read. Same contract as
   * `SurfaceStatus.UNKNOWN`: it is a hole in OUR knowledge and must never read
   * as a gap in theirs.
   */
  'EXTRACTOR_RETURNED_UNKNOWN',
  /**
   * The cell left the denominator on purpose: waived by the team, or
   * UNEXERCISABLE or REFUSED by our own harness, or an obligation this
   * deployment cannot execute. It is counted, named, and not scored.
   */
  'HELD_OUT',
  /**
   * A budget, take, limit, page size or timeout stopped the measurement short.
   * The one reason that MUST travel with a count — see {@link DimensionCapBite}
   * and rule 10: a cap applied without being disclosed is a lie this product
   * cannot afford.
   */
  'CAP_BIT',
] as const;
export type DimensionUnmeasuredReason = (typeof DIMENSION_UNMEASURED_REASONS)[number];

/**
 * The compile-time half of the guard, as for the dimensions above. A sixth
 * reason breaks this line until somebody states what it means.
 */
const DIMENSION_UNMEASURED_REASON_PRESENT: Record<DimensionUnmeasuredReason, true> = {
  NO_EXTRACTOR: true,
  NOT_ENUMERATED: true,
  EXTRACTOR_RETURNED_UNKNOWN: true,
  HELD_OUT: true,
  CAP_BIT: true,
};

export const DIMENSION_UNMEASURED_REASON_KINDS = Object.keys(
  DIMENSION_UNMEASURED_REASON_PRESENT,
) as ReadonlyArray<DimensionUnmeasuredReason>;

export const DIMENSION_UNMEASURED_REASON_LABELS: Record<DimensionUnmeasuredReason, string> = {
  NO_EXTRACTOR: 'QAAI does not measure this axis in this build',
  NOT_ENUMERATED: 'the cells on this axis were never enumerated for this subject',
  EXTRACTOR_RETURNED_UNKNOWN: 'the extractor ran and could not decide',
  HELD_OUT: 'held out of the denominator, with a reason, and not scored',
  CAP_BIT: 'a cap stopped the measurement short — at least this many more exist',
};

/**
 * The reasons that are a fact about OUR product rather than about the
 * customer's tests.
 *
 * Load-bearing in the report's wording: a dimension unmeasured for one of these
 * must never appear in the same list as a gap, and the sentence beside it names
 * us. `HELD_OUT` is deliberately NOT here — a waiver is the team's decision and
 * an obligation this deployment cannot run is ours, so the caller states which
 * on the row rather than this list guessing.
 */
export const OUR_LIMIT_UNMEASURED_REASONS: readonly DimensionUnmeasuredReason[] = [
  'NO_EXTRACTOR',
  'NOT_ENUMERATED',
  'EXTRACTOR_RETURNED_UNKNOWN',
  'CAP_BIT',
];

// ─── Cells: the kinds, and the dimension each one belongs to ─────────────────

/**
 * EVERY KIND OF CELL THAT LIVES BELOW A SURFACE ITEM, in one vocabulary.
 *
 * ── Why one list and not six ────────────────────────────────────────────────
 *
 * Because six dimension modules are written in parallel against this file, and
 * the failure mode the keystone exists to prevent is two of them inventing
 * their own notion of "a page state". One list, one `kind` column in the
 * database, and {@link CELL_KIND_DIMENSION} decides which denominator a kind
 * counts toward — so a kind cannot be added without somebody naming its
 * dimension, and no kind can be counted on two of them.
 *
 * ── Why the prefixes are not noise ─────────────────────────────────────────
 *
 * `PAGE_EMPTY` and `DATA_NONE` are both "nothing here" and they are NOT the
 * same cell. The first is a page that rendered with no content; the second is
 * the same page driven against a zero-row fixture, which is a test somebody has
 * to write on purpose. A shared spelling of `EMPTY` would have merged two
 * denominators the moment two modules wrote rows, and merged denominators is
 * how this product's headline once came to be 80% controls.
 *
 * The six `COMPONENT_*` members mirror `COMPONENT_STATE_KINDS` in
 * api-surface.ts member for member; coverage-dimensions.test.ts holds them to
 * it, because that list is what the ENUMERATE round already writes into
 * `ComponentState` rows and a kind here that it cannot produce is a cell with
 * no possible evidence.
 */
export const COVERAGE_CELL_KINDS = [
  // ─ PAGE_STATE: the states a route is in when nothing has gone wrong ─
  /** The happy path: the route rendered with content. */
  'PAGE_DEFAULT',
  'PAGE_LOADING',
  /** Rendered, with nothing in it. Not an error and not a fixture choice. */
  'PAGE_EMPTY',
  'PAGE_SLOW',
  /** A consent wall, cookie banner or onboarding step stood in front of it. */
  'PAGE_INTERSTITIAL',
  /** Asking for it landed somewhere else. */
  'PAGE_REDIRECTED',

  // ─ ERROR_STATE: the states that are a failure answer ─
  'ERROR_UNAUTHENTICATED',
  'ERROR_FORBIDDEN',
  'ERROR_NOT_FOUND',
  'ERROR_SERVER',
  /** A submitted form came back with its own validation errors shown. */
  'ERROR_VALIDATION',

  // ─ DATA_VARIANT: the same surface, a different fixture shape ─
  'DATA_NONE',
  'DATA_ONE',
  'DATA_MANY',
  /** The page where pagination turns over, which is where off-by-one lives. */
  'DATA_PAGE_BOUNDARY',
  'DATA_MAXIMUM',
  'DATA_MALFORMED',

  // ─ FORM_FIELD: one input ─
  'FORM_FIELD',

  // ─ VALIDATION_RULE: one rule derived from one input ─
  /** The field is required, and the test asserts what happens when it is empty. */
  'RULE_REQUIRED',
  'RULE_LENGTH',
  'RULE_RANGE',
  'RULE_STEP',
  'RULE_PATTERN',
  /*
   * A rule the meaning of the field implies: a Luhn check, a future date, a
   * real domain. Deliberately no apostrophes or brackets in the comments
   * inside this array: check-enums.ts reads the literal with a regex bounded
   * by the first closing bracket, so a bracket here would silently truncate
   * the list it compares against the Prisma enum.
   */
  'RULE_SEMANTIC',

  // ─ COMPONENT and COMPONENT_STATE ─
  'COMPONENT',
  'COMPONENT_DEFAULT',
  'COMPONENT_LOADING',
  'COMPONENT_EMPTY',
  'COMPONENT_ERROR',
  'COMPONENT_FORBIDDEN',
  'COMPONENT_SLOW',
] as const;
export type CoverageCellKind = (typeof COVERAGE_CELL_KINDS)[number];

/**
 * WHICH DENOMINATOR EACH CELL KIND COUNTS TOWARD.
 *
 * A `Record` keyed on the cell union, so a new kind breaks this line rather
 * than quietly producing rows that belong to no dimension and are therefore
 * counted nowhere. Counted nowhere is the invisible state, and invisible
 * flatters the number.
 *
 * Five of the thirteen dimensions are absent from the values here on purpose:
 * `TEST_TYPE`, `DEVICE_LOCALE`, `FLAG_COMBINATION`, `ROLE_CELL`,
 * `BACKGROUND_JOB` and `NOTIFICATION` key their cells on a `SurfaceDimension`
 * ROW or on a `TestType`, not on a kind from this list — see
 * `CoverageDimension.keyedOn`. A dimension with no cell kinds is not a
 * dimension with no cells.
 */
export const CELL_KIND_DIMENSION: Record<CoverageCellKind, CoverageDimensionKind> = {
  PAGE_DEFAULT: 'PAGE_STATE',
  PAGE_LOADING: 'PAGE_STATE',
  PAGE_EMPTY: 'PAGE_STATE',
  PAGE_SLOW: 'PAGE_STATE',
  PAGE_INTERSTITIAL: 'PAGE_STATE',
  PAGE_REDIRECTED: 'PAGE_STATE',

  ERROR_UNAUTHENTICATED: 'ERROR_STATE',
  ERROR_FORBIDDEN: 'ERROR_STATE',
  ERROR_NOT_FOUND: 'ERROR_STATE',
  ERROR_SERVER: 'ERROR_STATE',
  ERROR_VALIDATION: 'ERROR_STATE',

  DATA_NONE: 'DATA_VARIANT',
  DATA_ONE: 'DATA_VARIANT',
  DATA_MANY: 'DATA_VARIANT',
  DATA_PAGE_BOUNDARY: 'DATA_VARIANT',
  DATA_MAXIMUM: 'DATA_VARIANT',
  DATA_MALFORMED: 'DATA_VARIANT',

  FORM_FIELD: 'FORM_FIELD',

  RULE_REQUIRED: 'VALIDATION_RULE',
  RULE_LENGTH: 'VALIDATION_RULE',
  RULE_RANGE: 'VALIDATION_RULE',
  RULE_STEP: 'VALIDATION_RULE',
  RULE_PATTERN: 'VALIDATION_RULE',
  RULE_SEMANTIC: 'VALIDATION_RULE',

  COMPONENT: 'COMPONENT',
  COMPONENT_DEFAULT: 'COMPONENT_STATE',
  COMPONENT_LOADING: 'COMPONENT_STATE',
  COMPONENT_EMPTY: 'COMPONENT_STATE',
  COMPONENT_ERROR: 'COMPONENT_STATE',
  COMPONENT_FORBIDDEN: 'COMPONENT_STATE',
  COMPONENT_SLOW: 'COMPONENT_STATE',
};

/**
 * The cell kinds that count toward one dimension.
 *
 * DERIVED from {@link CELL_KIND_DIMENSION} rather than listed a second time on
 * the descriptor, because a second list is how a kind comes to be counted on
 * one screen and not another. The order follows `COVERAGE_CELL_KINDS`, which is
 * declaration order and therefore stable.
 */
export function cellKindsFor(dimension: CoverageDimensionKind): readonly CoverageCellKind[] {
  return COVERAGE_CELL_KINDS.filter((kind) => CELL_KIND_DIMENSION[kind] === dimension);
}

/** The dimension a cell kind counts toward. Total by construction. */
export function dimensionOfCellKind(kind: CoverageCellKind): CoverageDimensionKind {
  return CELL_KIND_DIMENSION[kind];
}

/**
 * Cell kinds that are not the happy path.
 *
 * The count the product's "not just the happy path" claim rests on, and the
 * mirror of `NON_HAPPY_PATH_STATES` in api-surface.ts one level down. Derived
 * by EXCLUSION so a new kind is non-happy-path by default: the opposite default
 * would quietly leave a new error state out of the one count that makes the
 * claim checkable.
 */
export const HAPPY_PATH_CELL_KINDS: readonly CoverageCellKind[] = [
  'PAGE_DEFAULT',
  'DATA_MANY',
  'COMPONENT_DEFAULT',
];

export function isNonHappyPathCell(kind: CoverageCellKind): boolean {
  return !HAPPY_PATH_CELL_KINDS.includes(kind);
}

// ─── The descriptor: what one dimension IS ──────────────────────────────────

/**
 * The identity of one axis: which surface items it refines, where its cells are
 * counted, and what they are keyed on.
 *
 * ── `refines` is a LIST and `cellAxis` is NULLABLE, and both are deliberate ──
 *
 * `DIMENSION_AXIS` in surface.ts maps each `SurfaceDimensionKind` to exactly
 * one `SurfaceKind`, which works because a role, a locale and a flag each
 * produce cells of one shape. That is not true of every dimension here.
 * `TEST_TYPE` refines EVERY axis — a route, an endpoint and a form can each owe
 * an ACCESSIBILITY test — and its cells are counted per refined item kind
 * rather than on an axis of their own, so `cellAxis` is null for it and only
 * for it. Giving it a thirteenth `SurfaceKind` of its own would have been a
 * SECOND DENOMINATOR, which is the defect this whole file is arranged around.
 *
 * `hasExtractor` is deliberately NOT a field. Whether an axis is measured in
 * this build is a property of the registry, not of the vocabulary, and a
 * boolean here would be a claim written by whoever defined the axis rather than
 * by whoever built the measurement — see {@link EXTRACTED_COVERAGE_DIMENSIONS}.
 */
export interface CoverageDimension {
  dimension: CoverageDimensionKind;
  label: string;
  /** What one cell is, in the sentence the report prints. Singular. */
  cellNoun: string;
  /**
   * The `SURFACE_KINDS` axes whose items this dimension multiplies. At least
   * one, and every member is a real `SurfaceKind` — pinned by a test, because a
   * dimension that refined an axis the inventory does not have would be rows
   * nothing could ever join to.
   */
  refines: readonly SurfaceKind[];
  /** The axis the cells land on, or null when they are counted per refined kind. */
  cellAxis: SurfaceKind | null;
  /**
   * The `SurfaceDimension` tables the cells are keyed on. Empty for a dimension
   * whose cells belong to ONE item and are therefore stored on it — a page
   * state, a form field, a component state. That split is the one surface.ts
   * already draws: a value enumerable independently of the pages it applies to
   * gets a shared table; a property of one item does not.
   */
  keyedOn: readonly SurfaceDimensionKind[];
}

/**
 * Every dimension's descriptor.
 *
 * A `Record` keyed on the union, so a fourteenth dimension cannot exist without
 * somebody stating what it refines and where its cells are counted. The same
 * mechanism as `COVERAGE_TIER_RANK`, and for the same reason: an `indexOf` or a
 * `??` default would have silently given it an axis nobody chose.
 */
export const COVERAGE_DIMENSION_DESCRIPTORS: Record<CoverageDimensionKind, CoverageDimension> = {
  PAGE_STATE: {
    dimension: 'PAGE_STATE',
    label: 'Page states',
    cellNoun: 'page state',
    refines: ['ROUTE'],
    cellAxis: 'ERROR_STATE',
    keyedOn: [],
  },
  ERROR_STATE: {
    dimension: 'ERROR_STATE',
    label: 'Error states',
    cellNoun: 'error state',
    refines: ['ROUTE', 'ENDPOINT'],
    cellAxis: 'ERROR_STATE',
    keyedOn: [],
  },
  DATA_VARIANT: {
    dimension: 'DATA_VARIANT',
    label: 'Data variants',
    cellNoun: 'data variant',
    refines: ['ROUTE', 'ENDPOINT'],
    cellAxis: 'DATA_VARIANT',
    keyedOn: [],
  },
  FORM_FIELD: {
    dimension: 'FORM_FIELD',
    label: 'Form fields',
    cellNoun: 'form field',
    refines: ['FORM'],
    cellAxis: 'FORM',
    keyedOn: [],
  },
  VALIDATION_RULE: {
    dimension: 'VALIDATION_RULE',
    label: 'Validation rules',
    cellNoun: 'validation rule',
    refines: ['FORM'],
    cellAxis: 'FORM',
    keyedOn: [],
  },
  COMPONENT: {
    dimension: 'COMPONENT',
    label: 'Components',
    cellNoun: 'component',
    refines: ['COMPONENT_STATE'],
    cellAxis: 'COMPONENT_STATE',
    keyedOn: [],
  },
  COMPONENT_STATE: {
    dimension: 'COMPONENT_STATE',
    label: 'Component states',
    cellNoun: 'component state',
    refines: ['COMPONENT_STATE'],
    cellAxis: 'COMPONENT_STATE',
    keyedOn: [],
  },
  TEST_TYPE: {
    dimension: 'TEST_TYPE',
    label: 'Test types owed',
    cellNoun: 'type obligation',
    /*
     * Every measured axis, because any of them can owe a typed test. The list
     * is spelled out rather than `SURFACE_KINDS` wholesale: an obligation on
     * DEVICE_LOCALE or FLAG_COMBINATION would be an obligation on a CELL, and
     * a cell that owes nineteen typed tests is how nineteen fabricated
     * denominators get built out of one real one.
     */
    refines: ['ROUTE', 'ENDPOINT', 'FORM', 'AUTH_SURFACE', 'BACKGROUND_JOB', 'NOTIFICATION'],
    cellAxis: null,
    keyedOn: [],
  },
  DEVICE_LOCALE: {
    dimension: 'DEVICE_LOCALE',
    label: 'Devices and locales',
    cellNoun: 'device or locale cell',
    refines: ['ROUTE'],
    cellAxis: 'DEVICE_LOCALE',
    keyedOn: ['DEVICE', 'LOCALE'],
  },
  FLAG_COMBINATION: {
    dimension: 'FLAG_COMBINATION',
    label: 'Feature-flag combinations',
    cellNoun: 'flag combination',
    refines: ['ROUTE'],
    cellAxis: 'FLAG_COMBINATION',
    keyedOn: ['FLAG'],
  },
  ROLE_CELL: {
    dimension: 'ROLE_CELL',
    label: 'Roles',
    cellNoun: 'route × role cell',
    refines: ['ROUTE', 'ENDPOINT'],
    cellAxis: 'ROLE_CELL',
    keyedOn: ['ROLE'],
  },
  BACKGROUND_JOB: {
    dimension: 'BACKGROUND_JOB',
    label: 'Jobs, crons and webhook receivers',
    cellNoun: 'background surface',
    /*
     * A job is a surface in its own right, not a pairing, so it refines its own
     * axis — the same note `DIMENSION_AXIS` already carries for JOB and EMAIL.
     * It is in this table anyway because "how many jobs does this app have, and
     * how many have a test" needs the same enumerable, sourced, counted row as
     * every other axis.
     */
    refines: ['BACKGROUND_JOB'],
    cellAxis: 'BACKGROUND_JOB',
    keyedOn: ['JOB'],
  },
  NOTIFICATION: {
    dimension: 'NOTIFICATION',
    label: 'Emails and notifications',
    cellNoun: 'notification template',
    refines: ['NOTIFICATION'],
    cellAxis: 'NOTIFICATION',
    keyedOn: ['EMAIL'],
  },
};

/**
 * THE AXES AN EXTRACTOR EXISTS FOR IN THIS BUILD. Everything else is reported
 * unmeasured, by name, with `NO_EXTRACTOR`.
 *
 * ── TWELVE OF THE THIRTEEN, AND THE ONE THAT IS NOT HERE ───────────────────
 *
 * This list was `[]` when the file was written, because at that moment nothing
 * measured any of the thirteen. The dimension modules landed immediately after,
 * and `DIMENSION_REGISTRY` in `packages/agent/src/coverage.ts` is what makes an
 * axis measured — so a member is added here as each module is registered, and
 * `coverage.ts`'s own test asserts that this list EQUALS the registry's measured
 * keys. Neither can be edited alone without a red test, which is what stops
 * this list becoming a claim nobody checks.
 *
 * ROLE_CELL IS DELIBERATELY ABSENT, and it is the one entry worth reading the
 * reasoning for. `access-matrix.ts` enumerates the route x role cells — so that
 * denominator is known and defensible — and nothing in this build matches a
 * TEST to one of those cells. The outcome the matrix records is the
 * APPLICATION's behaviour (a 403 happened), not a test's assertion about it.
 * Listing ROLE_CELL here would promote a crawl probe to coverage, the figure
 * would rise with no test written, and the rise would be invisible because the
 * probe really did happen. It is reported with its cell count, `NO_EXTRACTOR`,
 * and a null percentage.
 *
 * Pre-populating this with axes somebody INTENDS to build would be the cardinal
 * lie of this product in its purest form: a thing reported as measured that was
 * not measured.
 *
 * The shape mirrors `MEASURED_SURFACE_KINDS` one level up deliberately, so
 * there is one idiom for "we do not look at this" rather than two.
 */
export const EXTRACTED_COVERAGE_DIMENSIONS: readonly CoverageDimensionKind[] = [
  'PAGE_STATE',
  'ERROR_STATE',
  'DATA_VARIANT',
  'FORM_FIELD',
  'VALIDATION_RULE',
  'COMPONENT',
  'COMPONENT_STATE',
  'TEST_TYPE',
  'DEVICE_LOCALE',
  'FLAG_COMBINATION',
  'BACKGROUND_JOB',
  'NOTIFICATION',
];

/** Whether this build measures an axis at all. */
export function dimensionHasExtractor(dimension: CoverageDimensionKind): boolean {
  return EXTRACTED_COVERAGE_DIMENSIONS.includes(dimension);
}

/** The axes with no extractor, for the report to NAME rather than omit. */
export function unextractedDimensions(): CoverageDimensionKind[] {
  return COVERAGE_DIMENSIONS.filter((dimension) => !dimensionHasExtractor(dimension));
}

// ─── A cap that bit ─────────────────────────────────────────────────────────

/**
 * A budget, take, limit, page size or timeout that STOPPED THE MEASUREMENT.
 *
 * Rule 10 of this codebase, as a type: every cap that bit is reported as a
 * COUNT and as a REASON, so the report can say "at least 240 more form fields
 * existed" rather than quietly presenting a truncated denominator as the whole
 * application. `atLeastMore` is nullable because a cap that bit does not always
 * know how much it hid — a wall-clock timeout knows it stopped and not what it
 * stopped before. Null there is "more existed and we cannot say how many",
 * which is a weaker and still useful sentence; 0 would be the claim that
 * nothing was hidden, which is the opposite of what a bitten cap means.
 */
export interface DimensionCapBite {
  /** The cap's name as the customer configured it: `pageBudget`, `maxFields`. */
  cap: string;
  /** The value that bit. */
  limit: number;
  /** How many more cells existed beyond it, when the reader could tell. */
  atLeastMore: number | null;
  /** The sentence shown beside the number. Always written, never defaulted. */
  detail: string;
}

// ─── The measurement ────────────────────────────────────────────────────────

/**
 * ONE DIMENSION'S READING. The shape every one of the thirteen answers in.
 *
 * ── `tiers.denominator` IS `measured`, AND THAT IS THE WHOLE DESIGN ─────────
 *
 * There are two wrong ways to divide here and this field settles both.
 *
 *   · Dividing by `cells` would report every cell we never looked at as
 *     UNCOVERED. A route whose states were never enumerated would drag its
 *     dimension down for a reason that is a fact about our crawl.
 *   · Dividing by `measured` and printing nothing else would HIDE the cells we
 *     never looked at, which raises the figure every time our extractor gets
 *     worse — the exact property `SurfaceStatus.UNKNOWN` exists to deny.
 *
 * So both numbers are printed and neither is folded: the ladder divides by what
 * was measured, and `unmeasured` with its reason sits beside it. A reader can
 * see "34% of the 120 states we could measure, and 410 more we could not,
 * because the crawl never enumerated them". That is two facts; one percentage
 * would have been neither.
 *
 * `percent` is deliberately ABSENT. The figure is read off the ladder at a
 * named rung by {@link dimensionPercentAt} — one formula, `coveragePercent`,
 * null when there is nothing to divide. A `percent` field here would be a
 * second place the arithmetic could be done, and in a product whose only
 * sentence is a percentage, two places is two numbers.
 */
export interface DimensionMeasurement {
  dimension: CoverageDimensionKind;
  /**
   * Cells this dimension has for this subject, as far as anything knows:
   * `measured + unmeasured`. Enforced by `dimensionMeasurementSchema`, so a
   * reading whose parts do not reconstruct its whole is refused rather than
   * rendered.
   */
  cells: number;
  /** Cells an extractor produced a tier for. The ladder's denominator. */
  measured: number;
  /** Cells with no measurement. Counted, never dropped. */
  unmeasured: number;
  /**
   * WHY the unmeasured cells are unmeasured.
   *
   * REQUIRED AS A PROPERTY, nullable as a VALUE, and the two invariants are
   * both enforced: non-null exactly when `unmeasured > 0`. A null with
   * unmeasured cells is the lie this file exists to prevent; a reason with none
   * is a row claiming a limitation it did not hit.
   *
   * Not a two-arm discriminated union, and the reason is the six writers rather
   * than taste: arms differing only by `unmeasured: 0` make every arithmetic
   * expression over the field unassignable and six parallel agents would each
   * work around it differently. The invariant is held by
   * {@link measuredDimension} and {@link unmeasuredDimension}, which are the
   * only two constructors, plus the schema's refinements.
   */
  unmeasuredReason: DimensionUnmeasuredReason | null;
  /** The sentence beside the reason. Never defaulted to the empty string. */
  unmeasuredDetail: string | null;
  /** The ladder over the MEASURED cells. See the note above. */
  tiers: CoverageLadder;
  /**
   * Every cap that bit. `[]` is a positive claim that nothing was truncated,
   * which is the ordinary and verifiable case — the same judgement
   * `SuiteHealthSnapshot.caveats` records, and the reason the COUNTS above are
   * not defaulted while this is.
   */
  caps: DimensionCapBite[];
}

/**
 * A reading for an axis with an extractor: a tier per measured cell, plus
 * whatever was not measured and why.
 *
 * Takes the per-cell tiers as `(CoverageTier | null)[]` — the same input
 * `coverageLadder` takes, where null is a measured cell that nothing claims.
 * That is the gap this product exists to shrink and it stays IN the
 * denominator; it is NOT the same as an unmeasured cell, and keeping them as
 * two arguments is what stops them being merged.
 */
export function measuredDimension(input: {
  dimension: CoverageDimensionKind;
  /** One entry per measured cell. `null` means measured and unclaimed. */
  measuredCells: ReadonlyArray<CoverageTier | null>;
  unmeasured?: number;
  unmeasuredReason?: DimensionUnmeasuredReason | null;
  unmeasuredDetail?: string | null;
  caps?: readonly DimensionCapBite[];
}): DimensionMeasurement {
  const unmeasured = input.unmeasured ?? 0;
  if (unmeasured < 0) throw new Error('unmeasured cannot be negative');
  if (unmeasured > 0 && (input.unmeasuredReason ?? null) === null) {
    throw new Error(
      `${input.dimension}: ${unmeasured} unmeasured cell(s) with no reason — an unexplained ` +
        'unmeasured count is read as uncovered by the first consumer that forgets to check',
    );
  }
  if (unmeasured === 0 && (input.unmeasuredReason ?? null) !== null) {
    throw new Error(
      `${input.dimension}: an unmeasured reason with nothing unmeasured claims a limitation ` +
        'this reading did not hit',
    );
  }
  return {
    dimension: input.dimension,
    cells: input.measuredCells.length + unmeasured,
    measured: input.measuredCells.length,
    unmeasured,
    unmeasuredReason: input.unmeasuredReason ?? null,
    unmeasuredDetail: input.unmeasuredDetail ?? null,
    tiers: coverageLadder(input.measuredCells),
    caps: [...(input.caps ?? [])],
  };
}

/**
 * A reading for an axis that measured NOTHING. The constructor that cannot
 * produce a zero percent.
 *
 * `measured: 0` means `coverageLadder([])` means every rung's `percent` is
 * NULL, because `coveragePercent` returns null for an empty denominator. So a
 * dimension with no extractor renders as "not measured" by ARITHMETIC rather
 * than by a renderer remembering to check a flag — which is the difference
 * between a rule and a convention, and the reason this function exists instead
 * of a comment asking callers to be careful.
 *
 * `cells` may be known even when nothing was measured: we can know a form has
 * 40 fields and have measured none of them. `cells: 0` with
 * `NOT_ENUMERATED` is the other honest case — we do not even know how many
 * there are.
 */
export function unmeasuredDimension(input: {
  dimension: CoverageDimensionKind;
  reason: DimensionUnmeasuredReason;
  detail: string;
  /** Cells we know exist and did not measure. 0 when even the count is unknown. */
  cells?: number;
  caps?: readonly DimensionCapBite[];
}): DimensionMeasurement {
  const cells = input.cells ?? 0;
  if (cells < 0) throw new Error('cells cannot be negative');
  if (input.detail.length === 0) {
    throw new Error(
      `${input.dimension}: an unmeasured dimension needs the sentence that explains it — ` +
        'the reason code alone is not something a customer can act on',
    );
  }
  return {
    dimension: input.dimension,
    cells,
    measured: 0,
    unmeasured: cells,
    /*
     * The reason is kept even when `cells` is 0, which is the one place these
     * two constructors disagree about the invariant. An axis with no extractor
     * and no enumerated cells still has to say WHY it is empty: without the
     * reason it is indistinguishable from an axis that was measured and found
     * to have nothing, and those are opposite facts.
     */
    unmeasuredReason: input.reason,
    unmeasuredDetail: input.detail,
    tiers: coverageLadder([]),
    caps: [...(input.caps ?? [])],
  };
}

/**
 * One dimension's figure at one rung, or NULL.
 *
 * The only place a dimension percentage is produced, and it takes exactly one
 * measurement. It is structurally incapable of adding two denominators
 * together, which is the arithmetic this product has already been burned by.
 */
export function dimensionPercentAt(
  measurement: DimensionMeasurement,
  tier: CoverageTier,
): number | null {
  const rung = measurement.tiers.tiers.find((entry) => entry.tier === tier);
  if (!rung) return null;
  return coveragePercent(rung.atOrAbove, measurement.tiers.denominator);
}

/**
 * Whether a reading is a measurement at all.
 *
 * False when nothing was measured, whatever `cells` says. The predicate every
 * renderer asks before printing a figure, so that "not measured" and "0%" are
 * one branch apart rather than one rounding apart.
 */
export function dimensionWasMeasured(measurement: DimensionMeasurement): boolean {
  return measurement.measured > 0;
}

/**
 * The strongest rung this reading has evidence for, or null.
 *
 * Useful to a report that wants one word per axis. Returns null when nothing
 * was measured OR when nothing reached any rung — and those two are told apart
 * by {@link dimensionWasMeasured}, not by this function, because a single
 * return value cannot carry both facts without one of them being a guess.
 */
export function strongestDimensionTier(
  measurement: DimensionMeasurement,
): CoverageTier | null {
  let best: CoverageTier | null = null;
  for (const rung of measurement.tiers.tiers) {
    if (rung.atOrAbove === 0) continue;
    if (best === null || COVERAGE_TIER_RANK[rung.tier] > COVERAGE_TIER_RANK[best]) best = rung.tier;
  }
  return best;
}

// ─── Type obligations: what a surface OWES ──────────────────────────────────

/**
 * WHICH TEST TYPES EACH AXIS OWES, WHEN NOBODY HAS SAID.
 *
 * EVERY ENTRY IS EMPTY, AND THAT IS THE FEATURE.
 *
 * An obligation nobody declared is NOT OWED. The alternative — defaulting a
 * route to owing, say, an E2E and an ACCESSIBILITY test — would mint two
 * obligations per route on the day of the migration, report them all as
 * uncovered, and present QAAI's own opinion about what a team should test as
 * the team's debt. For a project with 412 routes that is 824 fabricated gaps
 * and a coverage number that fell for no reason connected to their code.
 *
 * A project states its obligations in `Project.typeObligationPolicy`, which is
 * NULLABLE WITH NO DEFAULT for the same reason: "this project never thought
 * about it" and "this project chose E2E only" stay distinguishable, and the UI
 * can say which.
 *
 * The `Record` is here anyway rather than an empty object, because it is the
 * compile-time guard: a thirteenth `SurfaceKind` breaks this line until
 * somebody decides what it owes, and the test below asserts every entry is
 * still empty — so the day somebody adds a default it is a deliberate, visible,
 * reviewed change rather than a line in a diff.
 */
export const DEFAULT_TYPE_OBLIGATIONS: Record<SurfaceKind, readonly TestType[]> = {
  ROUTE: [],
  ENDPOINT: [],
  FORM: [],
  AUTH_SURFACE: [],
  ROLE_CELL: [],
  COMPONENT_STATE: [],
  FLAG_COMBINATION: [],
  BACKGROUND_JOB: [],
  NOTIFICATION: [],
  ERROR_STATE: [],
  DEVICE_LOCALE: [],
  DATA_VARIANT: [],
};

/**
 * A project's declared obligation policy: which test types each axis owes.
 *
 * Partial on purpose. A policy that named every axis would force a customer to
 * state an opinion about `DATA_VARIANT` in order to say anything about
 * `ROUTE`, and an axis absent from the policy falls back to
 * {@link DEFAULT_TYPE_OBLIGATIONS} — which owes nothing.
 */
export interface TypeObligationPolicy {
  byKind: Partial<Record<SurfaceKind, readonly TestType[]>>;
}

/**
 * The test types one axis owes under one policy.
 *
 * Takes the policy as an ARGUMENT and never reads a default from anywhere
 * else, so the one place "what does this route owe" is answered cannot
 * disagree with itself. A null policy is a project that never configured one,
 * which owes the conservative default.
 */
export function obligationsFor(
  kind: SurfaceKind,
  policy: TypeObligationPolicy | null,
): readonly TestType[] {
  const declared = policy?.byKind[kind];
  if (declared === undefined) return DEFAULT_TYPE_OBLIGATIONS[kind];
  return declared;
}

/**
 * Every test type, as the obligation denominator's ceiling.
 *
 * Exported so a report can say "4 of 19 types are not executable here" with the
 * 19 coming from the one list `TEST_TYPES` rather than a number somebody typed.
 */
export const TEST_TYPE_COUNT = TEST_TYPES.length;

// ─── Deployment capability: which of the 19 types can run HERE ──────────────

/**
 * Whether this deployment can execute a test type at all.
 *
 * ── NOT_CHECKED IS NOT UNSUPPORTED, AND THE DIFFERENCE IS THE FEATURE ──────
 *
 * The worker image has no k6, no Lighthouse, no Stryker, no Maestro, no Firefox
 * and no WebKit, and the plugins for those types degrade to SKIPPED. So a pass
 * rate and a coverage percentage can both include tests that ALWAYS skip, and
 * nothing anywhere says which of the nineteen types this deployment can
 * actually run. That is a percentage with tests in it that cannot fail.
 *
 * Four states, and the fourth is the one a careless writer would collapse: a
 * type nobody probed is NOT_CHECKED. Reporting it as MISSING would be a claim
 * about the image we never looked at, and reporting it as AVAILABLE would let a
 * cached tick stand in for a binary that has since vanished. Same rule as
 * `ApiOperationVerification.NOT_PROBED` and `RouteAccessOutcome.NOT_PROBED`.
 */
export const DEPLOYMENT_CAPABILITY_STATUSES = [
  /** Probed, and the thing it needs is here and usable. */
  'AVAILABLE',
  /** Probed, and the binary, browser or driver is absent. */
  'MISSING',
  /** Probed, present, and outside the version range the plugin needs. */
  'WRONG_VERSION',
  /** Nobody asked. Not a verdict about the image. */
  'NOT_CHECKED',
] as const;
export type DeploymentCapabilityStatus = (typeof DEPLOYMENT_CAPABILITY_STATUSES)[number];

const DEPLOYMENT_CAPABILITY_STATUS_PRESENT: Record<DeploymentCapabilityStatus, true> = {
  AVAILABLE: true,
  MISSING: true,
  WRONG_VERSION: true,
  NOT_CHECKED: true,
};

export const DEPLOYMENT_CAPABILITY_STATUS_KINDS = Object.keys(
  DEPLOYMENT_CAPABILITY_STATUS_PRESENT,
) as ReadonlyArray<DeploymentCapabilityStatus>;

export const DEPLOYMENT_CAPABILITY_STATUS_LABELS: Record<DeploymentCapabilityStatus, string> = {
  AVAILABLE: 'this deployment can run it',
  MISSING: 'the binary, browser or driver it needs is not installed here',
  WRONG_VERSION: 'installed, but outside the version range this plugin needs',
  NOT_CHECKED: 'never probed — nothing is claimed in either direction',
};

/**
 * The statuses that take an obligation OUT of the coverage denominator, with a
 * reason.
 *
 * NOT_CHECKED is NOT here, and that is the point. An unprobed type stays in the
 * denominator: dropping it would mean a deployment that never ran a preflight
 * silently shed every obligation it could not prove it could run, and the
 * percentage would rise for a preflight nobody executed. Same argument as
 * `exercisabilityCounts` counting `undefined`.
 */
export const NON_EXECUTABLE_CAPABILITY_STATUSES: readonly DeploymentCapabilityStatus[] = [
  'MISSING',
  'WRONG_VERSION',
];

/** Whether an obligation of this type can be executed here, and therefore scored. */
export function capabilityCounts(status: DeploymentCapabilityStatus): boolean {
  return !NON_EXECUTABLE_CAPABILITY_STATUSES.includes(status);
}

/**
 * The sentinel for the deployment that is running this code.
 *
 * TEXT with a sentinel rather than a nullable column, because the unique key is
 * (deploymentKey, testType) and PostgreSQL treats NULLs as DISTINCT — a
 * nullable column there would let the same probe be written twice and the
 * upsert would stop being idempotent. Same reasoning and same angle-bracket
 * convention as `UNVARIED` and `<anonymous>`.
 */
export const SELF_DEPLOYMENT = '<self>';

/** The deployment key for a customer's own on-prem runner pool. */
export function runnerPoolDeploymentKey(pool: string): string {
  if (pool.length === 0) throw new Error('a runner pool deployment key needs a pool name');
  return `pool:${pool}`;
}

// ─── Comparability: when a delta is allowed to exist ────────────────────────

/**
 * WHETHER TWO SNAPSHOTS MAY BE SUBTRACTED.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * A delta is the number teams act on — it is what goes in the PR comment, the
 * badge and the digest — and it is the easiest number in this product to
 * compute wrongly, because subtracting two percentages always succeeds. Two
 * snapshots taken against DIFFERENT CRAWLS, or against different denominator
 * definitions, measured different applications. "Coverage fell 9 points" over
 * those two is not a regression, it is an artefact of our own enumeration
 * changing, and it will be read as a regression by everybody who sees it.
 *
 * So the delta is NULL unless the comparison is COMPARABLE, and the reason is
 * rendered in its place. The same rule, the same shape and the same argument as
 * `SURFACE_DRIFT_COMPARABILITIES` in constants.ts — a separate vocabulary only
 * because the reasons differ: a crawl diff cares whether the baseline was
 * ACCEPTED, and a snapshot diff cares whether the denominator moved under it.
 *
 * TEXT in the database rather than a Postgres enum, matching
 * `MutationSurvivor.reason`, `CoverageItem.unexercisableReason` and
 * `TestCoverageEdge.cappedBy`: nothing filters rows on it, the domain is
 * enforced at the producer by `snapshotComparabilitySchema`, and an enum here
 * would be another new type whose only job is to need a drift guard.
 */
export const SNAPSHOT_COMPARABILITIES = [
  /** Same crawl fingerprint and same denominator definition. Subtract away. */
  'COMPARABLE',
  /** The first snapshot for this subject. Everything is new, which is useless. */
  'UNCOMPARABLE_NO_BASELINE',
  /** The crawl changed under it, so the two measured different applications. */
  'UNCOMPARABLE_CRAWL_CHANGED',
  /** The denominator definition changed — a waiver, a scope rule, a new axis. */
  'UNCOMPARABLE_DENOMINATOR_CHANGED',
  /**
   * One side carries no fingerprint, so comparability itself is unprovable.
   * Every snapshot written before the column existed is in this state, and
   * reading it as COMPARABLE would produce a confident delta across an unknown
   * boundary.
   */
  'UNCOMPARABLE_FINGERPRINT_MISSING',
  /** The comparison did not run. Stops "no change" being claimed by nobody. */
  'NOT_COMPARED',
] as const;
export type SnapshotComparability = (typeof SNAPSHOT_COMPARABILITIES)[number];

const SNAPSHOT_COMPARABILITY_PRESENT: Record<SnapshotComparability, true> = {
  COMPARABLE: true,
  UNCOMPARABLE_NO_BASELINE: true,
  UNCOMPARABLE_CRAWL_CHANGED: true,
  UNCOMPARABLE_DENOMINATOR_CHANGED: true,
  UNCOMPARABLE_FINGERPRINT_MISSING: true,
  NOT_COMPARED: true,
};

export const SNAPSHOT_COMPARABILITY_KINDS = Object.keys(
  SNAPSHOT_COMPARABILITY_PRESENT,
) as ReadonlyArray<SnapshotComparability>;

export const SNAPSHOT_COMPARABILITY_LABELS: Record<SnapshotComparability, string> = {
  COMPARABLE: 'the same crawl and the same denominator, so the change is real',
  UNCOMPARABLE_NO_BASELINE: 'the first measurement of this subject — there is nothing to compare',
  UNCOMPARABLE_CRAWL_CHANGED:
    'the crawl changed between the two, so they measured different applications',
  UNCOMPARABLE_DENOMINATOR_CHANGED:
    'the denominator definition changed between the two, so the percentages are not the same measurement',
  UNCOMPARABLE_FINGERPRINT_MISSING:
    'one side carries no fingerprint, so whether they are comparable cannot be established',
  NOT_COMPARED: 'the comparison did not run',
};

/** Whether a delta computed across this pair means anything. */
export function deltaIsMeaningful(state: SnapshotComparability): boolean {
  return state === 'COMPARABLE';
}

/** One side of a comparison: the two things that have to match for a delta. */
export interface ComparabilityInput {
  /** The crawl the measurement was taken against. Null when none was recorded. */
  crawlFingerprint: string | null;
  /**
   * The sentence that defines what was divided by: which axes, which waivers,
   * which scope rules. Null when the writer did not record one.
   */
  denominatorDefinition: string | null;
}

export interface SnapshotDelta {
  comparability: SnapshotComparability;
  /** The sentence shown where a delta would otherwise go. Always written. */
  detail: string;
  /**
   * The change in percentage points, or NULL. Null whenever `comparability` is
   * anything but COMPARABLE, and null when either percent is null — a
   * measurement with no figure has no change.
   */
  deltaPercent: number | null;
}

/**
 * THE COMPARABILITY DECISION. Pure, no clock, no database, one place.
 *
 * `previous === null` is the no-baseline case and is the ONLY one that is not a
 * problem: a first measurement has nothing to compare, which is true and
 * useless, so the counts are null rather than a drift event on day one. Same
 * judgement as `UNCOMPARABLE_NO_BASELINE` in the crawl vocabulary.
 *
 * The order of the checks matters and is tested. A missing fingerprint is
 * reported BEFORE a changed one, because "we cannot establish comparability"
 * and "we established that they are not comparable" are different claims and
 * only the second one is evidence that the crawl moved.
 */
export function snapshotDelta(input: {
  current: ComparabilityInput & { percent: number | null };
  previous: (ComparabilityInput & { percent: number | null }) | null;
}): SnapshotDelta {
  const { current, previous } = input;
  if (previous === null) {
    return {
      comparability: 'UNCOMPARABLE_NO_BASELINE',
      detail: SNAPSHOT_COMPARABILITY_LABELS.UNCOMPARABLE_NO_BASELINE,
      deltaPercent: null,
    };
  }
  if (
    current.crawlFingerprint === null ||
    previous.crawlFingerprint === null ||
    current.denominatorDefinition === null ||
    previous.denominatorDefinition === null
  ) {
    return {
      comparability: 'UNCOMPARABLE_FINGERPRINT_MISSING',
      detail: SNAPSHOT_COMPARABILITY_LABELS.UNCOMPARABLE_FINGERPRINT_MISSING,
      deltaPercent: null,
    };
  }
  if (current.crawlFingerprint !== previous.crawlFingerprint) {
    return {
      comparability: 'UNCOMPARABLE_CRAWL_CHANGED',
      detail:
        `the crawl fingerprint changed from ${previous.crawlFingerprint} to ` +
        `${current.crawlFingerprint}, so the two snapshots measured different applications`,
      deltaPercent: null,
    };
  }
  if (current.denominatorDefinition !== previous.denominatorDefinition) {
    return {
      comparability: 'UNCOMPARABLE_DENOMINATOR_CHANGED',
      detail: SNAPSHOT_COMPARABILITY_LABELS.UNCOMPARABLE_DENOMINATOR_CHANGED,
      deltaPercent: null,
    };
  }
  if (current.percent === null || previous.percent === null) {
    return {
      comparability: 'COMPARABLE',
      /*
       * COMPARABLE with a null delta, which looks like a contradiction and is
       * not. The two measurements ARE the same measurement; one of them has no
       * figure, because its denominator was zero. Reporting that as
       * NOT_COMPARED would blame the comparison for an empty denominator, and
       * reporting a delta of 0 would claim nothing changed between a number and
       * an absence.
       */
      detail: 'comparable, but one side has no percentage to subtract — its denominator was zero',
      deltaPercent: null,
    };
  }
  return {
    comparability: 'COMPARABLE',
    detail: SNAPSHOT_COMPARABILITY_LABELS.COMPARABLE,
    // One decimal, matching `coveragePercent`, so a delta and the figures it
    // was taken between cannot round differently and fail to add up on screen.
    deltaPercent: Math.round((current.percent - previous.percent) * 10) / 10,
  };
}

// ─── Rollup scope: the key five writers must agree on ───────────────────────

/**
 * The sentinel for surface no feature could be attributed to.
 *
 * Spelled exactly as `apps/api/src/routes/issues.ts` already spells it (the
 * local `UNATTRIBUTED` const, used by `POST /issues/coverage` to file the gaps
 * with no feature), so the rollup's bucket and the issue filer's bucket are the
 * same bucket. Two spellings of "no feature" is two different 31%.
 */
export const UNATTRIBUTED_FEATURE = 'UNATTRIBUTED';

/**
 * The sentinel for surface nobody owns.
 *
 * Matching `UNOWNED` in the same route. UNOWNED SURFACE IS A FINDING — "31% of
 * the surface has no owner" is the most useful sentence a rollup produces — so
 * it gets a named bucket rather than being distributed among the teams that do
 * own things or dropped, either of which would make the finding disappear.
 */
export const UNOWNED_TEAM = 'UNOWNED';

/**
 * The environment a stored observation is attributed to when nothing recorded
 * one.
 *
 * Minted for `VisualBaseline.environmentId`, whose rows predate the column: one
 * baseline per (test, viewport, browser) means staging and production SHARE a
 * reference image, so a staging capture silently becomes the production
 * baseline and the red it produces is permanently false. Existing rows are
 * attributed here rather than guessed at — attributing them to a real
 * environment would be inventing the fact the column exists to record — and a
 * reader must treat an unattributed baseline as "no reference for any
 * environment, re-capture required" rather than as a reference for all of them.
 *
 * The safe failure (one re-approval per test on deploy) is disclosed in the
 * migration rather than discovered.
 */
export const UNATTRIBUTED_ENVIRONMENT = '<unattributed>';

/**
 * What one rollup row is about.
 *
 * Every member nullable, because the four combinations are four real questions:
 * the headline (all null), one dimension, one feature, one team, or a dimension
 * within a feature within a team.
 */
export interface RollupScope {
  dimension?: CoverageDimensionKind | null;
  /** The feature, or {@link UNATTRIBUTED_FEATURE}. */
  feature?: string | null;
  /** The team id, or {@link UNOWNED_TEAM}. */
  teamId?: string | null;
}

const SCOPE_RESERVED = /[%|=]/g;

function encodeScopePart(raw: string): string {
  return raw.replace(SCOPE_RESERVED, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeScopePart(raw: string): string {
  return raw.replace(/%(25|7C|3D)/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The headline scope's key: every rollup table's one unavoidable row. */
export const HEADLINE_SCOPE_KEY = 'HEADLINE';

/**
 * THE IDENTITY OF ONE ROLLUP SCOPE, and why it is a string rather than three
 * nullable columns in a unique index.
 *
 * PostgreSQL treats NULLs in a unique index as DISTINCT, so
 * `UNIQUE(snapshotId, dimension, feature, teamId)` would permit the headline
 * row — all three null — to be written an unbounded number of times, and the
 * writer's upsert would silently stop being idempotent. Every duplicate is a
 * second denominator for the same subject, which is how one screen comes to
 * disagree with another about the same percentage. So the identity is one NOT
 * NULL text column built here, and `dimension`, `feature` and `teamId` stay
 * beside it as the columns a reader FILTERS on.
 *
 * The format follows `dimensionCellIdentity`'s rules so there is one idiom:
 *
 *   HEADLINE
 *   DIM=PAGE_STATE
 *   FEATURE=payments|TEAM=t_7
 *   DIM=FORM_FIELD|FEATURE=checkout|TEAM=UNOWNED
 *
 *   1. Parts appear in a FIXED order — dimension, feature, team — not
 *      alphabetically and not in the order the caller passed them. Re-sorting a
 *      key retires every row it names and mints new ones.
 *
 *      A HONEST LIMIT ON THAT CLAIM, measured rather than assumed: `DIM`,
 *      `FEATURE` and `TEAM` are already in alphabetical order, so adding a
 *      `.sort()` to this function today changes nothing and NO TEST CAN SEE IT.
 *      That was confirmed by mutation — the mutant survived. It matters for the
 *      next person: a FOURTH part whose name sorts before `DIM` (say `AXIS`)
 *      would be emitted first by a stray sort and last by this code, and the
 *      two spellings would be two buckets for one subject. If a part is added,
 *      add it in a position where the two orders DIFFER, or the ordering rule
 *      goes back to being enforced by nothing but this comment.
 *   2. Values keep their case. A team called `Billing` and one called `billing`
 *      are two teams until the customer says otherwise.
 *   3. `|`, `=` and `%` are percent-encoded, so a feature called `a=b` cannot
 *      forge a second part.
 *   4. An empty string is REFUSED rather than treated as absent. `feature: ''`
 *      is a writer's bug, and silently filing it under the headline would merge
 *      a feature's numbers into the global ones.
 */
export function rollupScopeKey(scope: RollupScope): string {
  const parts: string[] = [];
  const dimension = scope.dimension ?? null;
  const feature = scope.feature ?? null;
  const teamId = scope.teamId ?? null;

  if (dimension !== null) parts.push(`DIM=${encodeScopePart(dimension)}`);
  if (feature !== null) {
    if (feature.length === 0) throw new Error('an empty feature is not a scope — pass null');
    parts.push(`FEATURE=${encodeScopePart(feature)}`);
  }
  if (teamId !== null) {
    if (teamId.length === 0) throw new Error('an empty team id is not a scope — pass null');
    parts.push(`TEAM=${encodeScopePart(teamId)}`);
  }
  return parts.length === 0 ? HEADLINE_SCOPE_KEY : parts.join('|');
}

/** Splits a scope key back apart. Null when the string is not one of ours. */
export function parseRollupScopeKey(key: string): RollupScope | null {
  if (key === HEADLINE_SCOPE_KEY) return { dimension: null, feature: null, teamId: null };
  const scope: RollupScope = { dimension: null, feature: null, teamId: null };
  const seen = new Set<string>();
  for (const part of key.split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator);
    if (seen.has(name)) return null;
    seen.add(name);
    const value = decodeScopePart(part.slice(separator + 1));
    if (value.length === 0) return null;
    if (name === 'DIM') {
      if (!COVERAGE_DIMENSIONS.includes(value as CoverageDimensionKind)) return null;
      scope.dimension = value as CoverageDimensionKind;
    } else if (name === 'FEATURE') {
      scope.feature = value;
    } else if (name === 'TEAM') {
      scope.teamId = value;
    } else {
      return null;
    }
  }
  return scope;
}

// ─── Self-measurement: the verdicts that measure the measurer ───────────────

/**
 * WHETHER A SEEDED DEFECT WAS FOUND.
 *
 * Four outcomes, and the third is the one that makes the benchmark worth
 * running. A benchmark that cannot tell "we had no test for this surface" from
 * "our test ran and passed anyway" reports both as MISSED and is useless in
 * both directions: the first is a coverage gap and the second is an assertion
 * gap, and only the second says the tests we DO have are weak.
 *
 * BASELINE_DIRTY is a refusal rather than a result. A fault left switched on
 * from a previous run makes every subsequent outcome meaningless, so the bench
 * asserts the clean baseline before AND after and reports this instead of a
 * detection rate it cannot stand behind.
 */
export const FAULT_DETECTION_OUTCOMES = [
  /** A test exercised the surface and went red. */
  'DETECTED',
  /** A test exercised the surface and passed anyway. The assertion is weak. */
  'MISSED',
  /** No test exercised the surface at all, so nothing was proved either way. */
  'NOT_EXERCISED',
  /** The clean baseline was dirty, so this reading means nothing. */
  'BASELINE_DIRTY',
] as const;
export type FaultDetectionOutcome = (typeof FAULT_DETECTION_OUTCOMES)[number];

const FAULT_DETECTION_OUTCOME_PRESENT: Record<FaultDetectionOutcome, true> = {
  DETECTED: true,
  MISSED: true,
  NOT_EXERCISED: true,
  BASELINE_DIRTY: true,
};

export const FAULT_DETECTION_OUTCOME_KINDS = Object.keys(
  FAULT_DETECTION_OUTCOME_PRESENT,
) as ReadonlyArray<FaultDetectionOutcome>;

export const FAULT_DETECTION_OUTCOME_LABELS: Record<FaultDetectionOutcome, string> = {
  DETECTED: 'a test exercised the surface and went red',
  MISSED: 'a test exercised the surface and passed anyway — the assertion is weak',
  NOT_EXERCISED: 'no test exercised the surface, so nothing was proved either way',
  BASELINE_DIRTY: 'the clean baseline was dirty, so this reading means nothing',
};

/**
 * The outcomes that belong in a detection RATE.
 *
 * NOT_EXERCISED is excluded from both halves of the fraction, and that is the
 * arithmetic the whole benchmark turns on: counting it as MISSED would blame
 * the assertions for a coverage gap, and counting it as DETECTED would be
 * fiction. It is reported as its own number beside the rate.
 */
export const RATED_FAULT_OUTCOMES: readonly FaultDetectionOutcome[] = ['DETECTED', 'MISSED'];

/**
 * Whether a validity back-test has enough data to say anything.
 *
 * "Does covered predict quality?" is the question a buyer actually asks, and it
 * is the question most easily answered with a flattering correlation computed
 * over four defects. So INSUFFICIENT_DATA is a first-class answer with the n
 * beside it, and NOT_ATTEMPTED is distinct from it: one says "we looked and
 * there is not enough", the other says "we did not look", and a buyer reading
 * silence as the first when it is the second is the failure this vocabulary
 * prevents.
 *
 * A note on wording that is binding rather than stylistic: nothing in this
 * product may present this as a CAUSAL claim. The field names say `escapedRate`
 * and the verdict says `SUFFICIENT`, never `PROVEN` and never `PREDICTS`.
 */
export const VALIDITY_VERDICTS = [
  /** Enough defects landed in the window to report both rates. */
  'SUFFICIENT',
  /** We looked and there are not enough defects for the result to mean anything. */
  'INSUFFICIENT_DATA',
  /** No back-test ran. Not a verdict about the correlation. */
  'NOT_ATTEMPTED',
] as const;
export type ValidityVerdict = (typeof VALIDITY_VERDICTS)[number];

const VALIDITY_VERDICT_PRESENT: Record<ValidityVerdict, true> = {
  SUFFICIENT: true,
  INSUFFICIENT_DATA: true,
  NOT_ATTEMPTED: true,
};

export const VALIDITY_VERDICT_KINDS = Object.keys(
  VALIDITY_VERDICT_PRESENT,
) as ReadonlyArray<ValidityVerdict>;

export const VALIDITY_VERDICT_LABELS: Record<ValidityVerdict, string> = {
  SUFFICIENT: 'enough defects landed in the window to report both rates',
  INSUFFICIENT_DATA: 'too few defects for the comparison to mean anything — the n is stated',
  NOT_ATTEMPTED: 'no back-test ran',
};

/**
 * The fewest defects a back-test will compute a rate from.
 *
 * Thirty, and the number is a judgement rather than a theorem: below it a
 * single mis-attributed ticket moves the reported rate by more than three
 * percentage points, which is larger than any difference the product would
 * claim to have found. A CONSTANT and not a column, for the same reason as
 * `DEFAULT_COVERAGE_FRESHNESS_DAYS`: a threshold a customer can lower is a
 * threshold that gets lowered until the number means nothing, and the one place
 * it is applied reports the value it used.
 */
export const MINIMUM_BACKTEST_DEFECTS = 30;

/** Whether a defect count supports a rate at all. */
export function backtestVerdict(defectCount: number): ValidityVerdict {
  return defectCount >= MINIMUM_BACKTEST_DEFECTS ? 'SUFFICIENT' : 'INSUFFICIENT_DATA';
}

/**
 * Every axis in this file whose members are pinned against a SURFACE_KINDS
 * axis, for the test that holds them there.
 *
 * Exported so the assertion lives in the test file and the LIST lives beside
 * the descriptors — a test that hard-codes thirteen dimension names goes stale
 * the moment a fourteenth lands, and a stale test is one somebody deletes.
 */
export function dimensionAxesReferenced(): SurfaceKind[] {
  const axes = new Set<SurfaceKind>();
  for (const descriptor of Object.values(COVERAGE_DIMENSION_DESCRIPTORS)) {
    for (const kind of descriptor.refines) axes.add(kind);
    if (descriptor.cellAxis !== null) axes.add(descriptor.cellAxis);
  }
  return [...axes].filter((kind) => SURFACE_KINDS.includes(kind));
}
