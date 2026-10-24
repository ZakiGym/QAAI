import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_CLOCK,
  SYNTHETIC_EMAIL_DOMAIN,
  createSyntheticFactory,
  fillForm,
  formatDate,
  syntheticValue,
  type SyntheticField,
} from './synthetic';
import { isLuhnValid } from './test-values';

/**
 * Determinism is the product here, so it is tested first and hardest: the same
 * (seed, scope, field) must give the same value in every process forever, and a
 * different seed must give a different one. Everything else in this file is
 * about the second promise — that the value is valid under what the page
 * actually declared.
 */

const field = (
  over: Partial<SyntheticField> & Pick<SyntheticField, 'name' | 'semantic'>,
): SyntheticField => over;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

describe('determinism', () => {
  const form: SyntheticField[] = [
    field({ name: 'email', semantic: 'email' }),
    field({ name: 'fullName', semantic: 'person_name' }),
    field({ name: 'quantity', semantic: 'number', inputType: 'number', min: '1', max: '9' }),
    field({ name: 'notes', semantic: 'freeform', inputType: 'textarea' }),
  ];

  it('gives byte-identical output for the same seed, twice', () => {
    const first = fillForm(form, { seed: 'run-abc' });
    const second = fillForm(form, { seed: 'run-abc' });
    expect(second.values).toEqual(first.values);
    expect(second.fields).toEqual(first.fields);
  });

  it('gives different output for a different seed', () => {
    const a = fillForm(form, { seed: 'run-abc' }).values;
    const b = fillForm(form, { seed: 'run-xyz' }).values;
    expect(b).not.toEqual(a);
    // Specifically the email, because that is the value a repeat run collides on.
    expect(b.email).not.toBe(a.email);
  });

  it('separates two tests in the same run by scope', () => {
    const one = fillForm(form, { seed: 'run-abc', scope: 'test-signup' }).values;
    const two = fillForm(form, { seed: 'run-abc', scope: 'test-invite' }).values;
    expect(two.email).not.toBe(one.email);
  });

  it('does not depend on the position of a field in the form', () => {
    // Inserting a field at the top must not rewrite the values below it: a
    // suite that re-randomises on an unrelated markup change is a suite nobody
    // trusts, and order-dependent hashing is how that happens.
    const withExtra = [field({ name: 'coupon', semantic: 'freeform' }), ...form];
    const before = fillForm(form, { seed: 'run-abc' }).values;
    const after = fillForm(withExtra, { seed: 'run-abc' }).values;
    expect(after.email).toBe(before.email);
    expect(after.fullName).toBe(before.fullName);
  });

  it('derives every date from the frozen clock, not the wall clock', () => {
    const dated = field({ name: 'startDate', semantic: 'date', inputType: 'date' });
    const a = syntheticValue(dated, { seed: 's' }).value;
    const b = syntheticValue(dated, { seed: 's', now: SYNTHETIC_CLOCK }).value;
    expect(a).toBe(b);
    expect(a.startsWith('2026-')).toBe(true);
  });
});

describe('uniqueness', () => {
  it('never gives two different fields in one form the same value', () => {
    const fields = Array.from({ length: 8 }, (_, i) =>
      field({ name: `contact_${i}`, semantic: 'person_name' }),
    );
    const { values } = fillForm(fields, { seed: 'run-1' });
    expect(new Set(Object.values(values)).size).toBe(fields.length);
  });

  it('puts a traceable, run-specific local part in every email', () => {
    const value = syntheticValue(field({ name: 'workEmail', semantic: 'email' }), {
      seed: 'run-7',
    }).value;
    expect(value).toMatch(EMAIL_SHAPE);
    expect(value).toContain('qaai-');
    expect(value.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)).toBe(true);
  });

  it('only uses a reserved domain, so no generated address can reach a person', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const value = syntheticValue(field({ name: 'email', semantic: 'email' }), { seed }).value;
      expect(value).toMatch(/@(example\.com|qa\.test)$/);
    }
  });

  it('mirrors a confirmation field instead of making it unique', () => {
    // The bug uniqueness-by-default causes: every signup submission fails
    // validation because the two password fields disagree.
    const { values, notes } = fillForm(
      [
        field({ name: 'password', semantic: 'password' }),
        field({ name: 'password_confirmation', semantic: 'password' }),
        field({ name: 'email', semantic: 'email' }),
        field({ name: 'confirmEmail', semantic: 'email', label: 'Confirm email' }),
      ],
      { seed: 'run-1' },
    );
    expect(values.password_confirmation).toBe(values.password);
    expect(values.confirmEmail).toBe(values.email);
    expect(notes.join(' ')).toMatch(/was filled to match/);
  });

  it('says so out loud when the value space is too small to separate two fields', () => {
    // Two country fields both want "United States" and no re-draw can change
    // that. The honest outcome is a stated caveat, not a silent duplicate.
    const { notes } = fillForm(
      [
        field({ name: 'country', semantic: 'country' }),
        field({ name: 'shipping_nation', semantic: 'country' }),
      ],
      { seed: 'run-1' },
    );
    expect(notes.join(' ')).toMatch(/too small/);
  });
});

describe('constraints the page declares', () => {
  it('keeps an email inside maxlength and still plausible', () => {
    const result = syntheticValue(field({ name: 'email', semantic: 'email', maxLength: 20 }), {
      seed: 'run-1',
    });
    expect(result.value.length).toBeLessThanOrEqual(20);
    expect(result.value).toMatch(EMAIL_SHAPE);
    expect(result.honoured).toContain('maxLength');
    expect(result.unsatisfiable).toEqual([]);
  });

  it('refuses to pretend when maxlength admits no valid value', () => {
    const result = syntheticValue(field({ name: 'email', semantic: 'email', maxLength: 6 }), {
      seed: 'run-1',
    });
    expect(result.unsatisfiable).toContain('maxLength');
    expect(result.note).toMatch(/too small/);
  });

  it('calls out a card field whose maxlength cannot hold a card number', () => {
    const result = syntheticValue(
      field({ name: 'cardNumber', semantic: 'credit_card', maxLength: 10 }),
      { seed: 'run-1' },
    );
    expect(result.unsatisfiable).toContain('maxLength');
    expect(result.note).toMatch(/bug in the page/);
  });

  it('reaches minlength on a free-text field', () => {
    const result = syntheticValue(
      field({ name: 'bio', semantic: 'freeform', inputType: 'textarea', minLength: 120 }),
      { seed: 'run-1' },
    );
    expect(result.value.length).toBeGreaterThanOrEqual(120);
    expect(result.honoured).toContain('minLength');
  });

  it('reports a minlength/maxlength contradiction rather than resolving it', () => {
    const result = syntheticValue(
      field({ name: 'code', semantic: 'freeform', minLength: 20, maxLength: 5 }),
      { seed: 'run-1' },
    );
    expect(result.unsatisfiable.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/contradict|cannot be reached/);
  });

  it('stays inside min/max and aligned to step', () => {
    const result = syntheticValue(
      field({
        name: 'qty',
        semantic: 'number',
        inputType: 'number',
        min: '1',
        max: '10',
        step: '5',
      }),
      { seed: 'run-1' },
    );
    const value = Number(result.value);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(10);
    expect((value - 1) % 5).toBe(0);
  });

  it('gives a currency field two decimal places', () => {
    const result = syntheticValue(
      field({ name: 'price', semantic: 'currency', inputType: 'text' }),
      { seed: 'run-1' },
    );
    expect(result.value).toMatch(/^\d+\.\d{2}$/);
  });

  it('honours a declared pattern by choosing a format that satisfies it', () => {
    const result = syntheticValue(
      field({ name: 'zip', semantic: 'postal_code', pattern: '[0-9]{5}' }),
      { seed: 'run-1' },
    );
    expect(result.value).toMatch(/^[0-9]{5}$/);
    expect(result.honoured).toContain('pattern');
  });

  it('picks the UK format when the pattern asks for it', () => {
    const result = syntheticValue(
      field({
        name: 'postcode',
        semantic: 'postal_code',
        pattern: '[A-Z]{2}[0-9]A? ?[0-9][A-Z]{2}',
      }),
      { seed: 'run-1' },
    );
    expect(result.honoured).toContain('pattern');
    expect(result.value).toMatch(/^SW1A/);
  });

  /**
   * These cover the narrow pattern synthesiser, which exists because of a
   * concrete failure found by inspection: a single field with
   * `pattern="[A-Z]{4}[0-9]{2}"` could not be filled, and since every boundary
   * case submits the whole form, that one field made the negative cases for
   * EVERY other field unattributable.
   */
  it.each([
    ['[0-9]{5}', /^[0-9]{5}$/],
    ['[A-Z]{4}[0-9]{2}', /^[A-Z]{4}[0-9]{2}$/],
    ['\\d{3}-\\d{4}', /^\d{3}-\d{4}$/],
    ['[A-Za-z0-9_]{3,16}', /^[A-Za-z0-9_]{3,16}$/],
    ['[A-Z]{2}-[0-9]{3}', /^[A-Z]{2}-[0-9]{3}$/],
  ])('builds a value satisfying pattern="%s"', (pattern, shape) => {
    const result = syntheticValue(field({ name: 'code', semantic: 'freeform', pattern }), {
      seed: 'run-1',
    });
    expect(result.value).toMatch(shape);
    expect(result.honoured).toContain('pattern');
    expect(result.unsatisfiable).toEqual([]);
  });

  it('says when a value was built from the pattern rather than from real data', () => {
    const result = syntheticValue(
      field({ name: 'code', semantic: 'freeform', pattern: '[A-Z]{4}[0-9]{2}' }),
      { seed: 'run-1' },
    );
    expect(result.note).toMatch(/built from the pattern itself/);
  });

  it('declines the constructs its parser does not fully understand', () => {
    // Alternation, groups and unbounded repeats are out of scope, and the
    // honest outcome is "could not satisfy" rather than an approximation.
    for (const pattern of ['(foo|bar)', '[0-9]+', 'a*b', '[^0-9]{4}', '(?=.*[A-Z]).{8,}']) {
      const result = syntheticValue(field({ name: 'code', semantic: 'freeform', pattern }), {
        seed: 'run-1',
      });
      if (result.unsatisfiable.length === 0) {
        // If it did produce a value it must genuinely satisfy the pattern —
        // the caller verifies against the real regex, so this can never be a
        // value that merely looks right.
        expect(new RegExp(`^(?:${pattern})$`).test(result.value), pattern).toBe(true);
      }
    }
  });

  it('never returns a pattern-satisfying claim it cannot back up', () => {
    // The safety net: `honoured` may contain 'pattern' only when the real
    // compiled regex accepts the value.
    for (const pattern of ['[0-9]{5}', '[A-Z]{4}[0-9]{2}', 'ZZ[0-9]{9}QQ', '(foo|bar)', '[0-9]+']) {
      const result = syntheticValue(field({ name: 'c', semantic: 'freeform', pattern }), {
        seed: 'run-9',
      });
      if (result.honoured.includes('pattern')) {
        expect(new RegExp(`^(?:${pattern})$`).test(result.value), pattern).toBe(true);
      }
    }
  });

  it('admits defeat on a pattern nothing it can build satisfies', () => {
    const result = syntheticValue(
      field({ name: 'weird', semantic: 'postal_code', pattern: '(?=x)[0-9]{9}' }),
      { seed: 'run-1' },
    );
    expect(result.unsatisfiable).toContain('pattern');
    expect(result.note).toMatch(/out of scope/);
  });

  it('does not throw on a pattern the runtime cannot compile', () => {
    const result = syntheticValue(field({ name: 'bad', semantic: 'freeform', pattern: '([a-' }), {
      seed: 'run-1',
    });
    expect(result.value).not.toBe('');
    expect(result.note).toMatch(/not a regex this runtime can compile/);
  });

  it('chooses from the options a select actually offers', () => {
    const result = syntheticValue(
      field({
        name: 'country',
        semantic: 'country',
        inputType: 'select',
        options: ['Select a country…', 'Portugal', 'Japan'],
      }),
      { seed: 'run-1' },
    );
    expect(['Portugal', 'Japan']).toContain(result.value);
    expect(result.honoured).toContain('options');
  });

  it('flags a select whose every option is a placeholder', () => {
    const result = syntheticValue(
      field({
        name: 'country',
        semantic: 'country',
        inputType: 'select',
        options: ['', 'Select…'],
      }),
      { seed: 'run-1' },
    );
    expect(result.value).toBe('');
    expect(result.unsatisfiable).toContain('options');
  });

  it('keeps a date inside a declared min/max window', () => {
    const result = syntheticValue(
      field({
        name: 'when',
        semantic: 'date',
        inputType: 'date',
        min: '2027-03-01',
        max: '2027-03-10',
      }),
      { seed: 'run-1' },
    );
    expect(result.value >= '2027-03-01').toBe(true);
    expect(result.value <= '2027-03-10').toBe(true);
  });

  it('puts a date of birth far enough back to clear an age gate', () => {
    const result = syntheticValue(
      field({ name: 'dob', semantic: 'date', inputType: 'date', label: 'Date of birth' }),
      { seed: 'run-1' },
    );
    const year = Number(result.value.slice(0, 4));
    expect(year).toBeLessThan(new Date(SYNTHETIC_CLOCK).getUTCFullYear() - 25);
  });
});

describe('payment values come from the catalogue, never invented', () => {
  it('uses a Luhn-valid published test card', () => {
    const result = syntheticValue(field({ name: 'cardNumber', semantic: 'credit_card' }), {
      seed: 'run-1',
    });
    expect(isLuhnValid(result.value)).toBe(true);
    expect(result.value).toBe('4242424242424242');
  });

  it('gives a card expiry that is still in the future under the frozen clock', () => {
    const result = syntheticValue(field({ name: 'exp', semantic: 'card_expiry' }), {
      seed: 'run-1',
    });
    // Eight years ahead of SYNTHETIC_CLOCK. Asserted against the clock rather
    // than against today, so this test does not rot the way the value does —
    // and the value's own expiry is documented where the constant lives.
    const expected = new Date(SYNTHETIC_CLOCK).getUTCFullYear() + 8;
    expect(result.value).toBe(`12/${String(expected).slice(-2)}`);
  });

  it('formats a month input as the month input wants', () => {
    const result = syntheticValue(
      field({ name: 'exp', semantic: 'card_expiry', inputType: 'month' }),
      { seed: 'run-1' },
    );
    expect(result.value).toMatch(/^\d{4}-12$/);
  });

  it('uses the fictional 555-01XX range for phone numbers', () => {
    const result = syntheticValue(field({ name: 'phone', semantic: 'phone' }), { seed: 'run-1' });
    expect(result.value.replace(/\D/g, '')).toMatch(/^155555501\d{2}$/);
  });
});

describe('the factory wrapper', () => {
  it('scopes cumulatively', () => {
    const run = createSyntheticFactory({ seed: 'run-1' });
    const test = run.scoped('test-a');
    const nested = test.scoped('step-1');
    const f = field({ name: 'email', semantic: 'email' });
    const values = [run.value(f), test.value(f), nested.value(f)];
    expect(new Set(values).size).toBe(3);
    expect(createSyntheticFactory({ seed: 'run-1' }).scoped('test-a').value(f)).toBe(test.value(f));
  });

  it('names the field it could not understand, in the value', () => {
    const result = syntheticValue(field({ name: 'mystery', semantic: 'unknown' }), {
      seed: 'run-1',
    });
    expect(result.value).toMatch(/^qaai-/);
  });
});

describe('formatDate', () => {
  const date = new Date('2026-03-05T09:07:00.000Z');
  it.each([
    ['date', '2026-03-05'],
    ['month', '2026-03'],
    ['time', '09:07'],
    ['datetime-local', '2026-03-05T09:07'],
  ])('formats %s', (type, expected) => {
    expect(formatDate(date, type)).toBe(expected);
  });

  it('formats a week input as an ISO week', () => {
    expect(formatDate(date, 'week')).toMatch(/^2026-W\d{2}$/);
  });
});
