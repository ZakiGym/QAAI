import { healVerificationDisplay, healVerifyStateSchema } from '@qaai/shared';
import type { Heal, HealVerification } from '../../lib/api';

/**
 * The vocabulary a heal card is graded by — risk, and whether the fix was
 * afterwards proved to work.
 *
 * Extracted from HealCard.tsx so both halves can be pinned by a test. Both were
 * defects of the same kind: a value the API returns that this client had no
 * entry for, rendered as something else's label.
 *
 * ── RETIRE, the one that mattered ──────────────────────────────────────────
 *
 * `riskOf` was `RISK[level] ?? RISK.STRUCTURAL`, and RISK had no RETIRE entry.
 * A RETIRE proposal does not patch anything: it proposes that the test STOP
 * EXISTING, carries no diff, and is applied by disabling the test. It rendered
 * with the label, the colour and the blurb of a structural code change —
 * "steps were added, removed, or reordered. Review it as you would a
 * colleague's pull request" — so a reviewer pressing Apply was told they were
 * accepting a refactor while they were removing coverage.
 *
 * The fallback is now an explicit UNRECOGNISED entry rather than STRUCTURAL,
 * because the fallback is what hid the missing arm: a risk level this build has
 * never heard of is read as unrecognised and says so, which is the same rule
 * the API applies to an unknown verification state.
 */

export type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';

export interface RiskMeta {
  label: string;
  blurb: string;
  tone: Tone;
  /**
   * What pressing the button DOES, in the imperative, for the button itself.
   * "Apply" is true of a patch and false of a retirement, and the button is the
   * last thing a reviewer reads.
   */
  action: string;
}

export const RISK: Record<string, RiskMeta> = {
  SELECTOR_ONLY: {
    label: 'Selector only',
    blurb:
      'Only a locator changed. No assertion was touched, so the test still checks the same thing.',
    tone: 'pass',
    action: 'Apply',
  },
  ASSERTION_CHANGE: {
    label: 'Assertion change',
    blurb:
      'An expected value changed — read this one. After applying, the test checks something different than before.',
    tone: 'flake',
    action: 'Apply',
  },
  STRUCTURAL: {
    label: 'Structural',
    blurb:
      'Steps were added, removed, or reordered. Review it as you would a colleague’s pull request.',
    tone: 'fail',
    action: 'Apply',
  },
  RETIRE: {
    label: 'Retire the test',
    blurb:
      'This is not a patch and there is no diff to apply. Approving it switches the test OFF: it stops running, and it stops covering whatever it covered. Its code and history stay in your repository, so you can switch it back on. Read the evidence first — a test whose page QAAI could not REACH looks very like a test whose page is GONE, and only the second is worth retiring.',
    tone: 'fail',
    action: 'Retire the test',
  },
};

/**
 * The entry for a risk level this build does not know.
 *
 * Not an alias of STRUCTURAL. Describing an unknown value with a known value's
 * sentence is how RETIRE went eight weeks looking like a refactor.
 */
export const UNRECOGNISED_RISK: RiskMeta = {
  label: 'Unrecognised risk',
  blurb:
    'This proposal carries a risk level this version of the cockpit does not recognise, so nothing can be concluded from the label. Read the diff before deciding.',
  tone: 'fail',
  action: 'Apply — asks to confirm',
};

export function riskOf(level: string): RiskMeta {
  return RISK[level] ?? UNRECOGNISED_RISK;
}

/**
 * Applying this one needs no second thought — and so gets no second dialog.
 *
 * SELECTOR_ONLY and nothing else. Written as an allow-list on purpose: a risk
 * level added later is confirmed by default, and a RETIRE that slipped through
 * here would delete a test on one click.
 */
export const appliesImmediately = (heal: Heal): boolean => heal.riskLevel === 'SELECTOR_ONLY';

/** True when approving removes coverage rather than changing code. */
export const isRetirement = (heal: Pick<Heal, 'riskLevel'>): boolean => heal.riskLevel === 'RETIRE';

// ─── Verification: three facts, and never one ───────────────────────────────

/**
 * What a verification state is CALLED and COLOURED.
 *
 * It is not what a verification MEANS: that is `healVerificationDisplay` in
 * @qaai/shared, which answers `measured`, `fixed` and `unverified` and is the
 * one place the rules live. This table is the words.
 */
export interface VerifyMeta {
  word: string;
  tone: Tone;
}

/**
 * The four states the column may hold, in the words a reviewer needs.
 *
 * ── WHY `satisfies` AND NOT `Record<string, VerifyMeta>` ────────────────────
 *
 * It was `Record<string, VerifyMeta>`, which accepts any key and requires
 * none — so a FIFTH state added to the vocabulary compiled cleanly here and
 * arrived at `verifyMeta` as a missing entry. The fallback would then describe
 * it, and the fallback's sentence is about a state this build cannot interpret,
 * which is a different claim from whatever the new state actually says. A blank
 * or borrowed label on this particular card is how RETIRE spent eight weeks
 * looking like a refactor.
 *
 * `satisfies Record<HealVerifyState, VerifyMeta>` makes that a COMPILE ERROR.
 * The union comes from `healVerifyStateSchema.options` — the zod enum the WRITE
 * PATH ITSELF VALIDATES AGAINST (`recordHealVerificationSchema`) — and not from
 * a list retyped here. A test that asserts a value's spelling does not assert
 * that the value can be STORED, so the card's label table is now bound to the
 * validator rather than to a parallel copy of the vocabulary.
 *
 * It is NOT a tautology. `@qaai/shared` cannot import `@qaai/agent`, so that
 * schema's four members are a literal, and
 * packages/shared/src/suppression.test.ts asserts its `.options` against
 * `HEAL_VERIFY_STATES` BY NAME. The chain is: this table → the write
 * validator → the agent's vocabulary, with a real assertion at each link.
 *
 * UNVERIFIABLE is the member that must exist: applied, and nobody checked — no
 * environment to run in, the org at its run cap, the run errored or was
 * cancelled. Without it "we could not look" collapses into one of the other two
 * answers, and whichever one it collapses into is a lie.
 */
export type HealVerifyState = (typeof healVerifyStateSchema.options)[number];

export const HEAL_VERIFY_LABEL = {
  PENDING: { word: 'Verifying — the run has not finished', tone: 'flake' },
  VERIFIED: { word: 'Verified — the test was re-run and passed', tone: 'pass' },
  STILL_FAILING: { word: 'Still failing after the fix', tone: 'fail' },
  UNVERIFIABLE: { word: 'Applied, and nobody could check', tone: 'flake' },
} satisfies Record<HealVerifyState, VerifyMeta>;

/**
 * What to put on the card for a verification state.
 *
 * `null` for a null state, which means NOTHING WAS CLAIMED — nobody applied
 * this proposal, so nothing was verified. Null is not a failure and must not
 * render as one.
 *
 * An unrecognised non-null state is reported as unrecognised rather than
 * falling through to "not verified": the column is TEXT with its domain
 * enforced at the producer, so a row written by a newer deployment reaches here
 * as a value this build cannot interpret, and "we cannot interpret this" is a
 * different sentence from "the fix did not work".
 */
export function verifyMeta(state: string | null): VerifyMeta | null {
  if (state === null) return null;
  const known = (HEAL_VERIFY_LABEL as Record<string, VerifyMeta>)[state];
  return (
    known ?? {
      word: `Verification state this build does not recognise (${state})`,
      tone: 'fail',
    }
  );
}

/**
 * The three facts a heal claims about its test, and the colour for them.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 *
 * The card was driven off `verification.claimsFixed`, a single boolean the API
 * computes as `verifyState === 'VERIFIED'`. One boolean cannot carry three
 * facts, and the one it dropped is the one that matters: with `claimsFixed`
 * false, APPLIED-AND-STILL-RED, APPLIED-AND-NOBODY-LOOKED and
 * APPLIED-AND-NOTHING-HAS-RUN-YET were the same pixel, so "we did not check"
 * rendered beside a fix.
 *
 * `healVerificationDisplay` is the server's own rule for this and answers all
 * three. It used to answer `verified`, and `verified` was TRUE for
 * STILL_FAILING — two facts in one field, with only one plausible way to read
 * the name, so a tick rendered on it showed a heal that left the test RED as a
 * fix. The field is gone rather than kept as an alias, because an alias would
 * let the next caller pick the wrong one.
 *
 *   · `measured`   — a verifying run happened and produced an answer.
 *   · `fixed`      — that answer was green. NEVER true without `measured`.
 *   · `unverified` — applied, and the claim is still outstanding.
 *
 * `claimsFixed` is still required for the PASS colour, and requiring BOTH is
 * the point: the two agree today by construction, and a producer that ever set
 * one without the other is a producer this build cannot interpret. The honest
 * rendering of that is "unresolved", not a green claim that a fix works.
 */
export interface HealClaim {
  /** A verifying run executed the test after the patch was written. */
  measured: boolean;
  /** That run passed. The ONLY field a surface may colour green. */
  fixed: boolean;
  /** Applied, and the claim is still outstanding. */
  unverified: boolean;
  /** The server's own short label for the pair. Never implies an unrun check. */
  label: string;
  /** The words for the stored state, or null when nothing was claimed. */
  meta: VerifyMeta | null;
  tone: Tone;
}

export function healClaim(heal: {
  state: string;
  verification: Pick<HealVerification, 'state' | 'claimsFixed'>;
}): HealClaim {
  const display = healVerificationDisplay({ state: heal.state, verifyState: heal.verification.state });
  const meta = verifyMeta(heal.verification.state);
  return {
    measured: display.measured,
    fixed: display.fixed,
    unverified: display.unverified,
    label: display.label,
    meta,
    tone: verifyTone(display.fixed, heal.verification.claimsFixed, meta),
  };
}

/**
 * The three facts as the words the card prints, or NULL when there are none.
 *
 * It lives here and not in the JSX for the reason this whole file exists (see
 * the header): a sentence composed inside a component cannot be pinned by a
 * test, and this repository has no React render tooling at all — no jsdom, no
 * testing-library, not one `.test.tsx`. So the card is a projection of this
 * function and this function is tested, rather than the most load-bearing
 * sentence in the feature being the one thing nothing can assert about.
 *
 * NULL for a proposal nobody applied: all three facts are false, nothing was
 * claimed, and a line here would imply a check somebody should have run.
 *
 * `measured` is the half nothing on this card ever stated. A reviewer looking
 * at "Still failing after the fix" and at "Applied, and nobody could check"
 * needs to know the first is a measurement and the second is not — and the two
 * labels alone do not carry it.
 */
export function claimLine(claim: HealClaim): string | null {
  if (!claim.measured && !claim.unverified) return null;
  const parts = [claim.measured ? 're-run and measured' : 'NOT re-run'];
  if (claim.unverified) parts.push('nobody has confirmed this works');
  return parts.join(' · ');
}

/**
 * The colour, and it takes TWO independent "the fix works" claims.
 *
 * ── WHY BOTH, AND WHY `fixed` IS THE NEW ONE ────────────────────────────────
 *
 * `claimsFixed` is the API's own boolean (`verifyState === 'VERIFIED'`).
 * `fixed` is `healVerificationDisplay`'s, derived from the state AND the
 * proposal's `state` — so it is false for a VERIFIED row on a proposal nobody
 * applied, which `claimsFixed` alone cannot see.
 *
 * The two agree today by construction, and requiring both is the point: a
 * producer that ever sets one without the other is a producer this build cannot
 * interpret, and the honest rendering of that is "unresolved", not a green
 * claim that a fix works. Green is the one colour on this card a reviewer acts
 * on without reading further.
 *
 * `neutral` for no metadata at all, because nothing was claimed — an absent
 * verification is not an amber one.
 */
export function verifyTone(fixed: boolean, claimsFixed: boolean, meta: VerifyMeta | null): Tone {
  if (fixed && claimsFixed) return 'pass';
  if (!meta) return 'neutral';
  return meta.tone === 'pass' ? 'flake' : meta.tone;
}
