import { describe, expect, it } from 'vitest';
import type { Heal } from '../../lib/api';
import { healVerifyStateSchema } from '@qaai/shared';
import {
  HEAL_VERIFY_LABEL,
  RISK,
  UNRECOGNISED_RISK,
  appliesImmediately,
  claimLine,
  healClaim,
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
  it('gives the pass colour only when BOTH claims say the test was re-run and passed', () => {
    expect(verifyTone(true, true, verifyMeta('VERIFIED'))).toBe('pass');
    expect(verifyTone(false, false, verifyMeta('UNVERIFIABLE'))).not.toBe('pass');
    expect(verifyTone(false, false, verifyMeta('STILL_FAILING'))).toBe('fail');
  });

  it('refuses the pass colour when the two claims disagree, in EITHER direction', () => {
    /*
     * `claimsFixed` is the API's `verifyState === 'VERIFIED'`; `fixed` is
     * `healVerificationDisplay`'s, which also looks at the proposal's own
     * state. They agree today by construction, so neither case below can arise
     * from this producer — and requiring both is what makes a producer that
     * changes one without the other read as unresolved instead of as a proven
     * fix. Green is the one colour on this card a reviewer acts on without
     * reading further.
     */
    expect(verifyTone(false, true, verifyMeta('VERIFIED'))).toBe('flake');
    expect(verifyTone(true, false, verifyMeta('VERIFIED'))).toBe('flake');
  });

  it('is neutral when nothing was claimed at all', () => {
    // An absent verification is not an amber one.
    expect(verifyTone(false, false, null)).toBe('neutral');
  });
});

describe('HEAL_VERIFY_LABEL is a compile-enforced presence record', () => {
  it('has an entry for every state the write path can STORE', () => {
    /*
     * THE DEFECT: the table was `Record<string, VerifyMeta>`, which accepts any
     * key and requires none — so a fifth state added to the vocabulary compiled
     * cleanly here and arrived at `verifyMeta` as a missing entry, to be
     * described by the fallback's "this build cannot interpret this" sentence.
     * `satisfies Record<HealVerifyState, VerifyMeta>` makes that a compile
     * error.
     *
     * The union comes from `healVerifyStateSchema.options` — THE ZOD ENUM THE
     * WRITE PATH VALIDATES AGAINST (`recordHealVerificationSchema`) — so this
     * is the run-time half of a chain that ends at the validator rather than at
     * a parallel list: a test that asserts a value's spelling does not assert
     * that the value can be stored.
     */
    expect(Object.keys(HEAL_VERIFY_LABEL).sort()).toEqual([...healVerifyStateSchema.options].sort());
  });

  it('gives each state a DISTINCT word, so no two collapse', () => {
    const words = Object.values(HEAL_VERIFY_LABEL).map((meta) => meta.word);
    expect(new Set(words).size).toBe(words.length);
  });

  it('colours exactly one state as a pass', () => {
    const pass = healVerifyStateSchema.options.filter(
      (state) => HEAL_VERIFY_LABEL[state].tone === 'pass',
    );
    expect(pass).toEqual(['VERIFIED']);
  });
});

describe('healClaim: three facts on the card, never one', () => {
  const claim = (state: string, verifyState: string | null, claimsFixed = verifyState === 'VERIFIED') =>
    healClaim({ state, verification: { state: verifyState, claimsFixed } });

  it('colours and labels a verified heal as the only fixed one', () => {
    const got = claim('APPLIED', 'VERIFIED');
    expect(got).toMatchObject({ measured: true, fixed: true, unverified: false, tone: 'pass' });
    expect(got.meta).toBe(HEAL_VERIFY_LABEL.VERIFIED);
  });

  it('keeps STILL RED and NOBODY CHECKED apart — one is a measurement', () => {
    /*
     * THE DEFECT THIS REPLACES: the card was driven off `claimsFixed` alone,
     * and with it false these two and PENDING were the same pixel. A reviewer
     * could not tell a fix that FAILED from a fix nobody CHECKED, and the
     * second is the one that leaves a red test looking handled.
     */
    const red = claim('APPLIED', 'STILL_FAILING');
    const unchecked = claim('APPLIED', 'UNVERIFIABLE');

    expect(red.measured).toBe(true);
    expect(red.unverified).toBe(false);
    expect(unchecked.measured).toBe(false);
    expect(unchecked.unverified).toBe(true);
    // Neither is fixed, and neither is green.
    expect([red.fixed, unchecked.fixed]).toEqual([false, false]);
    expect([red.tone, unchecked.tone]).not.toContain('pass');
    // And they do not share a sentence.
    expect(red.label).not.toBe(unchecked.label);
    expect(red.meta?.word).not.toBe(unchecked.meta?.word);
  });

  it('never calls an unchecked heal measured, on ANY unmeasured state', () => {
    for (const state of ['PENDING', 'UNVERIFIABLE'] as const) {
      const got = claim('AUTO_APPLIED', state);
      expect(got.measured).toBe(false);
      expect(got.fixed).toBe(false);
      expect(got.unverified).toBe(true);
    }
  });

  it('reads a NULL state as "nothing claimed", never as a failure', () => {
    // Null is every heal written before verification existed, and every one
    // whose start died between the apply transaction and the update.
    const got = claim('APPLIED', null);
    expect(got.meta).toBeNull();
    expect(got.fixed).toBe(false);
    expect(got.unverified).toBe(true);
    expect(got.tone).toBe('neutral');
    expect(got.label).toContain('NOT CHECKED');
  });

  it('renders an UNKNOWN state as unrecognised, not as "not verified"', () => {
    // The column is TEXT with its domain enforced at the producer, so a row
    // written by a newer deployment reaches this build as a value it cannot
    // interpret — a different fact from a check that came back negative.
    const got = claim('APPLIED', 'REVERTED_BY_HUMAN');
    expect(got.measured).toBe(false);
    expect(got.fixed).toBe(false);
    expect(got.meta?.word).toContain('REVERTED_BY_HUMAN');
    expect(got.meta?.word.toLowerCase()).toContain('not recognise');
    expect(got.tone).toBe('fail');
  });

  it('claims nothing at all about a proposal nobody applied', () => {
    // Not a failed verification: nothing was applied, so nothing was verified.
    // All three facts false is what the card reads to decide to say nothing.
    const got = claim('PROPOSED', null);
    expect(got).toMatchObject({ measured: false, fixed: false, unverified: false });
    expect(got.label).toBe('Not applied');
  });

  it('prints the three facts for every state, and prints NOTHING when none apply', () => {
    /*
     * ALL FOUR STATES PLUS AN UNKNOWN ONE PLUS NULL, through the function the
     * card renders. This repository has no React render tooling — no jsdom, no
     * testing-library, not one `.test.tsx` — so the card is a projection of
     * `claimLine` and `healClaim`, and this is where the prose is pinned.
     */
    expect(claimLine(claim('APPLIED', 'VERIFIED'))).toBe('re-run and measured');
    expect(claimLine(claim('APPLIED', 'STILL_FAILING'))).toBe('re-run and measured');
    expect(claimLine(claim('AUTO_APPLIED', 'PENDING'))).toBe(
      'NOT re-run · nobody has confirmed this works',
    );
    expect(claimLine(claim('AUTO_APPLIED', 'UNVERIFIABLE'))).toBe(
      'NOT re-run · nobody has confirmed this works',
    );
    // A state this build has never heard of is NOT re-run as far as it knows,
    // which is the fail-safe direction: the one thing this must never do is
    // show an unchecked heal as a fix.
    expect(claimLine(claim('APPLIED', 'SOMETHING_NEW'))).toBe(
      'NOT re-run · nobody has confirmed this works',
    );
    expect(claimLine(claim('APPLIED', null))).toBe(
      'NOT re-run · nobody has confirmed this works',
    );
    // Nothing was applied, so nothing was claimed, and the card says nothing
    // rather than implying a check somebody should have run.
    expect(claimLine(claim('PROPOSED', null))).toBeNull();
    expect(claimLine(claim('REJECTED', null))).toBeNull();
    expect(claimLine(claim('SUPERSEDED', null))).toBeNull();
  });

  it('never prints "re-run and measured" without the measurement behind it', () => {
    // The mutation that matters: swap the two arms of `claimLine` and a heal
    // nobody checked reads as one that was.
    for (const state of ['PENDING', 'UNVERIFIABLE', 'WHAT_IS_THIS', null]) {
      expect(claimLine(claim('APPLIED', state))).not.toContain('re-run and measured');
    }
  });

  it('refuses green on a VERIFIED state the proposal state does not support', () => {
    // A VERIFIED verifyState on a PROPOSED row is a producer this build cannot
    // interpret. `claimsFixed` alone says "fixed"; `fixed` does not, and the
    // colour needs both.
    const got = claim('PROPOSED', 'VERIFIED', true);
    expect(got.fixed).toBe(false);
    expect(got.tone).not.toBe('pass');
  });
});
