/**
 * Inline-edit processor (§8).
 *
 * The API creates the AgentProposal row and enqueues; this fills in `newCode`.
 * The client polls the row, so the empty-`newCode` state is "still thinking" and
 * a `state: REJECTED` with a rationale is "it failed, here's why" — no separate
 * status field needed.
 */

import { editInline } from '@qaai/agent';
import { locatorsFromFlowMap } from '@qaai/shared';
import type { EditJob, FlowMap } from '@qaai/shared';
import { llm, logger, prisma } from '../context.js';

export async function processEdit(job: EditJob): Promise<void> {
  const { orgId, projectId, proposalId, instruction } = job;

  const proposal = await prisma.agentProposal.findFirst({
    where: { id: proposalId, orgId },
    select: { id: true, filePath: true, oldCode: true, testId: true, state: true },
  });
  if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
  if (proposal.state !== 'PENDING') {
    logger.debug({ proposalId }, 'edit proposal already decided; skipping');
    return;
  }

  // Ground the edit in locators the app actually has, so "click the login
  // button" targets something real rather than something plausible.
  const flowMapRow = await prisma.flowMap.findFirst({
    where: { orgId, projectId },
    orderBy: { version: 'desc' },
    select: { graph: true },
  });
  const availableLocators = flowMapRow
    ? locatorsFromFlowMap(flowMapRow.graph as unknown as FlowMap)
        .slice(0, 40)
        .map((l: { expression: string; label: string; route: string }) => `${l.expression}   // ${l.label} on ${l.route}`)
    : undefined;

  try {
    const result = await editInline(
      llm,
      { orgId, projectId, agent: 'CHAT', subjectId: proposal.testId ?? proposal.id },
      {
        filePath: proposal.filePath,
        code: proposal.oldCode,
        selection: job.selection,
        selectionStartLine: job.selectionStartLine,
        selectionEndLine: job.selectionEndLine,
        instruction,
        availableLocators,
      },
    );

    // A declined edit, or one that changed nothing, is reported rather than
    // shown as an empty diff the user has to interpret.
    if (result.declined || result.code === proposal.oldCode) {
      await prisma.agentProposal.update({
        where: { id: proposal.id },
        data: {
          state: 'REJECTED',
          rationale: result.explanation || 'The agent made no change.',
        },
      });
      return;
    }

    await prisma.agentProposal.update({
      where: { id: proposal.id },
      data: { newCode: result.code, rationale: result.explanation },
    });

    logger.info({ proposalId, bytes: result.code.length }, 'inline edit ready');
  } catch (err) {
    logger.error({ err, proposalId }, 'inline edit failed');
    await prisma.agentProposal.update({
      where: { id: proposal.id },
      data: {
        state: 'REJECTED',
        rationale: err instanceof Error ? `Edit failed: ${err.message}` : 'Edit failed',
      },
    });
  }
}
