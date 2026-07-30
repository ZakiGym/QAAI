/**
 * Triage (§3.3) — classifies every failure and explains itself.
 *
 * The product promise here is narrow and important: QAAI never silently
 * self-heals. Triage produces a verdict, a confidence score, and evidence a
 * human can check. What happens next — file a bug, approve a fix, quarantine —
 * is a decision the human makes from that verdict.
 *
 * The failure history matters as much as the failure. A test that has failed on
 * this step three times this week at the same time of day is a different
 * animal from one that has passed a hundred times and just broke.
 */

import { triageVerdictSchema } from '@qaai/shared';
import type { StepResult, TestExecution, TriageVerdict } from '@qaai/shared';
import type { CallContext, LlmService } from './llm.js';

const SYSTEM = `You are the Triage agent inside QAAI, an AI QA engineer.

A test failed. Classify why, in exactly one of four ways:

  REAL_BUG         the application is wrong. A user hitting this path would be
                   harmed: wrong money, wrong data, a broken flow, a leak.
  INTENDED_CHANGE  the application changed on purpose and the test is now stale.
                   A renamed button, a moved element, a reworded label.
  FLAKE            the test is unreliable, not the app. Timing, ordering, shared
                   state, a race. Passing on retry is strong evidence for this.
  ENV_ISSUE        the environment failed. The app never loaded, DNS died, a
                   dependency was down, the test compiled wrong, auth expired.

How to decide, in priority order:

1. If the failure is an assertion about a *value* — a total, a count, a status,
   a permission — and the app produced a different value than the arithmetic or
   the rule requires, that is REAL_BUG. Wrong money is never a flake.
2. If the failure is "locator not found" or "expected text X, got Y" where Y is
   a plausible new copy for the same element, lean INTENDED_CHANGE.
3. If the test passed on retry, or the error mentions timeouts, detachment, or
   navigation races, lean FLAKE — but not if the underlying assertion was about
   a value that was simply wrong.
4. If the app returned 5xx, the page never loaded, or the spec failed to
   compile, that is ENV_ISSUE.

Confidence is a real number, not decoration. Use below 0.7 when the evidence
genuinely supports more than one verdict, and say so in the explanation. A
confidently wrong verdict costs a team more than an honest uncertain one.

Cite concrete evidence. Every evidence entry points at something in the input:
a step index, a network entry, a console line, a history fact, a diff hunk.
Do not assert anything the input does not show.`;

export interface TriageInput {
  testName: string;
  testCode: string;
  execution: TestExecution;
  /** Flake radar context (§5). */
  history: {
    totalRuns: number;
    failures: number;
    flakeRatePercent: number;
    lastPassedAt: string | null;
    /** True when previous failures were on the same step index. */
    sameStepRepeatedly: boolean;
  };
  /** Present when the repo is connected. */
  recentCommits?: Array<{ sha: string; author: string; message: string; files: string[] }>;
  /** The app's own diff for the suspect range, when available. */
  diff?: string;
}

function renderSteps(steps: StepResult[]): string {
  if (steps.length === 0) return '  (the test recorded no steps)';
  return steps
    .map((step) => {
      const head = `  [${step.index}] ${step.status} (${step.durationMs}ms) ${step.title}`;
      if (!step.error) return head;
      return [
        head,
        `        error:    ${step.error.message.split('\n')[0]}`,
        step.error.expected ? `        expected: ${step.error.expected}` : null,
        step.error.actual ? `        actual:   ${step.error.actual}` : null,
        step.error.selector ? `        locator:  ${step.error.selector}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

export async function triageFailure(
  llm: LlmService,
  ctx: CallContext,
  input: TriageInput,
): Promise<TriageVerdict> {
  const { execution, history } = input;

  const network = execution.network
    .filter((n) => n.status === null || n.status >= 400)
    .slice(0, 15)
    .map((n) => `  ${n.method} ${n.url} -> ${n.status ?? 'no response'} (${n.durationMs}ms)`)
    .join('\n');

  const consoleErrors = execution.console
    .filter((c) => c.level === 'error' || c.level === 'warn')
    .slice(0, 15)
    .map((c) => `  [${c.level}] ${c.text.slice(0, 300)}`)
    .join('\n');

  const commits = input.recentCommits
    ?.slice(0, 10)
    .map(
      (c) =>
        `  ${c.sha.slice(0, 8)} ${c.author}: ${c.message.split('\n')[0]}\n      ${c.files.slice(0, 8).join(', ')}`,
    )
    .join('\n');

  const prompt = `FAILED TEST: ${input.testName}
  status:            ${execution.status}
  duration:          ${execution.durationMs}ms
  passed on retry:   ${execution.retriedAndPassed ? 'YES' : 'no'}
  top-level error:   ${execution.errorMessage ?? '(none — failure was inside a step)'}

STEPS
${renderSteps(execution.steps)}

FAILED NETWORK REQUESTS
${network || '  (none)'}

CONSOLE
${consoleErrors || '  (nothing at warn or above)'}

FINDINGS
${
  execution.findings.length
    ? execution.findings
        .slice(0, 10)
        .map((f) => `  [${f.severity}] ${f.kind} ${f.code}: ${f.message} @ ${f.location}`)
        .join('\n')
    : '  (none)'
}

HISTORY FOR THIS TEST
  runs:              ${history.totalRuns}
  failures:          ${history.failures}
  flake rate:        ${history.flakeRatePercent.toFixed(1)}%
  last passed:       ${history.lastPassedAt ?? 'never'}
  same step failing: ${history.sameStepRepeatedly ? 'yes' : 'no'}

${commits ? `RECENT COMMITS\n${commits}\n` : ''}${
    input.diff ? `DIFF\n${input.diff.slice(0, 6000)}\n` : ''
  }
TEST SOURCE
${input.testCode.slice(0, 6000)}

Classify this failure. If a commit above plausibly caused it, name it in
suspectCommit; otherwise set suspectCommit to null. Do not guess a commit just
because one exists.`;

  // Cheap model first: most failures are unambiguous, and triage runs on every
  // failing test of every run. The escalation below catches the hard ones.
  const first = await llm.structured(ctx, {
    tier: 'cheap',
    effort: 'medium',
    system: SYSTEM,
    prompt,
    schema: triageVerdictSchema,
    schemaName: 'TriageVerdict',
    maxTokens: 4000,
    cacheSystem: true,
  });

  if (first.confidence >= 0.75) {
    return { ...first, model: 'cheap' };
  }

  // Ambiguous: re-run on the strong model and keep whichever is more confident.
  // The spec routes ambiguous verdicts to the strong model precisely because a
  // wrong REAL_BUG wastes an engineer's morning.
  const second = await llm.structured(ctx, {
    tier: 'strong',
    effort: 'high',
    system: SYSTEM,
    prompt: `${prompt}

A first pass was uncertain (${first.verdict}, confidence ${first.confidence.toFixed(2)}):
${first.explanation}

Re-examine the evidence and give your own verdict. Disagreeing is fine.`,
    schema: triageVerdictSchema,
    schemaName: 'TriageVerdict',
    maxTokens: 6000,
    cacheSystem: true,
  });

  return { ...second, model: 'strong' };
}
