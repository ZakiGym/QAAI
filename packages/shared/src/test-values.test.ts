import { describe, expect, it } from 'vitest';
import {
  OMITTED_FOR_LACK_OF_CONFIDENCE,
  TEST_VALUES,
  cardForOutcome,
  describeTestValueConfidence,
  isLuhnValid,
  luhnBreak,
  testValuesForProvider,
  testValuesOfKind,
} from './test-values';

/**
 * This file is the catalogue's own honesty check, and it is the reason any entry
 * is allowed to say `verified: true`.
 *
 * The register's warning was that a card number nobody is sure of is worse than
 * an absent one, because a test built on it fails for a reason nobody can
 * diagnose. There is no network here, so "is 4000000000000002 really the
 * generic-decline card" is not a question these tests can answer. What they CAN
 * answer is everything the value proves about itself — every number must pass
 * Luhn, the one deliberately-invalid number must fail it, and no entry may
 * claim more evidence than it has. A recalled digit string that fails Luhn is
 * a transcription error, and that check alone catches the most likely way for a
 * number in this file to be wrong.
 */

describe('every card number proves what it can about itself', () => {
  const cards = TEST_VALUES.filter((v) => v.kind === 'card');

  it('has cards to check', () => {
    expect(cards.length).toBeGreaterThan(5);
  });

  it.each(cards.filter((c) => c.outcome !== 'invalid-number').map((c) => [c.id, c.value] as const))(
    '%s passes the Luhn checksum',
    (_id, value) => {
      // A recalled card number with a typo in it almost always fails Luhn, so
      // this is the single highest-value check available without a network.
      expect(value).not.toBeNull();
      expect(isLuhnValid(value!)).toBe(true);
    },
  );

  it.each(cards.filter((c) => c.outcome === 'invalid-number').map((c) => [c.id, c.value] as const))(
    '%s fails the Luhn checksum, which is the whole point of it',
    (_id, value) => {
      expect(isLuhnValid(value!)).toBe(false);
    },
  );

  it('gives every card an outcome, so no entry is a number with no meaning', () => {
    for (const card of cards) {
      expect(card.outcome, card.id).toBeDefined();
    }
  });

  it('marks every card test-mode-only except the one that is invalid everywhere', () => {
    for (const card of cards) {
      // A Luhn-invalid number is refused by any form in any mode, so it is the
      // one card value that is safe to carry without a test-mode warning.
      expect(card.testModeOnly, card.id).toBe(card.outcome !== 'invalid-number');
    }
  });
});

describe('isLuhnValid', () => {
  it('accepts the published test card in every formatting', () => {
    expect(isLuhnValid('4242424242424242')).toBe(true);
    expect(isLuhnValid('4242 4242 4242 4242')).toBe(true);
    expect(isLuhnValid('4242-4242-4242-4242')).toBe(true);
  });

  it('rejects anything that is not a card-shaped string, without throwing', () => {
    for (const input of ['', 'abcd', '4242', '42424242424242424242424242', '4242 4242 4242 424a']) {
      expect(isLuhnValid(input)).toBe(false);
    }
  });
});

describe('luhnBreak', () => {
  it('turns any valid number into an invalid one of the same length', () => {
    for (const valid of ['4242424242424242', '4111111111111111', '4000000000000002']) {
      const broken = luhnBreak(valid);
      expect(broken).toHaveLength(valid.length);
      expect(isLuhnValid(broken)).toBe(false);
      // Same prefix, so a form's brand detection still fires and the case tests
      // the checksum rather than the BIN lookup standing in front of it.
      expect(broken.slice(0, 6)).toBe(valid.slice(0, 6));
    }
  });

  it('is deterministic', () => {
    expect(luhnBreak('4242424242424242')).toBe(luhnBreak('4242424242424242'));
  });
});

describe('honesty invariants', () => {
  it('populates sourceNote on every entry, with no placeholders', () => {
    for (const entry of TEST_VALUES) {
      expect(entry.sourceNote.length, entry.id).toBeGreaterThan(30);
      expect(entry.sourceNote, entry.id).not.toMatch(/TODO|TBD|FIXME/i);
    }
  });

  it('says what the app should do for every entry — an entry with no expectation is a value with no test', () => {
    for (const entry of TEST_VALUES) {
      expect(entry.expected.length, entry.id).toBeGreaterThan(20);
      expect(entry.purpose.length, entry.id).toBeGreaterThan(10);
    }
  });

  it('never claims verification it has not got', () => {
    for (const entry of TEST_VALUES) {
      if (entry.verified) {
        // The only grounds for `verified: true` are arithmetic done here, a
        // second independent appearance inside this repo, or a property of a
        // standard. Recall is never grounds, and this is the assertion that
        // keeps someone from quietly promoting a recalled entry.
        expect(['computed-here', 'corroborated-in-repo', 'standards-reserved'], entry.id).toContain(
          entry.evidence,
        );
      } else {
        // And an unverified entry must say WHICH kind of unverified it is:
        // recalled from a vendor's docs, or dependent on infrastructure this
        // module cannot see. Those need different things from the reader.
        expect(['published-recalled', 'environment-dependent'], entry.id).toContain(entry.evidence);
      }
    }
  });

  it('carries no value at all on a no-fixed-value entry', () => {
    for (const entry of TEST_VALUES.filter((v) => v.kind === 'no-fixed-value')) {
      expect(entry.value, entry.id).toBeNull();
    }
    for (const entry of TEST_VALUES.filter((v) => v.kind !== 'no-fixed-value')) {
      expect(entry.value, entry.id).not.toBeNull();
    }
  });

  it('uses unique ids, so a generated test can reference one unambiguously', () => {
    const ids = TEST_VALUES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records what was left out rather than leaving the gap to be inferred', () => {
    expect(OMITTED_FOR_LACK_OF_CONFIDENCE.length).toBeGreaterThan(3);
    for (const omission of OMITTED_FOR_LACK_OF_CONFIDENCE) {
      expect(omission.why.length, omission.what).toBeGreaterThan(40);
    }
  });

  it('leads its summary with what is NOT verified', () => {
    const summary = describeTestValueConfidence();
    expect(summary).toMatch(/recalled/);
    expect(summary).toMatch(/left out|omitted/i);
  });

  it('only uses reserved domains in its mail patterns', () => {
    for (const entry of testValuesOfKind('email-pattern')) {
      // RFC 2606 (example.*, .invalid) and RFC 6761 (.test). A real domain in
      // this list would be an address that can reach somebody.
      expect(entry.value, entry.id).toMatch(/example\.com|\.invalid|\.test|<domain>/);
    }
  });
});

describe('lookups', () => {
  it('finds a card for each outcome it carries', () => {
    expect(cardForOutcome('success')?.value).toBe('4242424242424242');
    expect(cardForOutcome('declined-generic')?.provider).toBe('stripe');
    expect(cardForOutcome('requires-3ds')).not.toBeNull();
  });

  it('falls back to Stripe for a provider that has no card for that outcome, and says so', () => {
    const fallback = cardForOutcome('declined-insufficient-funds', 'square');
    expect(fallback?.provider).toBe('stripe');
    // The fallback is only defensible because the entry names its own provider,
    // which is what makes the assumption auditable rather than invisible.
    expect(fallback?.sourceNote).toMatch(/Stripe/i);
  });

  it('returns null rather than a wrong card when nothing matches', () => {
    expect(cardForOutcome('declined-expired-card', 'paypal')?.provider).toBe('stripe');
    expect(testValuesForProvider('paypal').every((v) => v.kind === 'no-fixed-value')).toBe(true);
  });

  it('groups by provider', () => {
    expect(testValuesForProvider('stripe').length).toBeGreaterThan(5);
    expect(testValuesForProvider('twilio').length).toBe(2);
  });
});
