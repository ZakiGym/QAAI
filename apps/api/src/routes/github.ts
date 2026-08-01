/**
 * The GitHub App's inbound half (§7): installation events and the re-run button.
 *
 * Two routers, because they need two different body parsers and this file does
 * not own the mount:
 *
 *   githubWebhooksRouter → mounted at '/webhooks', where index.ts already
 *     installs express.raw() ahead of the global JSON parser. The HMAC is
 *     computed over the RAW bytes GitHub signed; a parsed-and-reserialised body
 *     is a different string and every signature would fail. Stripe mounts under
 *     the same prefix for the same reason.
 *   githubRouter → mounted at '/github', ordinary JSON, session-authenticated.
 *     The cockpit asks it whether the app is set up and which repos it can see.
 *
 * ── What this endpoint is for ───────────────────────────────────────────────
 * Three jobs, and deliberately not a fourth:
 *
 *   • installation / installation_repositories — the app has to know which
 *     repositories it may act on, and this event is the only trustworthy source.
 *   • check_run rerequested / requested_action — the re-run button. A check a
 *     reviewer can re-run from the merge box is the difference between a tool
 *     in the workflow and a site they forget to visit.
 *   • ping — GitHub's connectivity check.
 *
 * A `pull_request` event is deliberately IGNORED here. Runs for pull requests
 * are created by POST /webhooks/github, which this change does not own, and
 * creating them in two places would give a repo wired both ways two runs, two
 * checks and two comments for one push. See the handover note at the bottom.
 *
 * ── Trust ───────────────────────────────────────────────────────────────────
 * Nothing in the payload is trusted before the signature is checked, and the
 * repository named in it is matched EXACTLY against a project — an unknown repo
 * is ignored, never guessed at. Every string that reaches a database lookup or a
 * URL path has been through the parsers in lib/github-app.ts first.
 */

import { Router } from 'express';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@qaai/shared';
import { env } from '../env.js';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import {
  CHECKS_QUEUE,
  isRerunRequest,
  parseCheckRunEvent,
  parseInstallationEvent,
  webhookSignatureMatches,
  type ChecksJob,
  type CheckRunEvent,
  type InstallationEvent,
} from '../lib/github-app.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const githubWebhooksRouter: Router = Router();
export const githubRouter: Router = Router();

/**
 * The checks queue's producer.
 *
 * Identical compromise to routes/bisect.ts: `enqueue()` in lib/queues.ts is
 * typed on `keyof JobPayloads` and `queueDepths()` iterates `QUEUE_NAMES`, both
 * of which live in @qaai/shared and are not this change's to edit. So one Queue,
 * lazily constructed, with its own connection.
 *
 * DELETE THIS the moment `qaai.checks` is in QUEUE_NAMES and `ChecksJob` is in
 * JobPayloads — this becomes `enqueue('qaai.checks', job)`, the depth shows up
 * on /health/ready, and the existing shutdown path closes the connection.
 */
let checksQueue: Queue | null = null;

function queue(): Queue {
  if (!checksQueue) {
    checksQueue = new Queue(CHECKS_QUEUE, {
      // BullMQ's requirement; without it a job can be dropped rather than
      // retried when Redis blinks.
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      defaultJobOptions: { removeOnComplete: { age: 24 * 3600, count: 500 } },
    });
  }
  return checksQueue;
}

async function enqueueCheck(job: ChecksJob): Promise<void> {
  await queue().add(CHECKS_QUEUE, job, {
    // One job per run per phase. A redelivered webhook must not produce two
    // check runs on the same PR.
    jobId: `check-${job.runId}-${job.phase}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

// An open ioredis socket keeps the event loop alive; without this the API would
// sit through its 10s shutdown backstop on every deploy.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void checksQueue?.close().catch(() => {});
  });
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Installation events, applied to the projects they name.
 *
 * `Project.repoFullName` / `Project.repoInstallationId` already exist in the
 * schema for exactly this ("set when the GitHub App is installed on the repo"),
 * so nothing new is stored. A repository with no QAAI project is not an error —
 * an admin may well install the app org-wide — it simply matches nothing.
 *
 * Comparison is case-insensitive because GitHub treats `Acme/Store` and
 * `acme/store` as the same repository and a webhook may spell it either way; a
 * case-sensitive match would silently forget an installation.
 */
async function applyInstallation(event: InstallationEvent): Promise<number> {
  if (!event.installationId) return 0;
  let touched = 0;

  const projectsFor = (repos: string[]) =>
    unscoped(() =>
      prisma.project.findMany({
        where: {
          archivedAt: null,
          OR: repos.map((repo) => ({
            repoFullName: { equals: repo, mode: 'insensitive' as const },
          })),
        },
        select: { id: true, orgId: true, repoFullName: true },
      }),
    );

  if (event.added.length > 0) {
    for (const project of await projectsFor(event.added)) {
      await withTenant(project.orgId, () =>
        prisma.project.update({
          where: { id: project.id },
          data: { repoInstallationId: event.installationId },
        }),
      );
      touched += 1;
      await audit({
        actor: { userId: '', orgId: project.orgId, ip: null, impersonatedBy: null },
        action: 'github_app.installed',
        targetType: 'Project',
        targetId: project.id,
        metadata: { repo: project.repoFullName, installationId: event.installationId },
      });
    }
  }

  /*
   * Losing access must take effect immediately and must be recorded.
   *
   * This is the branch that stops QAAI holding an installation id it is no
   * longer entitled to use — the check-run path treats a null id as "no app",
   * which is the honest degradation. It is audited for the same reason every
   * signal-suppressing action in this codebase is: an installation that
   * disappears is indistinguishable from a bug unless someone wrote it down.
   */
  const revoked = event.revokesAll
    ? await unscoped(() =>
        prisma.project.findMany({
          where: { repoInstallationId: event.installationId },
          select: { id: true, orgId: true, repoFullName: true },
        }),
      )
    : event.removed.length > 0
      ? await projectsFor(event.removed)
      : [];

  for (const project of revoked) {
    await withTenant(project.orgId, () =>
      prisma.project.update({ where: { id: project.id }, data: { repoInstallationId: null } }),
    );
    touched += 1;
    await audit({
      actor: { userId: '', orgId: project.orgId, ip: null, impersonatedBy: null },
      action: 'github_app.uninstalled',
      targetType: 'Project',
      targetId: project.id,
      metadata: {
        repo: project.repoFullName,
        installationId: event.installationId,
        reason: event.revokesAll ? event.action : 'repository removed',
      },
    });
  }

  return touched;
}

/**
 * The re-run button: a new run for the same commit, and a new check to report it.
 *
 * A reviewer pressed a button on a PR, so this creates exactly one run and does
 * it synchronously enough to answer 202 with its id. Environment selection is
 * the same rule POST /webhooks/github uses — a PR is a preview deploy and
 * running it against production would be actively dangerous.
 */
async function queueRerun(event: CheckRunEvent): Promise<string | null> {
  if (!event.repoFullName || !event.headSha) return null;

  // The webhook arrives with no session, so this one lookup runs unscoped —
  // everything after it runs inside that org's tenant scope.
  const project = await unscoped(() =>
    prisma.project.findFirst({
      where: {
        archivedAt: null,
        repoFullName: { equals: event.repoFullName as string, mode: 'insensitive' },
      },
      select: { id: true, orgId: true },
    }),
  );
  if (!project) return null;

  return withTenant(project.orgId, async () => {
    const environment =
      (await prisma.environment.findFirst({
        where: { projectId: project.id, kind: 'PREVIEW' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) ??
      (await prisma.environment.findFirst({
        where: { projectId: project.id, kind: { not: 'PRODUCTION' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }));
    if (!environment) return null;

    const tests = await prisma.test.findMany({
      where: {
        projectId: project.id,
        disabledAt: null,
        filePath: { not: { startsWith: 'fixtures/' } },
      },
      select: { id: true },
    });
    if (tests.length === 0) return null;

    const run = await prisma.run.create({
      data: {
        orgId: project.orgId,
        projectId: project.id,
        environmentId: environment.id,
        trigger: 'WEBHOOK',
        // Says who asked, in a form the run list can show without a join.
        triggeredBy: 'github-app:rerun',
        commitSha: event.headSha,
        prNumber: event.prNumbers[0] ?? null,
        totalCount: tests.length,
        results: {
          create: tests.map((t) => ({
            orgId: project.orgId,
            testId: t.id,
            status: 'SKIPPED' as const,
          })),
        },
      },
      select: { id: true },
    });

    await enqueue(QUEUE_NAMES.run, { orgId: project.orgId, runId: run.id });
    // The check is created straight away, so the reviewer sees the button they
    // pressed turn into a check that is visibly working rather than nothing.
    await enqueueCheck({ orgId: project.orgId, runId: run.id, phase: 'started' });

    await audit({
      actor: { userId: '', orgId: project.orgId, ip: null, impersonatedBy: null },
      action: 'github_app.rerun',
      targetType: 'Run',
      targetId: run.id,
      metadata: {
        repo: event.repoFullName,
        commitSha: event.headSha,
        checkRunId: event.checkRunId,
        via: event.action,
      },
    });

    return run.id;
  });
}

githubWebhooksRouter.post('/github-app', async (req, res) => {
  /*
   * The signature is over the exact bytes GitHub hashed.
   *
   * If `req.body` is not a Buffer, this router was mounted somewhere the raw
   * parser does not cover and every signature would be checked against a
   * re-serialised object. That is refused loudly rather than accepted, because
   * the failure mode of guessing here is an unauthenticated write endpoint.
   */
  if (!Buffer.isBuffer(req.body)) {
    logger.error(
      'githubWebhooksRouter must be mounted under a prefix parsed with express.raw() — mount it at /webhooks',
    );
    throw badRequest('This deployment is misconfigured: the GitHub App webhook is not raw-parsed');
  }
  const raw = req.body;
  const event = String(req.header('x-github-event') ?? '');

  const secret = (process.env.GITHUB_APP_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    // Refuse rather than accept unverified writes, exactly as /webhooks/github
    // does. A misconfigured deployment that trusted every caller would be worse
    // than a broken one.
    throw badRequest('GITHUB_APP_WEBHOOK_SECRET is not configured on this deployment');
  }
  if (!webhookSignatureMatches(raw, req.header('x-hub-signature-256'), secret)) {
    throw unauthorized('Bad webhook signature');
  }

  if (event === 'ping') {
    res.json({ ok: true, pong: true });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('Malformed JSON payload');
  }

  if (event === 'installation' || event === 'installation_repositories') {
    const parsed = parseInstallationEvent(payload);
    const touched = await applyInstallation(parsed);
    logger.info(
      { action: parsed.action, installationId: parsed.installationId, projects: touched },
      'github app installation event',
    );
    res.json({ ok: true, projectsUpdated: touched });
    return;
  }

  if (event === 'check_run' || event === 'check_suite') {
    const parsed = parseCheckRunEvent(payload);
    if (!isRerunRequest(parsed)) {
      res.json({ ok: true, ignored: `action ${parsed.action}` });
      return;
    }
    const runId = await queueRerun(parsed);
    if (!runId) {
      // 200 so GitHub stops retrying: the repo is genuinely not runnable here.
      logger.info({ repo: parsed.repoFullName }, 're-run requested for a repo QAAI cannot run');
      res.json({ ok: true, ignored: 'no project, environment or runnable tests for that repo' });
      return;
    }
    logger.info({ repo: parsed.repoFullName, runId }, 'queued a re-run from the check');
    res.status(202).json({ ok: true, runId });
    return;
  }

  // Notably `pull_request`: those runs belong to POST /webhooks/github, and
  // creating them here too would double every run. See the handover note.
  res.json({ ok: true, ignored: `event ${event}` });
});

// ─── Cockpit ─────────────────────────────────────────────────────────────────

githubRouter.use(requireAuth);

/**
 * Is the app set up, and which of this org's repos can it see?
 *
 * Deliberately says nothing about the private key beyond whether one loaded.
 * The App ID is public — it is on the app's own settings page and in every JWT
 * it issues — and having it in the response is what turns "the check never
 * appeared" into a two-minute diagnosis.
 */
githubRouter.get('/app', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);

  const projects = await prisma.project.findMany({
    where: { orgId: actor.orgId, archivedAt: null },
    select: { id: true, name: true, repoFullName: true, repoInstallationId: true },
    orderBy: { name: 'asc' },
  });

  const appId = (process.env.GITHUB_APP_ID ?? '').trim();
  const hasKey = Boolean(
    (process.env.GITHUB_APP_PRIVATE_KEY_ENC ?? process.env.GITHUB_APP_PRIVATE_KEY ?? '').trim(),
  );

  res.json({
    configured: Boolean(appId && hasKey),
    appId: appId || null,
    webhookConfigured: Boolean((process.env.GITHUB_APP_WEBHOOK_SECRET ?? '').trim()),
    // The honest fallback, stated rather than implied: without the app, PR
    // feedback is still delivered as a comment by the PAT integration.
    fallback: 'pull-request comment via the GitHub personal access token integration',
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      repoFullName: p.repoFullName,
      installed: Boolean(p.repoInstallationId),
    })),
  });
});

/**
 * Re-post the check for one run.
 *
 * The operator's escape hatch, and the thing that makes this feature debuggable
 * before anything else is wired: it re-derives the check from the run as it
 * stands now. Idempotent by construction — the processor updates the existing
 * check run rather than adding another.
 */
githubRouter.post('/checks/:runId', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const runId = String(req.params.runId ?? '');

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId: actor.orgId },
    select: { id: true, status: true, prNumber: true, commitSha: true },
  });
  if (!run) throw notFound('Run');
  if (!run.commitSha) {
    throw badRequest('That run has no commit SHA, so there is nothing on GitHub to attach a check to');
  }

  const phase = ['QUEUED', 'RUNNING'].includes(run.status) ? 'started' : 'completed';
  await enqueueCheck({ orgId: actor.orgId, runId: run.id, phase });

  await audit({
    actor: { ...actor, userAgent: req.headers['user-agent'] ?? null },
    action: 'github_app.check_reposted',
    targetType: 'Run',
    targetId: run.id,
    metadata: { phase },
  });

  res.status(202).json({ ok: true, runId: run.id, phase });
});

/*
 * ── Handover ────────────────────────────────────────────────────────────────
 * Mounts this change does not own, because index.ts is shared:
 *
 *   apps/api/src/index.ts
 *     import { githubRouter, githubWebhooksRouter } from './routes/github.js';
 *     app.use('/webhooks', githubWebhooksRouter);  // MUST be this prefix — it is
 *                                                  // the only one parsed raw
 *     app.use('/github', githubRouter);
 *
 *   apps/worker/src/index.ts
 *     import { armCheckSweep, processChecks } from './processors/checks.js';
 *     import { CHECKS_QUEUE, type ChecksJob } from '../../api/src/lib/github-app.js';
 *     // Network-bound on GitHub; it never holds a browser.
 *     register<ChecksJob>(CHECKS_QUEUE, config.concurrency, processChecks);
 *     void armCheckSweep().catch((err) => logger.error({ err }, 'could not arm the check sweep'));
 *
 * Then, in the GitHub App's own settings, set the webhook URL to
 * `<API_PUBLIC_URL>/webhooks/github-app`, give it Checks: write and Pull
 * requests: read, and subscribe it to `check_run`, `check_suite`,
 * `installation` and `installation_repositories`.
 *
 * Until the worker registration exists, every path here still records what
 * happened — installations are applied, re-runs are created and queued — and the
 * check runs themselves wait in Redis rather than being lost.
 */
