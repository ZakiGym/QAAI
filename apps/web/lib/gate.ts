import type { GateResult } from '@qaai/shared';

/**
 * Reading a gate result, with the third and fourth states intact.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * The web's own gate type said `evaluations: Array<{ passed: boolean; … }>`.
 * `passed` has been `boolean | null` since the measurement rules shipped, where
 * null means NOT MEASURED — the distinction this product is built on. Typing it
 * `boolean` did not merely lose the information, it inverted it: `!e.passed` is
 * true for an unmeasured rule, so the run log picked "not measured — no
 * coverage snapshot has been computed" as the reason a merge was blocked.
 *
 * So every read of an evaluation goes through a function here, and each one
 * names the state it selects on:
 *
 *   action === 'BLOCK'       held the merge.
 *   action === 'WARN'        said so and did not hold it.
 *   action === 'UNMEASURED'  had no input. Never a pass, never a failure.
 *   action === 'PASS'        was measured and was fine.
 *
 * `passed` is left to the surfaces that render a single rule; nothing here
 * branches on it, because the action is the field that cannot be misread.
 */

type GateEvaluation = GateResult['evaluations'][number];

/** The evaluations, defensively — a stored Json column can be anything. */
function evaluationsOf(gate: GateResult | null | undefined): GateEvaluation[] {
  if (!gate || !Array.isArray(gate.evaluations)) return [];
  return gate.evaluations;
}

/**
 * The rules that actually held the merge.
 *
 * Plural and ordered as the evaluator produced them, so a caller that wants one
 * sentence takes the first and a caller that wants the list has it.
 */
export function gateBlockers(gate: GateResult | null | undefined): GateEvaluation[] {
  return evaluationsOf(gate).filter((evaluation) => evaluation.action === 'BLOCK');
}

/**
 * Why the merge was blocked, in the words the evaluator wrote — or null when
 * nothing blocked.
 *
 * Null rather than a fallback sentence: a red run with no blocking rule failed
 * its tests or fell over, and both of those have their own, better explanation
 * on the row. Inventing a gate reason here would attribute a failure to a rule
 * that did not fire.
 */
export function gateBlockReason(gate: GateResult | null | undefined): string | null {
  return gateBlockers(gate)[0]?.detail ?? null;
}

/** How many rules had no input. Rendered, so "6 rules" never implies 6 answers. */
export function gateUnmeasuredCount(gate: GateResult | null | undefined): number {
  /*
   * The evaluator stamps `unmeasured` on every result it produces, and it is
   * preferred when present — it is the producer's own count. Falling back to a
   * filter covers the rows written before that field existed, which would
   * otherwise report 0 unmeasured rules while displaying them.
   */
  const evaluations = evaluationsOf(gate);
  if (typeof gate?.unmeasured === 'number') {
    /*
     * Clamped to the rows that are actually here, because the caller's next
     * move is `evaluations.length - this`: a stored count that disagrees with
     * the stored array would otherwise print "-1 of 3 rules were measured",
     * which is a number nobody can act on. Read defensively, like every Json
     * column in this product.
     */
    return Math.min(Math.max(0, Math.trunc(gate.unmeasured)), evaluations.length);
  }
  return evaluations.filter((evaluation) => evaluation.action === 'UNMEASURED').length;
}

/**
 * Is this gate still waiting on triage?
 *
 * The same definition as `gateAwaitsTriage` in packages/runner/src/gates.ts —
 * an UNMEASURED `BLOCK_ON_VERDICT` rule, which is exactly what a gate scored at
 * finalisation looks like, because the rule every new project gets is scored
 * against verdicts and finalisation runs before any verdict exists.
 *
 * Mirrored rather than imported, and the reason is the bundle: `@qaai/runner`
 * has one export path (its barrel), which pulls in Playwright, `pg` and
 * axe-core. Importing a four-line predicate out of it would put a browser
 * driver and a Postgres client into a client component. It is the same trade
 * this app already makes for `RUN_SHARD_TERMINAL`, and the test below pins the
 * definition so the mirror cannot quietly become a different question.
 *
 * It replaces the page's own attempt, which recomputed the answer from the
 * RESULT rows ("is there a failure with no verdict") — a different question
 * that happened to agree on the common case. It disagreed whenever a project
 * gates on something other than verdicts, or when a verdict existed but the
 * gate had not been re-scored.
 */
export function gateAwaitsTriage(gate: GateResult | null | undefined): boolean {
  return evaluationsOf(gate).some(
    (evaluation) =>
      evaluation.action === 'UNMEASURED' && evaluation.rule?.kind === 'BLOCK_ON_VERDICT',
  );
}

/**
 * The one word for the chip, and the third state is not decoration.
 *
 * A gate scored before triage finds nothing to block on and reports a pass. It
 * is not a pass; it has not been decided. The gate value itself is never
 * altered here — GitHub's check conclusion already treats an un-triaged failure
 * as actionable — only the claim the badge makes about it.
 */
export function gateWord(gate: GateResult | null | undefined): 'PASS' | 'BLOCK' | 'PROVISIONAL' {
  if (!gate) return 'PROVISIONAL';
  if (gate.passed && gateAwaitsTriage(gate)) return 'PROVISIONAL';
  return gate.passed ? 'PASS' : 'BLOCK';
}
