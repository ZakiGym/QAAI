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
    const reasons = reasonsFor({ pattern: null, minLength: null, min: null, max: null, step: null });
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
          { name: 'order', label: 'Order number', inputType: 'text', required: true, semantic: 'freeform' },
          { name: 'amount', label: 'Amount', inputType: 'number', required: true, semantic: 'currency', min: '1', max: '500' },
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
