/**
 * Generate processor (§3.2): turns approved plan items into real test files.
 *
 * Each item is generated independently so one bad item cannot take the batch
 * down — a plan of ten where one fails should produce nine tests and one
 * recorded error, not zero tests.
 */

import { generateTest } from '@qaai/agent';
import type { FlowMap, GenerateJob, Priority, TestType } from '@qaai/shared';
import { llm, logger, prisma } from '../context.js';
import { secretsFor } from '../vault.js';

export async function processGenerate(job: GenerateJob): Promise<void> {
  const { orgId, projectId, testPlanId, planItemIds } = job;

  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, primaryLanguage: true, primaryFramework: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found for org ${orgId}`);

  const plan = await prisma.testPlan.findFirst({
    where: { id: testPlanId, orgId },
    select: { id: true, flowMapId: true },
  });
  if (!plan) throw new Error(`Test plan ${testPlanId} not found`);

  const flowMapRow = plan.flowMapId
    ? await prisma.flowMap.findUnique({ where: { id: plan.flowMapId } })
    : await prisma.flowMap.findFirst({ where: { orgId, projectId }, orderBy: { version: 'desc' } });
  if (!flowMapRow) throw new Error('No flow map to generate against — run the Explorer first');

  const flowMap = flowMapRow.graph as unknown as FlowMap;

  const environment = await prisma.environment.findFirst({
    where: { orgId, id: flowMapRow.environmentId },
    select: { id: true },
  });
  const secretNames = environment ? Object.keys(await secretsFor(orgId, environment.id)) : [];

  const items = await prisma.planItem.findMany({
    where: { id: { in: planItemIds }, orgId, testPlanId },
  });

  // One suite per generation batch keeps the cockpit's left pane meaningful
  // instead of a flat list that grows forever.
  const suite = await prisma.suite.upsert({
    where: { projectId_name: { projectId, name: 'Generated' } },
    create: { orgId, projectId, name: 'Generated', description: 'Tests written by the Generator' },
    update: {},
  });

  let created = 0;
  const failures: Array<{ itemId: string; error: string }> = [];

  for (const item of items) {
    try {
      const generated = await generateTest(
        llm,
        { orgId, projectId, agent: 'GENERATOR', subjectId: item.id },
        {
          item: {
            id: item.id,
            title: item.title,
            rationale: item.rationale,
            feature: item.feature,
            priority: item.priority as Priority,
            testType: item.testType as TestType,
            steps: item.steps as string[],
            assertions: item.assertions as string[],
            journeyId: item.journeyId,
            authProfileId: item.authProfileId,
          },
          flowMap,
          language: project.primaryLanguage,
          framework: project.primaryFramework,
          availableSecretNames: secretNames,
        },
      );

      const test = await prisma.test.create({
        data: {
          orgId,
          projectId,
          suiteId: suite.id,
          name: generated.name,
          type: item.testType,
          feature: item.feature,
          priority: item.priority,
          code: generated.code,
          filePath: generated.filePath,
          tags: item.priority === 'CRITICAL_PATH' ? ['smoke'] : [],
          reviewFlags: generated.reviewFlags,
          planItemId: item.id,
          versions: {
            create: {
              orgId,
              version: 1,
              code: generated.code,
              source: 'GENERATOR',
              message: `Generated from plan item "${item.title}"`,
            },
          },
        },
      });

      await prisma.planItem.update({
        where: { id: item.id },
        data: { state: 'GENERATED', generatedTestId: test.id },
      });

      created += 1;
      logger.info(
        { testId: test.id, name: test.name, flags: generated.reviewFlags.length },
        'test generated',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ itemId: item.id, error: message });
      logger.error({ err, itemId: item.id, title: item.title }, 'generation failed for plan item');
    }
  }

  logger.info(
    { created, failed: failures.length, planId: testPlanId },
    'generation batch complete',
  );

  if (created === 0 && failures.length > 0) {
    // Nothing was produced — surface it as a job failure so it shows up in the
    // admin panel instead of looking like a successful no-op.
    throw new Error(`Generation produced no tests. First error: ${failures[0]!.error}`);
  }
}
