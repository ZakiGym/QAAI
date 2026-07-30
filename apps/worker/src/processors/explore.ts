/**
 * Explore processor (§3.1): crawl the app, ask the Explorer what is worth
 * testing, persist the Flow Map and the proposed plan.
 *
 * The crawl and the plan are stored separately and versioned separately. That
 * matters for the "3 uncovered flows — propose tests" prompt in the cockpit:
 * a later crawl can be diffed against the tests that already exist without
 * re-running the model.
 */

import { proposePlan, crawl } from '@qaai/agent';
import type { ExploreJob, FlowMap } from '@qaai/shared';
import { llm, logger, prisma, publishEvent } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueGenerate } from '../queues.js';

export async function processExplore(job: ExploreJob): Promise<void> {
  const { orgId, projectId, environmentId } = job;

  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, orgId },
    select: { id: true, baseUrl: true, projectId: true },
  });
  if (!environment) throw new Error(`Environment ${environmentId} not found for org ${orgId}`);

  const previous = await prisma.flowMap.findFirst({
    where: { orgId, projectId, environmentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (previous?.version ?? 0) + 1;

  // An auth profile's cached storageState lets the crawler get past the login
  // wall and see the half of the app that actually matters (§2).
  const authProfile = await prisma.authProfile.findFirst({
    where: { orgId, environmentId },
    orderBy: { createdAt: 'asc' },
    select: { storageState: true, storageStateExpiresAt: true },
  });
  const storageState =
    authProfile?.storageState &&
    (!authProfile.storageStateExpiresAt || authProfile.storageStateExpiresAt > new Date())
      ? authProfile.storageState
      : undefined;

  logger.info({ projectId, baseUrl: environment.baseUrl, version }, 'crawl starting');
  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'log',
    data: { message: `Crawling ${environment.baseUrl}` },
    at: new Date().toISOString(),
  });

  const flowMap: FlowMap = await crawl({
    baseUrl: environment.baseUrl,
    projectId,
    environmentId,
    version,
    maxPages: job.maxPages,
    maxDepth: job.maxDepth,
    maxMillis: 5 * 60_000,
    storageState,
    onProgress: (message) => {
      logger.debug({ message }, 'crawl progress');
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message },
        at: new Date().toISOString(),
      });
    },
  });

  const stored = await prisma.flowMap.create({
    data: {
      orgId,
      projectId,
      environmentId,
      version,
      graph: flowMap as unknown as object,
      nodeCount: flowMap.nodes.length,
      edgeCount: flowMap.edges.length,
      journeyCount: flowMap.journeys.length,
      truncatedReason: flowMap.truncatedReason,
    },
  });

  logger.info(
    { nodes: flowMap.nodes.length, edges: flowMap.edges.length },
    'crawl complete; asking the Explorer for a plan',
  );

  const secretNames = Object.keys(await secretsFor(orgId, environmentId));
  const { plan } = await proposePlan(
    llm,
    { orgId, projectId, agent: 'EXPLORER', subjectId: stored.id },
    flowMap,
  );

  const testPlan = await prisma.testPlan.create({
    data: {
      orgId,
      projectId,
      flowMapId: stored.id,
      summary: plan.summary,
      skipped: plan.skipped as unknown as object,
      items: {
        create: plan.items.map((item) => ({
          orgId,
          title: item.title,
          rationale: item.rationale,
          feature: item.feature,
          priority: item.priority,
          testType: item.testType,
          steps: item.steps as unknown as object,
          assertions: item.assertions as unknown as object,
          journeyId: item.journeyId,
          authProfileId: item.authProfileId,
        })),
      },
    },
    include: { items: { select: { id: true } } },
  });

  logger.info(
    { planId: testPlan.id, items: testPlan.items.length, secretsAvailable: secretNames.length },
    'plan proposed',
  );

  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'run.finished',
    data: { planId: testPlan.id, items: testPlan.items.length, flowMapVersion: version },
    at: new Date().toISOString(),
  });

  // Onboarding can skip the approval screen; everywhere else a human ticks the
  // boxes before any code is written (§10).
  if (job.autoApprove && testPlan.items.length > 0) {
    await prisma.planItem.updateMany({
      where: { testPlanId: testPlan.id },
      data: { state: 'APPROVED', decidedBy: job.requestedBy, decidedAt: new Date() },
    });
    await enqueueGenerate({
      orgId,
      projectId,
      testPlanId: testPlan.id,
      planItemIds: testPlan.items.map((i) => i.id),
      requestedBy: job.requestedBy,
    });
  }
}
