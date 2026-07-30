/**
 * Git integrations (§7) — where a project's tests get pushed.
 *
 * A connection is a provider + repo + a personal access token. The token is
 * write-only: it is sealed into the vault on the way in and never comes back out
 * of any endpoint. Responses expose only `hasToken`, so the UI can say "a token
 * is stored" without ever holding one.
 */

import { Router } from 'express';
import { createIntegrationSchema, updateIntegrationSchema } from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { parseGitConfig, sealToken } from '../lib/integrations.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth);

/** Shape sent to clients — never includes configEnc or any token material. */
function present(row: {
  id: string;
  kind: string;
  name: string;
  config: unknown;
  configEnc: string | null;
  enabled: boolean;
  updatedAt: Date;
}) {
  const config = parseGitConfig(row.config);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    repo: config.repo,
    defaultBranch: config.defaultBranch,
    enabled: row.enabled,
    hasToken: row.configEnc !== null,
    updatedAt: row.updatedAt,
  };
}

integrationsRouter.get('/', async (_req, res) => {
  const rows = await prisma.integration.findMany({
    where: { kind: { in: ['GITHUB', 'GITLAB', 'BITBUCKET'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });
  res.json({ integrations: rows.map(present) });
});

integrationsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = createIntegrationSchema.parse(req.body);

  const existing = await prisma.integration.findFirst({
    where: { kind: input.kind, name: input.name },
    select: { id: true },
  });
  if (existing) throw conflict(`An integration named "${input.name}" already exists`);

  // Created first so the token's AAD can bind to the row's own id.
  const created = await prisma.integration.create({
    data: {
      orgId: actor.orgId,
      kind: input.kind,
      name: input.name,
      config: { repo: input.repo, defaultBranch: input.defaultBranch },
      enabled: true,
    },
    select: { id: true },
  });

  const sealed = sealToken(input.token, actor.orgId, created.id);
  const row = await prisma.integration.update({
    where: { id: created.id },
    data: {
      configEnc: sealed.ciphertext,
      config: {
        repo: input.repo,
        defaultBranch: input.defaultBranch,
        keyVersion: sealed.keyVersion,
      },
    },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });

  // Repo and provider are fine to record; the token never appears in metadata.
  await audit({
    actor,
    action: 'integration.connect',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: input.kind, repo: input.repo, branch: input.defaultBranch },
  });

  res.status(201).json({ integration: present(row) });
});

integrationsRouter.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateIntegrationSchema.parse(req.body);

  const current = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, config: true },
  });
  if (!current) throw notFound('Integration');

  const config = parseGitConfig(current.config);
  const nextConfig: { repo: string; defaultBranch: string; keyVersion?: number } = {
    repo: input.repo ?? config.repo,
    defaultBranch: input.defaultBranch ?? config.defaultBranch,
    ...(config.keyVersion !== undefined ? { keyVersion: config.keyVersion } : {}),
  };

  // Repointing the remote invalidates the stored token unless a new one is
  // supplied in the same request. A token is granted for a destination, so
  // silently carrying it to a different one is exactly the move an attacker
  // would make to have it delivered somewhere they control.
  const repoChanged = input.repo !== undefined && input.repo !== config.repo;

  if (input.token) {
    const sealed = sealToken(input.token, actor.orgId, current.id);
    nextConfig.keyVersion = sealed.keyVersion;
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: sealed.ciphertext },
    });
  } else if (repoChanged) {
    delete nextConfig.keyVersion;
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: null },
    });
  }

  const row = await prisma.integration.update({
    where: { id: current.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      config: nextConfig,
    },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });

  // The repo is recorded because a changed destination is the thing a reviewer
  // most needs to see; the token itself never appears.
  await audit({
    actor,
    action: 'integration.update',
    targetType: 'Integration',
    targetId: row.id,
    metadata: {
      repo: nextConfig.repo,
      repoChanged,
      rotatedToken: Boolean(input.token),
      tokenCleared: repoChanged && !input.token,
      enabled: row.enabled,
    },
  });

  res.json({ integration: present(row) });
});

integrationsRouter.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const row = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, kind: true, name: true },
  });
  if (!row) throw notFound('Integration');

  await prisma.integration.delete({ where: { id: row.id } });

  await audit({
    actor,
    action: 'integration.disconnect',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: row.kind, name: row.name },
  });

  res.json({ ok: true });
});
