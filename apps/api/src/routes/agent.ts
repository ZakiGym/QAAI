/**
 * Agent-facing routes (§3): kick off exploration, read the proposed plan,
 * approve items into generated tests, review verdicts, act on heals, chat.
 *
 * These endpoints only ever enqueue work and read results. The agents
 * themselves run in the worker, where a long crawl or a slow generation cannot
 * hold an HTTP connection open.
 */

import { Router } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import {
  AUTH_PROFILE_KINDS,
  FIXTURE_PREFIX,
  QUEUE_NAMES,
  RE_ENUMERATION_TRIGGER_KINDS,
  SURFACE_DIMENSION_KINDS,
  approvePlanSchema,
  driftCountsAreMeaningful,
  newSurfaceWithoutTests,
  triggerHasRun,
} from '@qaai/shared';
import type {
  EnvironmentKind,
  FlowMap,
  ReEnumerationRunState,
  SurfaceDimensionKind,
  TestType,
} from '@qaai/shared';
import {
  AUTH_PROFILE_CAPABILITIES,
  AUTH_PROFILE_KIND_LABELS,
  ROLE_CRAWL_FAULT,
  authAdapterUnavailable,
  authProfileKindRefusedOn,
  botProtectionSchema,
  environmentExtraHeadersSchema,
  isRouteAccessMeasured,
  reachabilityFromPolicy,
  roleHadNoExtraSurface,
} from '@qaai/shared';
/*
 * The self-measurement vocabulary. `MINIMUM_BACKTEST_DEFECTS` is reported
 * rather than implied — a threshold a reader cannot see is a threshold they
 * cannot argue with — and `VALIDITY_VERDICT_LABELS` is imported so the sentence
 * on this endpoint and the sentence on the stored row cannot diverge.
 */
import { MINIMUM_BACKTEST_DEFECTS, VALIDITY_VERDICT_LABELS } from '@qaai/shared';
import type { ValidityVerdict } from '@qaai/shared';
/*
 * THE RATES, every one of them a pure function over rows these handlers read.
 *
 * Imported rather than inlined so that there is exactly ONE implementation of
 * each with its own test. A handler that divided here would be a second answer
 * to the same question served from the same product, which is how two screens
 * come to disagree about how accurate we are.
 */
import {
  generationSurvival,
  loadLatestValidityBacktest,
  triageAccuracy,
  yieldTelemetry,
  type GeneratedTestRow,
} from '../lib/accuracy.js';
import { loginCapabilities } from '@qaai/runner';
import {
  applyHealDiff,
  auditTestsAgainstCrawl,
  canScaffoldWithoutModel,
  driftCheck,
  healKindOf,
  planSupersede,
  postCheckCode,
  verificationRunTag,
  HEAL_VERIFY_STATES,
  SCENARIO_KIND_LIST,
  SCENARIO_KIND_RISK,
  type ScenarioKind,
} from '@qaai/agent';
import type { OpenHeal, PostCheck } from '@qaai/agent';
/*
 * The one import still reached by path, and a narrower reason than before:
 * `obsolete.js` is in the package barrel now, but `suite-health.js` is not
 * exported from it. This is TYPE-ONLY, so it is erased at build time and
 * reaches no runtime code across the workspace boundary.
 */
import type { SuiteHealthTestInput } from '../../../../packages/agent/src/suite-health.js';
import { effectivePlan, startRun } from '../lib/start-run.js';
import {
  budgetForEnvironment,
  dimensionsForProject,
  observationForEnvironment,
  resumePointForEnvironment,
} from '../lib/crawl-store.js';
import { prisma, unscoped } from '../lib/prisma.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound, unauthorized, unprocessable } from '../lib/errors.js';
import { webhookSignatureMatches } from '../lib/github-app.js';
import { logger } from '../lib/logger.js';
import { open as openSecret } from '../lib/vault.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const agentRouter: Router = Router();

/**
 * One re-enumeration trigger, as a client may send it.
 *
 * Declared HERE and not in packages/shared/src/schemas.ts, which is where
 * `approvePlanSchema` and its neighbours live and where this belongs — that
 * file is owned by another change this round. Same shape of borrowing as
 * `ANALYZE_SOURCE_QUEUE` in apps/worker/src/queues.ts, and the same handover:
 * move it beside the other request schemas so the cockpit can validate a
 * trigger form against the same shape the route parses.
 */
const reEnumerationTriggerSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(RE_ENUMERATION_TRIGGER_KINDS),
  enabled: z.boolean().default(true),
  /** SCHEDULE only. Validated against the real parser by the route. */
  cron: z.string().min(1).max(200).optional(),
  timezone: z.string().min(1).max(100).optional(),
  /** DEPLOY only. A `Secret.name` REFERENCE — never a value. */
  webhookSecretName: z.string().min(1).max(200).optional(),
});

// ─── Re-enumeration, drift, and the authorization axis ───────────────────────

/**
 * THE DEFECT THIS SECTION CLOSES.
 *
 * Four tables landed in this round with a worker that writes them and no
 * request path that could reach them:
 *
 *   ReEnumerationTrigger  only SCHEDULE could fire. A CI step and a deploy
 *                         webhook had nowhere to POST, so a CI or DEPLOY
 *                         trigger sat at NEVER_RUN forever — and there was no
 *                         endpoint to CREATE a trigger with either, so on a
 *                         real install the nightly sweep correctly found
 *                         nothing and reported nothing.
 *   SurfaceDriftRecord    computed, stored, auditable, and on no screen.
 *   RouteAccessCell       the route x role matrix, visible only inside one
 *   RoleCrawlAttempt      run-finished event payload.
 *   EnvironmentAccess     nothing read or wrote it at all, so an application
 *                         behind reCAPTCHA or a WAF had no way to tell us how
 *                         to get in and no way to be told why its coverage was
 *                         zero.
 *
 * "A trigger that exists in the schema and cannot be fired from any request
 * path" is this codebase's signature defect, and every read below is written so
 * an EMPTY table reports as "nobody has looked" rather than as a clean result.
 */

/**
 * How many access cells one read returns, and the ceiling is disclosed.
 *
 * routes x roles is multiplicative: 412 routes and 5 roles is ~2,000 rows, and
 * a large environment with declared roles can be several times that. One row
 * past the limit is fetched so the response can say "at least N more existed"
 * instead of presenting a truncated matrix as the whole one — the same shape
 * `FlowMap.truncatedReason`/`atLeastMoreUrls` and `RoleCrawlAttempt.cappedBy`/
 * `atLeastMoreRoutes` use, because it is the same obligation.
 */
export const ACCESS_CELL_LIMIT = 2_000;

/** Drift records per read. The feed is "most recent first", not a full history. */
export const SURFACE_DRIFT_LIMIT = 50;

/**
 * How long an inbound deploy-webhook signature is accepted for.
 *
 * Five minutes. Long enough for a CI runner with a slow clock, short enough
 * that a captured request is not a standing key. Replay INSIDE the window is
 * bounded by the trigger claim below rather than by this: a second delivery of
 * the same signed request finds `lastRunState` already RUNNING and is refused
 * with `another caller claimed this trigger first`, so the worst a replay
 * achieves is one crawl the customer's own deploy asked for anyway.
 */
export const RE_ENUMERATION_WEBHOOK_SKEW_MS = 5 * 60_000;

/**
 * The exact bytes a deploy webhook's signature is computed over.
 *
 * ── WHY THE BODY IS NOT IN IT, AND WHY THAT IS SAFE HERE ────────────────────
 *
 * An HMAC must cover the exact bytes the sender hashed, and `express.raw()` is
 * mounted only under `/webhooks` (see apps/api/src/index.ts) — this router is
 * mounted at `/`, so by the time a handler here runs the body has been parsed
 * and the original bytes are gone. Re-serialising the parsed object and hashing
 * THAT is the tempting move and it is a forgery waiting to happen: key order,
 * number formatting and unicode escaping all differ, so the check would either
 * fail on honest callers or be loosened until it passed.
 *
 * So this route takes NO BODY. Everything that decides what happens is in the
 * path and the headers, and all of it is signed: the project, the environment,
 * the trigger name and the timestamp. There is no unsigned input, which is a
 * stronger property than "the body was signed too" and is the reason the
 * endpoint is shaped this way rather than the shape being a compromise.
 */
export function reEnumerationWebhookMessage(input: {
  projectId: string;
  environmentId: string;
  triggerName: string;
  timestamp: string;
}): string {
  return [
    'qaai.re-enumerate.v1',
    input.projectId,
    input.environmentId,
    input.triggerName,
    input.timestamp,
  ].join('\n');
}

/**
 * Claim a trigger and ask for a crawl — the API's half of
 * `fireReEnumeration` in apps/worker/src/processors/schedule.ts.
 *
 * ── WHY THIS IS A SECOND COPY AND NOT AN IMPORT ─────────────────────────────
 *
 * `fireReEnumeration` is exported and takes its producer as an argument
 * precisely so every caller claims identically. It still cannot be imported
 * here: `processors/schedule.ts` imports `../context.js` and `../queues.js`,
 * both of which run at module load — the worker's own Prisma client, and ten
 * `new Queue(...)` handles on the worker's Redis connection. Importing it into
 * an Express route would stand all of that up inside the API process. The
 * house precedent for exactly this is in apps/worker/src/queues.ts, which
 * states that `apps/api/src/lib/plan.ts` and `vault.ts` are DUPLICATED into the
 * worker "precisely because they are not" pure modules. Same call, other
 * direction.
 *
 * What makes the duplication safe is that the race is arbitrated by POSTGRES,
 * not by sharing a function: the `where` clause below pins `lastRunAt` and
 * `lastRunState` to the row as it was read, so two callers that saw the same
 * row produce exactly one crawl however many processes they live in. The
 * extraction that would remove the copy is named in this round's handover.
 *
 * ── NO jobId, DELIBERATELY ──────────────────────────────────────────────────
 *
 * `POST /explore` above enqueues with no job id either, and here it matters
 * more: this API's `enqueue` retains completed jobs for 24 hours, and BullMQ
 * SILENTLY DROPS an `add` whose job id matches a retained job — measured, see
 * the note on `enqueueExplore` in apps/worker/src/queues.ts. A per-project job
 * id here would make a CI trigger fire once a day at most while reporting
 * success every time. The trigger claim IS the lock, and it is a better one: it
 * is per trigger, it is in the same database as the row that records the
 * outcome, and it cannot be swallowed.
 */
async function claimTriggerAndCrawl(
  trigger: {
    id: string;
    orgId: string;
    projectId: string;
    environmentId: string;
    lastRunAt: Date | null;
    lastRunState: ReEnumerationRunState;
  },
  now: Date,
): Promise<{ fired: true } | { fired: false; why: string }> {
  /*
   * CAPTURED BEFORE THE CLAIM, because these two values are what the release
   * path below restores. Reading them off `trigger` afterwards works only as
   * long as nothing aliases the row the claim just wrote, and a release that
   * "restores" RUNNING leaves the trigger stuck forever — which then reports as
   * a crawl that failed, which reads as a fact about the customer's
   * application. Two locals cost nothing and make the rollback independent of
   * where the caller's object came from.
   */
  const previousState = trigger.lastRunState;
  const previousRunAt = trigger.lastRunAt;

  const claimed = await prisma.reEnumerationTrigger.updateMany({
    where: { id: trigger.id, lastRunAt: previousRunAt, lastRunState: { not: 'RUNNING' } },
    data: { lastRunState: 'RUNNING', lastRunAt: now },
  });
  if (claimed.count === 0) return { fired: false, why: 'another caller claimed this trigger first' };

  try {
    await enqueue(
      QUEUE_NAMES.explore,
      {
        orgId: trigger.orgId,
        projectId: trigger.projectId,
        environmentId: trigger.environmentId,
        requestedBy: `re-enumeration:${trigger.id}`,
        /*
         * ZERO IS NOT A PLACEHOLDER. The explore processor reads a non-positive
         * budget as "no caller override" and lets `Environment.crawlPolicy`
         * decide, clamped by the plan. A re-enumeration's whole job is to
         * refresh the denominator at the width the customer configured; a
         * hard-coded 60 here would re-enumerate a 412-route application as 60
         * routes and call the difference drift.
         */
        maxPages: 0,
        maxDepth: 0,
        /* An unattended crawl that also approved tests is an autopilot nobody asked for. */
        autoApprove: false,
      },
      { attempts: 1 },
    );
    return { fired: true };
  } catch {
    /*
     * RELEASE the claim. A trigger left RUNNING against a crawl that was never
     * queued waits out the worker's run timeout and is then recorded FAILED —
     * which reads as a fact about the customer's application. A queue that
     * would not take the job is a fact about US.
     */
    await prisma.reEnumerationTrigger
      .updateMany({
        where: { id: trigger.id, lastRunState: 'RUNNING' },
        data: { lastRunState: previousState, lastRunAt: previousRunAt },
      })
      .catch(() => {});
    return { fired: false, why: 'the crawl could not be queued' };
  }
}

/**
 * Fire a deploy trigger from the customer's own CD pipeline.
 *
 * REGISTERED BEFORE `agentRouter.use(requireAuth)` — a deploy hook carries no
 * session cookie, and its authentication is the signature over
 * {@link reEnumerationWebhookMessage}, checked against the `Secret` row the
 * trigger NAMES. A name and never a value, and deliberately not an environment
 * variable: one env var would arm one answer for every environment in the
 * install at once.
 *
 * Nothing is logged from here but the trigger id and the outcome. Not the
 * signature, not the secret, not the header.
 */
agentRouter.post(
  '/projects/:projectId/environments/:environmentId/re-enumerate/webhook',
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    const triggerName = String(req.header('x-qaai-trigger') ?? '').trim();
    const timestamp = String(req.header('x-qaai-timestamp') ?? '').trim();
    const signature = req.header('x-qaai-signature');
    if (!triggerName || !timestamp) {
      throw badRequest('x-qaai-trigger and x-qaai-timestamp are required');
    }

    const sentAt = Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : null;
    if (sentAt === null) throw badRequest('x-qaai-timestamp must be an ISO-8601 instant');
    const now = new Date();
    if (Math.abs(now.getTime() - sentAt) > RE_ENUMERATION_WEBHOOK_SKEW_MS) {
      // Not 401: the caller is probably right and their clock is wrong, and a
      // skew error that reads as a bad secret sends them to the wrong fix.
      throw badRequest(
        `This request is signed for ${timestamp}, which is more than ` +
          `${RE_ENUMERATION_WEBHOOK_SKEW_MS / 60_000} minutes from now. Check the clock on the ` +
          'machine that sent it.',
      );
    }

    /*
     * Unscoped, like POST /webhooks/github: the caller has no session, so there
     * is no tenant scope to read the row under. Ownership is then re-checked
     * against the path, and nothing is acted on before the signature verifies.
     */
    const trigger = await unscoped(() =>
      prisma.reEnumerationTrigger.findUnique({
        where: { environmentId_name: { environmentId, name: triggerName } },
        select: {
          id: true,
          orgId: true,
          projectId: true,
          environmentId: true,
          kind: true,
          enabled: true,
          webhookSecretName: true,
          lastRunAt: true,
          lastRunState: true,
        },
      }),
    );
    if (!trigger || trigger.projectId !== projectId) throw notFound('Re-enumeration trigger');
    if (trigger.kind !== 'DEPLOY') {
      throw unprocessable(
        `"${triggerName}" is a ${trigger.kind} trigger. Only a DEPLOY trigger is fired by this webhook.`,
      );
    }
    if (!trigger.webhookSecretName) {
      throw unprocessable(
        `"${triggerName}" has no webhook secret, so an inbound request cannot be authenticated. ` +
          "Store the shared secret in this environment's vault and name it on the trigger.",
      );
    }

    const secretRow = await unscoped(() =>
      prisma.secret.findUnique({
        where: { environmentId_name: { environmentId, name: trigger.webhookSecretName as string } },
        select: { name: true, valueEnc: true, keyVersion: true },
      }),
    );
    let secret: string | null = null;
    if (secretRow) {
      try {
        secret = openSecret(secretRow.valueEnc, secretRow.keyVersion, trigger.orgId, secretRow.name);
      } catch {
        /* sealed under a retired key: unavailable, and treated as absent below */
      }
    }
    if (!secret) {
      throw unprocessable(
        `The vault entry "${trigger.webhookSecretName}" named by "${triggerName}" is not readable ` +
          'on this environment, so the request could not be authenticated.',
      );
    }

    const message = reEnumerationWebhookMessage({
      projectId,
      environmentId,
      triggerName,
      timestamp,
    });
    if (!webhookSignatureMatches(Buffer.from(message, 'utf8'), signature, secret)) {
      // Refuse rather than accept an unverified write, exactly as the GitHub
      // App webhook does. No detail: a signature error that explains itself is
      // an oracle.
      throw unauthorized('Bad webhook signature');
    }
    if (!trigger.enabled) {
      res.json({ fired: false, why: 'the trigger is disabled' });
      return;
    }

    const outcome = await claimTriggerAndCrawl(trigger, now);
    logger.info(
      { triggerId: trigger.id, projectId, fired: outcome.fired },
      're-enumeration deploy webhook',
    );
    res.status(outcome.fired ? 202 : 200).json(outcome);
  },
);

agentRouter.use(requireAuth);

// ─── Explorer ────────────────────────────────────────────────────────────────

agentRouter.post('/projects/:projectId/explore', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const { projectId } = req.params;
  const environmentId = String(req.body?.environmentId ?? '');
  if (!environmentId) throw badRequest('environmentId is required');

  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true, projectId: true, baseUrl: true },
  });
  if (!environment || environment.projectId !== projectId) throw notFound('Environment');

  /*
   * ── THE CRAWL BUDGET, AND THE TWO NUMBERS THAT ARE GONE ────────────────────
   *
   * This line used to read `Math.min(60, Number(req.body?.maxPages ?? 25))` and
   * `Math.min(6, Number(req.body?.maxDepth ?? 3))`. Three web callers send 25
   * and 3; nothing sent anything else; so every crawl of every application ever
   * made by this product enumerated at most 25 states to a depth of 3, and the
   * coverage percentage it produced was a percentage of that. A 412-route
   * application reported "100% covered" over 25 of them. The cap was not a
   * safety decision — safety is about what the crawl DOES, which the policy's
   * `safeMethodsOnly`, `allowDestructive` and `excludeGlobs` govern — it was a
   * "make the demo finish" decision that became the denominator.
   *
   * So the numbers are now OPTIONAL and UNCLAMPED here. Zero means "no
   * override": the environment's own `Environment.crawlPolicy` decides, clamped
   * by the org's plan ceiling, and `resolveCrawlBudget` reports every clamp
   * with both numbers. An explicit request value is still honoured — that is
   * the behaviour the three web callers have today — but it arrives as a POLICY
   * OVERRIDE that the response names, instead of a constant nobody chose.
   *
   * `Number(undefined)` is NaN, which is neither `> 0` nor a usable budget, so
   * an absent field and a garbage field both mean "no override" rather than
   * silently becoming a cap. A negative or zero value means the same thing: a
   * crawl that may visit no pages is not a budget anybody could have meant.
   */
  const askedPages = Number(req.body?.maxPages);
  const askedDepth = Number(req.body?.maxDepth);
  const maxPages = Number.isFinite(askedPages) && askedPages > 0 ? Math.floor(askedPages) : 0;
  const maxDepth = Number.isFinite(askedDepth) && askedDepth > 0 ? Math.floor(askedDepth) : 0;

  const { effective } = effectivePlan(
    await unscoped(() =>
      prisma.subscription.findUnique({
        where: { orgId: actor.orgId },
        select: { plan: true, status: true },
      }),
    ),
    (
      await unscoped(() =>
        prisma.organization.findUnique({ where: { id: actor.orgId }, select: { plan: true } }),
      )
    )?.plan ?? null,
  );

  const [budget, resume] = await Promise.all([
    budgetForEnvironment({
      environmentId,
      plan: effective,
      overrides: { maxPages, maxDepth },
    }),
    resumePointForEnvironment({ projectId, environmentId }),
  ]);

  const jobId = await enqueue(
    QUEUE_NAMES.explore,
    {
      orgId: actor.orgId,
      projectId,
      environmentId,
      requestedBy: actor.userId,
      maxPages,
      maxDepth,
      autoApprove: req.body?.autoApprove === true,
    },
    // One attempt. A crawl is expensive and NOT idempotent — it writes a new
    // FlowMap version every run — so the default 3 retries silently re-crawled
    // the customer's site three times whenever the plan step failed.
    { attempts: 1 },
  );

  await audit({
    actor,
    action: 'explorer.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { environmentId, baseUrl: environment.baseUrl },
  });

  /*
   * THE APPLIED BUDGET, IN THE RESPONSE. Not decoration: these are the numbers
   * that decide what the resulting percentage is a percentage OF, and the only
   * moment a person is looking at this decision is the moment they ask for the
   * crawl. `resume` is the other half — an application over the cap can only
   * ever be fully enumerated by continuing, so whether this run continues the
   * last one is a fact the requester should see rather than infer.
   */
  res.status(202).json({ jobId, status: 'queued', budget, resume });
});

/**
 * The dimensions a multi-axis denominator is counted over.
 *
 * The READ PATH for the `SurfaceDimension` rows the Explorer writes. Without
 * one the table is a write-only pile: `check:wiring` flags exactly that, and it
 * is right to — a dimension nothing can surface cannot be reviewed, and an
 * unreviewable denominator is the thing this whole slice is about.
 */
agentRouter.get('/projects/:projectId/dimensions', async (req, res) => {
  const projectId = String(req.params.projectId);
  // `req.query.kind` can be an array or an object when a caller repeats or
  // nests the parameter, and `String()` on either produces garbage that then
  // fails the vocabulary check with an unreadable message. Only a plain string
  // is a candidate; anything else is "not one of the kinds", which is what the
  // guard below already says.
  const rawKind = req.query.kind;
  const kind = typeof rawKind === 'string' ? rawKind : undefined;
  if (rawKind !== undefined && kind === undefined) {
    throw badRequest(`kind must be one of ${SURFACE_DIMENSION_KINDS.join(', ')}`);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');
  if (kind !== undefined && !(SURFACE_DIMENSION_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(`kind must be one of ${SURFACE_DIMENSION_KINDS.join(', ')}`);
  }

  const dimensions = await dimensionsForProject(
    projectId,
    kind === undefined ? undefined : (kind as SurfaceDimensionKind),
  );
  res.json({ dimensions });
});

/**
 * What the last crawl of an environment OBSERVED.
 *
 * The READ PATH for the observation report. The crawl records the endpoints the
 * UI called, the routes it was bounced to, the runtime errors it logged, the
 * export surfaces it found and the error paths it probed — and before this
 * endpoint existed every one of those was computed during the crawl and
 * discarded when the function returned, which is a feature indistinguishable
 * from one that was never built.
 *
 * `null` is a real answer and the response says which: a flow map written
 * before this slice carries no observation, and that must never be rendered as
 * "the application made no calls".
 */
agentRouter.get(
  '/projects/:projectId/environments/:environmentId/observation',
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);

    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { id: true, projectId: true },
    });
    if (!environment || environment.projectId !== projectId) throw notFound('Environment');

    const declared = await prisma.coverageItem.findMany({
      where: { projectId, kind: 'ENDPOINT', retiredAt: null },
      select: { key: true },
    });
    const found = await observationForEnvironment({
      projectId,
      environmentId,
      declaredKeys: declared.map((row) => row.key),
    });

    if (found === null) {
      res.json({
        observation: null,
        why: 'the newest flow map for this environment recorded no observation — re-crawl to collect one. This is NOT a statement that the application made no calls.',
      });
      return;
    }
    res.json({ flowMapVersion: found.version, observation: found.observation, why: null });
  },
);

/**
 * Live crawl progress. The Explorer publishes under a synthetic run id because
 * a crawl is not a run and has no Run row to hang events off — reusing the
 * /runs events route would 404 on the missing run.
 */
agentRouter.get('/projects/:projectId/explore/events', async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const unsubscribe = subscribe(actor.orgId, `explore:${projectId}`, res);
  req.on('close', unsubscribe);
});

/** The most recent plan, with its items — what the approval screen renders. */
agentRouter.get('/projects/:projectId/plan', async (req, res) => {
  const plan = await prisma.testPlan.findFirst({
    where: { projectId: String(req.params.projectId) },
    orderBy: { createdAt: 'desc' },
    include: { items: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] } },
  });
  if (!plan) throw notFound('Test plan');
  res.json({ plan });
});

agentRouter.post('/plans/:planId/approve', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = approvePlanSchema.parse(req.body);

  const plan = await prisma.testPlan.findUnique({
    where: { id: String(req.params.planId) },
    include: { items: { select: { id: true, state: true, testType: true } } },
  });
  if (!plan) throw notFound('Test plan');

  const known = new Set(plan.items.map((i) => i.id));
  const unknown = input.approvedItemIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw badRequest('Some approved ids do not belong to this plan', { unknown });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.planItem.updateMany({
      where: { id: { in: input.approvedItemIds } },
      data: { state: 'APPROVED', decidedBy: actor.userId, decidedAt: now },
    }),
    // Everything not ticked is explicitly rejected rather than left PROPOSED,
    // so a re-opened plan does not silently re-offer declined items.
    prisma.planItem.updateMany({
      where: { testPlanId: plan.id, id: { notIn: input.approvedItemIds }, state: 'PROPOSED' },
      data: { state: 'REJECTED', decidedBy: actor.userId, decidedAt: now },
    }),
  ]);

  for (const [itemId, edit] of Object.entries(input.edits)) {
    if (!known.has(itemId)) continue;
    await prisma.planItem.update({
      where: { id: itemId },
      data: {
        ...(edit.title ? { title: edit.title } : {}),
        ...(edit.priority ? { priority: edit.priority } : {}),
      },
    });
  }

  /*
   * Test CODE needs a model, but the spec-driven types do not — the Generator
   * scaffolds those deterministically from the crawl (@qaai/agent's
   * spec-strategies), each carrying review flags naming its TODO fields. So a
   * missing key narrows the queue to the scaffoldable subset instead of
   * refusing outright; only when NOTHING in the batch can be scaffolded does
   * this fall back to the old "approved, not queued, here is what to set".
   *
   * The history that shaped this: the endpoint used to answer 202 with no key,
   * the cockpit read that as success, and the job died in the worker with
   * nothing anywhere to say why. `generation.reason` is always present when a
   * key is missing so the person is told exactly which half happened.
   */
  const canGenerate = Boolean(env.ANTHROPIC_API_KEY);
  const typeOf = new Map(plan.items.map((i) => [i.id, i.testType]));
  const queueableIds = canGenerate
    ? input.approvedItemIds
    : input.approvedItemIds.filter((id) => canScaffoldWithoutModel(typeOf.get(id) as TestType));
  const jobId =
    queueableIds.length > 0
      ? await enqueue(QUEUE_NAMES.generate, {
          orgId: actor.orgId,
          projectId: plan.projectId,
          testPlanId: plan.id,
          planItemIds: queueableIds,
          requestedBy: actor.userId,
        })
      : null;

  await audit({
    actor,
    action: 'plan.approve',
    targetType: 'TestPlan',
    targetId: plan.id,
    metadata: {
      approved: input.approvedItemIds.length,
      rejected: known.size - input.approvedItemIds.length,
      queued: jobId !== null,
      ...(canGenerate ? {} : { scaffolded: queueableIds.length, reason: 'no ANTHROPIC_API_KEY' }),
    },
  });

  const needModel = input.approvedItemIds.length - queueableIds.length;
  res.status(202).json({
    jobId,
    approved: input.approvedItemIds.length,
    generation: canGenerate
      ? { queued: true }
      : {
          queued: jobId !== null,
          scaffolded: queueableIds.length,
          reason:
            queueableIds.length > 0
              ? `${queueableIds.length} of ${input.approvedItemIds.length} approved item(s) are spec-driven and were scaffolded from the crawl without a model — each carries review flags naming what to fill in. ` +
                (needModel > 0
                  ? `The other ${needModel} need a model: ANTHROPIC_API_KEY is not set on this deployment — set it and approve the plan again.`
                  : `Set ANTHROPIC_API_KEY to have a model write them outright.`)
              : 'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run and no ' +
                'test code was written. Your approval was saved — these items are APPROVED and will ' +
                'generate as soon as the key is set and you approve the plan again.',
        },
  });
});

// ─── Verdicts (§3.3) ─────────────────────────────────────────────────────────

agentRouter.get('/verdicts', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const verdicts = await prisma.triageVerdict.findMany({
    where: {
      ...(state ? { reviewState: state as never } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      testResult: {
        select: {
          id: true,
          runId: true,
          status: true,
          test: { select: { id: true, name: true, filePath: true, priority: true } },
        },
      },
    },
  });
  res.json({ verdicts });
});

/**
 * The keyboard-first review action (§8). A human can accept the verdict,
 * override it, or mute it — and the override is what gates, not the model's
 * original call.
 */
agentRouter.post('/verdicts/:verdictId/review', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const action = String(req.body?.action ?? '');
  const overrideTo = req.body?.overrideTo as string | undefined;

  const verdict = await prisma.triageVerdict.findUnique({
    where: { id: String(req.params.verdictId) },
  });
  if (!verdict) throw notFound('Verdict');
  if (verdict.reviewState !== 'PENDING') {
    throw conflict(`This verdict was already reviewed (${verdict.reviewState})`);
  }

  const reviewState =
    action === 'accept'
      ? 'ACCEPTED'
      : action === 'override'
        ? 'OVERRIDDEN'
        : action === 'mute'
          ? 'MUTED'
          : null;
  if (!reviewState) throw badRequest('action must be one of: accept, override, mute');
  if (reviewState === 'OVERRIDDEN' && !overrideTo) {
    throw badRequest('overrideTo is required when overriding a verdict');
  }

  const updated = await prisma.triageVerdict.update({
    where: { id: verdict.id },
    data: {
      reviewState,
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
      overriddenTo: reviewState === 'OVERRIDDEN' ? (overrideTo as never) : null,
    },
  });

  await audit({
    actor,
    action: `verdict.${action}`,
    targetType: 'TriageVerdict',
    targetId: verdict.id,
    metadata: { from: verdict.verdict, to: overrideTo ?? verdict.verdict },
  });

  res.json({ verdict: updated });
});

// ─── Heals (§3.4) ────────────────────────────────────────────────────────────

/**
 * The version-history message for an applied heal.
 *
 * Capped, because this is a database column and three long gate sentences plus
 * a model explanation will overrun any sensible display. The ORDER is the
 * point: what the heal claims to do, then anything nobody could verify, then
 * what the gates found, then which gates ran at all. A reader scanning history
 * after a suite quietly stopped asserting anything needs the last two most, and
 * they are the two that did not exist before.
 */
function healVersionMessage(
  explanation: string,
  unverified: string | undefined,
  check: PostCheck,
): string {
  return [
    `Applied heal: ${explanation.slice(0, 200)}`,
    unverified ? `unverified: ${unverified}` : null,
    ...check.flags,
    check.checks,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ')
    .slice(0, 2_000);
}

/**
 * What is known about whether an applied heal actually worked.
 *
 * `state: null` is the honest encoding of "nothing to say": nobody applied this
 * proposal, so nothing was verified. The field a reader must not be able to
 * misread is `claimsFixed` — true ONLY when a run executed the test after the
 * patch was written and it passed. Everything else, including an applied heal
 * nobody could check, is false, which is the whole point of this feature: a heal
 * recorded APPLIED while still red tells a human the problem is handled.
 */
function verificationOf(heal: {
  state: string;
  verifyState: string | null;
  verifyNote: string | null;
  verifyRunId: string | null;
  verifiedAt: Date | null;
}): {
  state: string | null;
  claimsFixed: boolean;
  note: string | null;
  runId: string | null;
  at: Date | null;
} {
  const applied = heal.state === 'APPLIED' || heal.state === 'AUTO_APPLIED';
  /*
   * `verifyState` is a TEXT column whose domain is enforced at the producer (see
   * the migration), so the read end has to cope with a value it does not know —
   * a row written by a newer deployment, or by hand. An unrecognised value is
   * reported as unrecognised rather than falling through `=== 'VERIFIED'` into
   * "not verified", which would read as a measured failure instead of a value
   * nobody can interpret.
   */
  const known = (HEAL_VERIFY_STATES as readonly string[]).includes(heal.verifyState ?? '');
  return {
    state: heal.verifyState,
    claimsFixed: heal.verifyState === 'VERIFIED',
    note:
      heal.verifyState !== null && !known
        ? `This heal records a verification state QAAI does not recognise ("${heal.verifyState}"), so nothing can be concluded from it. ${heal.verifyNote ?? ''}`.trim()
        : (heal.verifyNote ??
          (applied
            ? 'This heal was applied and no verification was recorded, so nobody has confirmed the test passes.'
            : null)),
    runId: heal.verifyRunId,
    at: heal.verifiedAt,
  };
}

/**
 * Start the run that checks an applied heal, and say what to record about it.
 *
 * ── WHY `advisory` AND NOT `enforce` ────────────────────────────────────────
 *
 * A person has just approved a fix for a red test. Throwing 402 at them because
 * the org is at its monthly run cap would refuse the APPROVAL over the
 * VERIFICATION — the heal would not be applied at all, and the customer would be
 * left with the broken test and a billing error message. So the toll is
 * advisory: the heal applies, and a refused verification is recorded as
 * UNVERIFIABLE with the quota as its stated reason. "Applied, nobody checked,
 * here is why" is a true sentence; "we could not apply your fix because of your
 * plan" is a worse product.
 *
 * ── WHY IT CAN COME BACK UNVERIFIABLE BEFORE IT EVEN RUNS ───────────────────
 *
 * A test that has never run has no environment to re-run it in, and guessing one
 * would be running the customer's test against a URL nobody chose. That is an
 * honest "nobody checked", recorded as such, rather than a silently skipped
 * verification — which is the defect this whole path exists to close.
 */
async function startHealVerification(args: {
  orgId: string;
  healId: string;
  testId: string;
  projectId: string;
}): Promise<{ runId: string | null; state: 'PENDING' | 'UNVERIFIABLE'; note: string }> {
  // The environment the test last ran in — the one a re-run must reproduce.
  // Same rule the flake radar's confirmation runs use.
  const last = await prisma.testResult.findFirst({
    where: { testId: args.testId, orgId: args.orgId },
    orderBy: { createdAt: 'desc' },
    select: { run: { select: { environmentId: true } } },
  });
  const environmentId = last?.run.environmentId;
  if (!environmentId) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: this test has never run, so there is no environment to re-run it in. Run it yourself to find out whether the fix works.',
    };
  }

  const started = await startRun({
    db: prisma,
    orgId: args.orgId,
    mode: 'advisory',
    unscope: unscoped,
    data: {
      orgId: args.orgId,
      projectId: args.projectId,
      environmentId,
      trigger: 'MANUAL',
      triggeredBy: verificationRunTag(args.healId),
      totalCount: 1,
      // One placeholder result: the run processor executes exactly the tests its
      // result rows name, which is how a single-test run is expressed here.
      results: { create: [{ orgId: args.orgId, testId: args.testId, status: 'SKIPPED' as const }] },
    },
  });

  if (!started.created) {
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: `The heal was applied and nobody has checked it: the verifying run could not be started. ${started.quota.reason ?? 'This org is at its monthly run limit.'}`,
    };
  }

  try {
    await enqueue(
      QUEUE_NAMES.run,
      { orgId: args.orgId, runId: started.run.id },
      // Idempotent on run id, like POST /runs: a retried approval cannot
      // double-execute the verification.
      { jobId: `run-${started.run.id}` },
    );
  } catch {
    /*
     * A run row with no job would sit PENDING until the sweep's deadline and
     * then report itself unverifiable for the wrong reason. Mark it dead now and
     * say the true reason.
     */
    await prisma.run
      .update({
        where: { id: started.run.id },
        data: {
          status: 'ERRORED',
          finishedAt: new Date(),
          errorMessage: 'The heal verification run could not be queued.',
        },
      })
      .catch(() => {});
    return {
      runId: null,
      state: 'UNVERIFIABLE',
      note: 'The heal was applied and nobody has checked it: the verifying run could not be queued. Run the test yourself to find out whether the fix works.',
    };
  }

  return {
    runId: started.run.id,
    state: 'PENDING',
    note: `Applied, and now being checked: run ${started.run.id} re-runs this test on its own. Until it lands, nobody has confirmed the fix works.`,
  };
}

/** Open proposals for one test, in the shape the lifecycle rules want. */
async function openHealsFor(orgId: string, testId: string): Promise<OpenHeal[]> {
  return await prisma.healProposal.findMany({
    where: { orgId, testId, state: { in: ['PROPOSED', 'APPROVED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, state: true, riskLevel: true, diff: true, createdAt: true },
  });
}

/**
 * Heal proposals for the review screen. Defaults to what needs a decision;
 * `?state=all` includes decided ones so the screen can show what happened.
 * The test's current code ships alongside each diff so the client can render a
 * real before/after without a second round-trip per row.
 */
agentRouter.get('/heals', async (req, res) => {
  // `typeof`, not `String(...)`: Express 5 types a query value as string, an
  // array of strings, or an object (`?state[x]=all`), and stringifying the last
  // of those yields "[object Object]" — a comparison that can never match but
  // reads as though it could.
  const all = typeof req.query.state === 'string' && req.query.state === 'all';
  const rows = await prisma.healProposal.findMany({
    where: all ? {} : { state: 'PROPOSED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      // `type` and `spec` are here for the post-check gates: a spec-driven test
      // keeps its assertions in the spec and its `code` is an inert pointer
      // comment, so a gate handed the code alone would report a perfectly good
      // API test as asserting nothing.
      test: {
        select: { id: true, name: true, filePath: true, code: true, type: true, spec: true },
      },
    },
  });

  /**
   * The patched result is computed here, with the same applier approval uses, so
   * the reviewer sees the real before/after and is told up front when a proposal
   * has gone stale — rather than finding out by clicking Approve.
   *
   * And then the SAME gates a generated test passes through are run over the
   * patched file, because a heal writes code into the customer's repository
   * exactly as the Generator does. `await Promise.all` rather than the plain
   * `.map` this used to be: the gates are async. They are also cheap — the one
   * live toolchain gate is an in-process TypeScript parse (single-digit
   * milliseconds), and the rest are pure string analysis — so a page of 50
   * heals is not materially slower than it was.
   */
  const heals = await Promise.all(
    rows.map(async (heal) => {
      /*
       * A RETIREMENT is not a patch and must never be run through the applier.
       *
       * It carries no diff at all (see the column's own doc comment), so
       * `applyHealDiff` would refuse it for having no diff and the row would
       * render as "this heal is broken" — which is both wrong and the opposite
       * of actionable. Its preview is its EVIDENCE: the routes that are gone,
       * and the caveat saying what accepting it does.
       */
      if (healKindOf(heal.riskLevel) === 'RETIREMENT') {
        return {
          ...heal,
          preview: {
            kind: 'RETIREMENT' as const,
            /*
             * Applicable, and deliberately so: there is nothing that could fail
             * to apply. Accepting it DISABLES the test — the code stays in the
             * repository and in its version history — so the destructive
             * reading of this button is wrong and the note says why.
             */
            applies: true,
            code: null,
            reason: null,
            fuzz: null,
            review:
              'Accepting this disables the test. Its code and history stay in your repository and you can switch it back on. Read the evidence first: a test whose page QAAI could not REACH looks very like a test whose page is GONE, and only the second is worth retiring.',
            flags: [],
            checks:
              'No code check applies: a retirement changes no code. The evidence is the comparison against the newest crawl, recorded on the proposal.',
          },
          verification: verificationOf(heal),
        };
      }

      // The file path is what resolves the assertion dialect, and the dialect is
      // what makes the never-weaken guard bite outside JavaScript. Called without
      // it, the guard falls back to a JS-only count — 0 before and 0 after in a Go
      // or pytest repo, which is a guard that passes everything.
      const applied = applyHealDiff(heal.test.code, heal.diff, { filePath: heal.test.filePath });
      const check =
        applied.ok && applied.code !== undefined
          ? await postCheckCode({
              code: applied.code,
              filePath: heal.test.filePath,
              testType: heal.test.type,
              spec: heal.test.spec,
            })
          : null;

      return {
        ...heal,
        preview: {
          /*
           * `applies` drives the Approve button, so a heal the gates refuse has
           * to read as not-applicable here rather than as applicable-with-a-note.
           * The only gate that refuses is SYNTAX: a patched file that does not
           * parse would replace a test failing with a readable error by a file
           * the runner cannot load, taking its siblings down with it. The decide
           * route re-runs this check and 422s, so a client that ignores the flag
           * still cannot apply it.
           */
          applies: applied.ok && (check === null || check.allowed),
          code: applied.code ?? null,
          reason: (check !== null && !check.allowed ? check.refusal : applied.reason) ?? null,
          fuzz: applied.fuzz ?? null,
          /**
           * Present when the guard could not verify that the heal keeps the
           * assertions — an unreadable file type. It is not a refusal, so the
           * reviewer is the check; dropping it here would be the one case where
           * "this heal applies cleanly" is shown to a human with no mention that
           * nothing checked whether it still asserts anything.
           */
          review: applied.review ?? null,
          /**
           * What the gates found in the patched file: a fixed sleep, a brittle
           * locator, a QAAI import, a test that now asserts nothing. These are
           * flags and not refusals because a heal fixes a test that is currently
           * red — and this reviewer is the human the flag is addressed to.
           */
          flags: check?.flags ?? [],
          /**
           * …and which checks ran, so the screen can never imply a check that
           * did not happen. This path has no repository checkout, so typecheck,
           * formatting and lint are among the ones that did not.
           */
          checks: check?.checks ?? null,
          kind: 'PATCH' as const,
        },
        verification: verificationOf(heal),
      };
    }),
  );

  res.json({ heals });
});

agentRouter.post('/heals/:healId/decide', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const approve = req.body?.approve === true;

  const heal = await prisma.healProposal.findUnique({
    where: { id: String(req.params.healId) },
    // `type` and `spec` for the post-check gates; see the list route above.
    // `name` and `projectId` for the retirement record and the verifying run.
    include: {
      test: {
        select: {
          id: true,
          name: true,
          code: true,
          filePath: true,
          type: true,
          spec: true,
          projectId: true,
        },
      },
    },
  });
  if (!heal) throw notFound('Heal proposal');
  if (heal.state !== 'PROPOSED') throw conflict(`This heal was already ${heal.state}`);

  if (!approve) {
    const rejected = await prisma.healProposal.update({
      where: { id: heal.id },
      data: { state: 'REJECTED', decidedBy: actor.userId, decidedAt: new Date() },
    });
    await audit({ actor, action: 'heal.reject', targetType: 'HealProposal', targetId: heal.id });
    res.json({ heal: rejected });
    return;
  }

  /*
   * ── Accepting a RETIREMENT ─────────────────────────────────────────────────
   *
   * It applies by DISABLING the test, never by deleting it. `disabledAt` stops
   * the test running and stops it gating; the code and every version of it stay
   * in the repository, and the owner can switch it back on. The reversible
   * operation is the one offered, because the mistake this feature can make —
   * retiring a test whose page QAAI merely could not reach — is otherwise
   * unrecoverable, and `obsolete.ts` works hard to make that mistake rare
   * rather than impossible.
   *
   * No diff is applied and no post-check runs: there is no code change to check.
   * `verifyState` stays NULL — there is nothing to re-run, and claiming a
   * verification here would be the same lie this work exists to remove — while
   * `verifyNote` says so in words, because the screen reads that field.
   */
  if (healKindOf(heal.riskLevel) === 'RETIREMENT') {
    const now = new Date();
    const openPatches = (await openHealsFor(heal.orgId, heal.testId)).filter(
      (open) => open.id !== heal.id,
    );

    const [, retired] = await prisma.$transaction([
      prisma.test.update({ where: { id: heal.testId }, data: { disabledAt: now } }),
      prisma.healProposal.update({
        where: { id: heal.id },
        data: {
          state: 'APPLIED',
          decidedBy: actor.userId,
          decidedAt: now,
          verifyNote:
            'A retirement changes no code, so there is nothing to re-run and nothing was verified. The test is disabled: it stops running and stops gating from now on, and its code and history are untouched.',
        },
      }),
      /*
       * Every other open proposal for this test is closed with it.
       *
       * `planSupersede` deliberately refuses to supersede ACROSS kinds when a
       * proposal is MADE — a reviewer looking at both a retirement and a patch
       * is facing a real choice. Applying the retirement is that choice being
       * made: the test no longer runs, so a patch for it is moot, and leaving
       * the row open would leave an Approve button that silently re-enables
       * nothing. If the test is switched back on, triage proposes afresh.
       */
      prisma.healProposal.updateMany({
        where: { id: { in: openPatches.map((open) => open.id) } },
        data: { state: 'SUPERSEDED', supersededById: heal.id, decidedAt: now },
      }),
    ]);

    await audit({
      actor,
      action: 'heal.retire',
      targetType: 'HealProposal',
      targetId: heal.id,
      metadata: {
        testId: heal.testId,
        testName: heal.test.name,
        confidence: heal.confidence,
        supersededPatches: openPatches.map((open) => open.id),
        evidence: heal.evidence,
      },
    });

    res.json({
      heal: retired,
      note:
        `"${heal.test.name}" is disabled: it stops running and stops gating. Its code and history ` +
        `are untouched — un-disable it from the test page if this was wrong.` +
        (openPatches.length > 0
          ? ` ${openPatches.length} open fix proposal(s) for the same test were closed with it.`
          : ''),
    });
    return;
  }

  /**
   * Approving applies the diff to the test and records a version, so the fix is
   * real the moment a human accepts it. The test lives in the database, so this
   * is the working copy — Source control then pushes it like any other change.
   *
   * A patch that no longer applies (the test was edited after the proposal) is
   * refused with a 422 rather than force-fitted; the proposal stays PROPOSED so
   * it can be re-run.
   */
  // With the path, so the never-weaken guard runs in the test's own dialect
  // rather than a JavaScript one. See the list route above.
  const applied = applyHealDiff(heal.test.code, heal.diff, { filePath: heal.test.filePath });
  if (!applied.ok || !applied.code) {
    throw unprocessable(applied.reason ?? 'The diff could not be applied');
  }

  /*
   * The same gates a generated test passes through, over the patched file.
   *
   * Only one of them refuses: a file that does not parse. A human clicking
   * Approve is a check on whether the FIX is right, not on whether the file
   * loads — nobody reads a diff and notices a missing brace — so this is not a
   * decision to defer to them. Everything else (a fixed sleep, a brittle
   * locator, a QAAI import, a test that now asserts nothing) is recorded and
   * applied, because a heal fixes a test that is currently red and refusing it
   * would leave the customer with a broken test and no proposal.
   */
  const check = await postCheckCode({
    code: applied.code,
    filePath: heal.test.filePath,
    testType: heal.test.type,
    spec: heal.test.spec,
  });
  if (!check.allowed) {
    throw unprocessable(check.refusal ?? 'The patched file did not pass the post-heal checks');
  }

  const latest = await prisma.testVersion.findFirst({
    where: { testId: heal.testId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const appliedVersion = (latest?.version ?? 0) + 1;

  /*
   * Everything else open for this test is superseded by the decision being made
   * here, so the queue does not keep offering alternatives to a fix that is
   * already in the code. Computed BEFORE the transaction and written inside it:
   * the state of the queue and the state of the test move together or not at
   * all. Same-kind only — a retirement proposal is a different question and
   * stays open for its own answer (see `planSupersede`).
   */
  const supersede = planSupersede({
    incomingId: heal.id,
    incomingRiskLevel: heal.riskLevel,
    openHeals: await openHealsFor(heal.orgId, heal.testId),
  });

  const [, updatedHeal] = await prisma.$transaction([
    prisma.test.update({
      where: { id: heal.testId },
      data: {
        code: applied.code,
        /*
         * The Generator's review flags described the code this heal just
         * replaced, so they are stale — but clearing them to `[]` would also
         * erase what the gates just found in the NEW code, and the badge would
         * say "nothing to review" about a test that now contains a fixed sleep.
         * So the row carries the current findings instead of none.
         */
        reviewFlags: check.flags,
        versions: {
          create: {
            orgId: actor.orgId,
            version: (latest?.version ?? 0) + 1,
            code: applied.code,
            source: 'HEALER',
            authorId: actor.userId,
            /**
             * The review note rides along when the guard could not verify the
             * assertion count, and so does the list of checks that ran. A human
             * approved this, so neither is a refusal — but the version history
             * is the only place those facts survive, and "who approved a heal
             * nobody could check" is exactly the question asked after a suite
             * quietly stops asserting anything.
             */
            message: healVersionMessage(heal.explanation, applied.review, check),
          },
        },
      },
    }),
    prisma.healProposal.update({
      where: { id: heal.id },
      data: {
        state: 'APPLIED',
        decidedBy: actor.userId,
        decidedAt: new Date(),
        /*
         * Which version this heal wrote. The revert path in the worker's
         * verification sweep has no other way back: without it, an unattended
         * heal that failed verification could only be undone by guessing which
         * version came before it, and guessing would write a version of the
         * test the heal never replaced.
         */
        appliedVersion,
      },
    }),
    prisma.healProposal.updateMany({
      where: { id: { in: supersede.ids } },
      data: { state: 'SUPERSEDED', supersededById: heal.id, decidedAt: new Date() },
    }),
  ]);

  /*
   * ── The verification, started AFTER the code is written ────────────────────
   *
   * Order is load-bearing: a run queued before the transaction could execute the
   * OLD code and report a failure about a heal that had not been applied yet.
   *
   * It is also outside the transaction, which means a crash between the two
   * leaves `verifyState` NULL rather than PENDING — "nobody checked", which is
   * exactly what would have happened, rather than a row waiting forever on a run
   * that was never created. The sweep only ever chases PENDING.
   */
  const verification = await startHealVerification({
    orgId: heal.orgId,
    healId: heal.id,
    testId: heal.testId,
    projectId: heal.test.projectId,
  });
  await prisma.healProposal.update({
    where: { id: heal.id },
    data: {
      verifyState: verification.state,
      verifyRunId: verification.runId,
      verifyNote: verification.note,
      // Only an outcome stamps this. PENDING is not an outcome.
      verifiedAt: verification.state === 'UNVERIFIABLE' ? new Date() : null,
    },
  });

  await audit({
    actor,
    action: 'heal.apply',
    targetType: 'HealProposal',
    targetId: heal.id,
    metadata: {
      riskLevel: heal.riskLevel,
      testId: heal.testId,
      fuzz: applied.fuzz,
      // Which gates ran and what they found, on the record. An audit row saying
      // only "heal.apply" cannot answer "was this checked".
      checks: check.checks,
      flags: check.flags,
      appliedVersion,
      superseded: supersede.ids,
      // Whether anything is going to check this, on the record next to the
      // apply. "Applied" and "verified" are different claims.
      verification: { state: verification.state, runId: verification.runId },
    },
  });

  res.json({
    heal: { ...updatedHeal, verifyState: verification.state, verifyRunId: verification.runId },
    note: [
      applied.fuzz && applied.fuzz > 0
        ? `Applied, but the patch needed ${applied.fuzz} line(s) of fuzz — worth a glance in the editor.`
        : 'Applied to the test. Push it from Source control when you are ready.',
      // Before the gate prose, because "is this actually fixed" is the first
      // question and used to have no answer at all.
      verification.note,
      ...(supersede.ids.length > 0
        ? [`${supersede.ids.length} other open proposal(s) for this test were superseded.`]
        : []),
      ...check.flags,
      check.checks,
    ].join(' '),
  });
});

// ─── Drift against the newest crawl (§3.1/§3.4) ──────────────────────────────

/**
 * Tests compared per read. Matches `DRIFT_TEST_SCAN_LIMIT` in the worker's
 * sweep, so the screen and the queue judge the same tests.
 */
const DRIFT_TEST_SCAN_LIMIT = 500;

/**
 * Route items read per request — the SOURCE side of a retirement, and the cap
 * that has to be disclosed.
 *
 * The declared-route list is one of the two independent negatives behind an
 * OBSOLETE verdict. Beyond this many route items a route the source genuinely
 * declares does not come back, and a route that IS declared reading as
 * `declared: false` is exactly the evidence a retirement rests on — so past the
 * cap the source side is declared truncated and `obsolete.ts` withholds every
 * proposal, the same way it does for a truncated crawl. Kept equal to
 * `DRIFT_ROUTE_ITEM_SCAN_LIMIT` in the worker's sweep for the same reason the
 * crawl ordering is kept equal: two readers of one table that disagree about
 * the subset disagree about the verdict.
 */
const DRIFT_ROUTE_ITEM_SCAN_LIMIT = 2_000;

/**
 * Which tests the newest crawl says are about to break, and which ones drive a
 * page that is gone.
 *
 * READ-ONLY. The worker's `driftSweep` runs the same analysis once per crawl and
 * is the thing that mints retirement proposals; this endpoint is how a person
 * looks at the answer, including between crawls. The DECISION is shared —
 * `auditTestsAgainstCrawl` and `driftCheck` in packages/agent — so the screen
 * and the queue cannot disagree about a test. What is duplicated is the five
 * queries that load the inputs, and that is deliberate: the two live in
 * different workspaces with different Prisma clients, and the alternative
 * (another cross-workspace loader module) buys less than it costs. If a third
 * caller ever appears, that is the moment to extract it.
 */
agentRouter.get('/projects/:projectId/drift', async (req, res) => {
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  /*
   * `createdAt`, not `version` — the same ordering `driftSweep` uses, and the
   * difference is not cosmetic. `FlowMap.version` is sequenced per (project,
   * ENVIRONMENT) in processors/explore.ts, so a project with two environments
   * has two independent counters: ordering by version picks the crawl from
   * whichever environment has been crawled most often, which on a project whose
   * staging is crawled nightly and whose production is crawled weekly is a
   * months-old staging crawl beating this morning's production one. The worker
   * reads newest-by-createdAt and mints the retirement proposals from it, so
   * this screen has to read the same crawl or the two disagree about a test —
   * which is exactly what sharing `auditTestsAgainstCrawl` is supposed to make
   * impossible.
   */
  const crawl = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, version: true, graph: true, truncatedReason: true, createdAt: true },
  });

  const testRows = await prisma.test.findMany({
    where: { projectId, disabledAt: null },
    orderBy: { createdAt: 'asc' },
    // One over the cap, so the response can say that more exist instead of
    // handing the screen a row count it will render as the whole suite.
    take: DRIFT_TEST_SCAN_LIMIT + 1,
    select: {
      id: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      feature: true,
      tags: true,
      code: true,
      spec: true,
      flakeRate: true,
      quarantined: true,
      consecutiveFailures: true,
    },
  });
  const testsTruncated = testRows.length > DRIFT_TEST_SCAN_LIMIT;
  const tests = testRows.slice(0, DRIFT_TEST_SCAN_LIMIT);

  /*
   * `declaredRoutes` is NULL when no source analysis has run, and null is not an
   * empty list: with nothing having read the code, "the source does not declare
   * this route" is the absence of a detector rather than a fact — and a
   * retirement is never proposed on that basis. See obsolete.ts.
   */
  const sourceItems = await prisma.coverageItem.count({
    where: { projectId, origin: { in: ['SOURCE_ONLY', 'BOTH'] } },
  });
  const routeItemRows = await prisma.coverageItem.findMany({
    where: { projectId, kind: 'ROUTE' },
    // Ordered and read one over the cap, both deliberately. The worker's
    // `driftSweep` reads the same table the same way: without an ORDER BY the
    // two can be handed different subsets and reach different verdicts about
    // the same test, which is exactly what sharing the analysis is supposed to
    // make impossible.
    orderBy: { key: 'asc' },
    take: DRIFT_ROUTE_ITEM_SCAN_LIMIT + 1,
    select: { key: true, origin: true, retiredAt: true },
  });
  const routeItemsTruncated = routeItemRows.length > DRIFT_ROUTE_ITEM_SCAN_LIMIT;
  const routeItems = routeItemRows.slice(0, DRIFT_ROUTE_ITEM_SCAN_LIMIT);
  const routeOf = (key: string): string => key.replace(/^ROUTE:/, '');

  const graph = crawl?.graph as Partial<FlowMap> | null;
  const flowMap: FlowMap | null =
    graph && typeof graph === 'object' && Array.isArray(graph.nodes) && crawl
      ? ({
          ...graph,
          // The row is the authority on these two; a graph written by an older
          // crawler may carry neither, and a missing `truncatedReason` read as
          // "complete" is what would let a truncated crawl retire a test.
          version: crawl.version,
          truncatedReason: crawl.truncatedReason,
        } as FlowMap)
      : null;

  const report = auditTestsAgainstCrawl({
    tests: tests
      // Fixtures are test data, not tests — they never run and never gate, and
      // `driftSweep` refuses to judge them. Judged here and not there, the
      // screen would show a verdict for a file the queue will never act on.
      .filter((test) => !test.filePath.startsWith(FIXTURE_PREFIX))
      .map((test) => test as unknown as SuiteHealthTestInput),
    flowMap,
    declaredRoutes:
      sourceItems > 0
        ? routeItems.filter((item) => item.origin !== 'CRAWL_ONLY').map((item) => routeOf(item.key))
        : null,
    /*
     * The source-side fence, and the same string the worker passes. Beyond the
     * cap the declared list is a PAGE of this project's route items, so a route
     * the code does declare can arrive at the comparison missing — which is
     * precisely the negative a retirement needs. `obsolete.ts` withholds every
     * proposal on it, exactly as it does for a truncated crawl.
     */
    declaredRoutesTruncatedReason: routeItemsTruncated
      ? `QAAI read the first ${DRIFT_ROUTE_ITEM_SCAN_LIMIT} route items of this project and there are more`
      : null,
    retiredRoutes: routeItems
      .filter((item) => item.retiredAt !== null)
      .map((item) => routeOf(item.key)),
  });

  res.json({
    crawledAt: crawl?.createdAt ?? null,
    crawlVersion: crawl?.version ?? null,
    sourceAnalysed: report.sourceAnalysed,
    /*
     * Both caps, on the response rather than only in a server log. A screen
     * showing "12 tests compared" with no sign that there are 900 is a screen
     * that cannot be acted on, and `routesCompared` is the authority behind
     * every OBSOLETE row on it.
     */
    testsCompared: report.tests.length,
    testsTruncated,
    testScanLimit: DRIFT_TEST_SCAN_LIMIT,
    routesCompared: routeItems.length,
    routeItemsTruncated,
    routeItemScanLimit: DRIFT_ROUTE_ITEM_SCAN_LIMIT,
    declaredRoutesTruncatedReason: report.declaredRoutesTruncatedReason,
    drift: driftCheck(report),
    /*
     * Every verdict, not only the warnings. A screen that shows six drifted
     * tests out of an unstated total is a screen that cannot be acted on, and
     * the UNREACHED and UNMEASURED rows are the ones a reader has to see in
     * order to trust the OBSOLETE ones.
     */
    tests: report.tests,
  });
});

// Chat lives in routes/copilot.ts — it outgrew this file the moment it
// gained tools and an approval gate.

// ─── Re-enumeration triggers, drift and the access matrix (authenticated) ────

/** Resolves an environment inside a project, or 404s. Four endpoints below need it. */
async function environmentInProject(
  projectId: string,
  environmentId: string,
): Promise<{ id: string; orgId: string; projectId: string; kind: EnvironmentKind; baseUrl: string }> {
  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true, orgId: true, projectId: true, kind: true, baseUrl: true },
  });
  if (!environment || environment.projectId !== projectId) throw notFound('Environment');
  return environment;
}

/**
 * The re-enumeration triggers on an environment, and whether each has ever run.
 *
 * `hasRun` comes from `triggerHasRun` and not from `lastRunAt != null`, because
 * the two can disagree and only one of them is the question being asked. A
 * NEVER_RUN trigger must render as "this environment has never been
 * re-enumerated on a schedule" — never as "no drift", which is what a blank
 * lastRunAt invites.
 */
agentRouter.get(
  '/projects/:projectId/environments/:environmentId/re-enumeration',
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    await environmentInProject(projectId, environmentId);

    const rows = await prisma.reEnumerationTrigger.findMany({
      where: { environmentId },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        kind: true,
        enabled: true,
        cron: true,
        timezone: true,
        /* The NAME of the vault entry. Never the value, and never the value's length. */
        webhookSecretName: true,
        lastRunState: true,
        lastRunAt: true,
        lastFailureMessage: true,
        consecutiveFailures: true,
        createdAt: true,
      },
    });

    res.json({
      triggers: rows.map((row) => ({
        ...row,
        hasRun: triggerHasRun(row.lastRunState),
        /*
         * The sentence, computed once here so three screens cannot each invent
         * their own. "No drift" is not among the possible answers: this endpoint
         * reports whether a comparison has EVER been made, and the comparison's
         * result lives on SurfaceDriftRecord.
         */
        staleness: triggerHasRun(row.lastRunState)
          ? row.consecutiveFailures > 0
            ? `This trigger has failed ${row.consecutiveFailures} run(s) in a row, so the surface may not have been re-enumerated since before then.`
            : null
          : 'This environment has never been re-enumerated by this trigger. That is not a statement that nothing has changed — no comparison has been made.',
      })),
      /*
       * An empty list is NOT "nothing is stale". It is "nobody has set up
       * re-enumeration", which is the state of every install before this
       * endpoint existed, and the only crawl trigger was a human pressing a
       * button.
       */
      why: rows.length === 0
        ? 'No re-enumeration trigger exists for this environment, so the only thing that refreshes its denominator is somebody pressing Crawl. Nothing is watching for drift.'
        : null,
    });
  },
);

/**
 * Create or update one trigger.
 *
 * Upserted on `@@unique([environmentId, name])`, which is also what the deploy
 * webhook resolves by — so a customer who re-saves a trigger keeps the URL
 * their CD pipeline already posts to.
 *
 * ── THE FIELDS THAT ARE REFUSED RATHER THAN DEFAULTED ───────────────────────
 *
 * `cron`/`timezone` are SCHEDULE-only and are stored NULL for every other kind.
 * The tempting default is `* * * * *`, and a scheduler would obey it. A CI
 * trigger with a cron is a trigger that fires on a timer the customer did not
 * ask for.
 *
 * `webhookSecretName` is DEPLOY-only and is a `Secret.name` reference. The
 * endpoint refuses a name with no matching vault entry: a DEPLOY trigger whose
 * secret does not exist is a webhook that will reject every delivery, and
 * finding that out at deploy time is worse than finding it out here.
 */
agentRouter.put(
  '/projects/:projectId/environments/:environmentId/re-enumeration',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    const environment = await environmentInProject(projectId, environmentId);
    const input = reEnumerationTriggerSchema.parse(req.body);

    if (input.kind === 'SCHEDULE' && !input.cron) {
      throw unprocessable('A SCHEDULE trigger needs a cron expression; nothing would ever fire it.');
    }
    if (input.cron) {
      try {
        CronExpressionParser.parse(input.cron, { tz: input.timezone ?? 'UTC' });
      } catch {
        throw badRequest(`"${input.cron}" is not a cron expression this scheduler can read.`);
      }
    }
    if (input.kind === 'DEPLOY' && !input.webhookSecretName) {
      throw unprocessable(
        'A DEPLOY trigger is fired by an inbound request, so it needs a shared secret to ' +
          "authenticate it. Store one in this environment's vault and name it here.",
      );
    }
    if (input.webhookSecretName) {
      const exists = await prisma.secret.findUnique({
        where: { environmentId_name: { environmentId, name: input.webhookSecretName } },
        select: { id: true },
      });
      if (!exists) {
        throw unprocessable(
          `This environment has no vault entry called "${input.webhookSecretName}", so every ` +
            'inbound delivery would be rejected. Add the secret first.',
        );
      }
    }

    const scheduled = input.kind === 'SCHEDULE';
    const trigger = await prisma.reEnumerationTrigger.upsert({
      where: { environmentId_name: { environmentId, name: input.name } },
      create: {
        orgId: environment.orgId,
        projectId,
        environmentId,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled,
        cron: scheduled ? (input.cron ?? null) : null,
        timezone: scheduled ? (input.timezone ?? 'UTC') : null,
        webhookSecretName: input.kind === 'DEPLOY' ? (input.webhookSecretName ?? null) : null,
      },
      update: {
        kind: input.kind,
        enabled: input.enabled,
        cron: scheduled ? (input.cron ?? null) : null,
        timezone: scheduled ? (input.timezone ?? 'UTC') : null,
        webhookSecretName: input.kind === 'DEPLOY' ? (input.webhookSecretName ?? null) : null,
      },
      select: { id: true, name: true, kind: true, enabled: true, lastRunState: true },
    });

    await audit({
      actor,
      action: 'surface.re_enumeration.configured',
      targetType: 'Environment',
      targetId: environmentId,
      /* The secret's NAME is metadata; its value is never read here at all. */
      metadata: { triggerId: trigger.id, name: trigger.name, kind: trigger.kind, enabled: trigger.enabled },
    });
    res.json({ trigger });
  },
);

/**
 * Fire a CI or MANUAL trigger now.
 *
 * A CI step POSTs this with the session of a machine user; a person pressing
 * "Re-enumerate" hits the same route. SCHEDULE and DEPLOY are refused here on
 * purpose — each has exactly one way in, and a trigger that can be fired by two
 * mechanisms has a `lastRunAt` that answers "when did the schedule last run"
 * incorrectly forever.
 */
agentRouter.post(
  '/projects/:projectId/environments/:environmentId/re-enumerate',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    await environmentInProject(projectId, environmentId);
    const triggerName = String(req.body?.triggerName ?? '').trim();
    if (!triggerName) throw badRequest('triggerName is required');

    const trigger = await prisma.reEnumerationTrigger.findUnique({
      where: { environmentId_name: { environmentId, name: triggerName } },
      select: {
        id: true,
        orgId: true,
        projectId: true,
        environmentId: true,
        kind: true,
        enabled: true,
        lastRunAt: true,
        lastRunState: true,
      },
    });
    if (!trigger) throw notFound('Re-enumeration trigger');
    if (trigger.kind !== 'CI' && trigger.kind !== 'MANUAL') {
      throw unprocessable(
        `"${triggerName}" is a ${trigger.kind} trigger. A SCHEDULE trigger is fired by the ` +
          "worker's tick and a DEPLOY trigger by its signed webhook; firing it from here as " +
          'well would make its last-run time mean two different things.',
      );
    }
    if (!trigger.enabled) {
      res.json({ fired: false, why: 'the trigger is disabled' });
      return;
    }

    const outcome = await claimTriggerAndCrawl(trigger, new Date());
    await audit({
      actor,
      action: 'surface.re_enumeration.fired',
      targetType: 'Environment',
      targetId: environmentId,
      metadata: {
        triggerId: trigger.id,
        kind: trigger.kind,
        fired: outcome.fired,
        /* Countable. A message is not. */
        why: outcome.fired ? null : outcome.why,
      },
    });
    res.status(outcome.fired ? 202 : 200).json(outcome);
  },
);

/**
 * What changed between the last two crawls of this environment.
 *
 * ── THE HEADLINE NUMBER IS READ THROUGH THE PREDICATE, NEVER OFF THE COLUMN ──
 *
 * `newSurfaceWithoutTests(record)` returns NULL for every non-comparison AND
 * for a COMPARABLE row whose column is null — that row is a writer bug, and a 0
 * there would hide it behind a green tick. So the response carries the
 * predicate's answer under `newSurfaceWithoutTests` and the raw column is not
 * sent at all: a client cannot read a number this endpoint refused to report.
 *
 * `detail.routesRemoved === null` means removals were REFUSED because the crawl
 * disclosed truncation — not that there were none — which is why
 * `removalsRefusedBecause` is lifted out of `detail` into its own field.
 */
agentRouter.get(
  '/projects/:projectId/environments/:environmentId/surface-drift',
  async (req, res) => {
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    await environmentInProject(projectId, environmentId);

    const rows = await prisma.surfaceDriftRecord.findMany({
      where: { environmentId },
      orderBy: [{ comparedAt: 'desc' }, { createdAt: 'desc' }],
      take: SURFACE_DRIFT_LIMIT,
      select: {
        id: true,
        currentFlowMapId: true,
        baselineFlowMapId: true,
        comparability: true,
        routesAdded: true,
        routesRemoved: true,
        routesChanged: true,
        controlsAdded: true,
        controlsRemoved: true,
        newSurfaceWithoutTests: true,
        detail: true,
        comparedAt: true,
        createdAt: true,
        producedByTrigger: { select: { id: true, name: true, kind: true } },
      },
    });

    const records = rows.map((row) => {
      const detail = (row.detail ?? null) as Record<string, unknown> | null;
      const truncation = (detail?.truncation ?? null) as Record<string, unknown> | null;
      const comparable = driftCountsAreMeaningful(row.comparability);
      return {
        id: row.id,
        currentFlowMapId: row.currentFlowMapId,
        baselineFlowMapId: row.baselineFlowMapId,
        comparability: row.comparability,
        /* The only number anyone acts on, and only when it was measured. */
        newSurfaceWithoutTests: newSurfaceWithoutTests(row),
        /*
         * The rest of the counts, each NULL unless the comparison happened.
         * Passed through the same gate rather than spread off the row, so a
         * writer that filled a count on an uncomparable record cannot publish
         * it.
         */
        counts: comparable
          ? {
              routesAdded: row.routesAdded,
              routesRemoved: row.routesRemoved,
              routesChanged: row.routesChanged,
              controlsAdded: row.controlsAdded,
              controlsRemoved: row.controlsRemoved,
            }
          : null,
        /* Why the counts are null, in the customer's terms. */
        why: (detail?.why ?? null) as string | null,
        testednessUnmeasuredBecause: (detail?.testednessUnmeasuredBecause ?? null) as string | null,
        /* A null removal count means REFUSED, not zero. */
        removalsRefusedBecause: (truncation?.removalsRefusedBecause ?? null) as string | null,
        detail,
        comparedAt: row.comparedAt,
        createdAt: row.createdAt,
        trigger: row.producedByTrigger,
      };
    });

    res.json({
      records,
      /*
       * EMPTY IS NOT "NO DRIFT". Nothing has compared two crawls of this
       * environment — which is the state the cockpit already implied was
       * impossible, because the schema and the UI both claimed versions were
       * diffed and no diff code existed.
       */
      why: records.length === 0
        ? 'No crawl of this environment has ever been compared to another one, so nothing is known about drift. This is NOT a report that nothing changed.'
        : null,
      cappedBy: rows.length === SURFACE_DRIFT_LIMIT ? `the newest ${SURFACE_DRIFT_LIMIT} comparisons` : null,
    });
  },
);

/**
 * The authorization axis, and whether this environment can be reached at all.
 *
 * Three facts that only make sense together:
 *
 *   reachability   from `EnvironmentAccess`. The ABSENCE of the row is
 *                  NOT_PROBED — nobody has looked — and is reported as such
 *                  rather than as "nothing is blocking us".
 *   roles          one `RoleCrawlAttempt` per role. A role whose login FAILED
 *                  and a role with no extra surface are opposite facts, and
 *                  `roleHadNoExtraSurface` returns null rather than letting the
 *                  second be inferred from the first.
 *   cells          route x role. NOT_PROBED cells are returned WITH the rest
 *                  and counted separately, because the measured fraction of the
 *                  authorization denominator is the number that makes the rest
 *                  of it readable.
 *
 * An empty matrix means NOBODY HAS PROBED THE AUTHORIZATION AXIS. It never
 * means this application has no role restrictions.
 */
agentRouter.get('/projects/:projectId/environments/:environmentId/access', async (req, res) => {
  const projectId = String(req.params.projectId);
  const environmentId = String(req.params.environmentId);
  await environmentInProject(projectId, environmentId);

  const [access, attempts, cells, cellCount] = await Promise.all([
    prisma.environmentAccess.findUnique({
      where: { environmentId },
      select: {
        provider: true,
        bypassMode: true,
        bypassHeaderName: true,
        /* The NAME of the vault entry, never its value. */
        bypassSecretName: true,
        extraHeaders: true,
        reachability: true,
        remedy: true,
        observedSignal: true,
        observedAt: true,
      },
    }),
    prisma.roleCrawlAttempt.findMany({
      where: { environmentId },
      orderBy: { role: 'asc' },
      select: {
        role: true,
        authProfileId: true,
        outcome: true,
        detail: true,
        remedy: true,
        attemptedAt: true,
        routesReached: true,
        routesNewToThisRole: true,
        cappedBy: true,
        atLeastMoreRoutes: true,
      },
    }),
    prisma.routeAccessCell.findMany({
      where: { environmentId },
      orderBy: [{ routeTemplate: 'asc' }, { role: 'asc' }],
      /* One past the limit, so the response can say "at least N more existed". */
      take: ACCESS_CELL_LIMIT + 1,
      select: {
        routeTemplate: true,
        role: true,
        outcome: true,
        basis: true,
        status: true,
        finalUrl: true,
        probedAt: true,
      },
    }),
    prisma.routeAccessCell.count({ where: { environmentId } }),
  ]);

  const shown = cells.slice(0, ACCESS_CELL_LIMIT);
  const measured = shown.filter((cell) => isRouteAccessMeasured(cell)).length;

  res.json({
    /*
     * NO ROW IS NOT_PROBED. A row with provider NONE would be a CLAIM that
     * nothing is in the way; the absence of a row is the honest "nobody has
     * looked", and `reachabilityFromPolicy` never returns REACHABLE from
     * configuration alone either.
     */
    access: access
      ? { ...access, extraHeaderNames: extraHeaderNamesOf(access.extraHeaders) }
      : null,
    reachability: access?.reachability ?? 'NOT_PROBED',
    reachabilityWhy: access
      ? access.remedy
      : 'Nobody has probed this environment for bot protection. That is not a report that nothing is blocking us.',
    roles: attempts.map((attempt) => ({
      ...attempt,
      fault: ROLE_CRAWL_FAULT[attempt.outcome],
      /*
       * NULL whenever the question cannot be answered — a login that failed, a
       * crawl that never ran, or a capped crawl that happened to find nothing
       * new. A reader that gets null must render the outcome instead; "admin
       * sees nothing extra" is the dangerous sentence this prevents.
       */
      hadNoExtraSurface: roleHadNoExtraSurface(attempt),
    })),
    cells: shown,
    counts: {
      total: cellCount,
      shown: shown.length,
      /* Only OBSERVED, non-NOT_PROBED, non-ERRORED cells are a measurement. */
      measured,
      notMeasured: shown.length - measured,
    },
    cappedBy:
      cellCount > ACCESS_CELL_LIMIT
        ? `the ${ACCESS_CELL_LIMIT}-cell page size for this read`
        : null,
    atLeastMoreCells: cellCount > ACCESS_CELL_LIMIT ? cellCount - ACCESS_CELL_LIMIT : null,
    why:
      cellCount === 0
        ? 'Nobody has probed the authorization axis on this environment. This is NOT a report that the application has no role restrictions.'
        : null,
  });
});

/**
 * Tell QAAI how to reach an environment that sits behind a bot defence.
 *
 * ── RULE 9, IN CODE ─────────────────────────────────────────────────────────
 *
 * Every value this endpoint accepts describes something the OWNER of the
 * environment did on their OWN system: they configured their non-production
 * site with the provider's published test keys, they issue a header their own
 * edge accepts, or they allowlisted us. There is no field for a solver, a
 * challenge token or a captured response, and `reachabilityFromPolicy` is the
 * only thing that decides reachability — it never returns REACHABLE from
 * configuration alone, so saving this form cannot make an environment claim to
 * be reachable.
 *
 * A bypass value is stored ONLY as `bypassSecretName`, a `Secret.name`
 * reference, and `environmentExtraHeadersSchema` refuses an inline value for
 * any header that carries a credential by definition. Nothing in the request is
 * logged.
 */
agentRouter.put(
  '/projects/:projectId/environments/:environmentId/access',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const environmentId = String(req.params.environmentId);
    const environment = await environmentInProject(projectId, environmentId);

    const policy = botProtectionSchema.parse(req.body?.botProtection ?? {});
    const extraHeaders =
      req.body?.extraHeaders === undefined
        ? undefined
        : environmentExtraHeadersSchema.parse(req.body.extraHeaders);

    /* Every named vault entry must exist, or the header silently never sends. */
    for (const name of [
      policy.bypassSecretName,
      ...(extraHeaders ?? []).map((header) => header.secretName),
    ]) {
      if (!name) continue;
      const exists = await prisma.secret.findUnique({
        where: { environmentId_name: { environmentId, name } },
        select: { id: true },
      });
      if (!exists) {
        throw unprocessable(
          `This environment has no vault entry called "${name}". A header that names a missing ` +
            'secret is not sent at all, and the run then fails on an assertion and reports it ' +
            "as a defect in your application. Add the secret first.",
        );
      }
    }

    const { reachability, remedy } = reachabilityFromPolicy(policy);
    const row = {
      provider: policy.provider,
      bypassMode: policy.bypassMode,
      bypassHeaderName: policy.bypassHeaderName ?? null,
      bypassSecretName: policy.bypassSecretName ?? null,
      /*
       * `undefined` LEAVES THE COLUMN ALONE, and that is not the same as `[]`.
       * Null means nobody configured headers; `[]` means somebody looked and
       * chose none. Defaulting to `[]` here would erase a decision.
       */
      ...(extraHeaders === undefined ? {} : { extraHeaders }),
      reachability,
      remedy,
      observedSignal: policy.observedSignal ?? null,
    };

    const saved = await prisma.environmentAccess.upsert({
      where: { environmentId },
      create: { orgId: environment.orgId, environmentId, ...row },
      update: row,
      select: {
        provider: true,
        bypassMode: true,
        bypassHeaderName: true,
        bypassSecretName: true,
        extraHeaders: true,
        reachability: true,
        remedy: true,
      },
    });

    await audit({
      actor,
      action: 'environment.access.configured',
      targetType: 'Environment',
      targetId: environmentId,
      /* Provider, mode and header NAMES. No value, and no secret contents. */
      metadata: {
        provider: saved.provider,
        bypassMode: saved.bypassMode,
        bypassHeaderName: saved.bypassHeaderName,
        bypassSecretName: saved.bypassSecretName,
        extraHeaderNames: extraHeaderNamesOf(saved.extraHeaders),
        reachability: saved.reachability,
      },
    });
    res.json({
      access: { ...saved, extraHeaderNames: extraHeaderNamesOf(saved.extraHeaders) },
      /*
       * Said out loud on the write, because the thing a customer expects after
       * saving this form is "we can get in now" and that is NOT what was
       * recorded. Configuration is not a measurement.
       */
      note: 'Saved. Reachability is still a configuration, not a measurement: the next crawl is what probes it.',
    });
  },
);

/** The header NAMES on a stored access row. Never the values, for any caller. */
function extraHeaderNamesOf(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .map((entry) => (typeof (entry as { name?: unknown })?.name === 'string' ? (entry as { name: string }).name : null))
    .filter((name): name is string => name !== null);
}

/**
 * Which auth profile kinds this install can actually honour.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `AUTH_PROFILE_KINDS` grew from five members to eight, so the cockpit offers
 * PASSKEY, PHONE_OTP and MOCK_IDP. A kind the UI offers and the login module
 * cannot perform is the same defect as eight GateRule kinds that shipped
 * unsaveable — the customer configures it, stores it, and gets nothing with no
 * explanation. This endpoint is the explanation, in advance.
 *
 * ── WHERE THE CAPABILITY ANSWER COMES FROM, AND WHY IT IS A FLOOR ───────────
 *
 * `loginCapabilities(surfaces)` turns the surfaces a caller supplies into the
 * capability set `authAdapterUnavailable` answers from. Both call sites of
 * `signInWithProfile` in this repo — apps/worker/src/processors/run.ts and
 * .../explore.ts — supply NO surfaces, so `loginCapabilities({})` is the set
 * the worker genuinely has today, not an assumption. It is reported as a FLOOR
 * rather than a measurement anyway: the API does not run logins, and a worker
 * image that later injects a mailbox or a CDP session would have more. A floor
 * can only under-promise, which is the safe direction for this particular
 * sentence.
 */
agentRouter.get('/auth-profile-kinds', async (req, res) => {
  const environmentId = typeof req.query.environmentId === 'string' ? req.query.environmentId : null;
  const environment = environmentId
    ? await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { id: true, kind: true },
      })
    : null;
  if (environmentId && !environment) throw notFound('Environment');

  const stored = environment
    ? await prisma.authProfile.groupBy({
        by: ['kind'],
        where: { environmentId: environment.id },
        _count: { _all: true },
      })
    : [];
  const counts = new Map(stored.map((row) => [row.kind, row._count._all]));
  const capabilities = loginCapabilities({});

  res.json({
    capabilitiesPresent: capabilities,
    kinds: AUTH_PROFILE_KINDS.map((kind) => {
      const unavailable = authAdapterUnavailable(kind, capabilities);
      return {
        kind,
        label: AUTH_PROFILE_KIND_LABELS[kind],
        requires: AUTH_PROFILE_CAPABILITIES[kind],
        /*
         * UNAVAILABLE with every missing capability and a remedy, or null. Null
         * is "nothing is missing", not "this definitely works" — the login
         * itself can still be MISCONFIGURED or REJECTED, which are different
         * failures with different faults.
         */
        unavailable,
        /*
         * MOCK_IDP on PRODUCTION mints an assertion, which is forging a real
         * identity. Reported here so the form can refuse before a credential is
         * typed, and refused again in the login module itself.
         */
        refusedHere: environment ? authProfileKindRefusedOn(kind, environment.kind) : null,
        storedCount: counts.get(kind) ?? 0,
      };
    }),
    /*
     * The honest caveat on the whole answer. A kind reported available here can
     * still be unavailable on the runner that picks the job up.
     */
    note: 'This is the capability FLOOR for this install, read from the sign-in path as it is configured today. A runner with a mailbox, an OTP sink, a CDP session or a mock issuer attached can honour more.',
  });
});

// ─── Measuring the measurer ──────────────────────────────────────────────────

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE SELF-MEASUREMENT ROUTES
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Every other number this API serves is a claim about the CUSTOMER'S
 * application. These four are claims about QAAI, and until `lib/accuracy.ts`
 * landed there were none: no ground truth, no seeded-fault benchmark, no
 * back-test against the customer's own bug history, no keep-rate for generated
 * tests, no triage override rate. The consequence was not theoretical — a
 * catch-all route literal once produced 100% coverage and survived a whole
 * round, because nothing anywhere was checking the measurement against a known
 * answer.
 *
 * ── THESE ARE THIN CALLERS, DELIBERATELY ───────────────────────────────────
 *
 * Every rate below is computed by a pure function in `lib/accuracy.ts` over
 * rows these handlers read. No handler does arithmetic on a percentage: there
 * is one implementation of each rate, with its own test, and these are its
 * door. A handler that divided here would be a second answer to the same
 * question, served from the same product.
 *
 * ── INSUFFICIENT_DATA IS A 200 WITH A NAMED REASON ─────────────────────────
 *
 * Not a 404, not an empty object and never a zero. "We looked and there is not
 * enough" and "we did not look" are different answers with different remedies,
 * and both are more useful than silence — a buyer reading an empty response as
 * the first when it is the second is the failure this whole vocabulary exists
 * to prevent. So every payload here carries its own n, the threshold that was
 * APPLIED, and a sentence.
 *
 * ── AND NOTHING HERE MAY BE PRESENTED AS CAUSAL ────────────────────────────
 *
 * Binding rather than stylistic, and it is why the fields are named
 * `escapedRate*` and the verdict says `SUFFICIENT`: a correlation between
 * coverage and escaped defects is evidence worth reporting and is not proof
 * that the coverage caused the quality. There is no field called `predicts`
 * anywhere below and there must not be one.
 */

/** Verdicts read per accuracy request. A cap, therefore disclosed when it bites. */
const MAX_ACCURACY_VERDICTS = 5_000;
/** Generated tests read per keep-rate request. Same contract. */
const MAX_GENERATED_TESTS = 5_000;

/**
 * GET /verdicts/accuracy — HOW OFTEN A HUMAN OVERRULED THE TRIAGE MODEL.
 *
 * ── PER VERDICT KIND, AND THERE IS NO SINGLE NUMBER ────────────────────────
 *
 * "85% accurate" is unactionable and usually wrong in a specific way: a model
 * that is right about FLAKE (the common case) and wrong about ENV_ISSUE (the
 * rare one) scores well and is useless, because ENV_ISSUE is the verdict that
 * stops a team investigating a bug that is not theirs. Four rates make that
 * visible; one hides it. So `triageAccuracy` reports a rate per kind and the
 * totals are COUNTS — which a reader can re-divide, unlike a percentage, which
 * they cannot un-blend.
 *
 * ── A MUTE IS NOT AN ACCEPTANCE ────────────────────────────────────────────
 *
 * `muted` is its own column. A human who muted a signature did not agree with
 * the verdict, they stopped hearing about it, and folding those into `accepted`
 * would make the model look better the more people switched it off.
 */
agentRouter.get('/verdicts/accuracy', async (req, res) => {
  const rows = await prisma.triageVerdict.findMany({
    orderBy: { createdAt: 'desc' },
    take: MAX_ACCURACY_VERDICTS,
    // Named, so dropping one from this select is a type error at the call below
    // rather than a field that quietly reads as undefined and shifts a rate.
    select: { id: true, verdict: true, reviewState: true, overriddenTo: true },
  });

  const accuracy = triageAccuracy(rows);
  const capped = rows.length === MAX_ACCURACY_VERDICTS;

  res.json({
    ...accuracy,
    /*
     * THE n, BESIDE EVERY RATE. `reviewed` is the denominator of
     * `overridePercent`, and a rate over three reviews is not a rate — so the
     * figure and the count it was taken over travel together or not at all.
     */
    n: accuracy.totals.reviewed,
    /** The sentence, with the n in it. An override percent alone is not actionable. */
    why:
      `${accuracy.totals.reviewed} verdict(s) have been reviewed by a human: ` +
      `${accuracy.totals.accepted} accepted, ${accuracy.totals.overridden} overridden, ` +
      `${accuracy.totals.muted} muted and ${accuracy.totals.pending} still pending. ` +
      'A MUTE is not an acceptance — a human who muted a signature stopped hearing about it ' +
      'rather than agreeing — and PENDING is in neither half of any rate here. There is ' +
      'deliberately no single accuracy figure: a model that is right about FLAKE and wrong about ' +
      'ENV_ISSUE scores well blended and is useless, because ENV_ISSUE is the verdict that stops ' +
      'a team investigating a bug that is not theirs.' +
      (accuracy.overriddenWithNoReplacement > 0
        ? ` ${accuracy.overriddenWithNoReplacement} row(s) say OVERRIDDEN and name no replacement verdict — a data defect, reported rather than counted as an acceptance, which is the direction that would flatter the model.`
        : '') +
      (capped
        ? ` The read was capped at ${MAX_ACCURACY_VERDICTS} verdict(s), so these counts are a lower bound over the most recent window.`
        : ''),
    caps: capped
      ? [
          {
            cap: 'MAX_ACCURACY_VERDICTS',
            limit: MAX_ACCURACY_VERDICTS,
            // NULL, not 0: the read stopped at the limit and cannot say what
            // was behind it, and 0 would claim nothing was hidden.
            atLeastMore: null,
            detail: `the verdict read stopped at ${MAX_ACCURACY_VERDICTS} rows, so at least one more exists`,
          },
        ]
      : [],
  });
});

/**
 * GET /generation/survival — THE KEEP-RATE FOR GENERATED TESTS.
 *
 * "Does QAAI write tests a team keeps?" is the question that decides whether
 * the generator is worth having, and it had no answer anywhere in the product.
 *
 * ── NEVER_RUN IS IN NEITHER HALF OF THE FRACTION ───────────────────────────
 *
 * A generated test nobody has executed is not a kept test and not a rejected
 * one, so it is excluded from `rated` and reported as its own count. Counting
 * it as KEPT would make the generator look better the less anybody used it,
 * which is the exact direction a vendor metric fails in.
 *
 * ── BY COHORT, TYPE AND PRODUCER, AND ONE BLENDED `overall` ────────────────
 *
 * The `overall` row is the only blended figure here and it is defensible
 * because it is ONE population — unlike a blended fault-detection rate across
 * classes, which averages unlike things. A reader needs the total n, and three
 * groupings beside it are what make a bad producer or a bad week visible.
 */
agentRouter.get('/generation/survival', async (req, res) => {
  const generated = await prisma.test.findMany({
    where: {
      // `source: 'AI'` on the FIRST version is what makes a test generated, and
      // the versions carry it — so the filter is on the relation rather than on
      // a column Test does not have.
      versions: { some: { source: 'AI' } },
      filePath: { not: { startsWith: FIXTURE_PREFIX } },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_GENERATED_TESTS,
    select: {
      id: true,
      type: true,
      disabledAt: true,
      quarantined: true,
      createdAt: true,
      versions: {
        orderBy: { createdAt: 'asc' },
        select: { source: true, createdAt: true, producer: true },
      },
      results: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { status: true },
      },
    },
  });

  const rows: GeneratedTestRow[] = generated.map((test) => {
    const first = test.versions[0];
    return {
      testId: test.id,
      type: test.type,
      /*
       * NULL when the row predates the column, which is NOT the same as "an
       * unknown model wrote it": `generationSurvival` groups nulls under a
       * named bucket rather than attributing them to whichever producer is
       * most common.
       */
      producer: first?.producer ?? null,
      generatedAt: first?.createdAt ?? test.createdAt,
      /*
       * Every version AFTER the generated one, in order. This is what makes
       * REWRITTEN_BY_HUMAN observable at all — a generated test a person later
       * rewrote is the strongest negative signal the generator has, and it is
       * invisible from the test row alone.
       */
      laterSources: test.versions.slice(1).map((version) => version.source),
      disabledAt: test.disabledAt,
      quarantined: test.quarantined,
      /*
       * NULL means it has never run, which is NOT the same as passing and is
       * the distinction the whole metric turns on.
       */
      firstRunStatus: test.results[0]?.status ?? null,
    };
  });

  const survival = generationSurvival(rows);
  const capped = generated.length === MAX_GENERATED_TESTS;

  res.json({
    ...survival,
    n: survival.overall.total,
    rated: survival.overall.rated,
    why:
      `${survival.overall.total} generated test(s), of which ${survival.overall.rated} can be ` +
      'rated. NEVER_RUN is in neither half of the keep-rate: a generated test nobody has ' +
      'executed is not kept and not rejected, and counting it as kept would make the generator ' +
      'look better the less anybody used it. `survivalPercent` is NULL rather than 0 when ' +
      'nothing could be rated.' +
      (capped
        ? ` The read was capped at ${MAX_GENERATED_TESTS} test(s), so these counts are a lower bound over the most recent window.`
        : ''),
  });
});

/**
 * GET /projects/:projectId/yield — ACCEPTANCE, HEAL SUCCESS AND FIRST-RUN PASS.
 *
 * Each over its DECIDED population, with the pending count beside it. Dividing
 * by the total instead is the mistake that makes every one of these drift
 * downward as a review queue grows: a team that accepted every proposal it
 * looked at and has forty waiting would read as 20% acceptance. So PENDING is
 * its own number and NULL is the answer when nothing has been decided — not 0,
 * which would say every proposal was rejected.
 */
agentRouter.get('/projects/:projectId/yield', async (req, res) => {
  const projectId = String(req.params.projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const [proposals, heals, firstRuns] = await Promise.all([
    prisma.planItem.findMany({
      // `testPlan`, not `plan`: the relation field on PlanItem is named after
      // the model (TestPlan), and `plan` is the local variable name the
      // approval endpoint happens to use for the row.
      where: { testPlan: { projectId } },
      select: { id: true, state: true },
      take: MAX_GENERATED_TESTS,
    }),
    prisma.healProposal.findMany({
      where: { test: { projectId } },
      select: { id: true, state: true },
      take: MAX_GENERATED_TESTS,
    }),
    /*
     * The FIRST run of each generated test, and only of generated tests. A
     * first-run pass rate over hand-written tests would be a rate about the
     * customer's work filed under a metric about ours.
     */
    prisma.test.findMany({
      where: {
        projectId,
        versions: { some: { source: 'AI' } },
        filePath: { not: { startsWith: FIXTURE_PREFIX } },
      },
      select: {
        id: true,
        results: { orderBy: { createdAt: 'asc' }, take: 1, select: { status: true } },
      },
      take: MAX_GENERATED_TESTS,
    }),
  ]);

  const telemetry = yieldTelemetry({
    proposals,
    heals,
    /*
     * A generated test with NO result contributes no first run, rather than a
     * failing one. `firstRunPassPercent` divides by the first runs that
     * happened, and inventing a FAILED row for a test nobody executed would
     * report our generator as worse than it is for a reason that is the
     * customer's CI schedule.
     */
    firstRuns: firstRuns.flatMap((test) =>
      test.results[0] ? [{ testId: test.id, status: test.results[0].status }] : [],
    ),
  });

  res.json({
    ...telemetry,
    why:
      'Each rate divides by its DECIDED population and the pending count sits beside it. ' +
      'Dividing by the total instead makes every one of these drift downward as a review queue ' +
      'grows — a team that accepted everything it looked at and has forty waiting would read as ' +
      '20% acceptance. NULL means nothing has been decided yet, which is not 0%: 0% would say ' +
      'every proposal was rejected. A FLAKY first run is counted and excluded: it is neither a ' +
      'pass nor a failure. A SUPERSEDED heal is in neither half either — it was replaced by a ' +
      'newer proposal for the same test, so nobody judged it, and counting it as a failure would ' +
      'make the heal success rate fall every time the healer retried.',
  });
});

/**
 * GET /projects/:projectId/validity — DOES "COVERED" PREDICT QUALITY?
 *
 * ── THE QUESTION A BUYER ACTUALLY ASKS, AND ITS HONEST ANSWER ──────────────
 *
 * It is also the question most easily answered with a flattering correlation
 * computed over four defects. So `INSUFFICIENT_DATA` is a first-class verdict
 * with the n beside it, `NOT_ATTEMPTED` is distinct from it — one says "we
 * looked and there is not enough", the other says "we did not look" — and both
 * rates are NULL rather than numbers whenever the verdict is not SUFFICIENT.
 *
 * ── A 200 WITH A NAMED REASON, NEVER A 404 AND NEVER A ZERO ────────────────
 *
 * A 404 would read as "this project does not support the question". An empty
 * object would read as "there is nothing to report". Both are wrong in the
 * same direction: a buyer reading silence as "they looked and it was fine" is
 * exactly the inference this vocabulary exists to deny.
 *
 * ── AND IT IS NOT A CAUSAL CLAIM ───────────────────────────────────────────
 *
 * The back-test is computed by `backtestValidity` and WRITTEN by the bench
 * (`qaai bench`), not here: it needs the customer's own defect history, which
 * arrives through a tracker integration and not through an HTTP GET. This is
 * the read, and when nothing has been written the verdict is NOT_ATTEMPTED —
 * the one answer that is about us rather than about their data.
 */
agentRouter.get('/projects/:projectId/validity', async (req, res) => {
  const projectId = String(req.params.projectId);
  const actor = actorOf(req);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  /*
   * The tenant-scoped client, passed as the narrow `AccuracyClient` the
   * accuracy module declares. No cast: the module takes the two delegates it
   * needs as an injected interface precisely so it can be tested without a
   * database, and a cast here would have hidden the day one of those delegate
   * signatures stopped matching.
   */
  const record = await loadLatestValidityBacktest(prisma, {
    orgId: actor.orgId,
    projectId,
  });

  if (record === null) {
    res.json({
      /*
       * NOT_ATTEMPTED, which is a verdict about US and not about their data,
       * and is deliberately distinct from INSUFFICIENT_DATA. The remedy for
       * this one is connecting a tracker and running `qaai bench`; the remedy
       * for the other is waiting for more defects.
       */
      verdict: 'NOT_ATTEMPTED',
      verdictDetail: VALIDITY_VERDICT_LABELS.NOT_ATTEMPTED,
      defectCount: null,
      escapedRateCovered: null,
      escapedRateUncovered: null,
      minimumDefects: MINIMUM_BACKTEST_DEFECTS,
      defectSource: null,
      why:
        'No back-test has been run for this project, so whether covered surface escapes fewer ' +
        'defects than uncovered surface is NOT MEASURED here. That is a statement about QAAI and ' +
        'not about your application: the comparison needs your own defect history, which arrives ' +
        'through a tracker integration, and it is computed by `qaai bench`. Read this as "we did ' +
        'not look", which is a different answer from "we looked and there is not enough data" — ' +
        'and both are different from a result.',
    });
    return;
  }

  res.json({
    ...record,
    /*
     * The threshold that was APPLIED, echoed from the stored row rather than
     * from the constant. They should agree; if a row was written under an older
     * threshold they will not, and the row's own value is the one that explains
     * the verdict it carries. Reporting today's constant beside yesterday's
     * verdict is a doc comment contradicting the code under it, in data.
     */
    minimumDefects: record.minimumDefects,
    currentMinimumDefects: MINIMUM_BACKTEST_DEFECTS,
    why:
      `${record.defectCount} defect(s) in the window, against a floor of ${record.minimumDefects}. ` +
      `${VALIDITY_VERDICT_LABELS[record.verdict as ValidityVerdict] ?? record.verdict} ` +
      'Both rates are NULL rather than numbers unless the verdict is SUFFICIENT. This is a ' +
      'CORRELATION and is reported as one: nothing here claims the coverage caused the quality, ' +
      'and there is no field that says it did.',
  });
});

/*
 * ── GET /projects/:projectId/scenario-capability ────────────────────────────
 *
 * MOUNTED AT THE ROOT — apps/api/src/index.ts does `app.use('/', agentRouter)`
 * — so the full URL is exactly the path declared above, with no prefix. Stated
 * because a router that declares a relative path and is mounted at the wrong
 * prefix is a 404 with a comment swearing it works.
 *
 * DECLARED BELOW `agentRouter.use(requireAuth)` (line 438), deliberately: it
 * reads a project's configuration and must not answer an anonymous caller. The
 * only routes above that line are the ones that carry their own authentication,
 * and this is not one of them.
 *
 * ── WHY THIS ENDPOINT EXISTS ────────────────────────────────────────────────
 *
 * "My plan has no race tests" and "nothing looked for race conditions in my
 * application" are different sentences with different remedies, and the product
 * rendered them identically — as an absence. An absence reads as a clean bill
 * of health, which is the single most flattering wrong answer this product can
 * give, so every kind this project CANNOT produce is reported as UNAVAILABLE
 * with the fact that is missing and what to do about it. Never as a zero.
 */
agentRouter.get('/projects/:projectId/scenario-capability', async (req, res) => {
  const projectId = String(req.params.projectId);
  // Same guard the sibling `/projects/:projectId/dimensions` route uses: the
  // project has to exist before anything is reported about it.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const [authProfiles, flowMap, apiOperations, emailOtpTests] = await Promise.all([
    /*
     * COUNTS AND KINDS ONLY — never a config blob. An AuthProfile's config
     * holds the credential, and an endpoint that reports capability has no need
     * of it. `select` is narrowed rather than the row being fetched and picked
     * apart, so a field added to that model cannot start arriving here.
     */
    prisma.authProfile.findMany({
      // AuthProfile hangs off the ENVIRONMENT, not the project: a credential is
      // environment-specific, which is the whole reason the model is shaped
      // that way. Scoping it by `projectId` directly does not compile.
      where: { environment: { projectId } },
      select: { id: true, name: true, kind: true },
    }),
    prisma.flowMap.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    }),
    prisma.apiOperation.count({ where: { projectId } }),
    /*
     * THE ONLY MAIL-SINK EVIDENCE THIS SCHEMA HOLDS, and it is weak.
     *
     * There is NO per-environment place to configure a mail catcher anywhere in
     * this product — `grep -i mailSink` over schema.prisma returns nothing, and
     * `mailboxUrl` exists only inside an individual EMAIL_OTP test's `spec`
     * Json. So the best available signal is "this project has at least one
     * EMAIL_OTP test, therefore somebody somewhere knows a mailbox URL", and
     * the verdict below says exactly that rather than implying a configured
     * sink. An `EnvironmentMailSink` model is the real fix and it is in this
     * round's handover.
     *
     * An earlier draft of this query counted `environmentAccess` rows with a
     * non-null `provider`, which is BOT PROTECTION and has nothing to do with
     * mail — and it did not even compile, because `provider` is a non-nullable
     * enum defaulting to UNKNOWN. A count that cannot be null would have
     * reported every project as mail-capable.
     */
    prisma.test.count({ where: { projectId, type: 'EMAIL_OTP' } }),
  ]);

  const profiles = authProfiles.length;
  const crawled = flowMap !== null;

  /**
   * One kind's verdict. `available: false` ALWAYS carries a `missing` and a
   * `remedy`; there is no arm of this function that returns an unavailable
   * verdict with nothing beside it, because an unexplained absence is the thing
   * this endpoint exists to stop.
   */
  const verdict = (
    kind: ScenarioKind,
  ): {
    kind: ScenarioKind;
    rank: number;
    why: string;
    available: boolean;
    missing: string | null;
    remedy: string | null;
  } => {
    const risk = SCENARIO_KIND_RISK[kind];
    const base = { kind, rank: risk.points, why: risk.why };
    const no = (missing: string, remedy: string) => ({
      ...base,
      available: false,
      missing,
      remedy,
    });
    const yes = () => ({ ...base, available: true, missing: null, remedy: null });

    switch (kind) {
      case 'TENANCY':
      case 'MULTI_ACTOR':
        /*
         * TWO identities, not one. One auth profile cannot be both sides of a
         * handoff or both tenants of an isolation sweep, and a sweep run with
         * one identity on both sides asks a principal for its own records —
         * which `tenancyPlugin.validate` refuses outright rather than letting
         * it pass vacuously.
         */
        return profiles >= 2
          ? yes()
          : no(
              `${kind} needs two distinct identities and this project has ${profiles} auth profile(s).`,
              'Configure a second auth profile on this project. One identity cannot be both sides of a handoff, and a sweep that asks a principal for its own records proves nothing.',
            );
      case 'AUTHZ_PROBE':
        return profiles >= 2
          ? yes()
          : no(
              `An IDOR probe asks AS A REAL SIGNED-IN PRINCIPAL for another principal's object, and this project has ${profiles} auth profile(s).`,
              'Configure a second auth profile. The anonymous version of this check passes against every correct application, so it has never found anything.',
            );
      case 'AUTH_LIFECYCLE':
        /*
         * A mail sink, because signup, email verification and password reset
         * all stop at a message nothing can read. The journey is still PLANNED
         * without one — `auth-lifecycle.ts` records UNREACHABLE_NO_MAIL_SINK
         * rather than silently skipping — and it cannot be driven.
         */
        return emailOtpTests > 0
          ? yes()
          : no(
              'Signup, email verification and password reset all stop at a delivered message, and nothing on this project shows where one can be read. NOTE: this product has no per-environment mail-sink setting at all \u2014 the only evidence available is whether an EMAIL_OTP test exists \u2014 so read an `available: true` here as "somebody knows a mailbox URL", not as "a sink is configured".',
              'Until an EnvironmentMailSink setting exists, add an EMAIL_OTP test carrying a mailboxUrl. Without a readable mailbox these flows are reported UNREACHABLE_NO_MAIL_SINK, which is honest but is not coverage.',
            );
      case 'WALK':
      case 'FAULT_INJECTION':
      case 'RACE':
      case 'BOUNDARY':
      case 'FUZZ':
        return crawled
          ? yes()
          : no(
              'Nothing has been crawled for this project, so there is no graph to walk, no request to intercept and no form to perturb.',
              'Run the Explorer. Every kind here is derived from the crawl and none of them can be guessed at.',
            );
      case 'TYPE_COVERAGE':
        /*
         * WHICH TEST TYPE A SURFACE EARNS — the funnel that widened the
         * deterministic producer from TWO types to all nineteen minted ones.
         *
         * A crawl is enough to RUN it and is NOT enough to answer it fully, and
         * saying only the first would be the shape of dishonesty this endpoint
         * exists to stop. `signalsFromFlowMap` reports what a browser can see —
         * a card field, a file input, a download affordance, an id in a route —
         * and returns NO KEY AT ALL for a database, a CLI entry point, a unit
         * runner, a native build or a declared budget, because a crawl cannot
         * see any of them. Those come back NOT_PROBED, which is a hole in OUR
         * enumeration rather than a fact about the application.
         *
         * So this arm is deliberately NOT `yes()`: `yes()` sets `remedy: null`,
         * and a reader would take an unqualified `available: true` to mean the
         * funnel had considered every type — at which point a plan with no
         * MOBILE item reads as "this application has no native build" when the
         * truth is that nobody looked. `available` is honest (the kind runs and
         * produces real verdicts) and the remedy names what the crawl alone
         * leaves unanswered.
         */
        return crawled
          ? {
              ...base,
              available: true,
              missing: null,
              remedy:
                'A crawl answers only the signals a browser can observe. Whether this ' +
                'application earns MOBILE, CLI, DATABASE, UNIT_GEN, INTEGRATION, MUTATION, LOAD ' +
                'or PERFORMANCE tests needs source analysis and the environment settings, and ' +
                'until those run the funnel reports each of them NOT_PROBED — which means ' +
                '"nobody looked", NOT "no such surface". Connect the repository and run source ' +
                'analysis to widen it.',
            }
          : no(
              'Nothing has been crawled for this project, so no signal has been observed and no test type can be shown to be earned.',
              'Run the Explorer. Every type the funnel proposes is justified by an observed signal, and with nothing observed it proposes nothing rather than guessing.',
            );
      default: {
        /*
         * Exhaustive. A tenth scenario kind is a COMPILE ERROR here rather than
         * a silent `available: true` — which is how a kind nobody wired would
         * come to be reported as working.
         */
        const unreachable: never = kind;
        return unreachable;
      }
    }
  };

  const kinds = SCENARIO_KIND_LIST.map(verdict).sort((a, b) => b.rank - a.rank);

  res.json({
    projectId,
    flowMapId: flowMap?.id ?? null,
    flowMapVersion: flowMap?.version ?? null,
    /** Names and kinds only. A profile's config holds the credential; this does not. */
    authProfiles: authProfiles.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    apiOperations,
    emailOtpTests,
    /** Ranked by bug-finding power, highest first. Same order the plan uses. */
    kinds,
    counts: {
      available: kinds.filter((k) => k.available).length,
      unavailable: kinds.filter((k) => !k.available).length,
    },
    why:
      'Every unavailable kind names the FACT that is missing and the remedy. That is the whole ' +
      'point of this endpoint: "no race tests were proposed" and "nothing looked for race ' +
      'conditions" are different sentences, and an absence reported as a zero reads as a clean ' +
      'bill of health. A kind listed as available can still produce nothing — that means the ' +
      'enumerator looked and found none, which is a real and different answer.',
  });
});
