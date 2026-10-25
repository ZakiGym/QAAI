/**
 * Tests for the Healer's auto-approval boundary and its lifecycle rules.
 *
 * Three different kinds of dangerous failure are covered here, and they fail in
 * three different directions:
 *
 *  • AUTO-APPROVAL letting through something that should have had a human. The
 *    model self-reports its own risk level, and a self-report is not a safety
 *    boundary.
 *  • SUPERSEDING throwing away a decision somebody already made, or an option
 *    they were entitled to see.
 *  • VERIFICATION claiming a fix works when nobody checked, or silently
 *    reverting a change a person approved.
 */

import { describe, expect, it } from 'vitest';
import {
  decideVerification,
  healKindOf,
  isAutoApprovable,
  planSupersede,
  shouldProposeHeal,
  verificationRunTag,
  parseVerificationRunTag,
  HEAL_VERIFY_STATES,
} from './healer.js';
import type { OpenHeal } from './healer.js';

const CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
  '',
].join('\n');

/** A diff that applies to CODE: renames the test id in the assertion. */
const APPLIES = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

/** A diff against a line that is not in CODE any more. */
const STALE = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('grand-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

const open = (over: Partial<OpenHeal> = {}): OpenHeal => ({
  id: 'heal_1',
  state: 'PROPOSED',
  riskLevel: 'SELECTOR_ONLY',
  diff: APPLIES,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe('auto-approval', () => {
  const selectorOnly = {
    diff: [
      '--- a/t.spec.ts',
      '+++ b/t.spec.ts',
      '@@ -1,1 +1,1 @@',
      "-  await page.getByRole('button', { name: 'Pay' }).click();",
      "+  await page.getByRole('button', { name: 'Place order' }).click();",
    ].join('\n'),
    riskLevel: 'SELECTOR_ONLY',
    confidence: 0.95,
  };

  it('allows a narrow, high-confidence selector change when the org opted in', () => {
    expect(isAutoApprovable(selectorOnly, true).allowed).toBe(true);
  });

  it('refuses a retirement before it even looks at the org setting', () => {
    // The risk-level check further down would also refuse this, but a rule this
    // important must not depend on the order of two unrelated conditions.
    const verdict = isAutoApprovable({ diff: '', riskLevel: 'RETIRE', confidence: 1 }, true);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/never applied without a person/);
    expect(verdict.reason).toMatch(/unreached/);
  });

  it('refuses a proposal with no diff, which an unattended path could not apply', () => {
    const verdict = isAutoApprovable({ ...selectorOnly, diff: '   ' }, true);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/no diff/);
  });

  it('still re-derives the risk from the diff rather than trusting the label', () => {
    const lying = {
      ...selectorOnly,
      diff: [
        '--- a/t.spec.ts',
        '+++ b/t.spec.ts',
        '@@ -1,1 +1,1 @@',
        "-  await expect(page.getByTestId('total')).toHaveText('$42.00');",
        "+  await expect(page.getByTestId('total')).toBeVisible();",
      ].join('\n'),
    };
    expect(isAutoApprovable(lying, true).reason).toMatch(/changes an assertion/);
  });
});

describe('superseding is per TEST, and never rewrites a decision', () => {
  it('supersedes the open proposals for the same test, oldest first', () => {
    const plan = planSupersede({
      incomingId: 'heal_new',
      incomingRiskLevel: 'SELECTOR_ONLY',
      openHeals: [
        open({ id: 'heal_b', createdAt: new Date('2026-10-22T10:00:00Z') }),
        open({ id: 'heal_a', createdAt: new Date('2026-10-21T10:00:00Z') }),
      ],
    });
    expect(plan.ids).toEqual(['heal_a', 'heal_b']);
    expect(plan.reason).toMatch(/keeps its diff/);
  });

  it('leaves applied, auto-applied and rejected proposals exactly as they are', () => {
    // APPLIED is history; REJECTED is a decision a person made. Re-labelling
    // either is a way of quietly undoing something.
    const plan = planSupersede({
      incomingId: 'heal_new',
      incomingRiskLevel: 'SELECTOR_ONLY',
      openHeals: [
        open({ id: 'applied', state: 'APPLIED' }),
        open({ id: 'auto', state: 'AUTO_APPLIED' }),
        open({ id: 'rejected', state: 'REJECTED' }),
        open({ id: 'already', state: 'SUPERSEDED' }),
      ],
    });
    expect(plan.ids).toEqual([]);
  });

  it('never supersedes across kinds: a retirement is not a draft of a patch', () => {
    // A reviewer looking at both "retire this test" and "retarget this button"
    // is facing a real choice, and superseding one with the other would throw
    // away an option they were entitled to see.
    expect(
      planSupersede({
        incomingId: 'patch',
        incomingRiskLevel: 'SELECTOR_ONLY',
        openHeals: [open({ id: 'retire', riskLevel: 'RETIRE', diff: '' })],
      }).ids,
    ).toEqual([]);
    expect(
      planSupersede({
        incomingId: 'retire_new',
        incomingRiskLevel: 'RETIRE',
        openHeals: [open({ id: 'patch' })],
      }).ids,
    ).toEqual([]);
  });

  it('does not supersede the incoming proposal itself', () => {
    expect(
      planSupersede({
        incomingId: 'heal_1',
        incomingRiskLevel: 'SELECTOR_ONLY',
        openHeals: [open({ id: 'heal_1' })],
      }).ids,
    ).toEqual([]);
  });

  it('classifies kinds from the risk level', () => {
    expect(healKindOf('RETIRE')).toBe('RETIREMENT');
    expect(healKindOf('SELECTOR_ONLY')).toBe('PATCH');
    expect(healKindOf('STRUCTURAL')).toBe('PATCH');
  });
});

describe('the per-test guard on spending a strong-model call', () => {
  it('proposes when the test has no open proposal', () => {
    const decision = shouldProposeHeal({ openHeals: [], currentCode: CODE, filePath: 't.spec.ts' });
    expect(decision.propose).toBe(true);
    expect(decision.reuseId).toBeNull();
  });

  it('reuses an open proposal whose diff still applies, instead of minting another', () => {
    // THE DEFECT: the guard was per TestResult, so a test that fails every run
    // bought a new strong-tier call every run and filled the queue by itself.
    const decision = shouldProposeHeal({
      openHeals: [open()],
      currentCode: CODE,
      filePath: 'tests/checkout.spec.ts',
    });
    expect(decision.propose).toBe(false);
    expect(decision.reuseId).toBe('heal_1');
    expect(decision.reason).toMatch(/still applies/);
  });

  it('proposes again, and names the stale rows, once the file has moved on', () => {
    const decision = shouldProposeHeal({
      openHeals: [open({ diff: STALE })],
      currentCode: CODE,
      filePath: 'tests/checkout.spec.ts',
    });
    expect(decision.propose).toBe(true);
    expect(decision.staleIds).toEqual(['heal_1']);
    expect(decision.reason).toMatch(/no longer apply/);
  });

  it('keeps the newest applicable proposal and calls the older ones clutter', () => {
    const decision = shouldProposeHeal({
      openHeals: [
        open({ id: 'older', createdAt: new Date('2026-10-18T10:00:00Z') }),
        open({ id: 'newer', createdAt: new Date('2026-10-22T10:00:00Z') }),
      ],
      currentCode: CODE,
      filePath: 'tests/checkout.spec.ts',
    });
    expect(decision.propose).toBe(false);
    expect(decision.reuseId).toBe('newer');
    expect(decision.staleIds).toEqual(['older']);
  });

  it('never queues a second retirement for the same test', () => {
    const decision = shouldProposeHeal({
      openHeals: [open({ id: 'retire', riskLevel: 'RETIRE', diff: '' })],
      currentCode: CODE,
      kind: 'RETIREMENT',
    });
    expect(decision.propose).toBe(false);
    expect(decision.reuseId).toBe('retire');
  });

  it('ignores the other lane entirely', () => {
    // An open retirement must not stop a patch being proposed, or a renamed
    // button would be un-healable for as long as somebody ignored the
    // retirement row.
    expect(
      shouldProposeHeal({
        openHeals: [open({ id: 'retire', riskLevel: 'RETIRE', diff: '' })],
        currentCode: CODE,
        filePath: 'tests/checkout.spec.ts',
      }).propose,
    ).toBe(true);
  });
});

describe('verification: what happens when a heal is applied and still red', () => {
  const base = {
    healState: 'APPLIED',
    runStatus: 'FAILED',
    resultStatus: 'FAILED',
    retriedAndPassed: false,
    appliedVersion: 4,
  };

  it('reports PENDING while the verifying run is in flight, and claims nothing', () => {
    const outcome = decideVerification({ ...base, runStatus: null, resultStatus: null });
    expect(outcome.state).toBe('PENDING');
    expect(outcome.revert).toBe(false);
    expect(outcome.note).toMatch(/has not finished/);
  });

  it('verifies a heal whose test passed', () => {
    const outcome = decideVerification({
      ...base,
      runStatus: 'PASSED',
      resultStatus: 'PASSED',
    });
    expect(outcome.state).toBe('VERIFIED');
    expect(outcome.revert).toBe(false);
  });

  it('calls a pass-on-retry verified but says the test is unstable', () => {
    // The heal did fix the failure it was proposed for. What it did not do is
    // make the test stable, and that is the flake lane's job, not this one's.
    const outcome = decideVerification({
      ...base,
      runStatus: 'PASSED',
      resultStatus: 'PASSED',
      retriedAndPassed: true,
    });
    expect(outcome.state).toBe('VERIFIED');
    expect(outcome.passedOnRetry).toBe(true);
    expect(outcome.note).toMatch(/only on retry/);
    expect(outcome.note).toMatch(/also unstable/);
  });

  it('does NOT revert a heal a person approved, and says why', () => {
    const outcome = decideVerification(base);
    expect(outcome.state).toBe('STILL_FAILING');
    expect(outcome.revert).toBe(false);
    expect(outcome.note).toMatch(/a person approved it/);
    expect(outcome.note).toMatch(/still red and still gating/);
  });

  it('DOES revert an unattended heal that failed its own check', () => {
    const outcome = decideVerification({ ...base, healState: 'AUTO_APPLIED' });
    expect(outcome.state).toBe('STILL_FAILING');
    expect(outcome.revert).toBe(true);
    expect(outcome.note).toMatch(/REVERTED to version 3/);
  });

  it('does not put a reverted proposal back in the review queue, and the doc says so', () => {
    /*
     * THE DEFECT: the AUTO_APPLIED paragraph on `decideVerification` said the
     * reverted proposal "goes back to PROPOSED for a person" and the note the
     * function returns said the opposite — a doc comment contradicting the code
     * under it, about the one question a reviewer of this lane would ask.
     *
     * The CODE is the correct half, and `recordVerification` in
     * apps/worker/src/processors/flake.ts deliberately does not touch `state`
     * for exactly this reason: offering a human a fix we have evidence does not
     * work is how a product recommends the same wrong answer for ever. The
     * paragraph now agrees. This pins the behaviour the paragraph describes.
     */
    const outcome = decideVerification({ ...base, healState: 'AUTO_APPLIED' });
    expect(outcome.note).toMatch(/NOT put back in the review queue/);
    expect(outcome.note).not.toMatch(/back to PROPOSED/);
    expect(outcome.note).toMatch(/triage will propose afresh/);
    // And the state is the verification verdict only — nothing in this outcome
    // asks a caller to move the proposal's lifecycle state.
    expect(Object.keys(outcome).sort()).toEqual(['note', 'passedOnRetry', 'revert', 'state']);
  });

  it('refuses to revert an unattended heal whose previous version is unknown', () => {
    // Reverting to "whatever came before", guessed, could write a version of
    // the test the heal never replaced.
    const outcome = decideVerification({
      ...base,
      healState: 'AUTO_APPLIED',
      appliedVersion: null,
    });
    expect(outcome.state).toBe('STILL_FAILING');
    expect(outcome.revert).toBe(false);
    expect(outcome.note).toMatch(/could not be reverted automatically/);
  });

  it('calls an errored run UNVERIFIABLE and never a pass', () => {
    for (const runStatus of ['ERRORED', 'CANCELLED']) {
      const outcome = decideVerification({ ...base, runStatus, resultStatus: null });
      expect(outcome.state).toBe('UNVERIFIABLE');
      expect(outcome.revert).toBe(false);
      expect(outcome.note).toMatch(/nobody has confirmed it works/);
      expect(outcome.note).toMatch(/has NOT been shown to pass/);
    }
  });

  it('calls a run that never executed the test UNVERIFIABLE, not verified', () => {
    const outcome = decideVerification({
      ...base,
      runStatus: 'PASSED',
      resultStatus: 'SKIPPED',
    });
    expect(outcome.state).toBe('UNVERIFIABLE');
    expect(outcome.note).toMatch(/without executing the test/);
  });

  it('never reverts on no information, on either path', () => {
    for (const healState of ['APPLIED', 'AUTO_APPLIED']) {
      expect(
        decideVerification({ ...base, healState, runStatus: 'ERRORED', resultStatus: null }).revert,
      ).toBe(false);
    }
  });

  it('has no state meaning "not verified", because NULL is that', () => {
    // The column is nullable on purpose: "nobody applied this" and "the check
    // passed" must never be the same value.
    expect(HEAL_VERIFY_STATES).not.toContain('NOT_VERIFIED');
    expect([...HEAL_VERIFY_STATES]).toEqual([
      'PENDING',
      'VERIFIED',
      'STILL_FAILING',
      'UNVERIFIABLE',
    ]);
  });
});

describe('the verification run tag', () => {
  it('round-trips', () => {
    expect(parseVerificationRunTag(verificationRunTag('heal_abc'))).toBe('heal_abc');
  });

  it('ignores every other trigger, including the flake radar’s', () => {
    expect(parseVerificationRunTag('flake-radar:t1:inv1')).toBeNull();
    expect(parseVerificationRunTag('user_42')).toBeNull();
    expect(parseVerificationRunTag(null)).toBeNull();
    expect(parseVerificationRunTag('heal-verify:')).toBeNull();
  });
});
