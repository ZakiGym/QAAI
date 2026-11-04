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

import * as dns from 'node:dns';
import type {
  ChatIntegrationKind,
  EgressGuardIo,
  EgressGuardVerdict,
  RunFinishedPref,
} from '@qaai/shared';
import {
  CHAT_INTEGRATION_KINDS,
  guardUrl,
  refusalForCaller,
  resolveEgressPolicy,
} from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
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
    /*
     * A PATTERN MATCH, AND IT DECIDES NOTHING ABOUT WHERE THE HOST POINTS.
     *
     * `isInternalHostname` is `@qaai/shared/private-address`'s
     * `isPrivateNetworkName` — `INTERNAL_HOST.test(host) || !host.includes('.')`
     * — so it refuses the internal names an attacker would have to be careless
     * to use and accepts every name they would actually register. MEASURED on
     * this tree: `validateChatWebhookUrl('WEBHOOK', 'https://hook.attacker.test/p/abc')`
     * returned that URL, and the sealed envelope's URL — which IS the credential
     * — was posted to whatever the name resolved to.
     *
     * This stays, because it runs at WRITE time with no resolver and a bad URL
     * should be refused before it is sealed. The RESOLVING control is
     * {@link guardChatDestination}, at the send.
     */
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

// ─── The egress guard, at the send ──────────────────────────────────────────

/**
 * MAY WE DELIVER TO THIS WEBHOOK URL, AND TO WHICH ADDRESS.
 *
 * The context is `WEBHOOK_DELIVERY` and it is not a label: `EGRESS_CONTEXT_RULES`
 * gives it `targetsApplicationUnderTest: false` and `allowlistApplies: false`,
 * so a private, loopback, reserved or link-local address is refused in EVERY
 * deployment and cannot be allowlisted — an operator who allowlisted an
 * internal host for webhook delivery would have built an SSRF with paperwork.
 *
 * THAT BREAKS NOTHING THAT WORKS TODAY: `validateChatWebhookUrl` already
 * refuses `hook.internal`, `kubernetes.default.svc`, an IP literal and a bare
 * label, and it does so at write time as well as at send time. The only thing
 * that changes is that a name whose RECORDS point inside is refused too.
 */
export type ChatEgressGuard = (url: string) => Promise<EgressGuardVerdict>;

/**
 * WHAT THIS CONTROL DOES NOT DO.
 *
 * `guardUrl` hands back a PINNED ADDRESS SET, and the pin is the half that
 * turns a check into a control. The transports are `notify.ts`, `digest.ts` and
 * the API's test-send endpoint, all of which use Node's GLOBAL `fetch` — and
 * MEASURED on Node v25.6.1, `fetch(url, { agent: new http.Agent({ lookup }) })`
 * answered 200 and NEVER CALLED THE LOOKUP, while `{ dispatcher: … }` threw.
 * There is no supported way to hand global `fetch` a resolver.
 *
 * ── TRUE OF `fetch`, AND THE CONCLUSION DRAWN FROM IT WAS WRONG ──────────────
 *
 * That sentence used to end the matter, and a reader took it to mean the pin
 * cannot be enforced. It can. RE-MEASURED on Node v25.6.1 against a loopback
 * server: `fetch(url, { agent: new http.Agent({ lookup }) })` -> 200 with the
 * lookup called ZERO times (the original measurement reproduces — the agent is
 * IGNORED), but `http.request({ host, port, path, lookup })` -> 200 with the
 * lookup called ONCE. Node core honours it, with NO dependency change.
 *
 * So the remedy is a TRANSPORT and not a dependency: moving this call off global
 * `fetch` onto `node:http`/`node:https` with the permit's `lookup` enforces the
 * pin for free. The work is not done here; what is recorded is that the cheap
 * option exists, because the previous wording closed the question.
 *
 * So every address the name answers with is classified and THE PIN IS NOT
 * ENFORCED AT THE SOCKET. Named rather than papered over, the same way
 * `REFRESH_PIN_LIMITATION` names it on the auth-refresh path.
 */
export const CHAT_PIN_LIMITATION =
  'The webhook host was resolved and every address it answered with was classified, but Node’s ' +
  'global fetch cannot be handed a resolver, so the pinned address set is not enforced at the ' +
  'socket.';

/**
 * THE REAL GUARD.
 *
 * `policy` is `unknown` because that is how `Environment.egressPolicy` reads
 * out of its JSONB column. A chat integration is ORG-level and has no
 * environment, so today every caller passes nothing — and nothing falls through
 * `resolveEgressPolicy` to the HOSTED policy, PUBLIC ONLY, which is the
 * strictest reading. An absent policy must never be an open one.
 */
export async function defaultChatEgressGuard(policy?: unknown): Promise<ChatEgressGuard> {
  const resolved = resolveEgressPolicy(policy);
  const io: EgressGuardIo = {
    classifyHost: (host) => classifyHost(host),
    classifyAddress: (address) => classifyAddress(address),
    /*
     * EVERY address the name has, not the first — a record set mixing one
     * routable address with 169.254.169.254 is the attack written down — and
     * `verbatim: true` so the OS does not reorder and hide one.
     */
    lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true, family: 0 }),
    now: () => new Date(),
    // Monotonic, NOT the wall clock: an NTP step backwards mid-refusal would
    // make the pad negative and therefore zero, and a refusal that skipped its
    // pad is the timing oracle the floor exists to close.
    monotonicMs: () => performance.now(),
    delay: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Unreffed: a draining worker must not be held open by a refusal's pad.
        timer.unref?.();
      }),
  };
  return (url) => guardUrl({ url, context: 'WEBHOOK_DELIVERY', policy: resolved, io });
}

/**
 * {@link checkChatDestination} AND THEN THE RESOLUTION IT CANNOT DO.
 *
 * This is the function the three senders must call instead of
 * `checkChatDestination`: same `{ok, url} | {ok, reason}` shape, so the loop
 * that must skip-and-record rather than throw is unchanged and the call site is
 * a one-line `await`. `notify.ts`, `digest.ts` and the API's test-send endpoint
 * are the three; the exact edits are in the handover, because this slice does
 * not own them.
 *
 * ── Why only the generic WEBHOOK kind reaches the resolver ─────────────────
 *
 * Because only its host comes from the customer. MEASURED on this tree: SLACK,
 * DISCORD and MSTEAMS all refuse `hook.attacker.test`,
 * `hooks.slack.com.attacker.test` and `evil.example.net` through
 * `webhookHostAllowed`, which is a real host allowlist and not a pattern. A
 * resolver on those paths would add a DNS round trip and a new failure mode to
 * destinations no config row can choose, and would put a live lookup inside
 * every notify test. THE INVARIANT THAT MAKES THAT SAFE is that
 * `webhookHostAllowed` names hosts and never accepts one from config — if that
 * ever changes, this branch has to change with it, and
 * `chat-integrations.test.ts` asserts that the named kinds consult no resolver
 * so the pairing is visible rather than remembered.
 *
 * ── The refusal reason is ONE SENTENCE ─────────────────────────────────────
 *
 * {@link refusalForCaller} returns `EGRESS_REFUSAL_SENTENCE` for every one of
 * the seventeen refusals. `reason` is recorded against the integration and
 * shown in the cockpit to whoever typed the URL, so a message that
 * distinguished "that is a link-local address" from "that host did not resolve"
 * would turn a webhook integration into a port scanner with a readable report.
 * `verdict.operatorDetail` holds the class, the address and the refusal code,
 * and is deliberately NOT returned.
 */
/**
 * THE GUARD EVERY SENDER GETS, injected so a test can hand it an answer.
 *
 * ── WHY THIS SEAM EXISTS HERE AND NOT IN EACH SENDER ─────────────────────────
 *
 * There are three senders — `apps/api/src/routes/integrations.ts` (the
 * test-send endpoint), `apps/worker/src/processors/notify.ts` and
 * `apps/worker/src/processors/digest.ts` — and for a while
 * {@link guardChatDestination} had NO PRODUCTION CALLER at all: all three used
 * the synchronous {@link checkChatDestination}, which is a pattern match that
 * never resolves. MEASURED: `checkChatDestination('WEBHOOK',
 * 'https://hooks.attacker.test/services/...')` returned ok with ZERO DNS
 * queries, while `guardChatDestination` on the identical input refused with
 * one. The webhook URL IS the credential — a Slack or Discord token lives in
 * its path — so the request carries a secret to whatever the name answers.
 *
 * One factory shared by the three, rather than a seam in each: three seams are
 * three things to stub and three chances for one of them to be forgotten, which
 * is the shape of the defect this replaces.
 *
 * `configureChatEgress(null)` restores the real guard, which is what an
 * `afterEach` wants so one test cannot leak its resolver into the next.
 */
export type ChatEgressGuardFactory = () => Promise<ChatEgressGuard>;

let chatGuard: ChatEgressGuardFactory = () => defaultChatEgressGuard();

export function configureChatEgress(next: ChatEgressGuardFactory | null): void {
  chatGuard = next ?? (() => defaultChatEgressGuard());
}

/**
 * Resolve, classify and refuse — the call every sender makes instead of
 * {@link checkChatDestination}. Thin on purpose: it is the one line that is easy
 * to get right and was missing in three places.
 */
export async function chatDestinationFor(
  kind: string,
  rawUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  return guardChatDestination(kind, rawUrl, await chatGuard());
}

export async function guardChatDestination(
  kind: string,
  rawUrl: string,
  guard: ChatEgressGuard,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  // The synchronous rules FIRST, unchanged — and they are what refuses an
  // unparseable URL, a non-https scheme, embedded credentials and a wrong
  // provider host, none of which should cost a lookup.
  const checked = checkChatDestination(kind, rawUrl);
  if (!checked.ok) return checked;
  if (kind !== 'WEBHOOK') return checked;

  const verdict = await guard(checked.url);
  if (!verdict.ok) return { ok: false, reason: refusalForCaller(verdict).sentence };
  return checked;
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
