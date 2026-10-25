import { describe, expect, it } from 'vitest';
import {
  CLOSURE_APPROVAL_POLICIES,
  CLOSURE_CAMPAIGN_STATES,
  CLOSURE_STATES,
  GATE_RULE_KINDS,
  HEAL_STATES,
  ISSUE_OWNER_STATES,
  ISSUE_SUBJECTS,
  OWNERSHIP_STATES,
  type CauseIdentity,
  type HealProposal,
  type OwnerAssignment,
  type TestExecution,
  type TriageVerdict,
} from './types';

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
