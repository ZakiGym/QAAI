import { describe, expect, it } from 'vitest';
import {
  CLOSURE_APPROVAL_POLICIES,
  CLOSURE_CAMPAIGN_STATES,
  CLOSURE_STATES,
  COVERAGE_CRITICALITIES,
  COVERAGE_CRITICALITY_LABELS,
  COVERAGE_CRITICALITY_WEIGHT,
  GATE_RULE_KINDS,
  HEAL_STATES,
  ISSUE_OWNER_STATES,
  ISSUE_SUBJECTS,
  METRIC_DIRECTIONS,
  METRIC_UNITS,
  OWNERSHIP_STATES,
  UNVARIED,
  type CauseIdentity,
  type CoverageConfig,
  type EnvironmentSummary,
  type HealProposal,
  type OwnerAssignment,
  type SuiteHealthSnapshotData,
  type TestExecution,
  type TestMetric,
  type TestResultVariant,
  type TriageVerdict,
} from './types';
import { resolveCrawlPolicy } from './flow-map';

/**
 * The vocabularies this file now owns, pinned at the words they were promoted
 * WITH.
 *
 * Each of these was declared in a leaf file — apps/api/src/lib/ownership.ts,
 * packages/agent/src/coverage.ts, packages/agent/src/healer.ts,
 * apps/worker/src/processors/close-loop.ts — behind a TODO saying it belonged
 * here. Several of them are stored: `GapClosure.state`,
 * `ClosureCampaign.state`, `ClosureCampaign.approvalPolicy` and
 * `TriageVerdict.ownerState` are TEXT columns validated against these arrays
 * and nothing else, so a member dropped or respelled in transit does not fail
 * to compile — it fails to match a row somebody already wrote.
 *
 * That is the specific risk of a promotion, and it is why these are literal
 * lists rather than `expect(X.length).toBe(7)`: the assertion has to be the
 * spelling.
 */
describe('the promoted vocabularies', () => {
  it('keeps the four ownership states', () => {
    expect([...OWNERSHIP_STATES]).toEqual(['OWNED', 'NO_RULES', 'NO_MATCH', 'RULES_UNUSABLE']);
  });

  it('adds SPLIT for a multi-subject ticket, and only there', () => {
    // The relationship is the contract: a ticket may be in any ownership state
    // OR split, and a single verdict may never be SPLIT. Derived from the array
    // above rather than retyped, so the two cannot drift.
    expect([...ISSUE_OWNER_STATES]).toEqual([...OWNERSHIP_STATES, 'SPLIT']);
    expect(OWNERSHIP_STATES).not.toContain('SPLIT');
  });

  it('keeps the two issue subjects', () => {
    expect([...ISSUE_SUBJECTS]).toEqual(['FAILURE', 'COVERAGE_GAP']);
  });

  it('keeps all seven closure states, NOT_CLOSED and UNVERIFIABLE included', () => {
    expect([...CLOSURE_STATES]).toEqual([
      'OPEN',
      'PROPOSED',
      'TEST_WRITTEN',
      'CLOSED',
      'NOT_CLOSED',
      'REOPENED',
      'UNVERIFIABLE',
    ]);
  });

  it('keeps NOT_CLOSED and UNVERIFIABLE distinct from CLOSED and from each other', () => {
    // The two that look redundant are the only reason the ledger is worth
    // building. "We wrote a test and the gap is still reported" and "we could
    // not check" are both reported as CLOSED the moment either is folded in,
    // and a closure number that counts unchecked gaps is fiction.
    for (const state of ['NOT_CLOSED', 'UNVERIFIABLE'] as const) {
      expect(CLOSURE_STATES).toContain(state);
      expect(state).not.toBe('CLOSED');
    }
  });

  it('keeps all eight campaign states', () => {
    expect([...CLOSURE_CAMPAIGN_STATES]).toEqual([
      'RUNNING',
      'TARGET_MET',
      'SETTLED',
      'BUDGET_SPENT',
      'NOTHING_LEFT',
      'TICK_CEILING',
      'UNMEASURABLE',
      'BLOCKED',
    ]);
  });

  it('keeps RUNNING as the only non-terminal campaign state', () => {
    expect(CLOSURE_CAMPAIGN_STATES[0]).toBe('RUNNING');
    expect(CLOSURE_CAMPAIGN_STATES).toHaveLength(8);
  });

  it('keeps both approval policies, with HUMAN_REVIEW available', () => {
    // The default the autopilot falls back to. If it were ever dropped from
    // this list, the fallback would be validated against a list that does not
    // contain it and every campaign would arm as AUTO_APPROVE.
    expect([...CLOSURE_APPROVAL_POLICIES]).toEqual(['AUTO_APPROVE', 'HUMAN_REVIEW']);
  });

  it('keeps all six heal states', () => {
    expect([...HEAL_STATES]).toEqual([
      'PROPOSED',
      'APPROVED',
      'REJECTED',
      'APPLIED',
      'AUTO_APPLIED',
      'SUPERSEDED',
    ]);
  });

  it('has no duplicate member in any of them', () => {
    for (const vocabulary of [
      OWNERSHIP_STATES,
      ISSUE_OWNER_STATES,
      ISSUE_SUBJECTS,
      CLOSURE_STATES,
      CLOSURE_CAMPAIGN_STATES,
      CLOSURE_APPROVAL_POLICIES,
      HEAL_STATES,
      GATE_RULE_KINDS,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});

describe('GATE_RULE_KINDS', () => {
  it('names all twelve gate rule kinds', () => {
    // Derived from a `Record<GateRule['kind'], true>`, so the compiler refuses
    // a missing or invented member. Pinned at run time too, because the list is
    // what `schemas.test.ts` compares the zod union against — a list that
    // silently shrank would make that parity test pass by agreeing with less.
    expect([...GATE_RULE_KINDS].sort()).toEqual([
      'BLOCK_ON_VERDICT',
      'ENVIRONMENT_AVAILABLE',
      'MAX_FINDINGS',
      'MAX_FLAKE_RATE',
      'MAX_P95_LATENCY_MS',
      'MAX_QUARANTINE_PERCENT',
      'MAX_VITAL_BREACHES',
      'MIN_COVERAGE',
      'MIN_MUTATION_SCORE',
      'MIN_PASS_RATE',
      'MIN_PATCH_COVERAGE',
      'NO_NEW_UNCOVERED_ROUTES',
    ]);
  });
});

/**
 * The shapes, as typed fixtures.
 *
 * A pure interface has no run time to assert on, so the compiler is the test:
 * each object below is annotated with the type it claims to be, and a field
 * removed or retyped in types.ts makes this FILE fail to compile. The runtime
 * expectations are there so the fixture cannot be dropped as dead code.
 */
describe('TestExecution.notRun', () => {
  const blocked: TestExecution = {
    testId: 'tst_1',
    status: 'SKIPPED',
    durationMs: 0,
    steps: [],
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    errorMessage: 'k6 is not installed on this image',
    retriedAndPassed: false,
    notRun: { kind: 'UNSUPPORTED', why: 'k6 is not installed on this image' },
    findings: [],
  };

  it('lets a plugin say WHICH of the four reasons applies', () => {
    expect(blocked.notRun).toEqual({
      kind: 'UNSUPPORTED',
      why: 'k6 is not installed on this image',
    });
  });

  it('is optional, so a plugin that makes no claim still compiles', () => {
    // ABSENT IS NOT NOT_RUN. Every plugin that has not learned to classify
    // leaves this undefined, and undefined is the fifth state — the same one
    // `TestResult.notRunKind` spells NULL. Defaulting it would put a claim in
    // the database that no plugin wrote.
    const { notRun: _notRun, ...unclassified } = blocked;
    const execution: TestExecution = unclassified;
    expect(execution.notRun).toBeUndefined();
  });
});

describe('TriageVerdict carries the cause', () => {
  const firstHand: TriageVerdict = {
    verdict: 'REAL_BUG',
    confidence: 0.9,
    explanation: 'The checkout endpoint returned 500 on every attempt.',
    evidence: [{ kind: 'NETWORK', ref: 'POST /api/checkout', detail: '500, three times' }],
    suspectCommit: null,
    model: 'cheap',
    clusterKey: 'a1b2c3d4e5f6',
    derivedFromId: null,
    revision: 1,
    splitFromClusterKey: null,
  };

  it('says NULL derivedFromId for a verdict a model reached itself', () => {
    expect(firstHand.derivedFromId).toBeNull();
  });

  it('names the row a copy came from, so agreement cannot be over-counted', () => {
    // The honesty column. 200 verdicts copied from one model call are one piece
    // of evidence, and a reader who cannot tell a copy from a first-hand
    // judgement will read them as 200.
    const copy: TriageVerdict = {
      ...firstHand,
      model: `cluster:${firstHand.model}`,
      derivedFromId: 'tv_owner_1',
    };
    expect(copy.derivedFromId).toBe('tv_owner_1');
    expect(copy.model.startsWith('cluster:')).toBe(true);
  });

  it('starts at revision 1, never 0', () => {
    // There is no such thing as a verdict that was never reached. A 0 here
    // would make "how many times was this re-judged" undercount by one on
    // every row, and it is the column the revision history joins on.
    expect(firstHand.revision).toBe(1);
    expect(firstHand.revision).toBeGreaterThan(0);
  });
});

describe('the promoted shapes', () => {
  it('CauseIdentity carries ISO strings, because it arrives off JSON', () => {
    const cause: CauseIdentity = {
      clusterKey: 'a1b2c3d4e5f6',
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-24T00:00:00.000Z',
      runsSeen: 12,
      newInThisBuild: false,
      mutedUntil: null,
      mutedReason: null,
    };
    // Strings and not Dates: the web app receives this already serialised, and
    // one caller forgetting to re-hydrate would be comparing a string to a Date
    // and getting `false` for free.
    expect(typeof cause.firstSeenAt).toBe('string');
    expect(cause.mutedUntil).toBeNull();
  });

  it('OwnerAssignment carries the unusable rules even when an owner was found', () => {
    const owned: OwnerAssignment = {
      state: 'OWNED',
      owner: { kind: 'TEAM', teamId: 'team_1' },
      ruleId: 'rule_1',
      note: 'Matched apps/web/checkout/**',
      unusable: [{ ruleId: 'rule_9', reason: 'the pattern did not compile' }],
    };
    // A project can route this test correctly and still have a broken rule that
    // has stopped routing twenty others. Dropping `unusable` on an OWNED
    // assignment is how that stays invisible.
    expect(owned.unusable).toHaveLength(1);
  });

  it('HealProposal.riskLevel can name a retirement', () => {
    const retire: HealProposal = {
      testId: 'tst_1',
      diff: '',
      explanation: 'The route this test opens was deleted six months ago.',
      riskLevel: 'RETIRE',
      confidence: 0.95,
    };
    // The Prisma enum has had RETIRE since 20261024050000; the union did not,
    // so the one risk level that is not a patch at all was a value the database
    // accepted and TypeScript could not name.
    expect(retire.riskLevel).toBe('RETIRE');
    expect(retire.diff).toBe('');
  });
});

// ─── The crawl scope on the environment summary ─────────────────────────────

/**
 * `EnvironmentSummary.crawlPolicy`, and the three states it has to keep apart.
 *
 * This payload crosses the wire and is cached, so the absent case is not
 * hypothetical: a web app holding a response from an older API has no
 * `crawlPolicy` at all. "This payload predates the policy", "this environment
 * never chose one" and "this environment chose these numbers" are three
 * different sentences, and only the last one is something a customer can be
 * held to when they argue about a coverage number.
 */
describe('EnvironmentSummary.crawlPolicy', () => {
  function summary(over: Partial<EnvironmentSummary> = {}): EnvironmentSummary {
    return {
      id: 'env_1',
      name: 'Production',
      kind: 'PRODUCTION',
      baseUrl: 'https://a.example.com',
      ...over,
    };
  }

  it('is absent on a payload that predates it, and that is not "no policy"', () => {
    // A reader that cannot tell these apart would tell a customer their
    // production crawl is unscoped when the truth is that this response is old.
    expect(summary().crawlPolicy).toBeUndefined();
  });

  it('carries the resolved policy, including which fields anybody chose', () => {
    const applied = resolveCrawlPolicy({ pageBudget: 50 });
    const env = summary({ crawlPolicy: applied });
    expect(env.crawlPolicy?.policy.pageBudget).toBe(50);
    expect(env.crawlPolicy?.overridden).toEqual(['pageBudget']);
    // Not defaulted: this environment made a decision. An environment that
    // never chose reports `defaulted: true` with the same policy object, and
    // the panel renders those differently.
    expect(env.crawlPolicy?.defaulted).toBe(false);
  });

  it('reports a defaulted policy as defaulted rather than as a choice', () => {
    expect(summary({ crawlPolicy: resolveCrawlPolicy(null) }).crawlPolicy?.defaulted).toBe(true);
  });
});

// ─── The metric channel and the variant evidence ────────────────────────────

/**
 * The shapes, as typed fixtures, plus the two vocabularies that are STORED.
 *
 * `METRIC_UNITS` and `METRIC_DIRECTIONS` are Postgres enums
 * (`apps/api/scripts/check-enums.ts` pairs both), so a member respelled here
 * is a value no row can hold, discovered on an insert at run time. They are
 * pinned by name for the same reason `GATE_RULE_KINDS` is.
 *
 * The interfaces have no run time to assert on, so the compiler is the test:
 * each object below is annotated with the type it claims to be, and a field
 * removed or retyped in types.ts makes this FILE fail to compile. The runtime
 * expectations exist so the fixtures cannot be dropped as dead code.
 */
describe('METRIC_UNITS and METRIC_DIRECTIONS', () => {
  it('names the nine units and the two directions', () => {
    expect([...METRIC_UNITS].sort()).toEqual([
      'BYTES',
      'COUNT',
      'MILLISECONDS',
      'PERCENT',
      'PIXELS',
      'RATIO',
      'REQUESTS_PER_SECOND',
      'SCORE',
      'SECONDS',
    ]);
    expect([...METRIC_DIRECTIONS].sort()).toEqual(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']);
  });

  it('has no duplicate member', () => {
    expect(new Set(METRIC_UNITS).size).toBe(METRIC_UNITS.length);
    expect(new Set(METRIC_DIRECTIONS).size).toBe(METRIC_DIRECTIONS.length);
  });
});

describe('TestMetric', () => {
  it('carries a measured number with no unavailability reason', () => {
    const lcp: TestMetric = {
      name: 'lcp',
      value: 2410,
      unavailableReason: null,
      unit: 'MILLISECONDS',
      direction: 'LOWER_IS_BETTER',
    };
    expect(lcp.value).toBe(2410);
    expect(lcp.unavailableReason).toBeNull();
  });

  it('spells "we could not measure this" as a NULL with a reason, never as 0', () => {
    /*
     * The distinction the whole channel turns on. A p95 of 0 is a load test
     * that never ran; a null with a reason is a load test that could not be
     * run, and the two must not be the same row. `testMetricSchema` enforces
     * both halves — a null needs a reason, a value forbids one — and
     * schemas.test.ts asserts it.
     */
    const p95: TestMetric = {
      name: 'http_req_duration_p95',
      value: null,
      unavailableReason: 'k6 is not installed on this image',
      unit: 'MILLISECONDS',
      direction: 'LOWER_IS_BETTER',
    };
    expect(p95.value).toBeNull();
    expect(p95.unavailableReason).not.toBeNull();
  });
});

describe('TestResultVariant', () => {
  it('names all five dimensions, with UNVARIED for the ones nobody varied', () => {
    // Five non-null strings, because the persisted row's identity is a unique
    // index over them and PostgreSQL treats every NULL as distinct — a nullable
    // dimension would re-insert the default cell once per run for ever.
    const cell: TestResultVariant = {
      key: {
        browser: 'webkit',
        viewport: '1280x720',
        locale: 'de-DE',
        role: UNVARIED,
        environment: 'env_1',
      },
      status: 'FAILED',
      durationMs: 4100,
      errorMessage: 'expected “Warenkorb”, saw “Cart”',
      retriedAndPassed: false,
    };
    expect(cell.key.role).toBe(UNVARIED);
    expect(UNVARIED).toBe('<unvaried>');
  });

  it('leaves notRun ABSENT rather than defaulting it to NOT_RUN', () => {
    // Identical contract to `TestExecution.notRun` and `TestResult.notRunKind`:
    // absent means the producer made no claim about why, which is a fifth state
    // and is not the weakest of the four.
    const cell: TestResultVariant = {
      key: {
        browser: UNVARIED,
        viewport: UNVARIED,
        locale: UNVARIED,
        role: UNVARIED,
        environment: UNVARIED,
      },
      status: 'PASSED',
      durationMs: 12,
      errorMessage: null,
      retriedAndPassed: false,
    };
    expect(cell.notRun).toBeUndefined();
  });
});

describe('TestExecution.metrics and .variants', () => {
  function execution(over: Partial<TestExecution> = {}): TestExecution {
    return {
      testId: 'tst_1',
      status: 'PASSED',
      durationMs: 100,
      steps: [],
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: null,
      retriedAndPassed: false,
      findings: [],
      ...over,
    };
  }

  it('leaves both undefined for a plugin that measures nothing and varies nothing', () => {
    /*
     * The additive contract. Both are optional for exactly the reason
     * `mutation` and `newBaseline` are: they are plugin-produced extras the
     * WORKER persists, and every existing construction site in the repo keeps
     * compiling and keeps meaning what it meant. Absent on `variants`
     * additionally MEANS something — "this execution was not varied" — which a
     * single synthetic row duplicating the roll-up would have erased.
     */
    const plain = execution();
    expect(plain.metrics).toBeUndefined();
    expect(plain.variants).toBeUndefined();
  });

  it('carries readings and cells when a plugin produced them', () => {
    const rich = execution({
      metrics: [
        {
          name: 'visual_diff_ratio',
          value: 0,
          unavailableReason: null,
          unit: 'RATIO',
          direction: 'LOWER_IS_BETTER',
        },
      ],
      variants: [
        {
          key: {
            browser: 'chromium',
            viewport: '1280x720',
            locale: 'en-US',
            role: UNVARIED,
            environment: 'env_1',
          },
          status: 'PASSED',
          durationMs: 100,
          errorMessage: null,
          retriedAndPassed: false,
        },
      ],
    });
    // 0 here is a MEASUREMENT — a pixel-perfect match — which is the case a
    // channel that used 0 for "not measured" would have made unreportable.
    expect(rich.metrics?.[0]?.value).toBe(0);
    expect(rich.variants?.[0]?.status).toBe('PASSED');
  });
});

// ─── Suite health and the scope its owner declares ──────────────────────────

describe('SuiteHealthSnapshotData', () => {
  it('distinguishes "scanned and found none" from "never scanned"', () => {
    /*
     * The rule the whole table turns on. 0 is the BEST POSSIBLE RESULT for five
     * of these ten, so writing it for a scan that never ran is the most
     * flattering lie this product could tell about itself — a project that has
     * never been scanned would look identical to one with a perfect suite.
     */
    const scanned: SuiteHealthSnapshotData = {
      testCount: 412,
      quarantinedCount: 0,
      flakyCount: 0,
      weakAssertionCount: 0,
      duplicateCount: 0,
      obsoleteCount: 0,
      passRatePercent: 100,
      medianDurationMs: 900,
      p95DurationMs: 4200,
      score: 96,
    };
    const neverScanned: SuiteHealthSnapshotData = {
      testCount: null,
      quarantinedCount: null,
      flakyCount: null,
      weakAssertionCount: null,
      duplicateCount: null,
      obsoleteCount: null,
      passRatePercent: null,
      medianDurationMs: null,
      p95DurationMs: null,
      score: null,
    };
    expect(scanned.weakAssertionCount).toBe(0);
    expect(neverScanned.weakAssertionCount).toBeNull();
    // And the composite obeys the same rule: null is "not computed", where 0
    // would read as a suite with no value whatsoever.
    expect(neverScanned.score).toBeNull();
  });

  it('allows a source-only scan to report six numbers and NULL for the run-derived two', () => {
    // A scan with no run has nothing to say about pass rate or duration, and
    // saying 0 would be a claim about the customer's suite from our silence.
    const sourceOnly: SuiteHealthSnapshotData = {
      testCount: 412,
      quarantinedCount: 3,
      flakyCount: null,
      weakAssertionCount: 18,
      duplicateCount: 4,
      obsoleteCount: 1,
      passRatePercent: null,
      medianDurationMs: null,
      p95DurationMs: null,
      score: null,
    };
    expect(sourceOnly.passRatePercent).toBeNull();
    expect(sourceOnly.weakAssertionCount).toBe(18);
  });
});

describe('COVERAGE_CRITICALITIES', () => {
  it('names four levels, worst first, each with a label and a weight', () => {
    // Order is the contract for the same reason `FINDING_SEVERITIES`' is: a
    // report writes "at or above HIGH", and that only means something if one
    // list decides what "above" is.
    expect([...COVERAGE_CRITICALITIES]).toEqual(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);
    for (const level of COVERAGE_CRITICALITIES) {
      expect(COVERAGE_CRITICALITY_LABELS[level].length).toBeGreaterThan(0);
      expect(COVERAGE_CRITICALITY_WEIGHT[level]).toBeGreaterThan(0);
    }
  });

  it('weights them strictly decreasingly, so the ranking is a ranking', () => {
    const weights = COVERAGE_CRITICALITIES.map((level) => COVERAGE_CRITICALITY_WEIGHT[level]);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]!).toBeLessThan(weights[i - 1]!);
    }
  });
});

describe('CoverageConfig', () => {
  it('keeps out-of-scope separate from a waiver, with a reason on every rule', () => {
    /*
     * Both leave the denominator and they leave it for different reasons. A
     * `CoverageWaiver` is one item with an owner and an expiry; `outOfScope` is
     * a standing statement about a whole region. Merging them would mean either
     * a per-item waiver with no owner or a glob with a single expiry date.
     */
    const config: CoverageConfig = {
      criticality: [{ pattern: '/checkout*', reason: 'takes money', level: 'CRITICAL' }],
      outOfScope: [{ pattern: 'ROUTE:/internal/**', reason: 'staff-only admin tool' }],
      weights: [{ pattern: '/pay_now', reason: 'the money path', multiplier: 4 }],
      maxOutOfScopePercent: 25,
    };
    expect(config.outOfScope[0]?.reason).not.toBe('');
    // The brake is stored beside the rules it bounds, so a reader can always
    // see how much of the denominator the configuration is allowed to remove.
    expect(config.maxOutOfScopePercent).toBe(25);
  });

  it('expresses the two spellings the money-word regex cannot see', () => {
    // `/pay_now` and `/checkoutConfirm` are exactly what a \b-bounded English
    // word match misses, and they are the reason this is configuration rather
    // than a better regex.
    const config: CoverageConfig = {
      criticality: [
        { pattern: '/pay_now', reason: 'takes money', level: 'CRITICAL' },
        { pattern: '/checkoutConfirm', reason: 'takes money', level: 'CRITICAL' },
      ],
      outOfScope: [],
      weights: [],
      maxOutOfScopePercent: 0,
    };
    expect(config.criticality.map((rule) => rule.pattern)).toEqual([
      '/pay_now',
      '/checkoutConfirm',
    ]);
  });
});
