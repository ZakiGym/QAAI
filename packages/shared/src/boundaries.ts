/**
 * BOUNDARIES — the equivalence classes a field can be attacked at, and the
 * rule that stops us attacking one we never measured.
 *
 * ── The defect this replaces ────────────────────────────────────────────────
 *
 * One whole feature becomes ONE negative test, derived from the FIRST required
 * field: submit it blank, expect an error. Nothing enumerates empty against the
 * other eleven fields, nothing tries one character over the limit, nothing
 * sends a Luhn-invalid card, a leap day, an astral emoji, a negative zero or a
 * duplicate email. The negative half of testing does not exist, and the
 * positive half is the half that finds no bugs.
 *
 * ── The rule that matters, and why it is structural ────────────────────────
 *
 * A class is APPLICABLE ONLY WHEN THE CONSTRAINT THAT DEFINES IT WAS ACTUALLY
 * READ.
 *
 * "Type 300 characters and expect an error" against a field whose `maxlength`
 * nobody ever looked at produces a FAILING TEST THAT IS QAAI'S FAULT. The
 * customer sees red, investigates, finds their field has no limit and never
 * claimed one, and stops trusting the suite — which costs more than the bug the
 * test might have found.
 *
 * `FormField` already draws the distinction this needs, in three states, and
 * says why: absent means the crawl predates constraint capture, null means the
 * crawl looked and the page declares nothing, a value means the page declares
 * it. {@link ConstraintReading} is that distinction given a name, and
 * {@link boundaryApplicability} is what makes it impossible to ignore — it
 * cannot return an assertable expectation for a constraint it did not read,
 * because the arm that carries one is only constructed on the READ path.
 *
 * ── Why four states and not three ──────────────────────────────────────────
 *
 * The obvious model is applicable / inapplicable / unknown. It is wrong, and
 * the fourth state is the interesting one. A field that DECLARES NO MAXLENGTH
 * is a better place to send ten thousand characters than a field that declares
 * one — that is where the unbounded-input bugs are. But the expected outcome is
 * still UNKNOWN: an application may accept it, may truncate it, may reject it,
 * and all three can be correct. So {@link UNBOUNDED} is a probe worth running
 * whose result may not be asserted as a rejection, which is a different thing
 * from {@link CONSTRAINT_UNREAD}, where the honest answer is "re-crawl" and
 * generating anything at all is our mistake.
 *
 * Collapsing those two loses a real test on one side and invents a false
 * failure on the other.
 */

import type { FormFieldSemantic } from './flow-map';

// ─── Reading a constraint ────────────────────────────────────────────────────

/**
 * What we know about one constraint on one field.
 *
 * Maps exactly onto `FormField`'s documented three states, which is why
 * {@link readConstraint} takes `T | null | undefined` and not an option type:
 * the crawl already encodes the distinction in the shape of the JSON, and
 * re-encoding it would be a second source of truth about the same fact.
 */
export type ConstraintReading<T> =
  /** The page declares it, and this is the value. */
  | { readonly state: 'READ'; readonly value: T }
  /** The crawl looked, and the page declares nothing. An interesting absence. */
  | { readonly state: 'DECLARED_ABSENT' }
  /** Nobody looked. This crawl predates constraint capture. Not an absence — an ignorance. */
  | { readonly state: 'NOT_CAPTURED' };

/**
 * Classify a raw `FormField` constraint value.
 *
 * `undefined` is NOT_CAPTURED and `null` is DECLARED_ABSENT, in that order and
 * never conflated — the whole file turns on the difference. An empty string is
 * treated as DECLARED_ABSENT: `pattern=""` constrains nothing, and reading it
 * as a declared pattern would generate a PATTERN_VIOLATION case against a
 * pattern every string satisfies.
 */
export function readConstraint<T>(raw: T | null | undefined): ConstraintReading<T> {
  if (raw === undefined) return { state: 'NOT_CAPTURED' };
  if (raw === null) return { state: 'DECLARED_ABSENT' };
  if (typeof raw === 'string' && raw.trim() === '') return { state: 'DECLARED_ABSENT' };
  return { state: 'READ', value: raw };
}

// ─── The classes ─────────────────────────────────────────────────────────────

/**
 * Every equivalence class a field can be attacked at. Closed, and ordered by
 * family rather than alphabetically so a reader can see the shape of the list:
 * presence, length, numeric bound, format, temporal, text robustness, numeric
 * notation, uniqueness.
 *
 * The names travel in stored plan items and in generated test names, so a
 * spelling here is a wire format. Renaming one orphans every row that used it.
 */
export const BOUNDARY_CLASSES = [
  // Presence
  'EMPTY',
  'WHITESPACE_ONLY',
  // Length
  'TOO_SHORT',
  'TOO_LONG',
  // Numeric / temporal bound
  'AT_MIN',
  'BELOW_MIN',
  'AT_MAX',
  'ABOVE_MAX',
  'OFF_BY_ONE',
  'STEP_MISALIGNED',
  // Format
  'WRONG_TYPE',
  'PATTERN_VIOLATION',
  'CHECKSUM_INVALID',
  // Temporal
  'FUTURE_DATE',
  'PAST_DATE',
  'LEAP_DAY',
  'DST_BOUNDARY',
  // Text robustness
  'UNICODE_COMBINING',
  'RTL_MARK',
  'EMOJI_ASTRAL',
  'SQL_META',
  'HTML_META',
  'NULL_BYTE',
  // Numeric notation
  'LEADING_ZERO',
  'NEGATIVE_ZERO',
  'SCIENTIFIC_NOTATION',
  // Uniqueness
  'DUPLICATE_OF_EXISTING',
] as const;
export type BoundaryClass = (typeof BOUNDARY_CLASSES)[number];

/**
 * The compile-time half of the parity guard.
 *
 * A `Record` keyed on the union cannot be written without naming every member,
 * and naming one that does not exist is an excess property. The run-time half
 * is in `boundaries.test.ts`, comparing `boundaryClassSchema.options` against
 * this list — zod's options exist only at run time, and a hand-written list
 * would drift from the union. Eight `GateRule` kinds shipped unsaveable for two
 * slices because only one of the two mechanisms existed.
 */
const BOUNDARY_CLASS_PRESENT: Record<BoundaryClass, true> = {
  EMPTY: true,
  WHITESPACE_ONLY: true,
  TOO_SHORT: true,
  TOO_LONG: true,
  AT_MIN: true,
  BELOW_MIN: true,
  AT_MAX: true,
  ABOVE_MAX: true,
  OFF_BY_ONE: true,
  STEP_MISALIGNED: true,
  WRONG_TYPE: true,
  PATTERN_VIOLATION: true,
  CHECKSUM_INVALID: true,
  FUTURE_DATE: true,
  PAST_DATE: true,
  LEAP_DAY: true,
  DST_BOUNDARY: true,
  UNICODE_COMBINING: true,
  RTL_MARK: true,
  EMOJI_ASTRAL: true,
  SQL_META: true,
  HTML_META: true,
  NULL_BYTE: true,
  LEADING_ZERO: true,
  NEGATIVE_ZERO: true,
  SCIENTIFIC_NOTATION: true,
  DUPLICATE_OF_EXISTING: true,
};

/** Derived, never hand-listed. See the note on the record above. */
export const BOUNDARY_CLASS_LIST = Object.keys(BOUNDARY_CLASS_PRESENT) as ReadonlyArray<BoundaryClass>;

// ─── What a class expects to happen ──────────────────────────────────────────

/**
 * The shape of the outcome a class expects. THREE members, and the third is the
 * reason this type exists.
 *
 * UNKNOWN IS A REAL ANSWER AND MUST NOT BE ASSERTED AS A REJECTION. It is the
 * honest expectation for most of the text-robustness classes: an application
 * that strips a right-to-left mark, one that stores it verbatim, and one that
 * rejects it are all defensible, and a suite that demands one of the three
 * reports two correct applications as broken. What UNKNOWN licenses is a
 * SMOKE assertion — it did not 500, it did not silently discard the whole
 * value, the page still works — and nothing stronger.
 *
 * ACCEPTED_NORMALISED is the expectation that catches the most embarrassing
 * bugs. `SQL_META` is the example: O'Brien must be able to sign up. An
 * application that rejects an apostrophe in a surname has confused escaping
 * with validation, and the test that finds it asserts ACCEPTANCE.
 */
export const BOUNDARY_EXPECTATIONS = ['REJECTED', 'ACCEPTED_NORMALISED', 'UNKNOWN'] as const;
export type BoundaryExpectation = (typeof BOUNDARY_EXPECTATIONS)[number];

/** Compile-time half of the parity guard. */
const BOUNDARY_EXPECTATION_PRESENT: Record<BoundaryExpectation, true> = {
  REJECTED: true,
  ACCEPTED_NORMALISED: true,
  UNKNOWN: true,
};

/** Derived, never hand-listed. */
export const BOUNDARY_EXPECTATION_LIST = Object.keys(
  BOUNDARY_EXPECTATION_PRESENT,
) as ReadonlyArray<BoundaryExpectation>;

/**
 * Risk weight, as a closed vocabulary rather than a float.
 *
 * Ordinal and not numeric because the only operation anyone performs on it is
 * "do the high ones first under a budget", and a float invites an argument
 * about whether SQL_META is 0.7 or 0.75 that nobody can settle. The numeric
 * rank below exists for sorting, which is the one place a number is needed.
 */
export const BOUNDARY_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type BoundaryRisk = (typeof BOUNDARY_RISKS)[number];

/**
 * Sort weight. A `Record` keyed on the union, so a fifth risk has no rank until
 * someone gives it one — rather than comparing `undefined` and silently sorting
 * every item at that level to the bottom.
 */
export const BOUNDARY_RISK_RANK: Record<BoundaryRisk, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

// ─── Which constraint defines each class ─────────────────────────────────────

/**
 * The fact a class needs read before it can be generated.
 *
 * `FIELD_FAMILY` is the member that is not an HTML attribute: it means the
 * class is defined by what KIND of field this is (its `inputType` and
 * `semantic`), both of which are always captured, so the family is never
 * unread. `REQUIRED` is separate from the rest because `required` is a boolean
 * the crawl always captures too, and the three-state reading does not apply to
 * it — a field is required or it is not.
 *
 * `EXISTING_VALUE` is the one constraint that is not on the page at all: it is
 * a precondition the SCENARIO has to establish. DUPLICATE_OF_EXISTING needs a
 * value already in the system, and a suite that generates "sign up with an
 * email that already exists" without first creating that email is testing
 * nothing. See {@link BoundaryPrecondition}.
 */
export const BOUNDARY_CONSTRAINTS = [
  'maxLength',
  'minLength',
  'min',
  'max',
  'step',
  'pattern',
  'REQUIRED',
  'FIELD_FAMILY',
  'EXISTING_VALUE',
] as const;
export type BoundaryConstraint = (typeof BOUNDARY_CONSTRAINTS)[number];

/** Compile-time half of the parity guard. */
const BOUNDARY_CONSTRAINT_PRESENT: Record<BoundaryConstraint, true> = {
  maxLength: true,
  minLength: true,
  min: true,
  max: true,
  step: true,
  pattern: true,
  REQUIRED: true,
  FIELD_FAMILY: true,
  EXISTING_VALUE: true,
};

/** Derived, never hand-listed. */
export const BOUNDARY_CONSTRAINT_LIST = Object.keys(
  BOUNDARY_CONSTRAINT_PRESENT,
) as ReadonlyArray<BoundaryConstraint>;

// ─── Field families ──────────────────────────────────────────────────────────

/**
 * Input types that hold free text, so the text-robustness classes apply.
 *
 * `search` is in and `password` is deliberately in too: a password field that
 * cannot hold an astral emoji is a real and common defect, and one that
 * silently truncates at a byte boundary locks the user out of the account they
 * just created — which is the worst bug in this entire list, because the user
 * cannot even report it.
 */
const TEXTUAL_INPUT_TYPES: ReadonlyArray<string> = [
  'text',
  'textarea',
  'search',
  'email',
  'url',
  'tel',
  'password',
];

/** Input types whose value is a number, so the notation classes apply. */
const NUMERIC_INPUT_TYPES: ReadonlyArray<string> = ['number', 'range'];

/** Input types whose value is a point in time. */
const TEMPORAL_INPUT_TYPES: ReadonlyArray<string> = [
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
];

/** Input types that carry a calendar DATE, so a leap day is expressible. */
const DATED_INPUT_TYPES: ReadonlyArray<string> = ['date', 'datetime-local'];

/** Input types that carry a WALL CLOCK, so a DST discontinuity is expressible. */
const CLOCKED_INPUT_TYPES: ReadonlyArray<string> = ['datetime-local', 'time'];

/** Semantics whose value is validated by an arithmetic checksum. */
const CHECKSUMMED_SEMANTICS: ReadonlyArray<FormFieldSemantic> = ['credit_card'];

/**
 * Semantics the application is overwhelmingly likely to hold a uniqueness
 * constraint on, so DUPLICATE_OF_EXISTING is worth proposing.
 *
 * "Overwhelmingly likely" and not "certainly": nothing on the page declares a
 * database unique index. That is exactly why the expectation for this class is
 * UNKNOWN rather than REJECTED — see {@link BOUNDARY_DESCRIPTORS}.
 */
const UNIQUE_SEMANTICS: ReadonlyArray<FormFieldSemantic> = ['email', 'username'];

/** Semantics whose value is a quantity, so the numeric notation classes apply. */
const NUMERIC_SEMANTICS: ReadonlyArray<FormFieldSemantic> = ['number', 'currency'];

/**
 * A field, as this module needs to see it.
 *
 * Structurally a subset of `FormField`, so a crawled field passes straight in,
 * and every constraint is OPTIONAL so an old FlowMap that predates constraint
 * capture still works — and lands in NOT_CAPTURED, which is the correct answer
 * for it. Same arrangement as `SyntheticField` in synthetic.ts, for the same
 * reason.
 *
 * `required` is a plain boolean with a default of false rather than a
 * three-state reading. That is a judgement and it is worth stating: every crawl
 * that has ever run captured `required`, so there is no legacy state to
 * distinguish, and inventing one would mean every field in every old FlowMap
 * reported EMPTY as unassertable.
 */
export interface BoundaryField {
  readonly name: string;
  readonly semantic: FormFieldSemantic;
  /** HTML input type, or 'select' / 'textarea'. */
  readonly inputType?: string;
  readonly required?: boolean;
  readonly options?: readonly string[];
  readonly maxLength?: number | null;
  readonly minLength?: number | null;
  readonly min?: string | null;
  readonly max?: string | null;
  readonly step?: string | null;
  readonly pattern?: string | null;
}

function inputTypeOf(field: BoundaryField): string {
  return (field.inputType ?? 'text').toLowerCase();
}

function isTextual(field: BoundaryField): boolean {
  const t = inputTypeOf(field);
  if (TEXTUAL_INPUT_TYPES.includes(t)) return true;
  // A `select` offers a closed option list; typing an emoji into it is not a
  // thing a user can do, so the text classes do not apply however free-form the
  // semantic looks.
  return false;
}

function isNumeric(field: BoundaryField): boolean {
  return NUMERIC_INPUT_TYPES.includes(inputTypeOf(field)) || NUMERIC_SEMANTICS.includes(field.semantic);
}

function isTemporal(field: BoundaryField): boolean {
  return TEMPORAL_INPUT_TYPES.includes(inputTypeOf(field)) || field.semantic === 'date';
}

// ─── The descriptor table ────────────────────────────────────────────────────

export interface BoundaryDescriptor {
  /** The fact that must have been read before this class may be generated. */
  readonly constraint: BoundaryConstraint;
  /**
   * What the application is expected to do, WHEN the defining constraint was
   * read. An unread constraint always yields UNKNOWN regardless of this field —
   * see {@link boundaryApplicability}.
   */
  readonly expected: BoundaryExpectation;
  readonly risk: BoundaryRisk;
  /** Why this class is worth a test. One sentence, printed in the plan item's rationale. */
  readonly why: string;
}

/**
 * Every class, with the constraint that defines it and what it expects.
 *
 * A `Record` keyed on {@link BoundaryClass}, so a twenty-eighth class cannot be
 * added to the union without deciding these four things about it. That is the
 * point: the failure mode this table prevents is a class that exists in the
 * vocabulary, gets generated, and has no expectation — which produces a test
 * that asserts whatever the author of the generator felt like that afternoon.
 */
export const BOUNDARY_DESCRIPTORS: Record<BoundaryClass, BoundaryDescriptor> = {
  EMPTY: {
    constraint: 'REQUIRED',
    expected: 'REJECTED',
    risk: 'HIGH',
    why: 'a required field submitted empty must say so, and must say which field',
  },
  WHITESPACE_ONLY: {
    constraint: 'REQUIRED',
    expected: 'REJECTED',
    risk: 'HIGH',
    why:
      'a single space passes a naive `!value` check, so this is the required-field test that ' +
      'actually fails — and it leaves a user named " " in the database when it does',
  },
  TOO_SHORT: {
    constraint: 'minLength',
    expected: 'REJECTED',
    risk: 'MEDIUM',
    why: 'one character under a declared minimum must be refused, not silently padded',
  },
  TOO_LONG: {
    constraint: 'maxLength',
    expected: 'REJECTED',
    risk: 'HIGH',
    why:
      'one character over a declared maximum must be refused by the SERVER and not only by the ' +
      'attribute, which a client can remove',
  },
  AT_MIN: {
    constraint: 'min',
    expected: 'ACCEPTED_NORMALISED',
    risk: 'HIGH',
    why:
      'the minimum itself must be ACCEPTED — an exclusive comparison where the spec said ' +
      'inclusive is the commonest off-by-one in any form',
  },
  BELOW_MIN: {
    constraint: 'min',
    expected: 'REJECTED',
    risk: 'HIGH',
    why: 'one below the declared minimum must be refused',
  },
  AT_MAX: {
    constraint: 'max',
    expected: 'ACCEPTED_NORMALISED',
    risk: 'HIGH',
    why: 'the maximum itself must be accepted, for the same reason as AT_MIN',
  },
  ABOVE_MAX: {
    constraint: 'max',
    expected: 'REJECTED',
    risk: 'HIGH',
    why: 'one above the declared maximum must be refused',
  },
  OFF_BY_ONE: {
    constraint: 'max',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      'the pair either side of a bound, submitted together, so the report can say WHICH side the ' +
      'comparison is wrong on rather than that something is wrong',
  },
  STEP_MISALIGNED: {
    constraint: 'step',
    expected: 'REJECTED',
    risk: 'LOW',
    why:
      'a value between two legal steps — the class that finds a price field accepting 10.005 and ' +
      'rounding it into a half-cent discrepancy',
  },
  WRONG_TYPE: {
    constraint: 'FIELD_FAMILY',
    expected: 'REJECTED',
    risk: 'HIGH',
    why:
      'letters into a number field, prose into a date field: the server must refuse what the ' +
      'input type would have prevented, because an API client never saw the input type',
  },
  PATTERN_VIOLATION: {
    constraint: 'pattern',
    expected: 'REJECTED',
    risk: 'MEDIUM',
    why: 'a string the declared pattern does not match must be refused',
  },
  CHECKSUM_INVALID: {
    constraint: 'FIELD_FAMILY',
    expected: 'REJECTED',
    risk: 'CRITICAL',
    why:
      'a card number that fails Luhn must be caught BEFORE the payment provider is called — ' +
      'otherwise every typo becomes a billable declined-charge and a support ticket',
  },
  FUTURE_DATE: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      'a date after today, which some fields must refuse (date of birth) and others must accept ' +
      '(an appointment) — so the expectation comes from the semantic, never from the class',
  },
  PAST_DATE: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why: 'the mirror of FUTURE_DATE, and unassertable for the same reason',
  },
  LEAP_DAY: {
    constraint: 'FIELD_FAMILY',
    expected: 'ACCEPTED_NORMALISED',
    risk: 'MEDIUM',
    why:
      '29 February is a real date and must be accepted — hand-rolled date arithmetic that adds a ' +
      'year to it produces 1 March or throws, and both are wrong',
  },
  DST_BOUNDARY: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      'a wall-clock time that either does not exist or happens twice — the class that finds a ' +
      'booking system double-selling an hour, and whose correct behaviour is genuinely ambiguous',
  },
  UNICODE_COMBINING: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      'a name in NFD, where the accent is its own codepoint: accepting it, normalising it to NFC ' +
      'and refusing it are all defensible, but silently storing it and then failing to find it ' +
      'again is not',
  },
  RTL_MARK: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'LOW',
    why:
      'a bidirectional override, which must not be able to reorder text elsewhere on the page — ' +
      'stripping it and storing it are both acceptable, leaking it into a shared heading is not',
  },
  EMOJI_ASTRAL: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'HIGH',
    why:
      'a codepoint above the BMP, which is two UTF-16 units and four UTF-8 bytes: the class that ' +
      'finds a length check counting units, a column counting bytes, and a value truncated into ' +
      'an invalid surrogate pair',
  },
  SQL_META: {
    constraint: 'FIELD_FAMILY',
    expected: 'ACCEPTED_NORMALISED',
    risk: 'CRITICAL',
    why:
      "O'Brien must be able to sign up. This class asserts ACCEPTANCE and then asserts the value " +
      'came back intact — an application that refuses an apostrophe has confused escaping with ' +
      'validation, and one that executes it has a far worse problem',
  },
  HTML_META: {
    constraint: 'FIELD_FAMILY',
    expected: 'ACCEPTED_NORMALISED',
    risk: 'CRITICAL',
    why:
      'angle brackets must survive a round trip as TEXT and never as markup — the assertion is ' +
      'that the value is rendered escaped, which is a stronger and more useful claim than that ' +
      'the input was refused',
  },
  NULL_BYTE: {
    constraint: 'FIELD_FAMILY',
    expected: 'REJECTED',
    risk: 'HIGH',
    why:
      'a NUL truncates a C string, so a value containing one may be two different values to two ' +
      'layers of the stack — this is the one text class where rejection is the right answer',
  },
  LEADING_ZERO: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      'a postal code or account number whose leading zero must survive — the class that finds a ' +
      'value parsed as a number, or as octal, and stored one digit shorter',
  },
  NEGATIVE_ZERO: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'LOW',
    why:
      '-0 compares equal to 0 and formats as "-0", so a refund of -0 can print as a negative ' +
      'amount on an invoice while every guard that checks for negatives passes',
  },
  SCIENTIFIC_NOTATION: {
    constraint: 'FIELD_FAMILY',
    expected: 'UNKNOWN',
    risk: 'MEDIUM',
    why:
      '1e9 in a quantity field: accepted by a numeric parser, refused by a digit pattern, and a ' +
      'billion-unit order if nothing catches it',
  },
  DUPLICATE_OF_EXISTING: {
    constraint: 'EXISTING_VALUE',
    expected: 'UNKNOWN',
    risk: 'HIGH',
    why:
      'the second signup with the same email must fail cleanly rather than with a database ' +
      'constraint error — UNKNOWN because nothing on the page declares a unique index, so the ' +
      'test asserts a handled outcome rather than a particular one',
  },
};

// ─── Applicability ───────────────────────────────────────────────────────────

/**
 * Whether a class may be generated against a field, and on what terms.
 *
 * The four arms are the whole contract of this module, and only ONE of them
 * carries an assertable expectation:
 *
 *   · APPLICABLE       — the constraint was read. `expected` is meaningful.
 *   · UNBOUNDED        — the page declares no such constraint. The probe is
 *                        worth running (this is where unbounded-input bugs
 *                        live) and the outcome may NOT be asserted as a
 *                        rejection.
 *   · CONSTRAINT_UNREAD— nobody looked. Generate NOTHING; the remedy is a
 *                        re-crawl, and it is named.
 *   · INAPPLICABLE     — the class cannot apply to this kind of field at all.
 *
 * `expected` is present on the first two arms only, and is hard-wired to
 * UNKNOWN on UNBOUNDED. That is the structural half of the rule in this file's
 * header: there is no code path that returns an assertable REJECTED for a
 * constraint that was not read, because the arm that could is not constructed
 * there.
 */
export type BoundaryApplicability =
  | {
      readonly state: 'APPLICABLE';
      readonly expected: BoundaryExpectation;
      readonly risk: BoundaryRisk;
      /** The constraint value the case will be derived from, as read off the page. */
      readonly basis: string;
    }
  | {
      readonly state: 'UNBOUNDED';
      readonly expected: 'UNKNOWN';
      readonly risk: BoundaryRisk;
      readonly reason: string;
    }
  | {
      readonly state: 'CONSTRAINT_UNREAD';
      readonly constraint: BoundaryConstraint;
      /** Names the missing fact and the remedy. Printed, not swallowed. */
      readonly reason: string;
    }
  | { readonly state: 'INAPPLICABLE'; readonly reason: string };

/**
 * May a generator assert that the application REJECTS this case?
 *
 * The one predicate every generator must call before writing
 * `expect(error).toBeVisible()`. True only on the APPLICABLE arm with a
 * REJECTED expectation — so an unread constraint, an unbounded field and a
 * genuinely ambiguous class all return false, and the generator is pushed
 * towards the smoke assertion that is honest for them.
 */
export function mayAssertRejection(applicability: BoundaryApplicability): boolean {
  return applicability.state === 'APPLICABLE' && applicability.expected === 'REJECTED';
}

/** Does this class need a value already in the system before it means anything? */
export function needsPrecondition(klass: BoundaryClass): boolean {
  return BOUNDARY_DESCRIPTORS[klass].constraint === 'EXISTING_VALUE';
}

/**
 * What a scenario has to arrange before a class is testable.
 *
 * Only DUPLICATE_OF_EXISTING has one today, and it is a real obligation rather
 * than a note: "sign up with an existing email" run against an email nobody has
 * registered tests the happy path and reports a negative-case pass. The
 * scenario must create the first account, and the principal that owns it is the
 * one from principals.ts — which is why this type names a principal rather than
 * a value.
 */
export interface BoundaryPrecondition {
  readonly klass: BoundaryClass;
  /** The principal name whose existing data makes the case meaningful. */
  readonly establishedBy: string;
  readonly what: string;
}

/**
 * Which constraint reading a class depends on, for this field.
 *
 * Split out from {@link boundaryApplicability} so the dependency is stated once
 * and the big function below reads as a decision rather than as a lookup table
 * with a decision mixed into it.
 */
function readingFor(
  constraint: BoundaryConstraint,
  field: BoundaryField,
): ConstraintReading<string | number> {
  switch (constraint) {
    case 'maxLength':
      return readConstraint(field.maxLength);
    case 'minLength':
      return readConstraint(field.minLength);
    case 'min':
      return readConstraint(field.min);
    case 'max':
      return readConstraint(field.max);
    case 'step':
      return readConstraint(field.step);
    case 'pattern':
      return readConstraint(field.pattern);
    case 'REQUIRED':
    case 'FIELD_FAMILY':
    case 'EXISTING_VALUE':
      /*
       * Not three-state. `required`, `inputType` and `semantic` are captured by
       * every crawl that has ever run, and EXISTING_VALUE is not on the page at
       * all — it is a precondition the scenario establishes. Returning READ here
       * routes all four to the family checks below, which is where their real
       * applicability is decided.
       */
      return { state: 'READ', value: constraint };
  }
}

/**
 * Whether the class can apply to this KIND of field, ignoring constraints.
 *
 * Returns null when it can, or the sentence explaining why it cannot. Null for
 * "no objection" is the shape that makes the caller below read in one
 * direction; the alternative is a boolean plus a parallel reason lookup.
 */
function familyObjection(klass: BoundaryClass, field: BoundaryField): string | null {
  const t = inputTypeOf(field);
  switch (klass) {
    case 'EMPTY':
    case 'WHITESPACE_ONLY':
      if (!(field.required ?? false)) {
        return 'the field is not required, so an empty submission is the legitimate happy path';
      }
      /*
       * WHITESPACE_ONLY needs a field a space can be typed into. A select, a
       * checkbox or a radio has no such state — its empty state is EMPTY, which
       * is already covered by the class above.
       */
      if (klass === 'WHITESPACE_ONLY' && !isTextual(field)) {
        return 'whitespace cannot be entered into this control, so EMPTY is the only presence case';
      }
      return null;

    case 'TOO_SHORT':
    case 'TOO_LONG':
      if (!isTextual(field)) return 'length limits apply to text, and this control holds none';
      return null;

    case 'AT_MIN':
    case 'BELOW_MIN':
    case 'AT_MAX':
    case 'ABOVE_MAX':
    case 'OFF_BY_ONE':
      if (!isNumeric(field) && !isTemporal(field)) {
        return 'min and max bound a quantity or an instant, and this field holds neither';
      }
      return null;

    case 'STEP_MISALIGNED':
      if (!isNumeric(field) && !isTemporal(field)) return 'step applies to numeric and temporal inputs';
      if ((field.step ?? '').toLowerCase() === 'any') {
        return 'the page declares step="any", which is an explicit statement that no step applies';
      }
      return null;

    case 'WRONG_TYPE':
      if (isTextual(field) && !['email', 'url', 'tel'].includes(t)) {
        return 'a free text field accepts any string, so there is no wrong type to send';
      }
      if (field.options !== undefined && field.options.length > 0) {
        /*
         * A closed option list IS worth attacking with a value outside it, and
         * that is a real test — but it is an authorization-shaped test about
         * what the server accepts, not a type error, and it belongs to the
         * forced-option scenario rather than here. Saying so beats generating a
         * WRONG_TYPE case whose rationale would be wrong.
         */
        return 'the control offers a closed option list; sending an unlisted option is its own case';
      }
      return null;

    case 'PATTERN_VIOLATION':
      if (!isTextual(field)) return 'pattern applies to text inputs';
      return null;

    case 'CHECKSUM_INVALID':
      if (!CHECKSUMMED_SEMANTICS.includes(field.semantic)) {
        return 'no arithmetic checksum is defined for this semantic';
      }
      return null;

    case 'FUTURE_DATE':
    case 'PAST_DATE':
      if (!isTemporal(field)) return 'the field does not hold an instant';
      return null;

    case 'LEAP_DAY':
      if (DATED_INPUT_TYPES.includes(t)) return null;
      /*
       * The semantic is a fallback, NOT an override, and the distinction was a
       * live bug: `semantic === 'date'` alone made a `<input type="time">`
       * accept a LEAP_DAY case, because a hand-rolled date picker is a TEXT
       * input with a date semantic and the check could not tell the two apart.
       *
       * So the semantic rescues a field whose input type says nothing (text), and
       * an explicit temporal input type that carries no calendar date — time,
       * month, week — WINS over it. A time input cannot hold 29 February however
       * the field is named.
       */
      if (field.semantic === 'date' && !TEMPORAL_INPUT_TYPES.includes(t)) return null;
      return 'the field holds no calendar date, so 29 February is not expressible in it';

    case 'DST_BOUNDARY':
      if (!CLOCKED_INPUT_TYPES.includes(t)) {
        return 'the field holds no wall-clock time, so a DST discontinuity is not expressible in it';
      }
      return null;

    case 'UNICODE_COMBINING':
    case 'RTL_MARK':
    case 'EMOJI_ASTRAL':
    case 'SQL_META':
    case 'HTML_META':
    case 'NULL_BYTE':
      if (!isTextual(field)) return 'the control holds no free text';
      return null;

    case 'LEADING_ZERO':
      /*
       * Deliberately wider than `isNumeric`. A postal code is a TEXT field whose
       * leading zero is load-bearing — 02134 is the canonical example, and it is
       * a text input in every application that gets it right and a number input
       * in every application that gets it wrong. Restricting this class to
       * numeric fields would skip exactly the fields the bug lives in.
       */
      if (isNumeric(field) || field.semantic === 'postal_code' || field.semantic === 'phone') {
        return null;
      }
      return 'a leading zero is only load-bearing in a numeric or code-shaped field';

    case 'NEGATIVE_ZERO':
    case 'SCIENTIFIC_NOTATION':
      if (!isNumeric(field)) return 'the field does not hold a number';
      return null;

    case 'DUPLICATE_OF_EXISTING':
      if (!UNIQUE_SEMANTICS.includes(field.semantic)) {
        return 'nothing suggests the application holds a uniqueness constraint on this field';
      }
      return null;
  }
}

/**
 * The one entry point: may this class be generated against this field, and on
 * what terms?
 *
 * Order matters. The FAMILY objection is checked FIRST, before the constraint
 * reading, and that is deliberate: a `maxlength` nobody captured on a checkbox
 * is not an ignorance worth reporting — the class could not have applied
 * anyway. Reporting it as CONSTRAINT_UNREAD would bury the real unread
 * constraints under a pile of noise about classes that were never candidates,
 * and the remedy printed beside it ("re-crawl with constraint capture") would be
 * useless advice.
 */
export function boundaryApplicability(
  klass: BoundaryClass,
  field: BoundaryField,
): BoundaryApplicability {
  const descriptor = BOUNDARY_DESCRIPTORS[klass];

  const objection = familyObjection(klass, field);
  if (objection !== null) return { state: 'INAPPLICABLE', reason: objection };

  const reading = readingFor(descriptor.constraint, field);

  if (reading.state === 'NOT_CAPTURED') {
    return {
      state: 'CONSTRAINT_UNREAD',
      constraint: descriptor.constraint,
      reason:
        `${field.name}: \`${descriptor.constraint}\` was never read, so this field has no ` +
        `${klass} boundary — it has an unknown one. Generating a case here would assert a limit ` +
        'the page may never have claimed. Re-crawl with constraint capture to resolve it.',
    };
  }

  if (reading.state === 'DECLARED_ABSENT') {
    return {
      state: 'UNBOUNDED',
      expected: 'UNKNOWN',
      risk: descriptor.risk,
      reason:
        `${field.name}: the page declares no \`${descriptor.constraint}\`. The probe is worth ` +
        'running — an unbounded field is where the interesting failures are — but the outcome ' +
        'may not be asserted as a rejection, because no limit was claimed to be enforced.',
    };
  }

  return {
    state: 'APPLICABLE',
    expected: descriptor.expected,
    risk: descriptor.risk,
    basis: String(reading.value),
  };
}

// ─── Enumeration, with its caps disclosed ────────────────────────────────────

/** One class against one field, with the verdict on whether it may be generated. */
export interface BoundaryCandidate {
  readonly field: string;
  readonly klass: BoundaryClass;
  readonly applicability: BoundaryApplicability;
}

/**
 * The full enumeration for one form, and an account of everything it did not
 * return.
 *
 * ── Why the counts are not optional ────────────────────────────────────────
 *
 * Because "a cap applied without being disclosed" is on the short list of lies
 * this product cannot afford. A take of 50 over a form with 300 candidates must
 * report that at least 250 more existed, or the number below it is a measurement
 * of our own budget presented as a measurement of the customer's application.
 *
 * `unreadConstraints` is the same rule pointed at ourselves: those candidates
 * were not dropped because they were uninteresting, they were dropped because
 * our crawl did not capture a limit, and that is OUR gap. Collapsing it into
 * `inapplicable` would hide a bug in QAAI inside a fact about the customer.
 */
export interface BoundaryEnumeration {
  /** Candidates a generator may act on, highest risk first. */
  readonly candidates: readonly BoundaryCandidate[];
  /** Preconditions the scenario must establish first. */
  readonly preconditions: readonly BoundaryPrecondition[];
  /** How many (field, class) pairs were considered in total. */
  readonly considered: number;
  /** Dropped because the class cannot apply to the field. Not a shortfall. */
  readonly inapplicable: number;
  /** Dropped because WE did not read the constraint. Our gap, named separately. */
  readonly unreadConstraints: number;
  /** Suppressed by `limit`. Zero when no cap bit. */
  readonly omittedByCap: number;
  /**
   * Why the cap bit, or null when it did not.
   *
   * Non-null exactly when `omittedByCap > 0`, so a reader can never see a
   * shortfall with no reason beside it.
   */
  readonly capReason: string | null;
}

/**
 * Enumerate every class against every field.
 *
 * DETERMINISTIC: no clock, no randomness, and the comparator is TOTAL — risk
 * rank, then field order as given, then class order as declared in
 * {@link BOUNDARY_CLASSES}.
 *
 * ── What the tie-breaks do and do not buy, stated accurately ───────────────
 *
 * They are NOT what makes repeated calls agree. `Array.prototype.sort` has been
 * stable by specification since ES2019, and the tie-breaks reproduce the
 * insertion order the loops below already produce — so removing them leaves
 * observable output unchanged today, and a mutation that removes them survives
 * this file's tests. That is recorded here rather than hidden, because an
 * earlier draft of this comment claimed they stopped `limit` returning a
 * different 50 candidates on a different day, and that claim was false.
 *
 * What they buy is that the ORDER IS STATED rather than inherited. The ranking
 * a capped run depends on is written down in one comparator instead of being an
 * emergent property of two nested loops plus an engine guarantee, so changing
 * either loop is a deliberate change to a declared order rather than a silent
 * change to a cap's contents. The pinned-order test in `boundaries.test.ts` is
 * what makes any such change visible.
 *
 * `limit` caps the ASSERTABLE candidates only, and reports what it dropped.
 */
export function enumerateBoundaries(
  fields: readonly BoundaryField[],
  options: { readonly limit?: number } = {},
): BoundaryEnumeration {
  const candidates: BoundaryCandidate[] = [];
  const preconditions: BoundaryPrecondition[] = [];
  let considered = 0;
  let inapplicable = 0;
  let unreadConstraints = 0;

  for (const field of fields) {
    for (const klass of BOUNDARY_CLASSES) {
      considered += 1;
      const applicability = boundaryApplicability(klass, field);
      if (applicability.state === 'INAPPLICABLE') {
        inapplicable += 1;
        continue;
      }
      if (applicability.state === 'CONSTRAINT_UNREAD') {
        unreadConstraints += 1;
        continue;
      }
      candidates.push({ field: field.name, klass, applicability });
      if (needsPrecondition(klass)) {
        preconditions.push({
          klass,
          establishedBy: field.name,
          what: `a record already holding this ${field.semantic} must exist before the case means anything`,
        });
      }
    }
  }

  // Total order. `fieldIndex` and `classIndex` are the tie-breakers that make it
  // total; without them two candidates of equal risk could swap between runs.
  const fieldIndex = new Map(fields.map((f, i) => [f.name, i]));
  const classIndex = new Map(BOUNDARY_CLASSES.map((c, i) => [c, i]));
  candidates.sort((a, b) => {
    const byRisk =
      BOUNDARY_RISK_RANK[riskOf(b.applicability)] - BOUNDARY_RISK_RANK[riskOf(a.applicability)];
    if (byRisk !== 0) return byRisk;
    const byField = (fieldIndex.get(a.field) ?? 0) - (fieldIndex.get(b.field) ?? 0);
    if (byField !== 0) return byField;
    return (classIndex.get(a.klass) ?? 0) - (classIndex.get(b.klass) ?? 0);
  });

  const limit = options.limit;
  if (limit === undefined || candidates.length <= limit) {
    return {
      candidates,
      preconditions,
      considered,
      inapplicable,
      unreadConstraints,
      omittedByCap: 0,
      capReason: null,
    };
  }

  const omittedByCap = candidates.length - limit;
  const kept = candidates.slice(0, limit);
  const keptFields = new Set(kept.map((c) => c.field));
  return {
    candidates: kept,
    // A precondition for a candidate that was capped away is not an obligation.
    preconditions: preconditions.filter((p) => keptFields.has(p.establishedBy)),
    considered,
    inapplicable,
    unreadConstraints,
    omittedByCap,
    capReason:
      `a limit of ${limit} boundary cases was applied; at least ${omittedByCap} more applicable ` +
      'cases existed on this form and were not generated',
  };
}

/** The risk on an arm that carries one. The two dropped arms never reach this. */
function riskOf(applicability: BoundaryApplicability): BoundaryRisk {
  return applicability.state === 'APPLICABLE' || applicability.state === 'UNBOUNDED'
    ? applicability.risk
    : 'LOW';
}
