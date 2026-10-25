import type { Heal } from '../../lib/api';

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

// ─── Verification: "we applied this, and then proved the test passes" ────────

export interface VerifyMeta {
  word: string;
  tone: Tone;
}

/**
 * The four states `HEAL_VERIFY_STATES` allows, in the words a reviewer needs.
 *
 * UNVERIFIABLE is the member that must exist: applied, and nobody checked — no
 * environment to run in, the org at its run cap, the run errored or was
 * cancelled. Without it "we could not look" collapses into one of the other two
 * answers, and whichever one it collapses into is a lie.
 */
export const HEAL_VERIFY_LABEL: Record<string, VerifyMeta> = {
  PENDING: { word: 'Verifying — the run has not finished', tone: 'flake' },
  VERIFIED: { word: 'Verified — the test was re-run and passed', tone: 'pass' },
  STILL_FAILING: { word: 'Still failing after the fix', tone: 'fail' },
  UNVERIFIABLE: { word: 'Applied, and nobody could check', tone: 'flake' },
};

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
/**
 * The colour. The PASS colour requires the server's own `claimsFixed`, which it
 * sets for exactly one case: a run executed the test after the patch was
 * written and it passed.
 *
 * The two agree today by construction (`claimsFixed` is `verifyState ===
 * 'VERIFIED'`), and requiring both is the point: a producer that ever sets one
 * without the other is a producer this build cannot interpret, and the honest
 * rendering of that is "unresolved", not a green claim that a fix works.
 *
 * `neutral` for no metadata at all, because nothing was claimed — an absent
 * verification is not an amber one.
 */
export function verifyTone(claimsFixed: boolean, meta: VerifyMeta | null): Tone {
  if (claimsFixed) return 'pass';
  if (!meta) return 'neutral';
  return meta.tone === 'pass' ? 'flake' : meta.tone;
}

export function verifyMeta(state: string | null): VerifyMeta | null {
  if (state === null) return null;
  return (
    HEAL_VERIFY_LABEL[state] ?? {
      word: `Verification state this build does not recognise (${state})`,
      tone: 'fail',
    }
  );
}
