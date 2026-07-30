/**
 * Projects, environments, and the secrets vault (§2).
 */

import { Router } from 'express';
import { parse as parseDotenv } from 'dotenv';
import {
  GIT_INTEGRATION_KINDS,
  PLAN_LIMITS,
  SECRET_MASK,
  createEnvironmentSchema,
  createProjectSchema,
  createTestSchema,
  gitPushSchema,
  importSecretsSchema,
  updateEnvironmentSchema,
  updateTestSchema,
  upsertSecretSchema,
} from '@qaai/shared';
import type { GitIntegrationKind } from '@qaai/shared';
import { DEFAULT_GATE_RULES } from '@qaai/runner';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound, planLimit } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { seal } from '../lib/vault.js';
import { buildRepoTree } from '../lib/repo-export.js';
import { zipTree } from '../lib/zip.js';
import { pushRepo } from '../lib/git.js';
import { openToken, parseGitConfig } from '../lib/integrations.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

/** SCREAMING_SNAKE_CASE, matching upsertSecretSchema — used to filter a pasted .env. */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export const projectsRouter: Router = Router();

projectsRouter.use(requireAuth);

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'project'
  );
}

projectsRouter.get('/', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      environments: { select: { id: true, name: true, kind: true, baseUrl: true } },
      _count: { select: { tests: true, runs: true } },
    },
  });
  res.json({ projects });
});

projectsRouter.post('/', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = createProjectSchema.parse(req.body);

  // Plan limits are enforced here rather than trusted to the UI (§9).
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: actor.orgId },
    select: { plan: true },
  });
  const used = await prisma.project.count({ where: { archivedAt: null } });
  const limit = PLAN_LIMITS[org.plan].maxProjects;
  if (used >= limit) {
    throw planLimit(`The ${PLAN_LIMITS[org.plan].label} plan allows ${limit} project(s)`, {
      limit: 'maxProjects',
      plan: org.plan,
    });
  }

  const slug = input.slug ?? slugify(input.name);
  if (await prisma.project.findFirst({ where: { slug } })) {
    throw conflict(`A project with the slug "${slug}" already exists`);
  }

  const project = await prisma.project.create({
    data: {
      orgId: actor.orgId,
      name: input.name,
      slug,
      repoUrl: input.repoUrl ?? null,
      primaryLanguage: input.primaryLanguage,
      primaryFramework: input.primaryFramework,
      gateRules: DEFAULT_GATE_RULES as unknown as object,
    },
    include: { environments: true },
  });

  await audit({
    actor,
    action: 'project.create',
    targetType: 'Project',
    targetId: project.id,
    metadata: { name: project.name, slug },
  });

  res.status(201).json({ project });
});

projectsRouter.get('/:projectId', async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    include: {
      environments: true,
      suites: { select: { id: true, name: true } },
      _count: { select: { tests: true, runs: true } },
    },
  });
  if (!project) throw notFound('Project');
  res.json({ project });
});

// ─── Environments ────────────────────────────────────────────────────────────

projectsRouter.post('/:projectId/environments', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = createEnvironmentSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const environment = await prisma.environment.create({
    data: {
      orgId: actor.orgId,
      projectId: project.id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
    },
  });

  await audit({
    actor,
    action: 'environment.create',
    targetType: 'Environment',
    targetId: environment.id,
    metadata: { name: input.name, kind: input.kind, baseUrl: input.baseUrl },
  });

  res.status(201).json({ environment });
});

// ─── Secrets (§1 vault) ──────────────────────────────────────────────────────

/** Names and hints only. Plaintext leaves the vault for test execution, never for a client. */
projectsRouter.get('/:projectId/environments/:environmentId/secrets', async (req, res) => {
  const secrets = await prisma.secret.findMany({
    where: { environmentId: String(req.params.environmentId) },
    select: { id: true, name: true, hint: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });

  res.json({
    secrets: secrets.map((s) => ({
      ...s,
      value: s.hint ? `${SECRET_MASK}${s.hint}` : SECRET_MASK,
    })),
  });
});

projectsRouter.put(
  '/:projectId/environments/:environmentId/secrets',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = upsertSecretSchema.parse(req.body);

    const environment = await prisma.environment.findUnique({
      where: { id: String(req.params.environmentId) },
      select: { id: true },
    });
    if (!environment) throw notFound('Environment');

    const sealed = seal(input.value, actor.orgId, input.name);

    const secret = await prisma.secret.upsert({
      where: { environmentId_name: { environmentId: environment.id, name: input.name } },
      create: {
        orgId: actor.orgId,
        environmentId: environment.id,
        name: input.name,
        valueEnc: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        hint: sealed.hint,
        createdBy: actor.userId,
      },
      update: { valueEnc: sealed.ciphertext, keyVersion: sealed.keyVersion, hint: sealed.hint },
      select: { id: true, name: true, hint: true, updatedAt: true },
    });

    // The value is never in the metadata — only that it changed.
    await audit({
      actor,
      action: 'secret.upsert',
      targetType: 'Secret',
      targetId: secret.id,
      metadata: { name: input.name, environmentId: environment.id },
    });

    res.json({ secret: { ...secret, value: `${SECRET_MASK}${secret.hint ?? ''}` } });
  },
);

/** List environments for a project (config only — secrets have their own route). */
projectsRouter.get('/:projectId/environments', async (req, res) => {
  const environments = await prisma.environment.findMany({
    where: { projectId: String(req.params.projectId) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      kind: true,
      baseUrl: true,
      createdAt: true,
      _count: { select: { secrets: true } },
    },
  });
  res.json({ environments });
});

/** Rename or repoint an environment. Kind is immutable (see updateEnvironmentSchema). */
projectsRouter.patch(
  '/:projectId/environments/:environmentId',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = updateEnvironmentSchema.parse(req.body);

    const environment = await prisma.environment.findUnique({
      where: { id: String(req.params.environmentId) },
      select: { id: true, projectId: true },
    });
    if (!environment || environment.projectId !== String(req.params.projectId)) {
      throw notFound('Environment');
    }

    const updated = await prisma.environment.update({
      where: { id: environment.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      },
      select: { id: true, name: true, kind: true, baseUrl: true },
    });

    await audit({
      actor,
      action: 'environment.update',
      targetType: 'Environment',
      targetId: environment.id,
      metadata: { name: updated.name, baseUrl: updated.baseUrl },
    });

    res.json({ environment: updated });
  },
);

/**
 * Delete an environment. Its secrets and auth profiles cascade (shredding the
 * vault entries), but runs reference it with RESTRICT — so an environment with
 * run history is refused rather than orphaning that history.
 */
projectsRouter.delete(
  '/:projectId/environments/:environmentId',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const environment = await prisma.environment.findUnique({
      where: { id: String(req.params.environmentId) },
      select: { id: true, projectId: true, name: true },
    });
    if (!environment || environment.projectId !== String(req.params.projectId)) {
      throw notFound('Environment');
    }

    const runCount = await prisma.run.count({ where: { environmentId: environment.id } });
    if (runCount > 0) {
      throw conflict(
        `This environment has ${runCount} run(s) in its history and can't be deleted. ` +
          `Remove its secrets individually instead.`,
      );
    }

    await prisma.environment.delete({ where: { id: environment.id } });

    await audit({
      actor,
      action: 'environment.delete',
      targetType: 'Environment',
      targetId: environment.id,
      metadata: { name: environment.name },
    });

    res.json({ ok: true });
  },
);

/** Remove a secret. Hard delete — the vault holds nothing recoverable anyway. */
projectsRouter.delete(
  '/:projectId/environments/:environmentId/secrets/:secretId',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const secret = await prisma.secret.findUnique({
      where: { id: String(req.params.secretId) },
      select: { id: true, name: true, environmentId: true },
    });
    if (!secret || secret.environmentId !== String(req.params.environmentId)) {
      throw notFound('Secret');
    }

    await prisma.secret.delete({ where: { id: secret.id } });

    await audit({
      actor,
      action: 'secret.delete',
      targetType: 'Secret',
      targetId: secret.id,
      metadata: { name: secret.name, environmentId: secret.environmentId },
    });

    res.json({ ok: true });
  },
);

/**
 * Bulk-import a pasted `.env` file into the vault. Each valid KEY=VALUE line is
 * sealed like a single upsert. Names that are not SCREAMING_SNAKE_CASE are
 * reported back (by name only) rather than silently dropped; no value is ever
 * echoed. `export ` prefixes and `#` comments are tolerated.
 */
projectsRouter.post(
  '/:projectId/environments/:environmentId/secrets/import',
  requireRole('ADMIN'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = importSecretsSchema.parse(req.body);

    const env = await prisma.environment.findUnique({
      where: { id: String(req.params.environmentId) },
      select: { id: true, projectId: true },
    });
    if (!env || env.projectId !== String(req.params.projectId)) throw notFound('Environment');

    // dotenv.parse handles quotes and comments; strip a leading `export ` first.
    const normalized = input.content.replace(/^\s*export\s+/gm, '');
    const parsed = parseDotenv(normalized);
    const entries = Object.entries(parsed);
    if (entries.length === 0) throw badRequest('No KEY=VALUE lines found');

    const imported: string[] = [];
    const skipped: string[] = [];

    const existing = input.overwrite
      ? new Set<string>()
      : new Set(
          (
            await prisma.secret.findMany({
              where: { environmentId: env.id },
              select: { name: true },
            })
          ).map((s) => s.name),
        );

    for (const [name, value] of entries) {
      if (!SECRET_NAME_RE.test(name) || value.length === 0 || value.length > 8192) {
        skipped.push(name);
        continue;
      }
      if (!input.overwrite && existing.has(name)) {
        skipped.push(name);
        continue;
      }
      const sealed = seal(value, actor.orgId, name);
      await prisma.secret.upsert({
        where: { environmentId_name: { environmentId: env.id, name } },
        create: {
          orgId: actor.orgId,
          environmentId: env.id,
          name,
          valueEnc: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
          hint: sealed.hint,
          createdBy: actor.userId,
        },
        update: { valueEnc: sealed.ciphertext, keyVersion: sealed.keyVersion, hint: sealed.hint },
      });
      imported.push(name);
    }

    await audit({
      actor,
      action: 'secret.import',
      targetType: 'Environment',
      targetId: env.id,
      metadata: { imported: imported.length, skipped: skipped.length },
    });

    res.json({ imported, skipped });
  },
);

/** Suites and tests for the cockpit's left pane. */
projectsRouter.get('/:projectId/tests', async (req, res) => {
  const tests = await prisma.test.findMany({
    where: { projectId: String(req.params.projectId), disabledAt: null },
    orderBy: [{ feature: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      type: true,
      feature: true,
      priority: true,
      filePath: true,
      tags: true,
      quarantined: true,
      flakeRate: true,
      lastRunAt: true,
      reviewFlags: true,
      suiteId: true,
    },
  });
  res.json({ tests });
});

projectsRouter.get('/:projectId/tests/:testId', async (req, res) => {
  const test = await prisma.test.findUnique({ where: { id: String(req.params.testId) } });
  if (!test || test.projectId !== req.params.projectId) throw notFound('Test');
  res.json({ test });
});

/**
 * Hand-edit a test (§8 — the editor).
 *
 * Every save writes a TestVersion with source HUMAN, so a human edit sits in
 * the same history as a Generator write or an applied Heal. That matters for
 * triage: "who last touched this test, and why" has one answer, not two.
 *
 * Saving also clears the Generator's review flags. They mean "a machine wrote
 * this and was unsure"; once a person has read and edited the file, that
 * warning is stale and leaving it up trains people to ignore the badge.
 */
projectsRouter.put('/:projectId/tests/:testId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateTestSchema.parse(req.body);

  const test = await prisma.test.findUnique({ where: { id: String(req.params.testId) } });
  if (!test || test.projectId !== String(req.params.projectId)) throw notFound('Test');

  if (input.code === test.code && input.name === undefined && input.spec === undefined) {
    res.json({ test, saved: false });
    return;
  }

  const latest = await prisma.testVersion.findFirst({
    where: { testId: test.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const updated = await prisma.test.update({
    where: { id: test.id },
    data: {
      code: input.code,
      ...(input.name ? { name: input.name } : {}),
      ...(input.spec !== undefined ? { spec: input.spec as object } : {}),
      reviewFlags: [],
      versions: {
        create: {
          orgId: actor.orgId,
          version: (latest?.version ?? 0) + 1,
          code: input.code,
          source: 'HUMAN',
          authorId: actor.userId,
          message: input.message ?? 'Edited in the QAAI editor',
        },
      },
    },
  });

  await audit({
    actor,
    action: 'test.update',
    targetType: 'Test',
    targetId: test.id,
    metadata: { name: updated.name, bytes: input.code.length },
  });

  res.json({ test: updated, saved: true });
});

/** Version history for the editor's sidebar. */
projectsRouter.get('/:projectId/tests/:testId/versions', async (req, res) => {
  const versions = await prisma.testVersion.findMany({
    where: { testId: String(req.params.testId) },
    orderBy: { version: 'desc' },
    take: 50,
    select: {
      id: true,
      version: true,
      source: true,
      message: true,
      authorId: true,
      createdAt: true,
    },
  });
  res.json({ versions });
});

/**
 * Create a test by hand, with no plan item behind it (§8).
 *
 * The spec's flow is Explorer proposes → human approves → Generator writes. This
 * is the escape hatch for the QA engineer who already knows exactly what they
 * want to write and does not want to negotiate with an agent about it.
 */
projectsRouter.post('/:projectId/tests', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = createTestSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const suite = await prisma.suite.upsert({
    where: { projectId_name: { projectId: project.id, name: 'Hand-written' } },
    create: {
      orgId: actor.orgId,
      projectId: project.id,
      name: 'Hand-written',
      description: 'Tests authored directly in the editor',
    },
    update: {},
  });

  const test = await prisma.test.create({
    data: {
      orgId: actor.orgId,
      projectId: project.id,
      suiteId: suite.id,
      name: input.name,
      type: input.type,
      feature: input.feature ?? 'Uncategorised',
      priority: input.priority,
      code: input.code,
      filePath: input.filePath,
      spec: (input.spec as object) ?? undefined,
      tags: input.tags,
      versions: {
        create: {
          orgId: actor.orgId,
          version: 1,
          code: input.code,
          source: 'HUMAN',
          authorId: actor.userId,
          message: 'Created in the QAAI editor',
        },
      },
    },
  });

  await audit({
    actor,
    action: 'test.create',
    targetType: 'Test',
    targetId: test.id,
    metadata: { name: test.name, type: test.type },
  });

  res.status(201).json({ test });
});

// ─── Repo export & git push (§7) ─────────────────────────────────────────────

/**
 * What a push or export would contain. Read-only: no remote is contacted and no
 * credential is touched, so this is safe to call freely before committing to a
 * push.
 */
projectsRouter.get('/:projectId/git/preview', async (req, res) => {
  const projectId = String(req.params.projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const { tree, secretNames, skipped } = await buildRepoTree({ projectId });
  const files = [...tree.entries()]
    .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content, 'utf8') }))
    .sort((a, b) => a.path.localeCompare(b.path));

  res.json({
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    /** Names only — the export deliberately carries no secret values. */
    secretNames,
    skipped,
  });
});

/**
 * Download the repo as a zip. Needs no integration and no token: the
 * credential-free way to take your tests and push them yourself.
 */
projectsRouter.get('/:projectId/git/export', async (req, res) => {
  const projectId = String(req.params.projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true },
  });
  if (!project) throw notFound('Project');

  const { tree } = await buildRepoTree({ projectId });
  const zip = await zipTree(tree);

  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', `attachment; filename="${project.slug}-tests.zip"`);
  res.setHeader('content-length', String(zip.byteLength));
  res.end(zip);
});

/**
 * Push the repo to a connected git remote.
 *
 * ADMIN-only and gated on `confirm: true` — a write to the customer's own repo is
 * never implicit. The token is decrypted here, handed to the push, and dropped;
 * it is never logged, audited, or returned. Failures are reported with the
 * provider's message only after it has been checked for credential material.
 */
projectsRouter.post('/:projectId/git/push', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = gitPushSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) throw notFound('Project');

  const integration = await prisma.integration.findUnique({
    where: { id: input.integrationId },
    select: { id: true, kind: true, config: true, configEnc: true, enabled: true },
  });
  if (!integration || !GIT_INTEGRATION_KINDS.includes(integration.kind as GitIntegrationKind)) {
    throw notFound('Integration');
  }
  if (!integration.enabled) throw badRequest('That integration is disabled');
  if (!integration.configEnc) throw badRequest('That integration has no token stored');

  const config = parseGitConfig(integration.config);
  if (!config.repo) throw badRequest('That integration has no repository configured');

  const branch = input.branch ?? config.defaultBranch;
  const token = openToken(
    integration.configEnc,
    config.keyVersion ?? 1,
    actor.orgId,
    integration.id,
  );

  const { tree } = await buildRepoTree({ projectId });

  let result;
  try {
    result = await pushRepo(tree, {
      kind: integration.kind as GitIntegrationKind,
      repo: config.repo,
      token,
      branch,
      message: input.message ?? `QAAI: sync ${tree.size} test files`,
      authorName: 'QAAI',
      authorEmail: 'bot@qaai.local',
    });
  } catch (err) {
    // Never surface raw provider output: it can echo the request, and the token
    // rode in an auth header. Report the shape of the failure, not its body.
    const message = err instanceof Error ? err.message : 'Push failed';
    const safe = message.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
    await audit({
      actor,
      action: 'git.push.failed',
      targetType: 'Project',
      targetId: projectId,
      metadata: { integrationId: integration.id, branch, reason: safe.slice(0, 200) },
    });
    throw badRequest(`Push failed: ${safe.slice(0, 300)}`);
  }

  await audit({
    actor,
    action: 'git.push',
    targetType: 'Project',
    targetId: projectId,
    metadata: {
      integrationId: integration.id,
      branch: result.branch,
      commitSha: result.commitSha,
      files: result.fileCount,
    },
  });

  res.json({ push: result });
});

/** Latest flow map, for the Flow Map screen (§8). */
projectsRouter.get('/:projectId/flow-map', async (req, res) => {
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId: String(req.params.projectId) },
    orderBy: { version: 'desc' },
  });
  if (!flowMap) throw notFound('Flow map');
  res.json({ flowMap });
});

export async function projectExists(projectId: string): Promise<boolean> {
  return (
    (await unscoped(() => prisma.project.count({ where: { id: projectId } }).catch(() => 0))) > 0
  );
}
