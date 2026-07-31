/**
 * File a failing test as a bug, in one click (§7).
 *
 * The verdict screen's whole promise is "evidence attached, bug filed in one
 * click", so this endpoint takes a single `resultId` and does everything else:
 * picks the org's tracker, builds the issue from the run, files it, and records
 * the link on the triage verdict so the button can never be pressed twice for
 * the same failure.
 *
 * The token handling is deliberately ordered — pick the integration, validate
 * the destination, and only then unseal the token. A repointed integration
 * therefore fails while the credential is still ciphertext, which is the same
 * discipline the git push handler follows and for the same reason.
 */

import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { openToken } from '../lib/integrations.js';
import { registerRequestSecrets } from '../lib/logger.js';
import {
  ISSUE_TRACKER_KINDS,
  IssueFilingError,
  TRACKER_LABEL,
  buildIssue,
  createIssue,
  isIssueTrackerKind,
  parseIssueConfig,
  redactSecrets,
} from '../lib/issues.js';
import type { IssueTrackerKind } from '../lib/issues.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import { env } from '../env.js';

export const issuesRouter: Router = Router();

issuesRouter.use(requireAuth);

/** Statuses worth filing. A green or skipped result has no bug in it. */
const FILEABLE = new Set(['FAILED', 'TIMED_OUT', 'FLAKY']);

/**
 * Which tracker an already-filed URL points at. Only used on the
 * already-filed path, where the response should still carry a provider so the
 * UI can render the same chip it renders after a fresh file.
 */
function providerOfUrl(url: string): IssueTrackerKind | null {
  try {
    const host = new URL(url).hostname;
    if (host === 'github.com' || host.endsWith('.github.com')) return 'GITHUB';
    if (host === 'linear.app' || host.endsWith('.linear.app')) return 'LINEAR';
    return 'JIRA';
  } catch {
    return null;
  }
}

issuesRouter.post('/', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const resultId = String(req.body?.resultId ?? '').trim();
  if (!resultId) throw badRequest('resultId is required');

  // Optional, and the answer to "we connected both GitHub and Linear". Absent,
  // the single connected tracker is used.
  const integrationId = req.body?.integrationId ? String(req.body.integrationId).trim() : null;

  const result = await prisma.testResult.findUnique({
    where: { id: resultId },
    select: {
      id: true,
      status: true,
      durationMs: true,
      errorMessage: true,
      retriedAndPassed: true,
      videoKey: true,
      traceKey: true,
      test: { select: { name: true, filePath: true, type: true, priority: true } },
      run: {
        select: {
          id: true,
          projectId: true,
          commitSha: true,
          branch: true,
          prNumber: true,
          project: { select: { name: true } },
          environment: { select: { name: true, kind: true, baseUrl: true } },
        },
      },
      verdict: {
        select: {
          id: true,
          verdict: true,
          overriddenTo: true,
          confidence: true,
          explanation: true,
          issueUrl: true,
        },
      },
      // The locator that broke is the single most useful line in the issue, so
      // the first failing step comes along rather than just the run summary.
      steps: {
        where: { status: 'FAILED' },
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          index: true,
          title: true,
          selector: true,
          expected: true,
          actual: true,
          errorMessage: true,
        },
      },
    },
  });
  if (!result) throw notFound('Test result');

  if (!FILEABLE.has(result.status)) {
    throw badRequest(
      `That test ${result.status === 'PASSED' ? 'passed' : 'did not run'} — there is nothing to file.`,
    );
  }

  /*
   * Filing twice is the real hazard of a one-click button: a slow provider, an
   * impatient second click, two issues. The stored link is the guard, so an
   * already-filed failure returns its existing issue instead of creating
   * another one.
   */
  if (result.verdict?.issueUrl) {
    res.json({
      url: result.verdict.issueUrl,
      provider: providerOfUrl(result.verdict.issueUrl),
      key: null,
      alreadyFiled: true,
    });
    return;
  }

  const candidates = await prisma.integration.findMany({
    where: {
      kind: { in: [...ISSUE_TRACKER_KINDS] },
      enabled: true,
      // A tracker pinned to another project must not receive this project's bugs.
      OR: [{ projectId: null }, { projectId: result.run.projectId }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, name: true, projectId: true, config: true, configEnc: true },
  });

  // A tracker configured for this project specifically wins over the org-wide
  // one; an org that bothered to pin a tracker to a project meant it.
  const scoped = candidates.filter((c) => c.projectId === result.run.projectId);
  const pool = scoped.length > 0 ? scoped : candidates;

  const integration = integrationId
    ? (pool.find((c) => c.id === integrationId) ?? null)
    : (pool[0] ?? null);

  if (integrationId && !integration) throw notFound('Integration');

  if (!integration) {
    throw badRequest(
      'No issue tracker is connected. Connect GitHub, Jira or Linear under Settings → Integrations, then file the bug again.',
    );
  }

  if (!integrationId && pool.length > 1) {
    // Guessing which tracker a bug belongs in is not a decision QAAI gets to
    // make silently — say which ones exist and let the caller pick.
    throw badRequest(
      `${pool.length} issue trackers are connected (${pool
        .map((c) => c.name)
        .join(', ')}). Pass integrationId to choose one.`,
      { integrations: pool.map((c) => ({ id: c.id, kind: c.kind, name: c.name })) },
    );
  }

  if (!isIssueTrackerKind(integration.kind)) throw notFound('Integration');
  const kind = integration.kind;

  if (!integration.configEnc) {
    throw badRequest(
      `"${integration.name}" has no ${TRACKER_LABEL[kind]} token stored. Add one on that integration in Settings → Integrations.`,
    );
  }

  // Destination first, token second: a config that points somewhere it should
  // not must fail before the credential is ever produced in plaintext.
  let config;
  try {
    config = parseIssueConfig(kind, integration.config);
  } catch (err) {
    if (err instanceof IssueFilingError) throw badRequest(err.message);
    throw err;
  }

  let token: string;
  try {
    token = openToken(integration.configEnc, config.keyVersion, actor.orgId, integration.id);
  } catch {
    // The vault message names the key state, which is not the user's problem;
    // what they can act on is re-entering the token.
    throw badRequest(
      `The stored ${TRACKER_LABEL[kind]} token could not be read. Re-enter it on "${integration.name}" in Settings → Integrations.`,
    );
  }
  // Belt and braces: anything logged for the rest of this request is masked.
  registerRequestSecrets([token]);

  const verdict = result.verdict;
  const issue = buildIssue({
    project: result.run.project,
    environment: result.run.environment,
    run: result.run,
    test: result.test,
    result: {
      id: result.id,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage,
      retriedAndPassed: result.retriedAndPassed,
      videoKey: result.videoKey,
      traceKey: result.traceKey,
    },
    step: result.steps[0] ?? null,
    // A human override is what the org actually believes about this failure, so
    // it is what the issue reports — the same rule the quality gate uses.
    verdict: verdict
      ? {
          verdict: verdict.overriddenTo ?? verdict.verdict,
          confidence: verdict.confidence,
          explanation: verdict.explanation,
        }
      : null,
    webUrl: env.WEB_PUBLIC_URL,
    apiUrl: env.API_PUBLIC_URL,
  });

  let created;
  try {
    created = await createIssue(config, token, issue);
  } catch (err) {
    const message =
      err instanceof IssueFilingError
        ? err.message
        : `Filing the bug on ${TRACKER_LABEL[kind]} failed.`;
    const safe = redactSecrets(message);

    await audit({
      actor,
      action: 'issue.file.failed',
      targetType: 'TestResult',
      targetId: result.id,
      metadata: { integrationId: integration.id, provider: kind, reason: safe.slice(0, 300) },
    });

    // CONFIG problems are the caller's to fix; PROVIDER ones mean a well-formed
    // request the tracker would not carry out.
    if (err instanceof IssueFilingError && err.kind === 'CONFIG') throw badRequest(safe);
    throw unprocessable(safe);
  }

  /*
   * The link is recorded on TriageVerdict.issueUrl — the only column in the
   * schema for it. A failure that was never triaged has no verdict row and so
   * no home for the link: the issue is still filed and returned, but the
   * duplicate guard above cannot protect it. `persisted` says which case this
   * was rather than letting the UI assume.
   */
  if (verdict) {
    await prisma.triageVerdict.update({
      where: { id: verdict.id },
      data: { issueUrl: created.url },
    });
  }

  await audit({
    actor,
    action: 'issue.file',
    targetType: 'TestResult',
    targetId: result.id,
    metadata: {
      integrationId: integration.id,
      provider: created.provider,
      key: created.key,
      url: created.url,
      runId: result.run.id,
    },
  });

  res.status(201).json({
    url: created.url,
    provider: created.provider,
    key: created.key,
    persisted: Boolean(verdict),
  });
});
