/**
 * Integrations (§7) — git connections, and chat/webhook destinations.
 *
 * Two families share this router and one storage rule:
 *
 *   git  (GITHUB/GITLAB/BITBUCKET)      — where a project's tests get pushed.
 *   chat (SLACK/MSTEAMS/DISCORD/WEBHOOK) — where notifications and the digest go.
 *
 * The rule: the credential is write-only. A git token, a webhook URL, a signing
 * secret — each is sealed into the vault on the way in and never comes back out
 * of any endpoint. Responses expose `hasToken`/`hasUrl`/`hasSecret` and a
 * masked hint, so the UI can say "something is stored" without ever holding it.
 * For chat kinds the URL itself is the credential (Slack, Teams and Discord put
 * the secret in the path), which is why it is vaulted rather than kept in
 * `Integration.config` like other non-secret settings.
 *
 * The deliveries read path lives here too. WebhookDelivery rows have been
 * written by the notify and digest processors since §7 landed and were read by
 * nothing — the one table that could answer "did my Slack notification go out?"
 * could not be asked. GET /integrations/:id/deliveries is that answer.
 */

import { createHmac } from 'node:crypto';
import { Router } from 'express';
import {
  describeWebhookFailure,
  createChatIntegrationSchema,
  createIntegrationSchema,
  updateChatIntegrationSchema,
  updateIntegrationSchema,
} from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  openChatCredentials,
  parseGitConfig,
  sealChatCredentials,
  sealToken,
} from '../lib/integrations.js';
import {
  ChatWebhookError,
  DEFAULT_NOTIFY_PREFS,
  chatPayload,
  checkChatDestination,
  isChatIntegrationKind,
  maskWebhookUrl,
  parseChatConfig,
  validateChatWebhookUrl,
} from '../lib/chat-integrations.js';
import type { ChatCredentials, NotifyPrefs } from '../lib/chat-integrations.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const integrationsRouter: Router = Router();

integrationsRouter.use(requireAuth);

/** A provider that has not answered a test send in this long is not going to. */
const TEST_TIMEOUT_MS = 15_000;

/** Rows per page of the delivery log. Newest first; older history can wait. */
const DELIVERIES_LIMIT = 50;

// ─── Git connections ─────────────────────────────────────────────────────────

/** Shape sent to clients — never includes configEnc or any token material. */
function present(row: {
  id: string;
  kind: string;
  name: string;
  config: unknown;
  configEnc: string | null;
  enabled: boolean;
  updatedAt: Date;
}) {
  const config = parseGitConfig(row.config);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    repo: config.repo,
    defaultBranch: config.defaultBranch,
    enabled: row.enabled,
    hasToken: row.configEnc !== null,
    updatedAt: row.updatedAt,
  };
}

integrationsRouter.get('/', async (_req, res) => {
  const rows = await prisma.integration.findMany({
    where: { kind: { in: ['GITHUB', 'GITLAB', 'BITBUCKET'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });
  res.json({ integrations: rows.map(present) });
});

integrationsRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = createIntegrationSchema.parse(req.body);

  const existing = await prisma.integration.findFirst({
    where: { kind: input.kind, name: input.name },
    select: { id: true },
  });
  if (existing) throw conflict(`An integration named "${input.name}" already exists`);

  // Created first so the token's AAD can bind to the row's own id.
  const created = await prisma.integration.create({
    data: {
      orgId: actor.orgId,
      kind: input.kind,
      name: input.name,
      config: { repo: input.repo, defaultBranch: input.defaultBranch },
      enabled: true,
    },
    select: { id: true },
  });

  const sealed = sealToken(input.token, actor.orgId, created.id);
  const row = await prisma.integration.update({
    where: { id: created.id },
    data: {
      configEnc: sealed.ciphertext,
      config: {
        repo: input.repo,
        defaultBranch: input.defaultBranch,
        keyVersion: sealed.keyVersion,
      },
    },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });

  // Repo and provider are fine to record; the token never appears in metadata.
  await audit({
    actor,
    action: 'integration.connect',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: input.kind, repo: input.repo, branch: input.defaultBranch },
  });

  res.status(201).json({ integration: present(row) });
});

// ─── Chat & webhook destinations ─────────────────────────────────────────────

/**
 * Shape sent to clients. The URL never appears: `host` and `urlHint` were
 * derived at write time from a URL that passed validation, and they are all a
 * screen needs to tell two hooks apart.
 */
function presentChat(row: {
  id: string;
  kind: string;
  name: string;
  config: unknown;
  configEnc: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  const config = parseChatConfig(row.config);
  const c = (row.config ?? {}) as { urlHint?: unknown };
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    host: config.host,
    urlHint: typeof c.urlHint === 'string' ? c.urlHint : '',
    enabled: row.enabled,
    hasUrl: row.configEnc !== null,
    hasSecret: config.hasSecret,
    notify: config.notify,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CHAT_SELECT = {
  id: true,
  kind: true,
  name: true,
  config: true,
  configEnc: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Maps a validation failure to a 400 whose message never contains the URL. */
function validatedUrl(kind: string, raw: string): { url: string; host: string } {
  if (!isChatIntegrationKind(kind)) throw badRequest(`${kind} is not a chat integration kind`);
  try {
    return validateChatWebhookUrl(kind, raw);
  } catch (err) {
    if (err instanceof ChatWebhookError) throw badRequest(err.message);
    throw err;
  }
}

/** The one sentence for a secret offered to a kind that cannot use it. */
const SECRET_ON_PINNED =
  'Only a generic WEBHOOK integration takes a signing secret — Slack, Teams and Discord authenticate by the URL itself.';

integrationsRouter.get('/chat', async (_req, res) => {
  const rows = await prisma.integration.findMany({
    where: { kind: { in: ['SLACK', 'MSTEAMS', 'DISCORD', 'WEBHOOK'] } },
    orderBy: { createdAt: 'asc' },
    select: CHAT_SELECT,
  });
  res.json({ integrations: rows.map(presentChat) });
});

integrationsRouter.post('/chat', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = createChatIntegrationSchema.parse(req.body);

  if (input.secret && input.kind !== 'WEBHOOK') throw badRequest(SECRET_ON_PINNED);

  // Validated BEFORE anything is stored, so a row can never exist whose sealed
  // URL was refused. The pinned-host check happens again at every send.
  const destination = validatedUrl(input.kind, input.url);

  const existing = await prisma.integration.findFirst({
    where: { kind: input.kind, name: input.name },
    select: { id: true },
  });
  if (existing) throw conflict(`An integration named "${input.name}" already exists`);

  const notify: NotifyPrefs = input.notify ?? DEFAULT_NOTIFY_PREFS;

  // Created first so the credential's AAD can bind to the row's own id — the
  // same two-step the git POST uses, for the same reason: a ciphertext copied
  // onto another row fails to decrypt instead of quietly working.
  const created = await prisma.integration.create({
    data: {
      orgId: actor.orgId,
      kind: input.kind,
      name: input.name,
      config: { host: destination.host, notify } as object,
      enabled: true,
    },
    select: { id: true },
  });

  const credentials: ChatCredentials = {
    url: destination.url,
    ...(input.secret ? { secret: input.secret } : {}),
  };
  const sealed = sealChatCredentials(credentials, actor.orgId, created.id);

  const row = await prisma.integration.update({
    where: { id: created.id },
    data: {
      configEnc: sealed.ciphertext,
      config: {
        host: destination.host,
        urlHint: maskWebhookUrl(destination.url),
        keyVersion: sealed.keyVersion,
        hasSecret: Boolean(input.secret),
        notify,
      } as object,
    },
    select: CHAT_SELECT,
  });

  // The host is fine to record; the URL never appears in metadata.
  await audit({
    actor,
    action: 'integration.connect',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: input.kind, host: destination.host, notify },
  });

  res.status(201).json({ integration: presentChat(row) });
});

integrationsRouter.patch('/chat/:id', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateChatIntegrationSchema.parse(req.body);

  const current = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, kind: true, config: true, configEnc: true },
  });
  if (!current) throw notFound('Integration');
  if (!isChatIntegrationKind(current.kind)) {
    throw badRequest('That integration is a git connection — use PATCH /integrations/:id.');
  }
  if (input.secret && current.kind !== 'WEBHOOK') throw badRequest(SECRET_ON_PINNED);

  const config = parseChatConfig(current.config);
  const notify: NotifyPrefs = { ...config.notify, ...(input.notify ?? {}) };

  let host = config.host;
  let urlHint = (current.config as { urlHint?: string } | null)?.urlHint ?? '';
  let keyVersion = config.keyVersion;
  let hasSecret = config.hasSecret;

  if (input.url) {
    const destination = validatedUrl(current.kind, input.url);

    /*
     * Rotating the URL keeps the stored signing secret unless a new one comes
     * with it. This is deliberately the OPPOSITE of the git PATCH, where a
     * repointed repo invalidates the token: a git token GRANTS access to the
     * destination, so carrying it to a new one is the attacker's move, while an
     * HMAC secret only proves the sender to the receiver — a repointed URL with
     * the old secret hands the new host signatures, not the secret itself, and
     * nothing it can replay anywhere.
     *
     * An old envelope that no longer decrypts must not block the rotation —
     * re-entering the URL is exactly how an operator recovers from that — so
     * the secret is dropped rather than the request refused, and the response's
     * `hasSecret: false` plus the audit row say so out loud.
     */
    let carried: string | undefined;
    if (input.secret) {
      carried = input.secret;
    } else if (current.kind === 'WEBHOOK' && current.configEnc && config.hasSecret) {
      try {
        carried = openChatCredentials(
          current.configEnc,
          config.keyVersion,
          actor.orgId,
          current.id,
        ).secret;
      } catch {
        carried = undefined;
      }
    }

    const sealed = sealChatCredentials(
      { url: destination.url, ...(carried ? { secret: carried } : {}) },
      actor.orgId,
      current.id,
    );
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: sealed.ciphertext },
    });

    host = destination.host;
    urlHint = maskWebhookUrl(destination.url);
    keyVersion = sealed.keyVersion;
    hasSecret = Boolean(carried);
  } else if (input.secret) {
    // A new secret needs the stored URL to seal alongside — the envelope keeps
    // them together so they can never rotate apart.
    if (!current.configEnc) {
      throw badRequest('Store a webhook URL before setting a signing secret.');
    }
    let url: string;
    try {
      url = openChatCredentials(current.configEnc, config.keyVersion, actor.orgId, current.id).url;
    } catch {
      throw unprocessable(
        'The stored webhook URL could not be decrypted — re-enter the URL together with the new secret.',
      );
    }
    const sealed = sealChatCredentials({ url, secret: input.secret }, actor.orgId, current.id);
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: sealed.ciphertext },
    });
    keyVersion = sealed.keyVersion;
    hasSecret = true;
  }

  const row = await prisma.integration.update({
    where: { id: current.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      config: { host, urlHint, keyVersion, hasSecret, notify } as object,
    },
    select: CHAT_SELECT,
  });

  await audit({
    actor,
    action: 'integration.update',
    targetType: 'Integration',
    targetId: row.id,
    metadata: {
      kind: row.kind,
      host,
      rotatedUrl: Boolean(input.url),
      rotatedSecret: Boolean(input.secret),
      secretDropped: config.hasSecret && !hasSecret,
      enabled: row.enabled,
      notify,
    },
  });

  res.json({ integration: presentChat(row) });
});

/**
 * Send a test message, so the UI can prove a connection works before 3am does.
 *
 * The outcome is reported honestly and recorded as a WebhookDelivery row either
 * way — a test that says "sent" when the provider answered 404 teaches people
 * to distrust the button, and a test that leaves no delivery row makes the log
 * lie about what was attempted. `attempts: 0` marks a send that was refused
 * before any bytes left (destination re-validation failed); `attempts: 1` marks
 * a real POST, however it ended.
 */
integrationsRouter.post('/chat/:id/test', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);

  const row = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, kind: true, name: true, config: true, configEnc: true },
  });
  if (!row) throw notFound('Integration');
  if (!isChatIntegrationKind(row.kind)) {
    throw badRequest('Only chat and webhook integrations can receive a test message.');
  }
  // Deliberately no `enabled` check: disable → fix → test → enable is the flow.
  if (!row.configEnc) throw badRequest('This integration has no webhook URL stored — set one first.');

  const config = parseChatConfig(row.config);
  let credentials: ChatCredentials;
  try {
    credentials = openChatCredentials(row.configEnc, config.keyVersion, actor.orgId, row.id);
  } catch {
    throw unprocessable('The stored webhook URL could not be decrypted — re-enter it.');
  }

  const text = `👋 This is a QAAI test message — the "${row.name}" integration is connected.`;
  const body = chatPayload(row.kind, 'test', text);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'qaai',
  };
  if (row.kind === 'WEBHOOK' && credentials.secret) {
    headers['x-qaai-signature-256'] =
      `sha256=${createHmac('sha256', credentials.secret).update(body).digest('hex')}`;
  }

  // Re-checked on the unsealed URL immediately before the POST — the same rule
  // the worker applies — so a ciphertext row that reached the database through
  // any path that skipped this API still cannot aim a payload off-host.
  const destination = checkChatDestination(row.kind, credentials.url);

  let responseStatus: number | null = null;
  let error: string | null = null;
  let attempts = 0;

  if (!destination.ok) {
    error = destination.reason;
  } else {
    attempts = 1;
    try {
      const response = await fetch(destination.url, {
        method: 'POST',
        headers,
        body,
        // A 3xx is an error, not a hop. Following one would re-post the body —
        // and the webhook token in the URL — to whatever Location named.
        redirect: 'manual',
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      responseStatus = response.status;
      if (response.status >= 300 && response.status < 400) {
        error = 'redirected; not followed';
      } else if (!response.ok) {
        error = `HTTP ${response.status}`;
      }
    } catch (err) {
      // Classified without the URL — the failure CLASS (refused / DNS / TLS /
      // reset) is what an operator debugs with, and none of it carries the
      // credential the way err.message would.
      error = describeWebhookFailure(err, TEST_TIMEOUT_MS / 1000);
    }
  }

  // Decided in one attempt, never PENDING: the test button does not retry —
  // the person is right there to press it again.
  const delivery = await prisma.webhookDelivery.create({
    data: {
      orgId: actor.orgId,
      integrationId: row.id,
      event: 'test',
      payload: { text },
      signature: headers['x-qaai-signature-256'] ?? '',
      status: error ? 'FAILED' : 'SENT',
      responseStatus,
      attempts,
      deliveredAt: error ? null : new Date(),
      lastError: error,
    },
    select: { id: true },
  });

  await audit({
    actor,
    action: 'integration.test',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: row.kind, ok: !error, responseStatus },
  });

  res.json({ ok: !error, responseStatus, error, deliveryId: delivery.id });
});

// ─── The delivery log ────────────────────────────────────────────────────────

/**
 * THE read path for WebhookDelivery — the fix for the write-only table.
 * Newest first, one page: "did my Slack notification go out, and if not, why"
 * is a question about the last few sends, not a data export. The payload and
 * signature columns stay out of the response; status, attempts and lastError
 * are the answer.
 */
integrationsRouter.get('/:id/deliveries', async (req, res) => {
  const integration = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true },
  });
  if (!integration) throw notFound('Integration');

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { integrationId: integration.id },
    orderBy: { createdAt: 'desc' },
    take: DELIVERIES_LIMIT,
    select: {
      id: true,
      event: true,
      status: true,
      responseStatus: true,
      attempts: true,
      deliveredAt: true,
      lastError: true,
      createdAt: true,
    },
  });
  res.json({ deliveries });
});

// ─── Git mutations ───────────────────────────────────────────────────────────

integrationsRouter.patch('/:id', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const input = updateIntegrationSchema.parse(req.body);

  const current = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, kind: true, config: true },
  });
  if (!current) throw notFound('Integration');
  // This handler rewrites config in the git shape; aimed at a chat row it would
  // silently destroy the notify preference and the stored host.
  if (isChatIntegrationKind(current.kind)) {
    throw badRequest('That integration is a chat destination — use PATCH /integrations/chat/:id.');
  }

  const config = parseGitConfig(current.config);
  const nextConfig: { repo: string; defaultBranch: string; keyVersion?: number } = {
    repo: input.repo ?? config.repo,
    defaultBranch: input.defaultBranch ?? config.defaultBranch,
    ...(config.keyVersion !== undefined ? { keyVersion: config.keyVersion } : {}),
  };

  // Repointing the remote invalidates the stored token unless a new one is
  // supplied in the same request. A token is granted for a destination, so
  // silently carrying it to a different one is exactly the move an attacker
  // would make to have it delivered somewhere they control.
  const repoChanged = input.repo !== undefined && input.repo !== config.repo;

  if (input.token) {
    const sealed = sealToken(input.token, actor.orgId, current.id);
    nextConfig.keyVersion = sealed.keyVersion;
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: sealed.ciphertext },
    });
  } else if (repoChanged) {
    delete nextConfig.keyVersion;
    await prisma.integration.update({
      where: { id: current.id },
      data: { configEnc: null },
    });
  }

  const row = await prisma.integration.update({
    where: { id: current.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      config: nextConfig,
    },
    select: {
      id: true,
      kind: true,
      name: true,
      config: true,
      configEnc: true,
      enabled: true,
      updatedAt: true,
    },
  });

  // The repo is recorded because a changed destination is the thing a reviewer
  // most needs to see; the token itself never appears.
  await audit({
    actor,
    action: 'integration.update',
    targetType: 'Integration',
    targetId: row.id,
    metadata: {
      repo: nextConfig.repo,
      repoChanged,
      rotatedToken: Boolean(input.token),
      tokenCleared: repoChanged && !input.token,
      enabled: row.enabled,
    },
  });

  res.json({ integration: present(row) });
});

integrationsRouter.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const actor = actorOf(req);
  const row = await prisma.integration.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, kind: true, name: true },
  });
  if (!row) throw notFound('Integration');

  // Kind-agnostic on purpose: disconnecting works the same for a git connection
  // and a chat destination, and WebhookDelivery rows cascade with the row.
  await prisma.integration.delete({ where: { id: row.id } });

  await audit({
    actor,
    action: 'integration.disconnect',
    targetType: 'Integration',
    targetId: row.id,
    metadata: { kind: row.kind, name: row.name },
  });

  res.json({ ok: true });
});
