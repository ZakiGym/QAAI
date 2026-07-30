/**
 * Projects, environments, and the secrets vault (§2).
 */

import { Router } from 'express';
import {
  PLAN_LIMITS,
  SECRET_MASK,
  createEnvironmentSchema,
  createProjectSchema,
  createTestSchema,
  updateTestSchema,
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
