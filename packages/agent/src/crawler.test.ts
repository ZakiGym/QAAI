import { describe, expect, it } from 'vitest';
import { FORM_FIELD_SEMANTICS } from '@qaai/shared';
import { normaliseRoute, semanticFor } from './crawler';

/**
 * What is and is not covered here, said plainly.
 *
 * `semanticFor` and `normaliseRoute` are pure functions and are tested
 * properly. The in-page constraint extraction (`readConstraints`) is NOT
 * covered: it runs inside `locator.evaluate()` and needs a real browser, so a
 * unit test could only exercise a mock of the DOM and would prove that the mock
 * matches the code rather than that the code reads a page correctly. Naming the
 * gap beats a test that reads as coverage and measures nothing — the attributes
 * it reads are exercised end to end by the demo app's checkout form
 * (apps/demo/src/views.ts), which carries required, inputmode and autocomplete
 * on every field.
 */

describe('semanticFor', () => {
  it('trusts the autocomplete token over any guess from the name', () => {
    // The token vocabulary is specified, so a developer who wrote it has TOLD
    // us what the field is; everything else in the function is inference from a
    // string somebody chose for other reasons.
    expect(semanticFor('f1', 'text', 'Number', 'cc-number')).toBe('credit_card');
    expect(semanticFor('q', 'text', 'Code', 'cc-csc')).toBe('card_cvc');
    expect(semanticFor('x', 'text', 'Line one', 'address-line1')).toBe('street_address');
    expect(semanticFor('x', 'text', 'Town', 'address-level2')).toBe('city');
    expect(semanticFor('whatever', 'text', '', 'email')).toBe('email');
  });

  it('reads the demo checkout form the way that form is actually marked up', () => {
    // Mirrors apps/demo/src/views.ts, which is the one real form in this repo.
    expect(semanticFor('email', 'email', 'Email', 'email')).toBe('email');
    expect(semanticFor('fullName', 'text', 'Full name', 'name')).toBe('person_name');
    expect(semanticFor('address', 'text', 'Street address', 'street-address')).toBe(
      'street_address',
    );
    expect(semanticFor('city', 'text', 'City', 'address-level2')).toBe('city');
    expect(semanticFor('postalCode', 'text', 'Postal code', 'postal-code')).toBe('postal_code');
    expect(semanticFor('cardNumber', 'text', 'Card number', 'cc-number')).toBe('credit_card');
  });

  it('classifies a username, which used to come back as freeform', () => {
    // `\bname\b` does not match inside "username" — no word boundary — so these
    // fell through to the free-text branch and got a sentence typed into them.
    expect(semanticFor('username', 'text', 'Username')).toBe('username');
    expect(semanticFor('user_name', 'text', '')).toBe('username');
    expect(semanticFor('handle', 'text', 'Handle')).toBe('username');
  });

  it('classifies a URL field, which used to come back as unknown', () => {
    expect(semanticFor('website', 'url', 'Website')).toBe('url');
    expect(semanticFor('homepage', 'text', 'Homepage')).toBe('url');
  });

  it('separates money from a plain count', () => {
    expect(semanticFor('price', 'number', 'Price')).toBe('currency');
    expect(semanticFor('subtotal', 'text', 'Subtotal')).toBe('currency');
    // `amount` stays a number, where it has always been: it is as often a count
    // as a sum, and this rule only claims the words that can only mean money.
    expect(semanticFor('amount', 'number', 'Amount')).toBe('number');
    expect(semanticFor('quantity', 'number', 'Quantity')).toBe('number');
  });

  it('keeps every pre-existing classification unchanged', () => {
    // These are the answers this function gave before constraints were added.
    // A regression here would silently reclassify fields in every new crawl.
    expect(semanticFor('email', 'email', '')).toBe('email');
    expect(semanticFor('pw', 'password', '')).toBe('password');
    expect(semanticFor('q', 'search', '')).toBe('search');
    expect(semanticFor('phone', 'tel', '')).toBe('phone');
    expect(semanticFor('cvc', 'text', 'CVC')).toBe('card_cvc');
    expect(semanticFor('expiry', 'text', 'Expiry')).toBe('card_expiry');
    expect(semanticFor('cardNumber', 'text', 'Card number')).toBe('credit_card');
    expect(semanticFor('zip', 'text', '')).toBe('postal_code');
    expect(semanticFor('country', 'text', '')).toBe('country');
    expect(semanticFor('city', 'text', '')).toBe('city');
    expect(semanticFor('street', 'text', '')).toBe('street_address');
    expect(semanticFor('fullName', 'text', 'Full name')).toBe('person_name');
    expect(semanticFor('dob', 'date', '')).toBe('date');
    expect(semanticFor('message', 'textarea', '')).toBe('freeform');
    expect(semanticFor('anything', 'text', '')).toBe('freeform');
    expect(semanticFor('mystery', 'checkbox', '')).toBe('unknown');
  });

  it('only ever returns a name from the shared vocabulary', () => {
    const inputs: Array<[string, string, string, string?]> = [
      ['email', 'email', 'Email'],
      ['x', 'text', ''],
      ['x', 'checkbox', ''],
      ['x', 'text', '', 'nonsense-token'],
      ['', '', ''],
    ];
    for (const [name, type, label, autocomplete] of inputs) {
      expect(FORM_FIELD_SEMANTICS).toContain(semanticFor(name, type, label, autocomplete));
    }
  });

  it('ignores an autocomplete token it does not know', () => {
    expect(semanticFor('email', 'email', 'Email', 'off')).toBe('email');
    expect(semanticFor('q', 'search', '', 'nope')).toBe('search');
  });

  it('reads the first known token in a multi-token autocomplete value', () => {
    expect(semanticFor('x', 'text', '', 'shipping street-address')).toBe('street_address');
    expect(semanticFor('x', 'text', '', 'section-a billing postal-code')).toBe('postal_code');
  });
});

describe('normaliseRoute', () => {
  it.each([
    ['/orders/1001', '/orders/:id'],
    ['/orders/ORD-1001', '/orders/:id'],
    ['/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/users/:id'],
    ['/products', '/products'],
    ['/', '/'],
  ])('collapses %s', (input, expected) => {
    expect(normaliseRoute(input)).toBe(expected);
  });
});
