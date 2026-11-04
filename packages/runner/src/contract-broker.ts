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
 * hostname that walked straight past every guard. The rules, all enforced below
 * before the token is ever read out of the vault:
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
 *   - `redirect: 'manual'`. A 3xx is refused, never followed — following one
 *     re-sends the Authorization header to whatever `Location` names.
 *   - No token, no response body, and no header is ever logged or returned. The
 *     only broker text a user sees is a status-derived sentence written here.
 *
 * And one product rule that outranks all of it: PUBLISHING IS NEVER THE REASON A
 * CONTRACT TEST FAILS. A missing broker, a missing token, a refused destination
 * or an unreachable one all come back as SKIPPED with the thing to fix. The
 * provider's conformance was already decided before this module ran.
 */

import * as dns from 'node:dns';
import type { EgressGuardIo, EgressGuardVerdict, NetworkEntry, RunContext } from '@qaai/shared';
import { guardUrl, maskUrl, refusalForCaller, resolveEgressPolicy } from '@qaai/shared';
import type { BrokerPublishConfig } from './contract-events.js';
import { send } from './contract-events.js';

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

/** Why the publish did not happen, or where it landed. */
export type PublishOutcome =
  | { status: 'PUBLISHED'; detail: string; durationMs: number; network: NetworkEntry }
  | { status: 'SKIPPED'; detail: string; durationMs: number; network: NetworkEntry | null };

function skipped(
  detail: string,
  durationMs = 0,
  network: NetworkEntry | null = null,
): PublishOutcome {
  return { status: 'SKIPPED', detail, durationMs, network };
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
 * WHAT THIS CONTROL DOES NOT DO, STATED HERE BECAUSE A COMMENT IS WHAT THE NEXT
 * REVIEWER TRUSTS INSTEAD OF READING THE CODE.
 *
 * `guardUrl` hands back a PINNED ADDRESS SET, and the pin is the half that
 * turns a check into a control: whoever opens the connection must connect to
 * those addresses and must not resolve the name again. The transport here is
 * `send()` in `contract-events.ts`, which uses Node's GLOBAL `fetch` — and
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
 * So the classification is real, EVERY address the name answers with is
 * classified, and THE PIN IS NOT ENFORCED AT THE SOCKET. The residual hole is
 * exactly one race — a record set answering a public address here and a private
 * one to `fetch`. Named rather than papered over, the same way
 * `REFRESH_PIN_LIMITATION` names it on the auth-refresh path. The remedy is one
 * optional `lookup` parameter on `send()`; it is in the handover.
 */
export const BROKER_PIN_LIMITATION =
  'The broker host was resolved and every address it answered with was classified, but Node’s ' +
  'global fetch cannot be handed a resolver, so the pinned address set is not enforced at the ' +
  'socket.';

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
   * SENT. There is no arm below that reaches `send` on a refusal, and no
   * exception arm that falls through to it.
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

  const sent = await send(ctx, url, 'POST', headers, JSON.stringify(payload), PUBLISH_TIMEOUT_MS);
  const durationMs = Date.now() - started;

  /*
   * The network entry is built by hand rather than with `toNetworkEntry`, which
   * captures the response body on an error status. A broker's error page can
   * echo the request, and the request carried the token.
   */
  const entry = (note: string | null): NetworkEntry => ({
    method: 'POST',
    url: maskUrl(url),
    status: sent.status,
    durationMs: sent.durationMs,
    responseBodySnippet: note,
  });

  if (sent.transportError !== null) {
    return skipped(
      `Verification results were not published: the broker was unreachable. The provider's conformance is unaffected.`,
      durationMs,
      entry('the broker was unreachable'),
    );
  }

  // A null status only happens with a transport error, which returned above.
  const status = sent.status ?? 0;

  // Node's fetch hands back the real 3xx under `redirect: 'manual'`; a
  // spec-strict runtime hands back an opaque response with status 0. Both mean
  // the same thing and neither is followed while we are holding the token.
  if (status === 0 || (status >= 300 && status < 400)) {
    return skipped(
      'Verification results were not published: the broker answered with a redirect, and QAAI will not follow one while holding your token. Check `publish.brokerUrl`.',
      durationMs,
      entry('redirect refused'),
    );
  }

  if (status === 401 || status === 403) {
    return skipped(
      `Verification results were not published: the broker rejected the credential (${status}). Re-enter the secret named in \`publish.auth.secretName\`.`,
      durationMs,
      entry('credential rejected'),
    );
  }
  if (status === 404) {
    return skipped(
      `Verification results were not published: the broker returned 404 — it does not know a pact for ${input.consumerName} → ${input.providerName} at that version. Check \`publish.${(config.pactVersion ?? '').trim().length > 0 ? 'pactVersion' : 'consumerVersion'}\`.`,
      durationMs,
      entry('no such pact'),
    );
  }
  if (status >= 400) {
    return skipped(
      `Verification results were not published: the broker returned ${status}. The provider's conformance is unaffected.`,
      durationMs,
      entry(`broker returned ${status}`),
    );
  }

  return {
    status: 'PUBLISHED',
    detail: `Published ${input.success ? 'a passing' : 'a failing'} verification for ${input.consumerName} → ${input.providerName} (provider version ${config.providerVersion}).`,
    durationMs,
    network: entry(null),
  };
}
