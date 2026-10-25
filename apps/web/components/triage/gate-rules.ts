import { duration } from '../ui';

/**
 * The gate-rule vocabulary — what a rule IS, and what it says in English.
 *
 * Split out of GateRuleRow.tsx so a test can reach it: the twelve-kind union in
 * @qaai/shared against this editor's four is the kind of gap that only a test
 * comparing them catches, and nothing in this repo's suite imports a .tsx.
 */

/** The four kinds this editor has controls for. */
export type GateRule =
  | { kind: 'BLOCK_ON_VERDICT'; verdict: string; onlyPriorities: string[] }
  | { kind: 'MAX_FLAKE_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MAX_P95_LATENCY_MS'; ms: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MIN_PASS_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' };

/**
 * A rule as `GET /projects/:id/gate-rules` may actually return it.
 *
 * `GateRule` in @qaai/shared has TWELVE kinds and this editor has four. Until
 * today the other eight could not be written through the API at all
 * (`gateRuleSchema` was four arms behind the union), so the gap was invisible;
 * the schema now accepts all twelve, which means a project can hold a rule this
 * screen has never heard of.
 *
 * Typed as its own arm rather than widened, because the row's job is to decide
 * which case it is in: a kind with no controls renders as what it IS and keeps
 * its stored fields through the PUT, instead of being described by the sentence
 * of a rule it is not. Before this, an unknown kind rendered as a BLOCK badge
 * with NO TEXT beside it — "absent looks exactly like green" — and opening its
 * editor wrote `ratePercent` onto a rule whose number is called something else,
 * so a reviewer setting "80%" changed nothing and was told it had saved.
 */
export type StoredGateRule = GateRule | { kind: string; action?: 'WARN' | 'BLOCK' };

const EDITABLE_KINDS: ReadonlyArray<GateRule['kind']> = [
  'BLOCK_ON_VERDICT',
  'MAX_FLAKE_RATE',
  'MAX_P95_LATENCY_MS',
  'MIN_PASS_RATE',
];

export function isEditableRule(rule: StoredGateRule): rule is GateRule {
  return (EDITABLE_KINDS as readonly string[]).includes(rule.kind);
}

/** The choices the editor offers. Rendered by GateRuleRow. */
export const VERDICTS = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;
export const PRIORITIES = ['CRITICAL_PATH', 'IMPORTANT', 'NICE_TO_HAVE'] as const;

export const humanise = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/**
 * A verdict rule always blocks; the others carry their own severity.
 *
 * Null for a rule that is neither — an unknown kind with no `action` field, for
 * which 'BLOCK' would be a guess printed as a badge.
 */
export const actionOf = (rule: StoredGateRule): 'WARN' | 'BLOCK' | null => {
  if (rule.kind === 'BLOCK_ON_VERDICT') return 'BLOCK';
  return 'action' in rule && (rule.action === 'WARN' || rule.action === 'BLOCK')
    ? rule.action
    : null;
};

export function describeRule(rule: StoredGateRule): string {
  if (!isEditableRule(rule)) {
    /*
     * Named, not blank. The sentence has to carry the kind, because that is the
     * only thing this build knows about the rule — and a configured gate that
     * renders as an empty row is indistinguishable from no gate at all.
     */
    return `${humanise(rule.kind)} — this rule is in force and this version of the cockpit cannot edit it. It is kept exactly as it is when you save.`;
  }
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT':
      return `Block the deploy when triage calls a failure a ${humanise(rule.verdict)}${
        rule.onlyPriorities.length
          ? `, but only for ${rule.onlyPriorities.map(humanise).join(' or ')} tests`
          : ''
      }.`;
    case 'MAX_FLAKE_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when more than ${rule.ratePercent}% of tests are flaky.`;
    case 'MAX_P95_LATENCY_MS':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the 95th-percentile test takes longer than ${duration(rule.ms)}.`;
    case 'MIN_PASS_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the pass rate falls below ${rule.ratePercent}%.`;
  }
}
