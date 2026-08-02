/**
 * Agent-facing routes (§3): kick off exploration, read the proposed plan,
 * approve items into generated tests, review verdicts, act on heals, chat.
 *
 * These endpoints only ever enqueue work and read results. The agents
 * themselves run in the worker, where a long crawl or a slow generation cannot
 * hold an HTTP connection open.
 */

import { Router } from 'express';
import { QUEUE_NAMES, approvePlanSchema } from '@qaai/shared';
import { applyHealDiff } from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const agentRouter: Router = Router();

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

  const jobId = await enqueue(QUEUE_NAMES.explore, {
    orgId: actor.orgId,
    projectId,
    environmentId,
    requestedBy: actor.userId,
    maxPages: Math.min(60, Number(req.body?.maxPages ?? 25)),
    maxDepth: Math.min(6, Number(req.body?.maxDepth ?? 3)),
    autoApprove: req.body?.autoApprove === true,
  },
  // One attempt. A crawl is expensive and NOT idempotent — it writes a new
  // FlowMap version every run — so the default 3 retries silently re-crawled
  // the customer's site three times whenever the plan step failed.
  { attempts: 1 });

  await audit({
    actor,
    action: 'explorer.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { environmentId, baseUrl: environment.baseUrl },
  });

  res.status(202).json({ jobId, status: 'queued' });
});

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
    include: { items: { select: { id: true, state: true } } },
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
   * Generation needs a model. Missing one is a MISSING TOOL, not a failure —
   * the identical guard routes/coverage.ts and routes/traffic.ts already make,
   * for the identical reason, and this is the one approval path every new
   * customer walks.
   *
   * Without it this endpoint answered 202 `{ jobId, approved: 8 }`, the cockpit
   * read that as success and sent the person to /editor, and the job died in
   * the worker on "ANTHROPIC_API_KEY is not set". The only thing they ever saw
   * was a green count and then an editor that stayed empty forever, with
   * nothing anywhere to say why. The approval itself is real and is kept — the
   * items are APPROVED and generate as soon as a key is set — so the honest
   * answer is "approved, not queued, here is what to set".
   */
  const canGenerate = Boolean(env.ANTHROPIC_API_KEY);
  const jobId = canGenerate
    ? await enqueue(QUEUE_NAMES.generate, {
        orgId: actor.orgId,
        projectId: plan.projectId,
        testPlanId: plan.id,
        planItemIds: input.approvedItemIds,
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
      queued: canGenerate,
      ...(canGenerate ? {} : { reason: 'no ANTHROPIC_API_KEY' }),
    },
  });

  res.status(202).json({
    jobId,
    approved: input.approvedItemIds.length,
    generation: canGenerate
      ? { queued: true }
      : {
          queued: false,
          reason:
            'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run and no ' +
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
 * Heal proposals for the review screen. Defaults to what needs a decision;
 * `?state=all` includes decided ones so the screen can show what happened.
 * The test's current code ships alongside each diff so the client can render a
 * real before/after without a second round-trip per row.
 */
agentRouter.get('/heals', async (req, res) => {
  const all = String(req.query.state ?? '') === 'all';
  const rows = await prisma.healProposal.findMany({
    where: all ? {} : { state: 'PROPOSED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      test: { select: { id: true, name: true, filePath: true, code: true } },
    },
  });

  /**
   * The patched result is computed here, with the same applier approval uses, so
   * the reviewer sees the real before/after and is told up front when a proposal
   * has gone stale — rather than finding out by clicking Approve.
   */
  const heals = rows.map((heal) => {
    const applied = applyHealDiff(heal.test.code, heal.diff);
    return {
      ...heal,
      preview: {
        applies: applied.ok,
        code: applied.code ?? null,
        reason: applied.reason ?? null,
        fuzz: applied.fuzz ?? null,
      },
    };
  });

  res.json({ heals });
});

agentRouter.post('/heals/:healId/decide', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const approve = req.body?.approve === true;

  const heal = await prisma.healProposal.findUnique({
    where: { id: String(req.params.healId) },
    include: { test: { select: { id: true, code: true } } },
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

  /**
   * Approving applies the diff to the test and records a version, so the fix is
   * real the moment a human accepts it. The test lives in the database, so this
   * is the working copy — Source control then pushes it like any other change.
   *
   * A patch that no longer applies (the test was edited after the proposal) is
   * refused with a 422 rather than force-fitted; the proposal stays PROPOSED so
   * it can be re-run.
   */
  const applied = applyHealDiff(heal.test.code, heal.diff);
  if (!applied.ok || !applied.code) {
    throw unprocessable(applied.reason ?? 'The diff could not be applied');
  }

  const latest = await prisma.testVersion.findFirst({
    where: { testId: heal.testId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const [, updatedHeal] = await prisma.$transaction([
    prisma.test.update({
      where: { id: heal.testId },
      data: {
        code: applied.code,
        // The Generator's review flags describe code a human has now signed off on.
        reviewFlags: [],
        versions: {
          create: {
            orgId: actor.orgId,
            version: (latest?.version ?? 0) + 1,
            code: applied.code,
            source: 'HEALER',
            authorId: actor.userId,
            message: `Applied heal: ${heal.explanation.slice(0, 200)}`,
          },
        },
      },
    }),
    prisma.healProposal.update({
      where: { id: heal.id },
      data: { state: 'APPLIED', decidedBy: actor.userId, decidedAt: new Date() },
    }),
  ]);

  await audit({
    actor,
    action: 'heal.apply',
    targetType: 'HealProposal',
    targetId: heal.id,
    metadata: { riskLevel: heal.riskLevel, testId: heal.testId, fuzz: applied.fuzz },
  });

  res.json({
    heal: updatedHeal,
    note:
      applied.fuzz && applied.fuzz > 0
        ? `Applied, but the patch needed ${applied.fuzz} line(s) of fuzz — worth a glance in the editor.`
        : 'Applied to the test. Push it from Source control when you are ready.',
  });
});

// Chat lives in routes/copilot.ts — it outgrew this file the moment it
// gained tools and an approval gate.
