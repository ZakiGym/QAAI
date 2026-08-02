/**
 * Traffic-driven test proposals (API side).
 *
 * Two endpoints, and the split between them is the same one the rest of the
 * product uses: analysis is deterministic, fast and answered in the request;
 * generation calls a model and goes on the queue.
 *
 *   POST /traffic/:projectId/analyze   upload → ranked journeys, frequencies,
 *                                      coverage against the existing suite, and
 *                                      an itemised account of what was stripped
 *   POST /traffic/:projectId/propose   chosen journeys → approved plan items →
 *                                      the Generator writes the tests
 *
 * ── WHAT THIS FILE IS CAREFUL ABOUT ─────────────────────────────────────────
 *
 * 1. NOTHING RAW IS EVER PERSISTED. `analyzeTraffic` redacts on ingest and this
 *    route never sees the upload again after handing it over — the request body
 *    is not written anywhere, not to a row, not to the audit log, not to a log
 *    line. The audit entry records counts and never content.
 *
 * 2. THE CLIENT'S JOURNEYS ARE UNTRUSTED INPUT ON THE WAY BACK. /propose takes
 *    journeys that have been through a browser, so every route is re-sanitised
 *    here and the journey id is recomputed from the sanitised steps. If the two
 *    disagree, the steps were edited after the analysis — which is exactly what
 *    a raw production path smuggled into the plan would look like — and the
 *    request is refused rather than quietly persisted.
 *
 * 3. COVERAGE IS RECOMPUTED SERVER-SIDE. A client claiming a journey is
 *    uncovered does not make it so; the suite may have changed since /analyze,
 *    and "we already test this" is a claim only the database can make.
 *
 * 4. GENERATION FAILS FAST WHEN IT CANNOT SUCCEED. The Generator needs a Flow
 *    Map for real locators, so a project that has never been crawled is told
 *    that here, in a 422, instead of enqueuing a job that dies in the worker
 *    where nobody is watching.
 */

import { Router, text } from 'express';
import { z } from 'zod';
import { QUEUE_NAMES } from '@qaai/shared';
import {
  TrafficFormatError,
  analyzeTraffic,
  crossReferenceSteps,
  journeyIdOf,
  journeyToPlanItem,
  sanitisePath,
  type ExistingTest,
  type Journey,
  type TrafficFormat,
} from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const trafficRouter: Router = Router();

trafficRouter.use(requireAuth);

/**
 * The global JSON parser is capped at 2MB, which a week of access logs will
 * exceed on its own. Text uploads are parsed here instead, with their own
 * limit: `express.json` ignores these content types, so the two do not fight.
 *
 * A large HAR should therefore be posted as `text/plain` or
 * `application/har+json` rather than `application/json` — the parser sniffs the
 * shape either way, so the content type only decides which body parser runs.
 */
const UPLOAD_LIMIT = '24mb';
trafficRouter.use(
  ['/traffic/:projectId/analyze'],
  text({
    type: [
      'text/plain',
      'text/*',
      'application/x-ndjson',
      'application/har+json',
      'application/octet-stream',
    ],
    limit: UPLOAD_LIMIT,
  }),
);

/**
 * Lower than the module's own cap. The analysis is synchronous, so this bound
 * is really a bound on how long one request may hold the event loop; a bigger
 * upload is still accepted, it is just analysed as its first 50k entries and
 * says so in `warnings`.
 */
const API_MAX_ENTRIES = 50_000;
/** Enough of the suite to cross-reference against without reading a book. */
const MAX_TESTS_COMPARED = 500;
const MAX_JOURNEYS_PROPOSED = 20;

// ─── Analyze ─────────────────────────────────────────────────────────────────

const analyzeOptionsSchema = z.object({
  format: z.enum(['HAR', 'ACCESS_LOG', 'OTLP', 'AUTO']).optional(),
  sessionGapMinutes: z.coerce
    .number()
    .min(1)
    .max(24 * 60)
    .optional(),
  maxJourneys: z.coerce.number().int().min(1).max(40).optional(),
  includeStaticAssets: z.coerce.boolean().optional(),
  includeBots: z.coerce.boolean().optional(),
});

type AnalyzeOptionsInput = z.infer<typeof analyzeOptionsSchema>;

/**
 * Accepts the upload three ways, because three different clients send it three
 * different ways: a raw text body (curl piping a log file), a JSON envelope
 * `{ content, ...options }` (the cockpit), or the HAR/OTLP document itself as
 * the JSON body (anything scripted against the API).
 */
function readUpload(body: unknown): { payload: string | Record<string, unknown>; inline: unknown } {
  if (typeof body === 'string') {
    if (!body.trim()) throw badRequest('The upload is empty.');
    return { payload: body, inline: {} };
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.content === 'string') {
      if (!record.content.trim()) throw badRequest('`content` is empty.');
      return { payload: record.content, inline: record };
    }
    if (record.log !== undefined || record.resourceSpans !== undefined) {
      return { payload: record, inline: {} };
    }
  }
  throw badRequest(
    'Upload traffic as a text body (access logs, NDJSON), as `{ content: "…" }`, or as the HAR ' +
      'or OTLP document itself. Nothing recognisable was in the body.',
  );
}

function optionsFrom(inline: unknown, query: unknown): AnalyzeOptionsInput {
  const merged = { ...(query as object), ...(inline as object) };
  const parsed = analyzeOptionsSchema.safeParse(merged);
  if (!parsed.success) {
    throw badRequest('Invalid analysis options', parsed.error.flatten().fieldErrors);
  }
  return parsed.data;
}

async function loadProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

async function loadSuite(projectId: string): Promise<ExistingTest[]> {
  const tests = await prisma.test.findMany({
    where: { projectId, disabledAt: null },
    select: { id: true, name: true, code: true, filePath: true, spec: true },
    take: MAX_TESTS_COMPARED,
    orderBy: { createdAt: 'asc' },
  });
  return tests.map((test) => ({
    id: test.id,
    name: test.name,
    code: test.code,
    filePath: test.filePath,
    spec: test.spec,
  }));
}

trafficRouter.post('/traffic/:projectId/analyze', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  const project = await loadProject(projectId);

  const { payload, inline } = readUpload(req.body);
  const options = optionsFrom(inline, req.query);
  const existingTests = await loadSuite(projectId);

  let analysis;
  try {
    analysis = analyzeTraffic(payload, {
      format: options.format ?? 'AUTO',
      maxEntries: API_MAX_ENTRIES,
      maxJourneys: options.maxJourneys ?? 25,
      existingTests,
      ...(options.sessionGapMinutes ? { sessionGapMs: options.sessionGapMinutes * 60_000 } : {}),
      ...(options.includeStaticAssets !== undefined
        ? { includeStaticAssets: options.includeStaticAssets }
        : {}),
      ...(options.includeBots !== undefined ? { includeBots: options.includeBots } : {}),
    });
  } catch (err) {
    // A format we cannot read is the caller's problem to fix and the message
    // names the accepted shapes — it must not surface as an opaque 500.
    if (err instanceof TrafficFormatError) throw badRequest(err.message);
    throw err;
  }

  // Counts only. The upload is not written here, to the audit log, or anywhere
  // else — and it is not retained after this handler returns.
  await audit({
    actor,
    action: 'traffic.analyze',
    targetType: 'Project',
    targetId: project.id,
    metadata: {
      format: analysis.format,
      requests: analysis.totals.requests,
      sessions: analysis.totals.sessions,
      journeys: analysis.journeys.length,
      skipped: analysis.totals.skipped,
      redacted: analysis.redaction.counts,
    },
  });

  res.json({
    format: analysis.format,
    window: analysis.window,
    totals: analysis.totals,
    redaction: analysis.redaction,
    parameterisation: analysis.parameterisation,
    identityBreakdown: analysis.identityBreakdown,
    warnings: analysis.warnings,
    journeys: analysis.journeys,
    /** What /propose expects back, so the client does not have to guess. */
    next: {
      endpoint: `/traffic/${project.id}/propose`,
      send: 'the journeys you want tests for, unmodified, plus totalSessions and source',
    },
  });
});

// ─── Propose ─────────────────────────────────────────────────────────────────

const stepSchema = z.object({
  method: z.string().min(1).max(16),
  route: z.string().min(1).max(512),
  status: z.number().int().nullable().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  count: z.number().int().min(0).optional(),
  repeats: z.number().int().min(0).optional(),
});

const journeySchema = z.object({
  id: z.string().min(4).max(64),
  name: z.string().max(240).optional(),
  feature: z.string().max(80).optional(),
  steps: z.array(stepSchema).min(1).max(40),
  sessionCount: z.number().int().min(0),
  sessionShare: z.number().min(0).max(1),
  containingSessionCount: z.number().int().min(0).optional(),
  containingSessionShare: z.number().min(0).max(1).optional(),
  requestCount: z.number().int().min(0),
  errorRate: z.number().min(0).max(1).optional(),
  firstSeen: z.string().max(40),
  lastSeen: z.string().max(40),
  contentKind: z.enum(['html', 'json', 'other', 'mixed', 'unknown']).optional(),
  medianDurationMs: z.number().nullable().optional(),
});

const proposeSchema = z.object({
  journeys: z.array(journeySchema).min(1).max(MAX_JOURNEYS_PROPOSED),
  /** Denominator behind every percentage, from the analysis that produced these. */
  totalSessions: z.number().int().min(1),
  source: z.enum(['HAR', 'ACCESS_LOG', 'OTLP']),
  testType: z.enum(['E2E', 'API', 'SMOKE', 'INTEGRATION']).optional(),
  /** Propose anyway for journeys the suite already covers. Off by default. */
  includeCovered: z.boolean().optional(),
});

/**
 * Re-sanitises a client-supplied journey and proves it came from an analysis.
 *
 * Every route goes back through the ingest classifier, and the journey id is
 * recomputed from the result. A journey that survived the round trip unchanged
 * hashes to the id it arrived with; one whose routes were edited — which is
 * what a raw production path smuggled into the plan looks like — does not, and
 * is refused. That makes the id an integrity check rather than a label.
 */
function resanitise(journey: z.infer<typeof journeySchema>): {
  ok: boolean;
  steps: Array<{
    method: string;
    route: string;
    status: number | null;
    errorRate: number;
    count: number;
    repeats: number;
  }>;
} {
  const steps = journey.steps.map((step) => {
    const { segments } = sanitisePath(step.route);
    const route =
      segments.length === 0
        ? '/'
        : `/${segments.map((s) => s.text.replace(/^[{<](.+)[}>]$/, ':$1')).join('/')}`;
    return {
      method: step.method.toUpperCase().slice(0, 16),
      route,
      status: step.status ?? null,
      errorRate: step.errorRate ?? 0,
      count: step.count ?? journey.sessionCount,
      repeats: step.repeats ?? 0,
    };
  });

  return { ok: journeyIdOf(steps) === journey.id, steps };
}

trafficRouter.post('/traffic/:projectId/propose', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  // Called for its 404, not its value: a proposal against a project that does
  // not exist must not fall through to "no journeys matched".
  await loadProject(projectId);

  const parsed = proposeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest('Invalid proposal request', parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;

  // The Generator writes against the Flow Map's real locators. Without one it
  // would invent selectors, and the worker throws — so say so here, where the
  // person who can fix it is still on the line.
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  if (!flowMap) {
    throw unprocessable(
      'This project has never been crawled, so the Generator has no locators to write against. ' +
        'Run the Explorer once, then propose these journeys again.',
    );
  }

  const existingTests = await loadSuite(projectId);

  const accepted: Array<{ journey: Journey; steps: ReturnType<typeof resanitise>['steps'] }> = [];
  const skipped: Array<{ what: string; why: string }> = [];
  const tampered: string[] = [];

  for (const raw of input.journeys) {
    const { ok, steps } = resanitise(raw);
    if (!ok) {
      tampered.push(raw.id);
      continue;
    }

    // Never trust a coverage verdict that arrived over the wire: the suite may
    // have gained the very test that covers this since /analyze ran.
    const coverage = crossReferenceSteps(steps, existingTests);
    if (coverage.status === 'COVERED' && input.includeCovered !== true) {
      skipped.push({
        what: steps.map((s) => `${s.method} ${s.route}`).join(' → '),
        why:
          `Already covered by "${coverage.matchedTests[0]?.name ?? 'an existing test'}" — ` +
          'pass includeCovered to propose it anyway.',
      });
      continue;
    }

    accepted.push({
      steps,
      journey: {
        id: raw.id,
        name:
          raw.name ??
          steps
            .map((s) => s.route)
            .join(' → ')
            .slice(0, 200),
        feature: raw.feature ?? 'Traffic',
        steps,
        sessionCount: raw.sessionCount,
        sessionShare: raw.sessionShare,
        containingSessionCount: raw.containingSessionCount ?? raw.sessionCount,
        containingSessionShare: raw.containingSessionShare ?? raw.sessionShare,
        requestCount: raw.requestCount,
        medianDurationMs: raw.medianDurationMs ?? null,
        errorRate: raw.errorRate ?? 0,
        firstSeen: raw.firstSeen,
        lastSeen: raw.lastSeen,
        contentKind: raw.contentKind ?? 'unknown',
        identitySources: [],
        suggestedTestType: raw.contentKind === 'json' ? 'API' : 'E2E',
        suggestedPriority:
          raw.sessionShare >= 0.2
            ? 'CRITICAL_PATH'
            : raw.sessionShare >= 0.05
              ? 'IMPORTANT'
              : 'NICE_TO_HAVE',
        coverage,
      },
    });
  }

  if (tampered.length > 0) {
    throw badRequest(
      'Some journeys do not match their own id, which means their steps were changed after the ' +
        'analysis produced them. Re-run /analyze and propose the journeys it returns unmodified.',
      { journeyIds: tampered },
    );
  }

  if (accepted.length === 0) {
    res.status(200).json({
      testPlanId: null,
      jobId: null,
      accepted: 0,
      planItemIds: [],
      skipped,
      message: 'Every journey you selected is already covered by a test.',
    });
    return;
  }

  const source = input.source as TrafficFormat;
  const drafts = accepted.map(({ journey }) =>
    journeyToPlanItem(journey, {
      totalSessions: input.totalSessions,
      source,
      ...(input.testType ? { testType: input.testType } : {}),
    }),
  );

  const now = new Date();
  const plan = await prisma.testPlan.create({
    data: {
      orgId: actor.orgId,
      projectId,
      // Pinned to the Flow Map we just checked, so the worker generates against
      // the same crawl this endpoint validated against rather than re-picking.
      flowMapId: flowMap.id,
      summary:
        `${drafts.length} test${drafts.length === 1 ? '' : 's'} proposed from production ` +
        `traffic (${source}), ranked by how many of ${input.totalSessions} real sessions walk ` +
        'each journey. Traffic was redacted on ingest; no request content was stored.',
      skipped: skipped as unknown as object,
      items: {
        create: drafts.map((draft) => ({
          orgId: actor.orgId,
          title: draft.title,
          rationale: draft.rationale,
          feature: draft.feature,
          priority: draft.priority,
          testType: draft.testType,
          steps: draft.steps as unknown as object,
          assertions: draft.assertions as unknown as object,
          journeyId: draft.journeyId,
          // Selecting a journey IS the approval — the user picked it off a
          // ranked list. Leaving it PROPOSED would demand a second approval of
          // the same decision on a screen built for the Explorer's plans.
          state: 'APPROVED' as const,
          decidedBy: actor.userId,
          decidedAt: now,
        })),
      },
    },
    select: { id: true, items: { select: { id: true, title: true, journeyId: true } } },
  });

  /*
   * Generation needs a model. Missing one is a MISSING TOOL, not a failure —
   * the same call the coverage-gap route makes, and for the same reason: the
   * ranking, the redaction and the plan items are already done and already
   * worth having.
   *
   * Queueing anyway is worse than not queueing. The job dies in the worker with
   * "ANTHROPIC_API_KEY is not set", and the only thing the person ever saw was
   * a green "queued for generation" — a promise the deployment could not keep,
   * broken somewhere they are not looking. So: keep the plan, skip the queue,
   * and say so in the response.
   */
  const canGenerate = Boolean(env.ANTHROPIC_API_KEY);
  const jobId = canGenerate
    ? await enqueue(
        QUEUE_NAMES.generate,
        {
          orgId: actor.orgId,
          projectId,
          testPlanId: plan.id,
          planItemIds: plan.items.map((item) => item.id),
          requestedBy: actor.userId,
        },
        // Not idempotent: the processor inserts Test rows. One attempt only, so a
        // transient failure reports honestly instead of duplicating the suite.
        { attempts: 1 },
      )
    : null;

  await audit({
    actor,
    action: 'traffic.propose',
    targetType: 'TestPlan',
    targetId: plan.id,
    metadata: {
      source,
      accepted: plan.items.length,
      skippedAsCovered: skipped.length,
      totalSessions: input.totalSessions,
      queued: canGenerate,
      ...(canGenerate ? {} : { reason: 'no ANTHROPIC_API_KEY' }),
    },
  });

  res.status(202).json({
    jobId,
    testPlanId: plan.id,
    accepted: plan.items.length,
    planItemIds: plan.items.map((item) => item.id),
    items: plan.items,
    skipped,
    generation: canGenerate
      ? { queued: true }
      : {
          queued: false,
          reason:
            'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run. ' +
            'The plan items above are complete and were written from your traffic, not by a ' +
            'model — set the key and approve the plan to turn them into code.',
        },
  });
});
