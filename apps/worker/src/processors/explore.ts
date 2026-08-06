/**
 * Explore processor (§3.1): crawl the app, ask the Explorer what is worth
 * testing, persist the Flow Map and the proposed plan.
 *
 * The crawl and the plan are stored separately and versioned separately. That
 * matters for the "3 uncovered flows — propose tests" prompt in the cockpit:
 * a later crawl can be diffed against the tests that already exist without
 * re-running the model.
 */

import { analyzeCoverage, canScaffoldWithoutModel, planItemForGap, proposePlan, crawl } from '@qaai/agent';
import type { TestPlan, TestType } from '@qaai/shared';
import type { ExploreJob, FlowMap } from '@qaai/shared';
import { config, llm, logger, prisma, publishEvent } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueGenerate } from '../queues.js';

/** Parity with the Explorer's own default, so both paths propose the same size. */
const MAX_PLAN_ITEMS = 12;

/**
 * The plan a crawl can produce with no model at all.
 *
 * `analyzeCoverage` compares the crawl against the suite; on a project with no
 * tests every route, form, affordance and journey it saw comes back as a gap,
 * and `planItemForGap` turns each into a complete PlanItem — title, rationale,
 * priority, ordered steps, assertions. Both are pure, both are unit tested in
 * packages/agent/src/coverage.test.ts, and routes/coverage.ts and
 * routes/traffic.ts have shipped on them for a while.
 *
 * They were never reachable from the first-run path, which is the only path a
 * new customer takes. Without a key `proposePlan` threw, the whole job failed,
 * the finished FlowMap was left with no plan pointing at it, and onboarding sat
 * on a spinner for five minutes before claiming "the crawl did not finish" —
 * about a crawl that had in fact finished and was sitting in the database.
 */
function planFromCrawl(flowMap: FlowMap, reason: string): TestPlan {
  const report = analyzeCoverage({ flowMapGraph: flowMap, tests: [] });
  const chosen = report.gaps.slice(0, MAX_PLAN_ITEMS);

  return {
    summary:
      `${chosen.length} test${chosen.length === 1 ? '' : 's'} proposed directly from the crawl of ` +
      `${flowMap.baseUrl} — ${report.totals.routes} route(s), ${report.totals.forms} form(s) and ` +
      `${report.totals.journeys} journey(s) seen. Written by the crawler, not by a model: ${reason} ` +
      `Every item below is real and approvable; turning an approved item into code is the step that ` +
      `needs the model.`,
    // The reason rides in `skipped` too, because that is the field the approval
    // screen renders as "deliberately not proposed" — a plan that is quietly
    // shorter than usual has to say why, or it reads as the agent's judgement.
    skipped: [
      { what: 'Model-written test proposals', why: reason },
      ...report.gaps.slice(MAX_PLAN_ITEMS, MAX_PLAN_ITEMS + 50).map((gap) => ({
        what: gap.title,
        why: `ranked below the top ${MAX_PLAN_ITEMS} gaps from this crawl`,
      })),
    ],
    items: chosen.map(planItemForGap),
    flowMapVersion: flowMap.version,
  };
}

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

  /*
   * The crawl is the expensive half — a browser, up to five minutes — and this
   * job runs with `attempts: 1`, so there is no retry to fall back on. Losing a
   * finished crawl because the step after it could not reach a model is the
   * wrong trade, and it is the trade that made the product unusable without a
   * key: the FlowMap landed, the plan never did, and every screen downstream
   * read as empty.
   *
   * So the model is best-effort and the crawl is not. Any failure here degrades
   * to the deterministic plan and says so on the plan itself — it fails OPEN and
   * the reason is carried to the human rather than swallowed. `writtenByModel`
   * is what the run.finished event reports, so the cockpit can tell the two
   * kinds of plan apart instead of guessing.
   */
  let plan: TestPlan;
  let writtenByModel: boolean;

  if (!config.anthropicApiKey) {
    // Not an error path: a missing credential is a missing tool. Skipped with a
    // sentence naming the fix, never failed.
    const reason =
      'ANTHROPIC_API_KEY is not set on this deployment, so the Explorer could not ask a model to rank these. Set it and re-run the Explorer for a model-ranked plan.';
    logger.warn({ projectId }, 'no ANTHROPIC_API_KEY — proposing the plan from the crawl');
    publishEvent(orgId, {
      runId: `explore:${projectId}`,
      type: 'log',
      data: { message: `Crawl complete. ${reason}` },
      at: new Date().toISOString(),
    });
    plan = planFromCrawl(flowMap, reason);
    writtenByModel = false;
  } else {
    try {
      plan = (
        await proposePlan(
          llm,
          { orgId, projectId, agent: 'EXPLORER', subjectId: stored.id },
          flowMap,
        )
      ).plan;
      writtenByModel = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = `The Explorer's model call failed (${detail}), so these were read off the crawl instead. The crawl itself succeeded and is stored as flow map v${version}.`;
      logger.error({ err, projectId }, 'the Explorer model call failed; falling back to the crawl');
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message: reason },
        at: new Date().toISOString(),
      });
      plan = planFromCrawl(flowMap, reason);
      writtenByModel = false;
    }
  }

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
    include: { items: { select: { id: true, testType: true } } },
  });

  logger.info(
    {
      planId: testPlan.id,
      items: testPlan.items.length,
      secretsAvailable: secretNames.length,
      writtenByModel,
    },
    'plan proposed',
  );

  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'run.finished',
    data: {
      planId: testPlan.id,
      items: testPlan.items.length,
      flowMapVersion: version,
      writtenByModel,
    },
    at: new Date().toISOString(),
  });

  // Onboarding can skip the approval screen; everywhere else a human ticks the
  // boxes before any code is written (§10).
  if (job.autoApprove && testPlan.items.length > 0) {
    await prisma.planItem.updateMany({
      where: { testPlanId: testPlan.id },
      data: { state: 'APPROVED', decidedBy: job.requestedBy, decidedAt: new Date() },
    });
    // Test CODE genuinely needs a model, but the spec-driven types do not:
    // the Generator scaffolds them deterministically from this very crawl
    // (see @qaai/agent's spec-strategies). So without a key the scaffoldable
    // subset is queued and the rest is skipped with the reason — the same
    // fail-open shape the plan itself took above. Code items stay APPROVED
    // and generate the moment a key is present and the plan is approved again.
    if (config.anthropicApiKey) {
      await enqueueGenerate({
        orgId,
        projectId,
        testPlanId: testPlan.id,
        planItemIds: testPlan.items.map((i) => i.id),
        requestedBy: job.requestedBy,
      });
    } else {
      const scaffoldable = testPlan.items.filter((i) =>
        canScaffoldWithoutModel(i.testType as TestType),
      );
      if (scaffoldable.length > 0) {
        await enqueueGenerate({
          orgId,
          projectId,
          testPlanId: testPlan.id,
          planItemIds: scaffoldable.map((i) => i.id),
          requestedBy: job.requestedBy,
        });
      }
      const needModel = testPlan.items.length - scaffoldable.length;
      const message =
        scaffoldable.length > 0
          ? `${testPlan.items.length} item(s) approved. ${scaffoldable.length} spec-driven item(s) were queued to scaffold from the crawl — each carries review flags naming what to fill in. ` +
            (needModel > 0
              ? `The other ${needModel} need a model: ANTHROPIC_API_KEY is not set on this deployment — set it and approve the plan again.`
              : `Set ANTHROPIC_API_KEY to have a model write them outright.`)
          : `${testPlan.items.length} item(s) approved, but no test code was written: ANTHROPIC_API_KEY is not set on this deployment. Set it and approve the plan again.`;
      logger.warn(
        { planId: testPlan.id, items: testPlan.items.length, scaffolded: scaffoldable.length },
        'auto-approve without ANTHROPIC_API_KEY — queued only the deterministic scaffolds',
      );
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message },
        at: new Date().toISOString(),
      });
    }
  }
}
