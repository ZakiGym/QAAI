/**
 * Org settings (§8): members, API keys, audit log.
 *
 * API keys are the load-bearing part — the CLI and CI have no session, so a key
 * is the only way they authenticate (§1). The raw key is shown exactly once, at
 * creation; only its hash is stored, so a database leak hands out no live
 * credentials.
 */

import { Router } from 'express';
import { API_KEY_PREFIX, inviteSchema } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateApiKey, generateToken, hashToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { auditRowsToCsv } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { env } from '../env.js';

export const settingsRouter: Router = Router();

settingsRouter.use(requireAuth);

// ─── Members ─────────────────────────────────────────────────────────────────

settingsRouter.get('/members', async (req, res) => {
  const actor = actorOf(req);
  const memberships = await prisma.membership.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: 'asc' },
  });

  // Users are a global table, so this read is unscoped by necessity — the ids
  // come from the org's own memberships, so no cross-tenant data is exposed.
  const users = await unscoped(() =>
    prisma.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, email: true, name: true },
    }),
  );
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    members: memberships.map((m) => ({
      userId: m.userId,
      role: m.role,
      name: byId.get(m.userId)?.name ?? '',
      email: byId.get(m.userId)?.email ?? '',
      joinedAt: m.createdAt,
    })),
  });
});

// ─── API keys (§1) ───────────────────────────────────────────────────────────

settingsRouter.get('/api-keys', async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: 'desc' },
    // The hash is never returned; the prefix is the only recoverable part.
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  res.json({ keys });
});

settingsRouter.post('/api-keys', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw badRequest('A name is required');

  const scopes: string[] = Array.isArray(req.body?.scopes)
    ? req.body.scopes
    : ['runs:write', 'runs:read'];

  const { raw, hash, prefix } = generateApiKey();

  const key = await prisma.apiKey.create({
    // orgId is stamped by the tenancy extension; naming it satisfies the type.
    data: { orgId: actor.orgId, name, keyHash: hash, keyPrefix: prefix, scopes },
    select: { id: true, name: true, keyPrefix: true, scopes: true, createdAt: true },
  });

  await audit({
    actor,
    action: 'apikey.create',
    targetType: 'ApiKey',
    targetId: key.id,
    metadata: { name, scopes },
  });

  // The only time the full key exists outside a CI's secret store. There is no
  // way to see it again — the client must copy it now.
  res.status(201).json({ key: { ...key, secret: raw, prefix: API_KEY_PREFIX } });
});

settingsRouter.delete('/api-keys/:keyId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const key = await prisma.apiKey.findUnique({ where: { id: String(req.params.keyId) } });
  if (!key) throw notFound('API key');

  await prisma.apiKey.update({
    where: { id: key.id },
    data: { revokedAt: new Date() },
  });

  await audit({
    actor,
    action: 'apikey.revoke',
    targetType: 'ApiKey',
    targetId: key.id,
    metadata: { name: key.name },
  });

  res.json({ ok: true });
});

// ─── Audit log (§1) ──────────────────────────────────────────────────────────

/**
 * The audit trail. Every mutation has been recorded since the first commit and
 * nothing ever read it back, which makes an audit log a compliance checkbox
 * rather than a tool. Actor ids are resolved to names in one extra query so the
 * log is readable rather than a wall of cuids.
 *
 * ADMIN-only: it names who did what, which is not everyone's business.
 */
settingsRouter.get('/audit', requireRole('ADMIN'), async (req, res) => {
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const rows = await prisma.auditLog.findMany({
    where: { ...(action ? { action: { startsWith: action } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Number(req.query.limit ?? 200)),
  });

  if (req.query.format === 'csv') {
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="qaai-audit.csv"')
      .send(auditRowsToCsv(rows));
    return;
  }

  // One lookup for every distinct actor, rather than N queries.
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await unscoped(() =>
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        }),
      )
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    entries: rows.map((r) => ({
      ...r,
      actor: r.userId
        ? (byId.get(r.userId)?.name ?? byId.get(r.userId)?.email ?? 'unknown')
        : 'system',
    })),
  });
});

// ─── Audit log & usage (§11, §9) ─────────────────────────────────────────────

/**
 * The audit trail. Every mutation has been recorded since the first commit —
 * actor, action, target, masked metadata — and nothing has ever read it back,
 * which makes an audit log a compliance checkbox rather than a tool.
 *
 * ADMIN-only: it names who did what, which is not everyone's business.
 */
/**
 * What the AI has cost. Every model call already records its tokens, its
 * latency and its price; none of it was visible, so "what am I paying for
 * this" was unanswerable — a bad property for a product that bills partly on
 * model usage.
 */
settingsRouter.get('/usage', async (req, res) => {
  const days = Math.min(90, Number(req.query.days ?? 30));
  const since = new Date(Date.now() - days * 86_400_000);

  const calls = await prisma.agentCall.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: {
      agent: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      costCents: true,
      durationMs: true,
      error: true,
      createdAt: true,
    },
  });

  const byAgent = new Map<
    string,
    { agent: string; calls: number; inputTokens: number; outputTokens: number; costCents: number; failures: number }
  >();

  for (const call of calls) {
    const row = byAgent.get(call.agent) ?? {
      agent: call.agent,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      failures: 0,
    };
    row.calls += 1;
    row.inputTokens += call.inputTokens + call.cacheReadTokens;
    row.outputTokens += call.outputTokens;
    row.costCents += call.costCents;
    if (call.error) row.failures += 1;
    byAgent.set(call.agent, row);
  }

  res.json({
    days,
    totalCalls: calls.length,
    totalCostCents: calls.reduce((sum, c) => sum + c.costCents, 0),
    byAgent: [...byAgent.values()].sort((a, b) => b.costCents - a.costCents),
  });
});

/**
 * Invite a teammate. Settings has said "email invites are not built yet" since
 * the beginning; the Invite model existed the whole time. No email is sent —
 * this mints a link the inviter shares, which is honest about what the
 * deployment can actually do rather than silently dropping mail.
 */
settingsRouter.post('/invites', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = inviteSchema.parse(req.body);

  const existingMember = await unscoped(() =>
    prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
  );
  if (existingMember) {
    const already = await prisma.membership.findFirst({
      where: { userId: existingMember.id },
      select: { id: true },
    });
    if (already) throw conflict('That person is already in this organisation');
  }

  // Stored as a hash, exactly like an API key: the raw token is shown once and
  // is unrecoverable afterwards.
  const token = generateToken();
  const invite = await prisma.invite.create({
    data: {
      orgId: actor.orgId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: actor.userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  });

  await audit({
    actor,
    action: 'invite.create',
    targetType: 'Invite',
    targetId: invite.id,
    metadata: { email: input.email, role: input.role },
  });

  res.status(201).json({
    invite,
    // Shown once so the admin can pass it on however they like.
    acceptUrl: `${env.WEB_PUBLIC_URL}/signup?invite=${token}`,
  });
});

settingsRouter.get('/invites', requireRole('ADMIN'), async (_req, res) => {
  const invites = await prisma.invite.findMany({
    where: { acceptedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  res.json({ invites });
});
