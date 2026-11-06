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
 *  - THE SEND ITSELF LIVES HERE TOO, for the same reason the validation does.
 *    `chatDestinationFor` returns the egress PERMIT and {@link sendChatPayload}
 *    is the only function that opens the socket, so "which transport carries a
 *    credential-bearing POST" has one answer instead of one per sender. It had
 *    two, and both of them threw the permit away — see
 *    {@link CHAT_PIN_LIMITATION}.
 */

import * as dns from 'node:dns';
import type {
  ChatIntegrationKind,
  EgressGuardIo,
  EgressGuardVerdict,
  EgressPermit,
  RunFinishedPref,
} from '@qaai/shared';
import {
  CHAT_INTEGRATION_KINDS,
  EGRESS_REFUSAL_SENTENCE,
  describeWebhookFailure,
  guardUrl,
  refusalForCaller,
  resolveEgressPolicy,
} from '@qaai/shared';
import { classifyAddress, classifyHost } from '@qaai/shared/private-address';
/*
 * THE PINNED TRANSPORT, IMPORTED BY RELATIVE PATH AND NOT THROUGH THE BARREL.
 *
 * `packages/shared/src/pinned-request.ts` imports `node:http` and `node:https`,
 * and `packages/shared/src/index.ts` is imported by `apps/web`, so it is not in
 * the barrel and must not be added to it — the same rule that keeps
 * `private-address.ts` (which reaches for `node:dns`) out of it.
 *
 * MEASURED, because the obvious spelling does not work: `@qaai/shared/private-address`
 * resolves because `packages/shared/package.json` lists it in `exports`, and
 * `pinned-request` IS NOT LISTED there — `npx tsx` on
 * `import '@qaai/shared/pinned-request'` fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * So the reachable spelling today is this relative one, which is already how
 * `notify.ts` imports THIS module across the workspace boundary. The one-line
 * `exports` entry that would make the tidy spelling work is in the handover;
 * `packages/shared/package.json` is not this slice's file to edit.
 */
import { pinnedRequest } from '../../../../packages/shared/src/pinned-request.js';
import type {
  PinnedRequestRefusal,
  PinnedRequestResult,
  PinnedRequestInit,
} from '../../../../packages/shared/src/pinned-request.js';
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
 * WHAT THIS CONTROL DOES, AND THE THREE PLACES IT STILL DOES NOT.
 *
 * ── WHAT CHANGED, AND THE CLAIM THAT HELD IT UP FOR FOUR ROUNDS ─────────────
 *
 * This paragraph used to say the pin COULD NOT be enforced here, and that is
 * why it is rewritten rather than edited: the sentence a reviewer trusts
 * instead of reading the code was the thing that kept the hole open. It said
 * `fetch(url, { agent: new http.Agent({ lookup }) })` answered 200 and never
 * called the lookup, therefore nothing could pin. That measurement reproduces
 * (the `agent` option is silently IGNORED, 0 lookup calls — the worst kind of
 * failure, because it looks like it worked). The CONCLUSION was wrong:
 * `http.request({ host, port, path, lookup })` answers 200 with the lookup
 * called ONCE, in Node core, with no dependency change. So the remedy was a
 * TRANSPORT, and {@link sendChatPayload} is it.
 *
 * TODAY, for the generic WEBHOOK kind — the only kind whose host a tenant
 * chooses — the permit's address set IS enforced at the socket: the connection
 * goes to a classified address and the NAME stays in the request, so Host, SNI
 * and the certificate check all keep working. A name rebound between the
 * guard's lookup and the socket's cannot move the POST, so the webhook token in
 * the path cannot travel to an address nothing classified. MEASURED against a
 * loopback server standing in for an internal host, with the name resolving to
 * it and the permit pinning elsewhere: the internal server recorded ZERO hits
 * and the send refused. The same request with this transport reverted to
 * `fetch(url)` by name recorded `POST /services/…` with the token in the path.
 *
 * ── WHAT IS STILL NOT PINNED, AND WHY EACH ONE IS NOT A HOLE ────────────────
 *
 *  1. SLACK, MSTEAMS and DISCORD get NO PERMIT AT ALL, because
 *     {@link guardChatDestination} returns before the guard for them: their
 *     hosts come from {@link webhookHostAllowed}, a real host allowlist no
 *     config row can choose from. There is no pin to enforce, so those three
 *     still connect BY NAME, and the outcome says so
 *     (`transport: 'BY_NAME_ALLOWLISTED_HOST'`). A rebind there would need
 *     control of Slack's or Microsoft's own zone.
 *  2. An OBSERVED permit authorised no address, so observe mode connects BY
 *     NAME exactly as it did before this control existed — which is what
 *     OBSERVE promises — and every such send is reported as
 *     `transport: 'BY_NAME_OBSERVE_MODE'` for the caller to count. A mode with
 *     no counter is an off switch with a reassuring name.
 *  3. The DIGEST processor is not a caller of this door at all: it refuses the
 *     generic WEBHOOK kind outright and pins the other three to provider hosts,
 *     so a guard there could never refuse anything. That reasoning is written
 *     into digest.ts; read it rather than re-deriving it.
 *
 * Named rather than papered over, the same way `REFRESH_PIN_LIMITATION` names
 * what is left on the auth-refresh path.
 */
export const CHAT_PIN_LIMITATION =
  'A generic WEBHOOK destination is resolved, every address it answered with is classified, and ' +
  'the connection is made to the pinned address with the name left in the request, so the pinned ' +
  'address set is enforced at the socket. The three allowlisted provider kinds hold no permit and ' +
  'still connect by name, and an OBSERVE-mode permit authorises no address, so that send connects ' +
  'by name and is counted as such.';

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
 * WHAT A SENDER IS HANDED, AND WHY THE PERMIT IS PART OF IT.
 *
 * The `ok` arm used to be `{ ok: true, url }`, and that missing third field was
 * THE DEFECT this shape exists to close. `guardUrl` hands back a PINNED ADDRESS
 * SET — the half that turns a check into a control — and both senders read
 * `verdict.ok`, dropped the permit on the floor and called global `fetch(url)`
 * by name, which resolves independently. MEASURED on this tree:
 * `guardChatDestination('WEBHOOK', 'https://hook.acme.test/p/abcdefgh', guard)`
 * returned an object whose keys were exactly `['ok', 'url']` while the verdict
 * behind it carried `permit.kind: 'PINNED'` with the classified address right
 * there.
 *
 * `permit: null` IS A FACT AND NOT AN ABSENCE OF ONE: the three allowlisted
 * provider kinds never reach the guard (their hosts are constants), so there is
 * no permit to carry and {@link sendChatPayload} must not pretend otherwise.
 * Null means "no guard decided about this host"; it never means "pin waived".
 */
export type ChatDestination =
  | { readonly ok: true; readonly url: string; readonly permit: EgressPermit | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve, classify and refuse — the call every sender makes instead of
 * {@link checkChatDestination}. Thin on purpose: it is the one line that is easy
 * to get right and was missing in three places.
 */
export async function chatDestinationFor(kind: string, rawUrl: string): Promise<ChatDestination> {
  return guardChatDestination(kind, rawUrl, await chatGuard());
}

export async function guardChatDestination(
  kind: string,
  rawUrl: string,
  guard: ChatEgressGuard,
): Promise<ChatDestination> {
  // The synchronous rules FIRST, unchanged — and they are what refuses an
  // unparseable URL, a non-https scheme, embedded credentials and a wrong
  // provider host, none of which should cost a lookup.
  const checked = checkChatDestination(kind, rawUrl);
  if (!checked.ok) return checked;
  // NO PERMIT, SAID OUT LOUD. See ChatDestination above: these three kinds are
  // pinned to provider hosts by an allowlist, not by an address set.
  if (kind !== 'WEBHOOK') return { ...checked, permit: null };

  const verdict = await guard(checked.url);
  if (!verdict.ok) return { ok: false, reason: refusalForCaller(verdict).sentence };
  return { ...checked, permit: verdict.permit };
}

// ─── The send ────────────────────────────────────────────────────────────────

/**
 * WHICH TRANSPORT CARRIED A CREDENTIAL-BEARING POST. A closed vocabulary,
 * because the caller COUNTS it and a count whose buckets are assembled as
 * strings is one that drifts.
 *
 * PINNED is the control working: the socket went to an address the guard
 * classified, and re-resolution was impossible.
 *
 * The two BY_NAME values are the honest names for the two cases where no pin
 * exists to honour, and they are deliberately NOT one value — "there was never
 * a permit" and "a permit was issued and it authorised nothing" are different
 * facts about the install, and the second one is the rollout brake being used.
 * {@link CHAT_PIN_LIMITATION} explains why neither is a hole.
 */
export const CHAT_TRANSPORTS = [
  'PINNED',
  'BY_NAME_ALLOWLISTED_HOST',
  'BY_NAME_OBSERVE_MODE',
] as const;
export type ChatTransport = (typeof CHAT_TRANSPORTS)[number];

/**
 * The cap on the response body the pinned transport reads.
 *
 * `pinnedRequest` requires it rather than defaulting it, which is right, and
 * for these two senders the honest number is SMALL: neither reads the body at
 * all — the test endpoint reports `responseStatus` and the delivery row stores
 * it, and nothing anywhere renders a provider's reply. The cap exists so a
 * hostile receiver cannot stream forever into a worker, not so a body can be
 * used, which is also why {@link ChatSendOutcome} does not carry `truncated`:
 * there is no body being reported, so there is nothing for a truncation flag to
 * be true of. If a sender ever starts reading the reply, that flag has to come
 * with it.
 */
export const CHAT_RESPONSE_MAX_BYTES = 8_192;

export interface ChatSendInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface ChatSendOutcome {
  /** The provider's status, or null when no response was received at all. */
  readonly status: number | null;
  /** Null exactly when the send landed and the provider was happy. */
  readonly error: string | null;
  /** Recorded, never inferred. See {@link CHAT_TRANSPORTS}. */
  readonly transport: ChatTransport;
  /**
   * The pinned transport's own refusal code, for an OPERATOR LOG and nothing
   * else. A closed vocabulary, which is what makes it safe to write down where
   * `operatorDetail` is not; null on every by-name send and on every send that
   * got a response. See {@link chatRefusalForCaller} for what the caller is
   * told instead.
   */
  readonly refusal: PinnedRequestRefusal | null;
}

/**
 * THE TRANSPORT SEAM, for the same reason {@link configureChatEgress} exists.
 *
 * A send that is only ever tested against a fake transport is a pin nobody has
 * evidence for — that is precisely how this defect survived four rounds — so
 * the pin itself is proven in `chat-integrations.test.ts` against REAL loopback
 * sockets through the REAL default, with no stub installed. This seam is for
 * the route and processor tests either side of it, which are about the signed
 * body and the delivery row rather than about the socket, and which cannot use
 * a real one: a stored WEBHOOK URL is always https on a public name (see
 * {@link validateChatWebhookUrl}), and a loopback https server would need a
 * certificate this repository has no way to mint.
 *
 * `configureChatTransport(null)` restores the real transport, which is what an
 * `afterEach` wants so one test cannot leak its fake into the next.
 */
export type ChatTransportFn = (
  permit: EgressPermit,
  url: string,
  init: PinnedRequestInit,
) => Promise<PinnedRequestResult>;

let chatTransport: ChatTransportFn = pinnedRequest;

export function configureChatTransport(next: ChatTransportFn | null): void {
  chatTransport = next ?? pinnedRequest;
}

/**
 * A STATUS THAT IS NOT A SUCCESS, named the way both senders already named it.
 * A 3xx is reported and never followed: following one would re-post the body,
 * the signature header and — for a webhook — the token in the path to whatever
 * `Location` named, which is a host nothing classified.
 */
function chatStatusError(status: number): string | null {
  if (status >= 300 && status < 400) return 'redirected; not followed';
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  return null;
}

/**
 * A PINNED REFUSAL, IN THE WORDS THIS FILE ALREADY USES.
 *
 * `reason` is recorded on the delivery row and shown in the cockpit to whoever
 * typed the URL, so this maps the transport's six refusals onto sentences that
 * already existed here and adds NO new one. The four control refusals collapse
 * onto `EGRESS_REFUSAL_SENTENCE`, the same single sentence every one of the
 * guard's seventeen refusals produces, because a message distinguishing "the
 * permit pinned another host" from "that address refused the connection" is a
 * port scanner with a readable report.
 *
 * ── WHAT THIS DELIBERATELY STOPPED SAYING ───────────────────────────────────
 *
 * On the old `fetch` path a transport failure went through
 * `describeWebhookFailure`, which names a CLASS: refused, DNS, TLS, reset. The
 * pinned transport reports a closed refusal vocabulary instead of a syscall
 * code, so TRANSPORT_FAILED collapses onto that function's own fallback
 * sentence and the generic WEBHOOK kind loses that breakdown. That is a real
 * loss of debuggability and it is stated rather than hidden; inventing a finer
 * message from `operatorDetail` would both re-open the oracle and render a
 * string this file has no way to bound. TIMED_OUT keeps its sentence, because
 * `describeWebhookFailure` says exactly that one for a timeout today.
 */
function chatRefusalForCaller(refusal: PinnedRequestRefusal, timeoutMs: number): string {
  if (refusal === 'TIMED_OUT') return `no answer within ${timeoutMs / 1_000}s`;
  if (refusal === 'TRANSPORT_FAILED') return 'delivery failed';
  return EGRESS_REFUSAL_SENTENCE;
}

/**
 * POST THE PAYLOAD, TO THE ADDRESS THE PERMIT AUTHORISED.
 *
 * The ONE place a chat or webhook POST leaves this product. It was two, and
 * both of them resolved the name a second time; see {@link CHAT_PIN_LIMITATION}
 * for the measurement and for what is still not pinned.
 *
 * FAILS CLOSED, and the shape says so: every arm either returns a status from a
 * response that really arrived or an `error`, and there is no path from a
 * refusal to a send. In particular an OBSERVED permit is NOT handed to
 * `pinnedRequest` to be refused and then retried by name — that would make the
 * fall-back an exception handler, which is the shape this rule exists to
 * outlaw. It is a branch taken on purpose, named in the outcome, and the caller
 * counts it.
 *
 * `operatorDetail` from the transport is NOT logged, recorded or returned here.
 * It may name a host and the transport's own words, and the transport's own
 * words are an unbounded Node error message on a path whose URL IS the
 * credential — the same reason this file already refuses to record `err.message`
 * from a `fetch` failure. The REFUSAL CODE is the debuggable fact, and it is a
 * closed vocabulary, so the callers log that.
 */
export async function sendChatPayload(
  destination: { readonly url: string; readonly permit: EgressPermit | null },
  init: ChatSendInit,
): Promise<ChatSendOutcome> {
  const permit = destination.permit;

  if (permit !== null && permit.kind === 'PINNED') {
    /*
     * THE THROW IS A REFUSAL, NEVER A FALL-BACK.
     *
     * `pinnedRequest` answers with a result rather than throwing for every
     * failure it anticipates, but it CAN reject: `http.request` validates its
     * options synchronously inside the promise, so a path or header value Node
     * rejects arrives here as an exception. Neither is reachable from these two
     * senders today — the URL was rebuilt from a parsed `URL`, so it is already
     * percent-encoded, and the headers are a fixed shape — but a worker that
     * threw out of here would lose the delivery row that is its only record of
     * the attempt, which is the behaviour the old `catch` around `fetch` had.
     *
     * What this handler must never do is retry by name. It reports the same
     * refusal a transport failure reports and the send does not happen: an
     * exception handler that falls through to "send it anyway" is exactly the
     * shape that would re-open this defect from the other side.
     */
    let result: PinnedRequestResult;
    try {
      result = await chatTransport(permit, destination.url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        timeoutMs: init.timeoutMs,
        maxBytes: CHAT_RESPONSE_MAX_BYTES,
      });
    } catch {
      // Deliberately not the thrown message: this file does not render a
      // runtime error on a path whose URL is the credential.
      result = {
        ok: false,
        refusal: 'TRANSPORT_FAILED',
        operatorDetail: 'the pinned transport threw instead of answering',
      };
    }
    if (!result.ok) {
      return {
        status: null,
        error: chatRefusalForCaller(result.refusal, init.timeoutMs),
        transport: 'PINNED',
        refusal: result.refusal,
      };
    }
    return {
      status: result.response.status,
      error: chatStatusError(result.response.status),
      transport: 'PINNED',
      refusal: null,
    };
  }

  /*
   * BY NAME, and which of the two reasons it was. An OBSERVED permit means the
   * policy WOULD have refused this destination and the mode is OBSERVE, so the
   * connection happens exactly as it did before the control existed. Borrowing
   * a pin it was not given would be worse than the hole OBSERVE leaves open on
   * purpose.
   */
  const transport: ChatTransport =
    permit === null ? 'BY_NAME_ALLOWLISTED_HOST' : 'BY_NAME_OBSERVE_MODE';

  try {
    const response = await fetch(destination.url, {
      method: 'POST',
      headers: { ...init.headers },
      body: init.body,
      // A 3xx is an error, not a hop. Following one would re-post the body —
      // and the webhook token in the URL — to whatever Location named.
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    return {
      status: response.status,
      error: chatStatusError(response.status),
      transport,
      refusal: null,
    };
  } catch (err) {
    // Deliberately not err.message: a fetch failure embeds the URL, and the URL
    // is the credential. The shared classifier names the failure CLASS from the
    // wrapped syscall code instead.
    return {
      status: null,
      error: describeWebhookFailure(err, init.timeoutMs / 1_000),
      transport,
      refusal: null,
    };
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
