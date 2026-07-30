/**
 * Projects, environments, and the secrets vault (§2).
 */

import { Router } from 'express';
import { parse as parseDotenv } from 'dotenv';
import {
  FIXTURE_PREFIX,
  GIT_INTEGRATION_KINDS,
  INLINE_EDIT_PREFIX,
  QUEUE_NAMES,
  PLAN_LIMITS,
  SECRET_MASK,
  createEnvironmentSchema,
  createProjectSchema,
  createTestSchema,
  gitPushSchema,
  deleteFolderSchema,
  importSecretsSchema,
  inlineEditRequestSchema,
  moveFolderSchema,
  moveTestSchema,
  locatorsFromFlowMap,
  updateEnvironmentSchema,
  updateTestSchema,
  upsertSecretSchema,
} from '@qaai/shared';
import type { FlowMap, GitIntegrationKind } from '@qaai/shared';
import { DEFAULT_GATE_RULES } from '@qaai/runner';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound, planLimit } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/queues.js';
import { seal } from '../lib/vault.js';
import { buildRepoTree } from '../lib/repo-export.js';
import { zipTree } from '../lib/zip.js';
import { pushRepo, repoHttpsUrl } from '../lib/git.js';
import { openToken, parseGitConfig } from '../lib/integrations.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';

/**
 * SCREAMING_SNAKE_CASE, matching upsertSecretSchema — used to filter a pasted
 * .env. The length cap matters as much as the shape: dotenv parses a stray line
 * of a pasted private key as a KEY (base64 lines often end in `=`), and real
 * env-var names are short while such fragments are long.
 */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,79}$/;

/** A value of `=` or similar punctuation is a mis-parsed line, not a credential. */
const MEANINGLESS_VALUE_RE = /^[=\-+/\s]*$/;

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

/**
 * Archive a project.
 *
 * There was no way to remove a project at all, which turned a half-finished
 * onboarding into a permanent dead end: the project existed, the retry hit
 * "slug already exists" and — on the Free plan's single-project limit — the
 * user could never create another one.
 *
 * Archived rather than deleted: runs, results and artifacts are the record of
 * what was tested, and a stray click should not erase them. The slug is freed
 * so the name can be reused immediately.
 */
projectsRouter.delete('/:projectId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true, name: true, slug: true, archivedAt: true },
  });
  if (!project || project.archivedAt) throw notFound('Project');

  await prisma.project.update({
    where: { id: project.id },
    data: {
      archivedAt: new Date(),
      // Free the slug so the same name can be used again straight away.
      slug: `${project.slug}-archived-${Date.now().toString(36)}`,
    },
  });

  await audit({
    actor,
    action: 'project.archive',
    targetType: 'Project',
    targetId: project.id,
    metadata: { name: project.name, slug: project.slug },
  });

  res.json({ ok: true });
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

/**
 * Names and hints only. Plaintext leaves the vault for test execution, never for
 * a client.
 *
 * MEMBER and up: the hint is the last four characters of a real credential, so it
 * is a (small) disclosure and does not belong to a read-only VIEWER.
 */
projectsRouter.get(
  '/:projectId/environments/:environmentId/secrets',
  requireRole('MEMBER'),
  async (req, res) => {
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
  },
);

projectsRouter.put(
  '/:projectId/environments/:environmentId/secrets',
  requireRole('ADMIN'),
  requireScope('secrets:write'),
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
  requireScope('secrets:write'),
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
  requireScope('secrets:write'),
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
    /**
     * Names we can PROVE are safe to echo, because they already exist as secret
     * names in this environment. Everything else is only counted.
     *
     * This matters more than it looks: dotenv parses a stray line of a pasted
     * private key or base64 blob as a KEY (base64 often ends in `=`), so a
     * rejected "name" can itself be secret material. No pattern reliably tells a
     * key name from a base64 fragment, so the rule is to never echo an unproven
     * one rather than to guess.
     */
    const skipped: string[] = [];
    /** Rejected because the name is not SCREAMING_SNAKE_CASE, or the value was empty/oversized. */
    let rejected = 0;

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
      if (
        !SECRET_NAME_RE.test(name) ||
        value.length === 0 ||
        value.length > 8192 ||
        MEANINGLESS_VALUE_RE.test(value)
      ) {
        rejected += 1;
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
      metadata: { imported: imported.length, skipped: skipped.length, rejected },
    });

    // `skipped` holds only names that passed SCREAMING_SNAKE_CASE *and* already
    // exist here — so echoing them discloses nothing. `rejected` is a bare count.
    res.json({ imported, skipped, rejected });
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

/** One version, WITH its code — the list omits code to stay small. */
projectsRouter.get('/:projectId/tests/:testId/versions/:versionId', async (req, res) => {
  const version = await prisma.testVersion.findUnique({
    where: { id: String(req.params.versionId) },
    select: {
      id: true,
      version: true,
      source: true,
      message: true,
      authorId: true,
      createdAt: true,
      code: true,
      testId: true,
    },
  });
  if (!version || version.testId !== String(req.params.testId)) throw notFound('Version');
  res.json({ version });
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
 *
 * MEMBER and up: this is a bulk export of every test in the project, so it is
 * gated above a read-only VIEWER even though the individual tests are readable.
 */
projectsRouter.get(
  '/:projectId/git/export',
  requireRole('MEMBER'),
  requireScope('tests:read'),
  async (req, res) => {
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
projectsRouter.post(
  '/:projectId/git/push',
  requireRole('ADMIN'),
  requireScope('git:push'),
  async (req, res) => {
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

  // Resolve (and host-pin) the destination BEFORE decrypting the token, so a
  // repointed remote can never cause the PAT to be produced at all.
  try {
    repoHttpsUrl(integration.kind as GitIntegrationKind, config.repo);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'Invalid repository');
  }

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


// ─── Quality surfaces (§4, §5) ───────────────────────────────────────────────

/**
 * Findings across the whole project — accessibility, security, performance,
 * localisation and visual. They were only ever visible inside one test result,
 * which made "what is wrong with this app" a question you could not ask.
 *
 * De-duplicated by (kind, code, location): the same axe violation on the same
 * element across forty runs is one problem, not forty.
 */
projectsRouter.get('/:projectId/findings', async (req, res) => {
  const projectId = String(req.params.projectId);
  const includeMuted = String(req.query.muted ?? '') === 'true';

  const rows = await prisma.finding.findMany({
    where: {
      testResult: { run: { projectId } },
      ...(includeMuted ? {} : { mutedAt: null }),
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
    select: {
      id: true,
      kind: true,
      severity: true,
      code: true,
      message: true,
      location: true,
      helpUrl: true,
      mutedAt: true,
      createdAt: true,
      testResult: {
        select: { id: true, runId: true, test: { select: { id: true, name: true } } },
      },
    },
  });

  const grouped = new Map<
    string,
    {
      id: string;
      kind: string;
      severity: string;
      code: string;
      message: string;
      location: string;
      helpUrl: string | null;
      mutedAt: Date | null;
      occurrences: number;
      lastSeenAt: Date;
      tests: string[];
    }
  >();

  for (const row of rows) {
    const key = `${row.kind}:${row.code}:${row.location}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (row.testResult?.test.name && !existing.tests.includes(row.testResult.test.name)) {
        existing.tests.push(row.testResult.test.name);
      }
      continue;
    }
    grouped.set(key, {
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      code: row.code,
      message: row.message,
      location: row.location,
      helpUrl: row.helpUrl,
      mutedAt: row.mutedAt,
      occurrences: 1,
      lastSeenAt: row.createdAt,
      tests: row.testResult?.test.name ? [row.testResult.test.name] : [],
    });
  }

  const RANK: Record<string, number> = { CRITICAL: 0, SERIOUS: 1, MODERATE: 2, MINOR: 3 };
  const findings = [...grouped.values()].sort(
    (a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || b.occurrences - a.occurrences,
  );

  res.json({ findings });
});

/** Mute a finding — it keeps recording but stops gating. */
projectsRouter.post('/:projectId/findings/:findingId/mute', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const muted = String(req.body?.muted ?? 'true') !== 'false';

  const finding = await prisma.finding.findUnique({
    where: { id: String(req.params.findingId) },
    select: { id: true, code: true },
  });
  if (!finding) throw notFound('Finding');

  await prisma.finding.update({
    where: { id: finding.id },
    data: { mutedAt: muted ? new Date() : null },
  });

  await audit({
    actor,
    action: muted ? 'finding.mute' : 'finding.unmute',
    targetType: 'Finding',
    targetId: finding.id,
    metadata: { code: finding.code },
  });

  res.json({ ok: true, muted });
});

/**
 * The flake radar. `flakeRate` has been maintained on every run and never
 * shown, so "which tests can I not trust" had no answer — the single most
 * corrosive question in a test suite.
 */
projectsRouter.get('/:projectId/flaky', async (req, res) => {
  const tests = await prisma.test.findMany({
    where: { projectId: String(req.params.projectId), disabledAt: null },
    orderBy: [{ quarantined: 'desc' }, { flakeRate: 'desc' }],
    select: {
      id: true,
      name: true,
      filePath: true,
      type: true,
      priority: true,
      flakeRate: true,
      quarantined: true,
      quarantinedAt: true,
      lastRunAt: true,
    },
  });

  // Everything with any instability, plus anything already quarantined.
  res.json({ tests: tests.filter((t) => t.flakeRate > 0 || t.quarantined) });
});

/** Quarantine a flaky test: it still runs, but it stops gating a deploy (§5). */
projectsRouter.post('/:projectId/tests/:testId/quarantine', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const quarantined = String(req.body?.quarantined ?? 'true') !== 'false';

  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    select: { id: true, projectId: true, name: true },
  });
  if (!test || test.projectId !== String(req.params.projectId)) throw notFound('Test');

  const updated = await prisma.test.update({
    where: { id: test.id },
    data: { quarantined, quarantinedAt: quarantined ? new Date() : null },
    select: { id: true, quarantined: true, quarantinedAt: true },
  });

  await audit({
    actor,
    action: quarantined ? 'test.quarantine' : 'test.unquarantine',
    targetType: 'Test',
    targetId: test.id,
    metadata: { name: test.name },
  });

  res.json({ test: updated });
});

/** Approved visual baselines, for the review screen. */
projectsRouter.get('/:projectId/baselines', async (req, res) => {
  const baselines = await prisma.visualBaseline.findMany({
    where: { projectId: String(req.params.projectId) },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      viewport: true,
      browser: true,
      imageKey: true,
      updatedAt: true,
      approvedBy: true,
      test: { select: { id: true, name: true, filePath: true } },
    },
  });
  res.json({ baselines });
});

/**
 * Re-approve a baseline from a run's captured screenshot — the "yes, that
 * change was intended" action. Without it the only way to accept a deliberate
 * redesign was to delete the row by hand.
 */
projectsRouter.post('/:projectId/baselines/:baselineId/approve', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const imageKey = String(req.body?.imageKey ?? '');
  if (!imageKey) throw badRequest('imageKey is required');

  const baseline = await prisma.visualBaseline.findUnique({
    where: { id: String(req.params.baselineId) },
    select: { id: true, projectId: true, testId: true },
  });
  if (!baseline || baseline.projectId !== String(req.params.projectId)) throw notFound('Baseline');

  const updated = await prisma.visualBaseline.update({
    where: { id: baseline.id },
    data: { imageKey, approvedBy: actor.userId },
    select: { id: true, imageKey: true, updatedAt: true },
  });

  await audit({
    actor,
    action: 'baseline.approve',
    targetType: 'VisualBaseline',
    targetId: baseline.id,
    metadata: { testId: baseline.testId },
  });

  res.json({ baseline: updated });
});

// ─── File operations (§8) ────────────────────────────────────────────────────

/**
 * Paths are written to disk by the runner and committed by the exporter, so a
 * path is normalised in one place rather than trusted from wherever it came.
 * `relativeFilePath` in the schema already rejects traversal.
 */
function normalisePath(input: string): string {
  const cleaned = input.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return cleaned
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}

/**
 * `fixtures/` decides whether a row is a TEST or DATA — it is excluded from run
 * selection and materialised into every workspace. That boundary was previously
 * enforced only on read, so a move could silently turn a runnable test into a
 * file that never runs again. It is enforced here, on the write.
 */
function assertFixtureBoundary(path: string, hasRunnableCode: boolean): void {
  if (path.startsWith(FIXTURE_PREFIX) && hasRunnableCode && !path.endsWith('.json')) {
    throw badRequest(
      `Moving a test into ${FIXTURE_PREFIX} would stop it ever running — that folder holds ` +
        `test data, not tests. Move it elsewhere, or save it as .json if it really is data.`,
    );
  }
}

/** Rename or move one file. */
projectsRouter.patch('/:projectId/tests/:testId/path', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = moveTestSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    select: { id: true, projectId: true, filePath: true, name: true, code: true },
  });
  if (!test || test.projectId !== projectId) throw notFound('Test');

  const target = normalisePath(input.filePath);
  if (!target) throw badRequest('A file needs a name');

  const hasRunnableCode = test.code.trim().length > 0 && !test.filePath.endsWith('.json');
  assertFixtureBoundary(target, hasRunnableCode);

  if (target !== test.filePath) {
    const clash = await prisma.test.findFirst({
      where: { projectId, filePath: target, disabledAt: null, id: { not: test.id } },
      select: { id: true },
    });
    if (clash) throw conflict(`${target} already exists`);
  }

  const updated = await prisma.test.update({
    where: { id: test.id },
    data: { filePath: target, ...(input.name ? { name: input.name } : {}) },
    select: { id: true, name: true, filePath: true },
  });

  await audit({
    actor,
    action: 'test.move',
    targetType: 'Test',
    targetId: test.id,
    metadata: { from: test.filePath, to: target },
  });

  res.json({ test: updated });
});

/**
 * Delete a file. Soft, via `disabledAt` — the column existed and nothing ever
 * wrote it, so deleting was impossible. Soft because a test carries its version
 * history and its past run results; hard-deleting would quietly rewrite the
 * record of what was tested when.
 */
projectsRouter.delete('/:projectId/tests/:testId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    select: { id: true, projectId: true, name: true, filePath: true, disabledAt: true },
  });
  if (!test || test.projectId !== String(req.params.projectId)) throw notFound('Test');
  if (test.disabledAt) throw conflict('That file is already deleted');

  await prisma.test.update({ where: { id: test.id }, data: { disabledAt: new Date() } });

  await audit({
    actor,
    action: 'test.delete',
    targetType: 'Test',
    targetId: test.id,
    metadata: { name: test.name, filePath: test.filePath },
  });

  res.json({ ok: true });
});

/** Restore a soft-deleted file. */
projectsRouter.post('/:projectId/tests/:testId/restore', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    select: { id: true, projectId: true, filePath: true, disabledAt: true },
  });
  if (!test || test.projectId !== String(req.params.projectId)) throw notFound('Test');
  if (!test.disabledAt) throw conflict('That file is not deleted');

  // Its old path may have been taken while it was gone.
  const clash = await prisma.test.findFirst({
    where: {
      projectId: test.projectId,
      filePath: test.filePath,
      disabledAt: null,
      id: { not: test.id },
    },
    select: { id: true },
  });
  if (clash) throw conflict(`${test.filePath} is occupied — rename that file first`);

  const restored = await prisma.test.update({
    where: { id: test.id },
    data: { disabledAt: null },
    select: { id: true, name: true, filePath: true },
  });

  await audit({
    actor,
    action: 'test.restore',
    targetType: 'Test',
    targetId: test.id,
    metadata: { filePath: test.filePath },
  });

  res.json({ test: restored });
});

/** Copy a file, so a near-identical test does not have to be retyped. */
projectsRouter.post(
  '/:projectId/tests/:testId/duplicate',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);

    const source = await prisma.test.findUnique({ where: { id: String(req.params.testId) } });
    if (!source || source.projectId !== projectId) throw notFound('Test');

    // `a/b.spec.ts` → `a/b-copy.spec.ts`; the compound suffix stays intact so
    // Playwright still collects the copy.
    const compound = /(\.(?:spec|test)\.[cm]?[jt]sx?)$/.exec(source.filePath);
    const ext = compound ? compound[1]! : (/(\.[^./]+)$/.exec(source.filePath)?.[1] ?? '');
    const stem = ext ? source.filePath.slice(0, -ext.length) : source.filePath;

    let filePath = `${stem}-copy${ext}`;
    for (let n = 2; n < 100; n++) {
      const taken = await prisma.test.findFirst({
        where: { projectId, filePath, disabledAt: null },
        select: { id: true },
      });
      if (!taken) break;
      filePath = `${stem}-copy-${n}${ext}`;
    }

    const copy = await prisma.test.create({
      data: {
        orgId: actor.orgId,
        projectId,
        suiteId: source.suiteId,
        name: `${source.name} (copy)`,
        type: source.type,
        feature: source.feature,
        priority: source.priority,
        code: source.code,
        filePath,
        spec: (source.spec as object) ?? undefined,
        tags: source.tags,
        versions: {
          create: {
            orgId: actor.orgId,
            version: 1,
            code: source.code,
            source: 'HUMAN',
            authorId: actor.userId,
            message: `Duplicated from ${source.filePath}`,
          },
        },
      },
      select: { id: true, name: true, filePath: true },
    });

    await audit({
      actor,
      action: 'test.duplicate',
      targetType: 'Test',
      targetId: copy.id,
      metadata: { from: source.filePath, to: filePath },
    });

    res.status(201).json({ test: copy });
  },
);

/** Rename or move a folder — rewrites the path prefix on everything beneath it. */
projectsRouter.post('/:projectId/folders/move', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = moveFolderSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const from = normalisePath(input.from);
  const to = normalisePath(input.to);
  if (!from || !to) throw badRequest('Both a source and a destination folder are required');
  if (from === to) throw badRequest('The source and destination are the same');
  // Moving a folder inside itself would rewrite the prefix forever.
  if (to.startsWith(`${from}/`)) throw badRequest('A folder cannot be moved inside itself');

  const contents = await prisma.test.findMany({
    where: { projectId, disabledAt: null, filePath: { startsWith: `${from}/` } },
    select: { id: true, filePath: true, code: true },
  });
  if (contents.length === 0) throw notFound('Folder');

  const moves = contents.map((t) => ({
    id: t.id,
    to: `${to}/${t.filePath.slice(from.length + 1)}`,
    hasRunnableCode: t.code.trim().length > 0 && !t.filePath.endsWith('.json'),
  }));

  for (const move of moves) assertFixtureBoundary(move.to, move.hasRunnableCode);

  const clashes = await prisma.test.findMany({
    where: {
      projectId,
      disabledAt: null,
      filePath: { in: moves.map((m) => m.to) },
      id: { notIn: moves.map((m) => m.id) },
    },
    select: { filePath: true },
  });
  if (clashes.length > 0) {
    throw conflict(`${clashes[0]!.filePath} already exists in the destination`);
  }

  // One transaction: a half-moved folder is worse than a failed move.
  await prisma.$transaction(
    moves.map((m) => prisma.test.update({ where: { id: m.id }, data: { filePath: m.to } })),
  );

  await audit({
    actor,
    action: 'folder.move',
    targetType: 'Project',
    targetId: projectId,
    metadata: { from, to, files: moves.length },
  });

  res.json({ moved: moves.length, from, to });
});

/** Soft-delete every file in a folder. */
projectsRouter.post('/:projectId/folders/delete', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = deleteFolderSchema.parse(req.body);
  const projectId = String(req.params.projectId);
  const path = normalisePath(input.path);
  if (!path) throw badRequest('A folder is required');

  const result = await prisma.test.updateMany({
    where: { projectId, disabledAt: null, filePath: { startsWith: `${path}/` } },
    data: { disabledAt: new Date() },
  });

  await audit({
    actor,
    action: 'folder.delete',
    targetType: 'Project',
    targetId: projectId,
    metadata: { path, files: result.count },
  });

  res.json({ deleted: result.count, path });
});

// ─── Editor intelligence (§8) ────────────────────────────────────────────────

/**
 * Locators the last crawl actually found, for editor autocomplete.
 *
 * Entirely deterministic — this reads the flow map, so it works with no model
 * and no API key. It is also the thing a general-purpose coding assistant
 * structurally cannot offer: it knows what is really on the page.
 */
projectsRouter.get('/:projectId/locators', async (req, res) => {
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId: String(req.params.projectId) },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true, createdAt: true },
  });

  if (!flowMap) {
    res.json({ locators: [], version: null, crawledAt: null });
    return;
  }

  res.json({
    locators: locatorsFromFlowMap(flowMap.graph as unknown as FlowMap).slice(0, 300),
    version: flowMap.version,
    crawledAt: flowMap.createdAt,
  });
});

/**
 * Ask the agent to rewrite a test from a plain-English instruction (⌘K).
 *
 * Enqueued rather than answered inline, because the API holds no model client —
 * the row is created here so the client has something to poll immediately.
 */
projectsRouter.post(
  '/:projectId/tests/:testId/inline-edit',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = inlineEditRequestSchema.parse(req.body);
    const projectId = String(req.params.projectId);

    const test = await prisma.test.findUnique({
      where: { id: String(req.params.testId) },
      select: { id: true, name: true, type: true, filePath: true, code: true, projectId: true },
    });
    if (!test || test.projectId !== projectId) throw notFound('Test');

    const proposal = await prisma.agentProposal.create({
      data: {
        orgId: actor.orgId,
        projectId,
        // No FK here; the prefix namespaces inline edits so they never show up
        // in the copilot's proposal inbox.
        conversationId: `${INLINE_EDIT_PREFIX}${test.id}`,
        testId: test.id,
        filePath: test.filePath,
        oldCode: test.code,
        newCode: '',
        rationale: input.instruction,
        testName: test.name,
        testType: test.type,
        state: 'PENDING',
      },
      select: { id: true },
    });

    await enqueue(QUEUE_NAMES.edit, {
      orgId: actor.orgId,
      projectId,
      proposalId: proposal.id,
      instruction: input.instruction,
      selection: input.selection,
      selectionStartLine: input.selectionStartLine,
      selectionEndLine: input.selectionEndLine,
    });

    res.status(202).json({ proposalId: proposal.id });
  },
);

/** Poll target for an inline edit. `newCode: ''` means still working. */
projectsRouter.get('/:projectId/inline-edit/:proposalId', async (req, res) => {
  const proposal = await prisma.agentProposal.findUnique({
    where: { id: String(req.params.proposalId) },
    select: {
      id: true,
      state: true,
      oldCode: true,
      newCode: true,
      rationale: true,
      filePath: true,
    },
  });
  if (!proposal || !proposal.filePath) throw notFound('Edit');

  res.json({
    edit: {
      ...proposal,
      ready: proposal.newCode.length > 0,
      failed: proposal.state === 'REJECTED' && proposal.newCode.length === 0,
    },
  });
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
