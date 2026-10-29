import { describe, expect, it } from 'vitest';
import { isLuhnValid, type FormField, type FormModel, type Selector } from '@qaai/shared';
import {
  EQUIVALENCE_CLASSES,
  describeExpansion,
  expandBoundaries,
  type BoundaryCase,
  type EquivalenceClass,
} from './boundaries';

/**
 * What this file is actually checking.
 *
 * The defect was that a whole feature collapsed into ONE negative item built
 * from the first required field. So the tests that matter here are not "does it
 * return cases" — it obviously does — but the four properties that make the
 * cases usable:
 *
 *   1. ONE invalid field per case, and every other field valid. Without this a
 *      failure cannot be attributed and the test gets deleted.
 *   2. The classes that depend on a declared constraint appear when the page
 *      declares it, and the right ALTERNATIVE class appears when it does not.
 *   3. Nothing is dropped silently.
 *   4. Determinism, because the values come from the seeded factory.
 */

const selector: Selector = { strategy: 'LABEL', value: 'x', confidence: 0.9 };

const field = (over: Partial<FormField> & Pick<FormField, 'name' | 'semantic'>): FormField => ({
  label: over.label ?? over.name,
  inputType: 'text',
  required: false,
  selector,
  ...over,
});

const form = (fields: FormField[], id = 'form-0'): FormModel => ({
  id,
  name: 'POST /checkout',
  selector: { strategy: 'CSS', value: 'form', confidence: 0.5 },
  fields,
  submit: { strategy: 'ROLE', value: 'button', name: 'Place order', confidence: 0.95 },
});

const classesFor = (cases: BoundaryCase[], name: string): EquivalenceClass[] =>
  cases.filter((c) => c.field === name).map((c) => c.equivalenceClass);

const find = (cases: BoundaryCase[], name: string | null, klass: EquivalenceClass): BoundaryCase =>
  cases.find((c) => c.field === name && c.equivalenceClass === klass)!;

const CHECKOUT = form([
  field({ name: 'email', semantic: 'email', inputType: 'email', required: true, maxLength: 64 }),
  field({ name: 'promoCode', semantic: 'freeform', pattern: '[A-Z]{4}[0-9]{2}', maxLength: 6 }),
  field({
    name: 'quantity',
    semantic: 'number',
    inputType: 'number',
    required: true,
    min: '1',
    max: '10',
    step: '1',
  }),
  field({ name: 'cardNumber', semantic: 'credit_card', required: true, inputMode: 'numeric' }),
  field({
    name: 'country',
    semantic: 'country',
    inputType: 'select',
    options: ['Select…', 'Portugal', 'Japan'],
  }),
  field({ name: 'notes', semantic: 'freeform', inputType: 'textarea' }),
]);

describe('the one-invalid-field invariant', () => {
  const { cases, happyPathValues } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });

  it('perturbs exactly one field per case, leaving every other field valid', () => {
    for (const testCase of cases.filter((c) => c.field !== null)) {
      const differing = Object.keys(happyPathValues).filter(
        (name) => happyPathValues[name] !== testCase.values[name],
      );
      // Exactly one, or zero when the generated representative happens to equal
      // the valid value — never two, which would make the failure ambiguous.
      expect(differing.length, `${testCase.id} -> ${differing.join(',')}`).toBeLessThanOrEqual(1);
      if (differing.length === 1) expect(differing[0]).toBe(testCase.field);
    }
  });

  it('submits a complete form in every case, not just the one field', () => {
    for (const testCase of cases) {
      expect(Object.keys(testCase.values).sort()).toEqual(Object.keys(happyPathValues).sort());
    }
  });

  it('carries a happy path as the positive control, and expects it to be accepted', () => {
    const happy = find(cases, null, 'happy-path');
    expect(happy.expectation).toBe('accepted');
    expect(happy.values).toEqual(happyPathValues);
    expect(happy.why).toMatch(/positive control/i);
  });
});

describe('classes that depend on a declared constraint', () => {
  const { cases } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });

  it('tests the limit AND one past it when maxlength is declared', () => {
    const atMax = find(cases, 'email', 'at-max-length');
    const overMax = find(cases, 'email', 'over-max-length');
    expect(atMax.value).toHaveLength(64);
    expect(atMax.expectation).toBe('accepted');
    expect(overMax.value).toHaveLength(65);
    expect(overMax.expectation).toBe('rejected');
    // Still a syntactically valid address at the limit, so a rejection can only
    // be about length.
    expect(atMax.value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it('sends an unbounded string when NO maxlength is declared, and ranks it top', () => {
    expect(classesFor(cases, 'notes')).toContain('unbounded-length');
    expect(classesFor(cases, 'email')).not.toContain('unbounded-length');
    const unbounded = find(cases, 'notes', 'unbounded-length');
    expect(unbounded.value).toHaveLength(10_000);
    // The highest-ranked class there is: no declared limit usually means no
    // limit was considered anywhere, including in the column.
    expect(unbounded.rank).toBeGreaterThan(find(cases, 'email', 'empty').rank);
  });

  it('walks a numeric range: at the bound, and one step past it in both directions', () => {
    expect(find(cases, 'quantity', 'at-min').value).toBe('1');
    expect(find(cases, 'quantity', 'under-min').value).toBe('0');
    expect(find(cases, 'quantity', 'at-max').value).toBe('10');
    expect(find(cases, 'quantity', 'over-max').value).toBe('11');
    expect(find(cases, 'quantity', 'at-min').expectation).toBe('accepted');
    expect(find(cases, 'quantity', 'over-max').expectation).toBe('rejected');
  });

  it('produces a step-misaligned value that is genuinely off the grid', () => {
    /*
     * Regression. The first version added a fudge term that landed on min + 1
     * for step="1" — perfectly ALIGNED — and then rounded it to an integer, so
     * the case asserted that a legal value would be refused. A generated
     * negative test that fails against a CORRECT application is the worst way
     * for this file to be wrong, because the bug report lands on the app team.
     */
    const misaligned = find(cases, 'quantity', 'step-misaligned');
    expect(misaligned.value).toBe('1.5');
    const value = Number(misaligned.value);
    expect(Number.isInteger(value)).toBe(false);
    expect(value).toBeGreaterThan(1);
    expect(value).toBeLessThan(10);
    expect(misaligned.value).not.toBe(find(cases, 'quantity', 'at-min').value);
  });

  it('produces a value the declared pattern actually rejects', () => {
    const violating = find(cases, 'promoCode', 'pattern-violating');
    expect(new RegExp('^(?:[A-Z]{4}[0-9]{2})$').test(violating.value!)).toBe(false);
  });

  it('breaks the checksum on a card field, keeping the brand prefix', () => {
    const luhn = find(cases, 'cardNumber', 'luhn-invalid');
    expect(isLuhnValid(luhn.value!)).toBe(false);
    expect(luhn.value!.slice(0, 4)).toBe('4242');
    expect(luhn.expectation).toBe('rejected');
  });

  it("posts a value outside a select's options", () => {
    expect(classesFor(cases, 'country')).toContain('not-in-options');
    expect(classesFor(cases, 'notes')).not.toContain('not-in-options');
  });

  it('demands both empty and whitespace-only on a required field, and neither otherwise', () => {
    expect(classesFor(cases, 'email')).toContain('empty');
    expect(classesFor(cases, 'email')).toContain('whitespace-only');
    expect(classesFor(cases, 'notes')).not.toContain('empty');
  });

  it('expects emoji to be ACCEPTED — the one negative-looking class that is valid input', () => {
    const unicode = find(cases, 'notes', 'unicode-emoji');
    expect(unicode.expectation).toBe('accepted');
    expect(unicode.value).toMatch(/🧪/u);
  });

  it('does not offer a length or injection class on a control that takes neither', () => {
    const numeric = classesFor(cases, 'quantity');
    expect(numeric).not.toContain('injection-like');
    expect(numeric).not.toContain('unbounded-length');
    expect(classesFor(cases, 'country')).not.toContain('injection-like');
  });

  it('skips the wrong-type class where no value is the wrong type', () => {
    // A free-text field accepts any string, so there is no defensible
    // expectation for a "wrong type" case and none is invented.
    expect(classesFor(cases, 'notes')).not.toContain('wrong-type');
    expect(classesFor(cases, 'email')).toContain('wrong-type');
    expect(find(cases, 'email', 'wrong-type').value).not.toContain('@');
  });
});

describe('nothing is dropped silently', () => {
  it('counts the two-field combinations it refuses to enumerate', () => {
    const { dropped } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });
    const combinations = dropped.find((d) => d.what.includes('two-field'));
    expect(combinations).toBeDefined();
    expect(combinations!.count).toBeGreaterThan(0);
    expect(combinations!.why).toMatch(/cannot be attributed/);
  });

  it('explains every class that did not apply, so absence is never mistaken for omission', () => {
    const { dropped } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });
    const reasons = dropped.map((d) => d.what).join(' | ');
    expect(reasons).toMatch(/pattern-violating/);
    expect(reasons).toMatch(/luhn-invalid/);
    expect(reasons).toMatch(/not-in-options/);
  });

  it('records the cap when the cap bites', () => {
    const { cases, dropped } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 5 });
    expect(cases).toHaveLength(5);
    const cap = dropped.find((d) => d.what.includes('lower-ranked'));
    expect(cap).toBeDefined();
    expect(cap!.why).toMatch(/Capped at 5/);
  });

  it('leads its summary with what was left out', () => {
    const summary = describeExpansion(expandBoundaries(CHECKOUT, { seed: 'run-1' }));
    expect(summary).toMatch(/not enumerated/i);
  });

  it('builds a valid happy path for the checkout form, with nothing to caveat', () => {
    // Includes a field with pattern="[A-Z]{4}[0-9]{2}" and maxlength=6, which
    // is the combination that used to be unfillable.
    const { caveats, happyPathValues } = expandBoundaries(CHECKOUT, { seed: 'run-1' });
    expect(caveats).toEqual([]);
    expect(happyPathValues.promoCode).toMatch(/^[A-Z]{4}[0-9]{2}$/);
  });

  it('warns loudly, and first, when some OTHER field has no valid value', () => {
    /*
     * The caveat that outranks every other: each case submits the whole form,
     * so one unfillable field means every case carries two bad values and no
     * failure can be attributed to the field under test. maxlength=6 on an
     * email input admits no valid address, which is itself a bug in the page.
     */
    const broken = form(
      [
        field({
          name: 'email',
          semantic: 'email',
          inputType: 'email',
          required: true,
          maxLength: 6,
        }),
        field({ name: 'notes', semantic: 'freeform', inputType: 'textarea' }),
      ],
      'form-broken',
    );
    const { caveats } = expandBoundaries(broken, { seed: 'run-1' });
    expect(caveats[0]).toMatch(/^READ THIS FIRST/);
    expect(caveats[0]).toMatch(/"email"/);
    expect(caveats[0]).toMatch(/cannot be attributed/);
  });
});

describe('ranking', () => {
  const { cases } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });

  it('returns cases highest-rank first, so taking the top N is taking the best N', () => {
    const ranks = cases.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it('ranks a high-stakes field above the same class on an ordinary one', () => {
    expect(find(cases, 'cardNumber', 'empty').rank).toBeGreaterThan(
      find(cases, 'quantity', 'empty').rank,
    );
  });

  it('admits in rankWhy that the weights are judgement, not measurement', () => {
    for (const testCase of cases) {
      expect(testCase.rankWhy, testCase.id).toMatch(/judgement, not a measurement/);
    }
  });
});

describe('every case justifies itself', () => {
  const { cases } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });

  it('says why it exists and what the app should do, in sentences', () => {
    for (const testCase of cases) {
      // The register's point: a reviewer who cannot see the point of a negative
      // test deletes it. An empty or stub justification is therefore a defect
      // in the generator, not a cosmetic issue.
      expect(testCase.why.length, testCase.id).toBeGreaterThan(40);
      expect(testCase.expected.length, testCase.id).toBeGreaterThan(40);
      expect(testCase.why, testCase.id).not.toMatch(/TODO|TBD/i);
    }
  });

  it('uses a known equivalence class and a stable id', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of cases) {
      expect(EQUIVALENCE_CLASSES).toContain(testCase.equivalenceClass);
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('determinism', () => {
  it('gives identical cases for the same seed', () => {
    const a = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });
    const b = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });
    expect(b).toEqual(a);
  });

  it('changes the generated values, but not the classes, for a different seed', () => {
    const a = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });
    const b = expandBoundaries(CHECKOUT, { seed: 'run-2', maxCases: 200 });
    expect(b.happyPathValues).not.toEqual(a.happyPathValues);
    // The partition of the input space is a property of the form, not of the
    // seed — so the set of cases must be stable even as the values change.
    expect(b.cases.map((c) => c.id)).toEqual(a.cases.map((c) => c.id));
  });
});

describe('a form from a crawl that predates constraint capture', () => {
  // The whole point of making the constraints optional: an old FlowMap still
  // expands, it just expands to the classes that need no declared constraint.
  const old = form(
    [
      field({ name: 'email', semantic: 'email', inputType: 'email', required: true }),
      field({ name: 'message', semantic: 'freeform', inputType: 'textarea' }),
    ],
    'form-legacy',
  );
  const { cases, dropped } = expandBoundaries(old, { seed: 'run-1', maxCases: 200 });

  it('still produces useful cases', () => {
    expect(cases.length).toBeGreaterThan(5);
    expect(classesFor(cases, 'email')).toContain('empty');
    expect(classesFor(cases, 'email')).toContain('wrong-type');
    expect(classesFor(cases, 'message')).toContain('unbounded-length');
  });

  it('offers no constraint-derived class, and says that is because nothing was CAPTURED', () => {
    for (const klass of [
      'at-max-length',
      'over-max-length',
      'at-min',
      'over-max',
      'step-misaligned',
    ] as const) {
      expect(cases.map((c) => c.equivalenceClass)).not.toContain(klass);
    }
    /*
     * The wording, not just the absence. This fixture's constraints are ABSENT
     * (the crawl predates the capture), which is a different fact from a page
     * that declares none — and the earlier version of this assertion accepted
     * "the page declares no minlength", a claim about the customer's markup
     * made on the strength of never having read it.
     */
    const reasons = dropped.map((d) => d.what).join(' | ');
    expect(reasons).toMatch(/no minlength was captured/);
    expect(reasons).toMatch(/no min or max was captured/);
    // Matched tightly: the "not captured" sentence QUOTES the alternative in
    // order to deny it, so a loose /declares no/ would match its own disclaimer.
    expect(reasons).not.toMatch(/the page declares no minlength/);
    expect(reasons).not.toMatch(/the page declares no pattern/);
  });
});

describe('"nobody looked" is never reported as "the page declares nothing"', () => {
  /*
   * The distinction `FormField` makes every constraint optional in order to
   * keep, tested in both directions on the same field.
   *
   * It is load-bearing for a real caller: the source-analysis path in
   * apps/worker reads no length, range, step or pattern attribute at all, so on
   * that path EVERY constraint is absent. Collapsing absent onto null there
   * would have the product assert, ten times per field, that an application
   * declares no limits — on the strength of a file read that never looked.
   */
  const reasonsFor = (over: Partial<FormField>): string =>
    expandBoundaries(
      form([field({ name: 'code', semantic: 'freeform', required: true, ...over })], 'form-tri'),
      { seed: 'run-1', maxCases: 200 },
    )
      .dropped.map((d) => d.what)
      .join(' | ');

  it('says "not captured" when the attribute is absent', () => {
    const reasons = reasonsFor({});
    expect(reasons).toMatch(/no pattern was captured on this field/);
    expect(reasons).toMatch(/re-read the field/);
  });

  it('says "the page declares none" only when the crawl actually looked', () => {
    const reasons = reasonsFor({
      pattern: null,
      minLength: null,
      min: null,
      max: null,
      step: null,
    });
    expect(reasons).toMatch(/the page declares no pattern/);
    expect(reasons).toMatch(/the page declares no minlength/);
    expect(reasons).not.toMatch(/no pattern was captured/);
  });

  it('justifies an unbounded-length case differently when no maxlength was captured', () => {
    const absent = expandBoundaries(
      form([field({ name: 'notes', semantic: 'freeform', inputType: 'textarea' })], 'form-abs'),
      { seed: 'run-1', maxCases: 200 },
    );
    const declared = expandBoundaries(
      form(
        [field({ name: 'notes', semantic: 'freeform', inputType: 'textarea', maxLength: null })],
        'form-dec',
      ),
      { seed: 'run-1', maxCases: 200 },
    );
    expect(find(absent.cases, 'notes', 'unbounded-length').why).toMatch(
      /No maxlength was captured/,
    );
    expect(find(declared.cases, 'notes', 'unbounded-length').why).toMatch(
      /The page declares no maxlength/,
    );
  });
});

describe('a form that carries no locator at all still expands', () => {
  /*
   * `BoundaryForm`/`BoundaryField` exist so the two callers that have no
   * locator — a FormSummary read back out of a stored Json column, and a form
   * read out of a source file — do not have to invent one to satisfy a
   * parameter this file never reads. An invented locator is a fabricated fact
   * in a typed field, and it travels into generated test code.
   */
  it('reads the fields and never asks for a selector', () => {
    const { cases } = expandBoundaries(
      {
        id: 'summary-form',
        name: 'Refund request',
        fields: [
          {
            name: 'order',
            label: 'Order number',
            inputType: 'text',
            required: true,
            semantic: 'freeform',
          },
          {
            name: 'amount',
            label: 'Amount',
            inputType: 'number',
            required: true,
            semantic: 'currency',
            min: '1',
            max: '500',
          },
        ],
      },
      { seed: 'run-1', maxCases: 200 },
    );
    expect(classesFor(cases, 'order')).toContain('empty');
    expect(find(cases, 'amount', 'over-max').value).toBe('501');
  });
});

describe('a form with no fields', () => {
  it('returns nothing rather than inventing a happy path', () => {
    const { cases } = expandBoundaries(form([], 'form-empty'), { seed: 'run-1' });
    expect(cases).toEqual([]);
  });
});

/*
 * ─── The three things this file grew ─────────────────────────────────────────
 *
 * Everything above tests `expandBoundaries`, the form path. Below are the
 * additions, and the properties worth testing about them are not "does it
 * return cases" — they obviously do — but the ones that make the cases SAFE to
 * generate:
 *
 *   1. THE LICENCE. No case may claim the application rejects a value unless
 *      the application declared the constraint that justifies the claim. A
 *      generated test that goes red against a CORRECT application costs more
 *      than the bug it might have found, because the customer deletes the suite.
 *   2. THE ACCOUNTING. Every pair considered is either a case, inapplicable, an
 *      unread constraint of OURS, unrepresentable, or capped — and the parts
 *      sum to the whole. A cap or a refusal that is not counted reads as "that
 *      is all there is".
 *   3. THE REFUSALS. A negative probe that would mutate a customer's data must
 *      be refused AND RECORDED AS REFUSED, so the report says the check was not
 *      performed rather than reading as clean.
 */

import {
  API_NEGATIVE_CLASSES,
  API_NEGATIVE_CLASS_LIST,
  API_REFUSAL_REASONS,
  API_REFUSAL_REASON_LIST,
  API_VALUE_MEANINGS,
  API_VALUE_MEANING_LIST,
  BOUNDARY_DISPOSITIONS,
  BOUNDARY_DISPOSITION_LIST,
  expandApiBoundaries,
  expandBoundaryClasses,
  type ApiOperationDeclaration,
  type BoundaryClassCase,
} from './boundaries';
import { BOUNDARY_DESCRIPTORS, type BoundaryClass } from '@qaai/shared';

/** Classes whose defining constraint is a declared ATTRIBUTE a crawl may miss. */
const ATTRIBUTE_CONSTRAINTS = ['maxLength', 'minLength', 'min', 'max', 'step', 'pattern'] as const;

// ─── 1. The licence ──────────────────────────────────────────────────────────

describe('a rejection is only asserted when the application declared the limit', () => {
  const { cases, dropped } = expandBoundaries(CHECKOUT, { seed: 'run-1', maxCases: 200 });

  it('keeps the rejection when the page DECLARED the constraint', () => {
    // maxlength=64 is on the page, so "65 characters must be refused" is the
    // application's own claim and a test may demand an error.
    expect(find(cases, 'email', 'over-max-length').expectation).toBe('rejected');
    expect(find(cases, 'quantity', 'over-max').expectation).toBe('rejected');
    expect(find(cases, 'promoCode', 'pattern-violating').expectation).toBe('rejected');
    expect(find(cases, 'cardNumber', 'luhn-invalid').expectation).toBe('rejected');
  });

  it('weakens the unbounded-length rejection, because NO limit was ever read', () => {
    /*
     * THE DEFECT THIS PINS. `unbounded-length` carried `expectation: 'rejected'`
     * under an `expected` sentence that said either outcome passes — so a
     * generator keying on the structured field wrote `expect(error)` against a
     * length limit the page never claimed, and the red build was QAAI's fault.
     */
    const unbounded = find(cases, 'notes', 'unbounded-length');
    expect(unbounded.expectation).toBe('handled');
    expect(unbounded.value).toHaveLength(10_000);
  });

  it('weakens injection-like, because a CORRECT application accepts and escapes', () => {
    // HTML_META's honest expectation is that the value comes back escaped, so
    // "expect an error" fails against the application that does it right.
    expect(find(cases, 'notes', 'injection-like').expectation).toBe('handled');
  });

  it('says so in the case prose as well as in the structured field', () => {
    /*
     * Both or neither. A case whose `expectation` says `handled` under an
     * `expected` demanding an error is the original defect wearing the fix's
     * clothes: the generator reads one field and the reviewer reads the other.
     */
    for (const testCase of cases) {
      const claimsNoRejection = testCase.expected.startsWith('NOT ASSERTED AS A REJECTION');
      expect(claimsNoRejection, testCase.id).toBe(testCase.expectation === 'handled');
    }
  });

  it('DISCLOSES every weakened assertion as a count and the fields it hit', () => {
    const weakened = dropped.filter((d) => d.what.includes('weakened'));
    expect(weakened.length).toBeGreaterThan(0);
    for (const entry of weakened) {
      expect(entry.count).toBeGreaterThan(0);
      // Names the fields, so the line says which crawl to re-run rather than
      // just that something was weakened.
      expect(entry.what).toMatch(/"/);
      expect(entry.why.length).toBeGreaterThan(40);
    }
    expect(weakened.map((d) => d.what).join(' ')).toMatch(/unbounded-length/);
  });

  it('does NOT let the keystone veto a pairing this file knows more about', () => {
    /*
     * The other half of the judgement, and it is worth a test because it is the
     * half that could silently make this path WEAKER.
     *
     * The keystone's `familyObjection` refuses WRONG_TYPE on any free-text
     * input that is not email/url/tel, so it calls the class INAPPLICABLE on a
     * `credit_card` rendered as `<input type="text">`. But `wrongTypeValue`
     * here is keyed on the SEMANTIC and has a real wrong-type value for exactly
     * that field — "4242-abcd-4242-4242", which a card form must refuse before
     * it calls the processor. Reading INAPPLICABLE as a veto would downgrade
     * that to a handled-outcome assertion and lose a genuine defect.
     */
    const wrongType = find(cases, 'cardNumber', 'wrong-type');
    expect(wrongType.value).toMatch(/abcd/);
    expect(wrongType.expectation).toBe('rejected');
    expect(wrongType.expected).not.toMatch(/NOT ASSERTED/);
  });

  it('asserts NO attribute-derived rejection on a crawl that read no attributes', () => {
    /*
     * The strong invariant, over the whole expansion rather than over one case.
     * The source-analysis path in apps/worker reads NO maxlength, minlength,
     * range, step or pattern, so every constraint there is absent — and on that
     * path this property is the difference between a useful negative suite and
     * ten false rejections per field.
     */
    const legacy = expandBoundaries(
      form(
        [
          field({ name: 'email', semantic: 'email', inputType: 'email', required: true }),
          field({ name: 'message', semantic: 'freeform', inputType: 'textarea' }),
          field({ name: 'amount', semantic: 'currency', inputType: 'number', required: true }),
        ],
        'form-no-attributes',
      ),
      { seed: 'run-1', maxCases: 200 },
    );
    expect(legacy.cases.length).toBeGreaterThan(5);
    for (const testCase of legacy.cases) {
      if (testCase.expectation !== 'rejected') continue;
      const klass = KEYSTONE_FOR_TEST[testCase.equivalenceClass];
      if (klass === null) continue;
      expect(
        ATTRIBUTE_CONSTRAINTS as readonly string[],
        `${testCase.id} asserts a rejection from ${BOUNDARY_DESCRIPTORS[klass].constraint}, which nothing read`,
      ).not.toContain(BOUNDARY_DESCRIPTORS[klass].constraint);
    }
  });
});

/**
 * The same mapping `boundaries.ts` holds privately, restated here.
 *
 * Deliberately a SECOND copy rather than an export: the test's job is to check
 * the module's licence against an independent statement of which keystone class
 * governs which of this file's classes, and importing the module's own answer
 * would make the test agree with itself by construction. If the two ever
 * disagree, one of them is wrong and that is the thing worth finding out.
 */
const KEYSTONE_FOR_TEST: Record<EquivalenceClass, BoundaryClass | null> = {
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

// ─── 2. The keystone expansion ───────────────────────────────────────────────

const BOOKING = form(
  [
    field({ name: 'email', semantic: 'email', inputType: 'email', required: true, maxLength: 64 }),
    field({
      name: 'guests',
      semantic: 'number',
      inputType: 'number',
      required: true,
      min: '1',
      max: '8',
      step: '1',
    }),
    field({
      name: 'arrives',
      semantic: 'date',
      inputType: 'date',
      required: true,
      min: '2026-01-01',
      max: '2026-12-31',
    }),
    field({ name: 'slot', semantic: 'date', inputType: 'datetime-local', required: false }),
    field({ name: 'zip', semantic: 'postal_code', inputType: 'text', required: false }),
    field({ name: 'notes', semantic: 'freeform', inputType: 'textarea', maxLength: null }),
  ],
  'form-booking',
);

const klassesFor = (cases: readonly BoundaryClassCase[], name: string): BoundaryClass[] =>
  cases.filter((c) => c.field === name).map((c) => c.klass);

const findKlass = (
  cases: readonly BoundaryClassCase[],
  name: string,
  klass: BoundaryClass,
): BoundaryClassCase | undefined => cases.find((c) => c.field === name && c.klass === klass);

describe('expandBoundaryClasses partitions each field 27 ways, not once', () => {
  const expansion = expandBoundaryClasses(BOOKING, { seed: 'run-1' });

  it('gives one field many classes, which is the whole difference from the defect', () => {
    // The defect was ONE negative item per FEATURE, derived from the FIRST
    // required field. A six-field form must now yield many classes on several
    // fields, and `email` alone must carry more than one.
    expect(expansion.cases.length).toBeGreaterThan(20);
    expect(new Set(klassesFor(expansion.cases, 'email')).size).toBeGreaterThan(4);
    expect(new Set(expansion.cases.map((c) => c.field)).size).toBeGreaterThan(4);
  });

  it('reaches the classes the one-case item could not express', () => {
    expect(klassesFor(expansion.cases, 'guests')).toContain('OFF_BY_ONE');
    expect(klassesFor(expansion.cases, 'guests')).toContain('NEGATIVE_ZERO');
    expect(klassesFor(expansion.cases, 'guests')).toContain('SCIENTIFIC_NOTATION');
    expect(klassesFor(expansion.cases, 'slot')).toContain('LEAP_DAY');
    expect(klassesFor(expansion.cases, 'arrives')).toContain('FUTURE_DATE');
    expect(klassesFor(expansion.cases, 'slot')).toContain('DST_BOUNDARY');
    expect(klassesFor(expansion.cases, 'notes')).toContain('NULL_BYTE');
    expect(klassesFor(expansion.cases, 'zip')).toContain('LEADING_ZERO');
    expect(klassesFor(expansion.cases, 'email')).toContain('DUPLICATE_OF_EXISTING');
  });

  it('sends the PAIR either side of a bound for OFF_BY_ONE, which is why it exists', () => {
    /*
     * Submitted together, the report can say WHICH SIDE the comparison is wrong
     * on. Either value alone only says something is wrong.
     */
    const pair = findKlass(expansion.cases, 'guests', 'OFF_BY_ONE');
    expect(pair?.value).toBe('8');
    expect(pair?.alsoValue).toBe('9');
    // Every other class sends one value, so a consumer that ignores `alsoValue`
    // is only ever wrong about this one.
    for (const other of expansion.cases.filter((c) => c.klass !== 'OFF_BY_ONE')) {
      expect(other.alsoValue, other.id).toBeNull();
    }
  });

  it('derives its dates from the INJECTED instant and never from today', () => {
    /*
     * The sneaky half of the determinism defect: a date from `new Date()` makes
     * a test that passed yesterday fail today, and nothing in the diff explains
     * it. `slot` declares no range, so its dates are the clock plus a year
     * either way and nothing else moves them.
     */
    const moved = expandBoundaryClasses(BOOKING, {
      seed: 'run-1',
      now: '2030-06-15T12:00:00.000Z',
    });
    expect(findKlass(expansion.cases, 'slot', 'FUTURE_DATE')?.value).toBe('2027-06-15T12:00');
    expect(findKlass(moved.cases, 'slot', 'FUTURE_DATE')?.value).toBe('2031-06-15T12:00');
    // A leap day is 29 February whatever today is.
    expect(findKlass(moved.cases, 'slot', 'LEAP_DAY')?.value).toBe('2024-02-29T12:00');
  });

  it('keeps every date INSIDE the declared range, in both directions', () => {
    /*
     * THE DEFECT THIS PINS, and it bit twice. A naive year ahead of the frozen
     * clock lands on 2027-06-15 at a field declaring `max="2026-12-31"`: a
     * future date AND out of range. The application refuses it for the range,
     * the suite records "a future date is refused", and whether a booking can
     * be made for next week was never asked. The first fix clamped FUTURE_DATE
     * only, and left PAST_DATE with the same bug the other way up.
     */
    for (const run of [
      expansion,
      expandBoundaryClasses(BOOKING, { seed: 'run-1', now: '2030-06-15T12:00:00.000Z' }),
    ]) {
      for (const testCase of run.cases.filter((c) => c.field === 'arrives')) {
        if (!/DATE|LEAP|DST/.test(testCase.klass)) continue;
        expect(testCase.value >= '2026-01-01', `${testCase.id} = ${testCase.value}`).toBe(true);
        expect(testCase.value <= '2026-12-31', `${testCase.id} = ${testCase.value}`).toBe(true);
      }
    }
  });

  it('refuses a fixed date the declared range excludes, rather than asserting it', () => {
    /*
     * The one kind of date that cannot be clamped: moving a leap day stops it
     * being a leap day. 2026 is not a leap year and `arrives` admits no other
     * year, so the honest answer is that this class is not expressible here —
     * NOT an ACCEPTANCE assertion against a correct application that must
     * refuse 2024-02-29 for being out of range.
     */
    expect(klassesFor(expansion.cases, 'arrives')).not.toContain('LEAP_DAY');
    const refusal = expansion.unrepresentable.find(
      (u) => u.field === 'arrives' && u.klass === 'LEAP_DAY',
    );
    expect(refusal?.why).toMatch(/no 29 February/);
    expect(refusal?.why).toMatch(/test the range rather than the date arithmetic/);
  });

  it('names the reason when the clock leaves a date class inexpressible', () => {
    // `max` already behind the reference instant: "a date after today" inside
    // the declared range does not exist, and that is a fact about the page.
    const moved = expandBoundaryClasses(BOOKING, {
      seed: 'run-1',
      now: '2030-06-15T12:00:00.000Z',
    });
    expect(klassesFor(moved.cases, 'arrives')).not.toContain('FUTURE_DATE');
    const refusal = moved.unrepresentable.find(
      (u) => u.field === 'arrives' && u.klass === 'FUTURE_DATE',
    );
    expect(refusal?.why).toMatch(/max="2026-12-31"/);
    expect(refusal?.why).toMatch(/wearing this class's name/);
  });

  it('is byte-identical across calls for one seed', () => {
    expect(expandBoundaryClasses(BOOKING, { seed: 'run-1' })).toEqual(expansion);
  });

  it('changes the values for a different seed, and not the partition', () => {
    const other = expandBoundaryClasses(BOOKING, { seed: 'run-2' });
    expect(other.happyPathValues).not.toEqual(expansion.happyPathValues);
    // The partition of the input space is a property of the FORM, not of the
    // seed, so the classes must be stable even as the values move.
    expect(other.cases.map((c) => c.id)).toEqual(expansion.cases.map((c) => c.id));
  });

  it('carries the precondition DUPLICATE_OF_EXISTING is meaningless without', () => {
    /*
     * "Sign up with an existing email" run against an email nobody registered
     * tests the happy path and reports a negative-case PASS.
     */
    const duplicate = findKlass(expansion.cases, 'email', 'DUPLICATE_OF_EXISTING');
    expect(duplicate?.value).toBe(expansion.happyPathValues.email);
    expect(expansion.preconditions.map((p) => p.klass)).toContain('DUPLICATE_OF_EXISTING');
  });

  it('ranks a CRITICAL class above a LOW one, and never lets the field bump jump a tier', () => {
    const ranks = expansion.cases.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    const low = expansion.cases.filter((c) => c.risk === 'LOW');
    const critical = expansion.cases.filter((c) => c.risk === 'CRITICAL');
    for (const l of low) {
      for (const c of critical) expect(c.rank, `${c.id} vs ${l.id}`).toBeGreaterThan(l.rank);
    }
  });
});

describe('the licence, enforced structurally rather than per call site', () => {
  const expansion = expandBoundaryClasses(BOOKING, { seed: 'run-1' });

  it('never asserts a rejection without the declared value that justifies it', () => {
    /*
     * `basis` is the constraint as READ OFF THE PAGE, and the keystone only
     * puts one on its APPLICABLE arm. So an ASSERT_REJECTION with no basis is
     * structurally impossible — and this is the test that says so, over every
     * case rather than over one.
     */
    for (const testCase of expansion.cases.filter((c) => c.disposition === 'ASSERT_REJECTION')) {
      expect(testCase.basis, testCase.id).not.toBeNull();
      expect(testCase.keystoneExpectation, testCase.id).toBe('REJECTED');
    }
  });

  it('phrases every EXPLORATORY case as a question and never as a demand', () => {
    const exploratory = expansion.cases.filter((c) => c.disposition === 'EXPLORATORY');
    expect(exploratory.length).toBeGreaterThan(0);
    for (const testCase of exploratory) {
      expect(testCase.expected, testCase.id).toMatch(/DO NOT ASSERT A REJECTION/);
      expect(testCase.expected, testCase.id).toMatch(/RECORD what it/);
    }
  });

  it('produces every disposition it declares, so none is dead vocabulary', () => {
    /*
     * The run-time half of the parity guard. Eight `GateRule` kinds shipped
     * unsaveable for two slices because only the compile-time half existed.
     */
    expect([...BOUNDARY_DISPOSITION_LIST].sort()).toEqual([...BOUNDARY_DISPOSITIONS].sort());
    const seen = new Set(expansion.cases.map((c) => c.disposition));
    for (const disposition of BOUNDARY_DISPOSITION_LIST) {
      expect(seen, `${disposition} is never produced`).toContain(disposition);
    }
  });

  it("REFUSES to claim a card-number field accepts O'Brien", () => {
    /*
     * THE REGRESSION, NAMED. The keystone admits SQL_META on any textual field
     * and its descriptor expects ACCEPTED_NORMALISED at CRITICAL risk — so an
     * ungated expansion put "a card-number field must ACCEPT O'Brien" at the
     * TOP of the ranking. That is a generated test that fails against a CORRECT
     * payment form, with the bug report landing on the application team.
     */
    const card = form(
      [field({ name: 'cardNumber', semantic: 'credit_card', inputType: 'text', required: true })],
      'form-card',
    );
    const { cases, unrepresentable } = expandBoundaryClasses(card, { seed: 'run-1' });
    expect(klassesFor(cases, 'cardNumber')).not.toContain('SQL_META');
    expect(klassesFor(cases, 'cardNumber')).not.toContain('HTML_META');
    // Refused, not forgotten: the reason is on the record and names the remedy.
    const refusal = unrepresentable.find((u) => u.klass === 'SQL_META');
    expect(refusal?.why).toMatch(/fixed format/);
    expect(refusal?.why).toMatch(/WRONG_TYPE/);
    // And the class that CAN be defended on a card field is still there.
    expect(klassesFor(cases, 'cardNumber')).toContain('CHECKSUM_INVALID');
    expect(klassesFor(cases, 'cardNumber')).toContain('NULL_BYTE');
  });

  it('still asserts acceptance where it IS defensible', () => {
    // O'Brien must be able to sign up. A form that refuses an apostrophe in a
    // surname has confused escaping with validation.
    const name = form(
      [field({ name: 'fullName', semantic: 'person_name', inputType: 'text', required: true })],
      'form-name',
    );
    const { cases } = expandBoundaryClasses(name, { seed: 'run-1' });
    const sql = findKlass(cases, 'fullName', 'SQL_META');
    expect(sql?.value).toBe("O'Brien");
    expect(sql?.disposition).toBe('ASSERT_ACCEPTANCE');
    expect(sql?.expected).toMatch(/ACCEPTED/);
  });

  it('refuses a text case a DECLARED maxlength would reject for length instead', () => {
    /*
     * Two possible causes is the one thing this file exists to prevent. An
     * eleven-character `<b>qaai</b>` at a maxlength=6 field is refused, the
     * suite records "HTML metacharacters are rejected", and the escaping is
     * never actually tested.
     */
    const narrow = form(
      [field({ name: 'nickname', semantic: 'freeform', inputType: 'text', maxLength: 6 })],
      'form-narrow',
    );
    const { cases, unrepresentable } = expandBoundaryClasses(narrow, { seed: 'run-1' });
    expect(klassesFor(cases, 'nickname')).not.toContain('HTML_META');
    const refusal = unrepresentable.find((u) => u.klass === 'HTML_META');
    expect(refusal?.why).toMatch(/maxlength=6/);
    expect(refusal?.why).toMatch(/two causes/);
  });
});

describe('the keystone expansion accounts for everything it did not return', () => {
  const expansion = expandBoundaryClasses(BOOKING, { seed: 'run-1' });

  it('accounts for every pair it considered: the parts sum to the whole', () => {
    /*
     * The honest denominator. A number that cannot be reconstructed from its
     * parts is a number nobody can audit, and this is the arithmetic that keeps
     * "27 classes per field" from quietly becoming "whatever survived".
     */
    expect(
      expansion.cases.length +
        expansion.inapplicable +
        expansion.unreadConstraints +
        expansion.unrepresentable.length +
        expansion.omittedByCap,
    ).toBe(expansion.considered);
    expect(expansion.considered).toBe(BOOKING.fields.length * 27);
  });

  it('NAMES the unread constraints, and the names total the keystone count', () => {
    /*
     * OUR gap, counted separately from the customer's field shapes and then
     * made actionable: "11 classes were unreachable" tells a customer nothing,
     * while "`maxlength` was never read on zip" tells them which crawl to run.
     */
    const total = expansion.recrawl.reduce((sum, r) => sum + r.classesBlocked, 0);
    expect(total).toBe(expansion.unreadConstraints);
    expect(expansion.recrawl.map((r) => `${r.field}/${r.constraint}`)).toContain('zip/maxLength');
    for (const obligation of expansion.recrawl)
      expect(obligation.classesBlocked).toBeGreaterThan(0);
  });

  it('DISCLOSES the cap as a count and a reason', () => {
    const capped = expandBoundaryClasses(BOOKING, { seed: 'run-1', maxCases: 5 });
    expect(capped.cases).toHaveLength(5);
    expect(capped.omittedByCap).toBe(expansion.cases.length - 5);
    expect(capped.capReason).toMatch(/at least \d+ more APPLICABLE cases existed/);
    expect(capped.capReason).toMatch(/raise maxCases/);
  });

  it('never reports a shortfall with no reason beside it, or a reason with no shortfall', () => {
    for (const run of [expansion, expandBoundaryClasses(BOOKING, { seed: 'run-1', maxCases: 3 })]) {
      expect(run.omittedByCap > 0).toBe(run.capReason !== null);
    }
  });

  it('drops the obligations of cases the cap removed, rather than keeping orphans', () => {
    // A precondition for a case nobody will run is not an obligation; leaving
    // it would make a scenario create data no test consumes.
    const capped = expandBoundaryClasses(BOOKING, { seed: 'run-1', maxCases: 1 });
    const fields = new Set(capped.cases.map((c) => c.field));
    for (const precondition of capped.preconditions) {
      expect(fields).toContain(precondition.establishedBy);
    }
  });

  it('gives every unrepresentable candidate a sentence, never a bare count', () => {
    for (const entry of expansion.unrepresentable) {
      expect(entry.why.length, `${entry.field}/${entry.klass}`).toBeGreaterThan(40);
      expect(entry.why, `${entry.field}/${entry.klass}`).not.toMatch(/TODO|TBD/i);
    }
  });

  it('warns, first, when some OTHER field has no valid value', () => {
    // Each case submits the WHOLE form, so one unfillable field means every
    // case carries two bad values and nothing can be attributed.
    const broken = form(
      [
        field({
          name: 'email',
          semantic: 'email',
          inputType: 'email',
          required: true,
          maxLength: 6,
        }),
      ],
      'form-broken-class',
    );
    const { caveats } = expandBoundaryClasses(broken, { seed: 'run-1' });
    expect(caveats[0]).toMatch(/^READ THIS FIRST/);
    expect(caveats[0]).toMatch(/cannot be attributed/);
  });

  it('returns nothing for a form with no fields rather than inventing a partition', () => {
    const empty = expandBoundaryClasses(form([], 'form-empty-class'), { seed: 'run-1' });
    expect(empty.cases).toEqual([]);
    expect(empty.considered).toBe(0);
    expect(empty.capReason).toBeNull();
  });
});

// ─── 3. API negatives from the declared schema ───────────────────────────────

/**
 * An OpenAPI-shaped operation whose declaration is rich enough to exercise the
 * whole derivation: a nested array of objects, a format, a pattern, a closed
 * enum, and `additionalProperties: false`.
 *
 * Deliberately a LITERAL and not a fixture file. There is no HTTP client, no
 * document fetch and no Prisma delegate anywhere in the module under test —
 * which is the property 629 lines of untested crawler cost this repo — so a
 * literal is the whole harness.
 */
const ORDER_BODY = {
  type: 'object',
  required: ['sku', 'channel'],
  additionalProperties: false,
  properties: {
    sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{4}$', maxLength: 8 },
    channel: { type: 'string', enum: ['web', 'app', 'phone'] },
    contact: { type: 'string', format: 'email' },
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'object', properties: { qty: { type: 'integer', minimum: 1, maximum: 99 } } },
    },
  },
};

const readOperation = (over: Partial<ApiOperationDeclaration> = {}): ApiOperationDeclaration => ({
  method: 'GET',
  pathTemplate: '/orders',
  parameters: [
    { name: 'page', location: 'QUERY', required: true, type: 'integer', minimum: 1, maximum: 100 },
  ],
  requestShape: null,
  responseShapes: { '200': {}, '400': {} },
  ...over,
});

const writeOperation = (over: Partial<ApiOperationDeclaration> = {}): ApiOperationDeclaration => ({
  method: 'POST',
  pathTemplate: '/orders',
  parameters: [],
  requestShape: ORDER_BODY,
  responseShapes: { '201': {}, '422': {} },
  ...over,
});

describe('the mechanical negatives a declared schema makes free', () => {
  const expansion = expandApiBoundaries(writeOperation(), { seed: 'run-1' });
  const klasses = new Set(expansion.cases.map((c) => c.klass));

  it('derives every class the declaration justifies, not just the required one', () => {
    /*
     * The defect: neither the API nor the CONTRACT lane derived a single
     * invalid or edge-of-range input from the declared schema, though the
     * schema has been on `ApiOperation.requestShape` since ENUMERATE imported
     * it.
     */
    for (const klass of [
      'REQUIRED_OMITTED',
      'TYPE_VIOLATION',
      'FORMAT_VIOLATION',
      'PATTERN_VIOLATION',
      'NULL_FOR_NON_NULLABLE',
      'ABOVE_MAX_LENGTH',
      'OUTSIDE_ENUM',
      'ARRAY_BELOW_MIN_ITEMS',
      'ARRAY_ABOVE_MAX_ITEMS',
      'ADDITIONAL_PROPERTY',
      'BELOW_MINIMUM',
      'ABOVE_MAXIMUM',
    ] as const) {
      expect(klasses, `no case for ${klass}`).toContain(klass);
    }
  });

  it('DESCENDS the body below the top level, which nothing did before', () => {
    /*
     * `bodyBounds` in packages/agent/src/api-surface.ts reads the TOP LEVEL of
     * a request body and records NESTED_SHAPE_NOT_DESCENDED for everything
     * under it — so `minimum: 1` on an array item's `qty` was absent from the
     * operation rather than stated as none. These are the cases that gap cost.
     */
    const nested = expansion.cases.filter((c) => c.target.includes('/items/properties/qty'));
    expect(nested.map((c) => c.klass)).toContain('BELOW_MINIMUM');
    expect(nested.map((c) => c.klass)).toContain('ABOVE_MAXIMUM');
    expect(nested.find((c) => c.klass === 'BELOW_MINIMUM')?.value).toBe(0);
    expect(nested.find((c) => c.klass === 'ABOVE_MAXIMUM')?.value).toBe(100);
  });

  it('reads `required` off the PARENT, which is the only node that knows it', () => {
    // JSON Schema puts the required list on the object, not on the property. A
    // child reading its own node always sees `required: undefined`, and every
    // omission case silently vanishes.
    const omitted = expansion.cases.filter((c) => c.klass === 'REQUIRED_OMITTED');
    expect(omitted.map((c) => c.target)).toContain('#/properties/sku');
    expect(omitted.map((c) => c.target)).toContain('#/properties/channel');
    // `contact` is not in the required list, so its absence is legal.
    expect(omitted.map((c) => c.target)).not.toContain('#/properties/contact');
  });

  it('says HOW each value must be sent, because the type cannot say', () => {
    /*
     * `0` is a literal zero for BELOW_MINIMUM and an array of no items for
     * ARRAY_BELOW_MIN_ITEMS; `null` is "omit the field" for REQUIRED_OMITTED
     * and JSON `null` for NULL_FOR_NON_NULLABLE. A generator reading `value`
     * alone sends the wrong request for four of the eighteen classes, and three
     * of those then pass.
     */
    const meaning = (klass: string): string | undefined =>
      expansion.cases.find((c) => c.klass === klass)?.valueMeaning;
    expect(meaning('ARRAY_BELOW_MIN_ITEMS')).toBe('ITEM_COUNT');
    expect(meaning('BELOW_MINIMUM')).toBe('LITERAL');
    expect(meaning('REQUIRED_OMITTED')).toBe('OMIT');
    expect(meaning('NULL_FOR_NON_NULLABLE')).toBe('JSON_NULL');
    expect(meaning('ABOVE_MAX_LENGTH')).toBe('STRING_LENGTH');
    expect(meaning('ADDITIONAL_PROPERTY')).toBe('PROPERTY_NAME');
    for (const testCase of expansion.cases) {
      expect(API_VALUE_MEANINGS as readonly string[], testCase.id).toContain(testCase.valueMeaning);
    }
  });

  it('generates NOTHING for a format it does not recognise', () => {
    /*
     * An unrecognised `format` is not a constraint we read — it is a word we do
     * not understand. OpenAPI lets a document declare `format: "sku"`, and a
     * test that sends "not-a-sku" and asserts a rejection asserts a rule QAAI
     * invented. That is the failure the whole applicability rule exists to stop.
     */
    const invented = expandApiBoundaries(
      readOperation({
        parameters: [{ name: 'code', location: 'QUERY', required: false, type: 'string/sku' }],
      }),
      { seed: 'run-1' },
    );
    expect(invented.cases.map((c) => c.klass)).not.toContain('FORMAT_VIOLATION');
    // And it still derives the type violation, which the declaration DOES give.
    expect(invented.cases.map((c) => c.klass)).toContain('TYPE_VIOLATION');
  });

  it('derives no additionalProperties case from a default nobody wrote', () => {
    // JSON Schema's own default is that extra properties are ALLOWED, so
    // asserting a rejection from an unstated keyword is asserting from silence
    // — the same argument `boundaryEdges` makes about `required: null`.
    const unstated = expandApiBoundaries(
      writeOperation({ requestShape: { type: 'object', properties: { sku: { type: 'string' } } } }),
      { seed: 'run-1' },
    );
    expect(unstated.cases.map((c) => c.klass)).not.toContain('ADDITIONAL_PROPERTY');
  });

  it('is reproducible from the seed, which is what makes a fuzz case a test', () => {
    expect(expandApiBoundaries(writeOperation(), { seed: 'run-1' })).toEqual(expansion);
    const other = expandApiBoundaries(writeOperation(), { seed: 'run-2' });
    // The partition is a property of the DOCUMENT; only the tokens inside the
    // generated values move with the seed.
    expect(other.cases.map((c) => `${c.klass}:${c.target}`)).toEqual(
      expansion.cases.map((c) => `${c.klass}:${c.target}`),
    );
    const token = (run: typeof expansion): unknown =>
      run.cases.find((c) => c.klass === 'ADDITIONAL_PROPERTY')?.value;
    expect(token(other)).not.toEqual(token(expansion));
  });
});

describe('an API negative is read-only unless the document says otherwise', () => {
  it('REFUSES an unsafe-verb case with no declared rejection, and records every one', () => {
    /*
     * Nothing says the request would be refused, so sending it might write a
     * record in the customer's database — and a probe that mutates data is not
     * a probe. The report must be able to say THIS CHECK WAS NOT PERFORMED,
     * which is a different thing from a surface that does not exist.
     */
    const undeclared = expandApiBoundaries(writeOperation({ responseShapes: { '201': {} } }), {
      seed: 'run-1',
    });
    expect(undeclared.cases).toEqual([]);
    expect(undeclared.refused.length).toBe(undeclared.considered);
    expect(undeclared.refused.map((r) => r.reason)).toContain('UNSAFE_VERB_UNDECLARED_OUTCOME');
    for (const refusal of undeclared.refused) {
      expect(refusal.detail.length, refusal.klass).toBeGreaterThan(40);
      // The remedy is named, so the refusal is actionable and not a dead end.
      expect(refusal.detail, refusal.klass).toMatch(/allowUnsafeVerbs|not emitted/);
    }
  });

  it('admits the same case when the document declares the request is refused', () => {
    /*
     * The customer's own declaration is the statement that nothing will be
     * written — and if the API writes anyway, that write IS the defect this
     * test reports rather than a side effect the test caused.
     */
    const declared = expandApiBoundaries(writeOperation(), { seed: 'run-1' });
    expect(declared.cases.length).toBeGreaterThan(10);
    for (const testCase of declared.cases) {
      expect(testCase.declaredRejectionStatus, testCase.id).toBe('422');
      expect(testCase.disposition, testCase.id).not.toBe('ASSERT_ACCEPTANCE');
    }
  });

  it('refuses a VALID edge value on an unsafe verb, because it would create a record', () => {
    /*
     * AT_MAXIMUM on a POST is a perfectly valid request, and sending it creates
     * a row. That is a scenario with a disposable principal and a cleanup
     * obligation, not a read-only probe — so it is refused here even though the
     * operation declares a 422.
     */
    const declared = expandApiBoundaries(writeOperation(), { seed: 'run-1' });
    const byPolicy = declared.refused.filter((r) => r.reason === 'UNSAFE_VERB_BY_POLICY');
    expect(byPolicy.length).toBeGreaterThan(0);
    expect(byPolicy.map((r) => r.klass)).toContain('AT_MAX_LENGTH');
    expect(byPolicy[0]?.detail).toMatch(/disposable principal/);
    expect(declared.cases.map((c) => c.klass)).not.toContain('AT_MAX_LENGTH');
  });

  it('sends every case on a SAFE verb, because a GET changes nothing', () => {
    const safe = expandApiBoundaries(readOperation(), { seed: 'run-1' });
    expect(safe.refused).toEqual([]);
    expect(safe.cases.length).toBe(safe.considered);
    expect(safe.cases.map((c) => c.klass)).toContain('AT_MINIMUM');
  });

  it("widens only on the CUSTOMER's policy, which lives on a row and not in the env", () => {
    const allowed = expandApiBoundaries(writeOperation({ responseShapes: { '201': {} } }), {
      seed: 'run-1',
      policy: { allowUnsafeVerbs: true },
    });
    expect(allowed.cases.length).toBeGreaterThan(10);
    expect(allowed.refused.filter((r) => r.reason !== 'CAP_APPLIED')).toEqual([]);
  });

  it('accounts for every pair: admitted plus refused is everything considered', () => {
    /*
     * A failure suppressed without being counted is one of the lies this
     * product cannot afford, and a refusal is exactly that shape. The sum is
     * what makes "we checked N things" auditable.
     */
    for (const operation of [
      readOperation(),
      writeOperation(),
      writeOperation({ responseShapes: null }),
    ]) {
      const run = expandApiBoundaries(operation, { seed: 'run-1' });
      const capped = run.refused.filter((r) => r.reason === 'CAP_APPLIED').length;
      expect(run.cases.length + run.refused.length - capped + run.omittedByCap).toBe(
        run.considered,
      );
    }
  });
});

describe('the API expansion never invents a status, a limit or a reading', () => {
  it('asserts the DECLARED status and nothing else', () => {
    const declared = expandApiBoundaries(
      readOperation({ responseShapes: { '200': {}, '409': {} } }),
      {
        seed: 'run-1',
      },
    );
    const rejection = declared.cases.find((c) => c.disposition === 'ASSERT_REJECTION');
    expect(rejection?.declaredRejectionStatus).toBe('409');
    expect(rejection?.expected).toMatch(/status is 409/);
  });

  it('falls back to EXPLORATORY when the document declares no error response', () => {
    /*
     * Asserting 400 against an API that correctly answers 422 is a failure QAAI
     * caused. The honest assertion is the weaker one, and it says so.
     */
    const silent = expandApiBoundaries(readOperation({ responseShapes: { '200': {} } }), {
      seed: 'run-1',
    });
    const probe = silent.cases.find((c) => c.klass === 'BELOW_MINIMUM');
    expect(probe?.disposition).toBe('EXPLORATORY');
    expect(probe?.declaredRejectionStatus).toBeNull();
    expect(probe?.expected).toMatch(/DO NOT ASSERT A STATUS/);
    expect(probe?.expected).toMatch(/RECORD the status/);
  });

  it('reads a 4xx as a declared refusal and a 5xx as no such declaration', () => {
    // A declared 500 is not a promise to reject bad input; it is a promise to
    // fail. Treating it as a rejection would assert that malformed input
    // crashes the API, which is the opposite of the claim.
    const serverError = expandApiBoundaries(
      readOperation({ responseShapes: { '200': {}, '500': {} } }),
      {
        seed: 'run-1',
      },
    );
    expect(serverError.cases.every((c) => c.declaredRejectionStatus === null)).toBe(true);
    const wildcard = expandApiBoundaries(
      readOperation({ responseShapes: { '200': {}, '4XX': {} } }),
      {
        seed: 'run-1',
      },
    );
    expect(wildcard.cases[0]?.declaredRejectionStatus).toBe('4XX');
  });

  it('reports a composed schema as NOT READ, never as an API with no limits', () => {
    /*
     * "This API declares no limits on anything" is the most flattering possible
     * wrong answer, because it suppresses every negative test the document
     * actually entitles us to write. `parameterBound` makes the same argument
     * about Swagger 2.0 layouts.
     */
    const composed = expandApiBoundaries(
      writeOperation({
        /*
         * Siblings ON PURPOSE. A composed node with nothing beside it derives
         * nothing either way, so a fixture without them cannot tell "returned
         * early" from "walked on and found nothing" — a mutation that replaced
         * the early return with a `break` survived exactly that fixture. With a
         * sibling `properties`, walking on would derive `sku`'s maxLength and
         * present a PARTIAL reading of the declaration as the whole of it.
         */
        requestShape: {
          type: 'object',
          allOf: [{ type: 'object' }, ORDER_BODY],
          required: ['sku'],
          properties: { sku: { type: 'string', maxLength: 4 } },
        },
      }),
      { seed: 'run-1' },
    );
    expect(composed.cases).toEqual([]);
    expect(composed.cases.map((c) => c.target)).not.toContain('#/properties/sku');
    expect(composed.notRead.join(' ')).toMatch(/allOf/);
    expect(composed.notRead.join(' ')).toMatch(/absent rather than stated as none/);
  });

  it('reports an unresolved $ref as NOT READ', () => {
    const referenced = expandApiBoundaries(
      writeOperation({ requestShape: { $ref: '#/components/schemas/Order' } }),
      { seed: 'run-1' },
    );
    expect(referenced.notRead.join(' ')).toMatch(/\$ref/);
    expect(referenced.notRead.join(' ')).toMatch(/Order/);
  });

  it('stops at a declared depth and says where it stopped', () => {
    let deep: Record<string, unknown> = { type: 'string', maxLength: 4 };
    for (let level = 0; level < 10; level += 1) {
      deep = { type: 'object', properties: { child: deep } };
    }
    const nested = expandApiBoundaries(writeOperation({ requestShape: deep }), { seed: 'run-1' });
    expect(nested.notRead.join(' ')).toMatch(/the walk stops at depth/);
    // The deepest property's own maxLength is therefore NOT claimed as absent.
    expect(nested.cases.map((c) => c.klass)).not.toContain('ABOVE_MAX_LENGTH');
  });

  it('DISCLOSES the cap as a count and a reason, and never one without the other', () => {
    const capped = expandApiBoundaries(writeOperation(), {
      seed: 'run-1',
      policy: { maxCases: 4 },
    });
    expect(capped.cases).toHaveLength(4);
    expect(capped.omittedByCap).toBeGreaterThan(0);
    expect(capped.capReason).toMatch(/at least \d+ more were derivable/);
    expect(capped.refused.map((r) => r.reason)).toContain('CAP_APPLIED');
    const uncapped = expandApiBoundaries(writeOperation(), { seed: 'run-1' });
    expect(uncapped.omittedByCap).toBe(0);
    expect(uncapped.capReason).toBeNull();
  });

  it('returns an empty expansion for an operation that declares nothing', () => {
    const bare = expandApiBoundaries(
      {
        method: 'GET',
        pathTemplate: '/health',
        parameters: [],
        requestShape: null,
        responseShapes: null,
      },
      { seed: 'run-1' },
    );
    expect(bare.cases).toEqual([]);
    expect(bare.considered).toBe(0);
    expect(bare.capReason).toBeNull();
    // Nothing declared is NOT the same as nothing found, and neither is
    // reported as a pass.
    expect(bare.refused).toEqual([]);
  });
});

describe('API vocabulary parity', () => {
  it('derives each list from its presence record rather than hand-listing it', () => {
    /*
     * The run-time half of the guard. Eight `GateRule` kinds shipped unsaveable
     * for two slices because only the compile-time half existed.
     */
    expect([...API_NEGATIVE_CLASS_LIST].sort()).toEqual([...API_NEGATIVE_CLASSES].sort());
    expect([...API_REFUSAL_REASON_LIST].sort()).toEqual([...API_REFUSAL_REASONS].sort());
    expect([...API_VALUE_MEANING_LIST].sort()).toEqual([...API_VALUE_MEANINGS].sort());
  });

  it('can actually produce every refusal reason it declares', () => {
    const seen = new Set<string>();
    for (const run of [
      expandApiBoundaries(writeOperation({ responseShapes: { '201': {} } }), { seed: 'run-1' }),
      expandApiBoundaries(writeOperation(), { seed: 'run-1' }),
      expandApiBoundaries(writeOperation(), { seed: 'run-1', policy: { maxCases: 2 } }),
    ]) {
      for (const refusal of run.refused) seen.add(refusal.reason);
    }
    for (const reason of API_REFUSAL_REASON_LIST) {
      expect(seen, `${reason} is declared and never produced`).toContain(reason);
    }
  });

  it('uses a known class and a stable, unique id for every case', () => {
    const run = expandApiBoundaries(writeOperation(), { seed: 'run-1' });
    const ids = run.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of run.cases) {
      expect(API_NEGATIVE_CLASSES as readonly string[]).toContain(testCase.klass);
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/);
      // Every case says why it exists and what to assert, for the reviewer
      // about to delete it.
      expect(testCase.reason.length, testCase.id).toBeGreaterThan(20);
      expect(testCase.expected.length, testCase.id).toBeGreaterThan(40);
    }
  });
});
