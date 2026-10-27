/**
 * Tests for the field, rule, component and component-state denominators.
 *
 * Every test here is named after a DEFECT it would catch, because the thing
 * being measured is a sentence a customer is told and the failure mode is not
 * being slightly wrong — it is being confidently wrong in the direction that
 * flatters the vendor. The four groups the file is arranged in:
 *
 *   1. PARITY. Two mechanisms per vocabulary, because `check:wiring` cannot see
 *      a kind the compiler accepts and no producer can mint.
 *   2. THE DEFECT ITSELF. A fourteen-field form is fourteen cells, a fill is
 *      not an assertion, and `required` and `semantic` are counted.
 *   3. THE HONESTY RULES. Null is not zero, unmeasured is not uncovered, a cap
 *      that bit is disclosed as a count, written is not run.
 *   4. THE WRITE PATH. Every row this module emits is parsed through the real
 *      `coverageFormFieldSchema` / `coverageItemStateSchema`, because a
 *      measurement with no door is a measurement that cannot ship.
 */

import { describe, expect, it } from 'vitest';
import {
  CELL_KIND_DIMENSION,
  COMPONENT_STATE_KINDS,
  COVERAGE_DIMENSIONS,
  COVERAGE_DIMENSION_DESCRIPTORS,
  COVERAGE_TIERS,
  DIMENSION_UNMEASURED_REASONS,
  FORM_FIELD_SEMANTICS,
  SURFACE_KINDS,
  cellKindsFor,
  coverageFormFieldSchema,
  coverageItemStateSchema,
  dimensionMeasurementSchema,
  parseDimensionCellIdentity,
  type CoverageTier,
  type DimensionUnmeasuredReason,
} from '@qaai/shared';
import {
  COMPONENT_STATE_CELL_KINDS,
  FIELD_COVERAGE_DIMENSIONS,
  FIELD_COVERAGE_DIMENSION_KINDS,
  SEMANTIC_RULE_SLUGS,
  VALIDATION_RULE_CELL_KIND,
  VALIDATION_RULE_LABELS,
  VALIDATION_RULE_SLUGS,
  analyseFieldCoverage,
  componentCellKey,
  componentStateCellKey,
  fieldCoverageCellKinds,
  fieldCoveragePercentAt,
  formFieldCellKey,
  validationRuleCellKey,
  type CellObservation,
  type ComponentCoverageItem,
  type FieldCoverageField,
  type FieldCoverageForm,
  type FieldCoverageInput,
  type FieldCoverageResult,
  type FieldCoverageTest,
  type FormFieldConstraintReading,
} from './coverage-fields.js';

const NOW = '2026-10-26T12:00:00.000Z';

// ─── Builders ───────────────────────────────────────────────────────────────

const NO_CONSTRAINTS: FormFieldConstraintReading = {
  maxLength: null,
  minLength: null,
  min: null,
  max: null,
  step: null,
  pattern: null,
};

function field(over: Partial<FieldCoverageField> = {}): FieldCoverageField {
  return {
    name: 'email',
    label: 'Email',
    inputType: 'email',
    required: false,
    semantic: 'freeform',
    constraint: NO_CONSTRAINTS,
    constraintsRead: true,
    ...over,
  };
}

function form(over: Partial<FieldCoverageForm> = {}): FieldCoverageForm {
  return {
    itemKey: 'FORM:/checkout#0',
    name: 'Checkout',
    route: '/checkout',
    source: 'CRAWL',
    fields: [field()],
    ...over,
  };
}

function test(over: Partial<FieldCoverageTest> = {}): FieldCoverageTest {
  return { id: 't1', code: '', routes: ['/checkout'], ...over };
}

function component(over: Partial<ComponentCoverageItem> = {}): ComponentCoverageItem {
  return {
    itemKey: 'COMPONENT_STATE:src/Button.tsx#Button',
    modulePath: 'src/Button.tsx',
    exportName: 'Button',
    kind: 'COMPONENT',
    source: 'SOURCE',
    hasCatalogueEntry: false,
    states: [{ kind: 'DEFAULT', source: 'SOURCE', evidence: 'renders its children' }],
    ...over,
  };
}

function run(over: Partial<FieldCoverageInput> = {}): FieldCoverageResult {
  return analyseFieldCoverage({
    forms: [],
    components: [],
    tests: [],
    dialect: 'JS_EXPECT',
    nowIso: NOW,
    ...over,
  });
}

/** The rows for one dimension, so a test does not have to filter by hand. */
function rowsFor(result: FieldCoverageResult, dimension: string) {
  return result.formFieldRows.filter((row) => CELL_KIND_DIMENSION[row.kind] === dimension);
}

// ─── 1. Parity ──────────────────────────────────────────────────────────────

describe('the vocabularies this module owns', () => {
  it('keeps the presence record and the dimension list in step', () => {
    expect([...FIELD_COVERAGE_DIMENSION_KINDS].sort()).toEqual([...FIELD_COVERAGE_DIMENSIONS].sort());
  });

  it('measures only dimensions the keystone declares, each refining a real axis', () => {
    for (const dimension of FIELD_COVERAGE_DIMENSIONS) {
      expect(COVERAGE_DIMENSIONS).toContain(dimension);
      const descriptor = COVERAGE_DIMENSION_DESCRIPTORS[dimension];
      expect(descriptor.refines.length).toBeGreaterThan(0);
      for (const axis of descriptor.refines) expect(SURFACE_KINDS).toContain(axis);
    }
  });

  it('files every rule slug on the VALIDATION_RULE denominator and nowhere else', () => {
    for (const slug of VALIDATION_RULE_SLUGS) {
      expect(CELL_KIND_DIMENSION[VALIDATION_RULE_CELL_KIND[slug]]).toBe('VALIDATION_RULE');
      expect(VALIDATION_RULE_LABELS[slug].length).toBeGreaterThan(0);
    }
  });

  /*
   * THE MIRROR, and the one that actually bites. A RULE_* cell kind the
   * keystone declares and no slug here can produce is a cell with no possible
   * evidence: it would sit in `cellKindsFor('VALIDATION_RULE')`, be rendered as
   * an axis, and never receive a row.
   */
  it('can mint every VALIDATION_RULE cell kind the keystone declares', () => {
    const minted = new Set(VALIDATION_RULE_SLUGS.map((slug) => VALIDATION_RULE_CELL_KIND[slug]));
    for (const kind of cellKindsFor('VALIDATION_RULE')) expect(minted).toContain(kind);
  });

  it('pins the component-state cell kinds to api-surface member for member', () => {
    expect(COMPONENT_STATE_CELL_KINDS.length).toBe(COMPONENT_STATE_KINDS.length);
    expect([...COMPONENT_STATE_CELL_KINDS].sort()).toEqual([...cellKindsFor('COMPONENT_STATE')].sort());
  });

  it('declares a rule list for every semantic flow-map.ts knows', () => {
    for (const semantic of FORM_FIELD_SEMANTICS) {
      const slugs = SEMANTIC_RULE_SLUGS[semantic];
      expect(Array.isArray(slugs)).toBe(true);
      for (const slug of slugs) expect(VALIDATION_RULE_SLUGS).toContain(slug);
    }
  });

  it('reports exactly the cell kinds of its own four dimensions', () => {
    const kinds = fieldCoverageCellKinds();
    for (const kind of kinds) {
      expect(FIELD_COVERAGE_DIMENSIONS).toContain(CELL_KIND_DIMENSION[kind]);
    }
    expect(kinds).toContain('FORM_FIELD');
    expect(kinds).toContain('RULE_REQUIRED');
    expect(kinds).toContain('COMPONENT');
    expect(kinds).toContain('COMPONENT_LOADING');
  });
});

// ─── 2. The defect itself ───────────────────────────────────────────────────

describe('a form is no longer one boolean', () => {
  const threeFields = form({
    fields: [
      field({ name: 'email', label: 'Email' }),
      field({ name: 'card', label: 'Card number' }),
      field({ name: 'cvc', label: 'CVC' }),
    ],
  });

  const fillsEmail = test({
    code: ["await page.getByLabel('Email').fill('buyer@example.com');", "await expect(page).toHaveURL('/done');"].join(
      '\n',
    ),
  });

  it('counts one cell per field instead of one tick per form', () => {
    const result = run({ forms: [threeFields], tests: [fillsEmail] });
    expect(result.measurements.FORM_FIELD.cells).toBe(3);
    expect(result.measurements.FORM_FIELD.measured).toBe(3);
    // The old code marked the WHOLE form exercised off this one fill.
    expect(result.measurements.FORM_FIELD.tiers.unclaimed).toBe(2);
    expect(fieldCoveragePercentAt(result, 'FORM_FIELD', 'DECLARED')).toBeCloseTo(33.3, 1);
  });

  it('claims the field that was filled and not its neighbours', () => {
    const result = run({ forms: [threeFields], tests: [fillsEmail] });
    const byKey = new Map(rowsFor(result, 'FORM_FIELD').map((row) => [row.fieldKey, row]));
    expect(byKey.get(formFieldCellKey(threeFields.itemKey, 'email'))?.tier).toBe('DECLARED');
    expect(byKey.get(formFieldCellKey(threeFields.itemKey, 'card'))?.tier).toBeNull();
    expect(byKey.get(formFieldCellKey(threeFields.itemKey, 'cvc'))?.tier).toBeNull();
  });

  /*
   * THE HEADLINE RULE. Filling the email box says nothing about what happens
   * when the box is left empty, so the `required` rule stays unclaimed. This is
   * the one assertion that separates this module from the boolean it replaces.
   */
  it('does not let a fill claim the rule derived from the field', () => {
    const required = form({ fields: [field({ required: true })] });
    const result = run({ forms: [required], tests: [fillsEmail] });
    const rule = rowsFor(result, 'VALIDATION_RULE').find((row) => row.kind === 'RULE_REQUIRED');
    expect(rule?.tier).toBeNull();
    expect(result.measurements.VALIDATION_RULE.tiers.unclaimed).toBe(1);
    expect(result.caveats.join(' ')).toContain('has not asserted what happens when the rule is broken');
  });

  it('claims the required rule when a test submits it empty and asserts', () => {
    const required = form({ fields: [field({ required: true })] });
    const asserts = test({
      code: [
        "await page.getByLabel('Email').fill('');",
        "await expect(page.getByText('Email is required')).toBeVisible();",
      ].join('\n'),
    });
    const result = run({ forms: [required], tests: [asserts] });
    const rule = rowsFor(result, 'VALIDATION_RULE').find((row) => row.kind === 'RULE_REQUIRED');
    expect(rule?.tier).toBe('DECLARED');
  });

  it('never sums the four denominators', () => {
    const result = run({
      forms: [threeFields],
      components: [component({ states: [{ kind: 'ERROR', source: 'SOURCE', evidence: 'renders an alert' }] })],
      tests: [fillsEmail],
    });
    expect(result.measurements.FORM_FIELD.cells).toBe(3);
    expect(result.measurements.COMPONENT.cells).toBe(1);
    expect(result.measurements.COMPONENT_STATE.cells).toBe(1);
    // Adding a component moved nothing on the form axes, which is what makes
    // these four figures comparable across runs.
    const formsOnly = run({ forms: [threeFields], tests: [fillsEmail] });
    expect(result.measurements.FORM_FIELD).toEqual(formsOnly.measurements.FORM_FIELD);
    expect(result.measurements.VALIDATION_RULE).toEqual(formsOnly.measurements.VALIDATION_RULE);
  });
});

describe('required, the boundary case nobody counted', () => {
  it('mints a measured cell when the field is required', () => {
    const result = run({ forms: [form({ fields: [field({ required: true })] })] });
    expect(result.measurements.VALIDATION_RULE.measured).toBe(1);
    expect(result.measurements.VALIDATION_RULE.unmeasured).toBe(0);
  });

  it('mints NO cell when a reader looked and the field is optional', () => {
    const result = run({ forms: [form({ fields: [field({ required: false })] })] });
    expect(result.measurements.VALIDATION_RULE.cells).toBe(0);
    expect(fieldCoveragePercentAt(result, 'VALIDATION_RULE', 'DECLARED')).toBeNull();
  });

  /*
   * The exact defect the register names: reading "we could not read the
   * attribute" as "there is no rule here" removes the cell from the denominator
   * and raises the percentage.
   */
  it('mints an UNMEASURED cell when the reader could not tell', () => {
    const result = run({ forms: [form({ fields: [field({ required: null })] })] });
    expect(result.measurements.VALIDATION_RULE.measured).toBe(0);
    expect(result.measurements.VALIDATION_RULE.unmeasured).toBe(1);
    expect(result.unmeasuredByReason.VALIDATION_RULE.EXTRACTOR_RETURNED_UNKNOWN).toBe(1);
    expect(fieldCoveragePercentAt(result, 'VALIDATION_RULE', 'DECLARED')).toBeNull();
  });
});

describe('semantic, the other boundary case nobody counted', () => {
  it('mints a measured rule for a semantic we can check', () => {
    const result = run({ forms: [form({ fields: [field({ semantic: 'credit_card' })] })] });
    const rows = rowsFor(result, 'VALIDATION_RULE');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toContain('Luhn');
    expect(rows[0]?.unmeasuredReason).toBeNull();
  });

  it('claims it when a test submits a number that fails Luhn and asserts', () => {
    const asserts = test({
      code: [
        "await page.getByLabel('Email').fill('4242424242424241');",
        "await expect(page.getByText('Invalid card')).toBeVisible();",
      ].join('\n'),
    });
    const result = run({ forms: [form({ fields: [field({ semantic: 'credit_card' })] })], tests: [asserts] });
    expect(rowsFor(result, 'VALIDATION_RULE')[0]?.tier).toBe('DECLARED');
  });

  it('does NOT claim it when the card number is valid', () => {
    const passes = test({
      code: [
        "await page.getByLabel('Email').fill('4242424242424242');",
        "await expect(page.getByText('Thanks')).toBeVisible();",
      ].join('\n'),
    });
    const result = run({ forms: [form({ fields: [field({ semantic: 'credit_card' })] })], tests: [passes] });
    expect(rowsFor(result, 'VALIDATION_RULE')[0]?.tier).toBeNull();
  });

  it('reports a semantic we have no deterministic check for as OUR limit', () => {
    const result = run({ forms: [form({ fields: [field({ semantic: 'phone' })] })] });
    expect(result.unmeasuredByReason.VALIDATION_RULE.NO_EXTRACTOR).toBe(1);
    expect(rowsFor(result, 'VALIDATION_RULE')[0]?.unmeasuredDetail).toContain('QAAI has no deterministic check');
  });

  it('treats an unclassified field as unmeasured, not as a field with no rules', () => {
    for (const semantic of [null, 'unknown', 'a-semantic-from-a-newer-reader']) {
      const result = run({ forms: [form({ fields: [field({ semantic })] })] });
      expect(result.measurements.VALIDATION_RULE.cells).toBe(1);
      expect(result.measurements.VALIDATION_RULE.measured).toBe(0);
      expect(result.unmeasuredByReason.VALIDATION_RULE.EXTRACTOR_RETURNED_UNKNOWN).toBe(1);
    }
  });

  it('mints nothing for a meaning whose rule is not in the markup', () => {
    // A password policy ("eight characters, one digit") is nowhere on the page,
    // so there is no rule to count. This is the honest EMPTY case and it must
    // stay distinguishable from `unknown` above.
    const result = run({ forms: [form({ fields: [field({ semantic: 'password' })] })] });
    expect(result.measurements.VALIDATION_RULE.cells).toBe(0);
  });
});

// ─── 3. Constraint honesty ──────────────────────────────────────────────────

describe('constraints the crawl could not read', () => {
  const sourceField = field({
    inputType: 'text',
    constraint: null,
    constraintsRead: false,
    semantic: 'freeform',
    required: true,
  });

  it('counts the boundary classes it never looked at, and names the source path', () => {
    const result = run({ forms: [form({ fields: [sourceField] })] });
    // text honours maxlength, minlength and pattern; min/max/step it does not.
    expect(result.unmeasuredByReason.VALIDATION_RULE.NOT_ENUMERATED).toBe(3);
    expect(result.measurements.VALIDATION_RULE.unmeasuredDetail).toContain('NOT_ENUMERATED 3');
    expect(result.caveats.join(' ')).toContain('packages/shared/src/codebase.ts');
    expect(result.caveats.join(' ')).toContain('NEVER READ');
  });

  it('tells "never read" apart from "read, and the page declares nothing"', () => {
    const neverRead = run({ forms: [form({ fields: [sourceField] })] });
    const readAndEmpty = run({
      forms: [form({ fields: [field({ inputType: 'text', constraintsRead: true, required: true })] })],
    });
    expect(neverRead.unmeasuredByReason.VALIDATION_RULE.NOT_ENUMERATED).toBe(3);
    // A reader that looked and found nothing has MEASURED the field: no
    // constraint cells at all, and nothing unmeasured to explain.
    expect(readAndEmpty.unmeasuredByReason.VALIDATION_RULE.NOT_ENUMERATED).toBe(0);
    expect(readAndEmpty.measurements.VALIDATION_RULE.cells).toBe(1); // just `required`
  });

  it('only counts the classes the input type could even carry', () => {
    const numberField = field({ inputType: 'number', constraint: null, constraintsRead: false, required: false });
    const result = run({ forms: [form({ fields: [numberField] })] });
    // number honours min, max and step — and not maxlength, minlength, pattern.
    expect(result.unmeasuredByReason.VALIDATION_RULE.NOT_ENUMERATED).toBe(3);
    const slugs = rowsFor(result, 'VALIDATION_RULE').map((row) => row.label);
    expect(slugs.join(' ')).toContain('min —');
    expect(slugs.join(' ')).not.toContain('maxlength');
  });

  it('refuses a reading that never read constraints and found some anyway', () => {
    expect(() =>
      run({ forms: [form({ fields: [field({ constraintsRead: false, constraint: NO_CONSTRAINTS })] })] }),
    ).toThrow(/never read cannot also have been found/);
  });

  it('reports a constraint the numeric column cannot hold rather than dropping it', () => {
    const dateField = field({
      name: 'when',
      label: 'When',
      inputType: 'date',
      semantic: 'date',
      required: false,
      constraint: NO_CONSTRAINTS,
      constraintsRead: true,
      unreadableConstraints: ['min'],
    });
    const result = run({ forms: [form({ fields: [dateField] })] });
    const row = rowsFor(result, 'VALIDATION_RULE').find((entry) => entry.label.includes('min —'));
    expect(row?.unmeasuredReason).toBe('EXTRACTOR_RETURNED_UNKNOWN');
    expect(row?.unmeasuredDetail).toContain('numeric constraint column cannot hold');
  });

  it('holds a constraint the browser ignores OUT of the denominator, with a reason', () => {
    const silly = field({
      name: 'qty',
      label: 'Quantity',
      inputType: 'number',
      semantic: 'number',
      required: false,
      constraint: { ...NO_CONSTRAINTS, maxLength: 4 },
      constraintsRead: true,
    });
    const result = run({ forms: [form({ fields: [silly] })] });
    const row = rowsFor(result, 'VALIDATION_RULE').find((entry) => entry.label.includes('maxlength'));
    expect(row?.exercise?.state).toBe('UNEXERCISABLE');
    expect(row?.exercise?.reason).toBe('CAPABILITY_UNAVAILABLE');
    expect(row?.unmeasuredReason).toBe('HELD_OUT');
    // It stays in the inventory as a row and leaves the ladder's denominator.
    expect(result.measurements.VALIDATION_RULE.tiers.denominator).toBe(
      result.measurements.VALIDATION_RULE.measured,
    );
    expect(result.unmeasuredByReason.VALIDATION_RULE.HELD_OUT).toBe(1);
  });

  it('treats an unknown input type as unknown applicability, not as inapplicable', () => {
    const unread = field({ inputType: null, constraintsRead: true, required: false });
    const result = run({ forms: [form({ fields: [unread] })] });
    expect(result.unmeasuredByReason.VALIDATION_RULE.EXTRACTOR_RETURNED_UNKNOWN).toBe(6);
  });
});

describe('the boundary checks themselves', () => {
  function claimed(over: Partial<FieldCoverageField>, code: string): boolean {
    const result = run({
      forms: [form({ fields: [field({ required: false, semantic: 'freeform', ...over })] })],
      tests: [test({ code })],
    });
    const rows = rowsFor(result, 'VALIDATION_RULE');
    return rows.length > 0 && rows.some((row) => row.tier !== null);
  }

  const assertAfter = (value: string) =>
    [`await page.getByLabel('Email').fill('${value}');`, "await expect(page.getByText('nope')).toBeVisible();"].join(
      '\n',
    );

  it('calls one character over the maxlength a violation and one under not', () => {
    const over = { inputType: 'text', constraint: { ...NO_CONSTRAINTS, maxLength: 5 } };
    expect(claimed(over, assertAfter('abcdef'))).toBe(true);
    expect(claimed(over, assertAfter('abcde'))).toBe(false);
  });

  it('calls a value under the minlength a violation and an empty one not', () => {
    const under = { inputType: 'text', constraint: { ...NO_CONSTRAINTS, minLength: 4 } };
    expect(claimed(under, assertAfter('ab'))).toBe(true);
    // The empty string is `required`'s violation, not minlength's; counting it
    // here would let one test claim two different rules.
    expect(claimed(under, assertAfter(''))).toBe(false);
  });

  it('respects a numeric floor and ceiling', () => {
    const bounded = { inputType: 'number', constraint: { ...NO_CONSTRAINTS, min: 0, max: 10 } };
    expect(claimed(bounded, assertAfter('-1'))).toBe(true);
    expect(claimed(bounded, assertAfter('11'))).toBe(true);
    expect(claimed(bounded, assertAfter('5'))).toBe(false);
  });

  /*
   * The float trap: `0.3 % 0.1` is 0.09999999999999998 in IEEE 754, so a naive
   * modulo reports every decimal step as violated and every decimal field as
   * covered by any test that types a number into it.
   */
  it('does not call a legal decimal step a violation', () => {
    const stepped = { inputType: 'number', constraint: { ...NO_CONSTRAINTS, step: 0.1 } };
    expect(claimed(stepped, assertAfter('0.3'))).toBe(false);
    expect(claimed(stepped, assertAfter('0.25'))).toBe(true);
  });

  it('anchors the pattern, so a partial match is still a violation', () => {
    const patterned = { inputType: 'text', constraint: { ...NO_CONSTRAINTS, pattern: '[A-Z]{3}' } };
    expect(claimed(patterned, assertAfter('ABC'))).toBe(false);
    expect(claimed(patterned, assertAfter('ABCD'))).toBe(true);
  });

  it('holds an uncompilable pattern out of the denominator rather than guessing', () => {
    const result = run({
      forms: [
        form({
          fields: [
            field({
              required: false,
              semantic: 'freeform',
              inputType: 'text',
              constraint: { ...NO_CONSTRAINTS, pattern: '([unclosed' },
            }),
          ],
        }),
      ],
    });
    const row = rowsFor(result, 'VALIDATION_RULE')[0];
    expect(row?.exercise?.state).toBe('UNEXERCISABLE');
    expect(row?.unmeasuredReason).toBe('HELD_OUT');
  });

  it('knows a past card expiry from a future one, against the injected clock', () => {
    const expiry = { semantic: 'card_expiry', inputType: 'text' };
    expect(claimed(expiry, assertAfter('01/20'))).toBe(true);
    expect(claimed(expiry, assertAfter('01/99'))).toBe(false);
  });

  it('knows 30 February from 29 February in a leap year', () => {
    const date = { semantic: 'date', inputType: 'date' };
    expect(claimed(date, assertAfter('2024-02-30'))).toBe(true);
    expect(claimed(date, assertAfter('2024-02-29'))).toBe(false);
    expect(claimed(date, assertAfter('2023-02-29'))).toBe(true);
  });

  it('knows text in a numeric field from a number in one', () => {
    const numeric = { semantic: 'number', inputType: 'number' };
    expect(claimed(numeric, assertAfter('lorem'))).toBe(true);
    expect(claimed(numeric, assertAfter('42'))).toBe(false);
  });

  it('knows an address with no @ from one with', () => {
    const email = { semantic: 'email', inputType: 'email' };
    expect(claimed(email, assertAfter('nobody'))).toBe(true);
    expect(claimed(email, assertAfter('nobody@example.com'))).toBe(false);
  });
});

// ─── 3b. The honesty rules ──────────────────────────────────────────────────

describe('not measured is NULL, never 0', () => {
  it('reports NULL at every rung when there is nothing to divide by', () => {
    const result = run({});
    for (const tier of COVERAGE_TIERS) {
      for (const dimension of FIELD_COVERAGE_DIMENSIONS) {
        expect(fieldCoveragePercentAt(result, dimension, tier)).toBeNull();
      }
    }
    expect(result.caveats.join(' ')).toContain('NULL rather than 0 or 100');
  });

  it('reports NULL when cells exist and none of them was measured', () => {
    const result = run({ forms: [form({ fields: [field({ required: null, semantic: null })] })] });
    expect(result.measurements.VALIDATION_RULE.cells).toBe(2);
    expect(result.measurements.VALIDATION_RULE.measured).toBe(0);
    for (const tier of COVERAGE_TIERS) {
      expect(fieldCoveragePercentAt(result, 'VALIDATION_RULE', tier)).toBeNull();
    }
  });

  it('divides by what was MEASURED and keeps the unmeasured count beside it', () => {
    const result = run({
      forms: [
        form({
          fields: [
            field({ name: 'a', label: 'A', required: true, semantic: 'freeform' }),
            field({ name: 'b', label: 'B', required: null, semantic: 'freeform' }),
          ],
        }),
      ],
    });
    const rule = result.measurements.VALIDATION_RULE;
    expect(rule.cells).toBe(2);
    expect(rule.measured).toBe(1);
    expect(rule.unmeasured).toBe(1);
    // Dividing by `cells` would report the unread attribute as uncovered.
    expect(rule.tiers.denominator).toBe(1);
    expect(rule.unmeasuredReason).toBe('EXTRACTOR_RETURNED_UNKNOWN');
  });

  it('breaks the unmeasured count out by reason, and names them all in the detail', () => {
    const result = run({
      forms: [
        form({
          fields: [
            field({ name: 'a', label: 'A', required: null, semantic: 'freeform' }),
            field({ name: 'b', label: 'B', required: false, semantic: 'phone' }),
            field({
              name: 'c',
              label: 'C',
              required: false,
              semantic: 'freeform',
              inputType: 'text',
              constraint: null,
              constraintsRead: false,
            }),
          ],
        }),
      ],
    });
    const breakdown = result.unmeasuredByReason.VALIDATION_RULE;
    expect(breakdown.EXTRACTOR_RETURNED_UNKNOWN).toBe(1);
    expect(breakdown.NO_EXTRACTOR).toBe(1);
    expect(breakdown.NOT_ENUMERATED).toBe(3);
    // One code on the measurement, and the others named in the sentence —
    // a single code that hid the rest would make three findings look like one.
    expect(result.measurements.VALIDATION_RULE.unmeasuredReason).toBe('NOT_ENUMERATED');
    const detail = result.measurements.VALIDATION_RULE.unmeasuredDetail ?? '';
    expect(detail).toContain('NO_EXTRACTOR 1');
    expect(detail).toContain('EXTRACTOR_RETURNED_UNKNOWN 1');
    expect(detail.length).toBeLessThanOrEqual(500);
  });

  it('keeps the breakdown keyed on every reason the keystone declares', () => {
    const result = run({});
    for (const reason of DIMENSION_UNMEASURED_REASONS) {
      expect(result.unmeasuredByReason.FORM_FIELD[reason as DimensionUnmeasuredReason]).toBe(0);
    }
  });
});

describe('written is not run', () => {
  const claims = test({
    code: ["await page.getByLabel('Email').fill('x');", "await expect(page).toHaveURL('/done');"].join('\n'),
  });

  it('caps a static claim at DECLARED, whatever the test looks like', () => {
    const result = run({ forms: [form()], tests: [claims] });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('DECLARED');
    expect(fieldCoveragePercentAt(result, 'FORM_FIELD', 'NAVIGATED')).toBe(0);
    expect(fieldCoveragePercentAt(result, 'FORM_FIELD', 'DECLARED')).toBe(100);
  });

  /*
   * BLOCKED AND CAPPED ARE DIFFERENT FINDINGS, and this is the assertion that
   * keeps them apart. An honest static claim is BLOCKED from NAVIGATED because
   * nothing ran, so `tierCappedBy` is null. A `STATIC_EVIDENCE_ONLY` cap here
   * would mean this module had filled in run evidence it does not have and the
   * ceiling had quietly taken it back — the number would be identical and the
   * reason beside it would be a fabrication. Without this line, a writer that
   * set `runStatus: 'PASSED'` on a static edge is invisible.
   */
  it('reports a static claim as BLOCKED by no run, not as CAPPED by its source', () => {
    const result = run({ forms: [form()], tests: [claims] });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tierCappedBy).toBeNull();
  });

  it('lets a passing, fresh run carry a cell to FRESH', () => {
    const cellKey = formFieldCellKey('FORM:/checkout#0', 'email');
    const observation: CellObservation = {
      cellKey,
      testId: 't1',
      navigationObserved: true,
      assertionObserved: true,
      runStatus: 'PASSED',
      confirmedAtIso: '2026-10-25T12:00:00.000Z',
      runId: 'run-9',
    };
    const result = run({ forms: [form()], tests: [claims], observations: [observation] });
    const row = rowsFor(result, 'FORM_FIELD')[0];
    expect(row?.tier).toBe('FRESH');
    expect(row?.lastConfirmedRunId).toBe('run-9');
  });

  it('keeps covered and failing as two facts', () => {
    const cellKey = formFieldCellKey('FORM:/checkout#0', 'email');
    const result = run({
      forms: [form()],
      tests: [claims],
      observations: [
        {
          cellKey,
          testId: 't1',
          navigationObserved: true,
          assertionObserved: true,
          runStatus: 'FAILED',
          confirmedAtIso: '2026-10-25T12:00:00.000Z',
          runId: 'run-9',
        },
      ],
    });
    // The cell is ASSERTED — somebody asserted it — and the failure is the run
    // report's grade, not the denominator's.
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('ASSERTED');
  });

  it('refuses to count a stale pass as fresh', () => {
    const cellKey = formFieldCellKey('FORM:/checkout#0', 'email');
    const result = run({
      forms: [form()],
      tests: [claims],
      observations: [
        {
          cellKey,
          testId: 't1',
          navigationObserved: true,
          assertionObserved: true,
          runStatus: 'PASSED',
          confirmedAtIso: '2026-01-01T12:00:00.000Z',
          runId: 'run-1',
        },
      ],
    });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('PASSING');
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tierCappedBy).toBeNull();
  });

  it('lets a quarantined test claim a cell and nothing more', () => {
    const result = run({ forms: [form()], tests: [test({ ...claims, quarantined: true })] });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('DECLARED');
  });

  it('takes the strongest claim, not the first one it saw', () => {
    const cellKey = formFieldCellKey('FORM:/checkout#0', 'email');
    const result = run({
      forms: [form()],
      tests: [claims],
      observations: [
        {
          cellKey,
          testId: 't1',
          navigationObserved: true,
          assertionObserved: false,
          runStatus: 'PASSED',
          confirmedAtIso: NOW,
          runId: 'weak',
        },
        {
          cellKey,
          testId: 't2',
          navigationObserved: true,
          assertionObserved: true,
          runStatus: 'PASSED',
          confirmedAtIso: NOW,
          runId: 'strong',
        },
      ],
    });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('FRESH');
    expect(rowsFor(result, 'FORM_FIELD')[0]?.lastConfirmedRunId).toBe('strong');
  });
});

describe('scoping, so one word does not claim a product', () => {
  it('refuses a claim from a test that never visits the form’s route', () => {
    const elsewhere = test({
      routes: ['/settings'],
      code: ["await page.getByLabel('Email').fill('x');", 'await expect(1).toBe(1);'].join('\n'),
    });
    const result = run({ forms: [form()], tests: [elsewhere] });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBeNull();
  });

  it('discloses the widening when a form has no route to scope by', () => {
    const result = run({
      forms: [form({ route: null })],
      tests: [
        test({
          routes: ['/settings'],
          code: ["await page.getByLabel('Email').fill('x');", 'await expect(1).toBe(1);'].join('\n'),
        }),
      ],
    });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBe('DECLARED');
    expect(result.caveats.join(' ')).toContain('carry no route');
  });

  /*
   * THE CLAIM WINDOW IS A DECLARED LIMIT ON GENEROSITY, and this pins it. With
   * no window, any `.fill()` anywhere in a file claimed every field the file
   * mentions: a page object that names twelve locators at the top and drives
   * one of them at the bottom marked all twelve exercised, which is the
   * same-shaped defect as the form boolean this module replaces.
   */
  it('refuses a claim from an action too far from the field it names', () => {
    const far = test({
      code: [
        "const email = page.getByLabel('Email');",
        ...Array.from({ length: 10 }, (_, index) => `// filler ${index}`),
        "await somethingElse.fill('x');",
        'await expect(1).toBe(1);',
      ].join('\n'),
    });
    const result = run({ forms: [form()], tests: [far] });
    expect(rowsFor(result, 'FORM_FIELD')[0]?.tier).toBeNull();
  });

  it('refuses a rule claim when the violating value is out of the window', () => {
    const far = test({
      code: [
        "const email = page.getByLabel('Email');",
        ...Array.from({ length: 10 }, (_, index) => `// filler ${index}`),
        "await email.fill('');",
        "await expect(page.getByText('required')).toBeVisible();",
      ].join('\n'),
    });
    const result = run({
      forms: [form({ fields: [field({ required: true })] })],
      tests: [far],
    });
    expect(rowsFor(result, 'VALIDATION_RULE')[0]?.tier).toBeNull();
  });

  it('calls a test with no source UNKNOWN to us rather than uncovered', () => {
    const result = run({ forms: [form()], tests: [test({ code: null })] });
    expect(result.caveats.join(' ')).toContain('no source here');
    expect(result.caveats.join(' ')).toContain('unknown to us');
  });

  it('reports no dialect as unmeasured, never as a gap', () => {
    const result = run({
      forms: [form({ fields: [field({ required: true })] })],
      components: [component()],
      dialect: null,
    });
    expect(result.measurements.VALIDATION_RULE.measured).toBe(0);
    expect(result.unmeasuredByReason.VALIDATION_RULE.EXTRACTOR_RETURNED_UNKNOWN).toBe(1);
    expect(result.unmeasuredByReason.COMPONENT_STATE.EXTRACTOR_RETURNED_UNKNOWN).toBe(1);
    expect(result.caveats.join(' ')).toContain('No test dialect was resolved');
  });
});

describe('waivers leave the denominator, and only when they are real', () => {
  const fieldKey = formFieldCellKey('FORM:/checkout#0', 'email');

  it('holds a waived cell out, with its owner and expiry on the row', () => {
    const result = run({
      forms: [form()],
      waivers: {
        [fieldKey]: { reason: 'legacy form, scheduled for deletion', owner: 'ada@example.com', expiresAtIso: '2026-12-01T00:00:00.000Z' },
      },
    });
    expect(result.measurements.FORM_FIELD.measured).toBe(0);
    expect(result.unmeasuredByReason.FORM_FIELD.HELD_OUT).toBe(1);
    const row = rowsFor(result, 'FORM_FIELD')[0];
    expect(row?.unmeasuredDetail).toContain('ada@example.com');
    expect(row?.unmeasuredDetail).toContain('2026-12-01');
  });

  it('REFUSES a waiver with no owner and keeps the cell in the denominator', () => {
    const result = run({
      forms: [form()],
      waivers: { [fieldKey]: { reason: 'because', owner: '  ', expiresAtIso: '2026-12-01T00:00:00.000Z' } },
    });
    expect(result.measurements.FORM_FIELD.measured).toBe(1);
    expect(result.caveats.join(' ')).toContain('waiver(s) were REFUSED');
  });

  it('REFUSES a lapsed waiver', () => {
    const result = run({
      forms: [form()],
      waivers: { [fieldKey]: { reason: 'because', owner: 'ada', expiresAtIso: '2026-01-01T00:00:00.000Z' } },
    });
    expect(result.measurements.FORM_FIELD.measured).toBe(1);
    expect(result.caveats.join(' ')).toContain('waiver(s) were REFUSED');
  });
});

describe('caps are disclosed as a count and a reason', () => {
  it('reports the lines of a test it did not read', () => {
    const long = test({ code: Array.from({ length: 4_100 }, (_, index) => `// line ${index}`).join('\n') });
    const result = run({ forms: [form()], tests: [long] });
    const bite = result.measurements.FORM_FIELD.caps.find((cap) => cap.cap === 'MAX_SCANNED_LINES');
    expect(bite?.limit).toBe(4_000);
    expect(bite?.atLeastMore).toBe(100);
    expect(bite?.detail).toContain('not read');
  });

  it('carries a cap the enumerator hit before this module saw anything', () => {
    const result = run({
      forms: [form()],
      caps: [{ cap: 'MAX_FIELDS_PER_FORM', limit: 40, atLeastMore: 11, detail: 'the reader stopped at 40 fields' }],
    });
    for (const dimension of FIELD_COVERAGE_DIMENSIONS) {
      expect(result.measurements[dimension].caps.some((cap) => cap.cap === 'MAX_FIELDS_PER_FORM')).toBe(true);
    }
  });

  it('reports its own cell cap as CAP_BIT with a floor, not as a complete denominator', () => {
    const many = Array.from({ length: 20_050 }, (_, index) => field({ name: `f${index}`, label: `F${index}` }));
    const result = run({ forms: [form({ fields: many })] });
    const measurement = result.measurements.FORM_FIELD;
    expect(measurement.unmeasuredReason).toBe('CAP_BIT');
    const bite = measurement.caps.find((cap) => cap.cap === 'MAX_CELLS_PER_DIMENSION');
    expect(bite?.atLeastMore).toBe(50);
    expect(bite?.detail).toContain('floor');
  });
});

// ─── 3c. Components ────────────────────────────────────────────────────────

describe('the component and component-state denominators', () => {
  const three = component({
    states: [
      { kind: 'DEFAULT', source: 'SOURCE', evidence: 'renders its children' },
      { kind: 'LOADING', source: 'SOURCE', evidence: 'renders <Spinner/> when isLoading' },
      { kind: 'ERROR', source: 'CATALOGUE', evidence: 'the Error story' },
    ],
  });

  it('counts the component and its states as two denominators', () => {
    const result = run({ components: [three] });
    expect(result.measurements.COMPONENT.cells).toBe(1);
    expect(result.measurements.COMPONENT_STATE.cells).toBe(3);
  });

  it('claims the default state from a rendering test and not the error state', () => {
    const unit = test({
      routes: [],
      code: ['render(<Button label="Go" />);', "expect(screen.getByText('Go')).toBeTruthy();"].join('\n'),
    });
    const result = run({ components: [three], tests: [unit] });
    const byKind = new Map(result.itemStateRows.map((row) => [row.kind, row]));
    expect(byKind.get('COMPONENT')?.tier).toBe('DECLARED');
    expect(byKind.get('COMPONENT_DEFAULT')?.tier).toBe('DECLARED');
    expect(byKind.get('COMPONENT_LOADING')?.tier).toBeNull();
    expect(byKind.get('COMPONENT_ERROR')?.tier).toBeNull();
  });

  it('claims the error state when a test names it beside an assertion', () => {
    const unit = test({
      routes: [],
      code: [
        'render(<Button error={new Error("boom")} />);',
        "expect(screen.getByRole('alert')).toBeTruthy();",
      ].join('\n'),
    });
    const result = run({ components: [three], tests: [unit] });
    const byKind = new Map(result.itemStateRows.map((row) => [row.kind, row]));
    expect(byKind.get('COMPONENT_ERROR')?.tier).toBe('DECLARED');
  });

  it('does not let a wrapper’s test claim the thing it wraps', () => {
    const unit = test({
      routes: [],
      code: ['render(<ButtonGroup />);', 'expect(1).toBe(1);'].join('\n'),
    });
    const result = run({ components: [three], tests: [unit] });
    expect(result.itemStateRows.every((row) => row.tier === null)).toBe(true);
  });

  it('needs an assertion, not merely an import, to claim a component', () => {
    const unit = test({ routes: [], code: "import { Button } from './Button';\nrender(<Button />);" });
    const result = run({ components: [three], tests: [unit] });
    expect(result.itemStateRows.every((row) => row.tier === null)).toBe(true);
  });

  /*
   * `states: null` and `states: []` are different facts and this is the test
   * that keeps them apart. Collapsing them prints "0% of your component states
   * are covered" about a project whose states nobody read.
   */
  it('tells "nobody enumerated the states" from "a reader found none"', () => {
    const never = run({ components: [component({ states: null })] });
    expect(never.measurements.COMPONENT_STATE.cells).toBe(1);
    expect(never.measurements.COMPONENT_STATE.measured).toBe(0);
    expect(never.unmeasuredByReason.COMPONENT_STATE.NOT_ENUMERATED).toBe(1);
    expect(never.caveats.join(' ')).toContain('FLOOR');

    const stateless = run({ components: [component({ states: [] })] });
    expect(stateless.measurements.COMPONENT_STATE.cells).toBe(0);
    expect(stateless.unmeasuredByReason.COMPONENT_STATE.NOT_ENUMERATED).toBe(0);
  });

  it('keeps the component itself in the denominator when its states are unknown', () => {
    const result = run({ components: [component({ states: null })] });
    expect(result.measurements.COMPONENT.measured).toBe(1);
  });

  it('refuses to count a page component twice, and still counts its states', () => {
    const page = component({
      kind: 'PAGE',
      modulePath: 'app/checkout/page.tsx',
      exportName: 'default',
      states: [{ kind: 'LOADING', source: 'SOURCE', evidence: 'renders a skeleton' }],
    });
    const result = run({ components: [page] });
    expect(result.measurements.COMPONENT.cells).toBe(0);
    expect(result.measurements.COMPONENT_STATE.cells).toBe(1);
    expect(result.caveats.join(' ')).toContain('already counted on the ROUTE axis');
  });

  it('reports a component with no registry row as a dangling reference of ours', () => {
    const result = run({ components: [component({ itemKey: null })] });
    expect(result.unmeasuredByReason.COMPONENT.NOT_ENUMERATED).toBe(1);
    expect(result.unmeasuredByReason.COMPONENT_STATE.NOT_ENUMERATED).toBe(1);
    expect(result.itemStateRows).toHaveLength(0);
    expect(result.caveats.join(' ')).toContain('dangling reference in our own extractor');
  });

  it('reports an unread catalogue without letting it move the denominator', () => {
    const unread = run({ components: [component({ hasCatalogueEntry: null })] });
    const read = run({ components: [component({ hasCatalogueEntry: false })] });
    expect(unread.measurements.COMPONENT.cells).toBe(read.measurements.COMPONENT.cells);
    expect(unread.caveats.join(' ')).toContain('no catalogue read');
  });

  it('ties a state cell back to the component cell it is reached through', () => {
    const result = run({ components: [three] });
    const state = result.itemStateRows.find((row) => row.kind === 'COMPONENT_LOADING');
    expect(state?.parentStateKey).toBe(componentCellKey(three.itemKey as string));
  });
});

// ─── 4. Cell keys and the write path ───────────────────────────────────────

describe('cell keys go through the one format', () => {
  it('gives every rule on one field its own key, even at the same cell kind', () => {
    const base = 'FORM:/checkout#0';
    const max = validationRuleCellKey(base, 'email', 'maxlength');
    const min = validationRuleCellKey(base, 'email', 'minlength');
    expect(max).not.toBe(min);
    // Both are RULE_LENGTH: keying on the cell kind alone would collide them
    // and silently drop a boundary nobody would ever test.
    expect(VALIDATION_RULE_CELL_KIND.maxlength).toBe(VALIDATION_RULE_CELL_KIND.minlength);
  });

  it('percent-encodes the characters the format reserves', () => {
    const key = formFieldCellKey('FORM:/checkout#0', 'a|b=c%d');
    expect(key).not.toContain('|');
    const parsed = parseDimensionCellIdentity(key);
    expect(parsed?.base).toBe('FORM:/checkout#0#a|b=c%d');
  });

  it('round-trips a component-state key', () => {
    const key = componentStateCellKey('COMPONENT_STATE:src/Button.tsx#Button', 'LOADING');
    expect(parseDimensionCellIdentity(key)?.base).toBe(
      'COMPONENT_STATE:src/Button.tsx#Button#state=LOADING',
    );
  });

  it('keys the same cell identically across two runs', () => {
    const a = run({ forms: [form()], components: [component()] });
    const b = run({ forms: [form()], components: [component()] });
    expect(a.formFieldRows.map((row) => row.fieldKey)).toEqual(b.formFieldRows.map((row) => row.fieldKey));
    expect(a.itemStateRows.map((row) => row.stateKey)).toEqual(b.itemStateRows.map((row) => row.stateKey));
  });
});

describe('the write path: every row this module emits is saveable', () => {
  /** A reading that exercises every branch that produces a row. */
  function everything(): FieldCoverageResult {
    return run({
      forms: [
        form({
          fields: [
            field({ name: 'email', label: 'Email', required: true, semantic: 'email' }),
            field({ name: 'req', label: 'Required?', required: null, semantic: null }),
            field({
              name: 'src',
              label: 'From the source path',
              required: true,
              inputType: 'text',
              constraint: null,
              constraintsRead: false,
            }),
            field({
              name: 'qty',
              label: 'Quantity',
              inputType: 'number',
              semantic: 'number',
              constraint: { ...NO_CONSTRAINTS, maxLength: 4, min: 1, max: 9 },
            }),
            field({ name: 'tel', label: 'Phone', inputType: 'tel', semantic: 'phone' }),
            field({
              name: 'waived',
              label: 'Waived',
              required: true,
              exercise: { state: 'REFUSED', rule: 'crawl.policy.no-pii', detail: 'policy refuses PII fields' },
            }),
          ],
        }),
      ],
      components: [
        component({
          states: [
            { kind: 'DEFAULT', source: 'SOURCE', evidence: 'renders its children' },
            { kind: 'SLOW', source: 'MANUAL', evidence: 'a person recorded a slow response' },
          ],
        }),
        component({
          itemKey: 'COMPONENT_STATE:src/Table.tsx#Table',
          modulePath: 'src/Table.tsx',
          exportName: 'Table',
          hasCatalogueEntry: null,
          exercise: { state: 'UNEXERCISABLE', reason: 'CAPABILITY_UNAVAILABLE', detail: 'needs a CDP session' },
          states: [{ kind: 'EMPTY', source: 'CATALOGUE', evidence: 'the Empty story' }],
        }),
      ],
      tests: [
        test({
          code: [
            "await page.getByLabel('Email').fill('nobody');",
            "await expect(page.getByText('Enter a valid email')).toBeVisible();",
            'render(<Button />);',
            'expect(1).toBe(1);',
          ].join('\n'),
        }),
      ],
      waivers: {
        [validationRuleCellKey('FORM:/checkout#0', 'qty', 'min')]: {
          reason: 'the API clamps it',
          owner: 'grace@example.com',
          expiresAtIso: '2026-12-31T00:00:00.000Z',
        },
      },
    });
  }

  /*
   * THE READ PATH. The write path above is the rows; this is the reading, and
   * it is the half a round like this one usually forgets. A measurement the
   * API's own schema refuses is a number that can never be stored, exported or
   * compared — and `dimensionMeasurementSchema` is where the keystone's four
   * refusals live, so parsing through it proves `cells = measured + unmeasured`,
   * `tiers.denominator = measured`, no unexplained shortfall and no CAP_BIT
   * without a cap, on a real reading rather than on a hand-built one.
   */
  it('parses all four readings through dimensionMeasurementSchema', () => {
    const result = everything();
    for (const dimension of FIELD_COVERAGE_DIMENSIONS) {
      const parsed = dimensionMeasurementSchema.safeParse(result.measurements[dimension]);
      expect(parsed.success, `${dimension}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('bounds the cap list to what the measurement schema accepts, and says so', () => {
    const many = Array.from({ length: 26 }, (_, index) => ({
      cap: `cap${index}`,
      limit: index,
      atLeastMore: null,
      detail: `cap ${index} bit`,
    }));
    const result = run({ forms: [form()], caps: many });
    const caps = result.measurements.FORM_FIELD.caps;
    expect(caps).toHaveLength(20);
    expect(caps[19]?.cap).toBe('MAX_CAP_BITES');
    expect(caps[19]?.atLeastMore).toBe(7);
    expect(dimensionMeasurementSchema.safeParse(result.measurements.FORM_FIELD).success).toBe(true);
  });

  it('parses every form-field and rule row through coverageFormFieldSchema', () => {
    const result = everything();
    expect(result.formFieldRows.length).toBeGreaterThan(10);
    for (const row of result.formFieldRows) {
      const parsed = coverageFormFieldSchema.safeParse(row);
      expect(parsed.success, `${row.fieldKey}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('parses every component and state row through coverageItemStateSchema', () => {
    const result = everything();
    expect(result.itemStateRows.length).toBeGreaterThan(3);
    for (const row of result.itemStateRows) {
      const parsed = coverageItemStateSchema.safeParse(row);
      expect(parsed.success, `${row.stateKey}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('gives every rule row the field it was derived from', () => {
    const result = everything();
    for (const row of result.formFieldRows) {
      if (CELL_KIND_DIMENSION[row.kind] === 'VALIDATION_RULE') {
        expect(row.parentFieldKey).not.toBeNull();
        expect(row.parentFieldKey).toBe(formFieldCellKey(row.itemKey, fieldNameOf(row.fieldKey)));
      } else {
        expect(row.parentFieldKey).toBeNull();
      }
    }
  });

  it('names a run on every cell that claims to be above DECLARED', () => {
    const observed = run({
      forms: [form()],
      tests: [test({ code: "await page.getByLabel('Email').fill('x');\nexpect(1).toBe(1);" })],
      observations: [
        {
          cellKey: formFieldCellKey('FORM:/checkout#0', 'email'),
          testId: 't1',
          navigationObserved: true,
          assertionObserved: true,
          runStatus: 'PASSED',
          confirmedAtIso: NOW,
          runId: 'run-7',
        },
      ],
    });
    for (const row of [...observed.formFieldRows, ...observed.itemStateRows]) {
      if (row.tier !== null && row.tier !== 'DECLARED') expect(row.lastConfirmedRunId).not.toBeNull();
      else expect(row.lastConfirmedRunId).toBeNull();
    }
  });

  it('never writes an observation instant from static analysis alone', () => {
    const result = everything();
    for (const row of result.itemStateRows) expect(row.observedAtIso).toBeNull();
  });

  it('refuses a field with no identity rather than silently shrinking the denominator', () => {
    expect(() => run({ forms: [form({ fields: [field({ name: '  ' })] })] })).toThrow(/no identity to key on/);
  });

  it('keeps a row’s unmeasured reason and sentence together or absent together', () => {
    const result = everything();
    for (const row of [...result.formFieldRows, ...result.itemStateRows]) {
      expect(row.unmeasuredReason === null).toBe(row.unmeasuredDetail === null);
    }
  });
});

/** The field name out of a rule cell key — `<itemKey>#<field>#<slug>`. */
function fieldNameOf(ruleKey: string): string {
  const base = parseDimensionCellIdentity(ruleKey)?.base ?? ruleKey;
  const parts = base.split('#');
  return parts[parts.length - 2] ?? '';
}

// ─── A regression guard for the tier type, so the ladder cannot drift ──────

describe('the ladder', () => {
  it('reports a figure at every rung the keystone declares', () => {
    const result = run({ forms: [form()] });
    for (const tier of COVERAGE_TIERS as readonly CoverageTier[]) {
      const rung = result.measurements.FORM_FIELD.tiers.tiers.find((entry) => entry.tier === tier);
      expect(rung, `no rung for ${tier}`).toBeDefined();
    }
    expect(result.measurements.FORM_FIELD.tiers.tiers).toHaveLength(COVERAGE_TIERS.length);
  });
});
