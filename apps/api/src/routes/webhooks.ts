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
 *
 * ── AND NOW IT IS ALSO WHERE A QAAI PULL REQUEST ENDS ──────────────────────
 *
 * `recordPullRequestMerged` (../lib/pull-request.ts) had no caller anywhere in
 * this repository, and nothing at all handled `action: 'closed'`. A record
 * written by the open path therefore stayed at OPEN for ever, whichever way the
 * review went. `closed` arrives for BOTH endings and `merged` is the only thing
 * that separates them, so both arms are handled here, in one place, from one
 * verified event.
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
/*
 * ── THE ONE SEAM, REUSED ───────────────────────────────────────────────────
 *
 * `pullRequestStore`/`pullRequestAudit` are the SAME Prisma halves
 * `POST /agent/heals/:healId/pull-request` drives, and `recordPullRequestMerged`
 * is the same policy. Nothing about a pull-request record is re-implemented
 * here: a second idea of what a record is would be a second idea of which cause
 * a merge belongs to.
 */
import { pullRequestAudit, pullRequestStore } from '../lib/git.js';
import { recordPullRequestMerged } from '../lib/pull-request.js';
import type { Remeasure } from '../lib/pull-request.js';
import {
  findRecordByBranch,
  qaaiBranchShape,
  recordPullRequestClosed,
} from '../lib/pull-request-store.js';
import { computeCoverage } from '../lib/coverage-store.js';

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
    /**
     * The ONLY field that separates a merge from a decline, because GitHub
     * sends `action: 'closed'` for both.
     *
     * Read as `=== true` and never as "not false": a payload that omitted it —
     * a replay, a trimmed delivery, a provider change — must fall into the
     * close arm, which records a weaker fact, rather than into the merge arm,
     * which recomputes a customer's coverage number.
     */
    merged?: boolean;
  };
  repository?: { full_name?: string };
}

/** PR actions worth a run. Everything else (labels, comments, assignees) is noise. */
const RUNNABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/** The one action that ends a pull request. Both endings arrive under it. */
const CLOSED_ACTION = 'closed';

/**
 * The coverage re-measurement a merge owes, over the API's own computation.
 *
 * ── WHY IT IS SYNCHRONOUS, AND WHAT THAT COSTS ─────────────────────────────
 *
 * `requestRecompute` (apps/worker's recompute-coverage processor) is the queued
 * path and the API cannot reach it: `RECOMPUTE_COVERAGE_QUEUE` is not a member
 * of `JobPayloads`, so `enqueue` has no overload for it. The alternative to
 * computing here is a merge whose coverage is never re-measured, which is the
 * stale number the `remeasured` field exists to make visible — so this runs
 * `computeCoverage` on the request thread, exactly as `routes/coverage.ts`
 * already does for a cockpit read.
 *
 * The cost is disclosed rather than hidden: a recompute takes seconds, a merge
 * event is rare (one per merged pull request), and if GitHub times the delivery
 * out and retries, `recordPullRequestMerged` answers ALREADY_MERGED and nothing
 * is computed twice. The queue entry that would make this a background job is in
 * this round's handover.
 */
function coverageRemeasure(): Remeasure {
  return {
    async recompute({ orgId, projectId }) {
      await computeCoverage({ orgId, projectId, persist: true });
    },
  };
}

/** What the close/merge arm answers, so the route body stays one shape. */
interface ReconcileReport {
  readonly outcome: string;
  readonly remeasured: boolean;
  readonly note: string;
}

/**
 * Reconcile a QAAI pull-request record against a VERIFIED `closed` event.
 *
 * ── THE ROW IS CHOSEN BY A VALUE QAAI WROTE ────────────────────────────────
 *
 * The head branch, and nothing else. NOT `pull_request.number` — that is the
 * host's identifier, it is a plain integer an attacker can pick, and selecting a
 * record by it would let a delivery for one repository move another's row.
 * `qaaiBranchShape` refuses any ref `branchNameFor` could not have produced
 * before a query runs, and the surviving string is only ever compared for
 * equality against the `branch` column QAAI composed and stored.
 *
 * `orgId` comes from the integration row this request already resolved, never
 * from the payload, so the search is confined to the tenant that connected the
 * repository.
 */
async function reconcileClosedPullRequest(args: {
  orgId: string;
  headRef: unknown;
  merged: boolean;
}): Promise<ReconcileReport> {
  const branch = qaaiBranchShape(args.headRef);
  if (!branch) {
    /*
     * Not a branch QAAI composed, so there is nothing of ours to reconcile.
     * The ref is NOT logged: it is customer-authored text of unbounded length
     * and a log line is the one place an injected sentence gets read by a human
     * out of context. The shape verdict is the fact worth keeping.
     */
    return {
      outcome: 'NOT_A_QAAI_BRANCH',
      remeasured: false,
      note: 'The head branch is not one QAAI composed, so no QAAI pull-request record is involved.',
    };
  }

  const lookup = await findRecordByBranch(prisma, { orgId: args.orgId, branch });
  if (lookup.kind === 'NONE') {
    return {
      outcome: 'NOT_OURS',
      remeasured: false,
      note: 'No QAAI pull-request record claims that branch, so nothing was changed.',
    };
  }
  if (lookup.kind === 'AMBIGUOUS') {
    /*
     * NOTHING IS WRITTEN. The branch carries only a prefix of the cause key, so
     * two causes can collide on it; recording a merge against whichever row the
     * planner returned first would attribute a customer's merged change to the
     * wrong cause and re-measure the wrong project. Loud and unresolved beats
     * quiet and wrong.
     */
    logger.warn(
      { orgId: args.orgId, branch, matched: lookup.matched },
      'two pull-request records claim one branch; neither was reconciled',
    );
    return {
      outcome: 'AMBIGUOUS',
      remeasured: false,
      note: `${lookup.matched} pull-request records claim that branch, so QAAI changed none of them.`,
    };
  }

  const store = pullRequestStore(prisma, {
    /*
     * The row's OWN branch, which is a value QAAI wrote. `pushedBranch` is only
     * read by `loadTarget`, which neither arm below calls — but handing a store
     * a branch taken from the payload would put attacker-influenced text one
     * refactor away from being the branch a pull request is opened against.
     */
    pushedBranch: lookup.row.branch,
  });
  /*
   * `userId: null` — nobody asked. The actor on this path is GitHub, and
   * `pull_request.merged_by.login` is a GitHub login, not a QAAI user id: it is
   * deliberately NOT carried, because a column whose siblings hold QAAI user
   * ids would then hold two different kinds of identity and no reader could tell
   * which one it had.
   */
  const audit = pullRequestAudit(prisma, { orgId: args.orgId, userId: null });

  if (args.merged) {
    const merge = await recordPullRequestMerged(
      { store, audit, remeasure: coverageRemeasure() },
      { orgId: args.orgId, causeKey: lookup.row.causeKey, mergedBy: null },
    );
    // Two facts, two fields, carried through rather than folded: the state was
    // recorded and the number may or may not have been re-measured.
    return { outcome: merge.outcome, remeasured: merge.remeasured, note: merge.note };
  }

  const closed = await recordPullRequestClosed(
    { store, audit },
    { orgId: args.orgId, causeKey: lookup.row.causeKey, closedBy: null },
  );
  return { outcome: closed.outcome, remeasured: false, note: closed.note };
}

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

  if (!pr || !repoFullName) {
    res.json({ ok: true, ignored: `action ${action}` });
    return;
  }
  /*
   * `closed` joins the runnable actions as a reason to keep reading — it starts
   * no run, and the DRAFT check below therefore moved into the run arm. A draft
   * pull request closed without merging still has a record to reconcile, and
   * skipping it here is how the row stayed at OPEN for ever.
   */
  if (!RUNNABLE_ACTIONS.has(action) && action !== CLOSED_ACTION) {
    res.json({ ok: true, ignored: `action ${action}` });
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
   * ── THE PULL REQUEST ENDED ────────────────────────────────────────────────
   *
   * Handled before the run arm because a `closed` event starts nothing: there
   * is no environment to pick and no quota to check, only a record of ours to
   * bring in line with what the reviewer decided. Everything runs inside the
   * resolved org's tenant scope, so a repository can only ever reach its own
   * rows.
   */
  if (action === CLOSED_ACTION) {
    const report = await withTenant(integration.orgId, () =>
      reconcileClosedPullRequest({
        orgId: integration.orgId,
        headRef: pr.head?.ref,
        merged: pr.merged === true,
      }),
    );
    logger.info(
      {
        repoFullName,
        pr: pr.number,
        orgId: integration.orgId,
        merged: pr.merged === true,
        outcome: report.outcome,
        remeasured: report.remeasured,
      },
      'reconciled a closed pull request',
    );
    res.json({
      ok: true,
      pullRequest: {
        outcome: report.outcome,
        // Said out loud on every answer. A merge recorded while the coverage
        // recompute failed must not be indistinguishable from one that ran.
        remeasured: report.remeasured,
        note: report.note,
      },
    });
    return;
  }

  if (pr.draft) {
    res.json({ ok: true, ignored: 'draft pull request' });
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
