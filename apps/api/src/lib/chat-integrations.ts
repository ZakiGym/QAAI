/**
 * Chat & webhook integrations (§7) — the pure half.
 *
 * Everything here is types and functions: no Prisma, no Express, no env. That
 * is a load-bearing property, not tidiness — the worker's notify and digest
 * processors import this module the same way digest.ts imports run-selection.js,
 * so both sides of the product validate a destination and read a preference
 * with the SAME code. Two implementations of "is this really a Slack host" is
 * how the API accepts a URL the worker then refuses at 3am.
 *
 * The security frame, inherited from issues.ts and digest.ts:
 *
 *  - The webhook URL IS the credential (Slack/Teams/Discord put the secret in
 *    the path). It is sealed into the vault (`Integration.configEnc`) and never
 *    stored in, or returned from, `Integration.config`. Every error message in
 *    this file is written to name the HOST at most — never the URL.
 *  - Providers with a known webhook host are PINNED to it. The config row may
 *    choose the path (that is the webhook token), never the host.
 *  - A generic WEBHOOK has no pinnable host, so it gets the Jira treatment:
 *    https only, no embedded credentials, no IP literal, no internal-only name.
 *  - Validation runs at write time AND again immediately before every send
 *    (`checkChatDestination`), so a ciphertext row edited or imported by some
 *    path that skipped the API still cannot point a payload at the wrong host.
 */

import type { ChatIntegrationKind, RunFinishedPref } from '@qaai/shared';
import { CHAT_INTEGRATION_KINDS } from '@qaai/shared';
import { isInternalHostname, isIpLiteralHost } from './issues.js';

export function isChatIntegrationKind(kind: string): kind is ChatIntegrationKind {
  return (CHAT_INTEGRATION_KINDS as readonly string[]).includes(kind);
}

/**
 * The AAD name every integration credential is sealed under —
 * `<orgId>:integration:<id>` once the vault prefixes the org. Lives in this
 * pure module (rather than lib/integrations.ts, which imports the API's vault
 * and env) so the worker can bind the same AAD without dragging the API's
 * process environment into its import graph.
 */
export function integrationAad(integrationId: string): string {
  return `integration:${integrationId}`;
}

// ─── Sealed credentials ──────────────────────────────────────────────────────

/**
 * What the vault ciphertext holds, as JSON. `secret` is the WEBHOOK signing
 * secret; the pinned providers have no use for one. Sealed as one envelope so
 * the URL and the secret that signs payloads to it can never rotate apart.
 */
export interface ChatCredentials {
  url: string;
  secret?: string;
}

export function encodeChatCredentials(credentials: ChatCredentials): string {
  return JSON.stringify(
    credentials.secret ? { url: credentials.url, secret: credentials.secret } : { url: credentials.url },
  );
}

/** Throws on anything that is not an envelope with a URL — fail closed, not sideways. */
export function decodeChatCredentials(plaintext: string): ChatCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('Sealed chat credentials are not a JSON envelope');
  }
  const c = (parsed ?? {}) as Record<string, unknown>;
  if (typeof c.url !== 'string' || c.url.length === 0) {
    throw new Error('Sealed chat credentials have no URL');
  }
  return {
    url: c.url,
    ...(typeof c.secret === 'string' && c.secret.length > 0 ? { secret: c.secret } : {}),
  };
}

// ─── Non-secret config ───────────────────────────────────────────────────────

export interface NotifyPrefs {
  runFinished: RunFinishedPref;
  digest: boolean;
}

/** Absent preference = today's behaviour: failing runs, and the digest. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { runFinished: 'failures', digest: true };

/**
 * The non-secret half, stored on `Integration.config`. `host` is safe to show —
 * it survived validation, so it is either a pinned provider host or a public
 * name — and it is what the UI displays instead of the URL it must never see.
 */
export interface ChatIntegrationConfig {
  host: string;
  keyVersion: number;
  /** WEBHOOK only: whether the sealed envelope carries a signing secret. */
  hasSecret: boolean;
  notify: NotifyPrefs;
}

export function notifyPrefsOf(config: unknown): NotifyPrefs {
  const c = (config ?? {}) as { notify?: unknown };
  const n = (c.notify ?? {}) as Record<string, unknown>;
  return {
    runFinished:
      n.runFinished === 'off' || n.runFinished === 'all' || n.runFinished === 'failures'
        ? n.runFinished
        : DEFAULT_NOTIFY_PREFS.runFinished,
    digest: typeof n.digest === 'boolean' ? n.digest : DEFAULT_NOTIFY_PREFS.digest,
  };
}

export function parseChatConfig(config: unknown): ChatIntegrationConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    host: typeof c.host === 'string' ? c.host : '',
    keyVersion: typeof c.keyVersion === 'number' ? c.keyVersion : 1,
    hasSecret: c.hasSecret === true,
    notify: notifyPrefsOf(config),
  };
}

/**
 * Does this integration want to hear that a run finished?
 *
 * The one place the `runFinished` preference is interpreted. notify.ts asks it
 * per integration; the API asks it nowhere (a test send is explicit consent).
 */
export function wantsRunFinished(prefs: NotifyPrefs, runFailed: boolean): boolean {
  if (prefs.runFinished === 'off') return false;
  if (prefs.runFinished === 'all') return true;
  return runFailed;
}

// ─── Destination validation ──────────────────────────────────────────────────

/**
 * The host each provider's incoming webhooks actually live on.
 *
 * Pinned per provider, checked by the API when the URL is stored AND by the
 * worker before it posts (notify.ts, digest.ts). What travels over these hooks
 * is a summary of a customer's test suite — what broke, in which files — so a
 * config row may choose the PATH (that is the webhook token) and never the
 * host. ONE list, on purpose: two lists of what counts as a Slack host is how
 * one of them quietly stops being true.
 *
 * A fully-qualified name may end in a dot and DNS resolves it identically, so
 * it is stripped BEFORE comparing. One character defeating a hostname guard is
 * not hypothetical here — see the trailing-dot note in issues.ts.
 */
export function webhookHostAllowed(kind: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');

  if (kind === 'SLACK') return host === 'hooks.slack.com';
  if (kind === 'DISCORD') return host === 'discord.com' || host === 'discordapp.com';
  if (kind === 'MSTEAMS') {
    return (
      host === 'outlook.office.com' ||
      host === 'outlook.office365.com' ||
      host.endsWith('.webhook.office.com') ||
      // Power Automate, which is what "Workflows" in Teams creates now that the
      // Office connectors are being retired.
      host.endsWith('.logic.azure.com')
    );
  }
  return false;
}

/**
 * What the UI may show of a stored webhook URL: the host, and the last four
 * characters of the path. Same rule as the vault's own secret hint — enough to
 * tell two hooks apart, never enough to reconstruct one. Short paths get no
 * tail at all, so a hint can never carry most of a token. Computed at WRITE
 * time and stored on `Integration.config.urlHint`, because by read time the
 * URL is ciphertext.
 */
export function maskWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const path = url.pathname.replace(/\/+$/, '');
  const tail = path.length > 8 ? path.slice(-4) : '';
  return `${url.hostname}/…${tail}`;
}

/** Carries a message that is already safe to show: it never contains the URL. */
export class ChatWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatWebhookError';
  }
}

const PROVIDER_HINT: Record<ChatIntegrationKind, string> = {
  SLACK: 'a Slack incoming-webhook URL lives on hooks.slack.com',
  MSTEAMS: 'a Teams workflow URL lives on *.webhook.office.com or *.logic.azure.com',
  DISCORD: 'a Discord webhook URL lives on discord.com',
  WEBHOOK: '',
};

/**
 * Validate an incoming-webhook URL for `kind` and return it normalised, plus
 * the bare host for `Integration.config`. Throws ChatWebhookError with a
 * message that names the host at most — the URL is the credential, and the
 * parse-failure path especially is where a mangled URL carrying its token
 * would otherwise be echoed into a response or a log.
 */
export function validateChatWebhookUrl(
  kind: ChatIntegrationKind,
  raw: string,
): { url: string; host: string } {
  const trimmed = raw.trim();
  if (!trimmed) throw new ChatWebhookError('The webhook URL is empty.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ChatWebhookError('That webhook URL could not be parsed.');
  }

  if (url.protocol !== 'https:') {
    throw new ChatWebhookError(
      'A webhook URL must be https — the payload describes your test suite.',
    );
  }
  if (url.username || url.password) {
    throw new ChatWebhookError('Remove the embedded credentials from the webhook URL.');
  }

  // Strip trailing dots BEFORE any host check — the digest.ts lesson.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (kind === 'WEBHOOK') {
    if (isIpLiteralHost(host) || isInternalHostname(host) || !host.includes('.')) {
      throw new ChatWebhookError(
        `Refusing to send webhooks to ${host}: use a public hostname, not an IP or internal name.`,
      );
    }
  } else {
    if (!webhookHostAllowed(kind, host)) {
      throw new ChatWebhookError(
        `${host} is not a ${kind} webhook host — ${PROVIDER_HINT[kind]}. Re-copy the URL from ${kind}.`,
      );
    }
    if (url.port && url.port !== '443') {
      throw new ChatWebhookError(`A ${kind} webhook URL must use the default https port.`);
    }
  }

  /*
   * Rebuild from the NORMALISED host rather than returning `trimmed`, so a
   * trailing dot cannot survive validation and be re-attached to the send. The
   * search string is kept: Teams Power Automate URLs carry their signature in
   * the query (`?api-version=…&sig=…`), and dropping it would store a URL that
   * passes every check here and 401s on every send.
   */
  const port = kind === 'WEBHOOK' && url.port ? `:${url.port}` : '';
  return { url: `https://${host}${port}${url.pathname}${url.search}`, host };
}

/**
 * The send-time re-check. Same rules as write time, shaped for a loop that
 * must skip-and-record rather than throw: notify.ts, digest.ts and the API's
 * test endpoint all call this on the just-unsealed URL immediately before the
 * POST, so validation travels with the send instead of trusting the write path.
 */
export function checkChatDestination(
  kind: string,
  rawUrl: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (!isChatIntegrationKind(kind)) {
    return { ok: false, reason: `${kind} is not a chat destination.` };
  }
  try {
    return { ok: true, url: validateChatWebhookUrl(kind, rawUrl).url };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid webhook URL' };
  }
}

/**
 * One request body for all four kinds: Teams wants `text`, Discord wants
 * `content`, Slack accepts `text`, and a generic WEBHOOK gets `text` plus the
 * event name so a receiver can route without parsing prose.
 */
export function chatPayload(kind: string, event: string, text: string): string {
  if (kind === 'DISCORD') return JSON.stringify({ content: text });
  if (kind === 'WEBHOOK') return JSON.stringify({ event, text });
  return JSON.stringify({ text });
}
