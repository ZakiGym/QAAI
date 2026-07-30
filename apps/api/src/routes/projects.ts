/**
 * Projects, environments, and the secrets vault (§2).
 */

import { Router } from 'express';
import {
  PLAN_LIMITS,
  SECRET_MASK,
  createEnvironmentSchema,
  createProjectSchema,
  upsertSecretSchema,
} from '@qaai/shared';
import { DEFAULT_GATE_RULES } from '@qaai/runner';
import { prisma, unscoped } from '../lib/prisma.js';
import { conflict, notFound, planLimit } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { seal } from '../lib/vault.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

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
