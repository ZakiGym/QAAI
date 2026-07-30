/**
 * Triage processor (§3.3) and the Healer hand-off (§3.4).
 *
 * Runs once per failing test result. When the verdict is INTENDED_CHANGE it
 * asks the Healer for a diff — proposed, never applied, unless the org opted
 * into auto-approving selector-only fixes and the diff genuinely is one.
 */

import { applyHealDiff, isAutoApprovable, proposeHeal, triageFailure } from '@qaai/agent';
import type { FlowMap, StepResult, TestExecution, TriageJob } from '@qaai/shared';
import { llm, logger, prisma, publishEvent } from '../context.js';

export async function processTriage(job: TriageJob): Promise<void> {
  const { orgId, runId, testResultId } = job;

  const result = await prisma.testResult.findFirst({
    where: { id: testResultId, orgId },
    include: {
      test: true,
      steps: { orderBy: { index: 'asc' } },
      findings: true,
      verdict: { select: { id: true } },
    },
  });
  if (!result) throw new Error(`Test result ${testResultId} not found`);

  // Idempotence: the run job may be retried, and a second verdict row for the
  // same result would double-count in the gate.
  if (result.verdict) {
    logger.debug({ testResultId }, 'already triaged; skipping');
    return;
  }

  const history = await prisma.testResult.findMany({
    where: { testId: result.testId, orgId, id: { not: result.id } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { status: true, createdAt: true, steps: { select: { index: true, status: true } } },
  });

  const failures = history.filter((h) => h.status === 'FAILED' || h.status === 'TIMED_OUT').length;
  const flakyCount = history.filter((h) => h.status === 'FLAKY').length;
  const lastPassed = history.find((h) => h.status === 'PASSED')?.createdAt ?? null;

  const currentFailingIndex = result.steps.find((s) => s.status === 'FAILED')?.index ?? null;
  const sameStepRepeatedly =
    currentFailingIndex !== null &&
    history
      .slice(0, 5)
      .some((h) => h.steps.some((s) => s.status === 'FAILED' && s.index === currentFailingIndex));

  const steps: StepResult[] = result.steps.map((s) => ({
    index: s.index,
    title: s.title,
    status: s.status,
    startedAt: (s.startedAt ?? result.createdAt).toISOString(),
    durationMs: s.durationMs,
    screenshotKey: s.screenshotKey,
    error: s.errorMessage
      ? {
          message: s.errorMessage,
          stack: s.errorStack,
          selector: s.selector,
          expected: s.expected,
          actual: s.actual,
        }
      : null,
  }));

  const execution: TestExecution = {
    testId: result.testId,
    status: result.status,
    durationMs: result.durationMs,
    steps,
    network: (result.network as never) ?? [],
    console: (result.consoleLog as never) ?? [],
    videoKey: result.videoKey,
    traceKey: result.traceKey,
    errorMessage: result.errorMessage,
    retriedAndPassed: result.retriedAndPassed,
    findings: result.findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      code: f.code,
      message: f.message,
      location: f.location,
      helpUrl: f.helpUrl,
    })),
  };

  const verdict = await triageFailure(
    llm,
    { orgId, projectId: result.test.projectId, agent: 'TRIAGE', subjectId: result.id },
    {
      testName: result.test.name,
      testCode: result.test.code,
      execution,
      history: {
        totalRuns: history.length,
        failures,
        flakeRatePercent:
          history.length === 0 ? 0 : ((failures + flakyCount) / history.length) * 100,
        lastPassedAt: lastPassed?.toISOString() ?? null,
        sameStepRepeatedly,
      },
    },
  );

  const stored = await prisma.triageVerdict.create({
    data: {
      orgId,
      testResultId: result.id,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
      evidence: verdict.evidence as unknown as object,
      suspectCommit: (verdict.suspectCommit as unknown as object) ?? undefined,
      model: verdict.model,
    },
  });

  logger.info(
    { testResultId, verdict: verdict.verdict, confidence: verdict.confidence },
    'verdict recorded',
  );

  publishEvent(orgId, {
    runId,
    type: 'verdict',
    data: {
      testResultId: result.id,
      testName: result.test.name,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
    },
    at: new Date().toISOString(),
  });

  if (verdict.verdict === 'INTENDED_CHANGE') {
    await proposeHealFor(orgId, result.test, stored.id, verdict, steps);
  }
}

async function proposeHealFor(
  orgId: string,
  test: { id: string; projectId: string; name: string; filePath: string; code: string },
  verdictId: string,
  verdict: Awaited<ReturnType<typeof triageFailure>>,
  steps: StepResult[],
): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: test.projectId },
    select: { autoApproveSelectorHeals: true },
  });

  // The current crawl's locators give the Healer something real to target
  // instead of guessing at what the renamed element is called now.
  const flowMapRow = await prisma.flowMap.findFirst({
    where: { orgId, projectId: test.projectId },
    orderBy: { version: 'desc' },
  });
  const flowMap = flowMapRow?.graph as unknown as FlowMap | undefined;
  const availableLocators = flowMap?.nodes
    .flatMap((node) =>
      node.affordances.map(
        (a) => `${node.route}: ${a.selector.strategy} "${a.selector.name ?? a.selector.value}"`,
      ),
    )
    .slice(0, 40);

  try {
    const proposal = await proposeHeal(
      llm,
      { orgId, projectId: test.projectId, agent: 'HEALER', subjectId: test.id },
      {
        testName: test.name,
        filePath: test.filePath,
        currentCode: test.code,
        verdict,
        failingStep: steps.find((s) => s.status === 'FAILED') ?? null,
        availableLocators,
      },
    );

    const auto = isAutoApprovable(proposal, project?.autoApproveSelectorHeals ?? false);

    /**
     * Auto-approval has to actually write the code. Recording AUTO_APPLIED while
     * leaving the test untouched would claim work that never happened — and an
     * org that opted in would believe its suite was self-healing when nothing had
     * changed. If the patch refuses to apply, the proposal stays PROPOSED for a
     * human, with the reason attached.
     */
    let state: 'PROPOSED' | 'AUTO_APPLIED' = 'PROPOSED';
    let applyNote: string | null = null;

    if (auto.allowed) {
      const applied = applyHealDiff(test.code, proposal.diff);
      if (applied.ok && applied.code) {
        const latest = await prisma.testVersion.findFirst({
          where: { testId: test.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        await prisma.test.update({
          where: { id: test.id },
          data: {
            code: applied.code,
            versions: {
              create: {
                orgId,
                version: (latest?.version ?? 0) + 1,
                code: applied.code,
                source: 'HEALER',
                message: `Auto-applied selector heal: ${proposal.explanation.slice(0, 200)}`,
              },
            },
          },
        });
        state = 'AUTO_APPLIED';
      } else {
        applyNote = applied.reason ?? 'The diff could not be applied';
      }
    }

    await prisma.healProposal.create({
      data: {
        orgId,
        testId: test.id,
        verdictId,
        diff: proposal.diff,
        explanation: applyNote
          ? `${proposal.explanation}\n\nAuto-apply was declined: ${applyNote}`
          : proposal.explanation,
        riskLevel: proposal.riskLevel,
        confidence: proposal.confidence,
        state,
      },
    });

    logger.info(
      {
        testId: test.id,
        risk: proposal.riskLevel,
        autoApplied: state === 'AUTO_APPLIED',
        reason: applyNote ?? auto.reason,
      },
      'heal proposed',
    );
  } catch (err) {
    // A failed heal must not fail triage — the verdict is the valuable part.
    logger.error({ err, testId: test.id }, 'heal proposal failed');
  }
}
