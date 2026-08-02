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

import type { NetworkEntry, RunContext } from '@qaai/shared';
import { maskUrl } from '@qaai/shared';
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
const INTERNAL_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.intranet|.+\.lan|.+\.corp|.+\.private|.+\.svc|.+\.cluster\.local|.+\.home\.arpa)$/i;

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
  if (isIpLiteral || INTERNAL_HOST.test(host) || METADATA_HOST.has(host) || !host.includes('.')) {
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
