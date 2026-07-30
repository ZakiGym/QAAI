/**
 * Copilot routes (§3.5) — conversations, turns, and the approval gate on the
 * changes the agent wants to make.
 */

import { Router } from 'express';
import { QUEUE_NAMES, chatMessageSchema } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { subscribe } from '../lib/events.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const copilotRouter: Router = Router();

copilotRouter.use(requireAuth);

/** Conversations for a project, newest first. */
copilotRouter.get('/conversations', async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  if (!projectId) throw badRequest('projectId is required');

  const conversations = await prisma.chatConversation.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'desc' },
    take: 30,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
  res.json({ conversations });
});

/** Full transcript plus any proposals raised in it. */
copilotRouter.get('/conversations/:conversationId', async (req, res) => {
  const conversationId = String(req.params.conversationId);

  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, title: true, projectId: true },
  });
  if (!conversation) throw notFound('Conversation');

  const [messages, proposals] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        toolCalls: true,
        pending: true,
        error: true,
        createdAt: true,
      },
    }),
    prisma.agentProposal.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        messageId: true,
        testId: true,
        filePath: true,
        oldCode: true,
        newCode: true,
        rationale: true,
        testName: true,
        testType: true,
        state: true,
        createdAt: true,
      },
    }),
  ]);

  res.json({ conversation, messages, proposals });
});

/** Send a turn. Returns immediately; the worker produces the reply. */
copilotRouter.post('/messages', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = chatMessageSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const conversation = input.conversationId
    ? await prisma.chatConversation.findUnique({ where: { id: input.conversationId } })
    : await prisma.chatConversation.create({
        data: {
          orgId: actor.orgId,
          projectId: project.id,
          // First message doubles as the title, the way every chat UI does it.
          title: input.message.slice(0, 60),
          createdBy: actor.userId,
        },
      });
  if (!conversation) throw notFound('Conversation');

  // One turn at a time: a second message while the agent is mid-tool-loop would
  // race two workers against the same transcript.
  const inFlight = await prisma.chatMessage.count({
    where: { conversationId: conversation.id, pending: true },
  });
  if (inFlight > 0) throw conflict('The agent is still working on the previous message');

  const message = await prisma.chatMessage.create({
    data: {
      orgId: actor.orgId,
      conversationId: conversation.id,
      role: 'user',
      content: input.message,
      userId: actor.userId,
    },
  });

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  await enqueue(QUEUE_NAMES.copilot, {
    orgId: actor.orgId,
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: message.id,
  });

  res.status(202).json({ conversationId: conversation.id, messageId: message.id });
});

/** Live tool-call events for the panel. */
copilotRouter.get('/conversations/:conversationId/events', async (req, res) => {
  const actor = actorOf(req);
  const conversationId = String(req.params.conversationId);

  const conversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  });
  if (!conversation) throw notFound('Conversation');

  // The worker publishes under this synthetic run id; see processors/copilot.ts.
  const unsubscribe = subscribe(actor.orgId, `chat:${conversationId}`, res);
  req.on('close', unsubscribe);
});

// ─── The approval gate ───────────────────────────────────────────────────────

copilotRouter.get('/proposals', async (req, res) => {
  const proposals = await prisma.agentProposal.findMany({
    where: { state: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({ proposals });
});

/**
 * Accept or reject a proposed change. This is the only path by which the
 * copilot's work reaches the suite.
 *
 * On accept, an edit writes a new TestVersion with source AGENT and a create
 * makes the test — either way the change lands through the same history that
 * hand edits and heals use, so `git log`-style questions have one answer.
 */
copilotRouter.post('/proposals/:proposalId/decide', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const accept = req.body?.accept === true;

  const proposal = await prisma.agentProposal.findUnique({
    where: { id: String(req.params.proposalId) },
  });
  if (!proposal) throw notFound('Proposal');
  if (proposal.state !== 'PENDING') throw conflict(`This proposal was already ${proposal.state}`);

  if (!accept) {
    const rejected = await prisma.agentProposal.update({
      where: { id: proposal.id },
      data: { state: 'REJECTED', decidedBy: actor.userId, decidedAt: new Date() },
    });
    await audit({
      actor,
      action: 'proposal.reject',
      targetType: 'AgentProposal',
      targetId: proposal.id,
      metadata: { filePath: proposal.filePath },
    });
    res.json({ proposal: rejected });
    return;
  }

  let testId = proposal.testId;

  if (testId) {
    const existing = await prisma.test.findUnique({
      where: { id: testId },
      select: { id: true, code: true },
    });
    if (!existing) throw notFound('Test');

    // The file may have moved on since the agent read it. Applying anyway would
    // silently discard whatever changed in between, so say so instead.
    if (existing.code !== proposal.oldCode && proposal.oldCode !== '') {
      throw conflict(
        'The test changed since this was proposed. Reject it and ask the agent to look again.',
      );
    }

    const latest = await prisma.testVersion.findFirst({
      where: { testId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    await prisma.test.update({
      where: { id: testId },
      data: {
        code: proposal.newCode,
        name: proposal.testName,
        reviewFlags: [],
        versions: {
          create: {
            orgId: actor.orgId,
            version: (latest?.version ?? 0) + 1,
            code: proposal.newCode,
            source: 'AGENT',
            authorId: actor.userId,
            message: proposal.rationale.slice(0, 300),
          },
        },
      },
    });
  } else {
    const suite = await prisma.suite.upsert({
      where: { projectId_name: { projectId: proposal.projectId, name: 'Copilot' } },
      create: {
        orgId: actor.orgId,
        projectId: proposal.projectId,
        name: 'Copilot',
        description: 'Tests written by the copilot and accepted by a human',
      },
      update: {},
    });

    const created = await prisma.test.create({
      data: {
        orgId: actor.orgId,
        projectId: proposal.projectId,
        suiteId: suite.id,
        name: proposal.testName,
        type: proposal.testType,
        feature: 'Copilot',
        priority: 'IMPORTANT',
        code: proposal.newCode,
        filePath: proposal.filePath,
        versions: {
          create: {
            orgId: actor.orgId,
            version: 1,
            code: proposal.newCode,
            source: 'AGENT',
            authorId: actor.userId,
            message: proposal.rationale.slice(0, 300),
          },
        },
      },
    });
    testId = created.id;
  }

  const applied = await prisma.agentProposal.update({
    where: { id: proposal.id },
    data: { state: 'APPLIED', decidedBy: actor.userId, decidedAt: new Date(), testId },
  });

  await audit({
    actor,
    action: 'proposal.apply',
    targetType: 'AgentProposal',
    targetId: proposal.id,
    metadata: { filePath: proposal.filePath, testId },
  });

  res.json({ proposal: applied, testId });
});
