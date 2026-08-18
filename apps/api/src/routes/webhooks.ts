/**
 * Inbound webhooks (§7) — currently GitHub pull requests.
 *
 * This is the distribution feature: a PR opens, QAAI runs the tests that
 * matter against it, and posts what it found as a comment. The reviewer never
 * visits QAAI; the answer comes to them.
 *
 * Two things make this security-sensitive, and both are handled here rather than
 * trusted to the caller:
 *
 *  - The payload is unauthenticated until the HMAC is checked. Verification is
 *    timing-safe and happens over the RAW body, which is why `/webhooks` is
 *    mounted with express.raw() ahead of the global JSON parser.
 *  - The payload names a repository, and the repository decides which org's
 *    tests run. That lookup is deliberately exact-match against a connected
 *    integration; an unknown repo is ignored rather than guessed at.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { QUEUE_NAMES } from '@qaai/shared';
import { prisma, unscoped, withTenant } from '../lib/prisma.js';
import { enqueue } from '../lib/queues.js';
import { startRun } from '../lib/start-run.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { registerStripeWebhook } from './billing.js';

export const webhooksRouter: Router = Router();

/**
 * GitHub signs with `sha256=<hex hmac of the raw body>`.
 *
 * Compared with `timingSafeEqual` over equal-length buffers — a plain `===`
 * here leaks the signature a byte at a time to anyone who can measure the
 * response, which is exactly the attacker who is already sending requests.
 */
function signatureMatches(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    draft?: boolean;
    title?: string;
  };
  repository?: { full_name?: string };
}

/** PR actions worth a run. Everything else (labels, comments, assignees) is noise. */
const RUNNABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

webhooksRouter.post('/github', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const event = String(req.header('x-github-event') ?? '');

  if (!env.GITHUB_WEBHOOK_SECRET) {
    // Refuse rather than accept unverified writes. A misconfigured deployment
    // that silently trusted every caller would be worse than a broken one.
    throw badRequest('GITHUB_WEBHOOK_SECRET is not configured on this deployment');
  }
  if (!signatureMatches(raw, req.header('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET)) {
    throw unauthorized('Bad webhook signature');
  }

  // GitHub's connectivity check.
  if (event === 'ping') {
    res.json({ ok: true, pong: true });
    return;
  }
  if (event !== 'pull_request') {
    res.json({ ok: true, ignored: `event ${event}` });
    return;
  }

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as PullRequestPayload;
  } catch {
    throw badRequest('Malformed JSON payload');
  }

  const action = payload.action ?? '';
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;

  if (!RUNNABLE_ACTIONS.has(action) || !pr || !repoFullName) {
    res.json({ ok: true, ignored: `action ${action}` });
    return;
  }
  if (pr.draft) {
    res.json({ ok: true, ignored: 'draft pull request' });
    return;
  }

  /**
   * Which org owns this repo? The webhook arrives with no session, so this one
   * lookup runs unscoped — then everything after it runs inside that org's
   * tenant scope, so a repo can only ever reach its own tests.
   */
  const integration = await unscoped(() =>
    prisma.integration.findFirst({
      where: {
        enabled: true,
        kind: { in: ['GITHUB'] },
        // Matches both `owner/repo` and a full https URL ending in it.
        OR: [
          { config: { path: ['repo'], equals: repoFullName } },
          { config: { path: ['repo'], equals: `https://github.com/${repoFullName}` } },
        ],
      },
      select: { id: true, orgId: true, projectId: true },
    }),
  );

  if (!integration) {
    // Not ours, or not connected. Answer 200 so GitHub does not retry forever.
    logger.info({ repoFullName, action }, 'webhook for an unconnected repository');
    res.json({ ok: true, ignored: 'repository is not connected to a project' });
    return;
  }

  /*
   * Three outcomes, kept apart on purpose: a run, nothing to run, or a run this
   * org is not allowed to start. The third used to be impossible because this
   * path never asked — a free account that connected a repo got an unlimited
   * number of PR runs, and none of them moved the usage counter either.
   */
  const queued = await withTenant(integration.orgId, async (): Promise<
    { runId: string } | { refused: string } | null
  > => {
    const project = integration.projectId
      ? await prisma.project.findUnique({
          where: { id: integration.projectId },
          select: { id: true },
        })
      : await prisma.project.findFirst({
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
    if (!project) return null;

    // Prefer a PREVIEW environment for PR runs; a PR is a preview deploy, and
    // running it against production would be actively dangerous.
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
      where: { projectId: project.id, disabledAt: null, filePath: { not: { startsWith: 'fixtures/' } } },
      select: { id: true },
    });
    if (tests.length === 0) return null;

    /*
     * `advisory`, not `enforce`. GitHub is the caller here, not a person: a 402
     * thrown at a webhook is a retry loop that nobody reads and a PR that never
     * hears anything. The refusal comes back as a value and is reported the way
     * every other "we did nothing, here is why" on this endpoint is — 200 with
     * an `ignored` reason GitHub can stop retrying, and the reason is the one
     * the customer would see in the product.
     */
    const started = await startRun({
      db: prisma,
      orgId: integration.orgId,
      mode: 'advisory',
      unscope: unscoped,
      data: {
        orgId: integration.orgId,
        projectId: project.id,
        environmentId: environment.id,
        trigger: 'WEBHOOK',
        commitSha: pr.head?.sha ?? null,
        prNumber: pr.number,
        totalCount: tests.length,
        results: {
          create: tests.map((t) => ({
            orgId: integration.orgId,
            testId: t.id,
            status: 'SKIPPED' as const,
          })),
        },
      },
    });
    if (!started.created) {
      return { refused: started.quota.reason ?? 'This org is at its monthly run limit.' };
    }

    await enqueue(QUEUE_NAMES.run, { orgId: integration.orgId, runId: started.run.id });
    return { runId: started.run.id };
  });

  if (!queued) {
    res.json({ ok: true, ignored: 'no runnable tests or no non-production environment' });
    return;
  }

  if ('refused' in queued) {
    logger.warn(
      { repoFullName, pr: pr.number, orgId: integration.orgId },
      'a pull-request run was refused: the org is at its monthly run limit',
    );
    res.json({ ok: true, ignored: queued.refused });
    return;
  }

  logger.info(
    { repoFullName, pr: pr.number, runId: queued.runId },
    'queued a run for a pull request',
  );
  res.status(202).json({ ok: true, runId: queued.runId });
});

/*
 * Stripe mounts here rather than on /billing because signature verification has
 * to see the exact bytes Stripe signed, and only this prefix is parsed with
 * express.raw(). Registered from billing.ts so the Stripe client and the
 * price→plan mapping stay in one file.
 */
registerStripeWebhook(webhooksRouter);
