import { describe, expect, it } from 'vitest';
import { PERFORMANCE_METRICS, gateRuleSchema, planItemSchema, updateGateRulesSchema } from './schemas';
import { FINDING_KINDS, FINDING_SEVERITIES, GATE_RULE_KINDS, type GateRule } from './types';

/**
 * The gate rules, and the break this file exists to make impossible.
 *
 * `gateRuleSchema` is the ONLY write path to `Project.gateRules`: PUT
 * /projects/:projectId/gate-rules parses through it and nothing else writes the
 * column. Seven members were added to the `GateRule` union and not to that
 * schema, so for as long as that lasted every one of them was refused on the
 * way in — the six measurement rules plus the environment evaluation could not
 * be saved by any customer, and the feature was reachable only by hand-editing
 * a database row.
 *
 * `check:wiring` cannot see this. It looks for a FILE nobody reaches, and a
 * union member with no write path is live code in a reached file.
 *
 * So the guard is a PARITY ASSERTION, not a case per kind. Six hand-written
 * cases would have passed for the four kinds that existed and said nothing
 * about the five that did not: a test that enumerates what someone remembered
 * to enumerate cannot catch the thing that was forgotten. Two mechanisms,
 * because each catches what the other cannot:
 *
 *   · `GATE_RULE_KINDS` is derived from a `Record<GateRule['kind'], true>`, so
 *     the COMPILER refuses a list that is missing a union member or names one
 *     that does not exist.
 *   · the test below compares that list against the zod union's own options,
 *     which exist only at run time.
 *
 * A new `GateRule` kind therefore cannot ship unsaveable: it breaks the record
 * until it is listed, and it breaks this test until it is in the schema.
 */

/** The discriminant of each arm of the zod union, as zod itself holds it. */
function zodGateRuleKinds(): string[] {
  return gateRuleSchema.options.map((option) => option.shape.kind.value as string);
}

describe('gateRuleSchema ⇄ GateRule parity', () => {
  it('has one arm for every kind in the TypeScript union, and no others', () => {
    // Sorted: declaration order is not part of the contract, membership is.
    expect(zodGateRuleKinds().slice().sort()).toEqual(GATE_RULE_KINDS.slice().sort());
  });

  it('names every kind the union names — spelled out, so a failure reads', () => {
    // The same assertion as above, phrased so the diff on failure says WHICH
    // kind cannot be saved rather than printing two lists for a reader to
    // compare by eye.
    const inZod = new Set(zodGateRuleKinds());
    const unsaveable = GATE_RULE_KINDS.filter((kind) => !inZod.has(kind));
    expect(unsaveable).toEqual([]);
  });

  it('refuses a kind the union does not have', () => {
    const result = gateRuleSchema.safeParse({ kind: 'MIN_VIBES', percent: 50, action: 'BLOCK' });
    expect(result.success).toBe(false);
  });
});

/**
 * One accepted example per kind, and they are not decoration.
 *
 * The parity test above proves an ARM exists; it cannot prove the arm accepts
 * the shape the union declares. A `MIN_COVERAGE` arm that required `ratePercent`
 * would satisfy parity and still refuse every rule a client sends.
 *
 * Each row is typed `GateRule`, so the compiler checks the fixture against the
 * union and the parse checks it against the schema — the two directions of the
 * same claim, which is what "no project can save one" needed.
 */
const ACCEPTED: readonly GateRule[] = [
  { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
  { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
  { kind: 'MAX_P95_LATENCY_MS', ms: 2_000, action: 'BLOCK' },
  { kind: 'MIN_PASS_RATE', ratePercent: 95, action: 'BLOCK' },
  { kind: 'MAX_QUARANTINE_PERCENT', percent: 10, action: 'WARN' },
  { kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' },
  { kind: 'MIN_PATCH_COVERAGE', percent: 100, action: 'BLOCK' },
  { kind: 'MIN_MUTATION_SCORE', percent: 60, action: 'WARN' },
  { kind: 'NO_NEW_UNCOVERED_ROUTES', action: 'BLOCK' },
  { kind: 'MAX_FINDINGS', atOrAbove: 'CRITICAL', onlyKinds: [], max: 0, action: 'BLOCK' },
  { kind: 'MAX_VITAL_BREACHES', metric: 'ANY', max: 0, action: 'WARN' },
  { kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' },
];

describe('gateRuleSchema accepts every kind', () => {
  it('covers all of them, so this table cannot fall behind the union', () => {
    expect(ACCEPTED.map((rule) => rule.kind).sort()).toEqual(GATE_RULE_KINDS.slice().sort());
  });

  it.each(ACCEPTED.map((rule) => [rule.kind, rule] as const))('accepts %s', (_kind, rule) => {
    const result = gateRuleSchema.safeParse(rule);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('round-trips through the PUT body schema the route actually parses', () => {
    const parsed = updateGateRulesSchema.parse({ rules: ACCEPTED });
    expect(parsed.rules.map((rule) => rule.kind)).toEqual(ACCEPTED.map((rule) => rule.kind));
  });
});

/**
 * The vocabularies the gate selects on are the product's own, not a second
 * copy written to make gating tidy. A rule that could be configured against a
 * severity no plugin emits is a rule that blocks on a word nothing produces.
 */
describe('the gate rules borrow their vocabularies', () => {
  it.each(FINDING_SEVERITIES)('MAX_FINDINGS takes severity %s', (severity) => {
    expect(
      gateRuleSchema.safeParse({
        kind: 'MAX_FINDINGS',
        atOrAbove: severity,
        onlyKinds: [],
        max: 1,
        action: 'WARN',
      }).success,
    ).toBe(true);
  });

  it.each(FINDING_KINDS)('MAX_FINDINGS filters on kind %s', (kind) => {
    expect(
      gateRuleSchema.safeParse({
        kind: 'MAX_FINDINGS',
        atOrAbove: 'SERIOUS',
        onlyKinds: [kind],
        max: 1,
        action: 'WARN',
      }).success,
    ).toBe(true);
  });

  it.each(PERFORMANCE_METRICS)('MAX_VITAL_BREACHES takes metric %s', (metric) => {
    expect(
      gateRuleSchema.safeParse({ kind: 'MAX_VITAL_BREACHES', metric, max: 0, action: 'BLOCK' })
        .success,
    ).toBe(true);
  });

  it('refuses a severity and a metric nothing emits', () => {
    expect(
      gateRuleSchema.safeParse({
        kind: 'MAX_FINDINGS',
        atOrAbove: 'CATASTROPHIC',
        onlyKinds: [],
        max: 1,
        action: 'WARN',
      }).success,
    ).toBe(false);
    expect(
      gateRuleSchema.safeParse({
        kind: 'MAX_VITAL_BREACHES',
        metric: 'vibesMs',
        max: 0,
        action: 'BLOCK',
      }).success,
    ).toBe(false);
  });
});

/**
 * `onlyKinds` defaults to EMPTY and empty means every kind, which is the one
 * place in this schema where a default carries a meaning. A default of `null`
 * or an absent field would make "every kind" and "nobody said" the same value.
 */
describe('MAX_FINDINGS defaults', () => {
  it('defaults onlyKinds to the empty list — every kind, stated', () => {
    const parsed = gateRuleSchema.parse({
      kind: 'MAX_FINDINGS',
      atOrAbove: 'CRITICAL',
      max: 0,
      action: 'BLOCK',
    });
    expect(parsed).toMatchObject({ onlyKinds: [] });
  });

  it('accepts max 0 — the value most teams want, so it cannot be a floor of 1', () => {
    expect(
      gateRuleSchema.safeParse({
        kind: 'MAX_FINDINGS',
        atOrAbove: 'CRITICAL',
        onlyKinds: [],
        max: 0,
        action: 'BLOCK',
      }).success,
    ).toBe(true);
  });

  it('refuses a negative or fractional count', () => {
    for (const max of [-1, 1.5]) {
      expect(
        gateRuleSchema.safeParse({
          kind: 'MAX_FINDINGS',
          atOrAbove: 'CRITICAL',
          onlyKinds: [],
          max,
          action: 'BLOCK',
        }).success,
      ).toBe(false);
    }
  });
});

/**
 * A percentage rule is bounded 0–100 on both ends. 101% is not a stricter gate,
 * it is a gate that can never be satisfied, and `-1` is one that never fires.
 */
describe('percentage bounds', () => {
  it.each(['MIN_COVERAGE', 'MIN_PATCH_COVERAGE', 'MIN_MUTATION_SCORE', 'MAX_QUARANTINE_PERCENT'])(
    '%s accepts 0 and 100 and refuses either side',
    (kind) => {
      for (const percent of [0, 100]) {
        expect(gateRuleSchema.safeParse({ kind, percent, action: 'WARN' }).success).toBe(true);
      }
      for (const percent of [-1, 101]) {
        expect(gateRuleSchema.safeParse({ kind, percent, action: 'WARN' }).success).toBe(false);
      }
    },
  );

  it('takes only WARN or BLOCK as an action — PASS is an outcome, not a setting', () => {
    expect(gateRuleSchema.safeParse({ kind: 'MIN_COVERAGE', percent: 80, action: 'WARN' }).success)
      .toBe(true);
    for (const action of ['PASS', 'UNMEASURED', 'warn']) {
      expect(
        gateRuleSchema.safeParse({ kind: 'MIN_COVERAGE', percent: 80, action }).success,
      ).toBe(false);
    }
  });
});

/**
 * `PlanItem.gapId` — the provenance the database column has always had and the
 * wire shape did not, so both writers attached it by hand after this schema had
 * already parsed the item and dropped it.
 */
describe('planItemSchema gapId', () => {
  const base = {
    id: 'item_1',
    title: 'Checkout with a saved card',
    rationale: 'It is the revenue path.',
    feature: 'Checkout',
    priority: 'CRITICAL_PATH',
    testType: 'E2E',
    steps: ['Open /checkout'],
    assertions: ['The order confirmation names the card'],
  };

  it('keeps a gap id through the parse instead of stripping it', () => {
    const parsed = planItemSchema.parse({ ...base, gapId: 'gap_abc123' });
    expect(parsed.gapId).toBe('gap_abc123');
  });

  it('defaults to null for a cold plan with no gap behind it', () => {
    expect(planItemSchema.parse(base).gapId).toBeNull();
  });

  it('accepts an explicit null — "not minted for a gap" is a real answer', () => {
    expect(planItemSchema.parse({ ...base, gapId: null }).gapId).toBeNull();
  });
});
