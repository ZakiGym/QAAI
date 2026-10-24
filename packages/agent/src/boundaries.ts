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
 */

import {
  cardForOutcome,
  createSyntheticFactory,
  fillForm,
  luhnBreak,
  type FormField,
  type FormFieldSemantic,
} from '@qaai/shared';

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

/** Whether the submission should go through. The assertion's direction. */
export type BoundaryExpectation = 'accepted' | 'rejected';

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
 * Semantics for which "multi-byte input must round-trip" is a defensible
 * expectation — i.e. fields that genuinely accept whatever a person types.
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
 * way for this file to be wrong"; this was the same mistake in another class.
 *
 * The set is positive, not negative, and that is the safe direction. A field
 * whose format is fixed gets NO emoji case rather than one expecting rejection
 * — "an app must refuse emoji in a postcode" is not something this file knows
 * either, and the `wrong-type` class already asks that field the malformed-value
 * question with an expectation that can be defended.
 */
const EMOJI_IS_VALID_INPUT: ReadonlySet<FormFieldSemantic> = new Set([
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
          expectation,
          expected,
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
       * for a card number before `EMOJI_IS_VALID_INPUT` gated it; see the note
       * on that set.
       */
      if (EMOJI_IS_VALID_INPUT.has(field.semantic)) {
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
