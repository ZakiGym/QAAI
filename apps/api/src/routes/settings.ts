/**
 * Org settings (§8): members, API keys, audit log.
 *
 * API keys are the load-bearing part — the CLI and CI have no session, so a key
 * is the only way they authenticate (§1). The raw key is shown exactly once, at
 * creation; only its hash is stored, so a database leak hands out no live
 * credentials.
 */

import { Router } from 'express';
import { API_KEY_PREFIX } from '@qaai/shared';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { generateApiKey } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { auditRowsToCsv } from '../lib/audit.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

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

settingsRouter.get('/audit', requireRole('ADMIN'), async (req, res) => {
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  if (req.query.format === 'csv') {
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="qaai-audit.csv"')
      .send(auditRowsToCsv(rows));
    return;
  }

  res.json({ entries: rows });
});
