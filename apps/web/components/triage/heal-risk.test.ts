import { describe, expect, it } from 'vitest';
import type { Heal } from '../../lib/api';
import {
  HEAL_VERIFY_LABEL,
  RISK,
  UNRECOGNISED_RISK,
  appliesImmediately,
  isRetirement,
  riskOf,
  verifyMeta,
  verifyTone,
} from './heal-risk';

/**
 * A proposal must never be described as the opposite of what it does.
 *
 * The defect: `riskOf` was `RISK[level] ?? RISK.STRUCTURAL` and RISK had no
 * RETIRE arm, so a proposal to switch a test OFF rendered with the label, the
 * colour and the blurb of a structural code change — "review it as you would a
 * colleague's pull request" — and a reviewer pressing Apply was not told they
 * were removing coverage.
 */

const heal = (over: Partial<Heal> = {}): Heal => ({
  id: 'hp_1',
  testId: 't_1',
  diff: '',
  explanation: 'the route this test walks no longer exists',
  riskLevel: 'RETIRE',
  confidence: 0.9,
  state: 'PROPOSED',
  createdAt: '2026-10-24T00:00:00.000Z',
  // NULL and not omitted: "no pull request" is the fixture's claim, and an
  // absent field would be the type widening rather than the fact being stated.
  pullRequest: null,
  test: { id: 't_1', name: 'checkout → pay', filePath: 'tests/pay.spec.ts', code: '' },
  preview: {
    kind: 'RETIREMENT',
    applies: true,
    code: null,
    reason: null,
    fuzz: null,
    review: 'Accepting this disables the test.',
    flags: [],
    checks: 'No code check applies: a retirement changes no code.',
  },
  verification: { state: null, claimsFixed: false, note: null, runId: null, at: null },
  ...over,
});

describe('RETIRE is its own decision', () => {
  it('has an entry of its own, and it is not the structural one', () => {
    expect(RISK.RETIRE).toBeDefined();
    expect(riskOf('RETIRE')).toBe(RISK.RETIRE);
    expect(riskOf('RETIRE')).not.toBe(RISK.STRUCTURAL);
  });

  it('says what approval does, in the blurb and on the button', () => {
    const meta = riskOf('RETIRE');
    // The two facts a reviewer needs before pressing: the test stops running,
    // and the code is not destroyed.
    expect(meta.blurb.toLowerCase()).toContain('stops running');
    expect(meta.blurb.toLowerCase()).toContain('switch it back on');
    // "Apply" was the word on the button that switched a test off.
    expect(meta.action.toLowerCase()).toContain('retire');
    expect(meta.action.toLowerCase()).not.toBe('apply');
  });

  it('never applies without a confirmation', () => {
    // `appliesImmediately` is an allow-list of one. A retirement that slipped
    // through it would delete a test on a single click.
    expect(appliesImmediately(heal({ riskLevel: 'RETIRE' }))).toBe(false);
    expect(appliesImmediately(heal({ riskLevel: 'STRUCTURAL' }))).toBe(false);
    expect(appliesImmediately(heal({ riskLevel: 'ASSERTION_CHANGE' }))).toBe(false);
    expect(appliesImmediately(heal({ riskLevel: 'SELECTOR_ONLY' }))).toBe(true);
  });

  it('is recognised as a retirement so the card shows evidence, not a diff', () => {
    expect(isRetirement(heal({ riskLevel: 'RETIRE' }))).toBe(true);
    expect(isRetirement(heal({ riskLevel: 'SELECTOR_ONLY' }))).toBe(false);
  });
});

describe('an unknown risk level', () => {
  it('reads as unrecognised rather than borrowing another level’s sentence', () => {
    // The fallback is what hid the missing RETIRE arm for as long as it did:
    // describing an unknown value with a known value's words cannot fail
    // visibly.
    const meta = riskOf('SOMETHING_NEW');
    expect(meta).toBe(UNRECOGNISED_RISK);
    expect(meta.blurb.toLowerCase()).toContain('does not recognise');
  });
});

describe('verifyMeta', () => {
  it('says nothing at all for a null state', () => {
    // Null means nobody applied this proposal, so nothing was verified. It is
    // not a failed verification and must not be coloured like one.
    expect(verifyMeta(null)).toBeNull();
  });

  it('claims a pass only for VERIFIED', () => {
    expect(verifyMeta('VERIFIED')).toBe(HEAL_VERIFY_LABEL.VERIFIED);
    expect(verifyMeta('VERIFIED')?.tone).toBe('pass');
    for (const state of ['PENDING', 'STILL_FAILING', 'UNVERIFIABLE']) {
      expect(verifyMeta(state)?.tone).not.toBe('pass');
    }
  });

  it('keeps "nobody could check" apart from "the fix did not work"', () => {
    // UNVERIFIABLE is the member that must exist: applied, and nobody checked.
    // Collapsing it into either neighbour is a lie in one direction or the
    // other.
    expect(verifyMeta('UNVERIFIABLE')?.word).not.toEqual(verifyMeta('STILL_FAILING')?.word);
    expect(verifyMeta('UNVERIFIABLE')?.word.toLowerCase()).toContain('nobody');
    expect(verifyMeta('STILL_FAILING')?.word.toLowerCase()).toContain('still failing');
  });

  it('reports a state it does not know as unrecognised, not as "not verified"', () => {
    // The column is TEXT with its domain enforced at the producer, so a newer
    // deployment's value reaches this build as a value it cannot interpret —
    // which is a different sentence from a check that came back negative.
    const meta = verifyMeta('REVERTED_BY_HUMAN');
    expect(meta?.word).toContain('REVERTED_BY_HUMAN');
    expect(meta?.word.toLowerCase()).toContain('not recognise');
  });
});

describe('verifyTone', () => {
  it('gives the pass colour only when the server says the test was re-run and passed', () => {
    expect(verifyTone(true, verifyMeta('VERIFIED'))).toBe('pass');
    expect(verifyTone(false, verifyMeta('UNVERIFIABLE'))).not.toBe('pass');
    expect(verifyTone(false, verifyMeta('STILL_FAILING'))).toBe('fail');
  });

  it('refuses the pass colour for a VERIFIED row the server does not vouch for', () => {
    // `claimsFixed` is `verifyState === 'VERIFIED'` today, so this cannot
    // happen from this producer. Requiring both is what makes a producer that
    // changes one without the other read as unresolved instead of as a proven
    // fix.
    expect(verifyTone(false, verifyMeta('VERIFIED'))).toBe('flake');
  });

  it('is neutral when nothing was claimed at all', () => {
    // An absent verification is not an amber one.
    expect(verifyTone(false, null)).toBe('neutral');
  });
});
