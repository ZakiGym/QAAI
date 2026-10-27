/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it } from 'vitest';
import {
  paymentScenarioSchema,
  paymentsTestSpecSchema,
  PAYMENT_SCENARIO_KINDS,
  OUTCOME_FORCING_SCENARIOS,
} from './schemas.js';
import { SECRET_SHAPES, admitPublishedValue, catalogueHasId } from './provider-catalogue.js';

const BASE = {
  kind: 'AUTHORISE_AND_CAPTURE' as const,
  testMode: true as const,
  publisher: 'STRIPE',
  catalogueId: null,
  path: '/checkout',
  amountMinor: 4_200,
  currency: 'GBP',
};

/* Rule E: a credential-shaped probe string is COMPOSED at run time from the
 * exported vocabulary plus an obviously-fake tail, never written as a literal. */
const FAKE_TAIL = ['zz', 'not', 'a', 'real', 'key', '0000'].join('');
const LIVE_SHAPED = SECRET_SHAPES.map((s) => `${s.prefix}${FAKE_TAIL}`);

describe('ADVERSARY — PAYMENTS: live mode is structurally unreachable', () => {
  it('the honest baseline parses, so the refusals below are not vacuous', () => {
    expect(paymentScenarioSchema.safeParse(BASE).success).toBe(true);
  });

  it('refuses testMode:false, and testMode omitted, and every falsy spelling', () => {
    for (const value of [false, 0, '', null, 'false', 'true', 1, 'TEST'] as unknown[]) {
      const r = paymentScenarioSchema.safeParse({ ...BASE, testMode: value });
      expect(r.success, JSON.stringify(value)).toBe(false);
    }
    const { testMode: _omitted, ...noMode } = BASE;
    expect(paymentScenarioSchema.safeParse(noMode).success).toBe(false);
  });

  it('a DESERIALISED spec — the JSON-round-trip path a stored row takes — is refused', () => {
    // The realistic attack: a row in the database with testMode false.
    const stored = JSON.stringify({ ...BASE, testMode: false });
    const r = paymentScenarioSchema.safeParse(JSON.parse(stored));
    expect(r.success).toBe(false);
    // And through the whole-spec door, not only the leaf.
    const whole = paymentsTestSpecSchema.safeParse(
      JSON.parse(JSON.stringify({ scenarios: [{ ...BASE, testMode: false }] })),
    );
    expect(whole.success).toBe(false);
  });

  it('a CAST is defeated at run time, because the refusal is a parse and not a type', () => {
    const cast = { ...BASE, testMode: false } as unknown as typeof BASE;
    expect(paymentScenarioSchema.safeParse(cast).success).toBe(false);
    // And again through the spec door.
    expect(paymentsTestSpecSchema.safeParse({ scenarios: [cast] }).success).toBe(false);
  });

  it('carries NO credential field — every shape in the exported vocabulary is refused', () => {
    for (const field of ['apiKey', 'secretKey', 'token', 'key', 'publishableKey', 'liveKey', 'mode', 'livemode', 'live_mode']) {
      for (const value of LIVE_SHAPED.slice(0, 3)) {
        const r = paymentScenarioSchema.safeParse({ ...BASE, [field]: value });
        expect(r.success, `${field}`).toBe(false);
      }
    }
    // Every declared shape, not a hand-written subset of them.
    expect(LIVE_SHAPED.length).toBeGreaterThanOrEqual(16);
    for (const shaped of LIVE_SHAPED) {
      expect(paymentScenarioSchema.safeParse({ ...BASE, apiKey: shaped }).success).toBe(false);
    }
  });

  it('a "single boolean" provider cannot smuggle live mode through any extra key', () => {
    for (const field of ['live', 'sandbox', 'production', 'env', 'environment', 'testmode', 'test_mode']) {
      expect(
        paymentScenarioSchema.safeParse({ ...BASE, [field]: true }).success,
        field,
      ).toBe(false);
    }
  });

  it('refuses a decline scenario with nothing to force the outcome', () => {
    for (const kind of OUTCOME_FORCING_SCENARIOS) {
      const r = paymentScenarioSchema.safeParse({ ...BASE, kind, catalogueId: null });
      expect(r.success, kind).toBe(false);
    }
  });

  it('refuses a webhook scenario with no event, and a partial with no partial amount', () => {
    expect(paymentScenarioSchema.safeParse({ ...BASE, kind: 'WEBHOOK_TRANSITION' }).success).toBe(false);
    for (const kind of ['PARTIAL_CAPTURE', 'REFUND_PARTIAL'] as const) {
      expect(paymentScenarioSchema.safeParse({ ...BASE, kind }).success, kind).toBe(false);
      expect(
        paymentScenarioSchema.safeParse({ ...BASE, kind, partialAmountMinor: BASE.amountMinor + 1 })
          .success,
        `${kind} over the authorisation`,
      ).toBe(false);
    }
  });
});

describe('ADVERSARY — PAYMENTS: the catalogue gate is NOT enforced by the schema', () => {
  it('FINDING: catalogueId accepts a string the catalogue has never heard of', () => {
    /*
     * `catalogueId` is `z.string().min(1).max(120)` and the comment says it is
     * "validated against the catalogue by the producer". There is no producer and
     * no plugin, so NOTHING validates it: an invented id parses, is stored, and
     * would be handed to whatever plugin eventually lands. This test documents
     * the gap; it is a finding, not a pass.
     */
    const invented = 'card_that_does_not_exist_anywhere';
    const r = paymentScenarioSchema.safeParse({
      ...BASE,
      kind: 'DECLINE_INSUFFICIENT_FUNDS',
      catalogueId: invented,
    });
    expect(r.success).toBe(true); // ← the hole
    expect(catalogueHasId(invented)).toBe(false);
  });

  it('FINDING: a raw card-shaped number parses as a catalogueId', () => {
    // A 16-digit PAN is a plain string and the schema has no opinion about it.
    const panShaped = ['4', '1', '1', '1'].join('').repeat(4);
    const r = paymentScenarioSchema.safeParse({
      ...BASE,
      kind: 'DECLINE_GENERIC',
      catalogueId: panShaped,
    });
    expect(r.success).toBe(true); // ← the hole
    expect(catalogueHasId(panShaped)).toBe(false);
  });

  it('admitPublishedValue DOES refuse a credential-shaped value, so the gate exists upstream', () => {
    for (const shaped of LIVE_SHAPED) {
      const admission = admitPublishedValue(shaped);
      expect(admission.admitted, shaped.slice(0, 8)).toBe(false);
    }
  });

  it('every scenario kind is reachable and the forcing list is a real subset', () => {
    expect(PAYMENT_SCENARIO_KINDS.length).toBe(14);
    for (const kind of OUTCOME_FORCING_SCENARIOS) {
      expect(PAYMENT_SCENARIO_KINDS).toContain(kind);
    }
    expect(OUTCOME_FORCING_SCENARIOS.length).toBeLessThan(PAYMENT_SCENARIO_KINDS.length);
  });
});
