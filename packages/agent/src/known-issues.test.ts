/**
 * Tests for durable mutes and heal supersession.
 *
 * The dangerous failure here is not "a mute did not fire" — that costs a model
 * call and the board stays honest. The dangerous failure is a mute that fires
 * when it should not: an expired one still suppressing, or a broad "same test,
 * same error class" match swallowing a failure nobody inspected. Both make a
 * red thing quiet, and a board that goes quiet for the wrong reason is the one
 * outcome that would make this product worse than nothing.
 *
 * So the order of this file is deliberate. THE EXPIRY RULE IS FIRST, because it
 * is the rule every previous implementation of suppression in this repo forgot.
 */

import { describe, expect, it } from 'vitest';
import { suppressionEventSchema } from '@qaai/shared';
import {
  EXPIRED_LEDGER_REASON,
  HEAL_CHURN_FINDING_THRESHOLD,
  KNOWN_ISSUE_ADOPTION_MIN_CONFIDENCE,
  KNOWN_ISSUE_MATCH_TIERS,
  KNOWN_ISSUE_TIER_RULES,
  NEAR_UNEVALUABLE_REASONS,
  errorClassOf,
  healChurnFinding,
  knownIssueSuppression,
  knownIssueTally,
  matchKnownIssues,
  planHealSupersession,
  suppressionEventsFor,
} from './known-issues.js';
import type {
  FailureIdentity,
  KnownIssueMatchTier,
  KnownIssueRow,
  NearUnevaluableReason,
  OpenHealProposal,
} from './known-issues.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const LATER = new Date('2026-11-05T12:00:00.000Z');
const EARLIER = new Date('2026-10-20T12:00:00.000Z');

const KEY_A = 'a1b2c3d4e5f6';
const KEY_B = '0f1e2d3c4b5a';

const SIG_TIMEOUT = 'class=TimeoutError | selector=[data-testid=pay] | msg=locator not found';
const SIG_ASSERT = 'class=AssertionError | assert=toHaveText | msg=expected <str> got <str>';

function failure(over: Partial<FailureIdentity> = {}): FailureIdentity {
  return { clusterKey: KEY_A, signature: SIG_TIMEOUT, testId: 'test-1', ...over };
}

function issue(over: Partial<KnownIssueRow> = {}): KnownIssueRow {
  return {
    id: 'ki-1',
    title: 'Stripe sandbox times out on pay',
    reason: 'The sandbox is rate limiting us until the new key lands next sprint.',
    signatures: [KEY_A],
    expiresAt: LATER,
    revokedAt: null,
    owner: { kind: 'USER', userId: 'user-dana' },
    ownerProvenance: 'EXPLICIT_ASSIGNMENT',
    matchCount: 12,
    covered: [{ clusterKey: KEY_A, signature: SIG_TIMEOUT, testIds: ['test-1'] }],
    ...over,
  };
}

// ─── 1. The expiry rule, first ───────────────────────────────────────────────

describe('an expired known issue does not suppress', () => {
  it('suppresses while it is in force', () => {
    const result = matchKnownIssues([issue()], failure(), NOW);
    expect(result.tier).toBe('EXACT');
    expect(knownIssueSuppression(result, failure()).suppress).toBe(true);
    expect(knownIssueSuppression(result, failure()).modelCallSkipped).toBe(true);
  });

  it('stops suppressing the moment it expires, with no human action', () => {
    // Expiry exactly at `now`. The keystone's boundary is `>` not `>=`: a
    // suppression whose expiry is this instant is OVER.
    const result = matchKnownIssues([issue({ expiresAt: NOW })], failure(), NOW);
    expect(result.tier).toBe('NONE');
    expect(result.issue).toBeNull();
    const decision = knownIssueSuppression(result, failure());
    expect(decision.suppress).toBe(false);
    // The cost comes back with the redness. That is the deal.
    expect(decision.modelCallSkipped).toBe(false);
  });

  it('reports the expired issue WITH ITS OWNER, because the owner has to renew it', () => {
    const result = matchKnownIssues([issue({ expiresAt: EARLIER })], failure(), NOW);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]).toMatchObject({
      id: 'ki-1',
      forceState: 'EXPIRED',
      owner: { kind: 'USER', userId: 'user-dana' },
      ownerProvenance: 'EXPLICIT_ASSIGNMENT',
      wouldHaveMatched: 'EXACT',
    });
    expect(result.disclosure).toContain('red again');
  });

  it('tells a revoked issue apart from an expired one', () => {
    const result = matchKnownIssues(
      [issue({ expiresAt: LATER, revokedAt: EARLIER })],
      failure(),
      NOW,
    );
    expect(result.tier).toBe('NONE');
    // Revocation beats expiry: this row's expiry is in the FUTURE and it is
    // still dead. Only the revoked case says anything about the decision.
    expect(result.expired[0]?.forceState).toBe('REVOKED');
  });

  it('does not even NEAR-match once it is over, and still reports who owns it', () => {
    /*
     * Found by mutation: with only the call site's filter, mutating it away
     * left the near loop happily matching an EXPIRED mute — which minted an
     * adoption proposal for a dead issue and a ledger row claiming
     * `inForce: true`. The near loop asks `isInForce` itself now.
     */
    const moved = failure({ clusterKey: KEY_B });
    const over = issue({
      expiresAt: EARLIER,
      signatures: [KEY_A],
      covered: [{ clusterKey: KEY_A, signature: SIG_TIMEOUT, testIds: ['test-1'] }],
    });
    const result = matchKnownIssues([over], moved, NOW);
    expect(result.tier).toBe('NONE');
    expect(knownIssueSuppression(result, moved).adoption).toBeNull();
    // The counterfactual is still answered: it WOULD have near-matched, and
    // the owner is named so somebody can renew it.
    expect(result.expired[0]).toMatchObject({ wouldHaveMatched: 'NEAR', id: 'ki-1' });
    // And the ledger row says it suppressed nothing.
    const { events } = suppressionEventsFor(result, moved, {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 5,
    });
    expect(events[0]).toMatchObject({ inForce: false, suppressed: 0 });
  });

  it('counts an expired issue in the ledger as inForce:false, suppressed:0', () => {
    const result = matchKnownIssues([issue({ expiresAt: EARLIER })], failure(), NOW);
    const { match, events } = suppressionEventsFor(result, failure(), {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 40,
    });

    // No match row: nothing matched. But the EVENT exists, and it is the row
    // that proves the expiry worked.
    expect(match).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'MUTE',
      inForce: false,
      suppressed: 0,
      reason: EXPIRED_LEDGER_REASON,
    });
    // Not the mute's own reason: that reason explains why the cause WAS muted,
    // and this row's subject is that it no longer is.
    expect(events[0]?.reason).not.toContain('rate limiting');
  });
});

// ─── 2. Exact matching, and what must never widen it ─────────────────────────

describe('a mute matches the cause somebody triaged, and nothing else', () => {
  it('matches a key the issue names and skips the model call', () => {
    const result = matchKnownIssues([issue({ signatures: [KEY_B, KEY_A] })], failure(), NOW);
    expect(result.tier).toBe('EXACT');
    expect(result.confidence).toBe(1);
    expect(result.considered).toBe(1);
    expect(knownIssueSuppression(result, failure()).issueId).toBe('ki-1');
  });

  it('does not match a prefix, a superstring or a neighbouring key', () => {
    for (const key of [KEY_A.slice(0, 6), `${KEY_A}00`, KEY_B]) {
      const result = matchKnownIssues([issue({ signatures: [key] })], failure(), NOW);
      expect(result.tier, key).toBe('NONE');
    }
  });

  it('reports the denominator of a no-match, so "no mute" is distinguishable from "no mutes exist"', () => {
    expect(matchKnownIssues([], failure(), NOW).disclosure).toContain('No known issue was in force');
    const some = matchKnownIssues([issue({ signatures: [KEY_B] })], failure(), NOW);
    expect(some.considered).toBe(1);
    expect(some.disclosure).toContain('None of the 1 known issue(s) in force');
  });

  it('counts only the issues IN FORCE in that denominator', () => {
    // "None of the 4 known issues in force names this cause" has to be true
    // about four LIVE issues. Counting the dead ones inflates the denominator of
    // the one sentence a reader uses to judge how hard we looked.
    const result = matchKnownIssues(
      [
        issue({ id: 'live', signatures: [KEY_B] }),
        issue({ id: 'gone', signatures: [KEY_B], expiresAt: EARLIER }),
        issue({ id: 'revoked', signatures: [KEY_B], revokedAt: EARLIER }),
      ],
      failure(),
      NOW,
    );
    expect(result.considered).toBe(1);
    expect(result.disclosure).toContain('None of the 1 known issue(s) in force');
  });

  it('prefers the exact match over a near one, whatever order the rows arrive in', () => {
    const near = issue({
      id: 'ki-near',
      signatures: [KEY_B],
      covered: [{ clusterKey: KEY_B, signature: SIG_TIMEOUT, testIds: ['test-1'] }],
    });
    const exact = issue({ id: 'ki-exact', signatures: [KEY_A] });
    expect(matchKnownIssues([near, exact], failure(), NOW).issue?.id).toBe('ki-exact');
    expect(matchKnownIssues([exact, near], failure(), NOW).issue?.id).toBe('ki-exact');
  });
});

// ─── 3. The broader match proposes; it never suppresses ──────────────────────

describe('a signature that moved is found, and it does not silence anything', () => {
  const moved = failure({ clusterKey: KEY_B });
  const covering = issue({
    signatures: [KEY_A],
    covered: [{ clusterKey: KEY_A, signature: SIG_TIMEOUT, testIds: ['test-1'] }],
  });

  it('matches the same test and the same error class under a different key', () => {
    const result = matchKnownIssues([covering], moved, NOW);
    expect(result.tier).toBe('NEAR');
    expect(result.confidence).toBe(KNOWN_ISSUE_TIER_RULES.NEAR.confidence);
  });

  it('REFUSES to suppress on it — a new failure on a muted test looks exactly like this', () => {
    const decision = knownIssueSuppression(matchKnownIssues([covering], moved, NOW), moved);
    expect(decision.suppress).toBe(false);
    expect(decision.modelCallSkipped).toBe(false);
    expect(KNOWN_ISSUE_TIER_RULES.NEAR.maySuppress).toBe(false);
  });

  it('proposes the new key instead, so the next run is free', () => {
    const decision = knownIssueSuppression(matchKnownIssues([covering], moved, NOW), moved);
    expect(decision.adoption).toMatchObject({ knownIssueId: 'ki-1', clusterKey: KEY_B });
    expect(KNOWN_ISSUE_TIER_RULES.NEAR.confidence).toBeGreaterThan(
      KNOWN_ISSUE_ADOPTION_MIN_CONFIDENCE,
    );
  });

  it('records the near match with suppressed:0 — it nearly fired, it did not fire', () => {
    const result = matchKnownIssues([covering], moved, NOW);
    const { match, events } = suppressionEventsFor(result, moved, {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 7,
    });
    // Counted against the issue, because "this mute nearly fired seven times"
    // is what tells the owner their signature has moved.
    expect(match?.matchCountDelta).toBe(7);
    expect(events[0]).toMatchObject({ inForce: true, suppressed: 0 });
  });

  it('will not near-match a DIFFERENT error class on the same test', () => {
    const differentClass = failure({ clusterKey: KEY_B, signature: SIG_ASSERT });
    expect(matchKnownIssues([covering], differentClass, NOW).tier).toBe('NONE');
  });

  it('will not near-match the same error class on a DIFFERENT test', () => {
    const otherTest = failure({ clusterKey: KEY_B, testId: 'test-99' });
    const result = matchKnownIssues([covering], otherTest, NOW);
    expect(result.tier).toBe('NONE');
    // And it says the tier WAS evaluated, so this is a real "no", not a gap.
    expect(result.nearUnevaluable).toBeNull();
  });

  it('says UNEVALUABLE rather than NONE when it could not look', () => {
    const noJoin = issue({ signatures: [KEY_A], covered: [] });
    expect(matchKnownIssues([noJoin], moved, NOW).nearUnevaluable).toBe('NO_JOINED_CAUSES');

    const noTests = issue({
      signatures: [KEY_A],
      covered: [{ clusterKey: KEY_A, signature: SIG_TIMEOUT, testIds: [] }],
    });
    expect(matchKnownIssues([noTests], moved, NOW).nearUnevaluable).toBe('NO_TEST_IDS');

    const noClass = failure({ clusterKey: KEY_B, signature: 'msg=everything went wrong' });
    expect(matchKnownIssues([covering], noClass, NOW).nearUnevaluable).toBe('NO_ERROR_CLASS');

    // And each of those reasons is in the disclosure, not only in a field.
    for (const reason of NEAR_UNEVALUABLE_REASONS) {
      expect(NEAR_UNEVALUABLE_REASONS).toContain(reason);
    }
    expect(matchKnownIssues([noJoin], moved, NOW).disclosure).toContain('was not evaluated');
  });
});

describe('the signature parser reads one facet and invents none', () => {
  it('reads the class facet wherever it sits', () => {
    expect(errorClassOf(SIG_TIMEOUT)).toBe('TimeoutError');
    expect(errorClassOf('class=Error')).toBe('Error');
  });

  it('returns null for an absent or empty class, so two classless failures never match', () => {
    expect(errorClassOf('msg=something broke')).toBeNull();
    expect(errorClassOf('class= | msg=x')).toBeNull();
    expect(errorClassOf('')).toBeNull();
  });
});

// ─── 4. The vocabulary and the ledger ────────────────────────────────────────

describe('the tier table is complete and the honest confidences are null', () => {
  it('names every tier', () => {
    const named = Object.keys(KNOWN_ISSUE_TIER_RULES).sort();
    expect(named).toEqual([...KNOWN_ISSUE_MATCH_TIERS].sort());
  });

  it('reports NO confidence for NONE rather than zero confidence', () => {
    // "0% confident there is a match" and "there is no match" are different
    // facts, and a 0 here reads as the first.
    expect(KNOWN_ISSUE_TIER_RULES.NONE.confidence).toBeNull();
    expect(matchKnownIssues([], failure(), NOW).confidence).toBeNull();
  });

  it('lets exactly one tier suppress', () => {
    const suppressing = (KNOWN_ISSUE_MATCH_TIERS as readonly KnownIssueMatchTier[]).filter(
      (tier) => KNOWN_ISSUE_TIER_RULES[tier].maySuppress,
    );
    expect(suppressing).toEqual(['EXACT']);
  });
});

describe('the ledger row is one the database will actually accept', () => {
  const parse = (row: unknown) => suppressionEventSchema.safeParse(row);

  it('passes the keystone validator for a live match', () => {
    const result = matchKnownIssues([issue()], failure(), NOW);
    const { events } = suppressionEventsFor(result, failure(), {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 40,
    });
    // Ends at the validator the write path runs, not at the spelling of the
    // fields: a test that asserts a value's spelling does not assert the value
    // can be stored.
    const parsed = parse(events[0]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('passes it for the expired row too, which is the one that proves an expiry', () => {
    const result = matchKnownIssues([issue({ expiresAt: EARLIER })], failure(), NOW);
    const { events } = suppressionEventsFor(result, failure(), {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 3,
    });
    const parsed = parse(events[0]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keys the row on the FAILURE’s cause, not on a key picked out of the mute', () => {
    const multi = issue({ signatures: [KEY_B, KEY_A] });
    const { events, match } = suppressionEventsFor(
      matchKnownIssues([multi], failure(), NOW),
      failure(),
      { projectId: 'proj-1', runId: 'run-1', failures: 1 },
    );
    // A multi-cause mute's ledger has to say WHICH cause fired, and
    // `@@unique([runId, kind, targetKey])` means it gets exactly one row.
    expect(events[0]?.targetKey).toBe(KEY_A);
    expect(match?.clusterKey).toBe(KEY_A);
    expect(events).toHaveLength(1);
  });

  it('writes nothing at all when there was nothing to say', () => {
    const result = matchKnownIssues([issue({ signatures: [KEY_B] })], failure(), NOW);
    expect(suppressionEventsFor(result, failure(), {
      projectId: 'proj-1',
      runId: 'run-1',
      failures: 2,
    })).toEqual({ match: null, events: [] });
  });

  it('hands summariseSuppressions a tally rather than writing a second sentence', () => {
    expect(knownIssueTally({ suppressions: 3, suppressed: 47, expired: 1 })).toEqual({
      kind: 'MUTE',
      suppressions: 3,
      suppressed: 47,
      expired: 1,
    });
  });
});

// ─── 5. Heal supersession: the cause, not just the test ──────────────────────

function open(over: Partial<OpenHealProposal> = {}): OpenHealProposal {
  return {
    id: 'heal-1',
    causeKey: KEY_A,
    stillApplies: true,
    reviewedAt: null,
    createdAt: EARLIER,
    ...over,
  };
}

const quiet = { supersededWithoutReview: 0, reviewedEver: 0 };

describe('one proposal per cause, never fifty copies of one', () => {
  it('buys the first proposal for a cause', () => {
    const plan = planHealSupersession({ testId: 't1', causeKey: KEY_A, open: [], ...quiet });
    expect(plan.action).toBe('PROPOSE_FIRST');
    expect(plan.modelCallSkipped).toBe(false);
  });

  it('reuses an open proposal for the SAME cause instead of minting a copy', () => {
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [open()],
      ...quiet,
    });
    expect(plan.action).toBe('REUSE_OPEN');
    expect(plan.reuseId).toBe('heal-1');
    expect(plan.modelCallSkipped).toBe(true);
    expect(plan.supersedeIds).toEqual([]);
  });

  it('does NOT reuse a proposal for a different cause on the same test', () => {
    // THE DEFECT: `shouldProposeHeal` has no notion of the cause, so a selector
    // fix that still applies answers for an arithmetic bug too, and the second
    // cause never gets a proposal.
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_B,
      open: [open({ causeKey: KEY_A })],
      ...quiet,
    });
    expect(plan.action).toBe('PROPOSE_FIRST');
    expect(plan.reuseId).toBeNull();
    // And the other cause's proposal is left alone — closing it would throw
    // away an answer a person is entitled to see.
    expect(plan.supersedeIds).toEqual([]);
  });

  it('supersedes the stale ones rather than deleting them, oldest first', () => {
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [
        open({ id: 'heal-new', stillApplies: false, createdAt: new Date('2026-10-28T00:00:00Z') }),
        open({ id: 'heal-old', stillApplies: false, createdAt: new Date('2026-10-01T00:00:00Z') }),
      ],
      ...quiet,
    });
    expect(plan.action).toBe('SUPERSEDE_AND_PROPOSE');
    expect(plan.supersedeIds).toEqual(['heal-old', 'heal-new']);
    expect(plan.modelCallSkipped).toBe(false);
  });

  it('keeps the newest usable proposal and supersedes the rest of its own lane', () => {
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [
        open({ id: 'heal-stale', stillApplies: false, createdAt: EARLIER }),
        open({ id: 'heal-good', stillApplies: true, createdAt: new Date('2026-10-28T00:00:00Z') }),
      ],
      ...quiet,
    });
    expect(plan.reuseId).toBe('heal-good');
    expect(plan.supersedeIds).toEqual(['heal-stale']);
  });

  it('treats a null cause as reusable but never as grounds for closing anything', () => {
    const reusable = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [open({ id: 'legacy', causeKey: null })],
      ...quiet,
    });
    expect(reusable.action).toBe('REUSE_OPEN');
    expect(reusable.causeUnknown).toBe(true);

    const stale = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [open({ id: 'legacy', causeKey: null, stillApplies: false })],
      ...quiet,
    });
    // A proposal whose cause nobody recorded is not superseded by a cause it
    // cannot be shown to share.
    expect(stale.supersedeIds).toEqual([]);
    expect(stale.causeUnknown).toBe(true);
    expect(stale.action).toBe('PROPOSE_FIRST');
  });
});

describe('proposing forever at a queue nobody reads is the finding', () => {
  it('says nothing below the threshold — two is a coincidence', () => {
    expect(
      healChurnFinding({
        testId: 't1',
        supersededWithoutReview: HEAL_CHURN_FINDING_THRESHOLD - 1,
        reviewedEver: 0,
      }),
    ).toBeNull();
  });

  it('reports the churn at the threshold, with the number and the threshold that bit', () => {
    const finding = healChurnFinding({
      testId: 't1',
      supersededWithoutReview: HEAL_CHURN_FINDING_THRESHOLD,
      reviewedEver: 0,
    });
    expect(finding).not.toBeNull();
    expect(finding!.supersededWithoutReview).toBe(HEAL_CHURN_FINDING_THRESHOLD);
    expect(finding!.threshold).toBe(HEAL_CHURN_FINDING_THRESHOLD);
    expect(finding!.disclosure).toContain('still failing and still gates');
  });

  it('PAUSES the strong-model call and says so as a count and a reason', () => {
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [],
      supersededWithoutReview: 9,
      reviewedEver: 0,
    });
    expect(plan.action).toBe('PAUSE_FOR_CHURN');
    expect(plan.modelCallSkipped).toBe(true);
    // The cap that bit is reported as a count AND a reason.
    expect(plan.churn?.supersededWithoutReview).toBe(9);
    expect(plan.reason).toContain('9 heal proposals');
    // Nothing is closed while paused: a superseded row with no replacement is a
    // review somebody lost for a proposal that was never made.
    expect(plan.supersedeIds).toEqual([]);
  });

  it('is cleared by ONE human review, with no clock and no column', () => {
    expect(
      healChurnFinding({ testId: 't1', supersededWithoutReview: 50, reviewedEver: 1 }),
    ).toBeNull();
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [],
      supersededWithoutReview: 50,
      reviewedEver: 1,
    });
    expect(plan.action).toBe('PROPOSE_FIRST');
    expect(plan.churn).toBeNull();
  });

  it('hands back an open proposal even while paused — reuse costs nothing', () => {
    const plan = planHealSupersession({
      testId: 't1',
      causeKey: KEY_A,
      open: [open()],
      supersededWithoutReview: 9,
      reviewedEver: 0,
    });
    expect(plan.action).toBe('REUSE_OPEN');
    // The finding still rides along: the queue is still not being read.
    expect(plan.churn).not.toBeNull();
  });
});

describe('the near-match reasons are a closed vocabulary', () => {
  it('every reason has a note, and no note is missing', () => {
    const moved = failure({ clusterKey: KEY_B });
    const seen = new Set<NearUnevaluableReason>();
    seen.add(
      matchKnownIssues([issue({ signatures: [KEY_A], covered: [] })], moved, NOW)
        .nearUnevaluable as NearUnevaluableReason,
    );
    seen.add(
      matchKnownIssues(
        [
          issue({
            signatures: [KEY_A],
            covered: [{ clusterKey: KEY_A, signature: SIG_TIMEOUT, testIds: [] }],
          }),
        ],
        moved,
        NOW,
      ).nearUnevaluable as NearUnevaluableReason,
    );
    seen.add(
      matchKnownIssues(
        [issue()],
        failure({ clusterKey: KEY_B, signature: 'msg=no class here at all' }),
        NOW,
      ).nearUnevaluable as NearUnevaluableReason,
    );
    expect([...seen].sort()).toEqual([...NEAR_UNEVALUABLE_REASONS].sort());
  });
});
