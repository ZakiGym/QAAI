/**
 * Outbound notifications (§7) — pull-request comments, chat, and webhooks.
 *
 * One processor decides who hears about a finished run: a PR-triggered run gets
 * a comment on the pull request, any failing run reaches Slack/Teams/Discord and
 * signed webhooks, and a monitor crossing its failure threshold pages chat
 * directly. A green run stays quiet — nobody wants that notification.
 *
 * The PR comment deliberately reports triage verdicts rather than raw pass/fail.
 * "3 failed" makes a reviewer open QAAI; "2 look like real bugs, 1 is an
 * intended change with a fix proposed" lets them act without leaving GitHub.
 */

import { createHmac } from 'node:crypto';
import type { NotifyJob } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';

const VERDICT_LABEL: Record<string, string> = {
  REAL_BUG: '🐞 likely a real bug',
  INTENDED_CHANGE: '🔁 an intended change',
  FLAKE: '🎲 a flake',
  ENV_ISSUE: '🌐 an environment issue',
};

/** GitHub caps a comment at 65536 chars; stay well under and stay readable. */
const MAX_FAILURES_LISTED = 10;

function buildComment(run: {
  id: string;
  status: string;
  passedCount: number;
  failedCount: number;
  flakyCount: number;
  results: Array<{
    status: string;
    errorMessage: string | null;
    test: { name: string; filePath: string };
    verdict: { verdict: string; confidence: number; explanation: string } | null;
  }>;
  gateResult: unknown;
}, webUrl: string): string {
  const failures = run.results.filter((r) => r.status === 'FAILED' || r.status === 'TIMED_OUT');
  const gate = (run.gateResult ?? null) as { passed?: boolean } | null;

  const header =
    failures.length === 0
      ? `### ✅ QAAI — ${run.passedCount} passed`
      : `### ❌ QAAI — ${failures.length} failed, ${run.passedCount} passed`;

  const lines: string[] = [header, ''];

  if (gate && gate.passed === false) {
    lines.push('> **The quality gate is blocking this PR.**', '');
  }
  if (run.flakyCount > 0) {
    lines.push(`_${run.flakyCount} test(s) passed only on retry and are counted as flaky._`, '');
  }

  for (const failure of failures.slice(0, MAX_FAILURES_LISTED)) {
    lines.push(`**${failure.test.name}**`);
    lines.push(`\`${failure.test.filePath}\``);
    if (failure.verdict) {
      const label = VERDICT_LABEL[failure.verdict.verdict] ?? failure.verdict.verdict;
      lines.push(
        `- Triage: ${label} (${Math.round(failure.verdict.confidence * 100)}% confident)`,
        `- ${failure.verdict.explanation.split('\n')[0]}`,
      );
    }
    if (failure.errorMessage) {
      const snippet = failure.errorMessage.split('\n').slice(0, 3).join('\n').slice(0, 500);
      lines.push('', '```', snippet, '```');
    }
    lines.push('');
  }

  if (failures.length > MAX_FAILURES_LISTED) {
    lines.push(`_…and ${failures.length - MAX_FAILURES_LISTED} more._`, '');
  }

  lines.push(`[Open the full run in QAAI](${webUrl}/runs/${run.id})`);
  return lines.join('\n');
}

/**
 * Chat and webhook delivery.
 *
 * Slack, Teams and Discord all accept an incoming-webhook POST, so one sender
 * covers all three — the payload shape differs only in which key holds the
 * text. A generic WEBHOOK is signed with HMAC-SHA256 so the receiver can verify
 * it came from QAAI, the same contract QAAI itself demands of GitHub.
 *
 * Every attempt is recorded as a WebhookDelivery: a notification that silently
 * failed is indistinguishable from one that was never sent, and a customer
 * asking "why didn't I get paged" deserves an answer.
 */
async function deliverToChat(orgId: string, text: string): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { orgId, enabled: true, kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] } },
    select: { id: true, kind: true, config: true, configEnc: true },
  });

  for (const integration of integrations) {
    const config = (integration.config ?? {}) as { url?: string; keyVersion?: number };
    if (!config.url) continue;

    // Teams wants `text`, Discord wants `content`, Slack accepts `text`.
    const body =
      integration.kind === 'DISCORD'
        ? JSON.stringify({ content: text })
        : JSON.stringify({ text });

    const headers: Record<string, string> = { 'content-type': 'application/json' };

    // A generic webhook gets a signature so the receiver can trust it.
    if (integration.kind === 'WEBHOOK' && integration.configEnc) {
      try {
        const secret = openSecret(
          integration.configEnc,
          config.keyVersion ?? 1,
          orgId,
          `integration:${integration.id}`,
        );
        headers['x-qaai-signature-256'] =
          `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      } catch {
        // An unreadable secret must not stop the notification going out
        // unsigned-but-logged; it must stop it entirely.
        logger.error({ integrationId: integration.id }, 'could not sign the webhook; skipping');
        continue;
      }
    }

    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetch(config.url, { method: 'POST', headers, body });
      status = response.status;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 200) : 'delivery failed';
    }

    await prisma.webhookDelivery
      .create({
        data: {
          orgId,
          integrationId: integration.id,
          event: 'run.finished',
          payload: { text } as object,
          signature: headers['x-qaai-signature-256'] ?? '',
          responseStatus: status,
          attempts: 1,
          deliveredAt: error ? null : new Date(),
          lastError: error,
        },
      })
      .catch(() => {});

    if (error) logger.warn({ integrationId: integration.id, error }, 'notification failed');
  }
}

export async function processNotify(job: NotifyJob): Promise<void> {
  const { orgId, event, payload } = job;

  // A monitor crossing its threshold pages chat directly — there is no PR to
  // comment on, and this is the alert the on-call person actually needs.
  if (event === 'monitor.down') {
    const name = String(payload.name ?? 'A monitor');
    const streak = Number(payload.streak ?? 0);
    await deliverToChat(
      orgId,
      `🔴 ${name} has failed ${streak} checks in a row. QAAI run ${String(payload.runId ?? '')}`,
    );
    return;
  }

  if (event !== 'run.finished') return;

  const runId = String(payload.runId ?? '');
  if (!runId) return;

  const run = await prisma.run.findFirst({
    where: { id: runId, orgId },
    select: {
      id: true,
      status: true,
      prNumber: true,
      passedCount: true,
      failedCount: true,
      flakyCount: true,
      gateResult: true,
      projectId: true,
      results: {
        select: {
          status: true,
          errorMessage: true,
          test: { select: { name: true, filePath: true } },
          verdict: { select: { verdict: true, confidence: true, explanation: true } },
        },
      },
    },
  });

  if (!run) return;

  // Chat gets told about any failing run, PR or not — that is the point of a
  // nightly schedule. A green run stays quiet; nobody wants that notification.
  if (run.failedCount > 0) {
    await deliverToChat(
      orgId,
      `❌ QAAI: ${run.failedCount} test(s) failed, ${run.passedCount} passed. Run ${run.id}`,
    );
  }

  // Only PR-triggered runs get a comment; a nightly run posting to a PR would
  // be noise.
  if (!run.prNumber) return;

  const integration = await prisma.integration.findFirst({
    where: { orgId, kind: 'GITHUB', enabled: true },
    select: { id: true, config: true, configEnc: true },
  });
  if (!integration?.configEnc) {
    logger.warn({ runId }, 'PR run finished but no GitHub token is stored; skipping the comment');
    return;
  }

  const cfg = (integration.config ?? {}) as { repo?: string; keyVersion?: number };
  const repo = (cfg.repo ?? '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!repo.includes('/')) {
    logger.warn({ runId, repo }, 'GitHub integration has no owner/repo; skipping the comment');
    return;
  }

  let token: string;
  try {
    token = openSecret(
      integration.configEnc,
      cfg.keyVersion ?? 1,
      orgId,
      `integration:${integration.id}`,
    );
  } catch (err) {
    logger.error({ err, runId }, 'could not decrypt the GitHub token');
    return;
  }

  const body = buildComment(run, process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000');

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${run.prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'qaai',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    // Never log the response body verbatim — an auth failure echoes the request.
    logger.error(
      { runId, status: response.status, repo, pr: run.prNumber },
      'posting the PR comment failed',
    );
    return;
  }

  logger.info({ runId, repo, pr: run.prNumber }, 'posted the PR comment');
}
