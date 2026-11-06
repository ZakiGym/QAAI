/**
 * Publish verification results back to a Pact broker.
 *
 * Verification is only half of the contract loop. Until the provider's result is
 * published, the broker cannot answer the question the whole thing exists for —
 * "can I deploy this consumer?" — so a green QAAI run teaches the broker nothing
 * and `can-i-deploy` keeps guessing.
 *
 * SECURITY — this module is arranged around one fact, the same one
 * `apps/api/src/lib/issues.ts` is arranged around and the reason that file is
 * the reference implementation for anything outbound here: the request carries a
 * customer's broker token in an Authorization header, and the destination comes
 * out of a config value someone can edit. This repo has shipped that bug twice —
 * once as a PAT posted to an attacker-chosen host, once as a trailing-dot
 * hostname that walked straight past every guard. The rules, enforced below —
 * the URL ones before the token is ever read out of the vault, the address ones
 * immediately before the one line that connects, which is where they have to be
 * and where `publishVerification` explains itself at length:
 *
 *   - The origin is captured from the CONFIGURED broker URL, validated once, and
 *     is the only host any request goes to. The pact document is not consulted:
 *     a broker-hosted pact carries `_links.pb:publish-verification-results`, and
 *     following that href would let the fetched document choose where the token
 *     goes. The path is built here from encoded segments instead.
 *   - https only. The token travels in the request; there is no configuration in
 *     which sending it in clear is the right answer, and a broker that can only
 *     be reached over http is a broker QAAI SKIPS.
 *   - No credentials in the URL, no IP literal, no internal/metadata hostname,
 *     and the trailing dot is stripped BEFORE any of those checks.
 *   - A 3xx IS REFUSED, NEVER FOLLOWED — following one re-sends the
 *     Authorization header to whatever `Location` names. The pinned transport
 *     cannot follow one at all (it is not a configurable option there, which is
 *     stronger than the `redirect: 'manual'` this path used to rely on), and the
 *     observe arm still passes that flag for the same reason.
 *   - THE ADDRESS IS PINNED AND THE SOCKET GOES TO IT. The guard resolves and
 *     classifies every address the broker's name answers with, and the publish
 *     is then made to those addresses with the permit's own resolver, so the
 *     name cannot be re-resolved to somewhere else between the check and the
 *     connection. That rebind was a working, 100%-reliable credential leak until
 *     this round; `BROKER_PIN_LIMITATION` below has the measurement and names
 *     what is still not covered.
 *   - No token, no response body, and no header is ever logged or returned. The
 *     only broker text a user sees is a status-derived sentence written here.
 *
 * And one product rule that outranks all of it: PUBLISHING IS NEVER THE REASON A
 * CONTRACT TEST FAILS. A missing broker, a missing token, a refused destination
 * or an unreachable one all come back as SKIPPED with the thing to fix. The
 * provider's conformance was already decided before this module ran.
 */

import * as dns from 'node:dns';
import type {
  EgressGuardIo,
  EgressGuardVerdict,
  EgressPermit,
  NetworkEntry,
  RunContext,
} from '@qaai/shared';
import { guardUrl, maskUrl, refusalForCaller, resolveEgressPolicy } from '@qaai/shared';
import type { BrokerPublishConfig, PinnedSent } from './contract-events.js';
import { BODY_SNIPPET_LIMIT, send, sendPinned } from './contract-events.js';

/** A broker that has not answered in this long is not going to. */
const PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Names that resolve inside a private network and must never receive a token.
 *
 * Copied deliberately from `apps/api/src/lib/issues.ts` rather than imported:
 * the runner does not depend on the API package, and a security guard that
 * silently disappears when a dependency is dropped is worse than a duplicated
 * one. `.svc` and `.cluster.local` are in the list because QAAI workers commonly
 * run in Kubernetes, where `kubernetes.default.svc` is reachable from every pod.
 */
/*
 * The list lives in @qaai/shared/private-address. There were FIVE copies of
 * this regex across the repo — here, the SSO discovery guard, the issue linker,
 * the action dispatcher and the plugin sandbox — and the `.svc` entry in the
 * comment above is the record of one of them learning a lesson the others had
 * not. An attacker only needs the copy that has not learned it yet.
 */
import { classifyAddress, classifyHost, isPrivateNetworkName } from '@qaai/shared/private-address';

/**
 * Cloud metadata endpoints that answer on a PUBLIC-looking name. The IP forms
 * (169.254.169.254, fd00:ec2::254) are already refused as IP literals; these are
 * not, and they hand out instance credentials to anything that asks.
 */
const METADATA_HOST = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'metadata.azure.com',
]);

/**
 * WHETHER THE PIN WAS ENFORCED FOR THE CONNECTION THIS OUTCOME DESCRIBES.
 *
 * Rule: a control that is skipped must be COUNTED, never defaulted silently. An
 * OBSERVE-mode permit authorises no address, so this path connects by name with
 * the token exactly as it did before the guard existed — which is what the brake
 * promises — and that fact leaves the function on the outcome rather than only
 * in a comment.
 *
 * NOT rendered to the tenant anywhere. `detail` is the sentence they read; this
 * is a fact about our own control, and saying "the policy would have refused
 * your broker" to whoever typed the URL would turn the step list into the
 * classification oracle `refusalForCaller` exists to prevent.
 */
export type PublishPin = 'ENFORCED' | 'OBSERVE_BY_NAME';

/**
 * Why the publish did not happen, or where it landed.
 *
 * `pin` is OPTIONAL and absent means "no connection was attempted" — a URL this
 * module refuses, a secret that is not set, a guard that said no. Optional
 * rather than required because `plugins/contract.ts` builds two `PublishOutcome`
 * literals of its own for cases where nothing was published at all, and that
 * file is not this slice's to edit; absent is the honest reading for both of
 * them. Every arm below that reaches a transport sets it.
 */
export type PublishOutcome =
  | {
      status: 'PUBLISHED';
      detail: string;
      durationMs: number;
      network: NetworkEntry;
      pin?: PublishPin;
    }
  | {
      status: 'SKIPPED';
      detail: string;
      durationMs: number;
      network: NetworkEntry | null;
      pin?: PublishPin;
    };

function skipped(
  detail: string,
  durationMs = 0,
  network: NetworkEntry | null = null,
  pin?: PublishPin,
): PublishOutcome {
  return { status: 'SKIPPED', detail, durationMs, network, ...(pin === undefined ? {} : { pin }) };
}

/**
 * Validate the configured broker URL and return the origin every request is
 * built on. Returns a sentence instead of an origin when the destination is one
 * QAAI refuses — the caller turns that into a SKIPPED step.
 *
 * Exported because it is the security boundary of this module and is tested
 * directly: a guard nobody can call is a guard nobody can prove.
 */
export function brokerOrigin(
  rawUrl: string,
): { origin: string; host: string } | { refused: string } {
  const raw = rawUrl.trim();
  if (raw.length === 0) return { refused: 'no broker URL is configured' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Deliberately does NOT echo `raw`: an unparseable value is exactly where a
    // pasted `https://user:token@broker .example.com` ends up.
    return { refused: 'the broker URL could not be parsed' };
  }

  if (url.protocol !== 'https:') {
    return {
      refused: 'a broker URL must be https — the broker token travels in the request',
    };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      refused:
        'remove the credentials from the broker URL — put the token in the vault and name it under `publish.auth.secretName`',
    };
  }

  /*
   * Strip the trailing dot BEFORE any check.
   *
   * A fully-qualified name may end in a dot and Node's URL parser keeps it:
   * `new URL('https://localhost./x').hostname === 'localhost.'`. DNS resolves it
   * to exactly the same address, so one character defeated every guard below at
   * once — `INTERNAL_HOST` is anchored, so `localhost.` and `metadata.google.
   * internal.` failed to match, while the dot itself satisfied the "must contain
   * a dot" single-label check. That is the credentialed SSRF this repo already
   * shipped once.
   */
  const host = url.hostname.replace(/\.+$/, '').toLowerCase();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral || isPrivateNetworkName(host) || METADATA_HOST.has(host) || !host.includes('.')) {
    return {
      refused: `refusing to send a broker token to ${host || '(no host)'} — use the public hostname of your broker`,
    };
  }

  /*
   * A context path is legitimate (a broker behind /pact). Traversal in it is not:
   * the configured URL may choose a path PREFIX, never a different resource.
   *
   * The check is on the DECODED path. `new URL()` already resolves literal dot
   * segments away, so the form that survives to here is the percent-encoded one
   * — which is exactly the form that resolved back into `..` on the far side in
   * the GitHub-slug bug this repo already fixed.
   */
  const path = url.pathname.replace(/\/+$/, '');
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { refused: 'the broker URL path is not valid percent-encoding' };
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { refused: 'the broker URL must not contain . or .. path segments' };
  }

  /*
   * A port is allowed here where issues.ts refuses one for Jira, and the
   * difference is deliberate: Jira Cloud has exactly one port, while a pact
   * broker is self-hosted by definition and :9292 is its default. It does not
   * widen the blast radius — the host is still validated and the redirect ban
   * still stops the token travelling past it.
   */
  return { origin: `https://${host}${url.port ? `:${url.port}` : ''}${path}`, host };
}

// ─── The egress guard, at the one seam the broker token leaves through ──────

/**
 * MAY WE OPEN THIS BROKER REQUEST, AND TO WHICH ADDRESS.
 *
 * ── What `brokerOrigin` above decides, which is less than it looks ─────────
 *
 * NOTHING ABOUT WHERE THE HOST POINTS. Its host check is
 * `isPrivateNetworkName`, which is a PATTERN MATCH —
 * `INTERNAL_HOST.test(host) || !host.includes('.')` — plus the
 * {@link METADATA_HOST} set and an IPv4-literal regex. That refuses every
 * internal host an attacker would have to be careless to name and accepts
 * every name they would actually register. MEASURED on this tree:
 * `brokerOrigin('https://broker.attacker.test/')` returned
 * `{origin:'https://broker.attacker.test', host:'broker.attacker.test'}`, and
 * the broker token follows it to whatever that name resolves to. Its own
 * comment already says so — "there is no allow-list to check against" — and
 * `brokerHostFromSecretName` was the answer to the LOOKALIKE half of that.
 * This is the answer to the RESOLUTION half, which nothing addressed.
 *
 * `brokerOrigin` is therefore kept exactly as it is: it runs before the token
 * is read out of `ctx.secrets`, which is a property worth keeping.
 *
 * ── The context, which is not a label ──────────────────────────────────────
 *
 * `TRACKER_CALL` — "calling an issue tracker at a customer-named base URL" is
 * this request to the character. `EGRESS_CONTEXT_RULES` gives it
 * `targetsApplicationUnderTest: false` and `allowlistApplies: false`, so a
 * private, loopback, reserved or link-local address is refused in EVERY
 * deployment and cannot be allowlisted.
 *
 * THAT BREAKS NOTHING THAT WORKS TODAY, and the reason is worth stating
 * because a Pact broker IS legitimately self-hosted: `brokerOrigin` ALREADY
 * refuses `broker.internal`, `kubernetes.default.svc`, `10.0.0.5` and a bare
 * label, and `contract-broker.test.ts` asserts it. So the class rule and the
 * shipped behaviour agree, and the only thing that changes is that a name
 * whose RECORDS point inside is now refused too.
 */
export type BrokerEgressGuard = (url: string) => Promise<EgressGuardVerdict>;

/**
 * WHAT THIS CONTROL NOW DOES, AND WHAT IT STILL DOES NOT. STATED HERE BECAUSE A
 * COMMENT IS WHAT THE NEXT REVIEWER TRUSTS INSTEAD OF READING THE CODE — and
 * because the paragraph this one replaces said the fix was impossible, which is
 * the worst thing a comment in a security file can do.
 *
 * `guardUrl` hands back a PINNED ADDRESS SET, and the pin is the half that turns
 * a check into a control: whoever opens the connection must connect to those
 * addresses and must not resolve the name again. Until this round the transport
 * was `send()` in `contract-events.ts`, which calls global `fetch(url)` BY NAME
 * — so the name was resolved a SECOND time, by the transport, and the permit
 * was discarded. RE-MEASURED ON THIS PATH with the real
 * {@link defaultBrokerEgressGuard} and the real `send`, against a loopback
 * server, with `dns.promises.lookup` (the guard's) and `dns.lookup` (the
 * transport's) patched to answer a public-classified address once and
 * `127.0.0.1` after that:
 *
 *     guard verdict: ok, pinned [{"address":"3fff::1","class":"public"}]
 *     dns queries  : #1 broker.attacker.test -> 3fff::1   (the guard's)
 *                    #2 broker.attacker.test -> 127.0.0.1 (the transport's)
 *     internal saw : POST .../verification-results
 *                    host: broker.attacker.test:55741 | credentialed: TRUE
 *
 * Two queries, no cache between them, no timing precision needed, 100%
 * reliable, and the broker token attached. Not a race: a rebind.
 *
 * ── ONE REFINEMENT THE SAME MEASUREMENT PRODUCED, BECAUSE IT IS THIS PATH ───
 *
 * `brokerOrigin` allows ONLY https, and over https the same rebind delivered a
 * TCP connection to the loopback server and NO HTTP REQUEST AND NO CREDENTIAL
 * ("fetch failed" — the internal host cannot present a certificate for the
 * attacker's name). So on THIS path the shipped bug was: an attacker-chosen
 * internal address, connected to from a QAAI worker, with the token delivered
 * only where the rebind target can also present a certificate for the
 * attacker's own name. The reachability oracle was unconditional; the
 * credential delivery was not. Recorded because the brief described the plain
 * HTTP version, and the difference is a fact about this module rather than a
 * reason to care less.
 *
 * ── THE CLAIM THAT KEPT IT OPEN WAS HALF TRUE ───────────────────────────────
 *
 * The old paragraph said: "MEASURED, `fetch(url, { agent: new http.Agent({
 * lookup }) })` answered 200 and NEVER CALLED THE LOOKUP — there is no
 * supported way to hand global `fetch` a resolver." The measurement about
 * `fetch` REPRODUCES exactly; the conclusion drawn from it did not follow.
 * `http.request({ host, port, path, lookup })` answers 200 with the lookup
 * called ONCE, Node core, no dependency change.
 *
 * ── SO THE PIN IS ENFORCED AT THE SOCKET NOW ────────────────────────────────
 *
 * The publish goes through `sendPinned` in `contract-events.ts`, which hands the
 * permit's {@link pinnedLookup} to an `http.Agent`/`https.Agent`. The socket
 * goes to a CLASSIFIED ADDRESS and the NAME stays in the request, so the Host
 * header, SNI and the certificate check all keep working; the URL is not
 * rewritten to an address literal. The name is never resolved a second time, so
 * the rebind above cannot happen.
 *
 * ── WHAT IS STILL NOT ENFORCED, NAMED RATHER THAN PAPERED OVER ──────────────
 *
 *   · AN OBSERVED PERMIT IS NOT PINNED, BY DESIGN, and this path then connects
 *     BY NAME with the token exactly as it did before any of this existed — the
 *     rebinding window open. That is what OBSERVE means and it is the brake an
 *     operator deliberately armed; `login.ts` makes the identical choice for the
 *     identical reason and even types the credential. ENFORCE is the default, so
 *     nothing reaches that arm unless somebody set the mode. It is COUNTED, not
 *     silent: every outcome that attempted a connection carries
 *     {@link PublishOutcome.pin}.
 *   · RUN CANCELLATION NO LONGER TEARS THE SOCKET DOWN. `send` built an
 *     `AbortSignal` from `ctx.signal`; `PinnedRequestInit` takes a `timeoutMs`
 *     and no signal. A cancelled run therefore waits out
 *     {@link PUBLISH_TIMEOUT_MS} instead of aborting, and `sendPinned` refuses
 *     to START a request on an already-cancelled run. An optional `signal` on
 *     `PinnedRequestInit` is the one-line fix and is in the handover.
 *   · `brokerOrigin` IS UNCHANGED and still decides nothing about where a name
 *     points. It refuses the hosts QAAI can name as bad before the token is read
 *     out of the vault; the guard is what classifies the addresses; this is what
 *     connects to them and to nothing else.
 */
export const BROKER_PIN_LIMITATION =
  'The broker host is resolved, every address it answers with is classified, and the publish is ' +
  'made to those addresses with the permit’s own lookup, so the name is never resolved twice. ' +
  'What remains: an OBSERVE-mode permit authorises no address and connects by name as it always ' +
  'did (counted, never silent), and a cancelled run waits out the publish timeout instead of ' +
  'aborting the socket.';

/**
 * THE PINNED TRANSPORT, injected for exactly the same reason the guard is.
 *
 * The production door supplies NEITHER — `plugins/contract.ts:2712` calls
 * `publishVerification(ctx, config, input)` — so the default built here is what
 * ships, and there is no path from this function to a socket that skipped a
 * decision. A test supplies its own to drive the 200/401/404/3xx arms without
 * opening a connection to a public address, which is a thing a unit test must
 * never do.
 *
 * WHAT A FAKE TRANSPORT CANNOT PROVE, said plainly so nobody reads a green
 * suite as evidence it does: that the pin is honoured at the socket. That is
 * proved against REAL loopback sockets with the name rebound, in
 * `contract-events.test.ts` ("the pin is enforced at the socket") and in
 * `packages/shared/src/pinned-request.test.ts`. The tests here assert the
 * PRODUCT rules — published, skipped, which sentence, no token anywhere — plus
 * the one structural fact they can prove: that the permit handed to the
 * transport is the GUARD'S OWN, addresses and all.
 */
export type BrokerTransport = (
  permit: EgressPermit,
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<PinnedSent>;

/**
 * The transport production gets: `sendPinned`, with this module's own timeout
 * and this module's own body cap.
 *
 * {@link BODY_SNIPPET_LIMIT} is the cap because it is the one `contract-events.ts`
 * already documents and applies, and a second number invented here is how one of
 * them stops being the real one. It is applied to a body this path NEVER READS —
 * `entry()` below writes a note of its own and deliberately never carries the
 * broker's bytes, because a broker's error page can echo the request and the
 * request carried the token. So `truncated` is not reported anywhere, and that is
 * safe for the one reason that matters: no byte of the broker's answer reaches a
 * return value, a log line or a network entry.
 */
function defaultBrokerTransport(ctx: RunContext): BrokerTransport {
  return (permit, url, headers, body) =>
    sendPinned(ctx, permit, url, 'POST', headers, body, PUBLISH_TIMEOUT_MS, BODY_SNIPPET_LIMIT);
}

/**
 * THE OBSERVE-MODE ARM: connect BY NAME, exactly as this path always did.
 *
 * An OBSERVED permit authorised NO ADDRESS — `decideEgress` refuses to issue a
 * pin on an observed refusal, and `pinnedLookup` and `pinnedRequest` both refuse
 * one rather than let a caller borrow a pin it was not given. So the choice is
 * the caller's, and this is it: the connection happens the way it did before
 * this control existed, with the token, rebinding window open, because that is
 * what OBSERVE MEANS. Taking the publish away from an operator who armed the
 * brake would be the silent behaviour change the brake exists to avoid.
 * `login.ts`'s `LoginHostApproval` makes the identical call and even types the
 * credential there.
 *
 * ENFORCE is the default (`resolveEgressPolicy` with no policy at all is HOSTED
 * and ENFORCE), so nothing reaches here unless somebody set the mode on purpose.
 * And it is COUNTED: the outcome carries `pin: 'OBSERVE_BY_NAME'`.
 *
 * Normalised into {@link PinnedSent} so there is ONE shape downstream. Two
 * near-identical branches reading two different result types is how one of them
 * drifts.
 */
async function sendByName(
  ctx: RunContext,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<PinnedSent> {
  const sent = await send(ctx, url, 'POST', headers, body, PUBLISH_TIMEOUT_MS);
  if (sent.transportError !== null) {
    return { ok: false, refusal: 'TRANSPORT_FAILED', durationMs: sent.durationMs };
  }
  return {
    ok: true,
    // `send` returns a null status ONLY with a transport error, which returned
    // above. The 0 is the compiler's question answered, not a case: it lands in
    // the opaque-response arm below, which already means "not a status".
    status: sent.status ?? 0,
    headers: sent.headers,
    text: sent.text,
    // `send` reads the whole body. Not a default — a fact about that transport.
    truncated: false,
    durationMs: sent.durationMs,
  };
}

/**
 * THE REAL GUARD, built from the environment's own policy when it has one.
 *
 * `policy` is `unknown` because that is how `Environment.egressPolicy` reads
 * out of its JSONB column. Absent or unparseable falls through
 * `resolveEgressPolicy` to the HOSTED policy — PUBLIC ONLY — which is the
 * strictest reading; an absent policy must never be an open one. That is the
 * same posture `signInWithProfile` takes with `SignInContext.egressPolicy`.
 *
 * Built lazily per publish rather than per process: a worker handles runs for
 * many environments, and a module-level guard would apply one environment's
 * policy to the next one's broker.
 */
export async function defaultBrokerEgressGuard(policy?: unknown): Promise<BrokerEgressGuard> {
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
  return (url) => guardUrl({ url, context: 'TRACKER_CALL', policy: resolved, io });
}

/**
 * `Environment.egressPolicy`, as the run context carries it.
 *
 * `RunContext` in `packages/shared/src/types.ts` DOES NOT DECLARE THIS FIELD
 * yet — threading it is one line there and one in the worker's run processor,
 * neither of which this slice owns, and both are named in the handover. So it
 * is read structurally, and the reading is the SAFE one in the meantime:
 * `undefined` falls through `resolveEgressPolicy` to HOSTED, PUBLIC ONLY. The
 * day the field lands this function keeps working and the per-environment
 * brake arms itself.
 */
function egressPolicyOf(ctx: RunContext): unknown {
  return (ctx as RunContext & { readonly egressPolicy?: unknown }).egressPolicy;
}

/**
 * A pact's own name for itself becomes a path segment. It comes from the
 * document, which is data, so it gets the same treatment a configured repo slug
 * gets: no traversal, and encoded.
 */
function pathSegment(value: string, what: string): { segment: string } | { refused: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { refused: `the pact does not name its ${what}` };
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    return { refused: `"${trimmed}" is not a usable ${what} name` };
  }
  return { segment: encodeURIComponent(trimmed) };
}

/** One interaction's outcome, in the shape the broker records. */
export interface VerificationResult {
  interactionDescription: string;
  success: boolean;
  /** Only present on a failure; already free of secrets by construction. */
  exceptionMessage?: string;
}

export interface PublishInput {
  consumerName: string;
  providerName: string;
  /** True only when every verified interaction passed. */
  success: boolean;
  results: VerificationResult[];
}

/**
 * Build the verification-results URL from the validated origin and encoded path
 * segments — never from a link inside the fetched pact.
 *
 * Exported and pure so the property that matters can be asserted directly: a
 * consumer, provider or version name is data, and data may only ever choose a
 * path segment on the configured host.
 */
export function verificationResultsUrl(
  origin: string,
  providerName: string,
  consumerName: string,
  version: { pactVersion?: string; consumerVersion?: string },
): { url: string } | { refused: string } {
  // Exactly one addressing scheme, and QAAI will not guess which: the broker
  // addresses a pact either by the SHA of its content or by the consumer version
  // that published it, and guessing means reading a HAL link out of the document.
  const byPactVersion = (version.pactVersion ?? '').trim();
  const byConsumerVersion = (version.consumerVersion ?? '').trim();
  if (byPactVersion.length === 0 && byConsumerVersion.length === 0) {
    return {
      refused:
        'set `publish.pactVersion` to the pact content SHA the broker gave you, or `publish.consumerVersion` to the version that published the pact',
    };
  }
  if (byPactVersion.length > 0 && byConsumerVersion.length > 0) {
    return {
      refused:
        'set only one of `publish.pactVersion` and `publish.consumerVersion` — they address different things and the broker needs to know which you mean',
    };
  }

  const provider = pathSegment(providerName, 'provider');
  if ('refused' in provider) return provider;
  const consumer = pathSegment(consumerName, 'consumer');
  if ('refused' in consumer) return consumer;
  const pinned = pathSegment(
    byPactVersion.length > 0 ? byPactVersion : byConsumerVersion,
    'pact version',
  );
  if ('refused' in pinned) return pinned;

  const segment = byPactVersion.length > 0 ? 'pact-version' : 'version';
  return {
    url: `${origin}/pacts/provider/${provider.segment}/consumer/${consumer.segment}/${segment}/${pinned.segment}/verification-results`,
  };
}

/**
 * POST the verification results.
 *
 * The token is read out of `ctx.secrets` here and nowhere else, is used for
 * exactly one request, and never reaches a return value, a log line, a network
 * entry or a URL.
 */
/**
 * The host a broker secret is bound to, read from its own name.
 *
 * `PACT_BROKER_TOKEN__broker_acme_com` is bound to `broker.acme.com`. A plain
 * `PACT_BROKER_TOKEN` is unbound and returns null — existing setups keep
 * working, and a team that wants the binding opts in by naming the secret for
 * its host. Underscores map to dots because a secret name is
 * SCREAMING_SNAKE_CASE and cannot contain them.
 */
export function brokerHostFromSecretName(secretName: string): string | null {
  const marker = secretName.indexOf('__');
  if (marker === -1) return null;
  const encoded = secretName.slice(marker + 2).trim();
  if (encoded.length === 0) return null;
  return encoded.toLowerCase().replace(/_/g, '.').replace(/\.+$/, '');
}

export async function publishVerification(
  ctx: RunContext,
  config: BrokerPublishConfig,
  input: PublishInput,
  /**
   * The egress guard, injected. OPTIONAL so every existing caller keeps
   * compiling and keeps getting the REAL guard — the production door at
   * `packages/runner/src/plugins/contract.ts:2712` supplies none, so this
   * function builds {@link defaultBrokerEgressGuard} itself and there is no
   * path to the transport without a decision. A test supplies its own and
   * never touches a resolver.
   */
  egress?: BrokerEgressGuard,
  /**
   * The pinned transport, injected. OPTIONAL for the same reason and with the
   * same consequence as `egress` above: the production door supplies none, so
   * production gets {@link defaultBrokerTransport} and the pin is enforced. See
   * {@link BrokerTransport} for what a fake one does and does not prove.
   */
  transport?: BrokerTransport,
): Promise<PublishOutcome> {
  const started = Date.now();

  const origin = brokerOrigin(config.brokerUrl);
  if ('refused' in origin) {
    return skipped(`Verification results were not published: ${origin.refused}.`);
  }

  const target = verificationResultsUrl(
    origin.origin,
    config.providerName ?? input.providerName,
    input.consumerName,
    config,
  );
  if ('refused' in target) {
    return skipped(`Verification results were not published: ${target.refused}.`);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/hal+json, application/json',
    'user-agent': 'qaai',
  };

  if (config.auth !== undefined) {
    /*
     * BIND THE TOKEN TO A HOST.
     *
     * Every other guard in `brokerOrigin` refuses a host we can name as bad.
     * None of them can refuse `github.com.evil.com`, because a Pact broker is
     * legitimately self-hosted and that string is indistinguishable from
     * `broker.mycompany.com`. There is no allow-list to check against — which
     * means the destination is, in the end, whatever an org admin typed into a
     * config field, and the token follows it there. That is the exact shape of
     * the PAT exfiltration this repo already shipped once.
     *
     * So the token is not addressed to "a broker", it is addressed to a HOST.
     * The secret's name must carry the host it belongs to, and the two must
     * agree before it is sent. Repointing the broker URL at another host now
     * fails closed and requires someone to deliberately store a new secret for
     * that host, which is a different and much louder act than editing a URL.
     *
     * Same fix as `Integration.configEnc` being cleared when a repo changes:
     * a credential is only valid for the destination it was granted for.
     */
    const expectedHost = brokerHostFromSecretName(config.auth.secretName);
    if (expectedHost !== null && expectedHost !== origin.host) {
      return skipped(
        `Verification results were not published: the secret ${config.auth.secretName} is bound to ` +
          `${expectedHost}, but the broker URL points at ${origin.host}. A broker token is granted for one ` +
          `host — store a secret for ${origin.host} if that is really where these results belong.`,
      );
    }

    const token = ctx.secrets[config.auth.secretName];
    if (token === undefined || token.length === 0) {
      return skipped(
        `Verification results were not published: the secret ${config.auth.secretName} is not set for this environment. Add it, or drop \`publish.auth\` if the broker is open.`,
      );
    }
    headers['authorization'] =
      config.auth.scheme === 'basic'
        ? // Same shape as Jira Cloud in issues.ts: one secret holding `user:password`.
          `Basic ${Buffer.from(token).toString('base64')}`
        : `Bearer ${token}`;
  }

  const url = target.url;

  const payload = {
    success: input.success,
    providerApplicationVersion: config.providerVersion,
    ...(config.providerVersionBranch !== undefined
      ? { providerVersionBranch: config.providerVersionBranch }
      : {}),
    ...(config.buildUrl !== undefined ? { buildUrl: config.buildUrl } : {}),
    verifiedBy: { implementation: 'QAAI', version: '1' },
    testResults: input.results.map((result) => ({
      interactionDescription: result.interactionDescription,
      success: result.success,
      ...(result.exceptionMessage !== undefined
        ? { exception: { message: result.exceptionMessage } }
        : {}),
    })),
  };

  /*
   * ── RESOLVE AND CLASSIFY, IMMEDIATELY BEFORE THE ONE LINE THAT CONNECTS ───
   *
   * ── Why here and not above the `config.auth` block ────────────────────────
   *
   * The instinct is to refuse before the credential is touched, and on the Jira
   * path that is exactly right because the token is still CIPHERTEXT until the
   * route unseals it. Here it buys nothing: `ctx.secrets` is already decrypted
   * plaintext in this process, so assembling a header out of it sends nothing
   * and reveals nothing. What the earlier position DID cost was measurable —
   * it made the "skips, naming the secret, when the broker credential is not
   * set" case in `contract-events.test.ts` resolve `broker.example.com`, which
   * both changed that refusal's reason and put a live DNS query into a test
   * that had none. The later position returns on the missing secret first, as
   * it always did, and resolves nothing.
   *
   * What the guard still guarantees is the only thing that matters: NOTHING IS
   * SENT. There is no arm below that reaches a transport on a refusal, and no
   * exception arm that falls through to one. And the guard's PERMIT now travels
   * to the transport rather than being discarded, so "classified" and
   * "connected to" are the same addresses — see the two arms below.
   *
   * ── The refusal is SKIPPED, with ONE sentence ─────────────────────────────
   *
   * SKIPPED and never FAILED, because of the product rule that outranks
   * everything else in this file: PUBLISHING IS NEVER THE REASON A CONTRACT
   * TEST FAILS. The provider's conformance was decided before this function
   * ran.
   *
   * And {@link refusalForCaller} gives ONE CONSTANT, identical for a loopback
   * address, a link-local address, an unresolvable name and a context that may
   * never reach outward. A refusal that varied would turn `publish.brokerUrl`
   * into a port scanner whose report is the run's own step list. The operator's
   * copy — the class, the address, the refusal code — stays in
   * `verdict.operatorDetail` and is deliberately NOT returned.
   */
  const guard = egress ?? (await defaultBrokerEgressGuard(egressPolicyOf(ctx)));
  const verdict = await guard(url);
  if (!verdict.ok) {
    return skipped(
      `Verification results were not published: ${refusalForCaller(verdict).sentence} ` +
        "The provider's conformance is unaffected.",
      Date.now() - started,
    );
  }

  /*
   * ── AND NOW THE HALF THAT USED TO BE THROWN AWAY: THE PIN ─────────────────
   *
   * `verdict.permit` carries the ADDRESS SET the guard resolved and classified.
   * This call site used to read `verdict.ok`, discard the permit and call global
   * `fetch(url)` by name — so the name was resolved a SECOND time, by the
   * transport, and an attacker who owns the nameserver answered that query with
   * 127.0.0.1 while the token went along for the ride. See
   * {@link BROKER_PIN_LIMITATION} above for the end-to-end measurement.
   *
   * The permit now travels to the transport, which connects to those addresses
   * and never resolves the name again. The two arms are the two kinds of permit
   * and they are NOT the same permission: PINNED carries addresses, OBSERVED
   * carries none and means "connect as you always did" — see
   * {@link sendByName}. Which one happened is recorded on the outcome.
   */
  const permit = verdict.permit;
  const pin: PublishPin = permit.kind === 'PINNED' ? 'ENFORCED' : 'OBSERVE_BY_NAME';
  const body = JSON.stringify(payload);
  const answered =
    permit.kind === 'PINNED'
      ? await (transport ?? defaultBrokerTransport(ctx))(permit, url, headers, body)
      : await sendByName(ctx, url, headers, body);
  const durationMs = Date.now() - started;

  /*
   * The network entry is built by hand rather than with `toNetworkEntry`, which
   * captures the response body on an error status. A broker's error page can
   * echo the request, and the request carried the token.
   */
  const entry = (note: string | null): NetworkEntry => ({
    method: 'POST',
    url: maskUrl(url),
    status: answered.ok ? answered.status : null,
    durationMs: answered.durationMs,
    responseBodySnippet: note,
  });

  if (!answered.ok) {
    /*
     * ── THE REFUSAL VOCABULARY DOES NOT GROW BY ONE PER TRANSPORT ───────────
     *
     * `sendPinned` answers with a CODE from a closed set, and the codes split
     * into exactly the two sentences this file already said, plus one about our
     * own state:
     *
     *   TRANSPORT_FAILED, TIMED_OUT  the broker did not answer. "Unreachable",
     *                                which is what this arm has always said.
     *   RUN_CANCELLED                the run was torn down before the publish.
     *                                Nothing about the host, so no oracle; and
     *                                saying "unreachable" for it would be a
     *                                sentence that is simply not true.
     *   everything else              QAAI refused to open it. Unreachable by
     *                                construction here — a PINNED permit with
     *                                addresses, for the very URL the guard
     *                                decided about — so this arm is defence in
     *                                depth, and it answers with the guard's own
     *                                ONE CONSTANT rather than a fourth sentence.
     *
     * No code, status or timing difference is rendered: the same sentence covers
     * a connection refused at the pinned address and one that timed out, which
     * is what stops `publish.brokerUrl` from being a port scanner whose report
     * is the run's own step list.
     */
    const unreachable = answered.refusal === 'TRANSPORT_FAILED' || answered.refusal === 'TIMED_OUT';
    if (answered.refusal === 'RUN_CANCELLED') {
      return skipped(
        `Verification results were not published: the run was cancelled first. The provider's conformance is unaffected.`,
        durationMs,
        entry('run cancelled'),
        pin,
      );
    }
    return skipped(
      unreachable
        ? `Verification results were not published: the broker was unreachable. The provider's conformance is unaffected.`
        : `Verification results were not published: ${refusalForCaller(verdict).sentence} ` +
            "The provider's conformance is unaffected.",
      durationMs,
      entry(unreachable ? 'the broker was unreachable' : 'refused before the socket'),
      pin,
    );
  }

  const status = answered.status;

  // The pinned transport hands back the real 3xx and never follows one; so does
  // `fetch` under `redirect: 'manual'` on the observe arm, while a spec-strict
  // runtime hands back an opaque response with status 0. All three mean the same
  // thing and none of them is followed while we are holding the token.
  if (status === 0 || (status >= 300 && status < 400)) {
    return skipped(
      'Verification results were not published: the broker answered with a redirect, and QAAI will not follow one while holding your token. Check `publish.brokerUrl`.',
      durationMs,
      entry('redirect refused'),
      pin,
    );
  }

  if (status === 401 || status === 403) {
    return skipped(
      `Verification results were not published: the broker rejected the credential (${status}). Re-enter the secret named in \`publish.auth.secretName\`.`,
      durationMs,
      entry('credential rejected'),
      pin,
    );
  }
  if (status === 404) {
    return skipped(
      `Verification results were not published: the broker returned 404 — it does not know a pact for ${input.consumerName} → ${input.providerName} at that version. Check \`publish.${(config.pactVersion ?? '').trim().length > 0 ? 'pactVersion' : 'consumerVersion'}\`.`,
      durationMs,
      entry('no such pact'),
      pin,
    );
  }
  if (status >= 400) {
    return skipped(
      `Verification results were not published: the broker returned ${status}. The provider's conformance is unaffected.`,
      durationMs,
      entry(`broker returned ${status}`),
      pin,
    );
  }

  return {
    status: 'PUBLISHED',
    detail: `Published ${input.success ? 'a passing' : 'a failing'} verification for ${input.consumerName} → ${input.providerName} (provider version ${config.providerVersion}).`,
    durationMs,
    network: entry(null),
    pin,
  };
}
