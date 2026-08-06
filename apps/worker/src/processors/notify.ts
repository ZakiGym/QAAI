/**
 * Outbound notifications (§7) — pull-request comments, chat, and webhooks.
 *
 * One processor decides who hears about a finished run: a PR-triggered run gets
 * a comment on the pull request, a failing run reaches the chat integrations
 * that asked for failures (the default), and a monitor crossing its failure
 * threshold pages chat directly. A green run reaches only an integration whose
 * notification preference says `runFinished: 'all'` — by default it stays
 * quiet, because nobody wants that notification.
 *
 * The PR comment deliberately reports triage verdicts rather than raw pass/fail.
 * "3 failed" makes a reviewer open QAAI; "2 look like real bugs, 1 is an
 * intended change with a fix proposed" lets them act without leaving GitHub.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { describeWebhookFailure } from '@qaai/shared';
import type { NotifyJob } from '@qaai/shared';
import { logger, prisma } from '../context.js';
import { open as openSecret } from '../vault.js';
import { enqueueDelivery, type DeliveryJob } from '../queues.js';
/*
 * Pure helpers shared with the API's integrations surface — imported the way
 * digest.ts imports run-selection.js (types and functions; no Prisma, no
 * Express, no env). Both sides must agree on the sealed-credential envelope,
 * the AAD, the destination rules and the preference semantics, and two
 * implementations of any of those is how a URL accepted at the door gets
 * refused at delivery — or a page goes to a channel that opted out.
 */
import {
  chatPayload,
  checkChatDestination,
  decodeChatCredentials,
  integrationAad,
  notifyPrefsOf,
  wantsRunFinished,
} from '../../../api/src/lib/chat-integrations.js';
import type { ChatCredentials, NotifyPrefs } from '../../../api/src/lib/chat-integrations.js';

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
 * Chat and webhook delivery (§7).
 *
 * Slack, Teams and Discord all accept an incoming-webhook POST, so one sender
 * covers all three — the payload shape differs only in which key holds the
 * text. A generic WEBHOOK is signed with HMAC-SHA256 so the receiver can verify
 * it came from QAAI, the same contract QAAI itself demands of GitHub.
 *
 * This processor no longer POSTs inline. The fan-out writes one PENDING
 * WebhookDelivery row per destination and enqueues one delivery job per row
 * (enqueueDelivery in ../queues.ts); processDelivery below performs the POST
 * and records EVERY attempt on the row — attempts, response status, last
 * error. A failed send is retried by the queue with exponential backoff, and
 * the attempt that exhausts the retries leaves the row FAILED holding the
 * final error. That FAILED row is the dead letter — there is no separate
 * dead-letter store — and it is readable through the deliveries endpoint
 * (GET /integrations/:id/deliveries), because a notification that silently
 * failed is indistinguishable from one that was never sent, and a customer
 * asking "why didn't I get paged" deserves an answer.
 *
 * The transport itself carries digest.ts's delivery hardening, ported rather
 * than reinvented: a bounded request, 3xx treated as an error instead of a
 * hop, chat hosts pinned per provider, and error strings that never echo the
 * URL or what the runtime said — a webhook URL IS the credential.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fan a message out: one WebhookDelivery row and one queued delivery job per
 * enabled destination that WANTS the event. Sends nothing itself.
 *
 * `wants` is the org-scoped notification preference (§7), read from the same
 * `Integration.config.notify` the API writes: which events reach which
 * integration. Filtered here at fan-out so an opted-out channel gets no row at
 * all — "you asked not to hear this" is a preference honoured, not a failed
 * delivery, and it does not belong in the delivery log.
 *
 * `jobKey` is the BullMQ id of the notify job, stable across that job's
 * retries. The row id is derived from it and the write is an upsert, so a
 * retried notify job (the PR-comment half below can throw) re-claims the same
 * rows and — via enqueueDelivery's jobId — the same delivery jobs, instead of
 * paging every channel a second time.
 */
async function fanOutToChat(
  orgId: string,
  event: string,
  text: string,
  jobKey: string,
  wants: (prefs: NotifyPrefs) => boolean = () => true,
): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { orgId, enabled: true, kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] } },
    select: { id: true, kind: true, config: true, configEnc: true },
  });

  for (const integration of integrations) {
    if (!wants(notifyPrefsOf(integration.config))) continue;

    /*
     * The URL is sealed in the vault (it IS the credential — see the API's
     * chat CRUD), so the only static check left at fan-out is that a
     * credential exists at all. Everything about the URL itself — parse,
     * https, pinned host — is checked by the delivery job after unsealing.
     */
    const problem = integration.configEnc
      ? null
      : 'This integration has no webhook URL stored.';

    const deliveryId = `wd-${jobKey}-${integration.id}`;
    try {
      await prisma.webhookDelivery.upsert({
        where: { id: deliveryId },
        create: {
          id: deliveryId,
          orgId,
          integrationId: integration.id,
          event,
          payload: { text } as object,
          signature: '',
          /*
           * An unusable destination dead-letters immediately, with the reason
           * and zero attempts — digest.ts only logs its skips, but this
           * processor's contract is that every destination that did not hear
           * about a red run has a row saying why. Retrying cannot help a URL
           * that fails static checks.
           */
          status: problem ? 'FAILED' : 'PENDING',
          attempts: 0,
          lastError: problem,
        },
        // A notify retry must not reset a row its delivery job is already
        // recording into.
        update: {},
      });
    } catch (err) {
      // A failure to RECORD one destination must not cost the others theirs.
      logger.error({ err, integrationId: integration.id }, 'could not record a delivery row');
      continue;
    }

    if (problem) {
      logger.warn({ integrationId: integration.id, kind: integration.kind }, problem);
      continue;
    }

    await enqueueDelivery({ orgId, deliveryId });
  }
}

/** The attempt this call IS, as BullMQ frames it: 1-based, out of how many. */
export interface DeliveryAttempt {
  attempt: number;
  maxAttempts: number;
}

/**
 * One POST to one destination, recorded on its WebhookDelivery row.
 *
 * Reads everything fresh — the row for the payload, the Integration for the
 * URL and the secret — because the job may run minutes after it was enqueued
 * and an admin who fixed a broken webhook URL mid-retry should get the retry
 * delivered to the fixed URL (the same "carry ids, re-read state" rule every
 * queue payload in this repo follows).
 *
 * A failure with retries remaining records the attempt and re-throws, so the
 * QUEUE schedules the retry with backoff — no in-process sleeping, no worker
 * slot held through the wait, nothing lost to a restart. The LAST attempt
 * records status FAILED with the final error and returns instead of throwing:
 * the dead letter is the row itself — not BullMQ's failed set — kept where the
 * customer can read it, through GET /integrations/:id/deliveries.
 */
export async function processDelivery(job: DeliveryJob, meta: DeliveryAttempt): Promise<void> {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: job.deliveryId, orgId: job.orgId },
    select: { id: true, integrationId: true, status: true, payload: true, event: true },
  });

  // Gone — deleting an integration cascades its rows. Nothing to record into,
  // so nothing to retry for.
  if (!delivery) {
    logger.warn({ deliveryId: job.deliveryId }, 'delivery row is gone; dropping the job');
    return;
  }

  // A redelivered job after a landed POST must return, never re-send.
  if (delivery.status === 'SENT') return;

  const finalAttempt = meta.attempt >= meta.maxAttempts;

  /*
   * Every attempt lands on the row, success or failure. Non-final failures
   * stay PENDING — retries remain — and the final one flips the row to FAILED
   * with the error that killed it. Failing to RECORD a failed attempt is
   * logged rather than thrown: the real error is the delivery's, and it is
   * about to be re-thrown anyway.
   */
  const recordFailure = async (
    error: string,
    responseStatus: number | null,
    signature: string,
  ): Promise<void> => {
    await prisma.webhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          attempts: { increment: 1 },
          status: finalAttempt ? 'FAILED' : 'PENDING',
          responseStatus,
          lastError: error,
          signature,
        },
      })
      .catch((err) =>
        logger.error({ err, deliveryId: delivery.id }, 'could not record the failed attempt'),
      );
    if (finalAttempt) {
      logger.error(
        { deliveryId: delivery.id, integrationId: delivery.integrationId, error },
        'delivery dead-lettered after its last attempt',
      );
    }
  };

  const integration = await prisma.integration.findFirst({
    where: { id: delivery.integrationId, orgId: job.orgId },
    select: { id: true, kind: true, config: true, configEnc: true, enabled: true },
  });

  if (!integration || !integration.enabled) {
    // An admin switched it off (or deleted it) while retries were in flight.
    // More retries cannot be what they meant: dead-letter now, with the reason.
    await prisma.webhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          lastError: 'the integration was disabled or removed before this delivery landed',
        },
      })
      .catch((err) =>
        logger.error({ err, deliveryId: delivery.id }, 'could not record the failed attempt'),
      );
    return;
  }

  const config = (integration.config ?? {}) as { keyVersion?: number };

  /*
   * Unseal the credential envelope: the URL, plus the WEBHOOK signing secret
   * when one exists. One envelope on purpose — the URL and the secret that
   * signs payloads to it can never rotate apart, and "URL readable but secret
   * not" is a state that cannot exist. An unreadable envelope must not send
   * anything; it IS retried rather than dead-lettered at once, because
   * re-saving the integration mints a fresh seal and the next attempt (which
   * re-reads everything) uses it.
   */
  let credentials: ChatCredentials;
  try {
    if (!integration.configEnc) throw new Error('no sealed credentials');
    credentials = decodeChatCredentials(
      openSecret(
        integration.configEnc,
        config.keyVersion ?? 1,
        job.orgId,
        integrationAad(integration.id),
      ),
    );
  } catch {
    const error = 'could not unseal the webhook credentials; nothing was sent';
    logger.error({ integrationId: integration.id }, error);
    await recordFailure(error, null, '');
    if (finalAttempt) return;
    throw new Error(error);
  }

  /*
   * Destination rules are digest.ts's, via the shared checkChatDestination,
   * with one deliberate difference: a generic WEBHOOK is delivered, not
   * skipped. Posting to a customer-chosen host is this processor's §7
   * contract, and the HMAC signature is what makes that contract honourable —
   * but it must be https on a public name, because a signature does not help
   * anyone who broadcasts the body in clear or aims it inside the cluster.
   * Chat providers stay pinned to their real webhook hosts: the text being
   * posted describes a customer's failing tests, so an integration may choose
   * its PATH (that is the webhook token) and never its host. Checked HERE, on
   * the just-unsealed URL, not only at write time — recorded and retried like
   * any failure, so a config fixed mid-retry still lands and one that stays
   * broken burns down to FAILED.
   */
  const destination = checkChatDestination(integration.kind, credentials.url);
  if (!destination.ok) {
    await recordFailure(destination.reason, null, '');
    if (finalAttempt) return;
    throw new Error(destination.reason);
  }

  const text = String((delivery.payload as { text?: unknown } | null)?.text ?? '');

  // Teams wants `text`, Discord wants `content`, Slack accepts `text`; a
  // generic WEBHOOK gets the event name alongside so a receiver can route
  // without parsing prose. Same helper the API's test endpoint uses, so a test
  // send proves the exact body shape a real one will have.
  const body = chatPayload(integration.kind, delivery.event, text);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'qaai',
  };

  // A generic webhook gets a signature so the receiver can trust it.
  let signature = '';
  if (integration.kind === 'WEBHOOK' && credentials.secret) {
    signature = `sha256=${createHmac('sha256', credentials.secret).update(body).digest('hex')}`;
    headers['x-qaai-signature-256'] = signature;
  }

  let status: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(destination.url, {
      method: 'POST',
      headers,
      body,
      // A 3xx is an error, not a hop. Following one would re-post the body —
      // and the webhook token in the URL — to whatever Location named.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    if (response.status >= 300 && response.status < 400) {
      error = 'redirected; not followed';
    } else if (!response.ok) {
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    // Deliberately not err.message: a fetch failure embeds the URL, and the
    // URL is the credential. The shared classifier names the failure CLASS
    // (refused / DNS / TLS / reset) from the wrapped syscall code instead —
    // debuggable without the echo.
    error = describeWebhookFailure(err, REQUEST_TIMEOUT_MS / 1000);
  }

  if (error) {
    logger.warn(
      {
        integrationId: integration.id,
        kind: integration.kind,
        error,
        attempt: meta.attempt,
        of: meta.maxAttempts,
      },
      'delivery attempt failed',
    );
    await recordFailure(error, status, signature);
    if (finalAttempt) return;
    throw new Error(error);
  }

  // Landed. If RECORDING that fails, do not throw: a retry would re-send a
  // message that was already delivered, and a duplicate page is worse than a
  // PENDING row about a delivery the log says landed.
  await prisma.webhookDelivery
    .update({
      where: { id: delivery.id },
      data: {
        attempts: { increment: 1 },
        status: 'SENT',
        responseStatus: status,
        deliveredAt: new Date(),
        lastError: null,
        signature,
      },
    })
    .catch((err) =>
      logger.error({ err, deliveryId: delivery.id }, 'delivered, but could not record it'),
    );
}

export async function processNotify(job: NotifyJob, jobKey?: string): Promise<void> {
  const { orgId, event, payload } = job;

  // The fan-out derives delivery-row ids from this, so it must be stable
  // across THIS job's retries — index.ts passes the BullMQ job id. Only a
  // direct call (tests) arrives without one.
  const key = jobKey || randomUUID();

  // A monitor crossing its threshold pages chat directly — there is no PR to
  // comment on, and this is the alert the on-call person actually needs. It
  // deliberately ignores the `runFinished` preference: that preference is
  // about run REPORTS, and a monitor page is not one. Every enabled chat
  // integration hears it.
  if (event === 'monitor.down') {
    const name = String(payload.name ?? 'A monitor');
    const streak = Number(payload.streak ?? 0);
    await fanOutToChat(
      orgId,
      event,
      `🔴 ${name} has failed ${streak} checks in a row. QAAI run ${String(payload.runId ?? '')}`,
      key,
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

  /*
   * Chat gets told about any failing run, PR or not — that is the point of a
   * nightly schedule. Which integrations hear it is the org-scoped preference
   * (§7): `runFinished: 'failures'` (the default) and `'all'` both hear a red
   * run, only `'all'` hears a green one, and `'off'` hears neither. The
   * filter is per integration, inside the fan-out, so one org can keep a
   * loud #qa-firehose and a failures-only #eng in the same breath.
   */
  const runFailed = run.failedCount > 0;
  await fanOutToChat(
    orgId,
    event,
    runFailed
      ? `❌ QAAI: ${run.failedCount} test(s) failed, ${run.passedCount} passed. Run ${run.id}`
      : `✅ QAAI: all ${run.passedCount} test(s) passed. Run ${run.id}`,
    key,
    (prefs) => wantsRunFinished(prefs, runFailed),
  );

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
