/**
 * Healer (§3.4) — proposes the exact fix when Triage says INTENDED_CHANGE.
 *
 * The Healer only ever proposes. Applying is a human click, except for the one
 * narrow case the spec allows an org to opt into: a selector-only change with
 * high confidence. Anything that touches an assertion stays human-approved no
 * matter what the org setting says, because changing an assertion is how a
 * self-healing test suite quietly stops testing anything.
 */

import { healProposalSchema } from '@qaai/shared';
import type { HealProposal, StepResult, TriageVerdict } from '@qaai/shared';
import type { CallContext, LlmService } from './llm.js';

const SYSTEM = `You are the Healer agent inside QAAI, an AI QA engineer.

A test is failing because the application changed on purpose. Your job is to
update the test so it tests the same thing against the new application — not to
make the test pass.

Non-negotiable:
- Change the smallest thing that can work. A renamed button means one locator
  changes, not a rewritten test.
- Never weaken an assertion to make a failure go away. Do not replace a value
  check with a presence check, do not delete an assertion, do not add a
  try/catch or an optional wait around a failing step. If the only way to make
  the test pass is to stop testing something, say so in the explanation and
  propose the assertion update the change actually implies.
- Never add a fixed sleep.

Classify the risk of your own diff honestly:
  SELECTOR_ONLY     only locator strings changed; every assertion is untouched
  ASSERTION_CHANGE  an expected value or an assertion changed
  STRUCTURAL        steps were added, removed, or reordered

Output a unified diff against the file as given, with correct line context.`;

export interface HealInput {
  testName: string;
  filePath: string;
  currentCode: string;
  verdict: TriageVerdict;
  failingStep: StepResult | null;
  /** Locators the most recent crawl found, so the fix targets something real. */
  availableLocators?: string[];
}

export async function proposeHeal(
  llm: LlmService,
  ctx: CallContext,
  input: HealInput,
): Promise<HealProposal & { testId?: string }> {
  const prompt = `TEST: ${input.testName}
FILE: ${input.filePath}

TRIAGE VERDICT: ${input.verdict.verdict} (confidence ${input.verdict.confidence.toFixed(2)})
${input.verdict.explanation}

FAILING STEP
${
  input.failingStep
    ? [
        `  [${input.failingStep.index}] ${input.failingStep.title}`,
        `  error:    ${input.failingStep.error?.message ?? 'unknown'}`,
        input.failingStep.error?.expected
          ? `  expected: ${input.failingStep.error.expected}`
          : null,
        input.failingStep.error?.actual ? `  actual:   ${input.failingStep.error.actual}` : null,
        input.failingStep.error?.selector
          ? `  locator:  ${input.failingStep.error.selector}`
          : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '  (the failure was not attributed to a step)'
}

${
  input.availableLocators?.length
    ? `LOCATORS PRESENT ON THE PAGE RIGHT NOW\n${input.availableLocators
        .map((l) => `  ${l}`)
        .join('\n')}\n`
    : ''
}
CURRENT FILE
${input.currentCode}

Propose the fix as a unified diff.`;

  const proposal = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt,
    schema: healProposalSchema,
    schemaName: 'HealProposal',
    maxTokens: 8000,
    cacheSystem: true,
  });

  return { ...proposal, testId: '' };
}

/**
 * Whether a proposal may be applied without a human, given the org setting.
 *
 * The model self-reports risk, and self-reports are not a safety boundary — so
 * we re-derive it from the diff. A diff that touches an `expect(` line is an
 * assertion change regardless of what the model called it.
 */
export function isAutoApprovable(
  proposal: HealProposal,
  orgAllowsSelectorAutoApproval: boolean,
): { allowed: boolean; reason: string } {
  if (!orgAllowsSelectorAutoApproval) {
    return { allowed: false, reason: 'Auto-approval is disabled for this project' };
  }

  const changedLines = proposal.diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    );

  const touchesAssertion = changedLines.some((line) =>
    /\bexpect\s*\(|\bassert|toBe|toEqual|toHaveText|toHaveValue|toContain/.test(line),
  );
  if (touchesAssertion) {
    return { allowed: false, reason: 'The diff changes an assertion, which always needs a human' };
  }

  if (proposal.riskLevel !== 'SELECTOR_ONLY') {
    return { allowed: false, reason: `Risk level is ${proposal.riskLevel}, not SELECTOR_ONLY` };
  }
  if (proposal.confidence < 0.85) {
    return { allowed: false, reason: `Confidence ${proposal.confidence.toFixed(2)} is below 0.85` };
  }
  if (changedLines.length > 6) {
    return {
      allowed: false,
      reason: `${changedLines.length} lines changed — too broad to auto-apply`,
    };
  }

  return { allowed: true, reason: 'Selector-only, high confidence, narrow diff' };
}
