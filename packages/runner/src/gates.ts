/**
 * Quality gates (§4). Evaluated once per run; the result drives the PR status
 * check and the CLI's exit code.
 *
 * Two rules the evaluator enforces regardless of configuration:
 *  - Quarantined tests never block. They still run and still record history,
 *    but a flaky test in the quarantine lane cannot fail a build (§5).
 *  - A test that passed only on retry counts as flaky, not as a pass (§5).
 */

import { BLOCKING_VERDICTS } from '@qaai/shared';
import type { GateResult, GateRule, Priority, TestResultStatus, Verdict } from '@qaai/shared';

export interface GateInput {
  results: Array<{
    testId: string;
    testName: string;
    status: TestResultStatus;
    priority: Priority;
    quarantined: boolean;
    retriedAndPassed: boolean;
    verdict: Verdict | null;
    durationMs: number;
  }>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: for p95 of 20 samples this is the 19th, which is what people
  // mean by "p95" in a CI report.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function describe(rule: GateRule): string {
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT':
      return `Block on ${rule.verdict}${
        rule.onlyPriorities.length ? ` (${rule.onlyPriorities.join(', ')})` : ''
      }`;
    case 'MAX_FLAKE_RATE':
      return `Flake rate under ${rule.ratePercent}%`;
    case 'MAX_P95_LATENCY_MS':
      return `p95 under ${rule.ms}ms`;
    case 'MIN_PASS_RATE':
      return `Pass rate at least ${rule.ratePercent}%`;
  }
}

export function evaluateGates(rules: GateRule[], input: GateInput): GateResult {
  // Quarantined tests are excluded from every rule, not just the verdict rule —
  // a lane of known-flaky tests must not drag the pass rate below a threshold.
  const gating = input.results.filter((r) => !r.quarantined);
  const evaluations: GateResult['evaluations'] = [];

  for (const rule of rules) {
    let passed = true;
    let detail = '';

    switch (rule.kind) {
      case 'BLOCK_ON_VERDICT': {
        const offenders = gating.filter(
          (r) =>
            r.verdict === rule.verdict &&
            (rule.onlyPriorities.length === 0 || rule.onlyPriorities.includes(r.priority)),
        );
        passed = offenders.length === 0;
        detail = passed
          ? `No ${rule.verdict} verdicts`
          : `${offenders.length} ${rule.verdict} verdict(s): ${offenders
              .slice(0, 3)
              .map((o) => o.testName)
              .join(', ')}${offenders.length > 3 ? '…' : ''}`;
        break;
      }

      case 'MAX_FLAKE_RATE': {
        const flaky = gating.filter((r) => r.status === 'FLAKY' || r.retriedAndPassed).length;
        const rate = gating.length === 0 ? 0 : (flaky / gating.length) * 100;
        passed = rate <= rule.ratePercent;
        detail = `${rate.toFixed(1)}% flaky (${flaky}/${gating.length})`;
        break;
      }

      case 'MAX_P95_LATENCY_MS': {
        const p95 = percentile(
          gating.map((r) => r.durationMs),
          95,
        );
        passed = p95 <= rule.ms;
        detail = `p95 was ${p95}ms`;
        break;
      }

      case 'MIN_PASS_RATE': {
        const passedCount = gating.filter((r) => r.status === 'PASSED').length;
        const rate = gating.length === 0 ? 100 : (passedCount / gating.length) * 100;
        passed = rate >= rule.ratePercent;
        detail = `${rate.toFixed(1)}% passed (${passedCount}/${gating.length})`;
        break;
      }
    }

    const action: 'WARN' | 'BLOCK' | 'PASS' = passed
      ? 'PASS'
      : rule.kind === 'BLOCK_ON_VERDICT'
        ? 'BLOCK'
        : rule.action;

    evaluations.push({ rule, passed, action, detail: `${describe(rule)} — ${detail}` });
  }

  return { passed: evaluations.every((e) => e.action !== 'BLOCK'), evaluations };
}

/**
 * The default rule set a new project gets (§4). Deliberately conservative:
 * only a real bug on a critical-path test blocks, everything else warns, so a
 * team's first week with QAAI does not turn into a wall of red builds.
 */
export const DEFAULT_GATE_RULES: GateRule[] = [
  { kind: 'BLOCK_ON_VERDICT', verdict: BLOCKING_VERDICTS[0]!, onlyPriorities: ['CRITICAL_PATH'] },
  { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
];
