/**
 * Projects, environments, and the secrets vault (§2).
 */

import { createHash } from 'node:crypto';

import { Router } from 'express';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import {
  CLOSURE_APPROVAL_POLICIES,
  FIXTURE_PREFIX,
  GIT_INTEGRATION_KINDS,
  INLINE_EDIT_PREFIX,
  QUEUE_NAMES,
  PLAN_LIMITS,
  SECRET_MASK,
  SPEC_DRIVEN_TEST_TYPES,
  AUTH_PROFILE_CONFIG_SCHEMAS,
  authProfileSchema,
  createEnvironmentSchema,
  createProjectSchema,
  createMonitorSchema,
  createScheduleSchema,
  createTestSchema,
  gitPushSchema,
  deleteFolderSchema,
  importSecretsSchema,
  inlineEditRequestSchema,
  moveFolderSchema,
  moveTestSchema,
  locatorsFromFlowMap,
  isSupportedPair,
  pairMessage,
  updateEnvironmentSchema,
  updateGateRulesSchema,
  updateProjectSchema,
  updateTestSchema,
  upsertSecretSchema,
} from '@qaai/shared';
import type {
  FlowMap,
  GitIntegrationKind,
  Language,
  OwnershipVerdict,
  TestResultStatus,
  UiFramework,
} from '@qaai/shared';
import {
  DEFAULT_GATE_RULES,
  checkQuarantineBudget,
  quarantineExpiryFrom,
  quarantineSuppresses,
} from '@qaai/runner';
import { prisma, unscoped } from '../lib/prisma.js';
import { badRequest, conflict, notFound, planLimit, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/queues.js';
import { open as openSecret, seal } from '../lib/vault.js';
import { buildRepoTree } from '../lib/repo-export.js';
import { zipTree } from '../lib/zip.js';
import {
  MAX_REPORTED_PATHS,
  pullRequestAudit,
  pullRequestStore,
  pushRepo,
  repoHttpsUrl,
} from '../lib/git.js';
import type { OwnershipRecord, RepoOwnership } from '../lib/git.js';
/*
 * ── THE OUTWARD-FACING WRITE, THROUGH THE ONE SEAM THAT ALREADY EXISTS ─────
 *
 * `openPullRequest` is the policy, `githubPullRequestHost` is the single
 * injected git-host seam (it lives in github-app.ts with the injected fetch, the
 * installation token and the pinned API host), and
 * `pullRequestStore`/`pullRequestAudit` are its Prisma halves in git.ts. This
 * route adds a DOOR onto them and not a second path: a pull request composed
 * anywhere else would be a second place that decides what a repository, a branch
 * and a base ref may be.
 */
import { branchNameFor, openPullRequest, prCauseKey } from '../lib/pull-request.js';
import { githubPullRequestHost } from '../lib/github-app.js';
import { signInWithProfile } from '@qaai/runner';
import { openToken, parseGitConfig } from '../lib/integrations.js';
import { canCreateProject, planFor } from '../lib/plan.js';
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

  // Plan limits are enforced here rather than trusted to the UI (§9). See the
  // note in runs.ts on why this asks canCreateProject() rather than reading
  // Organization.plan, which records what was bought and not what is paid for.
  const verdict = await canCreateProject(actor.orgId);
  if (!verdict.allowed) {
    const { plan } = await planFor(actor.orgId);
    throw planLimit(verdict.reason ?? 'Plan limit reached', { limit: 'maxProjects', plan });
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
 * The closure autopilot's three settings, validated here.
 *
 * ── Why these are a door at all ─────────────────────────────────────────────
 *
 * `Project.coverageTargetPercent` IS THE AUTOPILOT'S ON SWITCH: the close-loop
 * sweep arms a campaign for a project that has one and ignores every project
 * that does not. Nothing in the API could set it, so the whole feature —
 * campaigns, budgets, the closure ledger, the nightly tick — was reachable only
 * by a seed script or by somebody with a psql prompt. A feature that ships
 * without the switch that turns it on has not shipped.
 *
 * ── Why the schema is local ─────────────────────────────────────────────────
 *
 * `updateProjectSchema` lives in @qaai/shared and is not this change's file, so
 * it is EXTENDED here rather than restated: `name`, `primaryLanguage` and
 * `primaryFramework` keep their one definition, and the `.refine` that answers
 * "nothing to update" is inherited and now sees all six fields. Restating the
 * first three locally would be two validators for one request shape, which is
 * the drift this repo keeps paying for. The right end state is these three
 * beside the others in the shared schema — see the handover.
 *
 * ── The three rules, each one a way to spend somebody's money ───────────────
 *
 *  · `coverageTargetPercent` is 1-100 and NULLABLE, and null is how the
 *    autopilot is switched back OFF. 0 is deliberately not allowed: a target of
 *    zero is met by every project on earth, so a campaign armed on it would
 *    arm and immediately settle, which looks exactly like a broken loop.
 *  · `closureApprovalPolicy` is validated against the shared vocabulary rather
 *    than a local pair of strings. The column is TEXT, so a typo here is not a
 *    value the database refuses — it is a value `approvalPolicyOf` does not
 *    recognise, which falls back to HUMAN_REVIEW. That fallback is the safe
 *    direction and is exactly why it must not be reachable: a team that typed
 *    `AUTO_APPROVVE` would believe they had switched unattended generation on.
 *  · `closureItemBudget` is 1-200. It is the money cap — every item is a model
 *    call and eventually a browser — so there is no unbounded setting, and the
 *    documented default (40) is what null means.
 */
const updateProjectClosureSchema = updateProjectSchema.extend({
  coverageTargetPercent: z.number().int().min(1).max(100).nullable().optional(),
  closureApprovalPolicy: z.enum(CLOSURE_APPROVAL_POLICIES).nullable().optional(),
  closureItemBudget: z.number().int().min(1).max(200).nullable().optional(),
});

/**
 * Rename an app, change the language and framework its tests are written in, or
 * arm the closure autopilot.
 *
 * The first-run funnel says on every step that nothing it asks is binding.
 * That was false: language and framework were set once at create time and
 * there was no route to change them, so a person who picked TypeScript on
 * their way in and then wanted Python had to archive the app — losing its runs,
 * its plan and its history — to get a different answer.
 *
 * The pair is validated against the MERGED row rather than against the request.
 * A body carrying only `primaryLanguage: 'RUBY'` is a perfectly well-formed
 * fragment that would leave a TypeScript project's Playwright pointing at a
 * language the generator cannot emit it for; the schema cannot see that,
 * because the schema never sees the row.
 */
projectsRouter.patch('/:projectId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateProjectClosureSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: {
      id: true,
      name: true,
      primaryLanguage: true,
      primaryFramework: true,
      archivedAt: true,
      // Read because the audit row carries the BEFORE value of each of them,
      // and because switching the autopilot on is the one change here that
      // starts spending model calls unattended.
      coverageTargetPercent: true,
      closureApprovalPolicy: true,
      closureItemBudget: true,
    },
  });
  if (!project || project.archivedAt) throw notFound('Project');

  const language = (input.primaryLanguage ?? project.primaryLanguage) as Language;
  const framework = (input.primaryFramework ?? project.primaryFramework) as UiFramework;
  if (!isSupportedPair(language, framework)) {
    throw unprocessable(pairMessage(language, framework));
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      primaryLanguage: language,
      primaryFramework: framework,
      /*
       * Each of the three only when the body NAMED it, which is what keeps an
       * explicit `null` (switch the autopilot off, fall back to the documented
       * default) different from an absent key (leave it alone). A spread of
       * `{ coverageTargetPercent: input.coverageTargetPercent }` would clear
       * all three on every rename.
       */
      ...(input.coverageTargetPercent !== undefined
        ? { coverageTargetPercent: input.coverageTargetPercent }
        : {}),
      ...(input.closureApprovalPolicy !== undefined
        ? { closureApprovalPolicy: input.closureApprovalPolicy }
        : {}),
      ...(input.closureItemBudget !== undefined
        ? { closureItemBudget: input.closureItemBudget }
        : {}),
    },
    include: { environments: true, _count: { select: { tests: true, runs: true } } },
  });

  /*
   * The BEFORE values are in the metadata as well as the after. Changing the
   * framework silently re-points every future generation at a different runner,
   * and "it used to write Playwright" is the question someone asks a week later
   * when a generated suite stops matching the one they already had.
   *
   * The autopilot's three are in the same row for a sharper reason:
   * `coverageTargetPercent` going from null to a number is the moment this
   * project starts proposing plan items, calling a model and writing tests
   * overnight with nobody watching. `armed` is on the row as its own boolean so
   * that moment can be FOUND — an audit log somebody has to diff two numbers
   * in to spot the most consequential change in it is not an audit log.
   */
  const armed = project.coverageTargetPercent === null && updated.coverageTargetPercent !== null;
  await audit({
    actor,
    action: 'project.update',
    targetType: 'Project',
    targetId: project.id,
    metadata: {
      from: {
        name: project.name,
        primaryLanguage: project.primaryLanguage,
        primaryFramework: project.primaryFramework,
        coverageTargetPercent: project.coverageTargetPercent,
        closureApprovalPolicy: project.closureApprovalPolicy,
        closureItemBudget: project.closureItemBudget,
      },
      to: {
        name: updated.name,
        primaryLanguage: updated.primaryLanguage,
        primaryFramework: updated.primaryFramework,
        coverageTargetPercent: updated.coverageTargetPercent,
        closureApprovalPolicy: updated.closureApprovalPolicy,
        closureItemBudget: updated.closureItemBudget,
      },
      closureAutopilot: {
        armed,
        disarmed: project.coverageTargetPercent !== null && updated.coverageTargetPercent === null,
        /*
         * Said in words on the row that arms it, because the policy decides
         * whether the loop writes code unattended or queues it for a human,
         * and null means the cautious default rather than "no policy".
         */
        approvalPolicy: updated.closureApprovalPolicy ?? 'HUMAN_REVIEW (default)',
      },
    },
  });

  res.json({ project: updated });
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
      /*
       * Which on-prem runner pool executes this environment's runs, or null for
       * QAAI's own workers.
       *
       * The schema accepted this field before anything persisted it, so a
       * customer could set a pool, get a 201, and watch every run go to the
       * shared cloud queue anyway — the exact shape of "correct code connected
       * to nothing" this repo keeps finding. `?? null` rather than a spread,
       * because an environment created without a pool must be explicitly
       * cloud-run, not merely unspecified.
       */
      runnerPool: input.runnerPool ?? null,
    },
  });

  await audit({
    actor,
    action: 'environment.create',
    targetType: 'Environment',
    targetId: environment.id,
    // The pool is in the audit because "why did this run execute inside their
    // network" is a question an incident asks, and this row is the answer.
    metadata: {
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      runnerPool: input.runnerPool ?? null,
    },
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
        // Spread, unlike create: `undefined` means "not mentioned" and must
        // leave the pool alone, while an explicit `null` means "move this back
        // to the cloud" and has to be written. The schema's `.nullish()` is
        // what makes those two distinguishable here.
        ...(input.runnerPool !== undefined ? { runnerPool: input.runnerPool } : {}),
      },
      select: { id: true, name: true, kind: true, baseUrl: true, runnerPool: true },
    });

    await audit({
      actor,
      action: 'environment.update',
      targetType: 'Environment',
      targetId: environment.id,
      metadata: {
        name: updated.name,
        baseUrl: updated.baseUrl,
        runnerPool: updated.runnerPool,
      },
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
/** Worst first — the tie-break below, and the order a reader would want. */
const RESULT_STATUS_RANK: Record<TestResultStatus, number> = {
  FAILED: 0,
  TIMED_OUT: 1,
  FLAKY: 2,
  PASSED: 3,
  SKIPPED: 4,
};

/**
 * How each test's most recent result ENDED, for every test in one query.
 *
 * `Test.lastRunAt` records *when* a test last ran and nothing about how it went,
 * so a file tree that wants to colour a row by its last verdict had no column to
 * read and the UI could only guess from `flakeRate` — which is a rate over a
 * window, not an answer about the last run. This supplies the missing half.
 *
 * The obvious implementation is a `findFirst` per row ordered by `createdAt`,
 * and it is the wrong one: this list is drawn for a whole suite, so that is a
 * query per file and a thousand-file project pays a thousand round trips to
 * paint one panel. The alternative usually reached for next — take the newest
 * N×k results and keep the first sighting of each test — is an approximation,
 * and it lies in exactly the case that matters most: a test nobody has touched
 * in months falls outside the window and is reported as never run.
 *
 * So the question is asked as an aggregate instead. Grouping by
 * `(testId, status)` and taking `_max(createdAt)` bounds the answer at one row
 * per test per status — five, given the enum — rather than one per result ever
 * recorded, and the pair with the greatest timestamp per test IS that test's
 * last result. Exact, one statement, and it rides the existing
 * `@@index([testId, createdAt])`.
 *
 * Grouping by status as well as by testId is what makes the status readable at
 * all: Prisma's `groupBy` returns aggregates only of the columns it did NOT
 * group by, so `by: ['testId']` can give the timestamp but never the status
 * that goes with it, and recovering it would take a second query carrying a
 * (testId, createdAt) pair per test in one enormous OR.
 */
async function lastResultStatuses(testIds: string[]): Promise<Map<string, TestResultStatus>> {
  // Not merely an optimisation: `in: []` is a query that reads the table to
  // return nothing, and the common case here is a brand-new project.
  if (testIds.length === 0) return new Map();

  const groups = await prisma.testResult.groupBy({
    by: ['testId', 'status'],
    where: { testId: { in: testIds } },
    _max: { createdAt: true },
  });

  const latest = new Map<string, { at: number; status: TestResultStatus }>();
  for (const group of groups) {
    const at = group._max.createdAt?.getTime() ?? 0;
    const held = latest.get(group.testId);
    if (
      !held ||
      at > held.at ||
      // A tie needs a rule, or the same suite renders differently on two loads.
      // `@@unique([runId, testId])` makes one row per test per run, so a tie
      // means two runs created in the same instant — and when a test both
      // passed and failed at the same moment, the honest colour is the failure.
      (at === held.at && RESULT_STATUS_RANK[group.status] < RESULT_STATUS_RANK[held.status])
    ) {
      latest.set(group.testId, { at, status: group.status });
    }
  }

  const statuses = new Map<string, TestResultStatus>();
  for (const [testId, held] of latest) statuses.set(testId, held.status);
  return statuses;
}

/**
 * Resolve the auth profile a test is being bound to, inside THIS project.
 *
 * `prisma` is the tenant-scoped client, so the org boundary is already closed:
 * a profile belonging to another organisation matches no row. This closes the
 * narrower one that scoping cannot — an AuthProfile hangs off an Environment,
 * an Environment off a Project, and two projects in the SAME org have separate
 * environments with separate sessions. Binding project A's test to project B's
 * profile would hand A's suite a session minted against B's application, and
 * nothing downstream would notice: the storageState is valid, the sign-in
 * succeeds, and the test asserts a page in the wrong deployment.
 *
 * So the join is explicit, and a miss is a 400 that NAMES the problem rather
 * than a silent drop to null. Dropping it would be the worse failure: the
 * caller is told the save worked, the test runs anonymously, and the role it
 * asked for is nowhere — which is precisely the quiet anonymous pass this whole
 * column exists to make impossible. 400 rather than 404 because the request is
 * malformed (an id that cannot belong here), and the message says which id and
 * why, since the caller is a person in the editor or a script holding a list.
 */
async function requireAuthProfileInProject(
  authProfileId: string,
  projectId: string,
): Promise<{ id: string; name: string }> {
  const profile = await prisma.authProfile.findFirst({
    where: { id: authProfileId, environment: { projectId } },
    select: { id: true, name: true },
  });
  if (!profile) {
    throw badRequest(
      `Auth profile ${authProfileId} does not belong to this project. A test can only run as a profile configured on one of its own environments — binding it to another project's profile would run the test with a session minted against a different application.`,
      { authProfileId, projectId },
    );
  }
  return profile;
}

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
      /*
       * The role each test runs as, on the LIST and not only on the detail
       * page. A suite where an admin test and a member test sit side by side is
       * unreadable if the tree cannot say which is which — that readability is
       * half of what "bind a role to a test" was asking for. `authProfile` is
       * joined for the name because an id is not something a person recognises;
       * it is null when the test is anonymous, and also when the binding broke,
       * which is why `authProfileRequired` comes along to tell those apart.
       */
      authProfileId: true,
      authProfileRequired: true,
      authProfile: { select: { id: true, name: true } },
    },
  });

  /*
   * A status string, not the result row. The row carries the error text, the
   * network log, the console log and the trace key, and none of that is drawn
   * on a list — attaching it would multiply this response by the size of every
   * failure in the suite to colour a dot.
   *
   * `null` means "no result on record", which is a real and different state
   * from every status in the enum: a test written five minutes ago has never
   * run, and the tree must be able to say so rather than paint it as skipped.
   */
  const lastStatus = await lastResultStatuses(tests.map((test) => test.id));

  res.json({
    tests: tests.map((test) => ({ ...test, lastStatus: lastStatus.get(test.id) ?? null })),
  });
});

/**
 * Search across every test file in the project (⌘⇧F in the editor).
 *
 * This is server-side because the list above deliberately omits `code`, and it
 * should stay that way: fetching every file so the browser can grep them is one
 * request per test, and the payload is the whole suite for a query that matches
 * three lines. The endpoint sends back only what is shown — the matching lines.
 *
 * Two rules keep it honest:
 *
 *  · It searches THE BUFFER THE EDITOR WOULD SHOW YOU. A spec-driven test's
 *    `code` column holds a pointer comment, not a program, and the editor opens
 *    its `spec` as pretty-printed JSON instead. Searching `code` for those would
 *    report matches in text nobody can see and, worse, report line numbers that
 *    jump to the wrong place in the file that does open.
 *
 *  · No caller-supplied regular expression, and none COMPILED FROM one either.
 *    Node cannot interrupt a running match, so one pathological pattern from one
 *    user stops the API for everyone. Case-sensitivity and whole-word are
 *    offered instead because both can be answered by `indexOf` plus a look at
 *    the two characters either side of the hit — a scan that is linear no matter
 *    what is typed, with no pattern-shaped input reaching a regex engine at all.
 *
 * `path` narrows the search to one folder — the tree's "Find in folder". It
 * obeys the same rule: a path is not a pattern here either. It is normalised
 * the way every other path in this file is, matched as a literal prefix in the
 * query, and then re-checked on the folder BOUNDARY in JavaScript, which is
 * what makes `tests/auth` a folder rather than a string that also happens to
 * start `tests/authz/login.spec.ts`.
 */

/** Longer than any query a person types; a longer one is a paste or a probe. */
const SEARCH_MAX_QUERY = 200;
/** Matches `relativeFilePath` in the shared schema — no path in the tree is longer. */
const SEARCH_MAX_SCOPE = 300;
/** Files reported. Past this the panel is a scroll, not an answer. */
const SEARCH_MAX_FILES = 100;
/** Rows per file. The panel says "+N more in this file" for the rest. */
const SEARCH_MAX_PER_FILE = 50;
/** Matches counted across the project before the scan stops. */
const SEARCH_MAX_TOTAL = 1000;
/** Long enough to read a matching line, short enough that a minified file cannot flood the panel. */
const SEARCH_MAX_LINE = 400;

/**
 * The whole-word boundary, checked by hand.
 *
 * `\w` in a regex, written out — because writing it out is the point: this is
 * the check a `\b` would do, done on two characters we already have, so the
 * query never becomes a pattern. `undefined` (either end of the line) is not a
 * word character, which is what makes a match at column 0 a whole word.
 */
function isSearchWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}

/** Every index in `haystack` where `needle` starts, left to right. */
function searchHits(haystack: string, needle: string, wholeWord: boolean): number[] {
  const columns: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (
      wholeWord &&
      (isSearchWordChar(haystack[at - 1]) || isSearchWordChar(haystack[at + needle.length]))
    ) {
      continue;
    }
    columns.push(at);
  }
  return columns;
}

projectsRouter.get('/:projectId/search', async (req, res) => {
  const query = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  if (query.length > SEARCH_MAX_QUERY) {
    throw badRequest(`q must be ${SEARCH_MAX_QUERY} characters or fewer`);
  }

  const matchCase = req.query.case === '1';
  const wholeWord = req.query.word === '1';

  /*
   * The folder to search in, or the whole project when absent.
   *
   * Normalised through the same function the move and delete routes use, so a
   * scope typed with a leading slash, a Windows separator or a `.` segment
   * means what the reader expects rather than silently matching nothing. A
   * scope that normalises away to nothing — `/`, `.`, `""` — is not an error:
   * it is the root, which is the unscoped search.
   */
  const rawScope = typeof req.query.path === 'string' ? req.query.path : '';
  if (rawScope.length > SEARCH_MAX_SCOPE) {
    throw badRequest(`path must be ${SEARCH_MAX_SCOPE} characters or fewer`);
  }
  const scope = normalisePath(rawScope);

  /*
   * Echoed back only when one was applied. An unscoped search's response is
   * then byte-identical to the one this endpoint has always sent, which keeps
   * the addition genuinely additive for every caller that predates it.
   */
  const echoScope = scope ? { scope } : {};

  /*
   * An empty box is not an error. The panel clears its own results before it
   * would send one, so a blank `q` here is a direct caller or a race — and the
   * honest answer to "find nothing" is nothing found, not a 400 the UI would
   * have to special-case, and not a scan of every file in the project.
   */
  if (!query) {
    res.json({ query, ...echoScope, files: [], totalMatches: 0, truncated: false });
    return;
  }

  /*
   * `prisma` is the tenant-scoped client: the extension in lib/prisma.ts merges
   * the request's orgId into this findMany, so a projectId belonging to another
   * organisation matches no rows rather than returning its code. That is the
   * whole tenant boundary for this route — reaching for `unscoped` here, or
   * building the client yourself, removes it silently.
   */
  const tests = await prisma.test.findMany({
    where: {
      projectId: String(req.params.projectId),
      disabledAt: null,
      // A literal prefix, added only when there is one — a parameterised LIKE,
      // not a pattern the caller wrote. It narrows what is read off the disk;
      // the folder boundary is settled below, where it can be settled exactly.
      ...(scope ? { filePath: { startsWith: scope } } : {}),
    },
    orderBy: [{ filePath: 'asc' }],
    select: { id: true, name: true, type: true, filePath: true, code: true, spec: true },
  });

  const needle = matchCase ? query : query.toLowerCase();

  const files: Array<{
    testId: string;
    name: string;
    filePath: string;
    type: string;
    matchCount: number;
    matches: Array<{ line: number; column: number; length: number; text: string }>;
  }> = [];
  let totalMatches = 0;
  let truncated = false;

  for (const test of tests) {
    /*
     * The folder boundary, which the prefix filter above cannot express: a
     * scope of `tests/auth` means that folder and the file `tests/auth` itself,
     * and NOT `tests/authz/login.spec.ts`. Doing it here rather than in SQL is
     * also what makes the LIKE's own metacharacters harmless — `%` in a scope
     * can only ever widen the set the database returns, and this narrows it
     * back to the one folder that was asked for.
     */
    if (scope && test.filePath !== scope && !test.filePath.startsWith(`${scope}/`)) continue;

    if (files.length >= SEARCH_MAX_FILES || totalMatches >= SEARCH_MAX_TOTAL) {
      truncated = true;
      break;
    }

    const buffer = SPEC_DRIVEN_TEST_TYPES.has(test.type)
      ? JSON.stringify(test.spec ?? {}, null, 2)
      : test.code;
    if (!buffer) continue;

    const matches: Array<{ line: number; column: number; length: number; text: string }> = [];
    let matchCount = 0;
    const lines = buffer.split('\n');

    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index] ?? '';
      const columns = searchHits(matchCase ? raw : raw.toLowerCase(), needle, wholeWord);
      if (columns.length === 0) continue;
      matchCount += columns.length;

      /*
       * The line as the panel will draw it: indentation dropped (a result row
       * is 40px wide and a nested step starts at column 8) and capped. The
       * column is re-based onto that string so the highlight lands on the same
       * characters the reader sees, and is -1 when the match sits past the cap
       * — a row that says "this line matches" without pretending to know where.
       */
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trimStart().slice(0, SEARCH_MAX_LINE);

      // A row per hit, not per line: two hits on one line are two things to
      // click. The panel keys its rows by line and column, so the unplaceable
      // ones — every hit past the text cap collapses to the same -1 — are
      // reported once and counted as dropped, rather than repeated.
      let unplaceableShown = false;
      for (const at of columns) {
        if (matches.length >= SEARCH_MAX_PER_FILE) {
          truncated = true;
          break;
        }
        const column = at - lead;
        const placed = column >= 0 && column < text.length;
        if (!placed) {
          if (unplaceableShown) {
            truncated = true;
            continue;
          }
          unplaceableShown = true;
        }
        matches.push({
          line: index + 1,
          column: placed ? column : -1,
          length: needle.length,
          text,
        });
      }
    }

    if (matchCount === 0) continue;
    totalMatches += matchCount;
    files.push({
      testId: test.id,
      name: test.name,
      filePath: test.filePath,
      type: test.type,
      matchCount,
      matches,
    });
  }

  res.json({ query, ...echoScope, files, totalMatches, truncated });
});

projectsRouter.get('/:projectId/tests/:testId', async (req, res) => {
  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    // Every scalar, as before, plus the bound profile's name. The editor has to
    // show WHICH role this test assumes, and an id is not a name.
    include: { authProfile: { select: { id: true, name: true } } },
  });
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

  const projectId = String(req.params.projectId);
  const test = await prisma.test.findUnique({ where: { id: String(req.params.testId) } });
  if (!test || test.projectId !== projectId) throw notFound('Test');

  /*
   * Validated BEFORE the no-op check and before the write, so a save carrying a
   * profile from another project is refused outright rather than being half
   * applied: the code lands, the binding does not, and nothing says so.
   *
   * `undefined` means the client did not mention the field and the binding is
   * left alone; `null` means clear it. A client that predates this field sends
   * neither and keeps its test bound, which is why `updateTestSchema` makes the
   * field optional AND nullable instead of merging the two.
   */
  if (typeof input.authProfileId === 'string') {
    await requireAuthProfileInProject(input.authProfileId, projectId);
  }

  if (
    input.code === test.code &&
    input.name === undefined &&
    input.spec === undefined &&
    input.authProfileId === undefined &&
    input.authProfileRequired === undefined
  ) {
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
      ...(input.authProfileId !== undefined ? { authProfileId: input.authProfileId } : {}),
      /*
       * Binding a profile implies the test needs one — saying "run as admin"
       * and "it does not matter whether you are signed in" in the same breath
       * is not a state worth storing. Clearing the binding does NOT clear the
       * requirement, because that is the pair the coverage report reads to say
       * "this test asked for a role and is running as nobody"; dropping the
       * requirement there would make the orphan silent again.
       */
      ...(input.authProfileRequired !== undefined
        ? { authProfileRequired: input.authProfileRequired }
        : typeof input.authProfileId === 'string'
          ? { authProfileRequired: true }
          : {}),
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
    metadata: {
      name: updated.name,
      bytes: input.code.length,
      // Re-binding a test to a different role changes what it can see, which is
      // exactly the kind of change an audit log exists to be able to answer
      // questions about later.
      ...(input.authProfileId !== undefined ? { authProfileId: input.authProfileId } : {}),
    },
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

  // Before the suite upsert, so a rejected binding does not leave a
  // "Hand-written" suite behind for a test that was never created.
  if (input.authProfileId !== null) {
    await requireAuthProfileInProject(input.authProfileId, project.id);
  }

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
      authProfileId: input.authProfileId,
      // Naming a profile IS the statement that the test needs one; see the same
      // rule on PUT above.
      authProfileRequired: input.authProfileRequired || input.authProfileId !== null,
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
    metadata: { name: test.name, type: test.type, authProfileId: test.authProfileId },
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
 * The digest `GeneratedArtifact.contentHash` is written with, in one place.
 *
 * It MUST be the same function `ledgerRowsFor` uses
 * (apps/worker/src/processors/generate.ts) — sha256 hex. `RepoOwnership.digest`
 * exists precisely so the reader supplies its own, because a comparison against
 * a digest computed by a different function never matches, and that failure is
 * closed for the WRONG reason: every file on the branch would come back as one
 * a human had changed.
 */
const ledgerDigest = (input: string): string => createHash('sha256').update(input).digest('hex');

/**
 * THE RECORDED OWNERSHIP LEDGER FOR ONE PROJECT, KEYED THE WAY `pushRepo` ASKS.
 *
 * ── WHY THE PUSH ASKS IN A DIFFERENT SPELLING THAN THE LEDGER RECORDS ───────
 *
 * `pushRepo` asks `recordFor` about paths AS THE TREE AND THE BRANCH SPELL
 * THEM, and the ledger records the path THE GENERATOR chose. For PLAYWRIGHT_TS
 * and PUPPETEER those differ — `checkout/pay.spec.ts` in the ledger,
 * `tests/checkout/pay.spec.ts` in the tree — so a reader that looked tree paths
 * up directly would answer `UNRECORDED` for every file in a Playwright project
 * and the push would refuse every replacement while the ledger claimed all of
 * them under another name. {@link RepoBuild.ledgerPaths} is the exporter's own
 * answer to that question, which is why it is passed in here rather than
 * recomputed.
 *
 * ── THE TWO-STEP LOOKUP, AND WHAT MAKES THE SECOND STEP SAFE ───────────────
 *
 * A tree path the exporter mapped is looked up under ITS MAPPED LEDGER PATH AND
 * NOWHERE ELSE: once the exporter has said which row is the recorded fact about
 * that file, a second candidate is a second answer to "may QAAI write this",
 * and the permissive one would win by accident.
 *
 * Every other path — and in pass 2 that means every tracked file on the branch
 * that QAAI's tree does not hold — is looked up VERBATIM. That step is what
 * lets a stale file QAAI wrote on an earlier push still be recognised, and the
 * reason it cannot be turned into a permission is `replaceDecision`: the
 * verdict alone authorises nothing, and the recorded `contentHash` must equal
 * the digest of the bytes actually on the branch. A human's unrelated file that
 * happens to sit at a path some row names is refused as BYTES_DIVERGED, because
 * its bytes are not the bytes QAAI recorded writing.
 *
 * Nothing is normalised, which is {@link RepoOwnership}'s own rule: a lookup
 * that helpfully stripped a `./` would make two spellings of one file resolve to
 * two verdicts.
 */
function repoOwnershipFor(args: {
  readonly rows: readonly {
    readonly path: string;
    readonly ownership: OwnershipVerdict;
    readonly contentHash: string;
    readonly imports: readonly string[];
  }[];
  /** Tree path → ledger path, from {@link buildRepoTree}. */
  readonly ledgerPaths: ReadonlyMap<string, string>;
}): { readonly ownership: RepoOwnership; readonly ledgerPathFor: (path: string) => string } {
  const byPath = new Map(args.rows.map((row) => [row.path, row] as const));
  const ledgerPathFor = (path: string): string => args.ledgerPaths.get(path) ?? path;

  /** The answer for a path with no row. Never a default of "ours". */
  const unrecorded: OwnershipRecord = { verdict: 'UNRECORDED', contentHash: null, imports: [] };

  return {
    ledgerPathFor,
    ownership: {
      digest: ledgerDigest,
      recordFor: (path: string): OwnershipRecord => {
        const row = byPath.get(ledgerPathFor(path));
        if (!row) return unrecorded;
        return {
          verdict: row.ownership,
          contentHash: row.contentHash,
          imports: row.imports,
        };
      },
    },
  };
}

/*
 * THE PULL-REQUEST HALF OF A PUSH IS NOW IN `gitPushSchema`, in
 * packages/shared/src/schemas.ts, with `PR_CAUSE_IDENTITY_MAX` beside it.
 *
 * It was a second, route-local schema because that file belonged to another
 * agent for one round. The cost of the split was not tidiness: the two fields
 * `openPr` requires are a DEPENDENCY between fields, and neither schema could
 * see both halves — so a body carrying `openPr` passed `gitPushSchema`
 * untouched and the dependency was enforced by a second parse. One schema, one
 * refusal, one path.
 */

/**
 * Push the repo to a connected git remote.
 *
 * ADMIN-only and gated on `confirm: true` — a write to the customer's own repo is
 * never implicit. The token is decrypted here, handed to the push, and dropped;
 * it is never logged, audited, or returned. Failures are reported with the
 * provider's message only after it has been checked for credential material.
 *
 * ── AND, WHEN ASKED, THE PULL REQUEST ───────────────────────────────────────
 *
 * `openPr` is what makes the generated suite reach a reviewer. Until it existed
 * the only door onto `openPullRequest` was `POST
 * /agent/heals/:healId/pull-request`, so a HEAL could be reviewed and a project's
 * generated tests could not: they were pushed to a branch and nobody was told.
 *
 * THE TARGET IS NOT NEGOTIABLE AND THE REQUEST CANNOT NAME IT. The repository
 * and the base branch are read off the `Integration` row by
 * `pullRequestStore.loadTarget`, and the branch is composed by `branchNameFor`
 * from the hash of the cause — so when `openPr` is set, a `branch` in the
 * request is REFUSED rather than honoured, because a caller that could choose
 * the head of a pull request could choose where QAAI's commits land.
 *
 * ── THE OWNERSHIP READER AND THE LEDGER REFRESH ARE ONE CHANGE ─────────────
 *
 * They cannot be separated, in either direction, and the comment is here rather
 * than at one of them because the argument is about the pair.
 *
 * WITHOUT THE READER this route is CREATE-ONLY. `pushRepo` resolves every path
 * on the branch `UNRECORDED`, `UNRECORDED` is not writable, and the second push
 * of a project therefore writes nothing and refuses every file it holds — which
 * is the correct, safe behaviour for a caller that cannot say what QAAI owns,
 * and useless as a product.
 *
 * WITHOUT THE REFRESH the reader makes things WORSE than create-only.
 * `contentHash` is written once, by `ledgerRowsFor`, with `skipDuplicates` — so
 * it holds the digest of the FIRST version QAAI ever generated for that path and
 * nothing updates it. The first push matches it and writes; the second push then
 * compares the bytes QAAI ITSELF pushed against that stale hash, they differ,
 * and `replaceDecision` refuses with BYTES_DIVERGED — "somebody changed this
 * file" said about a file nobody touched. That is a correct refusal with a false
 * reason on it, and a false accusation of a human edit is worse than a feature
 * that plainly does not work yet.
 *
 * So the refresh is written in ONE transaction, after the push has committed.
 * The order is deliberate and the failure direction is the reason: a push that
 * succeeded and a refresh that did not leaves a stale hash, which refuses the
 * next write — and a refresh written before a push that then failed would record
 * bytes that are not on the branch and PERMIT one.
 */
projectsRouter.post(
  '/:projectId/git/push',
  requireRole('ADMIN'),
  requireScope('git:push'),
  async (req, res) => {
  const actor = actorOf(req);
  const input = gitPushSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  /*
   * Narrowed, not re-validated. `gitPushSchema` has already refused `openPr`
   * without its two companions, so the three-way check below is what gives the
   * compiler the non-optional types rather than a second guard — and `null` is
   * what every branch reads to mean "nothing outward-facing was requested", not
   * `false`, which would be a third state to get wrong.
   */
  const prRequest =
    input.openPr === true && input.purpose !== undefined && input.causeIdentity !== undefined
      ? { openPr: input.openPr, purpose: input.purpose, causeIdentity: input.causeIdentity }
      : null;

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

  /*
   * ── THE CAUSE, AND THE BRANCH COMPOSED FROM IT ─────────────────────────────
   *
   * `prCauseKey` hashes `(purpose | projectId | identity)` and `branchNameFor`
   * takes 12 hex characters of the result, so the head of the pull request is
   * `qaai/<segment>/<12 hex>` and there is no parameter anywhere on this path
   * that a sentence could be passed as. The `projectId` comes from the route,
   * the purpose is a member of a closed union, and the identity is already
   * shape-bounded by `pushPullRequestSchema`.
   *
   * `prCauseKey` throws on a `projectId` carrying the separator. That is a
   * 400 and not a 500: the id is in the URL, so a caller can fix it.
   */
  let prCause: { causeKey: string; branch: string } | null = null;
  if (prRequest) {
    let causeKey: string;
    try {
      causeKey = prCauseKey(prRequest.purpose, projectId, prRequest.causeIdentity);
    } catch {
      throw badRequest(
        'That project id cannot be made into a pull-request cause key, so no pull request was requested.',
      );
    }
    prCause = { causeKey, branch: branchNameFor({ purpose: prRequest.purpose, causeKey }) };
    /*
     * A REQUEST-SUPPLIED BRANCH IS REFUSED, NOT OVERRIDDEN — and the refusal is
     * `gitPushSchema`'s, not a guard here. It used to be an `if` on this line,
     * and that `if` is GONE rather than kept as a belt: with the schema
     * refusing `openPr` beside `branch`, nothing could ever reach it, so it was
     * code connected to nothing that also hid the schema from the test meant to
     * pin it. The same reasoning routes/runs.ts records for the quarantine
     * filter it deleted.
     */
  }

  const branch = prCause?.branch ?? input.branch ?? config.defaultBranch;

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

  const { tree, ledgerPaths } = await buildRepoTree({ projectId });

  /*
   * The ledger, read ONCE for the whole push. `select` is the narrow projection
   * `OwnershipRecord` needs and nothing more — `contentHash` is the authority
   * here and `imports` is read for exactly one thing, the coherence rule in
   * `PRESERVE_REASONS`. The query carries no `orgId`: it runs inside the
   * request's tenant scope and the prisma extension adds it, which is the
   * convention every other read in this router follows.
   */
  const ledgerRows = await prisma.generatedArtifact.findMany({
    where: { projectId },
    select: { path: true, ownership: true, contentHash: true, imports: true },
  });
  const { ownership, ledgerPathFor } = repoOwnershipFor({
    /*
     * NO CAST ON `ownership`, deliberately. Prisma's `ArtifactOwnership` has
     * three members and `OwnershipVerdict` is those three plus `UNRECORDED`, so
     * the column is already assignable and an assertion here would only hide the
     * day the two vocabularies stop agreeing — which is the one thing a reader
     * of this ledger must not be allowed to get wrong silently.
     */
    rows: ledgerRows.map((row) => ({
      path: row.path,
      ownership: row.ownership,
      contentHash: row.contentHash,
      imports: row.imports,
    })),
    ledgerPaths,
  });

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
      ownership,
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

  /*
   * THE OBLIGATION THE PUSH RETURNED, PAID IN ONE TRANSACTION.
   *
   * One `updateMany` per written path rather than one `update`: `updateMany`
   * takes the `(projectId, path)` pair as a filter and matches nothing when no
   * row claims that path, where `update` would throw on the first unclaimed one
   * and abandon the refresh for every path after it. A path with no row is a
   * fact to COUNT, not an error to fail the whole push on — the push has already
   * committed and cannot be undone by throwing here.
   *
   * `refreshed` and `unclaimed` are both reported because 0 refreshed because
   * nothing was written and 0 refreshed because no row claimed any of it are
   * different outcomes, and only the pair distinguishes them. `unclaimed` is the
   * disclosed count {@link RepoBuild.ledgerPaths} promises: every one of those
   * paths is a file whose next update will be refused, and a refusal nobody was
   * told about is a failure suppressed without being counted.
   */
  let ledgerRefreshed = 0;
  let ledgerUnclaimed = 0;
  if (result.ledgerRefresh.length > 0) {
    const counts = await prisma.$transaction(
      result.ledgerRefresh.map((entry) => {
        /*
         * `bytes` is updated only when the written content is in hand, and
         * there is no `?? 0`. Every entry's path IS a key of the tree today —
         * `ledgerRefresh` is built from the paths `pushRepo` wrote — so the
         * absent branch is unreachable and is written this way anyway: a 0
         * length recorded for a file whose length was not known is a null that
         * became a measurement, and `bytes` is the audit trail for exactly
         * "how big was what we wrote". Leaving the column at its previous value
         * is the honest answer, and `contentHash` — the one the gate reads — is
         * refreshed either way.
         */
        const written = tree.get(entry.path);
        return prisma.generatedArtifact.updateMany({
          where: { projectId, path: ledgerPathFor(entry.path) },
          data: {
            contentHash: entry.contentHash,
            ...(written === undefined ? {} : { bytes: written.length }),
          },
        });
      }),
    );
    for (const count of counts) {
      if (count.count > 0) ledgerRefreshed += count.count;
      else ledgerUnclaimed += 1;
    }
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
      /*
       * THE INTENT AND THE CHANGE ARE TWO NUMBERS, AND THIS ROW USED TO CARRY
       * ONLY THE FIRST.
       *
       * `fileCount` is the size of QAAI's tree — what the push MEANT to sync —
       * and `pushRepo`'s own doc comment says so. Since ownership gates every
       * write it is NOT the number of files that moved, and it never was: a
       * path the ledger does not claim, or claims against bytes a human has
       * since changed, is refused. An audit row is the only durable record of
       * the push, and one that reports an intent as though it were a result is
       * a thing reported as measured that was not.
       *
       * `ownershipKnown` is here for the same reason: 0 written because nothing
       * was permitted and 0 written because nothing had changed are different
       * outcomes, and only this flag distinguishes them. It is `true` on every
       * row this route writes now that the reader above is supplied — which is
       * exactly why it stays, because a row that stopped carrying it could not
       * be told apart from the create-only pushes already in the table.
       */
      files: result.fileCount,
      filesWritten: result.filesWritten,
      filesCreated: result.filesCreated,
      filesDeleted: result.filesDeleted.length,
      refused: result.refusedCount,
      kept: result.keptCount,
      ownershipKnown: result.ownershipKnown,
      ledgerRefreshed,
      ledgerUnclaimed,
      // Whether a review was asked for, on the row that records the push. A
      // push that opened a pull request and one that did not are different
      // acts in somebody's repository.
      openPr: prRequest !== null,
    },
  });

  /*
   * ── THE PULL REQUEST, AFTER THE LEDGER REFRESH AND NOT BEFORE ─────────────
   *
   * The order is the same argument the refresh itself rests on, one step
   * further out. The branch is on the remote and the ledger agrees with it
   * before a human is asked to review: a pull request opened first would, on a
   * failed refresh, be a review request whose next update QAAI will refuse as
   * BYTES_DIVERGED — a false accusation of a human edit, in a reviewer's inbox.
   *
   * Nothing here throws. `openPullRequest` returns an outcome and a sentence
   * for every arm, which is what this route needs: the push has COMMITTED, and
   * a throw would report a failed push to a caller whose repository already has
   * the branch.
   */
  let pullRequest: {
    outcome: string;
    url: string | null;
    note: string;
    hostRefusal: string | null;
    refusalPaths: readonly string[];
    refusalTotal: number;
    disclosures: unknown;
    preserved: { named: number; total: number; capped: boolean; cap: number };
  } | null = null;

  if (prRequest && prCause) {
    const prResult = await openPullRequest(
      {
        store: pullRequestStore(prisma, {
          /*
           * THE BRANCH THE PUSH ITSELF REPORTS WRITING, not the one composed
           * above. `openPullRequest` re-derives the branch from the cause key
           * and refuses when the two differ, so handing it this value is what
           * makes that comparison a real check rather than one computation
           * compared with itself.
           */
          pushedBranch: result.branch,
        }),
        /*
         * The token is the one already opened for the push and is not read a
         * second time. A non-GitHub integration cannot leak it here:
         * `openPullRequest` compares `target.provider` with the host's and
         * returns REFUSED before any request is made, so the header this host
         * composes is never sent.
         */
        host: githubPullRequestHost({ token }),
        audit: pullRequestAudit(prisma, { orgId: actor.orgId, userId: actor.userId }),
      },
      {
        orgId: actor.orgId,
        projectId,
        purpose: prRequest.purpose,
        causeKey: prCause.causeKey,
        integrationId: integration.id,
        /*
         * THE FILES THE PUSH ACTUALLY WROTE, which is not the files it meant to
         * write. `result.fileCount` is the size of QAAI's tree and ownership
         * gates every write, so a body built from the intent would list a
         * reviewer's own untouched files as QAAI's changes.
         */
        filePaths: result.ledgerRefresh.map((entry) => entry.path),
        /*
         * And what was LEFT ALONE, from the push's own report. This is the half
         * that makes the rest of the diff trustworthy: "QAAI did not touch
         * these files of yours" is a sentence only `pushRepo` can supply.
         *
         * A CAP BITES HERE AND IT IS DISCLOSED BELOW. `filesKept` names at most
         * `MAX_REPORTED_PATHS` (200) while `keptCount` is the exact total, so on
         * a push that preserved more than 200 files the body's own
         * "**Files left alone** N" is the NAMED count and not the real one.
         * `preserved` in the response carries both numbers and which cap bit,
         * because a count that was quietly truncated reads as the whole story.
         */
        preservedPaths: result.filesKept.map((file) => file.path),
        /*
         * NO SPANS. The only untrusted text within reach of this route is a
         * model's own prose, and `UNTRUSTED_PROVENANCES` has no member for
         * model output — a span labelled `RUNNER_OUTPUT` over a model's
         * sentence is a fence whose header lies in the one line a reader is
         * most likely to believe. Passing none is the correct degradation; the
         * heal path, which has an honest compromise documented at its call
         * site, is where that quote lives today.
         */
        actorUserId: actor.userId,
      },
    );
    pullRequest = {
      outcome: prResult.outcome,
      url: prResult.url,
      note: prResult.note,
      hostRefusal: prResult.hostRefusal,
      /*
       * zod PATHS and the TOTAL beside the capped list, never zod messages: a
       * zod message quotes the offending value, and a stored value once turned
       * into the literal text of an injected instruction in a customer-facing
       * flag.
       */
      refusalPaths: prResult.refusalPaths,
      refusalTotal: prResult.refusalTotal,
      // What the body left out, carried rather than dropped.
      disclosures: prResult.body?.disclosures ?? null,
      /*
       * THE CAP THAT BIT, AS A COUNT AND A REASON. `named` is how many
       * preserved paths the pull request was given, `total` is how many files
       * the push actually left alone, and `capped` says whether the two differ
       * because `MAX_REPORTED_PATHS` bit — not because something else did.
       */
      preserved: {
        named: result.filesKept.length,
        total: result.keptCount,
        capped: result.keptCount > result.filesKept.length,
        cap: MAX_REPORTED_PATHS,
      },
    };
  }

  res.json({ push: result, ledgerRefreshed, ledgerUnclaimed, pullRequest });
});


/** The gate rules for a project — what blocks a deploy. */
projectsRouter.get('/:projectId/gate-rules', async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { gateRules: true },
  });
  if (!project) throw notFound('Project');
  res.json({ rules: project.gateRules ?? [] });
});

/**
 * Replace the gate rules. Validated as a discriminated union so a malformed
 * rule cannot be stored — a gate that throws at evaluation time would fail
 * open, which is the one behaviour a deploy gate must never have.
 */
projectsRouter.put('/:projectId/gate-rules', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateGateRulesSchema.parse(req.body);

  const project = await prisma.project.findUnique({
    where: { id: String(req.params.projectId) },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { gateRules: input.rules as unknown as object },
    select: { gateRules: true },
  });

  await audit({
    actor,
    action: 'project.gate-rules.update',
    targetType: 'Project',
    targetId: project.id,
    metadata: { count: input.rules.length, kinds: input.rules.map((r) => r.kind) },
  });

  res.json({ rules: updated.gateRules });
});



// ─── Auth profiles (§2) ──────────────────────────────────────────────────────

/**
 * How QAAI signs in to your app. Config is stored plainly; every credential is
 * a REFERENCE to a vault secret by name, so a profile can be read, edited and
 * exported without ever exposing a password.
 */
projectsRouter.get('/:projectId/environments/:environmentId/auth-profiles', async (req, res) => {
  const profiles = await prisma.authProfile.findMany({
    where: { environmentId: String(req.params.environmentId) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      kind: true,
      config: true,
      storageStateExpiresAt: true,
      // Never the storageState itself: it is a live session.
      updatedAt: true,
    },
  });

  res.json({
    profiles: profiles.map((p) => ({
      ...p,
      signedIn:
        p.storageStateExpiresAt !== null && p.storageStateExpiresAt > new Date(),
    })),
  });
});

projectsRouter.post(
  '/:projectId/environments/:environmentId/auth-profiles',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const input = authProfileSchema.parse(req.body);
    const environmentId = String(req.params.environmentId);

    const environment = await prisma.environment.findUnique({
      where: { id: environmentId },
      select: { id: true, projectId: true },
    });
    if (!environment || environment.projectId !== String(req.params.projectId)) {
      throw notFound('Environment');
    }

    // Validate the config against its kind, so a FORM_LOGIN missing its
    // password selector fails here rather than halfway through a browser run.
    const perKind = AUTH_PROFILE_CONFIG_SCHEMAS[input.kind];
    const parsed = perKind.safeParse(input.config);
    if (!parsed.success) {
      throw badRequest(
        `That ${input.kind} profile is incomplete: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }

    const profile = await prisma.authProfile.create({
      data: {
        orgId: actor.orgId,
        environmentId,
        name: input.name,
        kind: input.kind,
        config: parsed.data as object,
      },
      select: { id: true, name: true, kind: true, config: true },
    });

    await audit({
      actor,
      action: 'auth-profile.create',
      targetType: 'AuthProfile',
      targetId: profile.id,
      metadata: { name: input.name, kind: input.kind },
    });

    res.status(201).json({ profile });
  },
);

projectsRouter.delete(
  '/:projectId/environments/:environmentId/auth-profiles/:profileId',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const profile = await prisma.authProfile.findUnique({
      where: { id: String(req.params.profileId) },
      select: { id: true, environmentId: true, name: true },
    });
    if (!profile || profile.environmentId !== String(req.params.environmentId)) {
      throw notFound('Auth profile');
    }
    await prisma.authProfile.delete({ where: { id: profile.id } });
    await audit({
      actor,
      action: 'auth-profile.delete',
      targetType: 'AuthProfile',
      targetId: profile.id,
      metadata: { name: profile.name },
    });
    res.json({ ok: true });
  },
);

/**
 * Actually sign in, and cache the session.
 *
 * This is the step that never existed: storageState was read by the crawler and
 * every run, and produced by nothing, so a profile was configuration for
 * something that never happened. Running it here also makes the profile
 * verifiable — you find out the selector is wrong now, not during a nightly.
 */
projectsRouter.post(
  '/:projectId/environments/:environmentId/auth-profiles/:profileId/sign-in',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);

    const profile = await prisma.authProfile.findUnique({
      where: { id: String(req.params.profileId) },
      select: { id: true, environmentId: true, kind: true, config: true, name: true },
    });
    if (!profile || profile.environmentId !== String(req.params.environmentId)) {
      throw notFound('Auth profile');
    }

    const environment = await prisma.environment.findUnique({
      where: { id: profile.environmentId },
      /*
       * `kind` is read for `SignInContext.environmentKind`, which is required
       * with no default: `signInWithProfile` refuses MOCK_IDP on PRODUCTION —
       * minting an assertion against a real system is forging a real identity
       * — and a refusal that depends on a caller remembering an argument is not
       * a refusal.
       */
      select: { id: true, baseUrl: true, kind: true },
    });
    if (!environment) throw notFound('Environment');

    // Decrypt only this environment's secrets, in memory, for this call.
    const rows = await prisma.secret.findMany({
      where: { environmentId: environment.id },
      select: { name: true, valueEnc: true, keyVersion: true },
    });
    const secrets: Record<string, string> = {};
    for (const row of rows) {
      try {
        secrets[row.name] = openSecret(row.valueEnc, row.keyVersion, actor.orgId, row.name);
      } catch {
        /* a secret sealed under a retired key is simply unavailable here */
      }
    }

    /**
     * Re-validated here rather than trusted: a profile may predate the
     * per-kind validation, and driving a browser with a half-formed config
     * fails in a way nobody can read.
     */
    const shape = AUTH_PROFILE_CONFIG_SCHEMAS[profile.kind];
    const parsedConfig = shape.safeParse(profile.config);
    if (!parsedConfig.success) {
      throw unprocessable(
        `This ${profile.kind} profile is incomplete: ${parsedConfig.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }

    /*
     * ── ONE DISPATCH, NOT A THIRD COPY OF IT ─────────────────────────────────
     *
     * This route used to hold its own `kind ===` ladder over three of the
     * kinds, with a fallback sentence naming "the mail catcher / TOTP support
     * that is not built yet". Both halves had gone false: TOTP_MFA and
     * MAGIC_LINK have adapters, and three further kinds now exist that the
     * ladder had never heard of and would have answered for anyway. A branch
     * that answers for a kind it does not know is exactly the defect the
     * capability vocabulary was built to end.
     *
     * `signInWithProfile` refuses in three ordered stages — policy, then
     * capability, then config — so a kind this PROCESS cannot drive comes back
     * UNAVAILABLE with the remedy for the surface that is missing, rather than
     * as a claim about the customer's application. The per-kind branch now
     * exists once, next to the functions it dispatches to.
     */
    const result = await signInWithProfile(
      { id: profile.id, name: profile.name, kind: profile.kind, config: parsedConfig.data },
      secrets,
      { environmentKind: environment.kind, baseUrl: environment.baseUrl },
    );

    if (result.ok) {
      await prisma.authProfile.update({
        where: { id: profile.id },
        data: {
          storageState: (result.storageState as object) ?? undefined,
          storageStateExpiresAt: result.expiresAt,
        },
      });
    }

    // The message never contains a credential — see packages/runner/src/login.ts.
    await audit({
      actor,
      action: result.ok ? 'auth-profile.sign-in' : 'auth-profile.sign-in.failed',
      targetType: 'AuthProfile',
      targetId: profile.id,
      metadata: { name: profile.name, kind: profile.kind },
    });

    res.json({ ok: result.ok, message: result.message, expiresAt: result.expiresAt });
  },
);

// ─── Schedules & monitors (§6) ───────────────────────────────────────────────

/** Recurring runs and production monitors for a project. */
projectsRouter.get('/:projectId/automation', async (req, res) => {
  const projectId = String(req.params.projectId);
  const [schedules, monitors, suites, environments] = await Promise.all([
    prisma.schedule.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        cron: true,
        timezone: true,
        enabled: true,
        lastRunAt: true,
        nextRunAt: true,
        suiteId: true,
        environmentId: true,
      },
    }),
    prisma.monitor.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        intervalMinutes: true,
        enabled: true,
        failureThreshold: true,
        consecutiveFailures: true,
        lastStatus: true,
        lastCheckedAt: true,
        suiteId: true,
        environmentId: true,
      },
    }),
    prisma.suite.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.environment.findMany({
      where: { projectId },
      select: { id: true, name: true, kind: true },
    }),
  ]);
  res.json({ schedules, monitors, suites, environments });
});

projectsRouter.post('/:projectId/schedules', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = createScheduleSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const schedule = await prisma.schedule.create({
    data: {
      orgId: actor.orgId,
      projectId,
      suiteId: input.suiteId,
      environmentId: input.environmentId,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone,
    },
    select: { id: true, name: true, cron: true, enabled: true },
  });

  await audit({
    actor,
    action: 'schedule.create',
    targetType: 'Schedule',
    targetId: schedule.id,
    metadata: { name: input.name, cron: input.cron },
  });

  res.status(201).json({ schedule });
});

projectsRouter.patch('/:projectId/schedules/:scheduleId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const enabled = req.body?.enabled;
  const schedule = await prisma.schedule.findUnique({
    where: { id: String(req.params.scheduleId) },
    select: { id: true, projectId: true },
  });
  if (!schedule || schedule.projectId !== String(req.params.projectId)) throw notFound('Schedule');

  const updated = await prisma.schedule.update({
    where: { id: schedule.id },
    data: { ...(typeof enabled === 'boolean' ? { enabled } : {}) },
    select: { id: true, enabled: true },
  });
  await audit({
    actor,
    action: 'schedule.update',
    targetType: 'Schedule',
    targetId: schedule.id,
    metadata: { enabled: updated.enabled },
  });
  res.json({ schedule: updated });
});

projectsRouter.delete('/:projectId/schedules/:scheduleId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const schedule = await prisma.schedule.findUnique({
    where: { id: String(req.params.scheduleId) },
    select: { id: true, projectId: true, name: true },
  });
  if (!schedule || schedule.projectId !== String(req.params.projectId)) throw notFound('Schedule');
  await prisma.schedule.delete({ where: { id: schedule.id } });
  await audit({
    actor,
    action: 'schedule.delete',
    targetType: 'Schedule',
    targetId: schedule.id,
    metadata: { name: schedule.name },
  });
  res.json({ ok: true });
});

projectsRouter.post('/:projectId/monitors', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = createMonitorSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const monitor = await prisma.monitor.create({
    data: {
      orgId: actor.orgId,
      projectId,
      suiteId: input.suiteId,
      environmentId: input.environmentId,
      name: input.name,
      intervalMinutes: input.intervalMinutes,
      failureThreshold: input.failureThreshold,
    },
    select: { id: true, name: true, intervalMinutes: true, enabled: true },
  });

  await audit({
    actor,
    action: 'monitor.create',
    targetType: 'Monitor',
    targetId: monitor.id,
    metadata: { name: input.name, intervalMinutes: input.intervalMinutes },
  });

  res.status(201).json({ monitor });
});

projectsRouter.patch('/:projectId/monitors/:monitorId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const enabled = req.body?.enabled;
  const monitor = await prisma.monitor.findUnique({
    where: { id: String(req.params.monitorId) },
    select: { id: true, projectId: true },
  });
  if (!monitor || monitor.projectId !== String(req.params.projectId)) throw notFound('Monitor');

  const updated = await prisma.monitor.update({
    where: { id: monitor.id },
    data: {
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      // Re-enabling clears the streak; otherwise it would page instantly.
      ...(enabled === true ? { consecutiveFailures: 0 } : {}),
    },
    select: { id: true, enabled: true },
  });
  await audit({
    actor,
    action: 'monitor.update',
    targetType: 'Monitor',
    targetId: monitor.id,
    metadata: { enabled: updated.enabled },
  });
  res.json({ monitor: updated });
});

projectsRouter.delete('/:projectId/monitors/:monitorId', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const monitor = await prisma.monitor.findUnique({
    where: { id: String(req.params.monitorId) },
    select: { id: true, projectId: true, name: true },
  });
  if (!monitor || monitor.projectId !== String(req.params.projectId)) throw notFound('Monitor');
  await prisma.monitor.delete({ where: { id: monitor.id } });
  await audit({
    actor,
    action: 'monitor.delete',
    targetType: 'Monitor',
    targetId: monitor.id,
    metadata: { name: monitor.name },
  });
  res.json({ ok: true });
});

// ─── Quality surfaces (§4, §5) ───────────────────────────────────────────────

/**
 * Findings across the whole project — accessibility, security, performance,
 * localisation and visual. They were only ever visible inside one test result,
 * which made "what is wrong with this app" a question you could not ask.
 *
 * De-duplicated by (kind, code, location): the same axe violation on the same
 * element across forty runs is one problem, not forty.
 *
 * The ORDER BY is the expensive part, and it is now indexed: Finding(orgId,
 * createdAt), added in 20260824000000_query_plan_indexes. `createdAt` was the
 * only unindexed column in the query, so the planner had to materialise the
 * whole two-hop join — every finding of every run the project has ever had —
 * and sort it to return a thousand rows. With the index it walks that index
 * backwards, probes the two parents per row, and stops at the LIMIT: bounded
 * work rather than work proportional to the project's history.
 *
 * `mutedAt` is deliberately not in that index, and the reason is written out in
 * the migration: `IS NULL` is not an equality to the planner, so a column
 * between `orgId` and `createdAt` would destroy the ordering the sort needs.
 * Keep the filter here; do not "improve" the index by adding it.
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
/**
 * Quarantine a test by hand — THE OTHER DOOR.
 *
 * The auto-quarantine in apps/worker/src/processors/flake.ts goes through the
 * budget, the expiry and `quarantineSuppresses`. This endpoint did not, and a
 * brake that only one of two doors respects is not a brake: a team that hits
 * the automatic refusal can quarantine the same test from the screen, and the
 * fortieth quarantine nobody is allowed to take automatically goes through here
 * instead. Both doors now share one rule, imported from the module that owns it.
 */
projectsRouter.post('/:projectId/tests/:testId/quarantine', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const quarantined = String(req.body?.quarantined ?? 'true') !== 'false';
  const now = new Date();

  const test = await prisma.test.findUnique({
    where: { id: String(req.params.testId) },
    select: {
      id: true,
      orgId: true,
      projectId: true,
      name: true,
      quarantined: true,
      quarantineExpiresAt: true,
    },
  });
  if (!test || test.projectId !== String(req.params.projectId)) throw notFound('Test');

  /*
   * Counted in SQL, and the expiry arm matters: an expired quarantine
   * suppresses nothing, so charging the project for it would make the budget
   * tighten on its own and refuse a quarantine the suite had room for. Counting
   * rather than reading rows keeps the check cheapest on the 4,000-quarantine
   * suite it exists for.
   */
  let budget: ReturnType<typeof checkQuarantineBudget> | null = null;
  if (quarantined) {
    const [project, totalTests, inForce] = await Promise.all([
      prisma.project.findUnique({
        where: { id: test.projectId },
        select: { quarantineBudgetPercent: true },
      }),
      prisma.test.count({ where: { projectId: test.projectId, disabledAt: null } }),
      prisma.test.count({
        where: {
          projectId: test.projectId,
          disabledAt: null,
          quarantined: true,
          id: { not: test.id },
          OR: [{ quarantineExpiresAt: null }, { quarantineExpiresAt: { gt: now } }],
        },
      }),
    ]);

    budget = checkQuarantineBudget({
      totalTests,
      quarantinedCount: inForce,
      budgetPercent: project?.quarantineBudgetPercent ?? null,
      /*
       * Re-deciding a suppression that is ALREADY in force is never refused —
       * that would hide the state rather than change it. An EXPIRED quarantine
       * is a new suppression being taken out again, and is charged, or an
       * over-budget project could renew forever and never be refused.
       */
      alreadyQuarantined: quarantineSuppresses(test, now),
    });

    if (!budget.allowed) {
      throw conflict(budget.reason);
    }
  }

  const updated = await prisma.test.update({
    where: { id: test.id },
    data: {
      quarantined,
      quarantinedAt: quarantined ? now : null,
      /*
       * A quarantine with no end date is a deletion nobody signed. Expiry does
       * not clear the flag when it arrives — that would erase the reason — it
       * stops being HONOURED, so the test gates again and the gate says why.
       */
      quarantineExpiresAt: quarantined ? quarantineExpiryFrom(now) : null,
    },
    select: { id: true, quarantined: true, quarantinedAt: true, quarantineExpiresAt: true },
  });

  await audit({
    actor,
    action: quarantined ? 'test.quarantine' : 'test.unquarantine',
    targetType: 'Test',
    targetId: test.id,
    metadata: {
      name: test.name,
      ...(budget
        ? {
            quarantinedNow: budget.current + 1,
            quarantineLimit: budget.limit,
            quarantinePercent: budget.wouldBePercent,
            nearLimit: budget.nearLimit,
          }
        : {}),
      ...(updated.quarantineExpiresAt
        ? { expiresAt: updated.quarantineExpiresAt.toISOString() }
        : {}),
    },
  });

  // The near-limit warning rides the response, so the person who just switched
  // a signal off is told how much of the suite is now switched off.
  res.json({ test: updated, budget });
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

/**
 * How many files one batch may act on.
 *
 * Two hundred is well past any multi-select a person makes by hand and well
 * short of the point where the request stops being a request: every file in a
 * batch costs a statement inside an open transaction, so the cap is also the
 * ceiling on how long that transaction holds its row locks. It bounds the audit
 * row too — a batch move records every from/to pair, because an audit line
 * reading "40 files moved" without saying which is not a record of anything.
 *
 * A tree that wants to move more than this has a folder in mind, and
 * POST /folders/move already does whole folders in one statement-set.
 */
const BATCH_MAX_FILES = 200;

/**
 * A batch of moves. `filePath` and `name` are taken OFF the shared single-file
 * schema rather than restated here — the traversal rule, the length cap and the
 * name limits are the same rules or they are a second set of rules that drifts,
 * and a batch endpoint that validates more loosely than the single-file one it
 * shadows is a hole with a convenience API in front of it.
 */
const batchMoveSchema = z.object({
  moves: z
    .array(
      z.object({
        testId: z.string().min(1),
        filePath: moveTestSchema.shape.filePath,
        name: moveTestSchema.shape.name,
      }),
    )
    .min(1)
    .max(BATCH_MAX_FILES),
});

const batchDeleteSchema = z.object({
  testIds: z.array(z.string().min(1)).min(1).max(BATCH_MAX_FILES),
});

/** One validated move: the row to write, and what it is being written over. */
interface PlannedMove {
  id: string;
  from: string;
  /** Present only when the caller also asked to rename the test. */
  name?: string;
  to: string;
}

/**
 * Validate a whole set of moves against the project, and hand back the writes.
 *
 * This is the single-file route's validation, generalised — not a second copy of
 * it. Both callers go through here, so the path rules (normalisation, the
 * `fixtures/` boundary, collisions) cannot come to mean one thing when you drag
 * one file and another when you drag forty.
 *
 * It THROWS BEFORE IT RETURNS if any move is bad, which is what lets the caller
 * open its transaction knowing every destination is already settled. That
 * ordering is the whole point: the failure this endpoint exists to prevent is a
 * forty-file move that writes thirty-nine rows and then discovers the fortieth
 * would land on an occupied path.
 */
async function planMoves(
  projectId: string,
  requests: ReadonlyArray<{ testId: string; filePath: string; name?: string }>,
): Promise<PlannedMove[]> {
  const ids = requests.map((request) => request.testId);
  if (new Set(ids).size !== ids.length) {
    // Two destinations for one file is not a batch, it is a contradiction —
    // and whichever one won would depend on iteration order.
    throw badRequest('The same file appears more than once in this batch');
  }

  /*
   * `prisma` is the tenant-scoped client, so `projectId` here is joined by an
   * implicit orgId — there is deliberately no orgId in this `where`. A test id
   * from another organisation simply does not come back, and the size check
   * below turns that into the same 404 as an id that never existed. The two are
   * indistinguishable on purpose (lib/errors.ts): confirming that an id exists
   * but is not yours is an existence oracle.
   */
  const rows = await prisma.test.findMany({
    where: { projectId, id: { in: ids } },
    select: { id: true, filePath: true, code: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== ids.length) throw notFound('Test');

  const planned: PlannedMove[] = requests.map((request) => {
    const row = byId.get(request.testId)!;
    const to = normalisePath(request.filePath);
    if (!to) throw badRequest('A file needs a name');
    assertFixtureBoundary(to, row.code.trim().length > 0 && !row.filePath.endsWith('.json'));
    return { id: row.id, from: row.filePath, to, ...(request.name ? { name: request.name } : {}) };
  });

  // Collisions within the batch itself, which no query can see: two files
  // dragged onto the same destination. Checked across every move including the
  // ones that do not change path, so a file already sitting on the destination
  // and along for the ride still counts as the occupant it is.
  const destinations = new Set<string>();
  for (const move of planned) {
    if (destinations.has(move.to)) {
      throw conflict(`Two files in this batch would both become ${move.to}`);
    }
    destinations.add(move.to);
  }

  /*
   * Collisions with the rest of the project. `notIn` excludes the batch's own
   * rows, and that exclusion is what makes a rotation work: A→B and B→A is a
   * legal batch, because at the end no two live files share a path even though
   * both destinations are occupied at the start. Filtering to the moves that
   * actually change path keeps a no-op move behaving exactly as it always has
   * on the single-file route, where the clash query is skipped outright.
   */
  const changed = planned.filter((move) => move.to !== move.from);
  if (changed.length > 0) {
    const clashes = await prisma.test.findMany({
      where: {
        projectId,
        disabledAt: null,
        filePath: { in: changed.map((move) => move.to) },
        id: { notIn: planned.map((move) => move.id) },
      },
      select: { filePath: true },
    });
    if (clashes.length > 0) throw conflict(`${clashes[0]!.filePath} already exists`);
  }

  return planned;
}

/** Rename or move one file. */
projectsRouter.patch('/:projectId/tests/:testId/path', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = moveTestSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const [move] = await planMoves(projectId, [
    {
      testId: String(req.params.testId),
      filePath: input.filePath,
      ...(input.name ? { name: input.name } : {}),
    },
  ]);

  const updated = await prisma.test.update({
    where: { id: move!.id },
    data: { filePath: move!.to, ...(move!.name ? { name: move!.name } : {}) },
    select: { id: true, name: true, filePath: true },
  });

  await audit({
    actor,
    action: 'test.move',
    targetType: 'Test',
    targetId: move!.id,
    metadata: { from: move!.from, to: move!.to },
  });

  res.json({ test: updated });
});

/**
 * Move or rename many files at once — the tree's multi-select drag.
 *
 * The alternative the UI would otherwise be stuck with is forty PATCHes, and
 * forty PATCHes is not a slower version of this: it is a different operation
 * with a different failure mode. The thirty-ninth can 409 on a collision after
 * thirty-eight have already been written, leaving a tree that matches neither
 * what the user dragged nor what they had before, with no way to say which of
 * the two it is closer to. So this validates the whole set first and writes it
 * in one transaction — every file lands, or none does and the tree is exactly
 * as it was.
 */
projectsRouter.post('/:projectId/tests/batch/move', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = batchMoveSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  const planned = await planMoves(projectId, input.moves);

  const tests = await prisma.$transaction(async (tx) => {
    for (const move of planned) {
      /*
       * A compare-and-set on the old path, not an update by id.
       *
       * Validation ran before the transaction opened, so between the two some
       * other request may have moved or deleted one of these rows out from
       * under the plan. Naming `filePath: move.from` in the `where` makes each
       * write assert the world it was planned against: a row that moved matches
       * nothing, the count comes back 0, and throwing here rolls the whole
       * batch back rather than applying a plan to a tree that has changed.
       *
       * `updateMany` rather than `update` for the same reason it is used in
       * team.ts — it reports a count instead of throwing a Prisma error we
       * would have to translate, and it is filterable, so the tenancy extension
       * merges the orgId into this `where` too.
       */
      const applied = await tx.test.updateMany({
        where: { id: move.id, projectId, filePath: move.from },
        data: { filePath: move.to, ...(move.name ? { name: move.name } : {}) },
      });
      if (applied.count !== 1) {
        throw conflict(
          `${move.from} changed while this batch was being applied — nothing was moved`,
        );
      }
    }

    return tx.test.findMany({
      where: { id: { in: planned.map((move) => move.id) } },
      orderBy: [{ filePath: 'asc' }],
      select: { id: true, name: true, filePath: true },
    });
  });

  await audit({
    actor,
    action: 'tests.batch-move',
    targetType: 'Project',
    targetId: projectId,
    metadata: {
      files: planned.length,
      moves: planned.map((move) => ({ from: move.from, to: move.to })),
    },
  });

  res.json({ moved: planned.length, tests });
});

/**
 * Soft-delete many files at once. Same guarantee as the batch move, and soft
 * for the same reason the single-file delete is (see below): a test carries its
 * version history and its past results, and a hard delete would rewrite the
 * record of what was tested when — forty times over, here.
 */
projectsRouter.post('/:projectId/tests/batch/delete', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = batchDeleteSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  /*
   * Deduplicated rather than rejected, which is the opposite of what the batch
   * move does with a repeated id — and deliberately. Two moves of one file are
   * two different destinations and there is no right answer; two deletes of one
   * file are the same instruction said twice, and the answer is obvious.
   */
  const ids = [...new Set(input.testIds)];

  const rows = await prisma.test.findMany({
    where: { projectId, id: { in: ids } },
    select: { id: true, name: true, filePath: true, disabledAt: true },
  });
  // Scoped client: another org's id, another project's id and a made-up id all
  // fail to come back and all become the same 404.
  if (rows.length !== ids.length) throw notFound('Test');

  const gone = rows.find((row) => row.disabledAt);
  if (gone) throw conflict(`${gone.filePath} is already deleted`);

  const deletedAt = new Date();

  /*
   * One statement would already be atomic; the transaction is here for the
   * check that follows it. `disabledAt: null` in the `where` means a file
   * deleted by someone else a moment ago is simply not among the rows updated —
   * so the count is how the race is detected, and the rollback is how the batch
   * stays all-or-nothing once it has been.
   */
  await prisma.$transaction(async (tx) => {
    const applied = await tx.test.updateMany({
      where: { projectId, id: { in: ids }, disabledAt: null },
      data: { disabledAt: deletedAt },
    });
    if (applied.count !== ids.length) {
      throw conflict(
        'One of those files was deleted while this batch was being applied — nothing was deleted',
      );
    }
  });

  await audit({
    actor,
    action: 'tests.batch-delete',
    targetType: 'Project',
    targetId: projectId,
    metadata: {
      files: ids.length,
      tests: rows.map((row) => ({ id: row.id, filePath: row.filePath })),
    },
  });

  res.json({
    deleted: ids.length,
    tests: rows.map((row) => ({ id: row.id, name: row.name, filePath: row.filePath })),
  });
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
        /*
         * The copy inherits the role. A duplicate exists to be edited into a
         * near-identical test, and a copy of an admin test that silently runs
         * anonymously is the surprise this column was added to end — it would
         * reach a login page instead of the feature and the diff against the
         * original would explain nothing. The source is in this project by the
         * check above, so its profile is in this project too; no second
         * tenancy check is owed.
         */
        authProfileId: source.authProfileId,
        authProfileRequired: source.authProfileRequired,
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
      // The inherited role is returned, not just stored. A duplicate is the one
      // place a test's role changes hands without anybody typing it, so the
      // copy has to be able to say which role it came away with.
      select: {
        id: true,
        name: true,
        filePath: true,
        authProfileId: true,
        authProfileRequired: true,
      },
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
