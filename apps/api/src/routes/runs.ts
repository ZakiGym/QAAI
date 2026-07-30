/**
 * Runs (§5) — enqueue, read, stream, and the artifact endpoint the cockpit's
 * screenshots and trace viewer load from.
 */

import { Router } from 'express';
import { FIXTURE_PREFIX, PLAN_LIMITS, QUEUE_NAMES, createRunSchema } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, planLimit } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { storage } from '../lib/storage.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import { env } from '../env.js';

export const runsRouter: Router = Router();

runsRouter.use(requireAuth);

/** First day of the current UTC month — the usage-metering period key (§9). */
function currentPeriod(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

runsRouter.post('/', requireRole('MEMBER'), requireScope('runs:write'), async (req, res) => {
  const actor = actorOf(req);
  const input = createRunSchema.parse(req.body);

  const environment = await prisma.environment.findUnique({
    where: { id: input.environmentId },
    select: { id: true, projectId: true },
  });
  if (!environment) throw notFound('Environment');

  // Free plan caps monthly runs; paid plans are unlimited by design (§9), which
  // is the differentiator, so the check is deliberately narrow.
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.orgId },
    select: { plan: true },
  });
  const monthlyCap = PLAN_LIMITS[org.plan].maxRunsPerMonth;
  if (monthlyCap !== null) {
    const used = await prisma.run.count({ where: { queuedAt: { gte: currentPeriod() } } });
    if (used >= monthlyCap) {
      throw planLimit(
        `The ${PLAN_LIMITS[org.plan].label} plan includes ${monthlyCap} runs per month`,
        { limit: 'maxRunsPerMonth', plan: org.plan },
      );
    }
  }

  /**
   * Rows under `fixtures/` are test DATA, not tests — they hold no runnable code.
   * Excluded from both selection paths, so neither "run everything" nor an
   * explicit id list can queue one and report it as a failure.
   */
  const runnable = await prisma.test.findMany({
    where: {
      projectId: environment.projectId,
      disabledAt: null,
      filePath: { not: { startsWith: FIXTURE_PREFIX } },
      ...(input.testIds ? { id: { in: input.testIds } } : {}),
      ...(input.suiteId && !input.testIds ? { suiteId: input.suiteId } : {}),
    },
    select: { id: true },
  });
  const testIds = runnable.map((t) => t.id);

  if (testIds.length === 0) {
    throw badRequest('There are no tests to run for that suite or project');
  }

  const run = await prisma.run.create({
    data: {
      orgId: actor.orgId,
      projectId: environment.projectId,
      environmentId: environment.id,
      suiteId: input.suiteId ?? null,
      trigger: input.trigger,
      triggeredBy: actor.userId || null,
      commitSha: input.commitSha ?? null,
      prNumber: input.prNumber ?? null,
      totalCount: testIds.length,
      // Results are created upfront as placeholders so the cockpit can render
      // the whole suite immediately with each test pending.
      results: {
        create: testIds.map((testId) => ({
          orgId: actor.orgId,
          testId,
          status: 'SKIPPED' as const,
        })),
      },
    },
  });

  await prisma.usageRecord.upsert({
    where: { orgId_metric_period: { orgId: actor.orgId, metric: 'runs', period: currentPeriod() } },
    create: { orgId: actor.orgId, metric: 'runs', period: currentPeriod(), quantity: 1n },
    update: { quantity: { increment: 1n } },
  });

  const jobId = await enqueue(
    QUEUE_NAMES.run,
    { orgId: actor.orgId, runId: run.id },
    {
      // Idempotent on run id: a retried POST cannot double-execute a suite.
      jobId: `run-${run.id}`,
    },
  );

  await audit({
    actor,
    action: 'run.create',
    targetType: 'Run',
    targetId: run.id,
    metadata: { tests: testIds.length, trigger: input.trigger },
  });

  res.status(202).json({ run, jobId });
});

runsRouter.get('/', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  const runs = await prisma.run.findMany({
    where: { ...(projectId ? { projectId } : {}) },
    orderBy: { queuedAt: 'desc' },
    take: Math.min(100, Number(req.query.limit ?? 25)),
    include: { environment: { select: { name: true, kind: true } } },
  });
  res.json({ runs });
});

runsRouter.get('/:runId', async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    include: {
      environment: { select: { name: true, kind: true, baseUrl: true } },
      results: {
        include: {
          test: {
            select: {
              id: true,
              name: true,
              type: true,
              priority: true,
              filePath: true,
              quarantined: true,
            },
          },
          steps: { orderBy: { index: 'asc' } },
          findings: true,
          verdict: true,
        },
      },
    },
  });
  if (!run) throw notFound('Run');
  res.json({ run });
});

/** Live run events for the cockpit's right pane (§8). */
runsRouter.get('/:runId/events', async (req, res) => {
  const actor = actorOf(req);
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    select: { id: true, status: true },
  });
  if (!run) throw notFound('Run');

  const unsubscribe = subscribe(actor.orgId, run.id, res);
  req.on('close', unsubscribe);
});

/**
 * Artifact reader. Everything is served through the API rather than handing out
 * a bucket URL, so an artifact is subject to the same session and tenancy check
 * as the run it belongs to.
 */
runsRouter.get('/:runId/artifacts/{*key}', async (req, res) => {
  const key = Array.isArray(req.params.key)
    ? req.params.key.join('/')
    : String(req.params.key ?? '');

  const artifact = await prisma.artifact.findUnique({ where: { key } });
  if (!artifact || artifact.runId !== req.params.runId) throw notFound('Artifact');

  if (env.ARTIFACTS_LOCAL) {
    const body = await storage.get(key);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(body);
    return;
  }

  res.redirect(302, await storage.signedUrl(key, 3600));
});

/** JUnit XML for any CI's native reporting (§6). */
runsRouter.get('/:runId/junit.xml', async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: String(req.params.runId) },
    include: { results: { include: { test: { select: { name: true } } } } },
  });
  if (!run) throw notFound('Run');

  const escape = (v: string) =>
    v.replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );

  const cases = run.results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3);
      const name = escape(r.test.name);
      if (r.status === 'PASSED') return `    <testcase name="${name}" time="${time}"/>`;
      if (r.status === 'SKIPPED')
        return `    <testcase name="${name}" time="${time}"><skipped/></testcase>`;
      return `    <testcase name="${name}" time="${time}"><failure message="${escape(
        r.errorMessage ?? 'failed',
      )}"/></testcase>`;
    })
    .join('\n');

  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="qaai" tests="${run.totalCount}" failures="${run.failedCount}" skipped="${run.skippedCount}">\n${cases}\n  </testsuite>\n</testsuites>\n`,
    );
});
