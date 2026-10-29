/**
 * Boundary and equivalence-class expansion — the negative half of testing.
 *
 * THE DEFECT THIS FIXES: one whole feature became ONE negative test item, built
 * from the first required field, phrased as "submit with X left empty or set to
 * an invalid value" (see the `case 'negative'` arm of
 * `packages/agent/src/coverage.ts`). Nothing enumerated empty, whitespace-only,
 * too long, one over the limit, wrong type, pattern-violating, Luhn-invalid or
 * an out-of-range date. A suite built from that item proves that *a* bad
 * submission is refused, which is the one negative fact almost every form
 * already gets right.
 *
 * What a QA engineer actually does is mechanical, and this file is that
 * mechanism: take each field, partition its input space into equivalence
 * classes, and submit one representative of each — with every OTHER field
 * valid, so a failure names exactly one cause.
 *
 * ─── Three rules that shape everything here ──────────────────────────────────
 *
 * 1. ONE INVALID FIELD PER CASE. A case with two bad fields fails for a reason
 *    nobody can attribute, and the usual response to an unattributable failure
 *    is to delete the test.
 *
 * 2. EVERY CASE CARRIES ITS OWN JUSTIFICATION. `why` is one sentence, written
 *    for a reviewer who is looking at a negative test and wondering whether it
 *    is worth keeping. A test that cannot say why it exists gets deleted at the
 *    first red build, and then nobody knows the coverage went away.
 *
 * 3. THE CAP IS STATED, NOT SILENT. The full cross product of classes across
 *    fields is combinatorial and useless; this takes one case per class per
 *    field. What that leaves out is recorded in `dropped` and every caller that
 *    reports coverage is expected to print it, because a capped list presented
 *    as a complete one is the dishonest-coverage failure this product exists to
 *    stop.
 *
 * ─── What this file grew, and why it is three things and not one ─────────────
 *
 * {@link expandBoundaries} above is the FORM path, and two production callers
 * already read its output (`expandNegativeCases` in coverage.ts and the
 * source-analysis processor in apps/worker). Its vocabulary —
 * {@link EQUIVALENCE_CLASSES} — is a wire format those callers print, so it is
 * extended rather than replaced. Two things were added to it:
 *
 *   · {@link licenseExpectation}, which makes the keystone's unread-constraint
 *     rule structural instead of advisory. A case may only claim
 *     `expectation: 'rejected'` when the constraint that justifies the claim was
 *     actually READ off the page. Before this, `unbounded-length` carried
 *     `expectation: 'rejected'` while its own `expected` prose said either
 *     outcome passes — a doc comment contradicting the code under it, and a
 *     generator keying on the structured field would have written
 *     `expect(error).toBeVisible()` against a limit the page never claimed.
 *   · the third {@link BoundaryExpectation} member that downgrade needs.
 *
 * {@link expandBoundaryClasses} is the KEYSTONE path: all 27 of
 * `packages/shared/src/boundaries.ts`'s classes, with the applicability rule
 * enforced by the keystone itself rather than re-implemented here. It exists
 * beside the form path rather than inside it because adding classes to
 * `EQUIVALENCE_CLASSES` would silently change WHICH cases survive
 * `expandNegativeCases`'s breadth-first cap in coverage.ts — a round that
 * doubled the vocabulary would quietly evict the off-by-one cases that cap
 * currently keeps. Its consumption is one call site, named in the handover.
 *
 * {@link expandApiBoundaries} is the API path. Neither the API nor the contract
 * lane derived a single invalid input from the declared schema, though the
 * schema has been sitting on `ApiOperation.requestShape` since the ENUMERATE
 * round imported it — `bodyBounds` in api-surface.ts reads the TOP LEVEL of a
 * request body and records `NESTED_SHAPE_NOT_DESCENDED` for everything below
 * it. This descends it.
 */

import {
  boundaryEdges,
  cardForOutcome,
  cleanupFor,
  createSyntheticFactory,
  fillForm,
  formatDate,
  luhnBreak,
  uniquenessFor,
  SYNTHETIC_CLOCK,
  type ApiBoundaryEdge,
  type ApiParameterBound,
  type CleanupObligation,
  type FormField,
  type FormFieldSemantic,
  type UniquenessScope,
} from '@qaai/shared';
/*
 * ─── A CROSS-WORKSPACE RELATIVE IMPORT, AND THE ONE LINE THAT REMOVES IT ────
 *
 * `packages/shared/src/boundaries.ts` and `.../principals.ts` are NOT on
 * `packages/shared/src/index.ts`. Nothing re-exports them either: inside
 * `shared` they are reached relatively by `schemas.ts` and `types.ts`, and from
 * outside the package they are unreachable through the front door. So this
 * import is the defect the agent barrel's own comments describe — "a relative
 * import across a workspace boundary compiles and then bypasses the package's
 * own entry point", which leaves the keystone's compiler-enforced presence
 * records enforced on files nobody imports as a package.
 *
 * It is here on purpose and under protest, because the alternative is worse:
 * re-deriving `boundaryApplicability` in this file would be a SECOND copy of
 * the unread-constraint rule, and two copies of that rule is how one of them
 * drifts into generating the false failure the rule exists to prevent.
 *
 * THE FIX IS TWO LINES IN A FILE THIS CHANGE DOES NOT OWN, and they are in the
 * handover verbatim:
 *
 *     export * from './principals';
 *     export * from './boundaries';
 *
 * added to `packages/shared/src/index.ts` AFTER `./synthetic`, since
 * `boundaries.ts` imports `FormFieldSemantic` from `./flow-map`. The moment
 * they land, this block collapses into the `@qaai/shared` import above —
 * nothing else in this file changes, because every name below is imported under
 * its own identifier already.
 *
 * NOTE for whoever lands those lines: `boundaries.ts` exports `BoundaryField`
 * and `BoundaryExpectation`, and THIS package's barrel already publishes two
 * DIFFERENT types of both names from this very file. The two live in different
 * barrels so neither is TS2308 today, but a consumer that imports both packages
 * will have to disambiguate — which is why `BoundaryExpectation` is aliased
 * below. `BoundaryField` is deliberately NOT imported at all: this file's own
 * shape is structurally assignable to the keystone's, so every call passes it
 * uncast and the compiler checks the compatibility instead of a cast asserting
 * it.
 */
import {
  boundaryApplicability,
  enumerateBoundaries,
  mayAssertRejection,
  BOUNDARY_CLASSES,
  BOUNDARY_DESCRIPTORS,
  BOUNDARY_RISK_RANK,
} from '@qaai/shared';
import type {
  BoundaryApplicability,
  BoundaryClass,
  BoundaryExpectation as KeystoneExpectation,
  BoundaryPrecondition,
  BoundaryRisk,
} from '@qaai/shared';
import { isSafeProbeMethod } from '@qaai/shared';

// ─── Classes ─────────────────────────────────────────────────────────────────

/**
 * The partitions of a field's input space worth one representative each.
 *
 * Named after what is being tested rather than after the value, because the
 * name ends up in a test title: "rejects a value one over maxlength" tells a
 * reader what broke; "rejects aaaaaaaaaaa" does not.
 */
export const EQUIVALENCE_CLASSES = [
  'happy-path',
  'empty',
  'whitespace-only',
  'at-max-length',
  'over-max-length',
  'unbounded-length',
  'at-min-length',
  'under-min-length',
  'at-min',
  'under-min',
  'at-max',
  'over-max',
  'step-misaligned',
  'wrong-type',
  'pattern-violating',
  'luhn-invalid',
  'not-in-options',
  'injection-like',
  'unicode-emoji',
  'boundary-date',
] as const;
export type EquivalenceClass = (typeof EQUIVALENCE_CLASSES)[number];

/**
 * Whether the submission should go through. The assertion's DIRECTION, and the
 * third member is the one that keeps it honest.
 *
 * ── Why `handled` exists, and why it is spelled that way ────────────────────
 *
 * `rejected` is a claim: this application REFUSES this value. It is only
 * defensible when the application said so — a declared `maxlength`, a declared
 * `min`, a checksum the semantic defines. Against a field whose limit nobody
 * read, the same claim produces a test that goes RED AGAINST A CORRECT
 * APPLICATION, and the customer deletes the suite rather than the test. See the
 * header of packages/shared/src/boundaries.ts, which argues this at length and
 * owns the rule; {@link licenseExpectation} is where this file obeys it.
 *
 * `handled` is the weaker, true claim: the application did SOMETHING sane. It
 * did not 500, it did not silently discard the whole value, the page still
 * works. The keystone calls that a smoke assertion and licenses exactly it for
 * an UNKNOWN expectation.
 *
 * The WORD is load-bearing and was chosen for grammar, not for flavour. Both
 * consumers render this value into the sentence "expect it to be ${expectation}"
 * (`planItemForGap` in coverage.ts and `caseLine` in the worker's
 * analyze-source.ts), and that sentence has to read correctly on a customer's
 * approval screen. "expect it to be handled" does; "expect it to be unknown"
 * reads as a broken template, and a plan item that reads as broken gets
 * rejected along with the coverage it was carrying.
 *
 * It is NOT "we did not check". A `handled` case still runs and still asserts —
 * what it does not do is assert a direction nothing entitles it to.
 */
export type BoundaryExpectation = 'accepted' | 'rejected' | 'handled';

/**
 * A field as the expansion reads it: everything `FormField` carries except the
 * locator, which is optional here.
 *
 * The locator is how you DRIVE a field, not how you partition its input space,
 * and nothing in this file touches it. Requiring one would have forced the two
 * callers that have no locator to invent one — see `BoundaryForm` below.
 */
export type BoundaryField = Omit<FormField, 'selector'> & Partial<Pick<FormField, 'selector'>>;

/**
 * What this file actually needs off a form: an id to build case ids from, a
 * name to put in a title, and the fields.
 *
 * Narrower than `FormModel` on purpose. A `FormModel` also carries the form's
 * own locator and its submit locator, and the only callers that could supply
 * those are the ones that crawled a live page. `coverage.ts` holds a
 * `FormSummary` read back out of a stored FlowMap Json column, and
 * `analyze-source.ts` holds a form read out of a source file — neither has a
 * real locator for the <form> element, and both would have had to invent one to
 * satisfy a `FormModel` parameter. An invented locator that nothing here reads
 * is a fabricated fact travelling in a typed field, which is how a selector
 * nobody could have observed ends up in a generated test. So the signature asks
 * for exactly what is read, and a `FormModel` still satisfies it structurally —
 * every existing caller is unchanged.
 */
export interface BoundaryForm {
  id: string;
  name: string;
  fields: readonly BoundaryField[];
}

export interface BoundaryCase {
  /** Deterministic and stable: the same form gives the same ids every run. */
  id: string;
  formId: string;
  formName: string;
  /** The one field this case perturbs. null on the happy path. */
  field: string | null;
  fieldLabel: string | null;
  semantic: FormFieldSemantic | null;
  equivalenceClass: EquivalenceClass;
  /** The value typed into `field`. null on the happy path. */
  value: string | null;
  /**
   * The COMPLETE submission: every other field holds a valid synthetic value,
   * so the only thing wrong with this submission is the one field above.
   */
  values: Record<string, string>;
  expectation: BoundaryExpectation;
  /** What the application should do. This is the assertion, in words. */
  expected: string;
  /** Why this case exists. One sentence, for the reviewer about to delete it. */
  why: string;
  /** Higher = likelier to find a real bug. See `RANKING` below. */
  rank: number;
  /** How that number was arrived at, so it can be argued with. */
  rankWhy: string;
}

export interface BoundaryExpansion {
  /** Ranked, highest first. A caller taking the top N gets the best N. */
  cases: BoundaryCase[];
  /**
   * What was NOT enumerated, and why.
   *
   * This is not a footnote. A capped list that presents itself as complete is
   * the exact dishonesty this product sells against, so every cap, every
   * skipped class and every combination deliberately not taken is counted here
   * and is expected to be printed alongside the cases.
   */
  dropped: Array<{ what: string; why: string; count: number }>;
  /** The valid submission every case is a one-field perturbation of. */
  happyPathValues: Record<string, string>;
  /** Anything the synthetic factory could not satisfy while building the above. */
  caveats: string[];
}

export interface BoundaryOptions {
  /** Run seed — every value here comes from the synthetic factory (§2). */
  seed: string | number;
  /** Narrows the value space below the run; pass a test or form id. */
  scope?: string;
  /** Hard cap on returned cases. The default keeps a form's expansion readable. */
  maxCases?: number;
  /** ISO instant for date generation. Defaults to the factory's frozen clock. */
  now?: string;
}

const DEFAULT_MAX_CASES = 60;

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Weights, and the reasoning for each. These are JUDGEMENT, not measurement —
 * there is no bug corpus behind them, and saying so is the point. They exist so
 * that a caller who can only afford ten tests spends them on the ten classes
 * most likely to be unhandled, rather than on the first ten alphabetically.
 *
 * The shape of the reasoning: a class scores high when the app is likely to
 * have NO code for it. `empty on required` is low not because it does not
 * matter but because every framework handles it for free, so the test almost
 * always passes and almost never teaches anything. `unbounded-length` scores
 * highest because a field with no declared maxlength usually means nobody
 * thought about length anywhere, including in the column definition.
 */
const RANKING: Record<EquivalenceClass, { weight: number; because: string }> = {
  'unbounded-length': {
    weight: 100,
    because:
      'the page declares no length limit at all, which usually means no limit was considered server-side or in the column either',
  },
  'injection-like': {
    weight: 95,
    because: 'an unescaped value is a security bug, not a validation bug, and it is cheap to check',
  },
  'over-max-length': {
    weight: 85,
    because:
      'the browser silently truncates at maxlength, so the server-side check is frequently absent and never exercised through the UI',
  },
  'luhn-invalid': {
    weight: 82,
    because:
      'a card form that passes an invalid number to the processor turns a client-side validation gap into a failed payment',
  },
  'over-max': { weight: 80, because: 'one past a declared bound is where off-by-one errors live' },
  'under-min': { weight: 78, because: 'the other side of the same off-by-one' },
  'wrong-type': {
    weight: 72,
    because:
      'type coercion failures surface as 500s rather than validation messages more often than any other class',
  },
  'unicode-emoji': {
    weight: 70,
    because:
      'multi-byte input breaks length checks, database collations and PDF/email rendering, and is almost never in a fixture',
  },
  'pattern-violating': {
    weight: 65,
    because:
      'the page declares the rule, so the only question is whether anything other than the browser enforces it',
  },
  'step-misaligned': {
    weight: 60,
    because:
      'a step violation is refused by the browser with a message the test never sees, so the server side is usually untested',
  },
  'boundary-date': {
    weight: 58,
    because: 'leap days and far-future dates break date maths that works for every ordinary date',
  },
  'not-in-options': {
    weight: 55,
    because:
      'a value outside the select cannot be typed by a user but is trivial to post, so this is where authorisation-by-dropdown fails',
  },
  'at-max-length': {
    weight: 45,
    because:
      'the last legal value must be ACCEPTED; a test that only pushes past the limit misses an over-strict check',
  },
  'at-max': { weight: 45, because: 'same: the inclusive bound must be accepted' },
  'at-min': { weight: 45, because: 'same, at the bottom of the range' },
  'at-min-length': { weight: 42, because: 'same, for length' },
  'whitespace-only': {
    weight: 40,
    because:
      'a required check written as `if (!value)` passes a single space, which is the most common trimming bug there is',
  },
  'under-min-length': { weight: 38, because: 'usually enforced, occasionally only in the browser' },
  empty: {
    weight: 30,
    because:
      'nearly always handled by the framework, so it passes and teaches little — but its absence is what makes a suite look untested',
  },
  'happy-path': {
    weight: 25,
    because:
      'it belongs in the set so the negative cases have something to be compared against, and it is ranked low because the suite almost certainly covers it already',
  },
};

/**
 * "The page declares none" and "nobody captured it" are different facts, and
 * this is the one place in a position to tell them apart.
 *
 * THE DEFECT THIS PREVENTS: a lie with a straight face. `FormField` makes every
 * constraint optional precisely so that `undefined` (nothing looked) and `null`
 * (something looked and the page declares nothing) stay distinguishable — see
 * the comment block on it in packages/shared/src/flow-map.ts. The first draft
 * of this file collapsed them and wrote "the page declares no minlength" for
 * both, which is a claim about the customer's markup made on the strength of
 * having never read it.
 *
 * It is not a hypothetical. `apps/worker/src/processors/analyze-source.ts`
 * builds its forms from a static read of source files that captures NO length,
 * range, step or pattern attribute at all — every one of them is `undefined`
 * there — so on that path the collapsed wording would have asserted, ten times
 * per field, that a page declares nothing when the truth is that nobody looked.
 *
 * The two sentences also lead somewhere different: "declares none" is a fact
 * about the application and the end of the enquiry, while "not captured" is a
 * gap in OUR input and an instruction to re-crawl.
 */
function nothingDeclared(attribute: string, ...values: readonly unknown[]): string {
  return values.every((value) => value === undefined)
    ? `no ${attribute} was captured on this field, and "not captured" is not "the page declares none" — re-read the field to learn which it is`
    : `the page declares no ${attribute}`;
}

/**
 * Semantics that genuinely accept whatever a person types — so "this value must
 * round-trip" is a defensible expectation for them and for nothing else.
 *
 * Named after the QUESTION rather than after the one class that first needed
 * it, because {@link representativeValue} asks it of five classes now:
 * SQL_META, HTML_META, UNICODE_COMBINING, RTL_MARK and EMOJI_ASTRAL. Each one
 * expects the value through intact, and that expectation is only defensible on
 * a field whose format is open.
 *
 * THE DEFECT THIS PREVENTS, found by wiring this file to its first real caller:
 * the `unicode-emoji` case is the one class here whose expectation is ACCEPTED,
 * and it was emitted for every field `isTextual` admitted. That includes a
 * `credit_card` field — so the expansion produced a case asserting that a card
 * number input ACCEPTS "Ünïcødé 名前 🧪 🧬", which a correct payment form must
 * refuse. It was ranked high enough (82 on a high-stakes field) to land in the
 * top twelve, so it was not a theoretical possibility: it was a generated test
 * that would fail against a working application and send the bug report to the
 * app team. `boundsOf` already carries a long comment calling that "the worst
 * way for this file to be wrong"; this was the same mistake in another class,
 * and {@link representativeValue} reproduced it a THIRD time before this set
 * gated the keystone path too — SQL_META asserted, at CRITICAL risk and at the
 * very top of the ranking, that a card-number field ACCEPTS "O'Brien".
 *
 * The set is positive, not negative, and that is the safe direction. A field
 * whose format is fixed gets NO emoji case rather than one expecting rejection
 * — "an app must refuse emoji in a postcode" is not something this file knows
 * either, and the `wrong-type` class already asks that field the malformed-value
 * question with an expectation that can be defended.
 */
const ACCEPTS_ANY_TEXT: ReadonlySet<FormFieldSemantic> = new Set([
  'person_name',
  'street_address',
  'city',
  'country',
  // Any Unicode belongs in a password, and a form that silently refuses or
  // mangles one locks a real user out of an account they set up correctly.
  'password',
  'freeform',
  'search',
  'unknown',
]);

/** Fields whose failure costs money, access or data. Their cases rank up. */
const HIGH_STAKES: ReadonlySet<FormFieldSemantic> = new Set([
  'credit_card',
  'card_cvc',
  'card_expiry',
  'currency',
  'password',
  'email',
]);

// ─── The licensing gate ──────────────────────────────────────────────────────

/**
 * This file's class → the keystone's class, so the unread-constraint rule is
 * applied by the module that owns it instead of being re-argued here.
 *
 * A `Record` keyed on {@link EquivalenceClass}, so a twenty-first class in this
 * file's vocabulary cannot be added without deciding which keystone class
 * governs its licence — rather than defaulting to "ungoverned", which is the
 * value that lets a false rejection assertion back in.
 *
 * ── The two deliberate nulls ────────────────────────────────────────────────
 *
 * `happy-path` has no boundary class because it is not a boundary; it is the
 * positive control, and {@link licenseExpectation} only ever weakens a
 * rejection, so it could not be touched anyway.
 *
 * `not-in-options` is a RECORDED VOCABULARY GAP, not an oversight. The keystone
 * has no class for "post a value outside a `<select>`'s option list", and says
 * so in the WRONG_TYPE arm of its own `familyObjection`: "the control offers a
 * closed option list; sending an unlisted option is its own case". It stays
 * assertable here because its defining constraint — the option list — WAS read
 * off the page, which is the same test every other licensed class passes.
 *
 * ── Why several classes share one keystone class ────────────────────────────
 *
 * `at-max-length`, `over-max-length` and `unbounded-length` all map to
 * `TOO_LONG` because they are all governed by ONE constraint, `maxlength`, and
 * the licence is a question about the constraint and not about the value. That
 * is the whole mechanism: `over-max-length` is only ever emitted when a
 * maxlength was read, so it licenses; `unbounded-length` is only ever emitted
 * when one was NOT, so it does not.
 */
const KEYSTONE_CLASS: Record<EquivalenceClass, BoundaryClass | null> = {
  'happy-path': null,
  empty: 'EMPTY',
  'whitespace-only': 'WHITESPACE_ONLY',
  'at-max-length': 'TOO_LONG',
  'over-max-length': 'TOO_LONG',
  'unbounded-length': 'TOO_LONG',
  'at-min-length': 'TOO_SHORT',
  'under-min-length': 'TOO_SHORT',
  'at-min': 'AT_MIN',
  'under-min': 'BELOW_MIN',
  'at-max': 'AT_MAX',
  'over-max': 'ABOVE_MAX',
  'step-misaligned': 'STEP_MISALIGNED',
  'wrong-type': 'WRONG_TYPE',
  'pattern-violating': 'PATTERN_VIOLATION',
  'luhn-invalid': 'CHECKSUM_INVALID',
  'not-in-options': null,
  'injection-like': 'HTML_META',
  'unicode-emoji': 'EMOJI_ASTRAL',
  'boundary-date': 'LEAP_DAY',
};

/** A rejection this file wanted to assert and was not entitled to. */
interface ExpectationDowngrade {
  readonly klass: EquivalenceClass;
  readonly field: string;
  /** Why the rejection was not licensed. The keystone's own sentence. */
  readonly because: string;
}

/**
 * May this case assert that the application REJECTS the value, or only that it
 * HANDLED it?
 *
 * Asks `mayAssertRejection` in packages/shared/src/boundaries.ts, which is true
 * on exactly one of four arms: the constraint was READ and the class expects a
 * rejection. Everything else — nobody read the constraint, the page declares
 * none, or the class's honest expectation is acceptance or ambiguity — comes
 * back false and is downgraded here.
 *
 * ── ONE DIRECTION ONLY, and that is a judgement worth stating ──────────────
 *
 * This weakens `rejected` and never touches `accepted`. The lie it exists to
 * stop is a GENERATED TEST THAT GOES RED AGAINST A CORRECT APPLICATION, because
 * that is the failure that ends with the suite deleted — the bug report lands
 * on the application team, they prove the page never promised the limit, and
 * QAAI is the thing at fault. A too-strong `accepted` fails the other way, which
 * is worse epistemically and far cheaper practically.
 *
 * It also means `unicode-emoji` keeps its `accepted` expectation even though the
 * keystone's descriptor for EMOJI_ASTRAL says UNKNOWN. That is deliberate and
 * the keystone agrees with it: `ACCEPTS_ANY_TEXT` above is keyed on the
 * SEMANTIC, and the keystone's own FUTURE_DATE note says the expectation for
 * this family "comes from the semantic, never from the class". A set of eight
 * semantics that genuinely accept whatever a person types is a narrower and
 * better-argued judgement than a class-level default.
 *
 * ── INAPPLICABLE IS IGNORED, and that is the other judgement ───────────────
 *
 * The keystone's `familyObjection` is deliberately conservative about which
 * KIND of field a class can attack, and on two classes this file knows more.
 * `wrong-type` is the example: the keystone refuses it on any free-text input
 * that is not email/url/tel, while {@link wrongTypeValue} here is keyed on the
 * semantic and has a real wrong-type value for a `credit_card` rendered as
 * `<input type="text">` — "4242-abcd-4242-4242", which a card form must refuse
 * before it calls the processor. Downgrading that to `handled` would make this
 * path WEAKER than it is today, so an INAPPLICABLE verdict is read as "the
 * keystone has no opinion about this pairing" rather than as a veto. A case this
 * file declined to emit never reaches here at all, so nothing is widened.
 */
function licenseExpectation(
  klass: EquivalenceClass,
  field: BoundaryField,
  intended: BoundaryExpectation,
): { expectation: BoundaryExpectation; downgrade: ExpectationDowngrade | null } {
  if (intended !== 'rejected') return { expectation: intended, downgrade: null };

  const keystone = KEYSTONE_CLASS[klass];
  if (keystone === null) return { expectation: intended, downgrade: null };

  const applicability = boundaryApplicability(keystone, field);
  if (applicability.state === 'INAPPLICABLE') return { expectation: intended, downgrade: null };
  if (mayAssertRejection(applicability)) return { expectation: intended, downgrade: null };

  return {
    expectation: 'handled',
    downgrade: { klass, field: field.name, because: licenceRefusal(keystone, applicability) },
  };
}

/**
 * The keystone's own sentence for why a rejection is not licensed.
 *
 * Quoted rather than paraphrased: the UNBOUNDED and CONSTRAINT_UNREAD arms each
 * carry a `reason` written for a customer to read, including the remedy
 * ("re-crawl with constraint capture"), and rewriting it here would be a second
 * wording of one fact that could drift from the first.
 */
function licenceRefusal(klass: BoundaryClass, applicability: BoundaryApplicability): string {
  switch (applicability.state) {
    case 'UNBOUNDED':
    case 'CONSTRAINT_UNREAD':
      return applicability.reason;
    case 'APPLICABLE':
      /*
       * The constraint WAS read and the class still does not expect a rejection
       * — `injection-like` is the live case. HTML_META's honest expectation is
       * that the value is ACCEPTED and rendered escaped, so "expect an error"
       * would fail against an application that does the right thing.
       */
      return (
        `the \`${BOUNDARY_DESCRIPTORS[klass].constraint}\` behind ${klass} was read, but the ` +
        `honest expectation for this class is ${BOUNDARY_DESCRIPTORS[klass].expected} and not a ` +
        `rejection: ${BOUNDARY_DESCRIPTORS[klass].why}`
      );
    case 'INAPPLICABLE':
      /*
       * Unreachable: the caller returns before constructing a refusal on this
       * arm. Spelled out rather than left to a `default`, so the switch stays
       * exhaustive and a twenty-eighth arm in the keystone is a compile error
       * here instead of a silent empty string.
       */
      return applicability.reason;
  }
}

// ─── Expansion ───────────────────────────────────────────────────────────────

/**
 * The classes for one field, each with its value and its justification.
 *
 * Returns both the cases and the classes that did NOT apply, because "no
 * maxlength case for this field" has two completely different meanings — the
 * page declares no limit (interesting, and handled by `unbounded-length`) or
 * the field is a `<select>` where length is meaningless (not interesting) — and
 * a caller that cannot tell them apart will report the wrong thing.
 */
export function expandBoundaries(form: BoundaryForm, options: BoundaryOptions): BoundaryExpansion {
  const factory = createSyntheticFactory({
    seed: options.seed,
    scope: options.scope ?? form.id,
    ...(options.now ? { now: options.now } : {}),
  });

  const fields = form.fields;
  const fill = fillForm(fields, {
    seed: options.seed,
    scope: options.scope ?? form.id,
    ...(options.now ? { now: options.now } : {}),
  });
  const happy = fill.values;

  const cases: BoundaryCase[] = [];
  const dropped: BoundaryExpansion['dropped'] = [];
  /**
   * Rejections this expansion wanted to assert and was not entitled to.
   *
   * Collected rather than counted, because the disclosure has to NAME the
   * classes: "3 rejection assertions were downgraded" tells a reviewer nothing,
   * while "unbounded-length on Bio, Notes and Message" tells them which fields
   * to re-crawl. A downgrade is a cap on what we may claim, and a cap that bit
   * without being reported is one of the lies this product cannot afford.
   */
  const downgrades: ExpectationDowngrade[] = [];
  /** class → how many fields it did not apply to, and why. */
  const notApplicable = new Map<string, { why: string; count: number }>();
  const skip = (klass: EquivalenceClass, why: string): void => {
    const key = `${klass}: ${why}`;
    const existing = notApplicable.get(key);
    if (existing) existing.count += 1;
    else notApplicable.set(key, { why: `${klass} — ${why}`, count: 1 });
  };

  // ── The happy path ─────────────────────────────────────────────────────────
  // Present on purpose, and first: a negative suite with no positive control
  // cannot distinguish "the app correctly refused bad input" from "the app
  // refuses everything", and the second has shipped more than once.
  if (fields.length > 0) {
    cases.push(
      rank({
        id: caseId(form, null, 'happy-path'),
        formId: form.id,
        formName: form.name,
        field: null,
        fieldLabel: null,
        semantic: null,
        equivalenceClass: 'happy-path',
        value: null,
        values: { ...happy },
        expectation: 'accepted',
        expected:
          'The submission is accepted and the resulting state reflects what was entered — assert the stored values, not that a success message appeared.',
        why: 'The positive control. Without it, every negative case below is consistent with a form that refuses all input.',
      }),
    );
  }

  for (const field of fields) {
    const valid = happy[field.name] ?? '';
    const push = (
      klass: EquivalenceClass,
      value: string,
      expectation: BoundaryExpectation,
      expected: string,
      why: string,
    ): void => {
      /*
       * THE LICENCE CHECK, applied to every case on its way out.
       *
       * Here and not at each call site, because the property that matters is
       * that NO case can reach `cases` with an unlicensed rejection on it — and
       * a rule applied at twenty call sites is a rule the twenty-first forgets.
       */
      const licence = licenseExpectation(klass, field, expectation);
      if (licence.downgrade !== null) downgrades.push(licence.downgrade);
      cases.push(
        rank({
          id: caseId(form, field, klass),
          formId: form.id,
          formName: form.name,
          field: field.name,
          fieldLabel: field.label,
          semantic: field.semantic,
          equivalenceClass: klass,
          value,
          values: { ...happy, [field.name]: value },
          expectation: licence.expectation,
          /*
           * The prose is corrected with the structured field, in the same
           * place. A case whose `expectation` says `handled` under an `expected`
           * sentence demanding an error is the original defect wearing the
           * fix's clothes — the generator reads one and the reviewer reads the
           * other, and they disagree.
           */
          expected:
            licence.downgrade === null
              ? expected
              : `NOT ASSERTED AS A REJECTION — ${licence.downgrade.because} So assert only that the application HANDLED the value: no 500, no stack trace, no database error reaching the user, and the page still works. ${expected}`,
          why,
        }),
      );
    };

    const label = field.label ?? field.name;

    // ── Required-ness ───────────────────────────────────────────────────────
    if (field.required) {
      push(
        'empty',
        '',
        'rejected',
        `The submission is refused and the message names "${label}". Nothing is written: re-reading afterwards shows no new record.`,
        `"${label}" is marked required, and a required field is only required if the empty submission is actually refused.`,
      );
      push(
        'whitespace-only',
        '   ',
        'rejected',
        `Refused exactly as the empty case is, with the same message naming "${label}" — not accepted and stored as three spaces.`,
        'A required check written as `if (!value)` accepts a single space; this is the case that separates a real check from a falsy check.',
      );
    } else {
      skip('empty', 'the field is not required, so an empty value is a legal submission');
      skip('whitespace-only', 'the field is not required');
    }

    // ── Length ──────────────────────────────────────────────────────────────
    const max = field.maxLength;
    if (typeof max === 'number' && max > 0) {
      const atMax = exactLength(valid, max, field);
      if (atMax === null) {
        skip(
          'at-max-length',
          `maxlength=${max} is too small to hold any valid ${field.semantic} value — which is itself worth looking at`,
        );
      } else {
        push(
          'at-max-length',
          atMax,
          'accepted',
          'Accepted and stored in full, with no truncation anywhere in the round trip.',
          `maxlength=${max} says this is the longest legal value, so it must be accepted — a test that only pushes past the limit cannot catch an off-by-one that rejects the limit itself.`,
        );
        push(
          'over-max-length',
          `${atMax}x`,
          'rejected',
          'Refused by the server, not merely truncated by the browser. Submit it by filling the field programmatically, since the maxlength attribute stops a human from typing it.',
          `One character past maxlength=${max}. The browser enforces this attribute, which is precisely why the server-side check is so often missing and never noticed.`,
        );
      }
    } else if (isTextual(field)) {
      // No limit in hand. The most productive negative case there is — and the
      // `why` has to say WHICH of the two reasons there is no limit in hand,
      // because "the page declares none" is an argument for sending the string
      // and "nobody read the attribute" is an argument for re-reading it first.
      push(
        'unbounded-length',
        'A'.repeat(10_000),
        'rejected',
        'Either refused with a clear message or accepted and stored intact — but NOT a 500, a silent truncation, or a database error leaking to the user.',
        field.maxLength === undefined
          ? `No maxlength was captured for "${label}", so nothing here says whether a length limit exists at all; this is the case that finds the column limit the hard way, and it is worth re-reading the field to learn which of the two it is.`
          : `The page declares no maxlength on "${label}", so nothing here says a length was ever considered; this is the case that finds the column limit the hard way.`,
      );
    } else {
      skip(
        'unbounded-length',
        'the control is not a free-text field, so length is not its input space',
      );
    }

    const min = field.minLength;
    if (typeof min === 'number' && min > 0) {
      const atMin = exactLength(valid, min, field);
      if (atMin === null) {
        skip('at-min-length', `minlength=${min} cannot be met by a valid ${field.semantic} value`);
      } else {
        push(
          'at-min-length',
          atMin,
          'accepted',
          'Accepted — this is the shortest legal value.',
          `minlength=${min} declares this length legal, and an over-strict check that demands one more character is invisible without this case.`,
        );
        if (min > 1) {
          push(
            'under-min-length',
            atMin.slice(0, min - 1),
            'rejected',
            `Refused with a message that says how long the value must be, naming "${label}".`,
            `One character under minlength=${min} — the other half of the off-by-one, and the half a user actually hits.`,
          );
        }
      }
    } else {
      skip('at-min-length', nothingDeclared('minlength', field.minLength));
      skip('under-min-length', nothingDeclared('minlength', field.minLength));
    }

    // ── Numeric and date bounds ─────────────────────────────────────────────
    const bounds = boundsOf(field);
    if (bounds) {
      if (bounds.min !== null) {
        push(
          'at-min',
          bounds.min.at,
          'accepted',
          'Accepted — a declared minimum is inclusive.',
          `min="${field.min}" declares this value legal; an exclusive check written for an inclusive attribute rejects it, and nothing else catches that.`,
        );
        if (bounds.min.under !== null) {
          push(
            'under-min',
            bounds.min.under,
            'rejected',
            `Refused, with the limit stated in the message. No clamping: silently raising the value to the minimum is a data bug, not a fix.`,
            `One step below min="${field.min}". Off-by-one on a declared bound is the single most common validation defect.`,
          );
        }
      }
      if (bounds.max !== null) {
        push(
          'at-max',
          bounds.max.at,
          'accepted',
          'Accepted — a declared maximum is inclusive.',
          `max="${field.max}" declares this value legal, so rejecting it is an off-by-one in the other direction.`,
        );
        if (bounds.max.over !== null) {
          push(
            'over-max',
            bounds.max.over,
            'rejected',
            'Refused, with the limit stated. Not clamped, and not accepted and clamped later in the pipeline.',
            `One step past max="${field.max}" — and on a quantity or money field this is the case that turns into a pricing bug.`,
          );
        }
      }
      if (bounds.stepMisaligned !== null) {
        push(
          'step-misaligned',
          bounds.stepMisaligned,
          'rejected',
          'Refused by the server. The browser blocks this one on its own, so a test that drives the UI by typing will never reach the server check.',
          `step="${field.step}" says which values are legal; a value between two steps is refused in the browser and therefore almost never validated anywhere else.`,
        );
      }
    } else {
      skip('at-min', nothingDeclared('min or max', field.min, field.max));
      skip('step-misaligned', nothingDeclared('step', field.step));
    }

    // ── Shape ───────────────────────────────────────────────────────────────
    const wrong = wrongTypeValue(field);
    if (wrong === null) {
      skip(
        'wrong-type',
        `a "${field.semantic}" field accepts free text, so no value is the wrong type`,
      );
    } else {
      push(
        'wrong-type',
        wrong.value,
        'rejected',
        'Refused with a validation message. Specifically NOT a 500, a stack trace, or a NaN/Invalid Date written to storage.',
        wrong.why,
      );
    }

    if (field.pattern != null && field.pattern !== '') {
      const violating = patternViolatingValue(field);
      if (violating === null) {
        skip(
          'pattern-violating',
          `every candidate value satisfies pattern="${field.pattern}", so no representative of this class could be built — a pattern that accepts everything is worth a second look`,
        );
      } else {
        push(
          'pattern-violating',
          violating,
          'rejected',
          `Refused, and the message says what the format should be — ideally the page's own words${
            field.validationMessage ? `: "${field.validationMessage}"` : ''
          }.`,
          `The page declares pattern="${field.pattern}", so the rule is known; the open question is whether anything but the browser enforces it.`,
        );
      }
    } else {
      skip('pattern-violating', nothingDeclared('pattern', field.pattern));
    }

    if (field.semantic === 'credit_card') {
      const success = cardForOutcome('success');
      const base = (success?.value ?? valid).replace(/\s/g, '');
      push(
        'luhn-invalid',
        luhnBreak(base),
        'rejected',
        'Refused in the browser, before any request reaches the payment provider. If a network call goes out, card validation is not wired up.',
        'A number that fails the mod-10 checksum with the right length and the right prefix: it tests the checksum specifically, not the length validator standing in front of it.',
      );
    } else {
      skip('luhn-invalid', 'not a card-number field');
    }

    if (field.options && field.options.length > 0) {
      push(
        'not-in-options',
        `qaai-not-an-option-${factory.token}`,
        'rejected',
        "Refused server-side. A user cannot type this, but anyone can post it — so an app that trusts the dropdown accepts it, and that is how a hidden plan tier or another tenant's id gets selected.",
        `This control offers ${field.options.length} option(s), and the only thing stopping a value outside that set is a server-side check nobody has tested.`,
      );
    } else {
      skip('not-in-options', 'the control is not a select or radio group');
    }

    if (isTextual(field)) {
      push(
        'injection-like',
        `'"><script>alert('qaai')</script>-- `,
        'rejected',
        'Either refused or stored and rendered ESCAPED — the string appears as text on the page, no script runs, and no SQL error surfaces. Both outcomes pass; an executed script or a database error does not.',
        'The cheapest security check there is, and the one place where "the app accepted it" is not automatically the good outcome.',
      );
      /*
       * The one negative-looking class whose expectation is ACCEPTED.
       *
       * Emoji are valid input IN A FIELD THAT TAKES FREE TEXT. A form that
       * refuses them there is the bug, so the assertion is a round trip and not
       * a rejection — and getting this direction wrong would produce a test
       * that fails against a correct application. Which is exactly what it did
       * for a card number before `ACCEPTS_ANY_TEXT` gated it; see the note
       * on that set.
       */
      if (ACCEPTS_ANY_TEXT.has(field.semantic)) {
        push(
          'unicode-emoji',
          'Ünïcødé 名前 🧪 🧬',
          'accepted',
          'Accepted and round-tripped byte for byte: the same characters come back out of storage, out of the API, and into any email or PDF the value reaches.',
          'Multi-byte characters break length checks that count bytes, collations that assume Latin-1, and every renderer with a hard-coded font — and they are in approximately no fixture anywhere.',
        );
      } else {
        skip(
          'unicode-emoji',
          `a "${field.semantic}" value has a fixed format, so neither "emoji must round-trip" nor "emoji must be refused" is an expectation this can defend — the wrong-type case asks that field the malformed-value question instead`,
        );
      }
    } else {
      skip('injection-like', 'the control does not accept free text');
      skip('unicode-emoji', 'the control does not accept free text');
    }

    if (isDateLike(field)) {
      push(
        'boundary-date',
        '2024-02-29',
        'accepted',
        'Accepted and stored as 29 February 2024. A leap day that comes back as 1 March, or as an error, is a date-maths bug.',
        'Leap day is the date that breaks code which works for every other date, and it is never in a hand-written fixture.',
      );
    } else {
      skip('boundary-date', 'not a date-like control');
    }
  }

  // ── Cap, and say what the cap cost ────────────────────────────────────────
  cases.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));

  const limit = options.maxCases ?? DEFAULT_MAX_CASES;
  if (cases.length > limit) {
    dropped.push({
      what: `${cases.length - limit} lower-ranked cases`,
      why: `Capped at ${limit}. The cases are ranked, so what was cut is what the heuristic in RANKING considers least likely to find a bug — raise maxCases to see them.`,
      count: cases.length - limit,
    });
  }
  const kept = cases.slice(0, limit);

  /*
   * The combination explosion, stated rather than implied.
   *
   * Two invalid fields at once is a real class of defect (a form that reports
   * only the first error, a validator that short-circuits). It is deliberately
   * not enumerated: n single-field cases give n(n-1)/2 pairs, which for a
   * ten-field form is already hundreds of tests whose failures cannot be
   * attributed to one cause. Saying the number out loud is the difference
   * between a considered cap and an accidental one.
   */
  const singleFieldCases = cases.filter((c) => c.field !== null).length;
  if (singleFieldCases > 1) {
    const pairs = (singleFieldCases * (singleFieldCases - 1)) / 2;
    dropped.push({
      what: `${pairs} two-field combinations`,
      why: 'Not enumerated by design: a case with two invalid fields fails for a reason that cannot be attributed to either one. Worth ONE hand-written test ("the form reports every error, not just the first"), not a generated matrix.',
      count: pairs,
    });
  }

  /*
   * The downgrades, reported BEFORE the not-applicable list.
   *
   * A downgraded case is still in the table and still runs, so nothing is
   * missing — what is missing is the STRENGTH of its assertion, and that is the
   * thing a reader would otherwise never learn. It is grouped by class so the
   * line names the fields to re-crawl rather than repeating one sentence per
   * field, and the count is the number of ASSERTIONS weakened, which is the
   * number a reviewer can act on.
   */
  const byClass = new Map<EquivalenceClass, ExpectationDowngrade[]>();
  for (const downgrade of downgrades) {
    const list = byClass.get(downgrade.klass);
    if (list) list.push(downgrade);
    else byClass.set(downgrade.klass, [downgrade]);
  }
  for (const [klass, group] of byClass) {
    dropped.push({
      what: `${group.length} ${klass} rejection assertion(s) weakened to a handled-outcome assertion on ${group.map((d) => `"${d.field}"`).join(', ')}`,
      why: `Nothing the application declared entitles a test to assert a rejection here, so asserting one would produce a red build against a CORRECT application — which costs more than the bug it might find. ${group[0]?.because ?? ''}`,
      count: group.length,
    });
  }

  for (const [, entry] of notApplicable) {
    dropped.push({
      what: entry.why,
      why: `Did not apply to ${entry.count} field(s). Listed so that "no case for this class" is never mistaken for "this class was forgotten".`,
      count: entry.count,
    });
  }

  /*
   * The caveat that outranks all the others, stated first.
   *
   * Every case here submits the WHOLE form with one field perturbed. So if the
   * factory could not produce a valid value for some OTHER field, each case
   * carries two bad values, and a rejection cannot be attributed to the field
   * under test — the one property this file exists to guarantee. Found by
   * inspection on a form with `pattern="[A-Z]{4}[0-9]{2}"`: one unsatisfiable
   * field quietly invalidated the negative half of every other field's cases.
   *
   * It is a caveat and not an error because the cases are still worth running;
   * what is not acceptable is running them without knowing.
   */
  const poisoned = fill.fields.filter((f) => f.unsatisfiable.length > 0);
  const caveats =
    poisoned.length === 0
      ? fill.notes
      : [
          `READ THIS FIRST: no valid value could be produced for ${poisoned
            .map((f) => `"${f.field}" (${f.unsatisfiable.join(', ')})`)
            .join(
              ', ',
            )}. Every case below submits the whole form, so each one carries that known-bad value as well as its own — which means a rejection cannot be attributed to the field under test until this is fixed.`,
          ...fill.notes,
        ];

  return {
    cases: kept,
    dropped,
    happyPathValues: happy,
    caveats,
  };
}

// ─── Case construction helpers ───────────────────────────────────────────────

function rank(partial: Omit<BoundaryCase, 'rank' | 'rankWhy'>): BoundaryCase {
  const base = RANKING[partial.equivalenceClass];
  let score = base.weight;
  const reasons = [base.because];

  /*
   * One adjustment, and only one: the stakes of the FIELD.
   *
   * Deliberately not a pile of weights. The class weight above is already a
   * judgement, and multiplying judgements together produces a number that looks
   * far more considered than it is — which is how a ranking stops being
   * arguable and starts being believed.
   */
  if (partial.field !== null && partial.semantic !== null && HIGH_STAKES.has(partial.semantic)) {
    score += 12;
    reasons.push(
      `a ${partial.semantic.replace(/_/g, ' ')} field, where a failure costs money or access`,
    );
  }

  return {
    ...partial,
    rank: score,
    rankWhy: `${score}: ${reasons.join('; ')}. This is a judgement, not a measurement — there is no bug corpus behind the weights.`,
  };
}

/** Stable across runs so a case can be referenced, suppressed, or diffed. */
function caseId(form: BoundaryForm, field: BoundaryField | null, klass: EquivalenceClass): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return field === null
    ? `${slug(form.id)}--${klass}`
    : `${slug(form.id)}--${slug(field.name)}--${klass}`;
}

/** Free text, where length and injection classes mean something. */
function isTextual(field: BoundaryField): boolean {
  if (field.options && field.options.length > 0) return false;
  const type = field.inputType.toLowerCase();
  if (
    [
      'number',
      'range',
      'date',
      'month',
      'week',
      'time',
      'datetime-local',
      'checkbox',
      'radio',
      'file',
      'color',
      'select',
    ].includes(type)
  ) {
    return false;
  }
  return !['number', 'currency', 'date', 'card_expiry'].includes(field.semantic);
}

function isDateLike(field: BoundaryField): boolean {
  return (
    field.semantic === 'date' ||
    ['date', 'month', 'week', 'datetime-local'].includes(field.inputType.toLowerCase())
  );
}

/**
 * A valid value padded or trimmed to EXACTLY n characters, still plausible for
 * the field, or null when that is impossible.
 *
 * Null is a real answer: `maxlength="6"` on an email input admits no valid
 * address, and the honest output is "no representative of this class exists,
 * and the reason is a contradiction in the page" — not a six-character string
 * that fails for the wrong reason.
 */
function exactLength(valid: string, n: number, field: BoundaryField): string | null {
  if (n <= 0) return null;

  switch (field.semantic) {
    case 'email': {
      const domain = '@example.com';
      const localLength = n - domain.length;
      if (localLength < 1) return null;
      const local = `qaai-${'x'.repeat(Math.max(0, localLength))}`.slice(0, localLength);
      return `${local}${domain}`;
    }
    case 'url': {
      /*
       * Built to length rather than sliced to it: `'https://example.com'.slice(0, 14)`
       * is "https://exampl", which is not a URL, and a case whose value is
       * invalid for a second reason cannot be attributed to the length check.
       * Short lengths grow the host label, longer ones grow the path.
       */
      const shortest = 'https://a.test';
      if (n < shortest.length) return null;
      if (n <= 'https://.test'.length + 32) {
        return `https://${'a'.repeat(n - 'https://.test'.length)}.test`;
      }
      const prefix = 'https://example.com/';
      return `${prefix}${'a'.repeat(n - prefix.length)}`;
    }
    case 'credit_card':
    case 'card_cvc':
    case 'card_expiry':
      // Fixed-width formats. A 15-character card number is not a short card
      // number, it is not a card number, and a case built on one tests nothing.
      return valid.length === n ? valid : null;
    case 'number':
    case 'currency':
      // Padding a number with zeros changes its text and not its value, which
      // makes the case ambiguous: a rejection could be the length check or the
      // leading zero. Declined rather than guessed.
      return null;
    default: {
      if (valid.length === n) return valid;
      if (valid.length > n) return valid.slice(0, n);
      // Pad with 'a' rather than repeating the value: a repeated value can trip
      // a duplicate-detection rule and give the case a second possible cause.
      return `${valid}${'a'.repeat(n - valid.length)}`;
    }
  }
}

/**
 * The `min`/`max`/`step` triple turned into the four values that matter, in the
 * field's own format. Returns null when the page declares no bounds.
 */
function boundsOf(field: BoundaryField): {
  min: { at: string; under: string | null } | null;
  max: { at: string; over: string | null } | null;
  stepMisaligned: string | null;
} | null {
  const hasMin = field.min != null && field.min !== '';
  const hasMax = field.max != null && field.max !== '';
  const hasStep = field.step != null && field.step !== '' && field.step !== 'any';
  if (!hasMin && !hasMax && !hasStep) return null;

  if (isDateLike(field)) {
    const type = field.inputType.toLowerCase();
    const shift = (iso: string, days: number): string | null => {
      const parsed = new Date(/^\d{4}-\d{2}$/.test(iso) ? `${iso}-01` : iso);
      if (Number.isNaN(parsed.getTime())) return null;
      const moved = new Date(parsed.getTime() + days * 86_400_000);
      const y = moved.getUTCFullYear();
      const m = String(moved.getUTCMonth() + 1).padStart(2, '0');
      const d = String(moved.getUTCDate()).padStart(2, '0');
      return type === 'month' ? `${y}-${m}` : `${y}-${m}-${d}`;
    };
    return {
      min: hasMin ? { at: field.min!, under: shift(field.min!, -1) } : null,
      max: hasMax ? { at: field.max!, over: shift(field.max!, 1) } : null,
      // A date `step` counts days/months and a misaligned date is an exotic
      // case; not enumerated rather than enumerated wrongly.
      stepMisaligned: null,
    };
  }

  const num = (value: string | null | undefined): number | null => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const minNum = num(field.min);
  const maxNum = num(field.max);
  const stepNum = num(field.step);
  const delta = stepNum !== null && stepNum > 0 ? stepNum : 1;
  const places = Math.max(decimalsOf(field.step), decimalsOf(field.min), decimalsOf(field.max));
  const fmt = (value: number): string => (places > 0 ? value.toFixed(places) : String(value));

  /*
   * HALF A STEP off the base, formatted with one more decimal place than the
   * step has.
   *
   * Both halves of that sentence are a bug this had. The first draft added a
   * fudge term that landed on min + 1 for `step="1"` — a value that is PERFECTLY
   * ALIGNED — and then `fmt` rounded it to an integer anyway, so the case
   * submitted a legal value while asserting it would be refused. A negative
   * test that asserts a rejection of something valid fails against a correct
   * application, which is the worst way for a generated test to be wrong.
   *
   * Half a step is the right representative: it is never on the grid, whatever
   * the step is, and it stays inside the declared range.
   */
  let stepMisaligned: string | null = null;
  if (stepNum !== null && stepNum > 0) {
    const base = minNum ?? 0;
    let offGrid = base + stepNum / 2;
    if (maxNum !== null && offGrid > maxNum) offGrid = maxNum - stepNum / 2;
    const stepPlaces = Math.max(places, decimalsOf(field.step) + 1);
    if (maxNum === null || offGrid > (minNum ?? 0) || minNum === null) {
      stepMisaligned = offGrid.toFixed(stepPlaces);
    }
  }

  return {
    min: minNum === null ? null : { at: fmt(minNum), under: fmt(minNum - delta) },
    max: maxNum === null ? null : { at: fmt(maxNum), over: fmt(maxNum + delta) },
    stepMisaligned,
  };
}

function decimalsOf(value: string | null | undefined): number {
  if (value == null) return 0;
  return value.split('.')[1]?.length ?? 0;
}

/**
 * A value of the wrong TYPE for the field — right shape, wrong kind.
 *
 * Deliberately not just "asdf" everywhere: `2026-02-31` is a far better test of
 * a date field than "hello", because it is well-formed and still impossible, so
 * it reaches the parser instead of bouncing off the input mask.
 */
function wrongTypeValue(field: BoundaryField): { value: string; why: string } | null {
  switch (field.semantic) {
    case 'email':
      return {
        value: 'qaai-at-example.com',
        why: 'A string with no "@": the minimum thing an email validator must catch, and the one every hand-rolled regex gets wrong in a different way.',
      };
    case 'url':
      return {
        value: 'htp:/example',
        why: 'A near-miss scheme. A URL field that accepts this stores a link that will never resolve for any user who clicks it.',
      };
    case 'phone':
      return {
        value: 'call me maybe',
        why: 'Letters in a telephone field. Worth checking because phone validation is frequently skipped entirely on the grounds that formats vary.',
      };
    case 'credit_card':
      return {
        value: '4242-abcd-4242-4242',
        why: 'Letters inside a card number, which must be refused before any processor call rather than passed through and declined.',
      };
    case 'card_cvc':
      return {
        value: '12a',
        why: 'A non-digit in the security code, where the field is almost always treated as a plain text input.',
      };
    case 'card_expiry':
      return {
        value: '13/99',
        why: 'Month 13. A field that accepts it is doing string handling where it should be doing date handling.',
      };
    case 'date':
      return {
        value: '2026-02-31',
        why: 'A well-formed but impossible date, so it reaches the date parser instead of being stopped by the input mask — this is where silent rollover to 3 March appears.',
      };
    case 'number':
    case 'currency':
      return {
        value: 'twelve',
        why: 'A word where a number is expected. The classic path to NaN in storage and a 500 on the next read.',
      };
    case 'postal_code':
      return {
        value: 'not a postcode at all',
        why: 'Free prose in a postal-code field, which commonly has no validation beyond its length.',
      };
    default:
      // Genuinely no wrong type: a free-text field accepts any string, and
      // inventing a "wrong" value for it would be a case whose expectation
      // nobody could defend.
      return null;
  }
}

/** A value the declared `pattern` rejects, or null if we could not find one. */
function patternViolatingValue(field: BoundaryField): string | null {
  const source = field.pattern;
  if (source == null || source === '') return null;
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`);
  } catch {
    // An uncompilable pattern is not enforced by the browser either, so there
    // is no rule here to violate — and that fact is reported by the caller.
    return null;
  }
  const candidates = ['qaai-pattern-violation', '!!!', ' ', '0', 'aaaa', '§±#', 'A'.repeat(64)];
  return candidates.find((c) => !re.test(c)) ?? null;
}

/**
 * One line a reviewer can read before trusting an expansion.
 *
 * Leads with the cap rather than the count, because a list of 60 cases reads as
 * thoroughness and the thing worth knowing is what the 60 left out.
 */
export function describeExpansion(expansion: BoundaryExpansion): string {
  const droppedTotal = expansion.dropped.reduce((sum, d) => sum + d.count, 0);
  return [
    `${expansion.cases.length} case(s) kept, one per equivalence class per field, ranked by how likely each is to find a real bug.`,
    `${droppedTotal} case(s) or combinations were deliberately not enumerated; see \`dropped\` for each reason.`,
    expansion.caveats.length > 0
      ? `${expansion.caveats.length} caveat(s) from building the valid submission these cases perturb — read them before trusting the happy path.`
      : 'The valid submission these cases perturb satisfies every constraint the page declares.',
  ].join(' ');
}

// ─── The keystone expansion ──────────────────────────────────────────────────

/**
 * What a generator is entitled to assert about one case. THREE members, and the
 * third is the entire point of this section.
 *
 * `ASSERT_REJECTION` is the strong claim and the rare one: the application
 * DECLARED the constraint, so a test may demand an error and name the field.
 * `ASSERT_ACCEPTANCE` is equally strong in the other direction — the limit
 * itself must be accepted, O'Brien must be able to sign up, 29 February is a
 * real date.
 *
 * `EXPLORATORY` is the honest answer for everything else, and it is a REAL item
 * rather than a shrug: run the case, and assert only that the application
 * handled the value — no 500, no stack trace, no silently discarded field, the
 * page still works. Its title is a question ("find out what this field
 * rejects") and its value to the customer is that the answer gets written down.
 *
 * The rule that produces these is not re-implemented here. `boundaryApplicability`
 * in packages/shared/src/boundaries.ts has four arms, only one of which carries
 * an assertable expectation, and {@link dispositionFor} is a two-line read of
 * it. Generating a failing test against a constraint QAAI GUESSED is worse than
 * generating nothing, because the customer deletes the suite rather than the
 * test — so the arm that could produce a guessed rejection does not exist.
 */
export const BOUNDARY_DISPOSITIONS = [
  'ASSERT_REJECTION',
  'ASSERT_ACCEPTANCE',
  'EXPLORATORY',
] as const;
export type BoundaryDisposition = (typeof BOUNDARY_DISPOSITIONS)[number];

/**
 * Compile-time half of the parity guard, the same shape the keystone's own
 * vocabularies use. A fourth disposition cannot join the union without being
 * named here; the run-time half is the exhaustiveness test in
 * `boundaries.test.ts`, which walks this list and demands that every member is
 * actually producible.
 */
const BOUNDARY_DISPOSITION_PRESENT: Record<BoundaryDisposition, true> = {
  ASSERT_REJECTION: true,
  ASSERT_ACCEPTANCE: true,
  EXPLORATORY: true,
};

/** Derived, never hand-listed. */
export const BOUNDARY_DISPOSITION_LIST = Object.keys(
  BOUNDARY_DISPOSITION_PRESENT,
) as ReadonlyArray<BoundaryDisposition>;

/**
 * One keystone class against one field, with a value and a licence.
 *
 * Separate from {@link BoundaryCase} and not a widening of it, because the two
 * answer different questions and have different consumers. `BoundaryCase` is a
 * row in a table a reviewer approves, phrased in this file's own twenty-class
 * vocabulary, which two production callers already print. This is the full
 * twenty-seven-class partition, carrying the keystone's own `BoundaryClass`
 * names — which travel in stored plan items, so the spelling is a wire format.
 */
export interface BoundaryClassCase {
  /** Deterministic and stable: the same form gives the same ids every run. */
  readonly id: string;
  readonly formId: string;
  readonly formName: string;
  readonly field: string;
  readonly fieldLabel: string | null;
  readonly semantic: FormFieldSemantic;
  readonly klass: BoundaryClass;
  readonly disposition: BoundaryDisposition;
  /** The value to put in the field. The empty string IS the value for EMPTY. */
  readonly value: string;
  /**
   * A second value sent in the same case, or null.
   *
   * Only OFF_BY_ONE has one, and it is why the class exists: the pair either
   * side of a bound, submitted together, lets the report say WHICH SIDE the
   * comparison is wrong on instead of that something is wrong.
   */
  readonly alsoValue: string | null;
  /** The complete submission. Every other field holds a valid synthetic value. */
  readonly values: Record<string, string>;
  readonly risk: BoundaryRisk;
  /** Higher first. Risk rank, then the stakes of the field. See {@link rankClassCase}. */
  readonly rank: number;
  /**
   * The keystone's expectation for this class, verbatim.
   *
   * Carried beside `disposition` rather than folded into it so a reader can see
   * WHY the licence came out the way it did: an `EXPLORATORY` case whose
   * keystone expectation is `REJECTED` was downgraded because the constraint
   * was not declared, while one whose expectation is `UNKNOWN` is ambiguous by
   * nature. Those are different facts with different remedies — re-crawl, and
   * nothing — and a single field could not tell them apart.
   */
  readonly keystoneExpectation: KeystoneExpectation;
  /** The declared constraint value this case was derived from. Null on an unbounded probe. */
  readonly basis: string | null;
  readonly why: string;
  /** What to assert. Phrased by the disposition, never stronger than it. */
  readonly expected: string;
  /** How widely this value must not repeat. From the semantic, via the keystone. */
  readonly uniqueness: UniquenessScope;
  /** What sending it obliges the suite to clean up. UNKNOWN is a real answer. */
  readonly cleanup: CleanupObligation;
}

/** A candidate the keystone admitted and this file could not build a value for. */
export interface UnrepresentableBoundary {
  readonly field: string;
  readonly klass: BoundaryClass;
  /** Why no representative exists. Often a finding about the page in its own right. */
  readonly why: string;
}

/**
 * A constraint nobody read, named, so the gap is actionable.
 *
 * The keystone's `enumerateBoundaries` returns `unreadConstraints` as a COUNT
 * and drops the candidates, which is the right call for generation — the remedy
 * is a re-crawl and generating anything would assert a limit the page may never
 * have claimed. But a bare count is not actionable: "11 classes were
 * unreachable" tells a customer nothing, while "`maxlength` was never read on
 * Bio, Notes and Message" tells them which crawl to re-run.
 *
 * So the pairs are collected for REPORTING and never for generation. Nothing in
 * this file turns one into a case.
 */
export interface RecrawlObligation {
  readonly field: string;
  /** The attribute the crawl did not capture, spelled as the page spells it. */
  readonly constraint: string;
  /** How many classes this one unread attribute made unreachable. */
  readonly classesBlocked: number;
}

export interface BoundaryClassExpansion {
  /** Ranked, highest first. A caller taking the top N gets the best N. */
  readonly cases: readonly BoundaryClassCase[];
  /** What a scenario must arrange before a case means anything. */
  readonly preconditions: readonly BoundaryPrecondition[];
  /** The valid submission every case is a one-field perturbation of. */
  readonly happyPathValues: Record<string, string>;
  /** (field, class) pairs considered in total. The honest denominator. */
  readonly considered: number;
  /** Dropped because the class cannot apply to the field. Not a shortfall. */
  readonly inapplicable: number;
  /** Dropped because WE did not read the constraint. Our gap, counted separately. */
  readonly unreadConstraints: number;
  /** Those same gaps, named. Reporting only — never generated from. */
  readonly recrawl: readonly RecrawlObligation[];
  /** Admitted by the keystone, and no representative value could be built. */
  readonly unrepresentable: readonly UnrepresentableBoundary[];
  /** Suppressed by `limit`. Zero when no cap bit. */
  readonly omittedByCap: number;
  /** Why the cap bit, or null when it did not. Non-null exactly when the count is positive. */
  readonly capReason: string | null;
  /** Anything that makes the valid submission these cases perturb untrustworthy. */
  readonly caveats: readonly string[];
}

/**
 * The default cap. One form's expansion has to be reviewable by a person, and
 * a 40-field form times 27 classes is 1,080 items nobody will ever read.
 *
 * Higher than {@link DEFAULT_MAX_CASES} because this partition is finer: the
 * same form yields more classes, and the point of the finer partition is lost
 * if the cap throws the extra ones away.
 */
const DEFAULT_MAX_CLASS_CASES = 120;

/**
 * Expand a form into one case per APPLICABLE boundary class per field.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 *
 * Every value is a constant or comes from the seeded synthetic factory, every
 * date is derived from `options.now` (defaulting to the frozen
 * {@link SYNTHETIC_CLOCK}), and the comparator is TOTAL — risk rank, then the
 * stakes of the field, then field order as given, then class order as declared
 * in `BOUNDARY_CLASSES`. There is no `Math.random`, no `Date.now` and no
 * ambient clock anywhere below. A generator that is not reproducible produces a
 * suite nobody can debug, and it is the commonest cause of the flake this
 * product exists to eliminate.
 *
 * ── Why the keystone is asked for EVERY candidate, with no limit ───────────
 *
 * Because a candidate can still turn out to have no representative value —
 * `maxlength="6"` on an email input admits no valid address — and a cap applied
 * BEFORE that discovery buys fewer cases than it promises. So the keystone
 * enumerates everything, values are built, the ones with no representative are
 * named in {@link BoundaryClassExpansion.unrepresentable}, and the cap is
 * applied last to what survived. That also means there is exactly ONE cap in
 * the output, reported once, instead of two that a reader has to add up.
 */
export function expandBoundaryClasses(
  form: BoundaryForm,
  options: BoundaryOptions,
): BoundaryClassExpansion {
  const scope = options.scope ?? form.id;
  const now = options.now ?? SYNTHETIC_CLOCK;
  const factory = createSyntheticFactory({
    seed: options.seed,
    scope,
    ...(options.now ? { now: options.now } : {}),
  });
  const fill = fillForm(form.fields, {
    seed: options.seed,
    scope,
    ...(options.now ? { now: options.now } : {}),
  });
  const happy = fill.values;

  /*
   * The keystone decides WHICH (field, class) pairs are admissible and on what
   * terms. It is not consulted for a value and it is not second-guessed: the
   * unread-constraint rule is structural in that module, and re-deciding it
   * here would be a second copy of the rule that this file could drift from.
   */
  /*
   * Passed UNCAST on purpose. This file's `BoundaryField` is structurally
   * assignable to the keystone's, and letting the compiler check that means a
   * future divergence between the two shapes is a build error here rather than
   * a cast that keeps compiling while the keystone reads a field this file no
   * longer supplies.
   */
  const enumeration = enumerateBoundaries(form.fields);

  const built: BoundaryClassCase[] = [];
  const unrepresentable: UnrepresentableBoundary[] = [];

  for (const candidate of enumeration.candidates) {
    const field = form.fields.find((f) => f.name === candidate.field);
    /*
     * Cannot happen — the keystone enumerated over these very fields — but a
     * non-null assertion here would be a fabricated fact if it ever did, and
     * `noUncheckedIndexedAccess` is in force precisely so this is a decision.
     */
    if (field === undefined) continue;

    const representative = representativeValue(candidate.klass, field, {
      valid: happy[field.name] ?? '',
      applicability: candidate.applicability,
      now,
      token: factory.scoped(`${candidate.klass}/${field.name}`).token,
    });

    if ('why' in representative) {
      unrepresentable.push({ field: field.name, klass: candidate.klass, why: representative.why });
      continue;
    }

    built.push(
      rankClassCase({
        id: classCaseId(form, field, candidate.klass),
        formId: form.id,
        formName: form.name,
        field: field.name,
        fieldLabel: field.label ?? null,
        semantic: field.semantic,
        klass: candidate.klass,
        disposition: dispositionFor(candidate.applicability),
        value: representative.value,
        alsoValue: representative.alsoValue ?? null,
        values: { ...happy, [field.name]: representative.value },
        risk: riskOfApplicability(candidate.applicability),
        keystoneExpectation: expectationOfApplicability(candidate.applicability),
        basis:
          candidate.applicability.state === 'APPLICABLE' ? candidate.applicability.basis : null,
        why: BOUNDARY_DESCRIPTORS[candidate.klass].why,
        expected: assertionFor(candidate.klass, field, candidate.applicability),
        uniqueness: uniquenessFor(field.semantic),
        cleanup: cleanupFor(field.semantic),
      }),
    );
  }

  // Total order, stated rather than inherited. See the note in the keystone's
  // own `enumerateBoundaries` about what tie-breaks do and do not buy.
  const fieldIndex = new Map(form.fields.map((f, i) => [f.name, i]));
  const classIndex = new Map(BOUNDARY_CLASSES.map((c, i) => [c, i]));
  built.sort(
    (a, b) =>
      b.rank - a.rank ||
      (fieldIndex.get(a.field) ?? 0) - (fieldIndex.get(b.field) ?? 0) ||
      (classIndex.get(a.klass) ?? 0) - (classIndex.get(b.klass) ?? 0),
  );

  const limit = options.maxCases ?? DEFAULT_MAX_CLASS_CASES;
  const omittedByCap = Math.max(0, built.length - limit);
  const cases = omittedByCap === 0 ? built : built.slice(0, limit);
  const keptFields = new Set(cases.map((c) => c.field));

  return {
    cases,
    // A precondition for a case the cap removed is not an obligation.
    preconditions: enumeration.preconditions.filter((p) => keptFields.has(p.establishedBy)),
    happyPathValues: happy,
    considered: enumeration.considered,
    inapplicable: enumeration.inapplicable,
    unreadConstraints: enumeration.unreadConstraints,
    recrawl: recrawlObligations(form.fields),
    unrepresentable,
    omittedByCap,
    capReason:
      omittedByCap === 0
        ? null
        : `a limit of ${limit} boundary cases was applied to "${form.name}"; at least ` +
          `${omittedByCap} more APPLICABLE cases existed on this form and were not generated. ` +
          'They are the lowest-ranked by risk, which is a judgement and not a measurement — ' +
          'raise maxCases to see them.',
    caveats: classCaveats(fill),
  };
}

/**
 * The keystone's four arms collapsed onto the three things a generator can do.
 *
 * This is the whole licence, and it is deliberately this short: there is no
 * code path from an unread or undeclared constraint to `ASSERT_REJECTION`,
 * because `mayAssertRejection` is true on exactly one arm and this function has
 * no other way to reach that member.
 */
function dispositionFor(applicability: BoundaryApplicability): BoundaryDisposition {
  if (mayAssertRejection(applicability)) return 'ASSERT_REJECTION';
  if (applicability.state === 'APPLICABLE' && applicability.expected === 'ACCEPTED_NORMALISED') {
    return 'ASSERT_ACCEPTANCE';
  }
  return 'EXPLORATORY';
}

/** The keystone's expectation on an arm that carries one; UNKNOWN on the two that do not. */
function expectationOfApplicability(applicability: BoundaryApplicability): KeystoneExpectation {
  return applicability.state === 'APPLICABLE' || applicability.state === 'UNBOUNDED'
    ? applicability.expected
    : 'UNKNOWN';
}

/**
 * The risk on an arm that carries one.
 *
 * The two dropped arms never reach a built case, so the fallback is not a real
 * answer — and it is LOW rather than the descriptor's own risk on purpose: a
 * case this function could not read a risk off must sort last, not inherit a
 * CRITICAL it was never granted.
 */
function riskOfApplicability(applicability: BoundaryApplicability): BoundaryRisk {
  return applicability.state === 'APPLICABLE' || applicability.state === 'UNBOUNDED'
    ? applicability.risk
    : 'LOW';
}

/**
 * Rank, from the keystone's risk tier plus one adjustment.
 *
 * ONE adjustment, for the same reason {@link rank} above gives: the risk tier is
 * already a judgement, and multiplying judgements together produces a number
 * that looks far more considered than it is. Scaled by 10 so the single
 * field-stakes bump can never jump a whole risk tier — a LOW class on a card
 * field must not outrank a CRITICAL class on a nickname.
 */
function rankClassCase(partial: Omit<BoundaryClassCase, 'rank'>): BoundaryClassCase {
  const base = BOUNDARY_RISK_RANK[partial.risk] * 10;
  return { ...partial, rank: HIGH_STAKES.has(partial.semantic) ? base + 3 : base };
}

/** Stable across runs so a case can be referenced, suppressed, or diffed. */
function classCaseId(form: BoundaryForm, field: BoundaryField, klass: BoundaryClass): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${slug(form.id)}--${slug(field.name)}--${slug(klass)}`;
}

// ─── Representative values for the keystone's classes ────────────────────────

/**
 * The field's input type, lower-cased, defaulting to `text`.
 *
 * A local two-liner rather than an import: the keystone has a private function
 * of this name and does not export it, and a third copy of the default would be
 * a place for the three to disagree about what an absent `inputType` means.
 * `FormField` declares it required, so the fallback only ever fires for a
 * hand-written caller.
 */
function inputTypeOf(field: BoundaryField): string {
  return (field.inputType ?? 'text').toLowerCase();
}

/** Everything a representative needs that is not on the field itself. */
interface RepresentativeContext {
  /** The field's valid happy-path value, so a case differs in ONE respect. */
  readonly valid: string;
  readonly applicability: BoundaryApplicability;
  /** ISO instant every date is derived from. Injected; never an ambient clock. */
  readonly now: string;
  /** Deterministic per (seed, scope, class, field). Traces a stray row to a run. */
  readonly token: string;
}

/** A value, or the reason no representative of this class exists for this field. */
type Representative =
  { readonly value: string; readonly alsoValue?: string } | { readonly why: string };

/**
 * The string this class actually sends, in the field's own format.
 *
 * ── The length rule that keeps a case attributable ─────────────────────────
 *
 * Several of these values are longer than a short field allows, and a value
 * that violates a DECLARED maxlength as well as its own class has TWO possible
 * causes — which is the one property this whole file exists to prevent. So
 * {@link withinDeclaredLength} refuses such a case rather than sending it, and
 * the refusal is reported: `maxlength="4"` on a field means HTML_META's
 * `<b>qaai</b>` is not expressible there, and that is a fact about the page
 * worth printing, not a case to fudge.
 *
 * ── Why the dates come from a constant and not from today ──────────────────
 *
 * A leap day is 29 February whatever today is. FUTURE_DATE and PAST_DATE are a
 * year either side of `ctx.now`, which defaults to the frozen clock — so the
 * same seed gives the same value forever, and a caller who would rather have
 * fresh dates passes `now` and accepts that their values move.
 */
function representativeValue(
  klass: BoundaryClass,
  field: BoundaryField,
  ctx: RepresentativeContext,
): Representative {
  switch (klass) {
    case 'EMPTY':
      return { value: '' };
    case 'WHITESPACE_ONLY':
      return { value: '   ' };

    case 'TOO_SHORT': {
      const min = field.minLength;
      if (typeof min !== 'number' || min < 1) {
        return { why: 'no declared minlength to fall one character short of' };
      }
      const shorter = exactLength(ctx.valid, min - 1, field);
      return shorter === null
        ? {
            why: `minlength=${min} leaves no shorter value that is still a plausible ${field.semantic}, so a rejection could not be attributed to length`,
          }
        : { value: shorter };
    }

    case 'TOO_LONG': {
      /*
       * Two different cases behind one class, decided by the keystone's arm.
       *
       * APPLICABLE means a maxlength was READ, so the representative is exactly
       * one character over it — the off-by-one, which is the whole value of the
       * class. UNBOUNDED means the page declares none, so the representative is
       * the unbounded probe: ten thousand characters, looking for the column
       * limit nobody considered. They are not the same test and a single value
       * could not serve both.
       */
      if (ctx.applicability.state === 'UNBOUNDED') return { value: 'A'.repeat(10_000) };
      const max = field.maxLength;
      if (typeof max !== 'number' || max < 1) {
        return { why: 'no declared maxlength to exceed by one character' };
      }
      const atMax = exactLength(ctx.valid, max, field);
      return atMax === null
        ? {
            why: `maxlength=${max} is too small to hold any valid ${field.semantic} value, which is itself worth looking at — no case here could fail for length alone`,
          }
        : { value: `${atMax}x` };
    }

    case 'AT_MIN':
      return boundValue(field, 'min', 'at');
    case 'BELOW_MIN':
      return boundValue(field, 'min', 'past');
    case 'AT_MAX':
      return boundValue(field, 'max', 'at');
    case 'ABOVE_MAX':
      return boundValue(field, 'max', 'past');

    case 'OFF_BY_ONE': {
      /*
       * The ONE class that sends two values, and the reason it is worth having
       * beside AT_MAX and ABOVE_MAX: submitted as a pair, the report can say
       * WHICH SIDE the comparison is wrong on. "max accepted, max+1 accepted"
       * is an exclusive-where-inclusive-was-meant bug; "max refused, max+1
       * refused" is the mirror. Either alone just says something is wrong.
       */
      const at = boundValue(field, 'max', 'at');
      const past = boundValue(field, 'max', 'past');
      if ('why' in at) return at;
      if ('why' in past) return past;
      return { value: at.value, alsoValue: past.value };
    }

    case 'STEP_MISALIGNED': {
      const bounds = boundsOf(field);
      return bounds?.stepMisaligned == null
        ? { why: 'the declared step admits no value between two legal steps that is also in range' }
        : { value: bounds.stepMisaligned };
    }

    case 'WRONG_TYPE': {
      const wrong = wrongTypeValue(field);
      return wrong === null
        ? { why: `a "${field.semantic}" field accepts free text, so no value is the wrong type` }
        : { value: wrong.value };
    }

    case 'PATTERN_VIOLATION': {
      const violating = patternViolatingValue(field);
      return violating === null
        ? {
            why: `every candidate value satisfies pattern="${field.pattern}", so no representative could be built — a pattern that accepts everything is worth a second look`,
          }
        : { value: violating };
    }

    case 'CHECKSUM_INVALID': {
      const success = cardForOutcome('success');
      const base = (success?.value ?? ctx.valid).replace(/\s/g, '');
      return base === ''
        ? { why: 'no card number to break the checksum on' }
        : { value: luhnBreak(base) };
    }

    case 'FUTURE_DATE':
      return shiftedDate(field, ctx, 365);
    case 'PAST_DATE':
      return shiftedDate(field, ctx, -365);
    case 'LEAP_DAY':
      /*
       * A leap day INSIDE the declared range, and that is not pedantry: it was
       * a false ACCEPTANCE assertion.
       *
       * This class expects the value through — 29 February is a real date, and
       * hand-rolled date arithmetic that adds a year to it produces 1 March or
       * throws. But a fixed 2024-02-29 sent at a field declaring
       * `min="2026-01-01"` must be REFUSED by a correct application, for the
       * range. So the assertion was that a correct application is broken, which
       * is the worst way for this file to be wrong and the reason
       * {@link leapDayInRange} scans for one that fits instead.
       */
      return leapDayInRange(field, ctx);

    case 'DST_BOUNDARY': {
      /*
       * A wall clock inside a spring-forward gap: 02:30 on the second Sunday in
       * March does not exist in US Eastern or Pacific time.
       *
       * The timezone limitation is stated in the assertion rather than hidden,
       * because nothing here knows the application's — which is exactly why the
       * keystone's expectation for this class is UNKNOWN and the item is
       * EXPLORATORY. A case that asserted a rejection would be asserting a
       * timezone QAAI guessed.
       *
       * A `time` input carries no date, so the range cannot exclude it. A
       * `datetime-local` can, and an out-of-range instant would test the range
       * rather than the gap — so it is refused for the same reason the leap day
       * is, even though this class asserts nothing.
       */
      if (inputTypeOf(field) === 'time') return { value: '02:30' };
      const gap = '2026-03-08T02:30';
      return inDeclaredRange(field, `${gap}:00.000Z`)
        ? { value: gap }
        : {
            why: `the spring-forward gap this file knows (${gap}) falls outside the declared range min="${field.min}" max="${field.max}", so the case would test the range rather than the discontinuity`,
          };
    }

    /*
     * ─── THE FIVE CLASSES THAT EXPECT THE VALUE THROUGH ────────────────────
     *
     * All five are gated on {@link ACCEPTS_ANY_TEXT}, and the gate is not
     * cosmetic — it is this file's THIRD encounter with the same defect.
     *
     * The keystone admits these on any field its `isTextual` accepts, which
     * includes a `credit_card` rendered as `<input type="text">` — and its
     * descriptor for SQL_META expects ACCEPTED_NORMALISED at CRITICAL risk. So
     * an ungated expansion put "a card-number field must ACCEPT O'Brien" at
     * the TOP of the ranking: a generated test that fails against a CORRECT
     * payment form, with the bug report landing on the application team.
     * `boundsOf` calls that "the worst way for this file to be wrong".
     *
     * The gate is POSITIVE, which is the safe direction: a fixed-format field
     * gets NO case here rather than one expecting rejection, because "a postal
     * code must REFUSE an apostrophe" is not something this file knows either.
     * WRONG_TYPE already asks a fixed-format field the malformed-value
     * question with an expectation that can be defended.
     *
     * NULL_BYTE below is deliberately NOT gated. Its expectation is REJECTED
     * on every field — a NUL truncates a C string, so a value containing one
     * may be two different values to two layers of the stack — and that is as
     * true of a card number as of a biography.
     */
    case 'UNICODE_COMBINING':
      // "José" in NFD: the accent is its own codepoint, so the string is five
      // codepoints and four graphemes. Short enough to clear most maxlengths.
      return openFormatOnly(field, klass, () =>
        withinDeclaredLength(field, 'Jose\u0301', 'a name in decomposed form'),
      );
    case 'RTL_MARK':
      return openFormatOnly(field, klass, () =>
        withinDeclaredLength(field, 'qa\u202Eai', 'a bidirectional override'),
      );
    case 'EMOJI_ASTRAL':
      // U+1F9EC: two UTF-16 units, four UTF-8 bytes. One grapheme, and the
      // value that finds a length check counting the wrong unit.
      return openFormatOnly(field, klass, () =>
        withinDeclaredLength(field, 'qa\u{1F9EC}ai', 'an astral-plane codepoint'),
      );
    case 'SQL_META':
      // The keystone's own example, and the assertion is ACCEPTANCE: O'Brien
      // must be able to sign up.
      return openFormatOnly(field, klass, () =>
        withinDeclaredLength(field, "O'Brien", 'an apostrophe in a surname'),
      );
    case 'HTML_META':
      return openFormatOnly(field, klass, () =>
        withinDeclaredLength(field, '<b>qaai</b>', 'angle brackets that must survive as text'),
      );
    case 'NULL_BYTE':
      return withinDeclaredLength(field, 'qa\u0000ai', 'an embedded NUL');

    case 'LEADING_ZERO': {
      /*
       * 02134 for a postal code — the canonical example, and a TEXT field in
       * every application that gets it right. For anything else the valid value
       * gets a zero in front, so the case differs from the happy path in
       * exactly one respect.
       */
      if (field.semantic === 'postal_code')
        return withinDeclaredLength(field, '02134', 'a load-bearing leading zero');
      const digits = ctx.valid.replace(/\D/g, '');
      return digits === ''
        ? {
            why: 'the valid value holds no digits, so there is no number for a leading zero to be lost from',
          }
        : withinDeclaredLength(field, `0${digits}`, 'a load-bearing leading zero');
    }

    case 'NEGATIVE_ZERO':
      return { value: '-0' };
    case 'SCIENTIFIC_NOTATION':
      return { value: '1e9' };

    case 'DUPLICATE_OF_EXISTING':
      /*
       * The SAME value, deliberately. The precondition the keystone attaches to
       * this class says a record already holding it must exist, and the only
       * value guaranteed to be in that record is the one the scenario put
       * there. Generating a fresh value here would test the happy path and
       * report a negative-case pass — the exact defect the precondition exists
       * to prevent.
       */
      return ctx.valid === ''
        ? { why: 'no valid value to duplicate, so nothing could have been created to collide with' }
        : { value: ctx.valid };
  }
}

/**
 * One end of a declared numeric or temporal bound, at it or one step past it.
 *
 * Delegates to {@link boundsOf}, which already handles the date formats and
 * the decimal-place arithmetic, so there is one implementation of "one step
 * past max" rather than two that could disagree by a step.
 */
function boundValue(
  field: BoundaryField,
  end: 'min' | 'max',
  where: 'at' | 'past',
): Representative {
  const bounds = boundsOf(field);
  if (bounds === null) return { why: 'the page declares no min, max or step on this field' };
  /*
   * The two ends are read separately rather than through a narrowed union: the
   * `min` arm carries `under` and the `max` arm carries `over`, and a union of
   * the two has neither property. Spelling both out keeps the names the shape
   * they describe.
   */
  const side = end === 'min' ? bounds.min : bounds.max;
  if (side === null) return { why: `the page declares no ${end} on this field` };
  if (where === 'at') return { value: side.at };
  const past = end === 'min' ? (bounds.min?.under ?? null) : (bounds.max?.over ?? null);
  return past == null
    ? {
        why: `the declared ${end}="${end === 'min' ? field.min : field.max}" could not be stepped past — it is not a number or a date this file can shift, so a rejection could not be attributed to the bound`,
      }
    : { value: past };
}

/**
 * A date on the right side of the injected clock, kept INSIDE every declared
 * bound.
 *
 * ── Why the clamp is not optional, and why it must be symmetric ────────────
 *
 * Found by inspection on a booking form declaring `min="2026-01-01"` and
 * `max="2026-12-31"`: a naive year ahead of the frozen clock lands on
 * 2027-06-15, which is a future date AND out of the declared range. The
 * application refuses it for the range, the suite records "a future date is
 * refused", and whether a booking can be made for next week was never asked.
 * Two causes, and the case meant to isolate one of them isolates neither.
 *
 * The first fix clamped FUTURE_DATE against `max` only — and left PAST_DATE
 * with the identical bug the other way up: with the clock past the declared
 * window, "a year ago" is still beyond `max`. So the window is computed from
 * BOTH bounds and the clock, once, for both directions.
 *
 * When no date satisfies all three — a `max` already behind the clock means "a
 * date after today" is not expressible on this field at all — the honest output
 * is to say so. That is a fact about the page, not a case to fudge.
 */
function shiftedDate(
  field: BoundaryField,
  ctx: RepresentativeContext,
  days: number,
): Representative {
  const base = new Date(ctx.now);
  if (Number.isNaN(base.getTime())) {
    return {
      why: `the instant "${ctx.now}" is not a date, so no shifted date could be derived from it`,
    };
  }

  const forward = days > 0;
  const declared = (raw: string | null | undefined): number | null => {
    if (raw == null || raw === '') return null;
    // A `month` input's min/max is "2026-03"; `new Date` reads that as UTC
    // midnight on the 1st, which is the same convention `boundsOf` uses.
    const parsed = new Date(/^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  };
  const min = declared(field.min);
  const max = declared(field.max);

  /*
   * The window a legal value of this class must land in. For a future date:
   * strictly after the clock, at or after any declared min, at or before any
   * declared max. For a past date, the mirror.
   */
  const low = forward ? Math.max(base.getTime(), min ?? base.getTime()) : (min ?? -Infinity);
  const high = forward ? (max ?? Infinity) : Math.min(base.getTime(), max ?? base.getTime());

  if (!(low < high)) {
    const blocking = forward ? (max === null ? 'min' : 'max') : min === null ? 'max' : 'min';
    return {
      why:
        `the page declares ${blocking}="${blocking === 'min' ? field.min : field.max}", and no ` +
        `${forward ? 'future' : 'past'} date relative to ${ctx.now} also satisfies it — so this ` +
        `class is not expressible on this field, and sending a date outside the declared range ` +
        `would be an out-of-range case wearing this class's name`,
    };
  }

  const target = base.getTime() + days * 86_400_000;
  const inWindow = target > low && target < high;
  /*
   * The midpoint when the natural shift falls outside the window: strictly
   * inside every declared bound and strictly on the right side of the clock,
   * which is exactly what the class needs and nothing more.
   */
  const chosen = inWindow
    ? target
    : Number.isFinite(low) && Number.isFinite(high)
      ? low + (high - low) / 2
      : target;

  return { value: formatDate(new Date(chosen), inputTypeOf(field)) };
}

/**
 * Is this instant inside everything the page declares about the field?
 *
 * Shared by the two classes that send a FIXED date — a leap day and a DST gap —
 * because a fixed date is the one kind this file cannot clamp: moving it would
 * stop it being the thing under test.
 *
 * An undeclared or unparseable bound constrains nothing, which is the correct
 * reading: `boundsOf` treats the same values the same way, so a date accepted
 * here is one the bound-derived classes would also have accepted.
 */
function inDeclaredRange(field: BoundaryField, iso: string): boolean {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return false;
  for (const [raw, side] of [
    [field.min, 'min'],
    [field.max, 'max'],
  ] as const) {
    if (raw == null || raw === '') continue;
    const bound = new Date(/^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw).getTime();
    if (Number.isNaN(bound)) continue;
    if (side === 'min' ? at < bound : at > bound) return false;
  }
  return true;
}

/**
 * 29 February, in a year the declared range admits.
 *
 * ── Why 2024 is tried first, and why the rest are derived ──────────────────
 *
 * 2024 is the anchor so that a field with no declared range gets the SAME value
 * the form path's `boundary-date` case sends — two different leap days for one
 * form would read as two different tests of one thing. When a range excludes
 * it, the remaining candidates are derived from the INJECTED clock rather than
 * hard-coded, so the scan still works in 2040: a hard-coded list is a list that
 * expires, and the failure mode is this class silently vanishing from every
 * expansion.
 *
 * The window is ±8 years, which contains at least two leap years on either
 * side. A range narrower than that containing no 29 February is reported rather
 * than widened — "this field cannot hold a leap day" is a real answer, and
 * widening the scan until something fits would eventually find one decades
 * away, which no application would accept for an unrelated reason.
 */
function leapDayInRange(field: BoundaryField, ctx: RepresentativeContext): Representative {
  const reference = new Date(ctx.now);
  const anchorYear = Number.isNaN(reference.getTime()) ? 2024 : reference.getUTCFullYear();
  const isLeap = (year: number): boolean =>
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

  const candidates = [2024];
  for (let year = anchorYear - 8; year <= anchorYear + 8; year += 1) {
    if (isLeap(year) && !candidates.includes(year)) candidates.push(year);
  }

  for (const year of candidates) {
    const iso = `${year}-02-29T12:00:00.000Z`;
    if (inDeclaredRange(field, iso))
      return { value: formatDate(new Date(iso), inputTypeOf(field)) };
  }

  return {
    why: `no 29 February within eight years of ${ctx.now} satisfies the declared range min="${field.min}" max="${field.max}", so a leap day is not expressible on this field — sending one anyway would test the range rather than the date arithmetic`,
  };
}

/**
 * A text-robustness value, refused when a DECLARED maxlength would reject it
 * for length instead of for the thing under test.
 *
 * THE DEFECT THIS PREVENTS: a case with two possible causes. An eleven-
 * character `<b>qaai</b>` sent at a `maxlength="6"` field is refused, the suite
 * records "HTML metacharacters are rejected", and the application's escaping is
 * never actually tested. Refusing the case and NAMING the reason is the honest
 * output — and `maxlength="6"` on a free-text field is itself worth a look.
 *
 * It checks only maxLength, and only when a value was READ. An unread
 * maxlength cannot refuse anything, and a minlength is not a reason to refuse:
 * every value here is a positive-length string, and padding one to reach a
 * minimum would change the thing under test.
 */
function withinDeclaredLength(field: BoundaryField, value: string, what: string): Representative {
  const max = field.maxLength;
  if (typeof max === 'number' && value.length > max) {
    return {
      why: `${what} needs ${value.length} characters and the page declares maxlength=${max}, so the case would be refused for LENGTH rather than for the thing under test — two causes, and an unattributable failure gets deleted`,
    };
  }
  return { value };
}

/**
 * A text-robustness case, but only on a field whose format is open.
 *
 * Takes the value as a THUNK so the refusal short-circuits before any value is
 * built — which keeps the two reasons a case can be absent DISTINCT in the
 * output. "this field's format is fixed, so no expectation is defensible" is a
 * different fact from "the declared maxlength is too small to hold the value",
 * they lead to different places, and both land in
 * {@link BoundaryClassExpansion.unrepresentable} with their own sentence rather
 * than behind one shared count.
 */
function openFormatOnly(
  field: BoundaryField,
  klass: BoundaryClass,
  build: () => Representative,
): Representative {
  if (ACCEPTS_ANY_TEXT.has(field.semantic)) return build();
  return {
    why:
      `a "${field.semantic}" value has a fixed format, so neither "${klass} must round-trip" nor ` +
      `"${klass} must be refused" is an expectation this file can defend — asserting acceptance ` +
      'would fail against a CORRECT application, and WRONG_TYPE already asks this field the ' +
      'malformed-value question with an expectation that can be defended',
  };
}

/** The sentence a generator asserts, never stronger than the disposition allows. */
function assertionFor(
  klass: BoundaryClass,
  field: BoundaryField,
  applicability: BoundaryApplicability,
): string {
  const label = field.label ?? field.name;
  const descriptor = BOUNDARY_DESCRIPTORS[klass];
  switch (dispositionFor(applicability)) {
    case 'ASSERT_REJECTION':
      return (
        `Refused, with a message that names "${label}"${
          field.validationMessage
            ? ` — ideally the page's own words: "${field.validationMessage}"`
            : ''
        }. Nothing is written: re-reading afterwards shows no new record. The application DECLARED ` +
        `\`${descriptor.constraint}\`${
          applicability.state === 'APPLICABLE' ? ` as ${applicability.basis}` : ''
        }, which is what entitles this test to demand an error.`
      );
    case 'ASSERT_ACCEPTANCE':
      return (
        `ACCEPTED, and the value comes back out of storage byte for byte — through the API, and ` +
        `into anything the value is rendered into, where it must appear as TEXT and never as ` +
        `markup or SQL. A rejection here is the defect: ${descriptor.why}.`
      );
    case 'EXPLORATORY':
      /*
       * The weakest assertion in the file, and the one that must never be
       * phrased as a rejection. The reason is quoted from the keystone's own
       * arm, including its remedy, rather than paraphrased — two wordings of one
       * fact is how one of them drifts.
       */
      return (
        `DO NOT ASSERT A REJECTION. Assert only that the application HANDLED the value: no 500, no ` +
        `stack trace, no database error reaching the user, the whole value either stored or ` +
        `refused rather than silently truncated, and the page still works. Then RECORD what it ` +
        `actually did, so the next run can assert it. ${
          applicability.state === 'UNBOUNDED' || applicability.state === 'CONSTRAINT_UNREAD'
            ? applicability.reason
            : `Nothing the page declares settles what should happen: ${descriptor.why}.`
        }`
      );
  }
}

/**
 * The constraints no crawl captured, grouped per field, for REPORTING.
 *
 * Derived by asking `boundaryApplicability` — the same function the generation
 * path asks — rather than by re-deriving which classes need which attribute.
 * One rule, read twice, instead of two rules that can disagree.
 *
 * The test that keeps it honest is `the parts sum to the whole`: this function's
 * `classesBlocked` must total the keystone's own `unreadConstraints`. If it ever
 * does not, one of the two counts is wrong and a customer is reading a number
 * nobody can reproduce.
 */
function recrawlObligations(fields: readonly BoundaryField[]): RecrawlObligation[] {
  const blocked = new Map<string, RecrawlObligation>();
  for (const field of fields) {
    for (const klass of BOUNDARY_CLASSES) {
      const applicability = boundaryApplicability(klass, field);
      if (applicability.state !== 'CONSTRAINT_UNREAD') continue;
      const key = `${field.name}\u0000${applicability.constraint}`;
      const existing = blocked.get(key);
      blocked.set(
        key,
        existing === undefined
          ? { field: field.name, constraint: applicability.constraint, classesBlocked: 1 }
          : { ...existing, classesBlocked: existing.classesBlocked + 1 },
      );
    }
  }
  return [...blocked.values()];
}

/**
 * The caveat that outranks every other, for the keystone path.
 *
 * Same argument as the one in {@link expandBoundaries}: each case submits the
 * WHOLE form with one field perturbed, so a field the factory could not fill
 * validly means every case carries two bad values and no failure can be
 * attributed to the field under test — the one property this file guarantees.
 */
function classCaveats(fill: ReturnType<typeof fillForm>): string[] {
  const poisoned = fill.fields.filter((f) => f.unsatisfiable.length > 0);
  if (poisoned.length === 0) return fill.notes;
  return [
    `READ THIS FIRST: no valid value could be produced for ${poisoned
      .map((f) => `"${f.field}" (${f.unsatisfiable.join(', ')})`)
      .join(
        ', ',
      )}. Every case below submits the whole form, so each one carries that known-bad value as well as its own — which means a rejection cannot be attributed to the field under test until this is fixed.`,
    ...fill.notes,
  ];
}

// ─── API negatives, derived from the declared schema ─────────────────────────

/**
 * The negative classes a DECLARED schema makes free.
 *
 * ── What was missing, precisely ────────────────────────────────────────────
 *
 * `boundaryEdges` in packages/shared/src/api-surface.ts already owns the
 * arithmetic over a declared bound — minimum, maximum, minLength, maxLength,
 * enum membership and the omission of a required parameter — and it is called
 * below rather than re-implemented, because an off-by-one in that arithmetic
 * produces a test that passes against a buggy application and fails against a
 * correct one. What nothing derived was everything the arithmetic cannot see:
 * a type violation, a declared `format`, an array's item bounds, a nesting
 * depth, an undeclared property, a null where none is allowed, and the whole
 * body schema below its top level — `bodyBounds` there reads only top-level
 * properties and records `NESTED_SHAPE_NOT_DESCENDED` for the rest.
 *
 * The names travel in stored plan items, so a spelling here is a wire format.
 */
export const API_NEGATIVE_CLASSES = [
  // From the declared bounds. Delegated to `boundaryEdges`.
  'REQUIRED_OMITTED',
  'BELOW_MINIMUM',
  'AT_MINIMUM',
  'AT_MAXIMUM',
  'ABOVE_MAXIMUM',
  'BELOW_MIN_LENGTH',
  'AT_MAX_LENGTH',
  'ABOVE_MAX_LENGTH',
  'IN_ENUM',
  'OUTSIDE_ENUM',
  // From the declared shape. New here.
  'TYPE_VIOLATION',
  'FORMAT_VIOLATION',
  'PATTERN_VIOLATION',
  'NULL_FOR_NON_NULLABLE',
  'ARRAY_BELOW_MIN_ITEMS',
  'ARRAY_ABOVE_MAX_ITEMS',
  'ADDITIONAL_PROPERTY',
  'NESTING_DEPTH',
] as const;
export type ApiNegativeClass = (typeof API_NEGATIVE_CLASSES)[number];

/** Compile-time half of the parity guard. A nineteenth class must be named here. */
const API_NEGATIVE_CLASS_PRESENT: Record<ApiNegativeClass, true> = {
  REQUIRED_OMITTED: true,
  BELOW_MINIMUM: true,
  AT_MINIMUM: true,
  AT_MAXIMUM: true,
  ABOVE_MAXIMUM: true,
  BELOW_MIN_LENGTH: true,
  AT_MAX_LENGTH: true,
  ABOVE_MAX_LENGTH: true,
  IN_ENUM: true,
  OUTSIDE_ENUM: true,
  TYPE_VIOLATION: true,
  FORMAT_VIOLATION: true,
  PATTERN_VIOLATION: true,
  NULL_FOR_NON_NULLABLE: true,
  ARRAY_BELOW_MIN_ITEMS: true,
  ARRAY_ABOVE_MAX_ITEMS: true,
  ADDITIONAL_PROPERTY: true,
  NESTING_DEPTH: true,
};

/** Derived, never hand-listed. */
export const API_NEGATIVE_CLASS_LIST = Object.keys(
  API_NEGATIVE_CLASS_PRESENT,
) as ReadonlyArray<ApiNegativeClass>;

/**
 * Why a case this file could have written was NOT written.
 *
 * A closed vocabulary because each one has a different remedy and the report
 * groups by it — and because "we refused to do this, here is why" must not be
 * recorded the same way as "there was nothing here". A REFUSED check that reads
 * as a pass is the lie that matters most in this section: the customer believes
 * their mutating endpoints were probed when nothing touched them.
 */
export const API_REFUSAL_REASONS = [
  /**
   * The verb could change the customer's data and the case is not a declared
   * rejection, so sending it might create or destroy a record.
   */
  'UNSAFE_VERB_UNDECLARED_OUTCOME',
  /** The verb could change data and the customer's policy does not allow it. */
  'UNSAFE_VERB_BY_POLICY',
  /** A cap WE applied. Counted, with the number that was hidden. */
  'CAP_APPLIED',
] as const;
export type ApiRefusalReason = (typeof API_REFUSAL_REASONS)[number];

/** Compile-time half of the parity guard. */
const API_REFUSAL_REASON_PRESENT: Record<ApiRefusalReason, true> = {
  UNSAFE_VERB_UNDECLARED_OUTCOME: true,
  UNSAFE_VERB_BY_POLICY: true,
  CAP_APPLIED: true,
};

/** Derived, never hand-listed. */
export const API_REFUSAL_REASON_LIST = Object.keys(
  API_REFUSAL_REASON_PRESENT,
) as ReadonlyArray<ApiRefusalReason>;

/**
 * The operation, as this file needs to see it.
 *
 * Structurally satisfied by `ApiOperationInput` from
 * packages/shared/src/api-surface.ts, so an operation read back out of the
 * `ApiOperation` table passes straight in and no adapter exists to drift. It is
 * declared here as a NARROW INTERFACE rather than imported as that type because
 * this module must be testable with a literal — there is no HTTP client, no
 * document fetch and no Prisma delegate anywhere below, which is the property
 * 629 lines of untested crawler cost this repo.
 */
export interface ApiOperationDeclaration {
  readonly method: string;
  readonly pathTemplate: string;
  readonly operationId?: string | null;
  /** Path, query, header, cookie and TOP-LEVEL body bounds, as imported. */
  readonly parameters?: readonly ApiParameterBound[];
  /** The request body's declared JSON Schema, whole and opaque. Descended here. */
  readonly requestShape?: unknown;
  /** The declared responses, keyed by status code. Read for a declared rejection. */
  readonly responseShapes?: unknown;
}

/**
 * What the CUSTOMER permits against their own environment.
 *
 * On a row, not in `process.env`, following the AuthProfile / Integration
 * pattern already in the schema: a decision about whether QAAI may POST a
 * malformed body at a customer's API is the customer's to make, it differs per
 * environment, and an environment variable makes it one global answer that
 * nobody can audit per project.
 */
export interface ApiNegativePolicy {
  /**
   * May a negative case use a verb that could change data, when the document
   * does NOT declare the request will be rejected?
   *
   * Defaults to false, and the default is the whole safety position of this
   * section. See {@link admitApiCase}.
   */
  readonly allowUnsafeVerbs?: boolean;
  /** Hard cap on cases per operation. Reported as a count and a reason when it bites. */
  readonly maxCases?: number;
}

/**
 * How to turn a case's `value` into an actual request.
 *
 * THE DEFECT THIS PREVENTS: a number that means two things. `boundaryEdges` in
 * packages/shared/src/api-surface.ts documents the same ambiguity in a comment —
 * "A string length for the length edges, a number, or a member" — and a comment
 * is not enough, because the consumer is a code generator and it reads fields.
 * An `ARRAY_BELOW_MIN_ITEMS` case whose value is `0` must become `[]`; sent as
 * the literal `0` it is a TYPE_VIOLATION wearing the wrong class name, and it
 * will be rejected, and the suite will record the array bound as covered.
 *
 * `OMIT` and `JSON_NULL` are the same distinction on the other axis: omitting a
 * property and sending `null` for it are two different requests, and plenty of
 * APIs treat them differently on purpose.
 */
export const API_VALUE_MEANINGS = [
  /** Send the value as it stands. */
  'LITERAL',
  /** Send a string of this many characters. */
  'STRING_LENGTH',
  /** Send an array holding this many items. */
  'ITEM_COUNT',
  /** Send the request with this field ABSENT. */
  'OMIT',
  /** Send JSON `null` for this field. Not the same request as OMIT. */
  'JSON_NULL',
  /** Add a property of this NAME that the schema does not declare. */
  'PROPERTY_NAME',
  /** Nest the body this many levels deep. */
  'NESTING_DEPTH',
] as const;
export type ApiValueMeaning = (typeof API_VALUE_MEANINGS)[number];

/** Compile-time half of the parity guard. An eighth meaning must be named here. */
const API_VALUE_MEANING_PRESENT: Record<ApiValueMeaning, true> = {
  LITERAL: true,
  STRING_LENGTH: true,
  ITEM_COUNT: true,
  OMIT: true,
  JSON_NULL: true,
  PROPERTY_NAME: true,
  NESTING_DEPTH: true,
};

/** Derived, never hand-listed. */
export const API_VALUE_MEANING_LIST = Object.keys(
  API_VALUE_MEANING_PRESENT,
) as ReadonlyArray<ApiValueMeaning>;

/**
 * What each class's value means. A `Record` keyed on the class union, so a
 * nineteenth class cannot be generated without deciding how its value is sent —
 * rather than defaulting to LITERAL, which is the answer that silently sends
 * the wrong request.
 */
const API_VALUE_MEANING: Record<ApiNegativeClass, ApiValueMeaning> = {
  REQUIRED_OMITTED: 'OMIT',
  BELOW_MINIMUM: 'LITERAL',
  AT_MINIMUM: 'LITERAL',
  AT_MAXIMUM: 'LITERAL',
  ABOVE_MAXIMUM: 'LITERAL',
  BELOW_MIN_LENGTH: 'STRING_LENGTH',
  AT_MAX_LENGTH: 'STRING_LENGTH',
  ABOVE_MAX_LENGTH: 'STRING_LENGTH',
  IN_ENUM: 'LITERAL',
  OUTSIDE_ENUM: 'LITERAL',
  TYPE_VIOLATION: 'LITERAL',
  FORMAT_VIOLATION: 'LITERAL',
  PATTERN_VIOLATION: 'LITERAL',
  NULL_FOR_NON_NULLABLE: 'JSON_NULL',
  ARRAY_BELOW_MIN_ITEMS: 'ITEM_COUNT',
  ARRAY_ABOVE_MAX_ITEMS: 'ITEM_COUNT',
  ADDITIONAL_PROPERTY: 'PROPERTY_NAME',
  NESTING_DEPTH: 'NESTING_DEPTH',
};

export interface ApiBoundaryCase {
  /** Deterministic and stable: the same document gives the same ids every run. */
  readonly id: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly klass: ApiNegativeClass;
  /** JSON Pointer into the request body, or the parameter name for a non-body one. */
  readonly target: string;
  readonly location: 'PATH' | 'QUERY' | 'HEADER' | 'COOKIE' | 'BODY';
  /**
   * The datum, whose MEANING is {@link ApiBoundaryCase.valueMeaning} and is not
   * guessable from its type. `0` is a literal zero for BELOW_MINIMUM and an
   * array of no items for ARRAY_BELOW_MIN_ITEMS; `null` is "omit the field"
   * for REQUIRED_OMITTED and JSON `null` for NULL_FOR_NON_NULLABLE. A generator
   * that read this field alone would send the wrong request for four of the
   * eighteen classes, and three of those would then pass.
   */
  readonly value: string | number | boolean | null;
  /** How to turn {@link ApiBoundaryCase.value} into a request. Total, by construction. */
  readonly valueMeaning: ApiValueMeaning;
  readonly disposition: BoundaryDisposition;
  /**
   * The status the document declares for a rejected request, or null.
   *
   * Null is why a case is EXPLORATORY rather than asserted: a document that
   * declares only `200` entitles a test to assert that 0 is out of range but
   * not WHICH error it comes back as, and asserting 400 against an API that
   * correctly answers 422 is a failure QAAI caused.
   */
  readonly declaredRejectionStatus: string | null;
  /** The clause of the declaration that justifies the expectation. */
  readonly reason: string;
  readonly expected: string;
}

/** A case this file declined to emit, with the reason, so it is never a silent pass. */
export interface ApiRefusedCase {
  readonly klass: ApiNegativeClass;
  readonly target: string;
  readonly reason: ApiRefusalReason;
  readonly detail: string;
}

export interface ApiBoundaryExpansion {
  readonly cases: readonly ApiBoundaryCase[];
  /**
   * Cases that WERE derivable and were not emitted, each with its reason.
   *
   * The most important field in this interface. A cross-tenant or malformed
   * probe that would mutate another record must be refused AND RECORDED AS
   * REFUSED, so the report says "this check was not performed and why" rather
   * than silently reading as clean.
   */
  readonly refused: readonly ApiRefusedCase[];
  /** Every (target, class) pair considered. The honest denominator. */
  readonly considered: number;
  /** Suppressed by the policy's cap. Zero when no cap bit. */
  readonly omittedByCap: number;
  /** Non-null exactly when `omittedByCap > 0`. */
  readonly capReason: string | null;
  /**
   * What this reader did not read, named.
   *
   * `allOf`/`oneOf`/`anyOf` compositions, `$ref`s this walk does not resolve,
   * and the depth at which it stopped. Our gap, reported as ours: a composed
   * schema whose bounds are absent must not read as an API that declares no
   * limits, which is the most flattering possible wrong answer.
   */
  readonly notRead: readonly string[];
}

/** How deep the body walk goes. Reported in `notRead` when it bites. */
const MAX_SCHEMA_DEPTH = 6;
/** Default per-operation cap. A 60-property body yields far more than a reviewer reads. */
const DEFAULT_MAX_API_CASES = 80;

/**
 * Derive every negative and edge case the DECLARED schema entitles us to.
 *
 * ── The safety position, which is the central judgement in this function ───
 *
 * A negative API case is a SAFE-VERB, READ-ONLY operation by default. `GET`,
 * `HEAD` and `OPTIONS` — the list `isSafeProbeMethod` owns in
 * packages/shared/src/principals.ts, so there is one definition of "safe verb"
 * in the repo rather than two that can disagree about PATCH.
 *
 * On an unsafe verb, the test is whether the DOCUMENT SAYS THE REQUEST IS
 * REFUSED. It is not a technicality:
 *
 *   · A `POST` whose body omits a required property, at an operation that
 *     declares a 400, is a request the API itself promises not to act on. If it
 *     DOES act on it, that write is the defect the test exists to report — and
 *     the test is admitted, because the declaration is the customer's own
 *     statement that nothing will be created.
 *   · The same `POST` at an operation that declares no error response at all is
 *     REFUSED. Nothing says the request will be rejected, so sending it may
 *     create a record in the customer's database, and a probe that mutates data
 *     is not a probe. `UNSAFE_VERB_UNDECLARED_OUTCOME` is recorded, the report
 *     says the check was not performed, and the remedy — declare the error
 *     response, or allow unsafe verbs for this environment — is named.
 *
 * The customer can widen this with {@link ApiNegativePolicy.allowUnsafeVerbs},
 * which is a row they own. It is never an environment variable and never a
 * default.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 *
 * Every value is either read from the declaration, computed from it, or built
 * from `seed` through the synthetic factory. The fuzz values — the oversized
 * string, the undeclared property name, the nesting — carry a token derived
 * from (seed, method, path, target), so the same seed reproduces the same
 * request byte for byte and a failure can be replayed. No `Math.random`.
 */
export function expandApiBoundaries(
  operation: ApiOperationDeclaration,
  options: { readonly seed: string | number; readonly policy?: ApiNegativePolicy } = {
    seed: 'qaai',
  },
): ApiBoundaryExpansion {
  const policy = options.policy ?? {};
  const factory = createSyntheticFactory({
    seed: options.seed,
    scope: `${operation.method} ${operation.pathTemplate}`,
  });
  const declaredRejectionStatus = declaredRejection(operation.responseShapes);

  const admitted: ApiBoundaryCase[] = [];
  const refused: ApiRefusedCase[] = [];
  const notRead: string[] = [];
  let considered = 0;

  const offer = (
    klass: ApiNegativeClass,
    target: string,
    location: ApiBoundaryCase['location'],
    value: ApiBoundaryCase['value'],
    expectation: 'REJECT' | 'ACCEPT' | 'UNKNOWN',
    reason: string,
  ): void => {
    considered += 1;
    const admission = admitApiCase(operation.method, expectation, declaredRejectionStatus, policy);
    if (admission !== null) {
      refused.push({ klass, target, reason: admission.reason, detail: admission.detail });
      return;
    }
    const disposition =
      expectation === 'ACCEPT'
        ? 'ASSERT_ACCEPTANCE'
        : expectation === 'REJECT' && declaredRejectionStatus !== null
          ? 'ASSERT_REJECTION'
          : 'EXPLORATORY';
    admitted.push({
      id: apiCaseId(operation, target, klass),
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      klass,
      target,
      location,
      value,
      valueMeaning: API_VALUE_MEANING[klass],
      disposition,
      declaredRejectionStatus,
      reason,
      expected: apiAssertion(disposition, declaredRejectionStatus, reason),
    });
  };

  /*
   * The declared bounds, through the module that already owns the arithmetic.
   * `boundaryEdges` returns nothing for a `pattern` and never multiplies two
   * bounds together, both of which are deliberate there; the pattern case is
   * picked up separately below, from the same declaration.
   */
  for (const bound of operation.parameters ?? []) {
    for (const edge of boundaryEdges(bound)) {
      offer(edgeClass(edge), bound.name, bound.location, edge.value, edge.expectation, edge.reason);
    }
    for (const derived of shapeNegatives(bound, factory.scoped(bound.name).token)) {
      offer(
        derived.klass,
        bound.name,
        bound.location,
        derived.value,
        derived.expectation,
        derived.reason,
      );
    }
  }

  /*
   * The body, DESCENDED. This is the half that did not exist: `bodyBounds` in
   * api-surface.ts reads top-level properties only and records
   * NESTED_SHAPE_NOT_DESCENDED for everything under them, so a constraint one
   * level down was absent from the operation rather than stated as none.
   */
  for (const leaf of walkRequestShape(operation.requestShape, '#', 0, notRead)) {
    for (const edge of boundaryEdges(leaf.bound)) {
      offer(edgeClass(edge), leaf.pointer, 'BODY', edge.value, edge.expectation, edge.reason);
    }
    for (const derived of shapeNegatives(leaf.bound, factory.scoped(leaf.pointer).token)) {
      offer(
        derived.klass,
        leaf.pointer,
        'BODY',
        derived.value,
        derived.expectation,
        derived.reason,
      );
    }
    for (const derived of containerNegatives(leaf, factory.scoped(leaf.pointer).token)) {
      offer(
        derived.klass,
        leaf.pointer,
        'BODY',
        derived.value,
        derived.expectation,
        derived.reason,
      );
    }
  }

  const limit = policy.maxCases ?? DEFAULT_MAX_API_CASES;
  const omittedByCap = Math.max(0, admitted.length - limit);
  if (omittedByCap > 0) {
    refused.push({
      klass: 'NESTING_DEPTH',
      target: operation.pathTemplate,
      reason: 'CAP_APPLIED',
      detail: `${omittedByCap} further derivable case(s) were not emitted for ${operation.method} ${operation.pathTemplate}`,
    });
  }

  return {
    cases: omittedByCap === 0 ? admitted : admitted.slice(0, limit),
    refused,
    considered,
    omittedByCap,
    capReason:
      omittedByCap === 0
        ? null
        : `a limit of ${limit} case(s) per operation was applied; at least ${omittedByCap} more ` +
          `were derivable from this document for ${operation.method} ${operation.pathTemplate} ` +
          'and were not generated',
    notRead,
  };
}

/**
 * `boundaryEdges`'s edge kind → this file's class name.
 *
 * A `Record` keyed on the keystone's union, so an eleventh edge kind there
 * cannot be silently dropped here: it becomes a compile error until someone
 * decides which class it is. The previous shape of this — a string cast — is
 * how an edge kind gets generated under a class name no consumer recognises.
 */
const EDGE_CLASS: Record<ApiBoundaryEdge['kind'], ApiNegativeClass> = {
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  AT_MINIMUM: 'AT_MINIMUM',
  AT_MAXIMUM: 'AT_MAXIMUM',
  ABOVE_MAXIMUM: 'ABOVE_MAXIMUM',
  BELOW_MIN_LENGTH: 'BELOW_MIN_LENGTH',
  AT_MAX_LENGTH: 'AT_MAX_LENGTH',
  ABOVE_MAX_LENGTH: 'ABOVE_MAX_LENGTH',
  IN_ENUM: 'IN_ENUM',
  OUTSIDE_ENUM: 'OUTSIDE_ENUM',
  OMITTED: 'REQUIRED_OMITTED',
};

function edgeClass(edge: ApiBoundaryEdge): ApiNegativeClass {
  return EDGE_CLASS[edge.kind];
}

/** Stable across runs so a case can be referenced, suppressed, or diffed. */
function apiCaseId(
  operation: ApiOperationDeclaration,
  target: string,
  klass: ApiNegativeClass,
): string {
  const slug = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${slug(operation.method)}--${slug(operation.pathTemplate)}--${slug(target)}--${slug(klass)}`;
}

/**
 * The status code the document declares for a rejected request, or null.
 *
 * ── What this reads, and what it refuses to infer ──────────────────────────
 *
 * `responseShapes` is opaque JSON on the operation — `api-surface.ts` keeps the
 * document's `responses` object whole rather than modelling it, for the reason
 * stated there. This reads the KEYS of that object and nothing else: a key in
 * the 4xx range is the document declaring that the request can be refused, and
 * the FIRST such key in ascending order is the status a test may assert.
 *
 * `4XX` as a wildcard key counts, because OpenAPI allows it and a document that
 * writes it has declared a refusal. What does NOT count is a 5xx — a declared
 * 500 is not a promise to reject bad input, it is a promise to fail — and
 * neither does the absence of any response object. Null is returned and the
 * case becomes EXPLORATORY, because asserting 400 against an API that correctly
 * answers 422 is a failure QAAI caused, and asserting "some error" against an
 * API that answers 200 and writes the row is no assertion at all.
 */
function declaredRejection(responseShapes: unknown): string | null {
  if (responseShapes === null || typeof responseShapes !== 'object') return null;
  const keys = Object.keys(responseShapes);
  const rejections = keys
    .filter((key) => /^4(?:\d\d|XX)$/i.test(key.trim()))
    .sort((a, b) => a.localeCompare(b));
  return rejections[0] ?? null;
}

/**
 * May this case be sent at all? Null admits it; a reason refuses it.
 *
 * The whole safety position of the API section, in one function, so there is no
 * second place that could admit a mutating probe. See the long note on
 * {@link expandApiBoundaries}.
 */
function admitApiCase(
  method: string,
  expectation: 'REJECT' | 'ACCEPT' | 'UNKNOWN',
  declaredRejectionStatus: string | null,
  policy: ApiNegativePolicy,
): { reason: ApiRefusalReason; detail: string } | null {
  if (isSafeProbeMethod(method.toUpperCase())) return null;
  if (policy.allowUnsafeVerbs === true) return null;

  /*
   * The one case an unsafe verb is admitted on without the policy: the document
   * ITSELF declares the request is refused. The customer's own declaration is
   * the statement that nothing will be written, and a write would be the defect
   * this test reports rather than a side effect it caused.
   *
   * `expectation === 'ACCEPT'` is NOT admitted, and that is deliberate: an
   * AT_MAXIMUM case on a POST is a perfectly valid request, and sending it
   * creates a record. It is a real test and it belongs to a scenario that owns
   * a disposable principal and a cleanup obligation — not to a boundary probe.
   */
  if (expectation === 'REJECT' && declaredRejectionStatus !== null) return null;

  return expectation === 'ACCEPT'
    ? {
        reason: 'UNSAFE_VERB_BY_POLICY',
        detail:
          `${method.toUpperCase()} with a VALID edge value would succeed and create or change a ` +
          'record. That is a scenario with a disposable principal and a cleanup obligation, not a ' +
          'read-only probe, so it is not performed here. Set allowUnsafeVerbs on this ' +
          "environment's policy row to permit it.",
      }
    : {
        reason: 'UNSAFE_VERB_UNDECLARED_OUTCOME',
        detail:
          `${method.toUpperCase()} could change data and this operation declares no 4xx response, ` +
          'so nothing says the request would be refused — sending it might write a record. THIS ' +
          'CHECK WAS NOT PERFORMED. Declare the error response on the operation, or set ' +
          "allowUnsafeVerbs on this environment's policy row.",
      };
}

/** The sentence a generator asserts, never stronger than the disposition allows. */
function apiAssertion(
  disposition: BoundaryDisposition,
  declaredRejectionStatus: string | null,
  reason: string,
): string {
  switch (disposition) {
    case 'ASSERT_REJECTION':
      return (
        `The response status is ${declaredRejectionStatus}, as this operation declares, and the ` +
        `body names the offending field. No record is created: re-read afterwards and the ` +
        `collection is unchanged. Justified because ${reason}.`
      );
    case 'ASSERT_ACCEPTANCE':
      return (
        `The response is a success, because ${reason}. A rejection here is the defect — a bound ` +
        'the document declares as inclusive, enforced exclusively.'
      );
    case 'EXPLORATORY':
      return (
        `DO NOT ASSERT A STATUS. This operation declares no 4xx response, so nothing entitles a ` +
        `test to demand one — asserting 400 against an API that correctly answers 422 is a ` +
        `failure QAAI caused. Assert only that the response is NOT a 5xx and not a success that ` +
        `silently discarded the value, then RECORD the status so the next run can assert it. ` +
        `The input is justified: ${reason}.`
      );
  }
}

// ─── Walking the declared body schema ────────────────────────────────────────

/** One leaf of the request body, with its declared bounds and its container facts. */
interface SchemaLeaf {
  /** JSON Pointer from the body root: `#/properties/items/items/properties/sku`. */
  readonly pointer: string;
  readonly bound: ApiParameterBound;
  /** `type: array` facts, when the node is one. */
  readonly minItems: number | null;
  readonly maxItems: number | null;
  /** `additionalProperties: false`, read rather than assumed. Null when unstated. */
  readonly additionalProperties: boolean | null;
  /** How deep this node sits. Used for the nesting case and the depth report. */
  readonly depth: number;
  /** True when this node holds children, so the container classes apply. */
  readonly isContainer: boolean;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Descend the declared body schema into leaves, recording what was not read.
 *
 * ── Why this walk exists at all ────────────────────────────────────────────
 *
 * `bodyBounds` in api-surface.ts reads the TOP LEVEL of a request body and
 * records `NESTED_SHAPE_NOT_DESCENDED` for everything under it, saying so out
 * loud: "any constraint declared inside it is absent from this operation rather
 * than stated as none. The whole schema is kept on `requestShape`." This is the
 * code that reads the kept schema.
 *
 * ── What it refuses to do, and reports instead ─────────────────────────────
 *
 * It does not resolve `$ref`, and it does not compose `allOf`/`oneOf`/`anyOf`.
 * Both are recorded in `notRead` rather than skipped, because a composed schema
 * whose bounds are absent must not read as an API that declares no limits —
 * which is the most flattering possible wrong answer, and it suppresses every
 * negative test the document actually entitles us to.
 *
 * It stops at {@link MAX_SCHEMA_DEPTH} and says where. A cap applied without
 * being disclosed is one of the lies this product cannot afford, and a
 * recursive schema would otherwise walk until the stack gave out.
 */
function walkRequestShape(
  node: unknown,
  pointer: string,
  depth: number,
  notRead: string[],
): SchemaLeaf[] {
  if (!isRecordValue(node)) return [];

  if (depth > MAX_SCHEMA_DEPTH) {
    notRead.push(
      `${pointer}: the walk stops at depth ${MAX_SCHEMA_DEPTH}, so any constraint declared below ` +
        'this point is absent from this expansion rather than stated as none',
    );
    return [];
  }

  if (typeof node.$ref === 'string') {
    notRead.push(
      `${pointer}: declared by \`$ref\` (${node.$ref}) and this walk does not resolve references, ` +
        'so its bounds are absent rather than stated as none',
    );
    return [];
  }

  for (const keyword of ['allOf', 'oneOf', 'anyOf', 'not'] as const) {
    if (node[keyword] !== undefined) {
      notRead.push(
        `${pointer}: declared with \`${keyword}\` and this walk does not compose schemas, so its ` +
          'bounds are absent rather than stated as none',
      );
      return [];
    }
  }

  const declaredType = asStringOrNull(node.type);
  const properties = isRecordValue(node.properties) ? node.properties : null;
  const items = node.items;
  const isContainer = properties !== null || items !== undefined;

  const leaves: SchemaLeaf[] = [];

  /*
   * The node itself is a leaf whenever it carries bounds OR is a container with
   * container-level constraints. A container is emitted so the array and
   * additionalProperties classes have somewhere to hang; the root (`#`) is
   * emitted for the same reason, which is how ADDITIONAL_PROPERTY on the body
   * object gets derived at all.
   */
  const requiredNames = new Set(
    Array.isArray(node.required)
      ? node.required.filter((name): name is string => typeof name === 'string')
      : [],
  );

  leaves.push({
    pointer,
    bound: boundFromSchemaNode(pointer, node, null),
    minItems: asNumberOrNull(node.minItems),
    maxItems: asNumberOrNull(node.maxItems),
    /*
     * Three states, deliberately. `false` is a DECLARATION that extra
     * properties are refused and licenses an assertion; `true` declares they
     * are allowed, so the case would assert a rejection of something documented
     * as legal; ABSENT means the document did not say, and JSON Schema's own
     * default is "allowed" — treating that default as a declaration is how
     * "this API refuses unknown fields" gets asserted about an API that never
     * claimed it.
     */
    additionalProperties:
      typeof node.additionalProperties === 'boolean' ? node.additionalProperties : null,
    depth,
    isContainer,
  });

  if (properties !== null) {
    for (const [name, child] of Object.entries(properties)) {
      const childPointer = `${pointer}/properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!isRecordValue(child)) continue;
      const nested = walkRequestShape(child, childPointer, depth + 1, notRead);
      /*
       * The child's own `required` comes from the PARENT's list, which is where
       * JSON Schema puts it — a child that read its own node would always see
       * `required: undefined` and every omission case would vanish.
       */
      leaves.push(
        ...nested.map((leaf) =>
          leaf.pointer === childPointer
            ? { ...leaf, bound: { ...leaf.bound, required: requiredNames.has(name) } }
            : leaf,
        ),
      );
    }
  }

  if (items !== undefined && declaredType !== 'object') {
    leaves.push(...walkRequestShape(items, `${pointer}/items`, depth + 1, notRead));
  }

  return leaves;
}

/**
 * One schema node → the bound shape `boundaryEdges` acts on.
 *
 * `type` folds the declared `format` in as `string/email`, exactly as
 * `boundsFromSchema` in api-surface.ts does, so a bound built here and one
 * built there are the same shape — two spellings of a declared type is how a
 * consumer comes to switch on one and miss the other.
 *
 * `required` is null here and filled in by the PARENT, which is the only node
 * that knows: JSON Schema puts the required list on the object, not on the
 * property.
 */
function boundFromSchemaNode(
  pointer: string,
  node: Record<string, unknown>,
  required: boolean | null,
): ApiParameterBound {
  const declaredType = asStringOrNull(node.type);
  const format = asStringOrNull(node.format);
  const enumValues = Array.isArray(node.enum)
    ? node.enum.map((member) => (typeof member === 'string' ? member : JSON.stringify(member)))
    : null;

  return {
    name: pointer,
    location: 'BODY',
    required,
    type:
      declaredType === null ? null : format === null ? declaredType : `${declaredType}/${format}`,
    minimum: asNumberOrNull(node.minimum),
    maximum: asNumberOrNull(node.maximum),
    minLength: asNumberOrNull(node.minLength),
    maxLength: asNumberOrNull(node.maxLength),
    pattern: asStringOrNull(node.pattern),
    enumValues,
  };
}

// ─── The classes a declared bound makes free, that the arithmetic cannot see ──

/** A derived case before admission: the class, the value, and what it expects. */
interface DerivedApiCase {
  readonly klass: ApiNegativeClass;
  readonly value: ApiBoundaryCase['value'];
  readonly expectation: 'REJECT' | 'ACCEPT' | 'UNKNOWN';
  readonly reason: string;
}

/**
 * The format strings this file knows a counter-example for.
 *
 * ── Why a closed list and not a generator ──────────────────────────────────
 *
 * Because an unknown `format` is not a constraint we read — it is a word we do
 * not understand. OpenAPI lets a document declare any format it likes, and most
 * do: `format: "money"`, `format: "sku"`, `format: "slug"`. A test that sends
 * "not-a-money" and asserts a rejection is asserting a rule QAAI invented, and
 * that is the failure the whole applicability rule exists to prevent. So an
 * unrecognised format yields NOTHING — it is reported by neither this map nor a
 * guessed case, which is the honest answer.
 *
 * Each value is a counter-example that is clearly, structurally wrong for the
 * format rather than merely unusual, so a rejection cannot be a false positive
 * on an unusually-shaped legal value.
 */
const FORMAT_COUNTEREXAMPLES: Readonly<Record<string, { value: string; because: string }>> = {
  email: { value: 'qaai-at-example.com', because: 'it holds no "@", which no address can omit' },
  uuid: {
    value: 'not-a-uuid',
    because: 'it is neither 36 characters nor hyphenated in 8-4-4-4-12',
  },
  'date-time': { value: '2026-02-31T99:99:99Z', because: 'hour 99 exists in no calendar' },
  date: {
    value: '2026-02-31',
    because: 'February has no 31st, so it is well-formed and impossible',
  },
  uri: {
    value: 'htp:/example',
    because: 'the scheme is misspelled and the authority is malformed',
  },
  url: {
    value: 'htp:/example',
    because: 'the scheme is misspelled and the authority is malformed',
  },
  ipv4: { value: '999.1.1.1', because: 'no octet can exceed 255' },
  ipv6: { value: 'not::a::v6::address', because: 'a v6 address admits one "::" at most' },
  hostname: { value: '-not-a-hostname-', because: 'a label may not begin or end with a hyphen' },
  byte: { value: 'not base64 !!', because: 'a space and "!" are outside the base64 alphabet' },
};

/**
 * A value of the wrong JSON type for the declared one.
 *
 * Keyed on the declared type and never on a guess. The value chosen is one the
 * declared type CANNOT coerce: a string into an `integer` is the classic path to
 * a 500, and an object where a string was declared is the one that finds a
 * handler reading `.length` off it.
 */
const TYPE_COUNTEREXAMPLES: Readonly<
  Record<string, { value: ApiBoundaryCase['value']; because: string }>
> = {
  integer: { value: 'qaai-not-a-number', because: 'a word where an integer is declared' },
  number: { value: 'qaai-not-a-number', because: 'a word where a number is declared' },
  boolean: { value: 'qaai-not-a-boolean', because: 'a word where a boolean is declared' },
  string: { value: 1_000_000, because: 'a number where a string is declared' },
  array: { value: 'qaai-not-an-array', because: 'a string where an array is declared' },
  object: { value: 'qaai-not-an-object', because: 'a string where an object is declared' },
};

/**
 * The negatives a declared TYPE, FORMAT or PATTERN makes free.
 *
 * All three are "the document stated a rule and we send something that breaks
 * it", so the expectation is REJECT — which, on an unsafe verb with no declared
 * 4xx, is exactly what {@link admitApiCase} refuses. On a safe verb it is a
 * genuine assertion, because the rule came off the document and not out of this
 * file.
 */
function shapeNegatives(bound: ApiParameterBound, token: string): DerivedApiCase[] {
  const derived: DerivedApiCase[] = [];
  const declared = bound.type;

  if (declared !== null) {
    /*
     * `boundsFromSchema` folds the format into the type as `string/email`, so
     * the two halves are split back out here rather than read from two fields.
     * Splitting on the FIRST slash only: a format may contain one, a type may
     * not.
     */
    const slash = declared.indexOf('/');
    const base = (slash === -1 ? declared : declared.slice(0, slash)).toLowerCase();
    const format = slash === -1 ? null : declared.slice(slash + 1).toLowerCase();

    const typeCase = TYPE_COUNTEREXAMPLES[base];
    if (typeCase !== undefined) {
      derived.push({
        klass: 'TYPE_VIOLATION',
        value: typeCase.value,
        expectation: 'REJECT',
        reason: `the document declares type \`${base}\`, and this is ${typeCase.because}`,
      });
    }

    if (format !== null) {
      const formatCase = FORMAT_COUNTEREXAMPLES[format];
      if (formatCase !== undefined) {
        derived.push({
          klass: 'FORMAT_VIOLATION',
          value: formatCase.value,
          expectation: 'REJECT',
          reason: `the document declares format \`${format}\`, and this value breaks it: ${formatCase.because}`,
        });
      }
      /*
       * An unrecognised format produces NO case, on purpose. See the note on
       * FORMAT_COUNTEREXAMPLES: sending "not-a-sku" at `format: "sku"` and
       * asserting a rejection asserts a rule QAAI invented.
       */
    }

    /*
     * JSON `null` where a type was declared and nullability was not.
     *
     * OpenAPI 3.0 spells nullability `nullable: true` and 3.1 spells it
     * `type: ["string","null"]`; neither reaches `ApiParameterBound.type`,
     * which holds a single string. So a `type` that is a plain scalar name is a
     * declaration that null is not among the legal values — and sending null is
     * the case that finds a handler calling `.trim()` on it. Only for a
     * REQUIRED parameter, because an optional one's absence and its null are
     * frequently treated alike and the distinction is not one the document
     * drew.
     */
    if (bound.required === true && base !== 'null' && TYPE_COUNTEREXAMPLES[base] !== undefined) {
      derived.push({
        klass: 'NULL_FOR_NON_NULLABLE',
        value: null,
        expectation: 'REJECT',
        reason: `the document declares this required and of type \`${base}\`, and names no null among its legal values`,
      });
    }
  }

  const pattern = bound.pattern;
  if (pattern !== null && pattern !== undefined && pattern !== '') {
    /*
     * The same approach the form path takes: try candidates against the
     * declared pattern and send one it actually rejects. `boundaryEdges`
     * deliberately returns nothing for a pattern because it will not pretend to
     * invert a regex — and neither does this. It CHECKS, which is a different
     * and honest thing: a value the declared pattern provably does not match is
     * a rejection the document justifies, and when no candidate violates it,
     * nothing is generated.
     */
    const violating = patternCounterexample(pattern, token);
    if (violating !== null) {
      derived.push({
        klass: 'PATTERN_VIOLATION',
        value: violating,
        expectation: 'REJECT',
        reason: `the document declares pattern \`${pattern}\`, which this value provably does not match`,
      });
    }
  }

  return derived;
}

/**
 * A string the declared pattern rejects, checked rather than constructed.
 *
 * The token is in the candidate list so the chosen value is reproducible from
 * the run seed — the same seed picks the same candidate, and a fuzz case nobody
 * can replay is not a test.
 */
function patternCounterexample(source: string, token: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`);
  } catch {
    // An uncompilable pattern is not enforced by any runtime either, so there is
    // no declared rule here to violate.
    return null;
  }
  const candidates = [`qaai-${token}`, '!!!', ' ', '0', 'aaaa', '§±#', 'A'.repeat(64)];
  return candidates.find((candidate) => !re.test(candidate)) ?? null;
}

/**
 * The negatives a CONTAINER's declaration makes free: array item bounds, an
 * undeclared property, and a nesting depth.
 *
 * ── The one EXPLORATORY case in this section, and why it is honest ─────────
 *
 * NESTING_DEPTH is the only class here derived from no declaration at all: no
 * document declares a maximum nesting depth, so nothing entitles a test to
 * assert a rejection. It is generated anyway, as an EXPLORATORY probe, because
 * a deeply-nested body is a real and cheap way to find a parser that recurses
 * without a limit — and the honest assertion is the one it carries: not a 5xx,
 * not a hang. A case that demanded a 400 would be demanding a limit the
 * customer never claimed.
 */
function containerNegatives(leaf: SchemaLeaf, token: string): DerivedApiCase[] {
  const derived: DerivedApiCase[] = [];

  if (leaf.minItems !== null && leaf.minItems > 0) {
    derived.push({
      klass: 'ARRAY_BELOW_MIN_ITEMS',
      value: leaf.minItems - 1,
      expectation: 'REJECT',
      reason: `the document declares minItems ${leaf.minItems}; send an array of ${leaf.minItems - 1}`,
    });
  }

  if (leaf.maxItems !== null && leaf.maxItems >= 0) {
    derived.push({
      klass: 'ARRAY_ABOVE_MAX_ITEMS',
      value: leaf.maxItems + 1,
      expectation: 'REJECT',
      reason: `the document declares maxItems ${leaf.maxItems}; send an array of ${leaf.maxItems + 1}`,
    });
  }

  /*
   * ONLY on a declared `additionalProperties: false`. The null state — the
   * document did not say — produces nothing, because JSON Schema's own default
   * is that extra properties are ALLOWED, and asserting a rejection from a
   * default nobody wrote is asserting from silence. The same argument
   * `boundaryEdges` makes about `required: null`.
   */
  if (leaf.additionalProperties === false) {
    derived.push({
      klass: 'ADDITIONAL_PROPERTY',
      value: `qaai-undeclared-${token}`,
      expectation: 'REJECT',
      reason:
        'the document declares `additionalProperties: false`, so a property it does not name must be refused — ' +
        'and an API that silently drops it instead is how a field rename ships as a no-op',
    });
  }

  if (leaf.isContainer && leaf.depth === 0) {
    derived.push({
      klass: 'NESTING_DEPTH',
      value: MAX_SCHEMA_DEPTH * 4,
      expectation: 'UNKNOWN',
      reason:
        `a body nested ${MAX_SCHEMA_DEPTH * 4} levels deep, which is far past anything this ` +
        'document declares. Nothing declares a depth limit, so this is a probe and not an ' +
        'assertion: a parser that recurses without one is a denial of service, and a parser that ' +
        'refuses cleanly is correct',
    });
  }

  return derived;
}
