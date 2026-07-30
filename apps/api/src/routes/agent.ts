/**
 * Agent-facing routes (§3): kick off exploration, read the proposed plan,
 * approve items into generated tests, review verdicts, act on heals, chat.
 *
 * These endpoints only ever enqueue work and read results. The agents
 * themselves run in the worker, where a long crawl or a slow generation cannot
 * hold an HTTP connection open.
 */

import { Router } from 'express';
import { QUEUE_NAMES, approvePlanSchema, chatMessageSchema } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
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
  });

  await audit({
    actor,
    action: 'explorer.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { environmentId, baseUrl: environment.baseUrl },
  });

  res.status(202).json({ jobId, status: 'queued' });
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

  const jobId = await enqueue(QUEUE_NAMES.generate, {
    orgId: actor.orgId,
    projectId: plan.projectId,
    testPlanId: plan.id,
    planItemIds: input.approvedItemIds,
    requestedBy: actor.userId,
  });

  await audit({
    actor,
    action: 'plan.approve',
    targetType: 'TestPlan',
    targetId: plan.id,
    metadata: {
      approved: input.approvedItemIds.length,
      rejected: known.size - input.approvedItemIds.length,
    },
  });

  res.status(202).json({ jobId, approved: input.approvedItemIds.length });
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

agentRouter.get('/heals', async (_req, res) => {
  const heals = await prisma.healProposal.findMany({
    where: { state: 'PROPOSED' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { test: { select: { id: true, name: true, filePath: true } } },
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

  // Applying the diff to the working copy is the repo integration's job (§7).
  // Until a repo is connected, approval records intent and surfaces the diff
  // for a human to apply — which is honest, and better than pretending.
  const approved = await prisma.healProposal.update({
    where: { id: heal.id },
    data: { state: 'APPROVED', decidedBy: actor.userId, decidedAt: new Date() },
  });

  await audit({
    actor,
    action: 'heal.approve',
    targetType: 'HealProposal',
    targetId: heal.id,
    metadata: { riskLevel: heal.riskLevel, testId: heal.testId },
  });

  res.json({
    heal: approved,
    note: 'Approved. Connect a repository to have QAAI open the pull request automatically.',
  });
});

// ─── Chat copilot (§3.5) ─────────────────────────────────────────────────────

agentRouter.post('/chat', async (req, res) => {
  const actor = actorOf(req);
  const input = chatMessageSchema.parse(req.body);

  const conversation = input.conversationId
    ? await prisma.chatConversation.findUnique({ where: { id: input.conversationId } })
    : await prisma.chatConversation.create({
        data: {
          orgId: actor.orgId,
          projectId: input.projectId,
          title: input.message.slice(0, 60),
          createdBy: actor.userId,
        },
      });
  if (!conversation) throw notFound('Conversation');

  await prisma.chatMessage.create({
    data: {
      orgId: actor.orgId,
      conversationId: conversation.id,
      role: 'user',
      content: input.message,
      userId: actor.userId,
    },
  });

  // The copilot itself runs in the worker so a slow tool loop cannot hold this
  // connection; the cockpit polls the conversation for the reply.
  const jobId = await enqueue(QUEUE_NAMES.notify, {
    orgId: actor.orgId,
    event: 'chat.message',
    payload: {
      conversationId: conversation.id,
      projectId: input.projectId,
      message: input.message,
    },
  });

  res.status(202).json({ conversationId: conversation.id, jobId });
});

agentRouter.get('/chat/:conversationId', async (req, res) => {
  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: String(req.params.conversationId) },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ messages });
});
