/**
 * Coverage gap analysis — the tests you never wrote.
 *
 * Every other reporting endpoint in this API describes tests that exist. This
 * one describes their absence, by putting the two halves we already hold side by
 * side: the FlowMap (what the crawler proved the application can do) and the
 * Test rows (what is actually asserted). The difference is the answer.
 *
 * This file is only the wiring. All of the judgement lives in
 * packages/agent/src/coverage.ts, and none of it calls a model — a gap is a
 * claim about somebody's work, so it has to be arguable from evidence rather
 * than asserted by a language model. The model is invited exactly once, at
 * POST /propose, to WRITE the missing test, and it gets there through the
 * Generator that every other test in this product came from.
 *
 *   GET  /coverage/:projectId          ranked gaps, each with its evidence
 *   POST /coverage/:projectId/propose  turn selected gaps into plan items and
 *                                      queue the Generator on them
 *
 * TWO WIRING DECISIONS WORTH THE COMMENT.
 *
 * First: route extraction is NOT re-derived here. `../lib/impact.js` already
 * pulls route literals out of Test.code and Test.spec — string-level, cap-
 * guarded, with the template and toHaveURL handling that took real bugs to get
 * right — so this file lifts those functions rather than writing a second,
 * worse copy. packages/agent cannot import from an app, which is why the
 * analysis takes routes as an input and this is the one place that seam exists.
 *
 * Second: `indexTests` from that module is deliberately NOT used, even though
 * it is right there and returns almost the same shape. It folds a test's
 * *feature name* into its route set via the flow map, which is correct for
 * impact analysis ("a checkout test answers for a checkout change") and
 * circular for this one. A test labelled Checkout would be credited with
 * covering every checkout route without asserting a thing, and coverage the
 * suite does not have is the single claim this feature must never make.
 */

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { FIXTURE_PREFIX, QUEUE_NAMES } from '@qaai/shared';
import type { Priority, TestType } from '@qaai/shared';
/*
 * A relative path rather than `@qaai/agent`, because the package's export map
 * is `{ ".": "./src/index.ts" }` and its barrel is owned by another change in
 * flight. Swap this for a bare `@qaai/agent` import the moment
 * `export * from './coverage.js'` lands in packages/agent/src/index.ts — the
 * named imports are identical and nothing else has to move.
 */
import {
  analyzeCoverage,
  planItemForGap,
  type CoverageGap,
  type CoverageReport,
  type CoverageTestInput,
} from '../../../../packages/agent/src/coverage.js';
import {
  routeLiteralsFromCode,
  routesFromSpec,
  type CoverageTruncation,
} from '../lib/impact.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { env } from '../env.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

export const coverageRouter: Router = Router();

coverageRouter.use(requireAuth);

/** At most this many gaps become plan items in one request. */
const MAX_PROPOSALS = 25;

/**
 * The runnable set, mirroring POST /runs and /impact/analyze: disabled tests and
 * `fixtures/` rows are not tests, and counting them as coverage would mean
 * telling a team a route is tested by a spec that never executes.
 */
const TEST_SELECT = {
  id: true,
  name: true,
  filePath: true,
  code: true,
  spec: true,
  tags: true,
  feature: true,
  priority: true,
  type: true,
} as const;

type TestRow = {
  id: string;
  name: string;
  filePath: string;
  code: string | null;
  spec: unknown;
  tags: string[];
  feature: string | null;
  priority: string;
  type: string;
};

/**
 * Test rows → the analysis's input, with impact.ts doing the extraction.
 *
 * `coverageTruncated` is the load-bearing field. When either extractor hits a
 * cap it means we read only part of what this test declares, and the part we
 * did not read is exactly where the missing coverage might be. Passing that
 * through is what keeps such a test in the UNKNOWN bucket instead of letting
 * its silence be counted as a gap somewhere else.
 */
export function toCoverageInputs(tests: TestRow[]): CoverageTestInput[] {
  return tests.map((test) => {
    const truncation: CoverageTruncation = { truncated: false };
    const routes = new Set<string>();
    for (const route of routeLiteralsFromCode(test.code ?? '', truncation)) routes.add(route);
    for (const route of routesFromSpec(test.spec, 0, new Set<string>(), truncation)) {
      routes.add(route);
    }

    return {
      id: test.id,
      name: test.name,
      filePath: test.filePath,
      feature: test.feature,
      priority: test.priority as Priority,
      testType: test.type as TestType,
      tags: test.tags,
      routes: [...routes],
      code: test.code,
      coverageTruncated: truncation.truncated,
    };
  });
}

interface ProjectCoverage {
  report: CoverageReport;
  /** The crawl the report was computed against; the plan is pinned to it. */
  flowMapId: string | null;
  flowMapVersion: number | null;
}

/**
 * Both endpoints compute the report the same way, from the same latest crawl.
 * Sharing it is what makes the fingerprint check on /propose mean anything: the
 * two calls are comparing the same computation, not two similar ones.
 */
async function coverageFor(projectId: string, limit?: number): Promise<ProjectCoverage> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const [tests, flowMap] = await Promise.all([
    prisma.test.findMany({
      where: {
        projectId: project.id,
        disabledAt: null,
        filePath: { not: { startsWith: FIXTURE_PREFIX } },
      },
      select: TEST_SELECT,
    }),
    // Latest crawl only. An older version describes an app that no longer
    // exists, and a "gap" on a route that was deleted last month is noise that
    // costs this report its credibility.
    prisma.flowMap.findFirst({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: { id: true, graph: true, version: true },
    }),
  ]);

  const report = analyzeCoverage({
    flowMapGraph: flowMap?.graph ?? null,
    tests: toCoverageInputs(tests),
    ...(limit === undefined ? {} : { limit }),
  });

  return {
    report,
    flowMapId: flowMap?.id ?? null,
    // The row's version is authoritative; the serialised graph's copy can lag.
    flowMapVersion: flowMap?.version ?? report.flowMapVersion,
  };
}

// ─── GET /coverage/:projectId ────────────────────────────────────────────────

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(300).optional(),
  /** Comma-separated GapKind values. Unknown names are a 400, not a silent empty list. */
  kind: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  /**
   * Include the deterministic plan item each gap would become. Needs no API key
   * — this is the proposal BEFORE the model writes code — so it is the honest
   * way to see what /propose would do before committing to it.
   */
  proposals: z.enum(['true', '1']).optional(),
});

coverageRouter.get('/:projectId', requireScope('tests:read'), async (req, res) => {
  const query = listQuery.parse(req.query);
  const { report, flowMapId, flowMapVersion } = await coverageFor(
    String(req.params.projectId),
    query.limit,
  );

  let gaps = report.gaps;
  if (query.kind) {
    const wanted = new Set(
      query.kind
        .split(',')
        .map((k) => k.trim().toUpperCase())
        .filter(Boolean),
    );
    const known = new Set(report.gaps.map((g) => g.kind as string));
    // A typo'd filter that silently returns nothing reads exactly like "you have
    // no gaps of that kind", which is the one wrong answer this endpoint can
    // give. Only reject names that are not in the vocabulary at all.
    const unknownNames = [...wanted].filter((k) => !GAP_KIND_NAMES.has(k));
    if (unknownNames.length > 0) {
      throw badRequest(`Unknown gap kind(s): ${unknownNames.join(', ')}`, {
        known: [...GAP_KIND_NAMES],
        presentInThisProject: [...known],
      });
    }
    gaps = gaps.filter((g) => wanted.has(g.kind));
  }
  if (query.minScore !== undefined) gaps = gaps.filter((g) => g.score >= query.minScore!);

  const wantProposals = query.proposals === 'true' || query.proposals === '1';

  res.json({
    ...report,
    flowMapId,
    flowMapVersion,
    gaps: wantProposals
      ? gaps.map((gap) => ({ ...gap, proposal: safeProposal(gap) }))
      : gaps,
    filtered: gaps.length !== report.gaps.length,
    limits: { maxProposalsPerRequest: MAX_PROPOSALS },
  });
});

/**
 * The vocabulary, duplicated as a Set for the filter check. Kept here rather
 * than imported as a value so the query validator does not depend on the
 * analysis module's export shape.
 */
const GAP_KIND_NAMES = new Set([
  'UNVISITED_ROUTE',
  'UNREACHED_AUTH_ROUTE',
  'UNWALKED_JOURNEY',
  'UNSUBMITTED_FORM',
  'UNUSED_AFFORDANCE',
  'NO_NEGATIVE_CASE',
]);

/**
 * A proposal is a preview, and a preview must never be able to lose the report.
 * If one gap has a shape `planItemForGap` cannot express, the reader still gets
 * every other gap and an explicit null for this one.
 */
function safeProposal(gap: CoverageGap): ReturnType<typeof planItemForGap> | null {
  try {
    return planItemForGap(gap);
  } catch {
    return null;
  }
}

// ─── POST /coverage/:projectId/propose ───────────────────────────────────────

const proposeSchema = z.object({
  gapIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_PROPOSALS),
  /**
   * The fingerprint from the GET that produced these ids. Optional, and checked
   * when supplied: a human ticking gaps on a screen that went stale ten minutes
   * ago should be told, not quietly handed a test for a gap somebody already
   * closed.
   */
  fingerprint: z.string().max(64).optional(),
});

coverageRouter.post(
  '/:projectId/propose',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const input = proposeSchema.parse(req.body);

    const { report, flowMapId, flowMapVersion } = await coverageFor(projectId);

    if (!report.crawled) {
      throw unprocessable(
        'This project has no readable crawl, so there are no gaps to propose tests for. Run the Explorer first.',
      );
    }
    if (input.fingerprint && input.fingerprint !== report.fingerprint) {
      throw conflict(
        'The coverage report has changed since you looked at it — tests were added, or the app was re-crawled. Re-read GET /coverage/:projectId and choose again.',
        { yours: input.fingerprint, current: report.fingerprint },
      );
    }

    const byId = new Map(report.gaps.map((gap) => [gap.id, gap]));
    /*
     * Deduplicate the request before doing anything with it.
     *
     * The same gap id arriving twice is a "select all" over a list that used to
     * show the same finding more than once. Honouring both would mint two
     * identical PlanItems and hand the Generator the same work twice, which is
     * the opposite of what a coverage report is for. Fixed at the source in
     * coverage.ts too; this is the belt to that pair of braces, because a stale
     * client can still send repeats.
     */
    const requestedIds = [...new Set(input.gapIds)];
    const selected = requestedIds.map((id) => byId.get(id)).filter((g): g is CoverageGap => Boolean(g));
    const missing = requestedIds.filter((id) => !byId.has(id));
    if (selected.length === 0) {
      throw conflict(
        'None of those gaps is in the current report. They were probably closed by a test that has since been added, or the app was re-crawled.',
        { missing },
      );
    }

    /*
     * Built before the write, so a proposal this endpoint cannot express fails
     * the request outright rather than committing half a plan.
     *
     * The row ids are minted here rather than by the database, because the
     * caller needs to know which plan item closes which gap and Prisma makes no
     * promise that a nested `create` array comes back in the order it went in.
     * Reading the mapping off the returned order would be right in testing and
     * wrong, silently, in production.
     */
    const items = selected.map((gap) => ({
      gap,
      rowId: randomUUID(),
      item: planItemForGap(gap),
    }));

    const plan = await prisma.testPlan.create({
      data: {
        orgId: actor.orgId,
        projectId,
        flowMapId,
        summary: `Coverage gaps selected from flow map v${flowMapVersion ?? '?'}: ${selected.length} of ${report.totals.gaps} found. Each item's rationale is the evidence for the gap it closes.`,
        // The plan records what was NOT chosen, the same way the Explorer's does.
        // Without it, a plan of two items looks like a report of two gaps.
        skipped: report.gaps
          .filter((gap) => !selected.includes(gap))
          .slice(0, 50)
          .map((gap) => ({ what: gap.title, why: 'not selected in this request' })),
        items: {
          create: items.map(({ item, rowId }) => ({
            id: rowId,
            orgId: actor.orgId,
            title: item.title,
            rationale: item.rationale,
            feature: item.feature,
            priority: item.priority,
            testType: item.testType,
            steps: item.steps,
            assertions: item.assertions,
            journeyId: item.journeyId,
            authProfileId: item.authProfileId,
            /*
             * APPROVED, not PROPOSED. The Explorer proposes cold and a human
             * ticks them on the approval screen; here the ticking already
             * happened — that is what this request IS — and leaving them
             * PROPOSED would strand them waiting for an approval nobody is
             * going to give twice.
             */
            state: 'APPROVED' as const,
            decidedBy: actor.userId,
            decidedAt: new Date(),
          })),
        },
      },
      include: { items: { select: { id: true, title: true, priority: true, testType: true } } },
    });

    /*
     * Generation needs a key. Missing one is a MISSING TOOL, not a failure: the
     * deterministic half of this request — the gaps, the steps read off the
     * crawl, the assertions — is already done and already worth having. So the
     * plan is kept, the job is not queued, and the caller is told exactly what
     * to set. Queueing anyway would burn three BullMQ attempts to arrive at the
     * same sentence an hour later, in a log nobody is reading.
     */
    if (!env.ANTHROPIC_API_KEY) {
      await audit({
        actor,
        action: 'coverage.propose',
        targetType: 'TestPlan',
        targetId: plan.id,
        metadata: { gaps: selected.length, queued: false, reason: 'no ANTHROPIC_API_KEY' },
      });
      res.status(200).json({
        testPlanId: plan.id,
        items: plan.items,
        mapping: items.map(({ gap, rowId }) => ({ gapId: gap.id, planItemId: rowId })),
        skippedGapIds: missing,
        generation: {
          queued: false,
          reason:
            'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run. The plan items above are complete and were written from the crawl, not by a model — set the key and approve the plan (POST /plans/:planId/approve) to turn them into code.',
        },
        fingerprint: report.fingerprint,
      });
      return;
    }

    const jobId = await enqueue(QUEUE_NAMES.generate, {
      orgId: actor.orgId,
      projectId,
      testPlanId: plan.id,
      planItemIds: items.map(({ rowId }) => rowId),
      requestedBy: actor.userId,
    });

    await audit({
      actor,
      action: 'coverage.propose',
      targetType: 'TestPlan',
      targetId: plan.id,
      metadata: {
        gaps: selected.length,
        kinds: [...new Set(selected.map((gap) => gap.kind))],
        flowMapVersion,
        queued: true,
      },
    });

    res.status(202).json({
      jobId,
      testPlanId: plan.id,
      items: plan.items,
      mapping: items.map(({ gap, rowId }) => ({ gapId: gap.id, planItemId: rowId })),
      skippedGapIds: missing,
      generation: { queued: true },
      fingerprint: report.fingerprint,
    });
  },
);
