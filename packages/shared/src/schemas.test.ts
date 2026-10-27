import { describe, expect, it } from 'vitest';
import {
  PERFORMANCE_METRICS,
  coverageConfigSchema,
  createTestSchema,
  freshnessDaysSchema,
  gateRuleSchema,
  planItemSchema,
  suiteHealthSnapshotSchema,
  testCoverageEdgeSchema,
  testMetricSchema,
  testResultVariantSchema,
  testVariantKeySchema,
  updateGateRulesSchema,
  updateTestSchema,
} from './schemas';
import { FINDING_KINDS, FINDING_SEVERITIES, GATE_RULE_KINDS, UNVARIED, type GateRule } from './types';
import { DEFAULT_COVERAGE_FRESHNESS_DAYS } from './coverage-tiers';
/*
 * The sentinel's OWNER. schemas.ts restates the literal because it cannot
 * import this module — auth-profiles.ts imports `authProfileConfigSchema` back
 * out of schemas.ts, so a value import there closes the cycle. A test file can
 * import both, which is what pins the duplicate to its source.
 */
import { ANONYMOUS_ROLE } from './auth-profiles';

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

// ─── Measurement: the write paths the ladder depends on ─────────────────────

/**
 * The shapes this round added, and the refusals that are the whole point of
 * them.
 *
 * The tier/source/cap parity assertions live in `coverage-tiers.test.ts`, next
 * to the vocabulary they guard. What is asserted here is what the SCHEMAS
 * refuse: a regex claiming certainty, a static writer storing PASSING, a metric
 * that is both null and explained away, a forged "this was not varied"
 * sentinel, and an out-of-scope brake a caller could set past 100.
 */
describe('testCoverageEdgeSchema', () => {
  const runtime = {
    testId: 'tst_1',
    itemKey: 'ROUTE:/orders/:id',
    source: 'RUNTIME' as const,
    tier: 'PASSING' as const,
    confidence: 1,
    evidence: 'the run navigated to /orders/42 and asserted the total',
    lastConfirmedRunId: 'run_9',
    lastConfirmedAtIso: '2026-10-25T00:00:00.000Z',
  };

  it('accepts a RUNTIME edge that names the run it was confirmed by', () => {
    const parsed = testCoverageEdgeSchema.parse(runtime);
    expect(parsed.tier).toBe('PASSING');
    expect(parsed.cappedBy).toBeNull();
  });

  it('refuses a STATIC edge above DECLARED — a regex is not an observation', () => {
    /*
     * The single most important refusal in the file. If a STATIC writer could
     * store PASSING, the ladder would be decoration: the number on screen would
     * again be "some test mentions it" wearing the word "passing".
     */
    const result = testCoverageEdgeSchema.safeParse({
      ...runtime,
      source: 'STATIC',
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a SPEC declaration promoted past DECLARED', () => {
    // Otherwise `covers: ['ROUTE:/billing']` is a one-line way to manufacture
    // a green coverage report.
    expect(
      testCoverageEdgeSchema.safeParse({ ...runtime, source: 'SPEC', confidence: 0.9 }).success,
    ).toBe(false);
  });

  it('accepts STATIC and SPEC at DECLARED', () => {
    for (const source of ['STATIC', 'SPEC'] as const) {
      const parsed = testCoverageEdgeSchema.parse({
        ...runtime,
        source,
        tier: 'DECLARED',
        confidence: 0.5,
        lastConfirmedRunId: null,
        lastConfirmedAtIso: null,
      });
      expect(parsed.tier).toBe('DECLARED');
    }
  });

  it('caps confidence per source, so a regex cannot read as certainty', () => {
    // Same argument as `LINK_METHOD_CONFIDENCE_CEILING`: a method able to write
    // 1.0 is a guess that renders as traceability.
    expect(
      testCoverageEdgeSchema.safeParse({
        ...runtime,
        source: 'STATIC',
        tier: 'DECLARED',
        confidence: 1,
        lastConfirmedRunId: null,
        lastConfirmedAtIso: null,
      }).success,
    ).toBe(false);
    expect(
      testCoverageEdgeSchema.safeParse({
        ...runtime,
        source: 'STATIC',
        tier: 'DECLARED',
        confidence: 0.8,
        lastConfirmedRunId: null,
        lastConfirmedAtIso: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a tier above DECLARED with no run to point at', () => {
    // A tier claiming an observation and naming no run is an unauditable
    // claim, which is the one thing a provenance edge may not be.
    expect(
      testCoverageEdgeSchema.safeParse({ ...runtime, lastConfirmedRunId: null }).success,
    ).toBe(false);
  });
});

describe('testMetricSchema', () => {
  const lcp = {
    name: 'lcp',
    value: 2410,
    unit: 'MILLISECONDS' as const,
    direction: 'LOWER_IS_BETTER' as const,
  };

  it('accepts a measured number, including a meaningful zero', () => {
    // 0 is a MEASUREMENT: a pixel-perfect visual diff, a page that painted
    // instantly. A schema that rejected it would force writers to use null and
    // reintroduce the exact confusion the channel exists to end.
    expect(testMetricSchema.parse({ ...lcp, value: 0 }).value).toBe(0);
  });

  it('refuses a null value with no reason, because that is read as zero', () => {
    const result = testMetricSchema.safeParse({ ...lcp, value: null });
    expect(result.success).toBe(false);
  });

  it('accepts a null value that says why it could not be measured', () => {
    const parsed = testMetricSchema.parse({
      ...lcp,
      value: null,
      unavailableReason: 'k6 is not installed on this image',
    });
    expect(parsed.value).toBeNull();
    expect(parsed.unavailableReason).toContain('k6');
  });

  it('refuses a row that both has a value and claims to be unavailable', () => {
    expect(
      testMetricSchema.safeParse({ ...lcp, unavailableReason: 'the trace had no entry' }).success,
    ).toBe(false);
  });

  it('refuses NaN and Infinity, which are not measurements', () => {
    expect(testMetricSchema.safeParse({ ...lcp, value: Number.NaN }).success).toBe(false);
    expect(testMetricSchema.safeParse({ ...lcp, value: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  it('refuses a sentence as a metric name', () => {
    // The name is the key a trend query GROUPs on, and a sentence cannot be
    // grouped on — this is what stops the channel degenerating back into prose.
    expect(testMetricSchema.safeParse({ ...lcp, name: 'Mutation score 72.4%' }).success).toBe(
      false,
    );
  });
});

describe('testVariantKeySchema', () => {
  it('defaults every dimension nobody varied to the sentinel, never to null', () => {
    // Five non-null strings or the unique index that is the row's identity does
    // not hold: PostgreSQL treats every NULL as distinct, so the default cell
    // would re-insert once per run.
    const parsed = testVariantKeySchema.parse({});
    expect(parsed).toEqual({
      browser: UNVARIED,
      viewport: UNVARIED,
      locale: UNVARIED,
      role: UNVARIED,
      environment: UNVARIED,
    });
  });

  it('accepts the anonymous-role sentinel on role and nowhere else', () => {
    expect(testVariantKeySchema.parse({ role: ANONYMOUS_ROLE }).role).toBe(ANONYMOUS_ROLE);
    expect(testVariantKeySchema.safeParse({ browser: ANONYMOUS_ROLE }).success).toBe(false);
  });

  it('pins the duplicated anonymous sentinel to its owner in auth-profiles.ts', () => {
    /*
     * schemas.ts restates `'<anonymous>'` because it cannot import it —
     * auth-profiles.ts imports `authProfileConfigSchema` back out of schemas.ts,
     * so a value import there closes the cycle. This test is what stops the
     * duplicate drifting: the two halves of a variant key disagreeing about how
     * a logged-out visitor is spelled would split every anonymous cell in two.
     */
    expect(ANONYMOUS_ROLE).toBe('<anonymous>');
    expect(testVariantKeySchema.parse({ role: '<anonymous>' }).role).toBe(ANONYMOUS_ROLE);
  });

  it('refuses an invented sentinel, so "not varied" cannot be forged', () => {
    expect(testVariantKeySchema.safeParse({ locale: '<all>' }).success).toBe(false);
    expect(testVariantKeySchema.safeParse({ browser: 'chromium' }).success).toBe(true);
  });
});

describe('testResultVariantSchema', () => {
  const cell = {
    key: { browser: 'webkit', locale: 'de-DE' },
    status: 'FAILED' as const,
    durationMs: 4100,
  };

  it('uses the five statuses the roll-up uses and refuses a sixth', () => {
    // A cell's status has to be the same vocabulary as `TestResult.status` or
    // the worst-wins reduction has nothing to compare.
    expect(testResultVariantSchema.parse(cell).status).toBe('FAILED');
    expect(testResultVariantSchema.safeParse({ ...cell, status: 'ERROR' }).success).toBe(false);
  });

  it('leaves notRun NULL rather than defaulting it to NOT_RUN', () => {
    // NULL is a fifth state: the producer made no claim about why. Defaulting
    // would write a sentence nothing produced, for every cell at once.
    expect(testResultVariantSchema.parse(cell).notRun).toBeNull();
  });

  it('refuses more readings than a cell can honestly produce', () => {
    // A refusal and not a silent truncation: dropping readings over a limit
    // would be a cap that bit without being reported, on a path where the
    // caller can simply be told.
    const metric = {
      name: 'lcp',
      value: 1,
      unit: 'MILLISECONDS' as const,
      direction: 'LOWER_IS_BETTER' as const,
    };
    expect(
      testResultVariantSchema.safeParse({ ...cell, metrics: Array(41).fill(metric) }).success,
    ).toBe(false);
  });
});

describe('createTestSchema / updateTestSchema covers', () => {
  const base = { name: 'Checkout', code: 'test()', filePath: 'e2e/checkout.spec.ts' };

  it('defaults to an empty declaration on create', () => {
    // Declaring nothing is the ordinary case for every hand-written and
    // imported test, and there is no fourth state between that and an empty
    // list — so `[]` is honest here where it would not be on a count.
    expect(createTestSchema.parse(base).covers).toEqual([]);
  });

  it('keeps a declaration through the parse', () => {
    const parsed = createTestSchema.parse({ ...base, covers: ['ROUTE:/orders/:id'] });
    expect(parsed.covers).toEqual(['ROUTE:/orders/:id']);
  });

  it('is OPTIONAL on update, so an older client cannot silently erase one', () => {
    /*
     * Omitted leaves the declaration alone; `[]` deliberately clears it. A
     * client that predates this field sends neither, and if the field were
     * required-with-a-default every save from it would wipe a declaration
     * somebody made.
     */
    expect(updateTestSchema.parse({ code: 'test()' }).covers).toBeUndefined();
    expect(updateTestSchema.parse({ code: 'test()', covers: [] }).covers).toEqual([]);
  });

  it('refuses a declaration that describes a suite rather than a test', () => {
    expect(
      createTestSchema.safeParse({ ...base, covers: Array(101).fill('ROUTE:/a') }).success,
    ).toBe(false);
  });
});

describe('coverageConfigSchema', () => {
  it('defaults to nothing declared, with the out-of-scope brake on', () => {
    const parsed = coverageConfigSchema.parse({});
    expect(parsed.outOfScope).toEqual([]);
    expect(parsed.criticality).toEqual([]);
    // The default brake is conservative on purpose: a quarter of an application
    // being declared not-our-problem is already a lot.
    expect(parsed.maxOutOfScopePercent).toBe(25);
  });

  it('requires a reason on every rule, because a silent exclusion is the defect', () => {
    expect(
      coverageConfigSchema.safeParse({ outOfScope: [{ pattern: 'ROUTE:/internal/**' }] }).success,
    ).toBe(false);
    expect(
      coverageConfigSchema.safeParse({
        outOfScope: [{ pattern: 'ROUTE:/internal/**', reason: 'staff-only admin tool' }],
      }).success,
    ).toBe(true);
  });

  it('accepts the two spellings the money-word regex cannot see', () => {
    // `/pay_now` and `/checkoutConfirm` are exactly what a \b-bounded English
    // word match misses. They are the reason this is configuration.
    const parsed = coverageConfigSchema.parse({
      criticality: [
        { pattern: '/pay_now', reason: 'takes money', level: 'CRITICAL' },
        { pattern: '/checkoutConfirm', reason: 'takes money', level: 'CRITICAL' },
      ],
    });
    expect(parsed.criticality).toHaveLength(2);
  });

  it('bounds the brake and the weight multiplier', () => {
    // A brake above 100 is not a brake, and an unbounded multiplier is a
    // ranking in which one glob is the entire report.
    expect(coverageConfigSchema.safeParse({ maxOutOfScopePercent: 101 }).success).toBe(false);
    expect(
      coverageConfigSchema.safeParse({
        weights: [{ pattern: '/a', reason: 'why', multiplier: 11 }],
      }).success,
    ).toBe(false);
  });
});

describe('suiteHealthSnapshotSchema', () => {
  it('defaults every measurement to NULL and never to 0', () => {
    /*
     * The assertion that makes the whole table honest. 0 is the BEST possible
     * result for five of these, so a `.default(0)` anywhere would turn every
     * unmeasured dimension into a perfect score — and a project that has never
     * been scanned would look identical to one with a flawless suite.
     */
    const parsed = suiteHealthSnapshotSchema.parse({ fingerprint: 'abc' });
    for (const value of [
      parsed.testCount,
      parsed.quarantinedCount,
      parsed.flakyCount,
      parsed.weakAssertionCount,
      parsed.duplicateCount,
      parsed.obsoleteCount,
      parsed.passRatePercent,
      parsed.medianDurationMs,
      parsed.p95DurationMs,
      parsed.score,
    ]) {
      expect(value).toBeNull();
    }
    // The one defaulted field, and the difference is exact: an empty caveat
    // list is a positive, verifiable claim that nothing was truncated.
    expect(parsed.caveats).toEqual([]);
  });

  it('keeps a measured zero as zero', () => {
    const parsed = suiteHealthSnapshotSchema.parse({ fingerprint: 'abc', weakAssertionCount: 0 });
    expect(parsed.weakAssertionCount).toBe(0);
  });

  it('requires a fingerprint, so an unchanged score and an unchanged measurement differ', () => {
    expect(suiteHealthSnapshotSchema.safeParse({}).success).toBe(false);
  });
});

describe('freshnessDaysSchema', () => {
  it('defaults to the documented window and refuses one longer than a year', () => {
    // Three routes with three unvalidated windows would be three different
    // numbers on three screens, because the window is what the difference
    // between PASSING and FRESH MEANS.
    expect(freshnessDaysSchema.parse(undefined)).toBe(DEFAULT_COVERAGE_FRESHNESS_DAYS);
    expect(freshnessDaysSchema.safeParse(366).success).toBe(false);
    expect(freshnessDaysSchema.safeParse(0).success).toBe(false);
  });
});
