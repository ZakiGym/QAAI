/**
 * Form fields, validation rules, components and component states — as CELLS,
 * not as booleans.
 *
 * WHY THIS FILE EXISTS
 *
 * `packages/agent/src/coverage.ts:1168` marks a whole form "exercised" if any
 * test mentions its submit label, or one field label alongside a `.fill()`. So
 * a fourteen-field checkout form with one test that types into the email box is
 * 100% of the FORM axis, and `required`, `semantic` and every boundary case are
 * counted by nobody. One tick for fourteen inputs, eleven validation rules and
 * a payment path.
 *
 * `UNIT_GEN` has the mirror of the same hole from the other end: components and
 * component states are enumerated by the ENUMERATE source round and NOTHING
 * divides by them, so "3 of 41 components have a test for their error state" is
 * a sentence this product cannot say about an application it has already
 * finished reading.
 *
 * ── FOUR DENOMINATORS, AND THEY ARE NEVER SUMMED ────────────────────────────
 *
 * {@link FIELD_COVERAGE_DIMENSIONS} is FORM_FIELD, VALIDATION_RULE, COMPONENT
 * and COMPONENT_STATE. The task that commissioned this module said three; the
 * keystone's `CELL_KIND_DIMENSION` maps `COMPONENT` and the six `COMPONENT_*`
 * kinds to two DIFFERENT dimensions, so folding them into one figure would be
 * two denominators added together to make one percentage — the arithmetic that
 * once made controls 80% of this product's headline. Four it is, and
 * {@link fieldCoveragePercentAt} takes ONE dimension at a time so the summing
 * is not merely discouraged but unavailable.
 *
 * A field cell and a rule cell are two things to test. A fourteen-field form
 * with one `required` attribute read and eleven constraints never looked at is
 * fourteen field cells, one measured rule cell and eleven cells reported as
 * UNMEASURED with the reason — which is three numbers where the old code had a
 * tick.
 *
 * ── THE RULES THAT DECIDE EVERY LINE BELOW ──────────────────────────────────
 *
 *   · WRITTEN IS NOT RUN. Everything this module can see is a regular
 *     expression's opinion about a string in a file, so every static claim goes
 *     through `promoteCoverageTier` with `source: 'STATIC'` and is capped at
 *     DECLARED by `COVERAGE_EDGE_SOURCE_CEILING`. This file does not own a
 *     second ceiling and must never grow one.
 *   · A FILL IS NOT AN ASSERTION. Typing into the email box claims the FIELD
 *     cell and claims NOTHING about the `required` rule. A rule cell is claimed
 *     only when a test drives the field with a value that VIOLATES the rule and
 *     asserts in the same window — see {@link RULE_VIOLATION_CHECKS}. The
 *     weaker reading (an assertion near the field with no violating value) is
 *     counted and DISCLOSED rather than folded in, because a cell reported as
 *     covered when nothing asserts the rule is the vendor-flattering lie, and
 *     the conservative direction is the one the report can defend.
 *   · NOT MEASURED IS NULL, NEVER 0. A constraint nothing read, a semantic we
 *     have no deterministic check for, a dialect whose assertions live in a
 *     step definition we cannot see — each of those is an UNMEASURED cell with
 *     a reason from `DIMENSION_UNMEASURED_REASONS`, never a cell at 0 and never
 *     a cell quietly absent.
 *   · A NULL IS NOT A FALSE. `required: null` means the reader could not read
 *     the attribute; `required: false` means it looked and the field is
 *     optional. The first is an unmeasured rule cell, the second is no rule at
 *     all. Collapsing them removes the cell from the denominator and raises the
 *     percentage, which is the specific defect the register names.
 *   · UNEXERCISABLE LEAVES THE DENOMINATOR AND IS NAMED. A `maxlength` on a
 *     number input is an attribute the browser ignores: there is no outcome to
 *     assert, so the cell is UNEXERCISABLE with a reason and HELD_OUT of the
 *     ladder. It is never scored as a pass and never silently dropped.
 *
 * ── NO I/O ──────────────────────────────────────────────────────────────────
 *
 * Everything arrives as a narrow injected interface: forms, components, tests,
 * run observations, waivers and `nowIso`. There is no clock, no filesystem, no
 * database and no browser in here, which is what makes the whole thing
 * exercisable against a fake. 629 lines of crawler.ts had almost no tests for
 * exactly the opposite reason.
 */

import {
  COMPONENT_STATE_KINDS,
  COVERAGE_TIER_RANK,
  DEFAULT_COVERAGE_FRESHNESS_DAYS,
  DIMENSION_UNMEASURED_REASONS,
  cellKindsFor,
  componentHasOwnAxis,
  dialect as dialectRecord,
  dimensionCellIdentity,
  dimensionPercentAt,
  findAssertions,
  measuredDimension,
  promoteCoverageTier,
  type ComponentItemKind,
  type ComponentStateKind,
  type CoverageCellKind,
  type CoverageDimensionKind,
  type CoverageTier,
  type DialectId,
  type DimensionCapBite,
  type DimensionMeasurement,
  type DimensionUnmeasuredReason,
  type FormFieldSemantic,
  type SurfaceExercisability,
  type SurfaceSource,
  type TestResultStatus,
  type TierCapReason,
  type UnexercisableReason,
} from '@qaai/shared';

// ─── The four dimensions this module measures ───────────────────────────────

/**
 * The axes this module puts a denominator behind.
 *
 * Narrowed from `CoverageDimensionKind` rather than re-spelled, so a rename in
 * the keystone breaks this line instead of silently producing a `measurements`
 * record keyed on a dimension nothing else in the product knows about.
 */
export type FieldCoverageDimension = Extract<
  CoverageDimensionKind,
  'FORM_FIELD' | 'VALIDATION_RULE' | 'COMPONENT' | 'COMPONENT_STATE'
>;

export const FIELD_COVERAGE_DIMENSIONS = [
  'FORM_FIELD',
  'VALIDATION_RULE',
  'COMPONENT',
  'COMPONENT_STATE',
] as const satisfies readonly FieldCoverageDimension[];

/**
 * The compile-time half of the guard this codebase requires for a vocabulary
 * with a write path, as a presence record keyed on the union.
 *
 * The run-time half is in coverage-fields.test.ts, which compares this list
 * against the cell kinds `CELL_KIND_DIMENSION` actually maps into these four
 * dimensions. Eight `GateRule` kinds shipped unsaveable for two slices because
 * only one of the two mechanisms existed, and `check:wiring` cannot see that
 * class of defect.
 */
const FIELD_COVERAGE_DIMENSION_PRESENT: Record<FieldCoverageDimension, true> = {
  FORM_FIELD: true,
  VALIDATION_RULE: true,
  COMPONENT: true,
  COMPONENT_STATE: true,
};

export const FIELD_COVERAGE_DIMENSION_KINDS = Object.keys(
  FIELD_COVERAGE_DIMENSION_PRESENT,
) as ReadonlyArray<FieldCoverageDimension>;

// ─── Validation rules: the slugs, and the cell kind each one counts on ──────

/**
 * ONE VALIDATION RULE, AS A SLUG.
 *
 * ── Why a slug and not just the cell kind ───────────────────────────────────
 *
 * `CELL_KIND_DIMENSION` has six RULE_* kinds, and a field can carry TWO rules
 * of the same kind: `maxlength` and `minlength` are both RULE_LENGTH, `min` and
 * `max` are both RULE_RANGE. Keying a cell on the kind alone would collide
 * them, and a collision is not a smaller denominator — it is the same
 * application divided by a number that drops a boundary nobody will ever test.
 * So the cell's identity carries the slug and the ROW carries the kind, and
 * {@link VALIDATION_RULE_CELL_KIND} is the one place the two are related.
 *
 * ── The three groups ────────────────────────────────────────────────────────
 *
 *   `required`                         the attribute the register names as
 *                                      counted by nobody, first in the list
 *                                      because it is the cheapest real gap in
 *                                      any form.
 *   the five constraint attributes     maxlength / minlength / min / max /
 *                                      step / pattern. `detectForms` on the
 *                                      SOURCE path reads none of them, which is
 *                                      why `constraintsRead` exists.
 *   the semantic rules                 what the MEANING of the field implies: a
 *                                      Luhn check on a card, a future date on
 *                                      an expiry, an @ in an email. The second
 *                                      case the register names.
 *
 * `semantic-unclassified` is the sixteenth and is not a rule at all: it is the
 * placeholder cell a field gets when nothing classified it, so that "we do not
 * know what this field means" is a visible unmeasured row rather than an absent
 * one. It is the only slug with no violating value by construction.
 */
export const VALIDATION_RULE_SLUGS = [
  'required',
  'maxlength',
  'minlength',
  'min',
  'max',
  'step',
  'pattern',
  'email-shape',
  'url-shape',
  'luhn',
  'expiry-future',
  'date-real',
  'phone-shape',
  'postcode-shape',
  'numeric-shape',
  'semantic-unclassified',
] as const;
export type ValidationRuleSlug = (typeof VALIDATION_RULE_SLUGS)[number];

/**
 * WHICH CELL KIND EACH SLUG IS STORED AND COUNTED AS.
 *
 * A `Record` keyed on the slug union, so a seventeenth slug breaks this line
 * rather than producing rows with a kind nobody chose. The test holds the
 * mirror invariant — every RULE_* kind in `cellKindsFor('VALIDATION_RULE')` is
 * produced by at least one slug — because a cell kind the keystone declares and
 * this module cannot mint is a cell with no possible evidence.
 */
export const VALIDATION_RULE_CELL_KIND: Record<ValidationRuleSlug, CoverageCellKind> = {
  required: 'RULE_REQUIRED',
  maxlength: 'RULE_LENGTH',
  minlength: 'RULE_LENGTH',
  min: 'RULE_RANGE',
  max: 'RULE_RANGE',
  step: 'RULE_STEP',
  pattern: 'RULE_PATTERN',
  'email-shape': 'RULE_SEMANTIC',
  'url-shape': 'RULE_SEMANTIC',
  luhn: 'RULE_SEMANTIC',
  'expiry-future': 'RULE_SEMANTIC',
  'date-real': 'RULE_SEMANTIC',
  'phone-shape': 'RULE_SEMANTIC',
  'postcode-shape': 'RULE_SEMANTIC',
  'numeric-shape': 'RULE_SEMANTIC',
  'semantic-unclassified': 'RULE_SEMANTIC',
};

export const VALIDATION_RULE_LABELS: Record<ValidationRuleSlug, string> = {
  required: 'required — submitting it empty must be refused',
  maxlength: 'maxlength — one character over must be refused',
  minlength: 'minlength — one character under must be refused',
  min: 'min — a value below the floor must be refused',
  max: 'max — a value above the ceiling must be refused',
  step: 'step — a value off the step must be refused',
  pattern: 'pattern — a value the pattern rejects must be refused',
  'email-shape': 'email shape — an address with no @ must be refused',
  'url-shape': 'URL shape — a string that is not a URL must be refused',
  luhn: 'Luhn — a card number that fails the checksum must be refused',
  'expiry-future': 'expiry in the future — a past expiry must be refused',
  'date-real': 'a real date — 30 February must be refused',
  'phone-shape': 'phone shape — a number with letters in it must be refused',
  'postcode-shape': 'postcode shape — a malformed postcode must be refused',
  'numeric-shape': 'numeric — text in a numeric field must be refused',
  'semantic-unclassified': 'nothing classified what this field means',
};

/**
 * THE CONSTRAINT ATTRIBUTES, AS THE SLUGS DERIVED FROM A READING.
 *
 * Separate from the semantic slugs because these six are the ones
 * `constraintsRead` is about: a field whose constraints were never read owes
 * one UNMEASURED cell for each of these that COULD apply to its input type,
 * and owes nothing at all for the semantic rules, which come from the
 * classifier rather than from the markup.
 */
const CONSTRAINT_SLUGS = [
  'maxlength',
  'minlength',
  'min',
  'max',
  'step',
  'pattern',
] as const satisfies readonly ValidationRuleSlug[];
type ConstraintSlug = (typeof CONSTRAINT_SLUGS)[number];

/**
 * WHICH INPUT TYPES THE BROWSER ACTUALLY HONOURS EACH CONSTRAINT ON.
 *
 * Straight out of the HTML specification, and load-bearing rather than
 * pedantic: `maxlength` on `<input type="number">` is an attribute the browser
 * IGNORES. A cell minted for it is a boundary nothing can ever satisfy — there
 * is no outcome to assert, so the test can never be written and the gap can
 * never be closed. An unclosable gap gets gamed instead of met, which is the
 * argument `NON_DENOMINATOR_EXERCISABILITIES` already makes one level up. Such
 * a cell is therefore UNEXERCISABLE with a reason and leaves the denominator,
 * and the fact that the page declares an attribute the browser drops is
 * reported — it is a finding about their markup, not about their tests.
 *
 * A `Record` keyed on the constraint slug union, so a seventh constraint cannot
 * be added without somebody stating where it applies.
 */
const CONSTRAINT_APPLIES_TO: Record<ConstraintSlug, readonly string[]> = {
  maxlength: ['text', 'search', 'url', 'tel', 'email', 'password', 'textarea'],
  minlength: ['text', 'search', 'url', 'tel', 'email', 'password', 'textarea'],
  min: ['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local'],
  max: ['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local'],
  step: ['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local'],
  // Deliberately not `textarea`: the pattern attribute does not exist on one.
  pattern: ['text', 'search', 'url', 'tel', 'email', 'password'],
};

/**
 * WHAT THE MEANING OF A FIELD IMPLIES, PER SEMANTIC.
 *
 * A `Record` keyed on `FormFieldSemantic` — the nineteen-member vocabulary
 * `flow-map.ts` owns — so a twentieth semantic there breaks this line. That is
 * the point: a new semantic with no entry would silently imply no rules, and
 * "this field means nothing testable" is a claim that has to be made on
 * purpose.
 *
 * AN EMPTY LIST HERE MEANS "WE LOOKED AND THIS MEANING IMPLIES NO RULE WE CAN
 * CHECK", and it is NOT the same as an unclassified field. `unknown` is in the
 * table with an empty list for totality and is SPECIAL-CASED before the table
 * is consulted — see {@link semanticRuleSlugs} — because `unknown` is the
 * classifier saying it could not decide, which is an UNMEASURED cell and not an
 * absence of rules. A `password` field is the honest empty case: the policy
 * that governs it ("eight characters, one digit") is nowhere in the markup, so
 * there is no rule here to count.
 */
export const SEMANTIC_RULE_SLUGS: Record<FormFieldSemantic, readonly ValidationRuleSlug[]> = {
  email: ['email-shape'],
  password: [],
  username: [],
  person_name: [],
  phone: ['phone-shape'],
  street_address: [],
  city: [],
  postal_code: ['postcode-shape'],
  country: [],
  credit_card: ['luhn'],
  card_expiry: ['expiry-future'],
  card_cvc: ['numeric-shape'],
  date: ['date-real'],
  number: ['numeric-shape'],
  currency: ['numeric-shape'],
  url: ['url-shape'],
  search: [],
  freeform: [],
  unknown: [],
};

/** Every string the semantic table knows, for narrowing a free-text column. */
const KNOWN_SEMANTICS = new Set<string>(Object.keys(SEMANTIC_RULE_SLUGS));

/**
 * The rules a field's semantic implies, or NULL when the semantic itself was
 * never established.
 *
 * Null is the UNMEASURED case and is three different inputs: the column was
 * null (nothing classified it), the classifier returned `unknown` (it ran and
 * could not decide), or the column holds a string this build's table has never
 * heard of (a reader newer than this module). All three are "we cannot say what
 * rules this field owes", which must never render as "this field owes none".
 */
function semanticRuleSlugs(semantic: string | null): readonly ValidationRuleSlug[] | null {
  if (semantic === null || semantic === 'unknown') return null;
  if (!KNOWN_SEMANTICS.has(semantic)) return null;
  return SEMANTIC_RULE_SLUGS[semantic as FormFieldSemantic];
}

// ─── Deterministic violation checks ─────────────────────────────────────────

/**
 * Whether one literal from a test VIOLATES one rule.
 *
 * `null` for a slug we have no deterministic check for, and that null is the
 * whole reason this is a table instead of a switch. A phone number's shape and
 * a postcode's shape are real rules that QAAI cannot check model-free in this
 * build: there is no deterministic predicate that says a string is not a valid
 * phone number without a country, and inventing a loose one ("it contains a
 * letter") would attribute coverage to tests that assert something else. So
 * those cells are reported UNMEASURED with `NO_EXTRACTOR` — a fact about our
 * product, named as ours — instead of being scored either way.
 *
 * Measurement here is 100% model-free and deterministic on purpose. There is no
 * ANTHROPIC_API_KEY in this environment and none is wanted: a percentage whose
 * inputs depend on a sampled model answer is not a measurement.
 */
type RuleViolationCheck = (literal: string, rule: DerivedRule, nowIso: string) => boolean;

const RULE_VIOLATION_CHECKS: Record<ValidationRuleSlug, RuleViolationCheck | null> = {
  // The empty string IS the violation of `required`, which is why the matcher
  // below keeps zero-length literals that every other check discards.
  required: (literal) => literal.length === 0,
  maxlength: (literal, rule) => rule.bound !== null && literal.length > rule.bound,
  minlength: (literal, rule) =>
    rule.bound !== null && literal.length > 0 && literal.length < rule.bound,
  min: (literal, rule) => {
    const value = numeric(literal);
    return value !== null && rule.bound !== null && value < rule.bound;
  },
  max: (literal, rule) => {
    const value = numeric(literal);
    return value !== null && rule.bound !== null && value > rule.bound;
  },
  step: (literal, rule) => {
    const value = numeric(literal);
    if (value === null || rule.bound === null || rule.bound <= 0) return false;
    // Scaled to integers before the modulo: 0.3 % 0.1 is 0.09999999999999998 in
    // IEEE 754, which would report every decimal step as violated.
    const scale = 1_000_000;
    return Math.round(value * scale) % Math.round(rule.bound * scale) !== 0;
  },
  pattern: (literal, rule) => {
    if (rule.pattern === null) return false;
    const compiled = compilePattern(rule.pattern);
    // A pattern we could not compile is UNEXERCISABLE before it reaches here,
    // so this branch is the belt to that braces and must not read as "violated".
    if (compiled === null) return false;
    return !compiled.test(literal);
  },
  'email-shape': (literal) => literal.length > 0 && !literal.includes('@'),
  'url-shape': (literal) => {
    if (literal.length === 0) return false;
    try {
      new URL(literal);
      return false;
    } catch {
      return true;
    }
  },
  luhn: (literal) => {
    const digits = literal.replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(digits)) return false;
    return !luhnValid(digits);
  },
  'expiry-future': (literal, _rule, nowIso) => {
    const expiry = monthEnd(literal);
    const now = Date.parse(nowIso);
    if (expiry === null || Number.isNaN(now)) return false;
    return expiry < now;
  },
  'date-real': (literal) => impossibleDate(literal),
  /*
   * The three we do not check. See the header: a loose predicate here would
   * attribute coverage to a test that asserts something else, and that is the
   * lie this product cannot afford. `semantic-unclassified` is not a rule and
   * has nothing to violate by construction.
   */
  'phone-shape': null,
  'postcode-shape': null,
  'semantic-unclassified': null,
  'numeric-shape': (literal) => literal.length > 0 && numeric(literal) === null,
};

/** A number, or null when the literal is not one. Blank is not zero. */
function numeric(literal: string): number | null {
  if (literal.trim().length === 0) return null;
  const value = Number(literal);
  return Number.isFinite(value) ? value : null;
}

/**
 * The `pattern` attribute as a full-match regular expression, or null when it
 * does not compile.
 *
 * Anchored, because the HTML `pattern` attribute is a full match and an
 * unanchored test would call every string valid. Wrapped in try/catch because
 * an invalid pattern must not throw — a page is allowed to carry a broken
 * attribute and our reading of it is not allowed to take the report down.
 */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`);
    } catch {
      return null;
    }
  }
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = digits.charCodeAt(index) - 48;
    if (double) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
    double = !double;
  }
  return sum % 10 === 0;
}

/** The last instant of a `YYYY-MM` or `MM/YY` expiry, or null when unreadable. */
function monthEnd(literal: string): number | null {
  const iso = /^(\d{4})-(\d{2})$/.exec(literal.trim());
  if (iso) return monthEndFrom(Number(iso[1]), Number(iso[2]));
  const short = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(literal.trim());
  if (!short) return null;
  const rawYear = Number(short[2]);
  // A two-digit year in a card expiry is 20xx. There are no 1990s cards in
  // circulation and reading `12/24` as 1924 would call every expiry expired.
  const year = (short[2] ?? '').length === 2 ? 2000 + rawYear : rawYear;
  return monthEndFrom(year, Number(short[1]));
}

function monthEndFrom(year: number, month: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return Date.UTC(year, month, 1) - 1;
}

/**
 * Whether a date literal names a day that does not exist.
 *
 * `Date.parse('2024-02-30')` is NaN in V8 for the ISO form, but the check is
 * written on the components rather than on the parser because a parser's
 * leniency is not a property this measurement may depend on.
 */
function impossibleDate(literal: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(literal.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return true;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > daysInMonth;
}

// ─── Input: forms and fields ────────────────────────────────────────────────

/**
 * THE CONSTRAINTS AS A READER FOUND THEM.
 *
 * Mirrors `formFieldConstraintSchema` in packages/shared/src/schemas.ts member
 * for member, and EVERY MEMBER IS REQUIRED AND NULLABLE for the reason stated
 * there: an omitted key and a null are the same thing to `JSON.stringify` and
 * NOT the same thing to a reader that uses `in` or `??`, so making the writer
 * say `maxLength: null` is the only way the distinction survives the round trip.
 *
 * `min`, `max` and `step` are NUMBERS here because the stored column is numeric.
 * The DOM attributes are not: `min` is `"2024-01-01"` on a date input and
 * `"08:00"` on a time input. A reader that meets one of those cannot represent
 * it, and must say so through {@link FieldCoverageField.unreadableConstraints}
 * rather than coercing it to NaN or dropping it — see the note on that field.
 */
export interface FormFieldConstraintReading {
  maxLength: number | null;
  minLength: number | null;
  min: number | null;
  max: number | null;
  step: number | null;
  pattern: string | null;
}

/** One field of one form, as the enumerator found it. */
export interface FieldCoverageField {
  /** The `name` attribute. Identity within the form; never empty. */
  name: string;
  /** What a human reads. Null when the reader found no label of any kind. */
  label: string | null;
  /**
   * HTML input type, or `select` / `textarea`. NULL means the reader could not
   * tell, which is NOT the same as `text`: the applicability of every
   * constraint depends on it, so a null makes the constraint cells unmeasured
   * rather than inapplicable.
   */
  inputType: string | null;
  /**
   * THREE STATES, AND THIS IS THE MOST IMPORTANT FIELD IN THE INTERFACE.
   *
   * `null` — the reader could not read the attribute. The `required` rule cell
   * exists and is UNMEASURED.
   * `false` — it looked, and the field is optional. There is NO required rule,
   * so there is no cell. Not an unmeasured one: an absent rule.
   * `true` — the rule exists and is measured.
   */
  required: boolean | null;
  /** What the field means. NULL or `unknown` makes its semantic rules unmeasured. */
  semantic: string | null;
  /** NULL means the constraints were never read. See {@link constraintsRead}. */
  constraint: FormFieldConstraintReading | null;
  /**
   * Whether anything even TRIED to read the constraints.
   *
   * `false` with a null `constraint` is the honest state of the SOURCE path:
   * `detectForms` in packages/shared/src/codebase.ts reads no maxlength,
   * minlength, min, max, step or pattern at all, so six of this module's
   * constraint classes are unreachable from there. `true` with a null
   * constraint is a reader bug and {@link analyseFieldCoverage} refuses it.
   */
  constraintsRead: boolean;
  /**
   * Constraint slugs the reader SAW on the page and could not represent.
   *
   * The date case above is the one that forced this field to exist: a page
   * declaring `min="2024-01-01"` has a real range rule, the numeric column
   * cannot hold it, and both of the alternatives are lies — dropping it reports
   * a field with nothing to test, and coercing it reports a bound of NaN. So
   * the slug is named here, the cell is UNMEASURED with
   * `EXTRACTOR_RETURNED_UNKNOWN`, and the detail says which attribute we could
   * not keep.
   */
  unreadableConstraints?: readonly ConstraintSlug[];
  /** Set when the enumerator already decided a test may not drive this field. */
  exercise?: FieldCellExercise | null;
}

/**
 * One form, as the enumerator found it.
 *
 * `itemKey` is the `CoverageItem.key` of the FORM row — `FORM:<identity>` as
 * `surfaceKey` built it. Required rather than nullable, because a form cell
 * with no registry row to hang on cannot be written and a denominator of rows
 * nothing can store is not a denominator.
 */
export interface FieldCoverageForm {
  itemKey: string;
  name: string;
  /**
   * The canonical route the form is on, or null for a form read out of the
   * source with no route attached. Null WIDENS the match: route scoping is what
   * stops a test that mentions "Save" from claiming the Save button on five
   * pages, and with no route there is nothing to scope by, so the fact is
   * disclosed as a caveat rather than silently treated as a match everywhere.
   */
  route: string | null;
  /** Which declarer found the form. */
  source: SurfaceSource;
  fields: readonly FieldCoverageField[];
}

/**
 * Why a cell cannot be driven here.
 *
 * The same three columns and the same contract as `CoverageItem` and
 * `CoverageItemState`: a cell the harness may not drive stays in the inventory,
 * leaves the denominator, and is NAMED. `detail` is always written — "excluded
 * by policy" with no sentence is indistinguishable from a bug in the reader,
 * and the customer's only possible response to that is to distrust the number.
 */
export interface FieldCellExercise {
  state: SurfaceExercisability;
  reason?: UnexercisableReason | null;
  rule?: string | null;
  detail: string;
}

// ─── Input: components ──────────────────────────────────────────────────────

/** One declared state of one component, as the ENUMERATE source round wrote it. */
export interface ComponentCoverageState {
  kind: ComponentStateKind;
  /** SOURCE for a render branch, CATALOGUE for a story, MANUAL for a person. */
  source: SurfaceSource;
  evidence: string;
}

/**
 * One component, as `ComponentItem` holds it.
 *
 * ── `states: null` IS NOT `states: []` ──────────────────────────────────────
 *
 * `null` means NOBODY ENUMERATED THIS COMPONENT'S STATES. `[]` means a reader
 * looked and the component declares none. The first owes an unmeasured cell on
 * the COMPONENT_STATE axis; the second owes nothing, because a reader that
 * looked and found nothing has measured the component and found it stateless.
 * Collapsing the two is how "0% of your component states are covered" gets
 * printed about a project whose states we never read.
 *
 * ── `itemKey: null` ─────────────────────────────────────────────────────────
 *
 * `ComponentState.coverageItemKey` is nullable by design — the registry row is
 * written by a different pass and may not exist yet — so a component can reach
 * here with no key. Its cells cannot be written against an item, so they are
 * UNMEASURED with `NOT_ENUMERATED` and the dangling reference is reported. That
 * is a fact about OUR extractor, and it is the kind we refuse to hide.
 */
export interface ComponentCoverageItem {
  itemKey: string | null;
  modulePath: string;
  exportName: string;
  kind: ComponentItemKind;
  source: SurfaceSource;
  /** Three states; null means no catalogue was read. Reported, never divided by. */
  hasCatalogueEntry: boolean | null;
  states: readonly ComponentCoverageState[] | null;
  exercise?: FieldCellExercise | null;
}

/**
 * THE COMPONENT STATE KIND → CELL KIND MAP.
 *
 * A `Record` keyed on `ComponentStateKind`, so a seventh state in
 * api-surface.ts breaks this line instead of producing states that belong to no
 * cell kind and are therefore counted nowhere. Counted nowhere is the invisible
 * state, and invisible flatters the number.
 */
const COMPONENT_STATE_CELL_KIND: Record<ComponentStateKind, CoverageCellKind> = {
  DEFAULT: 'COMPONENT_DEFAULT',
  LOADING: 'COMPONENT_LOADING',
  EMPTY: 'COMPONENT_EMPTY',
  ERROR: 'COMPONENT_ERROR',
  FORBIDDEN: 'COMPONENT_FORBIDDEN',
  SLOW: 'COMPONENT_SLOW',
};

/**
 * What a test has to say for a component to be claimed in one state.
 *
 * DEFAULT has no tokens on purpose and is handled before this table: a test
 * that renders the component and asserts anything has exercised its default
 * state, and demanding the word "default" would report every happy-path unit
 * test as covering nothing.
 *
 * The five others are a closed list of English tokens, which is a REAL limit
 * and is disclosed as one: a suite written in another language will read as
 * unclaimed on these cells. That is the conservative direction — the cells stay
 * measured and unclaimed rather than being scored as covered on no evidence —
 * and the caveat says so.
 */
const COMPONENT_STATE_TOKENS: Record<ComponentStateKind, readonly RegExp[]> = {
  DEFAULT: [],
  LOADING: [/\bis_?loading\b/i, /\bloading\b/i, /\bpending\b/i, /\bskeleton\b/i, /\bspinner\b/i],
  EMPTY: [/\bempty\b/i, /\bno[_-]?(?:results|items|data|rows)\b/i, /\bzero[_-]?state\b/i],
  ERROR: [/\berror\b/i, /\bfail(?:ed|ure)\b/i, /\breject(?:ed|s)?\b/i, /\bthrow\b/i],
  FORBIDDEN: [/\bforbidden\b/i, /\b403\b/i, /\bunauthoriz/i, /\bno[_-]?permission\b/i],
  SLOW: [/\bslow\b/i, /\bdelay(?:ed)?\b/i, /\btimeout\b/i, /\babort(?:ed)?\b/i],
};

// ─── Input: tests, observations, waivers ────────────────────────────────────

/**
 * What this module is allowed to know about a test.
 *
 * A flat record of facts and nothing resembling a database row, so the whole
 * matcher runs against a fake. `routes` is ALREADY EXTRACTED by the caller,
 * exactly as `CoverageTestInput.routes` is, because route extraction is
 * coverage.ts's job and a second implementation of it would be a second answer
 * to "does this test visit /checkout".
 */
export interface FieldCoverageTest {
  id: string;
  /**
   * Source. NULL means we hold none, which makes every cell this test might
   * have claimed UNKNOWN to us rather than uncovered — the rule inherited from
   * coverage.ts, and the reason the count of such tests is disclosed.
   */
  code: string | null;
  routes: readonly string[];
  /** Whether the test's quarantine is IN FORCE, as the caller resolved it. */
  quarantined?: boolean;
}

/**
 * A run's observation of one cell, which is the only thing that can carry a
 * cell above DECLARED.
 *
 * Keyed on the cell key this module mints, so a runtime adapter and this
 * module cannot disagree about which cell was reached —
 * `dimensionCellIdentity` is the one format and both sides call it.
 *
 * Nothing in this file produces one of these. They arrive from a run, and when
 * none arrive every cell is capped at DECLARED by the STATIC ceiling. That is
 * the written-is-not-run rule as arithmetic rather than as a convention.
 */
export interface CellObservation {
  cellKey: string;
  testId: string;
  /** A run reached the cell while executing the test. */
  navigationObserved: boolean;
  /** The run made at least one assertion attributable to the cell. */
  assertionObserved: boolean;
  runStatus: TestResultStatus | null;
  retriedAndPassed?: boolean;
  confirmedAtIso: string | null;
  runId: string;
}

/**
 * A cell held out of the denominator by the team.
 *
 * STRICTER THAN `SurfaceWaiver`, which allows a null expiry. A waiver with no
 * expiry is how a denominator quietly shrinks forever, and a waiver with no
 * owner is a silent exclusion, so this module REFUSES both rather than
 * honouring them: the cell stays in the denominator and the rejection is
 * disclosed as a caveat. Refusing to shrink the denominator is the direction
 * that cannot flatter us, which is the only reason it is the default.
 */
export interface FieldCellWaiver {
  reason: string;
  /** A user id or an email. A waiver with no owner is refused. */
  owner: string;
  /** ISO-8601. A waiver with no expiry, or a lapsed one, is refused. */
  expiresAtIso: string;
}

/**
 * Everything the analysis needs, and nothing it does not.
 *
 * `nowIso` is passed rather than read, so freshness and expiry are
 * deterministic and a test can sit on any instant it likes.
 */
export interface FieldCoverageInput {
  forms: readonly FieldCoverageForm[];
  components: readonly ComponentCoverageItem[];
  tests: readonly FieldCoverageTest[];
  /** Absent means static evidence only, which caps every cell at DECLARED. */
  observations?: readonly CellObservation[];
  /** Keyed by cell key. */
  waivers?: Readonly<Record<string, FieldCellWaiver>>;
  /**
   * The dialect the project's tests are written in, as `resolveDialect`
   * answered it. NULL means we could not tell, which makes every claim that
   * depends on finding an assertion UNMEASURED rather than absent.
   */
  dialect: DialectId | null;
  nowIso: string;
  freshnessDays?: number;
  /** Caps the ENUMERATOR hit before this module saw anything. Carried through. */
  caps?: readonly DimensionCapBite[];
}

// ─── Output ─────────────────────────────────────────────────────────────────

/**
 * One cell of the FORM_FIELD or VALIDATION_RULE denominator, shaped to
 * `coverageFormFieldSchema` so that the write path is this module's output and
 * not a translation of it.
 *
 * A translation layer between what the measurement produces and what the API
 * accepts is where a field gets dropped, so there isn't one: the test parses
 * every row this module emits through the real schema, which is the only proof
 * that the read path and the write path describe the same cell.
 */
export interface FormFieldCellRow {
  itemKey: string;
  fieldKey: string;
  kind: CoverageCellKind;
  label: string;
  parentFieldKey: string | null;
  inputType: string | null;
  required: boolean | null;
  semantic: string | null;
  constraint: FormFieldConstraintReading | null;
  constraintsRead: boolean;
  origin: SurfaceSource;
  evidence: string;
  exercise: FieldCellExercise | null;
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
}

/** One cell of the COMPONENT or COMPONENT_STATE denominator, shaped to
 * `coverageItemStateSchema`. Same argument as above. */
export interface ItemStateCellRow {
  itemKey: string;
  stateKey: string;
  kind: CoverageCellKind;
  label: string;
  origin: SurfaceSource;
  evidence: string;
  parentStateKey: string | null;
  observedAtIso: string | null;
  exercise: FieldCellExercise | null;
  tier: CoverageTier | null;
  tierCappedBy: TierCapReason | null;
  lastConfirmedRunId: string | null;
  unmeasuredReason: DimensionUnmeasuredReason | null;
  unmeasuredDetail: string | null;
}

/** The unmeasured count broken out by reason, which is the actionable half. */
export type UnmeasuredBreakdown = Record<DimensionUnmeasuredReason, number>;

export interface FieldCoverageResult {
  /** The FORM_FIELD and VALIDATION_RULE rows. One table, two denominators. */
  formFieldRows: FormFieldCellRow[];
  /** The COMPONENT and COMPONENT_STATE rows. One table, two denominators. */
  itemStateRows: ItemStateCellRow[];
  /**
   * FOUR readings, never one. There is no total on this object and there must
   * never be: see the header.
   */
  measurements: Record<FieldCoverageDimension, DimensionMeasurement>;
  /**
   * Why each axis's unmeasured cells are unmeasured, by reason.
   *
   * On the object because `DimensionMeasurement` carries exactly one reason
   * code and a real reading has several. The measurement's single code is the
   * DOMINANT one and its detail names the rest, but a consumer that wants to
   * group findings needs the counts, and re-deriving them from the rows is how
   * two screens come to disagree.
   */
  unmeasuredByReason: Record<FieldCoverageDimension, UnmeasuredBreakdown>;
  /**
   * Every limit of ours that showed up in this reading, as sentences. Not
   * decoration: a cap that bit, a dialect we cannot read assertions in, a form
   * with no route to scope by and a test whose source we do not hold are all
   * facts that change what the number means.
   */
  caveats: string[];
}

// ─── Caps of our own ────────────────────────────────────────────────────────

/**
 * How many lines of one test this module reads.
 *
 * A cap, therefore disclosed: when it bites, the bite is reported as a count
 * AND a reason through {@link DimensionCapBite}, so the report can say "at
 * least N more lines existed" rather than presenting a partial scan as a
 * complete one. Rule 10 of this codebase, and the reason a number this file
 * produces can be defended at all.
 */
const MAX_SCANNED_LINES = 4_000;

/** The most cells one dimension will produce. Also a cap, also disclosed. */
const MAX_CELLS_PER_DIMENSION = 20_000;

/**
 * The most cap bites one measurement carries.
 *
 * `dimensionMeasurementSchema` accepts twenty, and a measurement the schema
 * refuses is a reading that silently never reaches the database — which is a
 * worse outcome than a truncated disclosure list. So the list is bounded HERE,
 * and the bound itself is disclosed: the last slot is spent on a bite that says
 * how many more caps bit. A cap on the cap list, reported as a count, because
 * the alternative is a cap applied without being disclosed.
 */
const MAX_CAP_BITES = 20;

/**
 * How far from a field's identity an action or an assertion still counts as
 * being about that field.
 *
 * Three lines, because the common shapes are
 * `await page.getByLabel('Email').fill('')` on one line and a locator bound on
 * one line then driven on the next two. Widening it makes a test that touches
 * one field claim its neighbours; narrowing it to one line loses the bound-
 * locator shape, which is the idiom every page object uses.
 */
const CLAIM_WINDOW_LINES = 3;

// ─── Cell keys ──────────────────────────────────────────────────────────────

/**
 * The identity of one field cell.
 *
 * Built through `dimensionCellIdentity`, which is THE cell-key format: it
 * percent-encodes the three characters the format reserves and sorts any
 * role/locale/device coordinates by declaration order, so a field cell and the
 * same field cell under a role are comparable and a label containing `|` cannot
 * forge a coordinate. A second format would make two dimensions silently
 * uncomparable, which is the one thing the keystone exists to prevent.
 *
 * The within-item part goes in the BASE, after a `#`, because a field is a
 * property of one item and not one of the six enumerable `SurfaceDimensionKind`
 * axes — `dimensionCellIdentity` has no coordinate that could express it. `#`
 * is already this codebase's separator for a part within an item: a crawled
 * form's own identity is `<route>#<formId>`.
 */
export function formFieldCellKey(itemKey: string, fieldName: string): string {
  return dimensionCellIdentity(`${itemKey}#${fieldName}`, []);
}

/** The identity of one rule cell, derived from one field. */
export function validationRuleCellKey(
  itemKey: string,
  fieldName: string,
  slug: ValidationRuleSlug,
): string {
  return dimensionCellIdentity(`${itemKey}#${fieldName}#${slug}`, []);
}

/** The identity of the COMPONENT cell for one component. */
export function componentCellKey(itemKey: string): string {
  return dimensionCellIdentity(`${itemKey}#component`, []);
}

/** The identity of one component-state cell. */
export function componentStateCellKey(itemKey: string, state: ComponentStateKind): string {
  return dimensionCellIdentity(`${itemKey}#state=${state}`, []);
}

// ─── Deriving the rules of one field ────────────────────────────────────────

/**
 * Why a derived rule is not a measurable cell.
 *
 * Three outcomes and not two, because "we never looked", "we looked and cannot
 * represent what we saw" and "a test could never assert this" are three
 * different findings with three different remedies, and a single `skipped`
 * boolean would make all three look like the same shrug.
 */
type RuleStatus =
  | { readonly state: 'MEASURABLE' }
  | {
      readonly state: 'UNMEASURED';
      readonly reason: DimensionUnmeasuredReason;
      readonly detail: string;
    }
  | {
      readonly state: 'UNEXERCISABLE';
      readonly reason: UnexercisableReason;
      readonly detail: string;
    };

/** One rule cell, before any test has been looked at. */
interface DerivedRule {
  readonly slug: ValidationRuleSlug;
  readonly kind: CoverageCellKind;
  /** The numeric bound, for the constraint slugs that have one. */
  readonly bound: number | null;
  /** The `pattern` source, verbatim and uncompiled. */
  readonly pattern: string | null;
  readonly status: RuleStatus;
}

/**
 * Every rule cell one field owes, with the reason attached to each one that
 * cannot be measured.
 *
 * Reading order matters and is the register's own: `required` first because it
 * is the boundary case nobody counts, then the six constraint classes, then the
 * semantic rules — which is the other one.
 */
function rulesForField(field: FieldCoverageField): DerivedRule[] {
  const rules: DerivedRule[] = [];
  const unreadable = new Set<ConstraintSlug>(field.unreadableConstraints ?? []);

  // ── required ──────────────────────────────────────────────────────────────
  if (field.required === null) {
    rules.push(
      rule('required', null, null, {
        state: 'UNMEASURED',
        reason: 'EXTRACTOR_RETURNED_UNKNOWN',
        detail:
          'the reader examined this field and could not tell whether it is required, so the ' +
          'rule is counted and not scored — reading that as optional would delete the cell',
      }),
    );
  } else if (field.required) {
    rules.push(rule('required', null, null, { state: 'MEASURABLE' }));
  }
  // `required: false` mints nothing on purpose: a reader looked and there is no
  // rule. An unmeasured cell here would claim a limitation we did not hit.

  // ── the six constraint classes ────────────────────────────────────────────
  for (const slug of CONSTRAINT_SLUGS) {
    const applicable = constraintApplies(slug, field.inputType);

    if (applicable === null) {
      rules.push(
        rule(slug, null, null, {
          state: 'UNMEASURED',
          reason: 'EXTRACTOR_RETURNED_UNKNOWN',
          detail:
            `the reader could not tell this field's input type, so whether the browser honours ` +
            `\`${slug}\` on it is unknown and the cell is not scored either way`,
        }),
      );
      continue;
    }

    if (!field.constraintsRead) {
      // The register's own arithmetic: ten of twenty boundary classes are
      // unreachable on the source path. Only the classes that COULD apply to
      // this input type are counted, so the unmeasured number is a floor built
      // out of the HTML specification rather than a guess.
      if (!applicable) continue;
      rules.push(
        rule(slug, null, null, {
          state: 'UNMEASURED',
          reason: 'NOT_ENUMERATED',
          detail:
            `nothing read this field's \`${slug}\`: \`detectForms\` in ` +
            'packages/shared/src/codebase.ts reads no constraint attributes on the source path, ' +
            'so this boundary class was never looked at — it is not a field with nothing to test',
        }),
      );
      continue;
    }

    if (unreadable.has(slug)) {
      rules.push(
        rule(slug, null, null, {
          state: 'UNMEASURED',
          reason: 'EXTRACTOR_RETURNED_UNKNOWN',
          detail:
            `the page declares \`${slug}\` on this field in a form the numeric constraint ` +
            'column cannot hold (a date or a time bound), so the rule exists and is not scored',
        }),
      );
      continue;
    }

    const declared = declaredConstraint(slug, field.constraint);
    if (declared === null) continue; // Looked, and the page declares nothing.

    if (!applicable) {
      rules.push(
        rule(slug, declared.bound, declared.pattern, {
          state: 'UNEXERCISABLE',
          reason: 'CAPABILITY_UNAVAILABLE',
          detail:
            `the page declares \`${slug}\` on an \`${field.inputType}\` input, which the ` +
            'browser ignores — there is no outcome a test could assert, so the cell leaves the ' +
            'denominator rather than becoming a gap nobody can ever close',
        }),
      );
      continue;
    }

    if (slug === 'pattern' && declared.pattern !== null && compilePattern(declared.pattern) === null) {
      rules.push(
        rule(slug, null, declared.pattern, {
          state: 'UNEXERCISABLE',
          reason: 'CAPABILITY_UNAVAILABLE',
          detail:
            'the declared pattern is not a regular expression this runtime can compile, so no ' +
            'value can be shown to violate it and the cell cannot be driven here',
        }),
      );
      continue;
    }

    rules.push(rule(slug, declared.bound, declared.pattern, { state: 'MEASURABLE' }));
  }

  // ── the semantic rules ────────────────────────────────────────────────────
  const semanticSlugs = semanticRuleSlugs(field.semantic);
  if (semanticSlugs === null) {
    rules.push(
      rule('semantic-unclassified', null, null, {
        state: 'UNMEASURED',
        reason: 'EXTRACTOR_RETURNED_UNKNOWN',
        detail:
          field.semantic === null
            ? 'nothing classified what this field means, so the rules its meaning implies are ' +
              'counted and not scored — an unclassified field is not a field with no rules'
            : `the classifier returned \`${field.semantic}\`, which this build has no rule table ` +
              'for, so the rules this field implies are counted and not scored',
      }),
    );
  } else {
    for (const slug of semanticSlugs) {
      if (RULE_VIOLATION_CHECKS[slug] === null) {
        rules.push(
          rule(slug, null, null, {
            state: 'UNMEASURED',
            reason: 'NO_EXTRACTOR',
            detail:
              `QAAI has no deterministic check for \`${slug}\` in this build, so a test that ` +
              'asserts it cannot be recognised — the rule is real, the measurement is ours to build',
          }),
        );
        continue;
      }
      rules.push(rule(slug, null, null, { state: 'MEASURABLE' }));
    }
  }

  return rules;
}

function rule(
  slug: ValidationRuleSlug,
  bound: number | null,
  pattern: string | null,
  status: RuleStatus,
): DerivedRule {
  return { slug, kind: VALIDATION_RULE_CELL_KIND[slug], bound, pattern, status };
}

/**
 * Whether the browser honours this constraint on this input type.
 *
 * NULL — not false — when the input type is unknown, because "the browser
 * ignores it here" and "we do not know what kind of input this is" are
 * different claims and the second one must not read as the first. A missing
 * input type defaults to nothing.
 */
function constraintApplies(slug: ConstraintSlug, inputType: string | null): boolean | null {
  if (inputType === null) return null;
  return CONSTRAINT_APPLIES_TO[slug].includes(inputType.toLowerCase());
}

/** The value the page declared for one constraint slug, or null for none. */
function declaredConstraint(
  slug: ConstraintSlug,
  constraint: FormFieldConstraintReading | null,
): { bound: number | null; pattern: string | null } | null {
  if (constraint === null) return null;
  switch (slug) {
    case 'maxlength':
      return constraint.maxLength === null ? null : { bound: constraint.maxLength, pattern: null };
    case 'minlength':
      return constraint.minLength === null ? null : { bound: constraint.minLength, pattern: null };
    case 'min':
      return constraint.min === null ? null : { bound: constraint.min, pattern: null };
    case 'max':
      return constraint.max === null ? null : { bound: constraint.max, pattern: null };
    case 'step':
      return constraint.step === null ? null : { bound: constraint.step, pattern: null };
    case 'pattern':
      return constraint.pattern === null ? null : { bound: null, pattern: constraint.pattern };
  }
}

// ─── Reading tests ──────────────────────────────────────────────────────────

/** Every action a test can take ON an input, across the dialects we read. */
const FIELD_ACTION =
  /\.\s*(?:fill|type|set_?[Vv]alue|select_?[Oo]ption|set_?[Ii]nput_?[Ff]iles|check|uncheck|press|send_?[Kk]eys|clear|append)\s*\(/;

/** A test's source, pre-chewed once instead of per cell. */
interface ScannedTest {
  readonly test: FieldCoverageTest;
  readonly lines: readonly string[];
  /** Line numbers (0-based) the dialect called assertions. */
  readonly assertionLines: ReadonlySet<number>;
  /** Quoted string literals per line, in source order. */
  readonly literals: ReadonlyArray<readonly string[]>;
  /** True when MAX_SCANNED_LINES bit on this test. */
  readonly truncated: boolean;
  /** Lines beyond the cap. The floor behind "at least N more existed". */
  readonly linesDropped: number;
}

function scanTest(test: FieldCoverageTest, dialectId: DialectId | null): ScannedTest | null {
  if (test.code === null) return null;
  const all = test.code.split('\n');
  const truncated = all.length > MAX_SCANNED_LINES;
  const lines = truncated ? all.slice(0, MAX_SCANNED_LINES) : all;
  const code = truncated ? lines.join('\n') : test.code;

  const assertionLines = new Set<number>();
  if (dialectId !== null) {
    for (const hit of findAssertions(code, dialectId)) assertionLines.add(hit.line - 1);
  }

  const quotes = dialectId === null ? ['"', "'", '`'] : dialectRecord(dialectId).quotes;
  return {
    test,
    lines,
    assertionLines,
    literals: lines.map((line) => quotedLiterals(line, quotes)),
    truncated,
    linesDropped: truncated ? all.length - lines.length : 0,
  };
}

/**
 * The quoted string literals on one line.
 *
 * Written by hand rather than by regex because the interesting literal is the
 * EMPTY one: `fill('')` is the only static evidence a test asserts the
 * `required` rule, and every "non-greedy anything" pattern either drops it or
 * swallows the line. Escapes are honoured so that `'it\'s'` does not look like
 * two literals, and an unterminated quote ends at the end of the line rather
 * than eating the file.
 */
function quotedLiterals(line: string, quotes: readonly string[]): string[] {
  const openers = new Set(quotes);
  const found: string[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? '';
    if (!openers.has(char)) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let value = '';
    let closed = false;
    while (cursor < line.length) {
      const inner = line[cursor] ?? '';
      if (inner === '\\') {
        value += line[cursor + 1] ?? '';
        cursor += 2;
        continue;
      }
      if (inner === char) {
        closed = true;
        break;
      }
      value += inner;
      cursor += 1;
    }
    if (closed) found.push(value);
    index = cursor + 1;
  }
  return found;
}

/**
 * Whether the test is scoped to the form's route.
 *
 * A test that mentions the word "email" somewhere in the suite is how every
 * form in a product ends up reported as exercised, so a claim needs the test to
 * declare the route the form is on. A form with NO route cannot be scoped —
 * source-read forms have a file, not a URL — and for those the scope check
 * passes and the widening is disclosed in the caveats.
 */
function inScope(scanned: ScannedTest, form: FieldCoverageForm): boolean {
  if (form.route === null) return true;
  return scanned.test.routes.includes(form.route);
}

/** The identities a line may mention to be about this field. */
function fieldIdentities(field: FieldCoverageField): string[] {
  const identities = [field.name];
  if (field.label !== null && field.label.trim().length > 0) identities.push(field.label);
  return identities;
}

/** True when any literal on this line is, or contains, one of the identities. */
function lineNamesField(literals: readonly string[], identities: readonly string[]): boolean {
  for (const literal of literals) {
    const haystack = literal.toLowerCase();
    for (const identity of identities) {
      const needle = identity.toLowerCase();
      if (needle.length > 0 && haystack.includes(needle)) return true;
    }
  }
  return false;
}

/** The lines within the claim window of a line that names the field. */
function windowAround(scanned: ScannedTest, identities: readonly string[]): number[] {
  const anchors: number[] = [];
  for (let index = 0; index < scanned.lines.length; index += 1) {
    if (lineNamesField(scanned.literals[index] ?? [], identities)) anchors.push(index);
  }
  return anchors;
}

/**
 * Does this test DRIVE this field?
 *
 * An input action within the window of a line that names the field. This is the
 * FIELD cell's whole claim, and it is deliberately the generous half of the
 * measurement: a test that types into the box has exercised the box, and a
 * false "nobody touches your email field" is the claim that makes a team close
 * the tab. What it does NOT do is claim any rule — see {@link assertsRule}.
 */
function drivesField(scanned: ScannedTest, field: FieldCoverageField): boolean {
  const identities = fieldIdentities(field);
  for (const anchor of windowAround(scanned, identities)) {
    for (let line = anchor - CLAIM_WINDOW_LINES; line <= anchor + CLAIM_WINDOW_LINES; line += 1) {
      const text = scanned.lines[line];
      if (text !== undefined && FIELD_ACTION.test(text)) return true;
    }
  }
  return false;
}

/** The two readings of a rule claim, told apart rather than merged. */
interface RuleClaim {
  /** A violating value AND an assertion in the window. The numerator's input. */
  readonly strict: boolean;
  /** An assertion in the window with no value that violates the rule. */
  readonly nearby: boolean;
}

/**
 * Does this test ASSERT THE OUTCOME of this rule?
 *
 * ── The strict reading, and why it is the one that counts ───────────────────
 *
 * A test claims a rule when it drives the field with a literal that VIOLATES
 * the rule and asserts within the window. Both halves are load-bearing: the
 * violating value is what makes the test about the RULE rather than about the
 * field, and the assertion is what makes it a test rather than a visit. A
 * `maxlength` of 60 and a 61-character string in the same breath is not a
 * heuristic — it is the boundary, written down.
 *
 * ── The nearby reading, and why it is disclosed instead of counted ──────────
 *
 * A test may assert a rule's outcome without a literal we can measure: the
 * value may be built at run time, or the assertion may be on the browser's own
 * validity state. Those cells get `nearby: true`, stay UNCLAIMED in the
 * ladder, and are reported as a count. Counting them would be coverage
 * attributed to a test that may assert something else entirely, which is the
 * flattering direction; omitting them entirely would hide the fact that we can
 * see something there. So they are named.
 */
function assertsRule(
  scanned: ScannedTest,
  field: FieldCoverageField,
  derived: DerivedRule,
  nowIso: string,
): RuleClaim {
  const check = RULE_VIOLATION_CHECKS[derived.slug];
  const identities = fieldIdentities(field);
  let nearby = false;

  for (const anchor of windowAround(scanned, identities)) {
    let assertedInWindow = false;
    const violating: string[] = [];
    for (let line = anchor - CLAIM_WINDOW_LINES; line <= anchor + CLAIM_WINDOW_LINES; line += 1) {
      if (line < 0 || line >= scanned.lines.length) continue;
      if (scanned.assertionLines.has(line)) assertedInWindow = true;
      if (check === null) continue;
      for (const literal of drivenValues(scanned, line, identities)) {
        if (check(literal, derived, nowIso)) violating.push(literal);
      }
    }
    if (!assertedInWindow) continue;
    if (violating.length > 0) return { strict: true, nearby: true };
    nearby = true;
  }
  return { strict: false, nearby };
}

/**
 * The literals on one line that could be a value DRIVEN INTO the field.
 *
 * ── THE DEFECT THIS FUNCTION EXISTS TO PREVENT, WHICH IT ALREADY CAUSED ─────
 *
 * Reading every literal in the window made `expect(page.getByText('nope'))`
 * supply the violating value. `'nope'` does not match `[A-Z]{3}`, is not a
 * number and has no `@` in it, so a test that typed a PERFECTLY VALID value and
 * asserted the success message claimed the pattern rule, the numeric rule and
 * the email rule at once. Three rule cells covered by a happy-path test, which
 * is the vendor-flattering lie in its purest form — and it was caught by three
 * named tests rather than by review.
 *
 * Two filters, and both are load-bearing:
 *
 *   1. THE LINE MUST CONTAIN AN INPUT ACTION. An assertion's message is not
 *      something the test put in the box.
 *   2. A LITERAL THAT NAMES THE FIELD IS THE LOCATOR, NOT THE VALUE.
 *      `getByLabel('Email').fill('')` carries both on one line, and `'Email'`
 *      is the selector. Excluded by containment rather than by equality, so
 *      `getByLabel('Email address')` and `'[name="email"]'` are excluded too.
 *      The cost is a value that happens to quote its own label, which is the
 *      conservative direction: it does not claim.
 */
function drivenValues(
  scanned: ScannedTest,
  line: number,
  identities: readonly string[],
): string[] {
  const text = scanned.lines[line];
  if (text === undefined || !FIELD_ACTION.test(text)) return [];
  return (scanned.literals[line] ?? []).filter((literal) => !lineNamesField([literal], identities));
}

/** Does this test render and assert on this component at all? */
function claimsComponent(scanned: ScannedTest, component: ComponentCoverageItem): boolean {
  if (scanned.assertionLines.size === 0) return false;
  return mentionsIdentifier(scanned, component.exportName);
}

/**
 * Does this test claim this component in this state?
 *
 * DEFAULT needs no token: a test that renders the component and asserts has
 * exercised its default state. The other five need a token from
 * {@link COMPONENT_STATE_TOKENS} within the window of an assertion, which is
 * what separates "this component has a test" from "this component's error
 * state has a test" — and the second sentence is the one UNIT_GEN was built to
 * make and has never been able to.
 */
function claimsComponentState(
  scanned: ScannedTest,
  component: ComponentCoverageItem,
  state: ComponentStateKind,
): boolean {
  if (!claimsComponent(scanned, component)) return false;
  if (state === 'DEFAULT') return true;
  const tokens = COMPONENT_STATE_TOKENS[state];
  for (const assertionLine of scanned.assertionLines) {
    for (
      let line = assertionLine - CLAIM_WINDOW_LINES;
      line <= assertionLine + CLAIM_WINDOW_LINES;
      line += 1
    ) {
      const text = scanned.lines[line];
      if (text === undefined) continue;
      if (tokens.some((token) => token.test(text))) return true;
    }
  }
  return false;
}

/**
 * Whether the export name appears as an identifier.
 *
 * On the RAW line and not inside a literal, because a unit test reaches a
 * component by importing and rendering it — `render(<Button />)` — rather than
 * by quoting its name. Bounded on both sides so `Button` does not match
 * `ButtonGroup`, which would attribute a wrapper's tests to the thing it wraps.
 */
function mentionsIdentifier(scanned: ScannedTest, name: string): boolean {
  if (name.length === 0) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
  return scanned.lines.some((line) => pattern.test(line));
}

// ─── Tiering one cell ───────────────────────────────────────────────────────

/** The verdict for one cell, plus the run that earned it. */
interface CellVerdict {
  readonly tier: CoverageTier | null;
  readonly cappedBy: TierCapReason | null;
  readonly lastConfirmedRunId: string | null;
}

const NO_CLAIM: CellVerdict = { tier: null, cappedBy: null, lastConfirmedRunId: null };

/**
 * The rung one cell earns, through the one promotion rule.
 *
 * This function picks the evidence and `promoteCoverageTier` decides the rung.
 * That split is the point: there is no second ladder in this file and no place
 * a tier is assigned directly, so a STATIC claim cannot be promoted past
 * DECLARED however it is phrased, and a RUNTIME observation walks the whole
 * ladder including the freshness window. The strongest claim wins, compared on
 * the ladder's own rank rather than on the order the tests arrived in.
 */
function tierForCell(
  cellKey: string,
  claimants: readonly ScannedTest[],
  observations: ReadonlyMap<string, CellObservation[]>,
  nowIso: string,
  freshnessDays: number,
): CellVerdict {
  let best: CellVerdict = NO_CLAIM;
  // Ranked by the ladder's OWN table rather than by a list this file keeps. A
  // second ordering of the five rungs is a second ladder, and two ladders is
  // how one screen comes to disagree with another about the same cell.
  const rank = (tier: CoverageTier | null): number =>
    tier === null ? -1 : COVERAGE_TIER_RANK[tier];

  const consider = (verdict: CellVerdict): void => {
    if (rank(verdict.tier) > rank(best.tier)) best = verdict;
  };

  for (const claimant of claimants) {
    const verdict = promoteCoverageTier(
      {
        source: 'STATIC',
        // Only a RUNTIME source can honestly set these, and the ceiling table
        // caps a mistaken writer anyway. Stated as false rather than omitted so
        // nobody reads a default as an observation.
        navigationObserved: false,
        assertionObserved: false,
        runStatus: null,
        retriedAndPassed: false,
        quarantined: claimant.test.quarantined === true,
        confirmedAtIso: null,
      },
      nowIso,
      freshnessDays,
    );
    consider({ tier: verdict.tier, cappedBy: verdict.cappedBy, lastConfirmedRunId: null });
  }

  for (const observation of observations.get(cellKey) ?? []) {
    const verdict = promoteCoverageTier(
      {
        source: 'RUNTIME',
        navigationObserved: observation.navigationObserved,
        assertionObserved: observation.assertionObserved,
        runStatus: observation.runStatus,
        retriedAndPassed: observation.retriedAndPassed === true,
        quarantined: false,
        confirmedAtIso: observation.confirmedAtIso,
      },
      nowIso,
      freshnessDays,
    );
    consider({
      tier: verdict.tier,
      cappedBy: verdict.cappedBy,
      // Named only when the rung actually rests on the run. A run id beside a
      // DECLARED cell would claim a confirmation that did not happen, and
      // `coverageFormFieldSchema` refuses the inverse for the same reason.
      lastConfirmedRunId: verdict.tier !== null && verdict.tier !== 'DECLARED' ? observation.runId : null,
    });
  }

  return best;
}

// ─── Accumulating one dimension ─────────────────────────────────────────────

function emptyBreakdown(): UnmeasuredBreakdown {
  return {
    NO_EXTRACTOR: 0,
    NOT_ENUMERATED: 0,
    EXTRACTOR_RETURNED_UNKNOWN: 0,
    HELD_OUT: 0,
    CAP_BIT: 0,
  };
}

/**
 * The reasons in declaration order, which is how a tie is broken.
 *
 * Taken from the keystone's own array rather than re-spelled here. A sixth
 * reason there then appears in every breakdown below automatically, where a
 * local copy would silently count it as zero — and a reason that always reads
 * zero is a disclosure nobody ever sees.
 */
const UNMEASURED_REASON_ORDER: readonly DimensionUnmeasuredReason[] = DIMENSION_UNMEASURED_REASONS;

/** One dimension's cells as they accumulate. */
class DimensionAccumulator {
  /** One entry per MEASURED cell: its rung, or null for measured-and-unclaimed. */
  readonly measured: Array<CoverageTier | null> = [];
  readonly unmeasured: UnmeasuredBreakdown = emptyBreakdown();
  readonly details: string[] = [];
  readonly caps: DimensionCapBite[] = [];
  /** Cells refused past MAX_CELLS_PER_DIMENSION. A floor, disclosed. */
  droppedByCap = 0;

  get cells(): number {
    return this.measured.length + this.unmeasuredTotal;
  }

  get unmeasuredTotal(): number {
    return UNMEASURED_REASON_ORDER.reduce((total, reason) => total + this.unmeasured[reason], 0);
  }

  /** True when the cap bit and the caller must stop minting. */
  atCap(): boolean {
    return this.cells >= MAX_CELLS_PER_DIMENSION;
  }

  addMeasured(tier: CoverageTier | null): void {
    if (this.atCap()) {
      this.droppedByCap += 1;
      return;
    }
    this.measured.push(tier);
  }

  addUnmeasured(reason: DimensionUnmeasuredReason, detail: string): void {
    if (this.atCap()) {
      this.droppedByCap += 1;
      return;
    }
    this.unmeasured[reason] += 1;
    if (this.details.length < 4 && !this.details.includes(detail)) this.details.push(detail);
  }

  /**
   * The reading, built through `measuredDimension` so the invariants are
   * enforced by the keystone and not re-stated here.
   *
   * The ladder divides by what was MEASURED and the unmeasured cells sit beside
   * it with their reason. Dividing by `cells` would report every cell nobody
   * looked at as uncovered; dividing by `measured` and printing nothing else
   * would make the figure rise every time our extractor got worse. Both numbers
   * travel, neither is folded.
   */
  finish(dimension: FieldCoverageDimension, carriedCaps: readonly DimensionCapBite[]): DimensionMeasurement {
    const caps = [...carriedCaps, ...this.caps];
    const dropped = this.droppedByCap;
    if (dropped > 0) {
      caps.push({
        cap: 'MAX_CELLS_PER_DIMENSION',
        limit: MAX_CELLS_PER_DIMENSION,
        atLeastMore: dropped,
        detail:
          `${dropped} more ${dimension} cell(s) existed and were not measured: this module stops ` +
          'minting cells at the limit, so the denominator below is a floor',
      });
      /*
       * THE DROPPED CELLS ARE UNMEASURED CELLS, and counting them here is not
       * bookkeeping. This block used to sit AFTER an early return taken when
       * nothing else was unmeasured, so a reading whose only shortfall was the
       * cap came out with `unmeasuredReason: null` — a cap applied without being
       * disclosed, which is rule 10 verbatim. Folding them into the count keeps
       * `cells = measured + unmeasured` true of a truncated reading and forces
       * the reason onto the row.
       */
      this.unmeasured.CAP_BIT += dropped;
      this.droppedByCap = 0;
    }

    const bounded = boundCaps(caps);

    if (this.unmeasuredTotal === 0) {
      return measuredDimension({ dimension, measuredCells: this.measured, caps: bounded });
    }

    // The dimension carries ONE reason code and a real reading has several, so
    // the dominant one is the code and the detail names the rest. Ties break by
    // declaration order, which is fixed in the keystone — breaking them by
    // whichever cell happened to arrive first would make the same inputs
    // produce two different reason codes across runs.
    let dominant: DimensionUnmeasuredReason = 'NO_EXTRACTOR';
    for (const reason of UNMEASURED_REASON_ORDER) {
      if (this.unmeasured[reason] > this.unmeasured[dominant]) dominant = reason;
    }
    // A cap that bit outranks every other reason for the dimension-level code,
    // however few cells it took, because it is the one that says the
    // DENOMINATOR ITSELF is incomplete rather than that some cells inside it
    // are unread. The others are findings about a known set of cells.
    if (this.unmeasured.CAP_BIT > 0) dominant = 'CAP_BIT';

    const breakdown = UNMEASURED_REASON_ORDER.filter((reason) => this.unmeasured[reason] > 0)
      .map((reason) => `${reason} ${this.unmeasured[reason]}`)
      .join(', ');
    const detail = clip(
      `${this.unmeasuredTotal} cell(s) unmeasured (${breakdown}). ${this.details.join(' · ')}`,
    );

    return measuredDimension({
      dimension,
      measuredCells: this.measured,
      unmeasured: this.unmeasuredTotal,
      unmeasuredReason: dominant,
      unmeasuredDetail: detail,
      caps: bounded,
    });
  }
}

/**
 * The cap list, bounded to what the measurement schema will accept.
 *
 * When more than {@link MAX_CAP_BITES} bit, the last slot carries the COUNT of
 * the ones that were dropped rather than a nineteenth detail. A reader can then
 * see "and 6 more caps bit" instead of a list that silently ended, which is the
 * same contract every other cap in this file keeps.
 */
function boundCaps(caps: readonly DimensionCapBite[]): DimensionCapBite[] {
  if (caps.length <= MAX_CAP_BITES) return [...caps];
  const kept = caps.slice(0, MAX_CAP_BITES - 1);
  const dropped = caps.length - kept.length;
  kept.push({
    cap: 'MAX_CAP_BITES',
    limit: MAX_CAP_BITES,
    atLeastMore: dropped,
    detail:
      `${dropped} more cap(s) bit this reading and are not listed here: the measurement schema ` +
      'accepts twenty disclosures and a reading it refuses would never reach the database',
  });
  return kept;
}

/** Trimmed to the 500 characters `dimensionMeasurementSchema` accepts. */
function clip(text: string): string {
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

// ─── The analysis ───────────────────────────────────────────────────────────

/**
 * Turn forms, components and tests into FOUR readings and the rows behind them.
 *
 * Deterministic, model-free and clock-free. Every number it produces can be
 * recomputed from the same inputs, which is the only property that lets a
 * customer argue with it.
 */
export function analyseFieldCoverage(input: FieldCoverageInput): FieldCoverageResult {
  const nowIso = input.nowIso;
  const freshnessDays = input.freshnessDays ?? DEFAULT_COVERAGE_FRESHNESS_DAYS;
  const waivers = input.waivers ?? {};
  const caveats: string[] = [];

  const observations = new Map<string, CellObservation[]>();
  for (const observation of input.observations ?? []) {
    const bucket = observations.get(observation.cellKey);
    if (bucket) bucket.push(observation);
    else observations.set(observation.cellKey, [observation]);
  }

  const scanned: ScannedTest[] = [];
  let withoutSource = 0;
  let linesDropped = 0;
  let truncatedTests = 0;
  for (const test of input.tests) {
    const result = scanTest(test, input.dialect);
    if (result === null) {
      withoutSource += 1;
      continue;
    }
    if (result.truncated) {
      truncatedTests += 1;
      linesDropped += result.linesDropped;
    }
    scanned.push(result);
  }

  const carriedCaps: DimensionCapBite[] = [...(input.caps ?? [])];
  if (truncatedTests > 0) {
    carriedCaps.push({
      cap: 'MAX_SCANNED_LINES',
      limit: MAX_SCANNED_LINES,
      atLeastMore: linesDropped,
      detail:
        `${truncatedTests} test(s) are longer than ${MAX_SCANNED_LINES} lines; ${linesDropped} ` +
        'line(s) were not read, so a claim written past the cap is not in this reading',
    });
  }
  if (withoutSource > 0) {
    caveats.push(
      `${withoutSource} test(s) have no source here, so any cell they claim is unknown to us ` +
        'rather than uncovered — the same rule coverage.ts applies to a runtime URL.',
    );
  }
  if (input.dialect === null) {
    caveats.push(
      'No test dialect was resolved for this project, so no assertion could be located: every ' +
        'validation-rule cell is reported unmeasured rather than uncovered, and no component ' +
        'cell is claimed.',
    );
  }

  const accumulators: Record<FieldCoverageDimension, DimensionAccumulator> = {
    FORM_FIELD: new DimensionAccumulator(),
    VALIDATION_RULE: new DimensionAccumulator(),
    COMPONENT: new DimensionAccumulator(),
    COMPONENT_STATE: new DimensionAccumulator(),
  };

  const formFieldRows: FormFieldCellRow[] = [];
  const itemStateRows: ItemStateCellRow[] = [];

  let waiversRefused = 0;
  const waiverFor = (cellKey: string): FieldCellWaiver | null => {
    const waiver = waivers[cellKey];
    if (waiver === undefined) return null;
    if (waiver.owner.trim().length === 0) {
      waiversRefused += 1;
      return null;
    }
    const expiry = Date.parse(waiver.expiresAtIso);
    const now = Date.parse(nowIso);
    if (Number.isNaN(expiry) || (!Number.isNaN(now) && expiry < now)) {
      waiversRefused += 1;
      return null;
    }
    return waiver;
  };

  // ── Forms: one cell per field, one cell per rule ──────────────────────────
  let routelessForms = 0;
  let fieldsWithUnreadConstraints = 0;
  let nearbyRuleClaims = 0;

  for (const form of input.forms) {
    if (form.route === null) routelessForms += 1;
    const scopedTests = scanned.filter((test) => inScope(test, form));

    for (const field of form.fields) {
      if (field.name.trim().length === 0) {
        // Identity, not cosmetics: a field with no name cannot be keyed, so it
        // cannot be a cell. Refused loudly rather than silently skipped —
        // silently skipped is a denominator that shrank for a reader bug.
        throw new Error(
          `${form.itemKey}: a form field with no name cannot be a cell — it has no identity to ` +
            'key on, and dropping it would shrink the denominator for a reader bug',
        );
      }
      if (field.constraintsRead === false && field.constraint !== null) {
        throw new Error(
          `${form.itemKey}#${field.name}: constraints that were never read cannot also have ` +
            'been found — `constraintsRead` is false with a constraint object present',
        );
      }
      if (!field.constraintsRead) fieldsWithUnreadConstraints += 1;

      const fieldKey = formFieldCellKey(form.itemKey, field.name);
      // The row schemas refuse an empty label, and a whitespace-only label is
      // the same case: a reader that found no words found no label. Falling
      // back to the `name` attribute keeps the cell nameable by a human.
      const label = textOrNull(field.label) ?? field.name;
      const waiver = waiverFor(fieldKey);

      // ── the FIELD cell ──────────────────────────────────────────────────
      if (waiver !== null) {
        accumulators.FORM_FIELD.addUnmeasured(
          'HELD_OUT',
          `waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`,
        );
        formFieldRows.push(
          fieldRow(form, field, fieldKey, label, NO_CLAIM, {
            reason: 'HELD_OUT',
            detail: clip(`waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`),
          }),
        );
      } else if (field.exercise && field.exercise.state !== 'EXERCISABLE') {
        accumulators.FORM_FIELD.addUnmeasured('HELD_OUT', field.exercise.detail);
        formFieldRows.push(
          fieldRow(form, field, fieldKey, label, NO_CLAIM, {
            reason: 'HELD_OUT',
            detail: clip(field.exercise.detail),
          }),
        );
      } else {
        const claimants = scopedTests.filter((test) => drivesField(test, field));
        const verdict = tierForCell(fieldKey, claimants, observations, nowIso, freshnessDays);
        accumulators.FORM_FIELD.addMeasured(verdict.tier);
        formFieldRows.push(fieldRow(form, field, fieldKey, label, verdict, null));
      }

      // ── one cell per RULE ───────────────────────────────────────────────
      for (const derived of rulesForField(field)) {
        const ruleKey = validationRuleCellKey(form.itemKey, field.name, derived.slug);
        const ruleLabel = `${label}: ${VALIDATION_RULE_LABELS[derived.slug]}`;
        const ruleWaiver = waiverFor(ruleKey);

        if (ruleWaiver !== null) {
          accumulators.VALIDATION_RULE.addUnmeasured(
            'HELD_OUT',
            `waived by ${ruleWaiver.owner} until ${ruleWaiver.expiresAtIso}: ${ruleWaiver.reason}`,
          );
          formFieldRows.push(
            ruleRow(form, field, derived, ruleKey, fieldKey, ruleLabel, NO_CLAIM, null, {
              reason: 'HELD_OUT',
              detail: clip(
                `waived by ${ruleWaiver.owner} until ${ruleWaiver.expiresAtIso}: ${ruleWaiver.reason}`,
              ),
            }),
          );
          continue;
        }

        if (derived.status.state === 'UNMEASURED') {
          accumulators.VALIDATION_RULE.addUnmeasured(
            derived.status.reason,
            derived.status.detail,
          );
          formFieldRows.push(
            ruleRow(form, field, derived, ruleKey, fieldKey, ruleLabel, NO_CLAIM, null, {
              reason: derived.status.reason,
              detail: clip(derived.status.detail),
            }),
          );
          continue;
        }

        if (derived.status.state === 'UNEXERCISABLE') {
          accumulators.VALIDATION_RULE.addUnmeasured('HELD_OUT', derived.status.detail);
          formFieldRows.push(
            ruleRow(
              form,
              field,
              derived,
              ruleKey,
              fieldKey,
              ruleLabel,
              NO_CLAIM,
              {
                state: 'UNEXERCISABLE',
                reason: derived.status.reason,
                detail: derived.status.detail,
              },
              {
                reason: 'HELD_OUT',
                detail: clip(derived.status.detail),
              },
            ),
          );
          continue;
        }

        if (input.dialect === null) {
          // No dialect means no assertion can be located, so the rule's outcome
          // cannot be seen. A hole in OUR knowledge, and it must not read as a
          // gap in theirs.
          accumulators.VALIDATION_RULE.addUnmeasured(
            'EXTRACTOR_RETURNED_UNKNOWN',
            'no test dialect was resolved, so no assertion on this rule could be located',
          );
          formFieldRows.push(
            ruleRow(form, field, derived, ruleKey, fieldKey, ruleLabel, NO_CLAIM, null, {
              reason: 'EXTRACTOR_RETURNED_UNKNOWN',
              detail:
                'no test dialect was resolved for this project, so an assertion on this rule ' +
                'cannot be located — the cell is counted and not scored',
            }),
          );
          continue;
        }

        const claimants: ScannedTest[] = [];
        for (const test of scopedTests) {
          const claim = assertsRule(test, field, derived, nowIso);
          if (claim.strict) claimants.push(test);
          else if (claim.nearby) nearbyRuleClaims += 1;
        }
        const verdict = tierForCell(ruleKey, claimants, observations, nowIso, freshnessDays);
        accumulators.VALIDATION_RULE.addMeasured(verdict.tier);
        formFieldRows.push(
          ruleRow(form, field, derived, ruleKey, fieldKey, ruleLabel, verdict, null, null),
        );
      }
    }
  }

  if (routelessForms > 0) {
    caveats.push(
      `${routelessForms} form(s) carry no route, so a test could not be scoped to the page they ` +
        'are on: their field claims are the generous reading and may belong to a form of the ' +
        'same shape elsewhere.',
    );
  }
  if (fieldsWithUnreadConstraints > 0) {
    caveats.push(
      `${fieldsWithUnreadConstraints} field(s) had their constraints NEVER READ — \`detectForms\` ` +
        'in packages/shared/src/codebase.ts reads no maxlength, minlength, min, max, step or ' +
        'pattern on the source path. Those boundary classes are reported unmeasured, not absent.',
    );
  }
  if (nearbyRuleClaims > 0) {
    caveats.push(
      `${nearbyRuleClaims} rule cell(s) have an assertion beside the field but no value we could ` +
        'show violates the rule, so they are counted as unclaimed: a test that fills an input ' +
        'has not asserted what happens when the rule is broken.',
    );
  }
  if (input.dialect !== null) {
    caveats.push(
      'Component-state tokens are matched in English only, so a suite written in another ' +
        'language reads as unclaimed on those cells rather than as covered.',
    );
  }

  // ── Components: one cell per component, one per declared state ────────────
  let onOtherAxis = 0;
  let statesNeverEnumerated = 0;
  let danglingComponents = 0;
  let noCatalogueRead = 0;

  for (const component of input.components) {
    const otherAxis = componentHasOwnAxis(component.kind);
    if (component.hasCatalogueEntry === null) noCatalogueRead += 1;

    if (component.itemKey === null) {
      // No registry row, so no cell can be written against an item. Counted as
      // unmeasured on BOTH axes and named: a key with no row is a dangling
      // reference, which is a fact about our own extractor.
      danglingComponents += 1;
      const detail =
        `${component.modulePath}#${component.exportName} has no \`CoverageItem\` row, so its ` +
        'cells cannot be keyed to the inventory — a dangling reference in our own extractor';
      if (otherAxis === null) accumulators.COMPONENT.addUnmeasured('NOT_ENUMERATED', detail);
      accumulators.COMPONENT_STATE.addUnmeasured('NOT_ENUMERATED', detail);
      continue;
    }

    const itemKey = component.itemKey;
    const label = `${component.exportName} (${component.modulePath})`;

    // ── the COMPONENT cell ─────────────────────────────────────────────────
    if (otherAxis !== null) {
      /*
       * A `page.tsx` is both an exported component and a ROUTE. Adding it to the
       * COMPONENT denominator would not be a bigger measurement of the
       * application — it would be the same application divided by a larger
       * number, which is exactly the double count `componentHasOwnAxis` exists
       * to prevent. It is not unmeasured either: it IS measured, on the ROUTE
       * axis. So it mints no COMPONENT cell and the count is disclosed.
       *
       * Its STATES still count below, because the ROUTE axis has no notion of a
       * loading state and dropping them would lose real surface.
       */
      onOtherAxis += 1;
    } else {
      const cellKey = componentCellKey(itemKey);
      const waiver = waiverFor(cellKey);
      if (waiver !== null) {
        accumulators.COMPONENT.addUnmeasured(
          'HELD_OUT',
          `waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`,
        );
        itemStateRows.push(
          componentRow(component, itemKey, cellKey, label, NO_CLAIM, null, {
            reason: 'HELD_OUT',
            detail: clip(`waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`),
          }),
        );
      } else if (component.exercise && component.exercise.state !== 'EXERCISABLE') {
        accumulators.COMPONENT.addUnmeasured('HELD_OUT', component.exercise.detail);
        itemStateRows.push(
          componentRow(component, itemKey, cellKey, label, NO_CLAIM, component.exercise, {
            reason: 'HELD_OUT',
            detail: clip(component.exercise.detail),
          }),
        );
      } else {
        const claimants = scanned.filter((test) => claimsComponent(test, component));
        const verdict = tierForCell(cellKey, claimants, observations, nowIso, freshnessDays);
        accumulators.COMPONENT.addMeasured(verdict.tier);
        itemStateRows.push(componentRow(component, itemKey, cellKey, label, verdict, null, null));
      }
    }

    // ── the COMPONENT_STATE cells ──────────────────────────────────────────
    if (component.states === null) {
      /*
       * Nobody enumerated this component's states. ONE unmeasured cell, and
       * that is a FLOOR rather than a count: every rendered component has at
       * least a default state, and we do not know how many more. A floor in the
       * unmeasured column cannot flatter the number — it moves nothing into the
       * numerator — and zero cells here would let an unenumerated component
       * read as an axis with nothing left to test.
       */
      statesNeverEnumerated += 1;
      accumulators.COMPONENT_STATE.addUnmeasured(
        'NOT_ENUMERATED',
        `${component.modulePath}#${component.exportName}: nothing enumerated this component's ` +
          'states, so the count below is a floor of one and not a measurement',
      );
      continue;
    }

    for (const state of component.states) {
      const cellKey = componentStateCellKey(itemKey, state.kind);
      const stateLabel = `${component.exportName} — ${state.kind.toLowerCase()}`;
      const waiver = waiverFor(cellKey);
      if (waiver !== null) {
        accumulators.COMPONENT_STATE.addUnmeasured(
          'HELD_OUT',
          `waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`,
        );
        itemStateRows.push(
          stateRow(component, state, itemKey, cellKey, stateLabel, NO_CLAIM, null, {
            reason: 'HELD_OUT',
            detail: clip(`waived by ${waiver.owner} until ${waiver.expiresAtIso}: ${waiver.reason}`),
          }),
        );
        continue;
      }
      if (input.dialect === null) {
        accumulators.COMPONENT_STATE.addUnmeasured(
          'EXTRACTOR_RETURNED_UNKNOWN',
          'no test dialect was resolved, so no assertion on this component state could be located',
        );
        itemStateRows.push(
          stateRow(component, state, itemKey, cellKey, stateLabel, NO_CLAIM, null, {
            reason: 'EXTRACTOR_RETURNED_UNKNOWN',
            detail:
              'no test dialect was resolved for this project, so an assertion on this component ' +
              'state cannot be located — the cell is counted and not scored',
          }),
        );
        continue;
      }
      const claimants = scanned.filter((test) => claimsComponentState(test, component, state.kind));
      const verdict = tierForCell(cellKey, claimants, observations, nowIso, freshnessDays);
      accumulators.COMPONENT_STATE.addMeasured(verdict.tier);
      itemStateRows.push(
        stateRow(component, state, itemKey, cellKey, stateLabel, verdict, null, null),
      );
    }
  }

  if (onOtherAxis > 0) {
    caveats.push(
      `${onOtherAxis} component(s) are page or layout entry points and are already counted on ` +
        'the ROUTE axis, so they mint no COMPONENT cell — adding them would divide the same ' +
        'application by a larger number. Their states are still counted.',
    );
  }
  if (statesNeverEnumerated > 0) {
    caveats.push(
      `${statesNeverEnumerated} component(s) have no enumerated states: each contributes one ` +
        'unmeasured cell as a FLOOR, because the real count is unknown and reporting zero would ' +
        'make an unread component look like one with nothing left to test.',
    );
  }
  if (danglingComponents > 0) {
    caveats.push(
      `${danglingComponents} component(s) have no registry row to key a cell against, so their ` +
        'cells could not be written — a dangling reference in our own extractor, not a gap in ' +
        'their tests.',
    );
  }
  if (noCatalogueRead > 0) {
    caveats.push(
      `${noCatalogueRead} component(s) had no catalogue read, so whether they have a story is ` +
        'unknown; it does not change the denominator, which counts components either way.',
    );
  }
  if (waiversRefused > 0) {
    caveats.push(
      `${waiversRefused} waiver(s) were REFUSED and their cells stay in the denominator: a ` +
        'waiver needs an owner and an unexpired expiry, and one without either is a silent ' +
        'exclusion that shrinks the denominator forever.',
    );
  }

  const measurements: Record<FieldCoverageDimension, DimensionMeasurement> = {
    FORM_FIELD: accumulators.FORM_FIELD.finish('FORM_FIELD', carriedCaps),
    VALIDATION_RULE: accumulators.VALIDATION_RULE.finish('VALIDATION_RULE', carriedCaps),
    COMPONENT: accumulators.COMPONENT.finish('COMPONENT', carriedCaps),
    COMPONENT_STATE: accumulators.COMPONENT_STATE.finish('COMPONENT_STATE', carriedCaps),
  };

  for (const dimension of FIELD_COVERAGE_DIMENSIONS) {
    if (measurements[dimension].cells === 0) {
      caveats.push(
        `${dimension} has no cells for this subject, so its percentage is NULL rather than 0 or ` +
          '100 — nothing was found to divide by, which is not the same as nothing being covered.',
      );
    }
  }

  return {
    formFieldRows,
    itemStateRows,
    measurements,
    unmeasuredByReason: {
      FORM_FIELD: accumulators.FORM_FIELD.unmeasured,
      VALIDATION_RULE: accumulators.VALIDATION_RULE.unmeasured,
      COMPONENT: accumulators.COMPONENT.unmeasured,
      COMPONENT_STATE: accumulators.COMPONENT_STATE.unmeasured,
    },
    caveats,
  };
}

/**
 * ONE dimension's figure at ONE rung, or NULL.
 *
 * A thin pass-through to `dimensionPercentAt`, and it exists so that this
 * module has no other way to produce a percentage. It takes one dimension name
 * and one measurement, which makes adding two denominators together
 * unavailable rather than merely discouraged — the same argument the keystone
 * makes for leaving `percent` off `DimensionMeasurement` entirely.
 */
export function fieldCoveragePercentAt(
  result: FieldCoverageResult,
  dimension: FieldCoverageDimension,
  tier: CoverageTier,
): number | null {
  return dimensionPercentAt(result.measurements[dimension], tier);
}

// ─── Row builders ───────────────────────────────────────────────────────────

interface RowUnmeasured {
  reason: DimensionUnmeasuredReason;
  detail: string;
}

function fieldRow(
  form: FieldCoverageForm,
  field: FieldCoverageField,
  fieldKey: string,
  label: string,
  verdict: CellVerdict,
  unmeasured: RowUnmeasured | null,
): FormFieldCellRow {
  return {
    itemKey: form.itemKey,
    fieldKey,
    kind: 'FORM_FIELD',
    label,
    parentFieldKey: null,
    inputType: textOrNull(field.inputType),
    required: field.required,
    semantic: textOrNull(field.semantic),
    constraint: field.constraint,
    constraintsRead: field.constraintsRead,
    origin: form.source,
    evidence: clipEvidence(
      `${form.name}: the \`${field.name}\` input` +
        (field.inputType === null ? ' (input type unread)' : ` of type \`${field.inputType}\``) +
        (field.required === null
          ? ', required unread'
          : field.required
            ? ', required'
            : ', optional') +
        (field.constraintsRead ? '' : ', constraints never read'),
    ),
    exercise: clipExercise(field.exercise ?? null),
    tier: verdict.tier,
    tierCappedBy: verdict.cappedBy,
    lastConfirmedRunId: verdict.lastConfirmedRunId,
    unmeasuredReason: unmeasured?.reason ?? null,
    unmeasuredDetail: unmeasured?.detail ?? null,
  };
}

function ruleRow(
  form: FieldCoverageForm,
  field: FieldCoverageField,
  derived: DerivedRule,
  ruleKey: string,
  parentFieldKey: string,
  label: string,
  verdict: CellVerdict,
  exercise: FieldCellExercise | null,
  unmeasured: RowUnmeasured | null,
): FormFieldCellRow {
  return {
    itemKey: form.itemKey,
    fieldKey: ruleKey,
    kind: derived.kind,
    label: label.length > 300 ? `${label.slice(0, 297)}...` : label,
    // Required for a rule by `coverageFormFieldSchema`: a rule with no field is
    // a cell nothing can ever assert against.
    parentFieldKey,
    inputType: textOrNull(field.inputType),
    required: field.required,
    semantic: textOrNull(field.semantic),
    constraint: field.constraint,
    constraintsRead: field.constraintsRead,
    origin: form.source,
    evidence: clipEvidence(
      `${form.name}: \`${derived.slug}\` on the \`${field.name}\` input` +
        (derived.bound === null ? '' : ` (bound ${derived.bound})`) +
        (derived.pattern === null ? '' : ` (pattern ${derived.pattern})`),
    ),
    exercise: clipExercise(exercise),
    tier: verdict.tier,
    tierCappedBy: verdict.cappedBy,
    lastConfirmedRunId: verdict.lastConfirmedRunId,
    unmeasuredReason: unmeasured?.reason ?? null,
    unmeasuredDetail: unmeasured?.detail ?? null,
  };
}

function componentRow(
  component: ComponentCoverageItem,
  itemKey: string,
  cellKey: string,
  label: string,
  verdict: CellVerdict,
  exercise: FieldCellExercise | null,
  unmeasured: RowUnmeasured | null,
): ItemStateCellRow {
  return {
    itemKey,
    stateKey: cellKey,
    kind: 'COMPONENT',
    label: label.length > 300 ? `${label.slice(0, 297)}...` : label,
    origin: component.source,
    evidence: clipEvidence(
      `${component.modulePath} exports \`${component.exportName}\` as a ${component.kind}` +
        (component.hasCatalogueEntry === null
          ? '; no catalogue was read'
          : component.hasCatalogueEntry
            ? '; it has a catalogue entry'
            : '; it is not in the catalogue that was read'),
    ),
    parentStateKey: null,
    // NULL MEANS DECLARED AND NEVER OBSERVED. Static analysis observes nothing,
    // so this module never writes an instant here; a runtime adapter does.
    observedAtIso: null,
    exercise: clipExercise(exercise),
    tier: verdict.tier,
    tierCappedBy: verdict.cappedBy,
    lastConfirmedRunId: verdict.lastConfirmedRunId,
    unmeasuredReason: unmeasured?.reason ?? null,
    unmeasuredDetail: unmeasured?.detail ?? null,
  };
}

function stateRow(
  component: ComponentCoverageItem,
  state: ComponentCoverageState,
  itemKey: string,
  cellKey: string,
  label: string,
  verdict: CellVerdict,
  exercise: FieldCellExercise | null,
  unmeasured: RowUnmeasured | null,
): ItemStateCellRow {
  return {
    itemKey,
    stateKey: cellKey,
    kind: COMPONENT_STATE_CELL_KIND[state.kind],
    label: label.length > 300 ? `${label.slice(0, 297)}...` : label,
    origin: state.source,
    evidence: clipEvidence(state.evidence),
    /*
     * The COMPONENT cell of the same component, so a reader can see that a
     * state is only reachable THROUGH the component. Not a foreign key and not
     * resolved here: the parent may be enumerated by a different pass, and a
     * self-referential link would make the write order load-bearing.
     */
    parentStateKey: componentCellKey(itemKey),
    observedAtIso: null,
    exercise: clipExercise(exercise),
    tier: verdict.tier,
    tierCappedBy: verdict.cappedBy,
    lastConfirmedRunId: verdict.lastConfirmedRunId,
    unmeasuredReason: unmeasured?.reason ?? null,
    unmeasuredDetail: unmeasured?.detail ?? null,
  };
}

/** Trimmed to the 1000 characters the row schemas accept, never to empty. */
function clipEvidence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'no evidence sentence was supplied by the enumerator';
  return trimmed.length <= 1_000 ? trimmed : `${trimmed.slice(0, 997)}...`;
}

/**
 * An exercisability the row schemas will accept.
 *
 * `surfaceExerciseSchema` caps `detail` at 500 and refuses an empty one, and an
 * enumerator's sentence is not ours to trust for length. Clipped rather than
 * rejected: losing the tail of a disclosure is better than losing the
 * disclosure, and a row the writer refuses is a cell that silently never
 * reaches the database.
 */
function clipExercise(exercise: FieldCellExercise | null): FieldCellExercise | null {
  if (exercise === null) return null;
  const detail = exercise.detail.trim();
  return {
    ...exercise,
    detail: detail.length === 0 ? 'no reason sentence was supplied by the enumerator' : clip(detail),
  };
}

/**
 * A free-text column the row schemas accept, or null.
 *
 * `semantic` and `inputType` are both `.min(1).nullable()` there, so a reader
 * that produced an empty string meant "no classification" and saying so is the
 * only reading that survives validation. Whitespace is the same case.
 */
function textOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Every component state kind, re-exported so a caller can iterate the axis. */
export const COMPONENT_STATE_CELL_KINDS: readonly CoverageCellKind[] = COMPONENT_STATE_KINDS.map(
  (kind) => COMPONENT_STATE_CELL_KIND[kind],
);

/** The cell kinds this module mints, for the parity test and for a reader. */
export function fieldCoverageCellKinds(): readonly CoverageCellKind[] {
  return FIELD_COVERAGE_DIMENSIONS.flatMap((dimension) => cellKindsFor(dimension));
}
