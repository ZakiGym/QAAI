/**
 * SSO routes (§1, §9) — the OIDC login flow, SAML's endpoints, and the admin
 * surface for configuring a connection.
 *
 * The trust decisions all live in lib/sso.ts and are unit-tested there. This
 * file is the plumbing around them, and it has four jobs of its own:
 *
 *   1. **Run the login path with no tenant in scope.** A browser arriving at
 *      /sso/start is anonymous, so every read on the way in is an explicit
 *      `unscoped()` with the orgId taken from the row rather than the caller.
 *      Writes under `unscoped()` are not stamped by the tenancy extension, so
 *      they set `orgId` by hand — and it always comes from the connection.
 *
 *   2. **Make every in-flight login single-use.** The state row is consumed
 *      with a conditional update (`where: { consumedAt: null }`), so two
 *      callbacks racing the same code cannot both mint a session; the loser
 *      sees an update count of zero.
 *
 *   3. **Never turn the callback into a JSON error.** The browser is mid-
 *      redirect, so failures land on the login page with a sentence we wrote.
 *      Provider text is never echoed.
 *
 *   4. **Fail closed.** Feature gate off, connection disabled, domain
 *      unverified, no SAML verifier — all of them refuse the login. The house
 *      rule that a missing dependency is *skipped* rather than failed is about
 *      test signals, where continuing is the safe direction. Here the signal is
 *      "is this stranger who they say they are", and the safe answer to "I
 *      cannot check" is no.
 *
 * ─── What changed, and what was already here ────────────────────────────────
 *
 * SAML's *return* leg has been complete for a while: `checkSamlAssertion` in
 * lib/sso.ts, a real XML-signature verifier in lib/saml-verifier.ts registered
 * at the composition root, and the `SsoAssertionSeen` unique index as the
 * replay guard. What did not exist was the *outbound* leg — this file refused
 * `protocol === 'SAML'` at /sso/start with a flat sentence, nothing ever built
 * an `<AuthnRequest>`, and `SsoLoginRequest.samlRequestId` (a column that
 * exists, and whose comment says what it is for) was never written. So SAML
 * worked only IdP-initiated, by posting to the ACS out of nowhere, and the
 * "Sign in with SSO" button on the login page led to a refusal.
 *
 * The ACS also asked for the wrong value: it passed the login request's *row
 * id* as the expected `InResponseTo`, which is a database key no IdP has ever
 * seen. Any real SP-initiated assertion would have been refused by it.
 */

import { Router } from 'express';
// NOT `Response`: Express's Response type would shadow the global fetch
// Response used in providerFetch, and the shadowing error is confusing enough
// that it is worth naming here.
import type { Request } from 'express';
import { promises as dns } from 'node:dns';
import { deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { EGRESS_REFUSAL_SENTENCE } from '@qaai/shared';
import type { EgressPermit } from '@qaai/shared';
/*
 * BY PATH, NOT THROUGH THE BARREL, and this is the same rule `vault.ts` follows
 * for `sealed.ts`: `pinned-request.ts` imports `node:http` and `node:https`,
 * `packages/shared/src/index.ts` is imported by `apps/web`, and a barrel line
 * for it would drag Node's HTTP stack into a browser bundle. `private-address.ts`
 * (which imports `node:dns`) is handled the same way.
 *
 * MEASURED: `@qaai/shared/pinned-request` does NOT resolve — "Package subpath
 * './pinned-request' is not defined by exports" — because that package's
 * `exports` map lists five entries and this is not one of them. Adding it is one
 * line in a file this slice does not own, and it is in needsFromOtherFiles; the
 * relative path is what works today and it is the shape `vault.ts`, `kms.ts` and
 * `rotate-vault-key.ts` already use.
 */
import { pinnedRequest } from '../../../../packages/shared/src/pinned-request.js';
import type { PinnedRequestRefusal } from '../../../../packages/shared/src/pinned-request.js';
import { prisma, unscoped } from '../lib/prisma.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { open as vaultOpen, seal } from '../lib/vault.js';
import { hasFeature } from '../lib/plan.js';
import { env, isProd } from '../env.js';
import { SESSION_COOKIE, actorOf, requireAuth, requireRole } from '../middleware/auth.js';
import {
  assertedEmailIsInScope,
  checkSamlAssertion,
  clampJitRole,
  constantTimeEqual,
  createPkce,
  decodeJwt,
  discoveryUrl,
  domainVerificationHost,
  domainVerificationRecord,
  emailDomain,
  identityFromUserinfo,
  normalizeDomain,
  normalizeIssuer,
  parseDiscovery,
  defaultSsoEgressGuard,
  guardOutboundUrl,
  safeOutboundUrl,
  safeRelativePath,
  samlDisplayName,
  samlEmail,
  samlVerifier,
  selectJwk,
  spAcsUrl,
  spEntityId,
  spMetadataXml,
  SsoError,
  SSO_PROTOCOLS,
  SSO_REQUEST_TTL_MS,
  PROVIDER_RESPONSE_MAX_BYTES,
  REQUEST_TIMEOUT_MS,
  txtRecordsProveOwnership,
  validateIdTokenClaims,
  verifyJwtSignature,
  type Jwk,
  type OidcEndpoints,
  type SamlAssertionFacts,
} from '../lib/sso.js';
import type { SsoEgressGuard } from '../lib/sso.js';

export const ssoRouter: Router = Router();

/** One registered redirect URI for every connection; state carries the rest. */
const redirectUri = () => `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/sso/oidc/callback`;

const webUrl = (path: string) => `${env.WEB_PUBLIC_URL.replace(/\/+$/, '')}${path}`;

// ─── Session issuance ────────────────────────────────────────────────────────

/*
 * Deliberately duplicated from routes/auth.ts rather than imported.
 *
 * Importing would be tidier, but auth.ts does not export either helper and it
 * belongs to a different owner in this change. Two copies of six lines is a
 * smaller risk than editing the file that mints every other session in the
 * product. The cookie attributes MUST stay identical to auth.ts's — if that
 * file's cookie changes, this one has to follow, or SSO sessions become subtly
 * different from password sessions.
 */
function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    isProd ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

async function issueSession(userId: string, orgId: string, ip: string | null, ua: string | null) {
  const raw = generateToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);
  await unscoped(() =>
    prisma.session.create({
      data: { userId, tokenHash: hashToken(raw), activeOrgId: orgId, ip, userAgent: ua, expiresAt },
    }),
  );
  return { raw, maxAge: env.SESSION_TTL_HOURS * 3600 };
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * The actor on a refused login: nobody, yet.
 *
 * `audit()` maps a falsy userId to a null column, which is the right shape —
 * the whole point of a refusal is that we never established who this was, and
 * writing a userId would be claiming we did.
 */
const ANONYMOUS_ACTOR = '';

// ─── Outbound HTTP ───────────────────────────────────────────────────────────

/**
 * HOW THIS ROUTER REACHES DNS, so a test can hand it an answer.
 *
 * One function rather than an options bag, because there is exactly one thing to
 * inject here. `configureSsoEgress(null)` puts the real guard back, which is
 * what an `afterEach` wants so one test cannot leak its resolver into the next.
 */
type SsoEgressGuardFactory = () => Promise<SsoEgressGuard>;

let egressGuard: SsoEgressGuardFactory = () => defaultSsoEgressGuard();

export function configureSsoEgress(next: SsoEgressGuardFactory | null): void {
  egressGuard = next ?? (() => defaultSsoEgressGuard());
}

/**
 * WHAT THIS ROUTER COUNTED ABOUT ITS OWN OUTBOUND CONNECTIONS.
 *
 * A closed vocabulary, because rule 7 of the round that wired the pin says a
 * cap or a refusal applied without being counted is one nobody can defend, and
 * the OBSERVE arm below is exactly such a decision: it connects by name, with
 * the rebinding window open, and the only honest way to ship that is to be able
 * to say how often it happened.
 *
 * `PINNED_SENT` is the denominator. A refusal count with no denominator is the
 * kind of number that gets quoted at a customer and cannot be defended — the
 * same reason `countGuard` in egress-guard.ts counts permits as well as
 * refusals.
 *
 * NO HOST, NO URL, NO REFUSAL DETAIL IN THE KEY. A row per connection would be
 * an inventory of every identity-provider host this install talks to, keyed by
 * outcome, which is the thing an attacker would most like to read — and the
 * webhook lesson applies doubly here, because a token endpoint URL is reached
 * while holding a client secret.
 */
export type SsoTransportOutcome = 'PINNED_SENT' | 'OBSERVED_BY_NAME' | PinnedRequestRefusal;

const transportCounts = new Map<SsoTransportOutcome, number>();

function countTransport(outcome: SsoTransportOutcome): void {
  transportCounts.set(outcome, (transportCounts.get(outcome) ?? 0) + 1);
}

/** A snapshot, copied so a reader cannot mutate the counter it is reading. */
export function ssoTransportCounts(): ReadonlyMap<SsoTransportOutcome, number> {
  return new Map(transportCounts);
}

/**
 * Zero the counters. For a test that needs to attribute a count to its own
 * request, in the same spirit as `configureSsoEgress(null)` — nothing in
 * production calls it, and a counter that cannot be zeroed is a counter two
 * tests have to share.
 */
export function resetSsoTransportCounts(): void {
  transportCounts.clear();
}

/** One provider answer, reduced to what the parsing below needs. */
interface ProviderAnswer {
  readonly status: number;
  readonly text: string;
  /**
   * True when the cap bit. Carried rather than dropped because a capped body
   * reported as a whole one is how a reader comes to believe a provider
   * answered something it did not — and here it would be `parseDiscovery`
   * reading a half-document and blaming the provider for the field it cut off.
   */
  readonly truncated: boolean;
}

/**
 * WHAT A FAILED CONNECTION SAYS OUT LOUD, AND WHY IT IS NOT MORE HELPFUL.
 *
 * The four control refusals — an OBSERVED permit, an unparseable URL, a scheme
 * the transport will not open, a URL whose host is not the pinned one — all map
 * to `EGRESS_REFUSAL_SENTENCE`, which is the single sentence
 * `guardOutboundUrl` already throws for all seventeen guard refusals. So a
 * caller cannot tell "the guard refused this" from "the pin refused this", and
 * the sign-in page does not become a readable report on our own network.
 *
 * The two transport refusals keep the two sentences this function has always
 * said, and that distinction got SAFER rather than riskier with the pin in
 * place: it used to be made about whatever the name resolved to, internal
 * addresses included, and it is now only ever made about an address the guard
 * classified as public. `operatorDetail` holds the host and the socket error
 * and is deliberately not thrown.
 */
function refusalFor(refusal: PinnedRequestRefusal): SsoError {
  if (refusal === 'TIMED_OUT') {
    return new SsoError('Your identity provider did not answer in time. Try signing in again.', 'CONFIG');
  }
  if (refusal === 'TRANSPORT_FAILED') {
    return new SsoError('Your identity provider was unreachable. Try signing in again.', 'CONFIG');
  }
  return new SsoError(EGRESS_REFUSAL_SENTENCE, 'CONFIG');
}

/**
 * Read a `fetch` body with the same cap the pinned transport applies.
 *
 * `await response.text()` has no limit, which is what this path did: a provider
 * — or whatever a rebound name pointed at — could stream until the process ran
 * out of memory, on a leg reachable by an ANONYMOUS request to /sso/start. Only
 * the OBSERVE arm still uses `fetch`, and it gets the cap too, because "observe
 * mode" means the pin is not enforced, not that nothing is.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ text: string; truncated: boolean }> {
  if (body === null) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > PROVIDER_RESPONSE_MAX_BYTES) {
        // Keep the bytes up to the cap and say so. Destroying the stream is
        // what stops a hostile server streaming forever.
        chunks.push(value.subarray(0, Math.max(0, PROVIDER_RESPONSE_MAX_BYTES - (bytes - value.byteLength))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** The headers every leg sends, with the caller's on top. */
function providerHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  return { accept: 'application/json', 'user-agent': 'qaai', ...(extra ?? {}) };
}

/**
 * THE PINNED ARM. The socket goes to an address the guard classified, and the
 * NAME stays in the request so Host, SNI and the certificate check keep working.
 *
 * `pinnedRequest` makes NO DNS QUERY of its own — that is the whole point — and
 * it never follows a redirect, which is the same rule this function has always
 * stated for the same reason: following one would re-send the client secret to
 * whatever `Location` names.
 */
async function sendPinned(
  /*
   * DELIBERATELY NOT NARROWED to the PINNED member. `providerFetch` only ever
   * calls this with one, and if a future branch got that wrong the transport's
   * own NOT_PINNED refusal is what answers — a refusal, not a connection by
   * name. Narrowing the parameter would move that decision to the compiler and
   * delete the run-time arm that fails closed.
   */
  permit: EgressPermit,
  target: URL,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<ProviderAnswer> {
  const result = await pinnedRequest(permit, target.href, {
    method: init.method,
    headers: providerHeaders(init.headers),
    body: init.body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: PROVIDER_RESPONSE_MAX_BYTES,
  });
  if (!result.ok) {
    countTransport(result.refusal);
    /*
     * THE REFUSAL CODE AND THE HOST, FOR AN OPERATOR — AND NOT
     * `result.operatorDetail`. That field is free text from the transport and
     * may one day carry a URL; on this path a URL holds no credential, but a
     * sibling path's webhook URL holds the token IN the path, and a log line
     * that is safe only because of a fact about one caller is a log line that
     * leaks the day a second caller copies it. The closed vocabulary plus the
     * host is everything a diagnosis needs.
     */
    logger.warn(
      { host: permit.kind === 'PINNED' ? permit.pinned.host : null, refusal: result.refusal },
      'sso provider request refused by the pinned transport',
    );
    /*
     * FAILS CLOSED, with no arm that falls through to "send it anyway". A
     * refused pin means the connection did not happen, and the one thing this
     * must never do is retry by name — which is precisely the bypass the pin
     * exists to close.
     */
    throw refusalFor(result.refusal);
  }
  countTransport('PINNED_SENT');
  return {
    status: result.response.status,
    text: result.response.text,
    truncated: result.response.truncated,
  };
}

/**
 * THE OBSERVE ARM, AND WHY IT CONNECTS BY NAME.
 *
 * An OBSERVED permit authorises NO ADDRESS: `decideEgress` refuses to issue a
 * pin on an observed refusal, so `permit.pinned` is `null` and `pinnedRequest`
 * answers NOT_PINNED. Borrowing a pin it was not given is not an option and
 * refusing outright is not either — the whole meaning of the OBSERVE brake is
 * "this install's traffic keeps working while we measure what we would have
 * refused", and a self-hosted deployment delivering SSO through an endpoint the
 * policy dislikes is traffic that works today.
 *
 * So it connects exactly as this function did before the pin existed, by name,
 * with the rebinding window open — and it is COUNTED as OBSERVED_BY_NAME and
 * logged for the operator, because an unpinned connection that nobody can count
 * is the one that gets described as pinned in a year's time.
 */
async function sendByName(
  permit: Extract<EgressPermit, { kind: 'OBSERVED' }>,
  target: URL,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<ProviderAnswer> {
  countTransport('OBSERVED_BY_NAME');
  /*
   * The HOST and the refusal that was skipped, and nothing else. `GuardedTarget`
   * carries no path and no query on purpose, so there is no URL here to leak a
   * token out of — and the client secret is in a header or a body this never
   * touches.
   */
  logger.warn(
    { host: permit.target.host, context: permit.context, wouldRefuse: permit.wouldRefuse },
    'sso provider reached by name under the OBSERVE brake: the pinned address set is not enforced for this connection',
  );

  let response: Response;
  try {
    response = await fetch(target.href, {
      method: init.method,
      headers: providerHeaders(init.headers),
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'was unreachable';
    throw new SsoError(`Your identity provider ${reason}. Try signing in again.`, 'CONFIG');
  }

  // `opaqueredirect` cannot happen with `redirect: 'manual'` on Node's fetch,
  // but it is cheap to treat as the 3xx it is rather than as a 0-status answer.
  const status = response.type === 'opaqueredirect' ? 302 : response.status;
  const read = await readCapped(response.body);
  return { status, text: read.text, truncated: read.truncated };
}

/**
 * One request to a provider, with the two rules lib/issues.ts exists to state:
 * a 3xx is an error rather than a hop (following one re-sends the client secret
 * to whatever Location names), and a provider that has not answered in
 * REQUEST_TIMEOUT_MS is not going to.
 *
 * The URL is re-validated here even though the caller already validated it —
 * this is the last point before bytes leave the process, and a second check
 * costs nothing.
 *
 * ── IT RESOLVES THE HOST, AND FOR A WHILE IT DID NOT ─────────────────────────
 *
 * This read `safeOutboundUrl(url, what)`, which is a PATTERN MATCH THAT NEVER
 * RESOLVES: `isPrivateNetworkName` refuses `localhost`, a bare name and the
 * recognisable internal spellings, and answers "not internal" for any name with
 * a dot. So `https://sso.attacker.test` whose single A record is
 * 169.254.169.254 was ACCEPTED with ZERO DNS queries — and this function is the
 * one that carries the OIDC client secret, as an `authorization: Basic` header
 * or a `client_secret` body field, to the token endpoint.
 *
 * `guardOutboundUrl` is the resolving version, in lib/sso.ts, and it was
 * written and tested in the same round that left it with NO PRODUCTION CALLER —
 * one of its own test blocks is titled "the guard production actually gets". It
 * runs the same synchronous rules first (so an obviously-bad URL still costs no
 * lookup), then classifies EVERY address the name answers with.
 *
 * The guard is INJECTED through {@link configureSsoEgress} rather than built
 * inline, and that is not ceremony: a guard that constructs its own resolver
 * cannot be driven by a test without real DNS, and a control nobody can test
 * with a fake is a control nobody will trust. The default is
 * `defaultSsoEgressGuard()` with no policy argument — an SSO connection is
 * org-level and has no environment to read a policy from, so it falls through to
 * HOSTED, PUBLIC ONLY, which is the strictest reading. An absent policy must
 * never be an open one.
 *
 * ── AND IT NOW HONOURS THE PIN AT THE SOCKET, WHICH IT DID NOT ──────────────
 *
 * For four rounds this paragraph said the pin could not be enforced because
 * global `fetch` cannot be handed a resolver. The measurement behind that is
 * real and still reproduces — `fetch(url, { agent })` ignores the agent, 0
 * lookup calls — but the conclusion was wrong: an `http.Agent` carrying a
 * `lookup`, driven by `http.request`, is honoured by Node core with no
 * dependency change. RE-MEASURED on this tree against a loopback server:
 * `http.request` BY NAME consults `dns.lookup` once and reaches the server;
 * through an agent carrying a `lookup` it consults `dns.lookup` ZERO times.
 *
 * So the discarded half of the guard's answer — the permit — is now threaded
 * into `pinnedRequest`, and the second DNS query that made the whole check
 * cosmetic is gone. `SSO_PIN_LIMITATION` states what is still not enforced, and
 * the honest short version is: OBSERVE mode, which authorises no address at all
 * and therefore connects by name.
 *
 * FOUR LEGS come through here — discovery, JWKS, the token endpoint and
 * userinfo — which is why the guard belongs here and not at one call site, and
 * why the permit is obtained PER URL. A provider that passes discovery can
 * still name a JWKS or token URL pointing inside, and the token leg is the one
 * carrying the secret.
 */
async function providerFetch(
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  what: string,
): Promise<unknown> {
  const { url: target, permit } = await guardOutboundUrl(url, what, await egressGuard());

  const answer =
    permit.kind === 'PINNED'
      ? await sendPinned(permit, target, init)
      : await sendByName(permit, target, init);

  if (answer.status >= 300 && answer.status < 400) {
    throw new SsoError(
      'Your identity provider answered with a redirect, and QAAI will not follow one while holding a client secret. Check the issuer URL on the connection.',
      'CONFIG',
    );
  }

  if (answer.truncated) {
    /*
     * REFUSED, not parsed. A truncated discovery document would be reported to
     * an administrator as "your provider has no `issuer`", which is a lie about
     * the provider; and a truncated token response would be "no ID token
     * returned", which sends somebody hunting a scope they already granted.
     */
    throw new SsoError(
      'Your identity provider sent a larger response than QAAI will read. Check the issuer URL on the connection.',
      'CONFIG',
    );
  }

  // Parsed defensively: an error page is usually HTML, and the body is never
  // logged or echoed — it can contain the token we just asked for.
  let json: unknown = null;
  try {
    json = answer.text ? JSON.parse(answer.text) : null;
  } catch {
    json = null;
  }

  if (answer.status >= 400) {
    throw new SsoError(
      `Your identity provider refused the request (${answer.status}). Check the client id and secret on the connection.`,
      'CONFIG',
    );
  }
  return json;
}

// ─── Discovery and JWKS caches ───────────────────────────────────────────────

/*
 * In-process, best-effort, and correctness never depends on them: a cold cache
 * simply refetches. They exist so a login does not cost three round trips to
 * the IdP, and so a burst of logins cannot be turned into a burst of requests
 * at the provider (which would look like an attack from their side).
 */
const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
/** A token with an unknown kid may force one refetch, no more often than this. */
const JWKS_REFETCH_COOLDOWN_MS = 60_000;

const discoveryCache = new Map<string, { at: number; endpoints: OidcEndpoints }>();
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function endpointsFor(issuer: string): Promise<OidcEndpoints> {
  const key = normalizeIssuer(issuer);
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.endpoints;

  const doc = await providerFetch(discoveryUrl(key), { method: 'GET' }, 'discovery URL');
  const endpoints = parseDiscovery(key, doc);
  discoveryCache.set(key, { at: Date.now(), endpoints });
  return endpoints;
}

async function jwksFor(endpoints: OidcEndpoints, force: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(endpoints.jwksUri);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && !force && age < JWKS_TTL_MS) return hit.keys;
  // Rate-limit the forced path so an attacker cannot make us hammer the IdP by
  // replaying tokens with random kids.
  if (hit && force && age < JWKS_REFETCH_COOLDOWN_MS) return hit.keys;

  const doc = (await providerFetch(endpoints.jwksUri, { method: 'GET' }, 'JWKS URL')) as {
    keys?: unknown;
  } | null;
  const keys = Array.isArray(doc?.keys)
    ? doc.keys.filter((k): k is Jwk => !!k && typeof k === 'object')
    : [];
  if (keys.length === 0) {
    throw new SsoError('Your identity provider published no signing keys.', 'CONFIG');
  }
  jwksCache.set(endpoints.jwksUri, { at: Date.now(), keys });
  return keys;
}

// ─── Connection loading (anonymous side) ─────────────────────────────────────

type ConnectionRow = NonNullable<Awaited<ReturnType<typeof loadConnection>>>;

/**
 * Loads a connection and its VERIFIED domains for the login path.
 *
 * `verifiedAt: { not: null }` in the query is load-bearing and the test suite
 * mirrors it: an unverified domain is a claim, not a proof, and honouring one
 * would let any org assert addresses in a domain it does not own.
 */
async function loadConnection(connectionId: string) {
  return unscoped(() =>
    prisma.ssoConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        orgId: true,
        protocol: true,
        enabled: true,
        defaultRole: true,
        oidcIssuer: true,
        oidcClientId: true,
        oidcClientSecretEnc: true,
        oidcKeyVersion: true,
        oidcScopes: true,
        samlIdpEntityId: true,
        samlSsoUrl: true,
        samlIdpCertsPem: true,
        domains: {
          where: { verifiedAt: { not: null } },
          select: { domain: true },
        },
      },
    }),
  );
}

/** Refuses a connection that must not be used right now, and says why. */
async function assertUsable(connection: ConnectionRow): Promise<void> {
  if (!connection.enabled) {
    throw new SsoError('Single sign-on is turned off for this organization.', 'CONFIG');
  }
  // The plan gate is enforced on the login path, not only in the admin UI. An
  // org that drops off Business genuinely loses SSO; saying so is the honest
  // meaning of a paid feature, and the message points at the way back in.
  if (!(await hasFeature(connection.orgId, 'sso'))) {
    throw new SsoError(
      'Single sign-on is included with the Business and Enterprise plans. Sign in with your password, or ask an owner to upgrade.',
      'CONFIG',
    );
  }
  if (connection.domains.length === 0) {
    throw new SsoError(
      'This connection has no verified email domain yet, so QAAI cannot tell which accounts it may sign in.',
      'CONFIG',
    );
  }
}

// ─── JIT provisioning ────────────────────────────────────────────────────────

/**
 * Turn a verified assertion into a session.
 *
 * Order matters: the email is checked against the connection's verified domains
 * BEFORE any user row is touched, so an out-of-scope assertion never creates or
 * mutates anything.
 */
async function provisionAndSignIn(
  connection: ConnectionRow,
  identity: { email: string; name: string | null; subject: string },
  req: Request,
): Promise<{ raw: string; maxAge: number; userId: string }> {
  const verified = connection.domains.map((d) => d.domain);
  if (!identity.email || !assertedEmailIsInScope(identity.email, verified)) {
    // The refusal is audited because it is the interesting one: an IdP naming
    // an address outside its proven domains is either a misconfiguration or an
    // attempt at exactly the cross-org escalation this feature is built around.
    await audit({
      actor: { userId: ANONYMOUS_ACTOR, orgId: connection.orgId, ip: clientIp(req), impersonatedBy: null },
      action: 'sso.login_refused',
      targetType: 'SsoConnection',
      targetId: connection.id,
      metadata: {
        reason: 'asserted email is outside the connection’s verified domains',
        // Only the domain, never the full address of a person who may not be
        // a customer at all.
        assertedDomain: identity.email.split('@')[1] ?? null,
      },
    });
    throw new SsoError(
      'Your identity provider asserted an email address outside the domains verified for this organization.',
      'AUTH',
    );
  }

  const email = identity.email;
  const role = clampJitRole(connection.defaultRole);

  const user = await unscoped(async () => {
    const existing = await prisma.user.findUnique({
      where: { email },
      /*
       * `emailVerified` AND `passwordHash` are in this projection because the
       * claim decision below needs both. They were not, which is the defect:
       * this read took ANY row with that address, with no check of either, and
       * then a membership in the customer's org was attached to it.
       */
      select: { id: true, name: true, emailVerified: true, passwordHash: true },
    });
    if (existing) return existing;

    // JIT creation. `passwordHash: null` is the point — an SSO-provisioned
    // account has no password to guess, and the User model already documents
    // that shape for OAuth users. `isSuperuser` is never touched here.
    return prisma.user.create({
      data: {
        email,
        name: identity.name?.slice(0, 120) || email.split('@')[0]!,
        passwordHash: null,
        /*
         * The IdP asserted it and we proved the domain, so it is verified in
         * the only sense this column means.
         *
         * THIS LINE IS NOW LOAD-BEARING FOR THE CLAIM CHECK BELOW, which keys
         * on `emailVerified === null` and nothing else. A fresh row is not a
         * claim because this write says so — three lines up, where a reader can
         * see it, rather than through a separate "was it created" flag that no
         * test could pin.
         */
        emailVerified: new Date(),
      },
      select: { id: true, name: true, emailVerified: true, passwordHash: true },
    });
  });

  /*
   * ── THE PRE-ACCOUNT-TAKEOVER, AND THE ANSWER PICKED ────────────────────────
   *
   * THE ATTACK: an attacker signs up at `POST /auth/signup` with
   * victim@customer.com and a password they choose. The customer later
   * configures SSO for customer.com. The victim signs in through the IdP, JIT
   * finds the attacker's pre-made row and attaches a membership in the
   * customer's org to it — and the attacker's password was never cleared, so
   * they now hold password access to an account inside the customer's org.
   *
   * TWO CANDIDATE REMEDIES. Both were weighed; the second is implemented.
   *
   *   REFUSE a claim of a row whose address nobody proved. Correct in the
   *   abstract and unshippable in practice: `User.emailVerified` is nullable and
   *   nothing wrote it until this round, so EVERY existing user is unverified
   *   and refusing would lock out the whole installed base at the moment their
   *   org turns SSO on. That is why `EMAIL_VERIFICATION` defaults to OBSERVE,
   *   and a refusal is a lockout no brake setting makes safe.
   *
   *   SEVER every credential that predates the claim, which is what happens
   *   below. The person arriving holds the credential the ORG CONTROLS — its
   *   own identity provider, for a domain it proved. Anything already on the
   *   row was put there by whoever created it, and nobody ever proved that was
   *   the owner. So the password is nulled and every live session is revoked.
   *   NOBODY IS LOCKED OUT: the user is signing in successfully at this very
   *   moment, by the route their org chose.
   *
   * ── WHY THIS IS NOT GATED ON `EMAIL_VERIFICATION`'s MODE ───────────────────
   *
   * Deliberately unconditional, and that is a decision rather than an omission.
   * A brake exists to protect traffic that is legitimate TODAY (rule 13), and
   * severance stops no legitimate traffic — the legitimate owner is being signed
   * in as it runs. Gating it on a control whose documented default is OBSERVE
   * would leave the takeover open in every deployment that had not armed
   * anything, which is all of them. So there is nothing for a brake to protect
   * and the refusal has no mode.
   *
   * ── WHAT IS DELIBERATELY NOT SEVERED ──────────────────────────────────────
   *
   * A row whose `emailVerified` is already set keeps its password. That user
   * proved the address, so the password is theirs, and an org adding SSO must
   * not silently take away the login its people already had.
   *
   * A row this function JUST CREATED is also not a claim, and `emailVerified`
   * is the whole reason: the create path above stamps it. An earlier draft
   * carried a separate "was it created" flag beside this condition; a mutation
   * run proved no test could tell the difference, because a fresh row is never
   * unverified — so the flag was removed rather than left for the next reader
   * to mistake for a second guard.
   */
  if (user.emailVerified === null) {
    const now = new Date();
    const severedPassword = user.passwordHash !== null;

    /*
     * The password goes, and the address becomes verified by the same reasoning
     * the create path above records: the IdP asserted it and we proved the
     * domain. Written BEFORE the membership is attached, so there is no window
     * in which a pre-claim credential and the org membership are both live.
     */
    await unscoped(() =>
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: null, emailVerified: now },
      }),
    );

    /*
     * And every session that predates the claim, because nulling the password
     * alone leaves the attacker's live cookie — which, once the membership
     * lands, can reach the customer's org through the switch-org route. This
     * runs before `issueSession` below, so the session this login mints is not
     * among them.
     */
    const revoked = await unscoped(() =>
      prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    );

    if (severedPassword || revoked.count > 0) {
      await audit({
        actor: { userId: user.id, orgId: connection.orgId, ip: clientIp(req), impersonatedBy: null },
        action: 'sso.claim_severed',
        targetType: 'User',
        targetId: user.id,
        metadata: {
          // COUNTS AND FLAGS ONLY (rule 11). No password, no hash, no fragment
          // of one, no session token, and not the address either — only the
          // domain, which the connection already proved.
          assertedDomain: email.split('@')[1] ?? null,
          passwordCleared: severedPassword,
          sessionsRevoked: revoked.count,
          connectionId: connection.id,
        },
      });
    }
  }

  const membership = await unscoped(() =>
    prisma.membership.findUnique({
      where: { orgId_userId: { orgId: connection.orgId, userId: user.id } },
      select: { role: true },
    }),
  );

  if (!membership) {
    await unscoped(() =>
      prisma.membership.create({ data: { orgId: connection.orgId, userId: user.id, role } }),
    );
    await audit({
      actor: { userId: user.id, orgId: connection.orgId, ip: clientIp(req), impersonatedBy: null },
      action: 'sso.provision',
      targetType: 'Membership',
      targetId: user.id,
      metadata: { role, connectionId: connection.id },
    });
  }
  /*
   * An EXISTING membership is deliberately left alone.
   *
   * Re-applying defaultRole on every login would silently undo a promotion an
   * org admin made in the UI, and — worse in the other direction — would let a
   * connection configured with ADMIN quietly re-grant admin to someone who was
   * demoted. Role changes belong to the org's own member management.
   */

  await unscoped(() =>
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  );

  const session = await issueSession(
    user.id,
    connection.orgId,
    clientIp(req),
    req.headers['user-agent'] ?? null,
  );

  await audit({
    actor: { userId: user.id, orgId: connection.orgId, ip: clientIp(req), impersonatedBy: null },
    action: 'sso.login',
    targetType: 'SsoConnection',
    targetId: connection.id,
    metadata: { protocol: connection.protocol, subject: identity.subject },
  });

  return { ...session, userId: user.id };
}

/** Turns any failure into a landing on the login page with a sentence we wrote. */
function failToLogin(res: import('express').Response, err: unknown): void {
  const message =
    err instanceof SsoError
      ? err.message
      : err instanceof ApiError
        ? err.message
        : 'Single sign-on failed. Try again, or sign in with your password.';
  if (!(err instanceof SsoError) && !(err instanceof ApiError)) {
    // An unexpected error is a bug: log it server-side, show the user nothing.
    logger.error({ err }, 'sso callback failed');
  }
  res.redirect(302, `${webUrl('/login')}?sso_error=${encodeURIComponent(message.slice(0, 300))}`);
}

// ─── Discovery: which connection handles this address? ───────────────────────

/**
 * POST rather than GET on purpose: an email address must not end up in a URL,
 * a proxy log or a Referer header.
 *
 * This does reveal whether a domain has SSO configured, which is unavoidable —
 * every SSO login page in the world reveals it, because the user has to be sent
 * somewhere. It reveals nothing about whether a particular ACCOUNT exists, and
 * the response carries no org name or id.
 */
ssoRouter.post('/discover', async (req, res) => {
  const parsed = z.object({ email: z.string().min(3).max(320) }).safeParse(req.body);
  if (!parsed.success) throw badRequest('An email address is required');

  let domain: string;
  try {
    domain = emailDomain(parsed.data.email);
  } catch {
    res.json({ available: false });
    return;
  }

  const row = await unscoped(() =>
    prisma.ssoDomain.findUnique({
      where: { domain },
      select: {
        verifiedAt: true,
        connection: { select: { id: true, enabled: true, protocol: true, orgId: true } },
      },
    }),
  );

  if (!row?.verifiedAt || !row.connection.enabled) {
    res.json({ available: false });
    return;
  }
  if (!(await hasFeature(row.connection.orgId, 'sso'))) {
    res.json({ available: false });
    return;
  }
  /*
   * A SAML domain on a deployment with no signature verifier is a button that
   * cannot work, and the login page has to be able to say so rather than
   * sending the browser to a refusal.
   *
   * `reason` is a fixed vocabulary of ours, and this one describes THIS
   * deployment, not the organization — it reveals nothing about the customer
   * that the `available` flag has not already revealed. The plan gate above
   * deliberately gets no reason code: that one would be leaking somebody
   * else's billing state to an anonymous caller.
   */
  if (row.connection.protocol === 'SAML' && !samlVerifier()) {
    res.json({ available: false, reason: 'SAML_UNAVAILABLE' });
    return;
  }

  res.json({
    available: true,
    connectionId: row.connection.id,
    protocol: row.connection.protocol,
    startUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/sso/start/${row.connection.id}`,
  });
});

// ─── SAML: the outbound leg ──────────────────────────────────────────────────

/*
 * Duplicated from lib/sso.ts's private `xmlEscape` rather than exported from
 * it, for the same reason `sessionCookie` above is duplicated from auth.ts:
 * this change does not own that file. Six lines with no behaviour of their own
 * is the cheaper of the two risks. Every value it is applied to below is one of
 * ours — our entity id, our ACS URL, a token we generated — so this is defence
 * against a URL containing an ampersand, not against an attacker.
 */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The `<samlp:AuthnRequest>` this SP sends.
 *
 * UNSIGNED, and that is a decision rather than an omission: our SP metadata
 * already advertises `AuthnRequestsSigned="false"`, and signing would mean
 * holding an SP private key whose only job is to prove the request came from
 * us — which nothing in this flow rests on. What binds the request to the
 * assertion that comes back is `ID`, echoed by the IdP as `InResponseTo` and
 * stored on the login request row before the browser leaves. Everything that
 * decides whether to trust the answer happens on the way back in.
 *
 * `ID` is an xsd:ID, so it has to be an NCName. A base64url token is fine in
 * the tail but may start with a digit, which an NCName may not — hence the
 * leading underscore, which is why every IdP in the wild emits ids of exactly
 * this shape.
 *
 * `NameIDPolicy` carries no `Format` on purpose. Our metadata names
 * emailAddress, but nothing here depends on the NameID being an address —
 * `samlEmail()` prefers an explicit attribute and only falls back to the
 * NameID — and demanding a Format is the most common way an AuthnRequest gets
 * refused outright by ADFS and Entra ID.
 */
function authnRequestXml(input: {
  id: string;
  issueInstant: Date;
  destination: string;
  issuer: string;
  acsUrl: string;
}): string {
  return [
    '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"',
    ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"',
    ` ID="${xmlAttr(input.id)}"`,
    ' Version="2.0"',
    ` IssueInstant="${input.issueInstant.toISOString()}"`,
    ` Destination="${xmlAttr(input.destination)}"`,
    ' ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
    ` AssertionConsumerServiceURL="${xmlAttr(input.acsUrl)}">`,
    `<saml:Issuer>${xmlAttr(input.issuer)}</saml:Issuer>`,
    '<samlp:NameIDPolicy AllowCreate="true"/>',
    '</samlp:AuthnRequest>',
  ].join('');
}

/**
 * Send the browser to the IdP, HTTP-Redirect binding (SAML bindings §3.4).
 *
 * The refusals above the redirect name the one field an administrator still
 * has to fill in. A SAML connection can legitimately exist half-configured —
 * the IdP usually needs our metadata (which the admin surface serves from the
 * connection the moment it is created) before it will tell you its entity id
 * or hand over a certificate — so "not finished yet" is a normal state and
 * deserves a sentence that says which half, not a flat "not available".
 */
async function startSamlLogin(
  connection: ConnectionRow,
  req: Request,
  res: import('express').Response,
): Promise<void> {
  /*
   * Fails closed BEFORE the browser leaves.
   *
   * With no verifier registered nothing coming back could be checked, and this
   * is the kinder of the two refusals: sending someone to their IdP, making
   * them authenticate, and rejecting them on the doorstep teaches them nothing
   * and looks like their password was wrong.
   */
  if (!samlVerifier()) {
    throw new SsoError(
      'SAML sign-in is not available on this deployment. Use OIDC or password sign-in.',
      'CONFIG',
    );
  }
  if (!connection.samlSsoUrl) {
    throw new SsoError(
      'This connection has no identity-provider sign-on URL yet. An administrator adds it under Settings → Single sign-on, from the IdP’s SAML 2.0 metadata.',
      'CONFIG',
    );
  }
  if (!connection.samlIdpEntityId) {
    throw new SsoError(
      'This connection has no identity-provider entity id yet. An administrator copies it from the IdP’s metadata into Settings → Single sign-on.',
      'CONFIG',
    );
  }
  if (connection.samlIdpCertsPem.length === 0) {
    throw new SsoError(
      'This connection has no identity-provider signing certificate yet, and QAAI will not accept an assertion it cannot verify. An administrator adds the certificate under Settings → Single sign-on.',
      'CONFIG',
    );
  }

  // Re-validated at the point of use rather than trusted from the row — the
  // same rule providerFetch states one section up, and for the same reason:
  // rows outlive the validation that was in force when they were written.
  const destination = safeOutboundUrl(connection.samlSsoUrl, 'SSO URL');

  const state = generateToken(32);
  const samlRequestId = `_${generateToken(16)}`;

  await unscoped(() =>
    prisma.ssoLoginRequest.create({
      data: {
        // Set by hand from the connection: `unscoped()` disables the tenancy
        // extension's stamping, and the caller here is anonymous.
        orgId: connection.orgId,
        connectionId: connection.id,
        stateHash: hashToken(state),
        samlRequestId,
        redirectTo: safeRelativePath(req.query.next),
        ip: clientIp(req),
        expiresAt: new Date(Date.now() + SSO_REQUEST_TTL_MS),
      },
      select: { id: true },
    }),
  );

  const xml = authnRequestXml({
    id: samlRequestId,
    issueInstant: new Date(),
    destination: destination.href,
    issuer: spEntityId(env.API_PUBLIC_URL),
    acsUrl: spAcsUrl(env.API_PUBLIC_URL, connection.id),
  });

  // RAW deflate — no zlib header, no checksum. SAML bindings §3.4.4.1 says the
  // DEFLATE encoding of RFC 1951, and an IdP handed a zlib-wrapped stream
  // reports a malformed request with no clue as to why.
  destination.searchParams.set(
    'SAMLRequest',
    deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'),
  );
  /*
   * RelayState is the only thing the IdP hands back that identifies this
   * browser's in-flight login, so it is the same opaque single-use token the
   * OIDC leg calls `state`, stored the same way — hashed, and consumed by the
   * conditional update in `consumeState`.
   *
   * The binding caps RelayState at 80 bytes; `generateToken(32)` is 43
   * base64url characters, which fits with room to spare.
   */
  destination.searchParams.set('RelayState', state);

  res.redirect(302, destination.href);
}

// ─── Start ───────────────────────────────────────────────────────────────────

ssoRouter.get('/start/:connectionId', async (req, res) => {
  try {
    const connection = await loadConnection(String(req.params.connectionId));
    if (!connection) throw new SsoError('That single sign-on link is not valid.', 'CONFIG');
    await assertUsable(connection);

    if (connection.protocol === 'SAML') {
      await startSamlLogin(connection, req, res);
      return;
    }

    if (!connection.oidcIssuer || !connection.oidcClientId) {
      throw new SsoError('This connection is not finished — it has no issuer or client id.', 'CONFIG');
    }

    const endpoints = await endpointsFor(connection.oidcIssuer);
    const pkce = createPkce();
    const state = generateToken(32);
    const nonce = generateToken(32);

    const request = await unscoped(() =>
      prisma.ssoLoginRequest.create({
        data: {
          // Set by hand: `unscoped()` disables the extension's stamping, and
          // the orgId must come from the connection, never from the caller.
          orgId: connection.orgId,
          connectionId: connection.id,
          stateHash: hashToken(state),
          nonceHash: hashToken(nonce),
          redirectTo: safeRelativePath(req.query.next),
          ip: clientIp(req),
          expiresAt: new Date(Date.now() + SSO_REQUEST_TTL_MS),
        },
        select: { id: true },
      }),
    );

    // Sealed, not stored raw: a database read alone should not be enough to
    // complete an intercepted authorization code.
    const sealed = seal(pkce.verifier, connection.orgId, `sso:${request.id}:pkce`);
    await unscoped(() =>
      prisma.ssoLoginRequest.update({
        where: { id: request.id },
        data: { pkceVerifierEnc: sealed.ciphertext, keyVersion: sealed.keyVersion },
      }),
    );

    const scopes = ['openid', 'email', 'profile', ...connection.oidcScopes];
    const authorize = new URL(endpoints.authorizationEndpoint);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', connection.oidcClientId);
    authorize.searchParams.set('redirect_uri', redirectUri());
    authorize.searchParams.set('scope', [...new Set(scopes)].join(' '));
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', nonce);
    authorize.searchParams.set('code_challenge', pkce.challenge);
    authorize.searchParams.set('code_challenge_method', pkce.method);

    res.redirect(302, authorize.href);
  } catch (err) {
    failToLogin(res, err);
  }
});

// ─── OIDC callback ───────────────────────────────────────────────────────────

/**
 * Consume the state row, atomically.
 *
 * `updateMany` with `consumedAt: null` in the where clause is a compare-and-set
 * in one statement. Reading the row and then updating it would let two
 * concurrent callbacks both see `null` and both mint a session from one code.
 */
async function consumeState(state: string) {
  const stateHash = hashToken(state);
  const claimed = await unscoped(() =>
    prisma.ssoLoginRequest.updateMany({
      where: { stateHash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    }),
  );
  if (claimed.count !== 1) return null;

  return unscoped(() =>
    prisma.ssoLoginRequest.findUnique({
      where: { stateHash },
      select: {
        id: true,
        orgId: true,
        connectionId: true,
        nonceHash: true,
        samlRequestId: true,
        pkceVerifierEnc: true,
        keyVersion: true,
        redirectTo: true,
      },
    }),
  );
}

async function exchangeCode(
  connection: ConnectionRow,
  endpoints: OidcEndpoints,
  code: string,
  verifier: string,
): Promise<{ idToken: string; accessToken: string | null }> {
  const secret = connection.oidcClientSecretEnc
    ? vaultOpen(
        connection.oidcClientSecretEnc,
        connection.oidcKeyVersion ?? 1,
        connection.orgId,
        `sso:${connection.id}:client_secret`,
      )
    : null;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    client_id: connection.oidcClientId!,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (secret) {
    // RFC 6749 §2.3.1: basic is the default and must be supported; post is only
    // used when the provider says it prefers it. Both halves are form-url-
    // encoded before base64, which the spec requires and which matters for any
    // secret containing a reserved character.
    const prefersPost =
      endpoints.tokenAuthMethods.includes('client_secret_post') &&
      !endpoints.tokenAuthMethods.includes('client_secret_basic');
    if (prefersPost) {
      body.set('client_secret', secret);
    } else {
      const pair = `${encodeURIComponent(connection.oidcClientId!)}:${encodeURIComponent(secret)}`;
      headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
    }
  }

  const json = (await providerFetch(
    endpoints.tokenEndpoint,
    { method: 'POST', headers, body: body.toString() },
    'token endpoint',
  )) as { id_token?: unknown; access_token?: unknown } | null;

  const idToken = typeof json?.id_token === 'string' ? json.id_token : null;
  if (!idToken) {
    throw new SsoError(
      'Your identity provider did not return an ID token. Make sure the `openid` scope is allowed for this application.',
      'CONFIG',
    );
  }
  return {
    idToken,
    accessToken: typeof json?.access_token === 'string' ? json.access_token : null,
  };
}

ssoRouter.get('/oidc/callback', async (req, res) => {
  try {
    // A provider-reported failure. `error_description` is provider text and is
    // NOT echoed; the code is a fixed vocabulary and safe.
    const providerError = typeof req.query.error === 'string' ? req.query.error : null;
    if (providerError) {
      throw new SsoError(
        providerError === 'access_denied'
          ? 'Your identity provider declined that sign-in.'
          : 'Your identity provider reported an error during sign-in.',
        'AUTH',
      );
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code) throw new SsoError('That sign-in link is incomplete — try again.', 'AUTH');

    const request = await consumeState(state);
    // Covers unknown, expired and already-used state with one message: a
    // replayed callback must not be distinguishable from a stale one.
    if (!request) throw new SsoError('That sign-in has already been used or expired — try again.', 'AUTH');

    const connection = await loadConnection(request.connectionId);
    if (!connection) throw new SsoError('That single sign-on connection no longer exists.', 'CONFIG');
    await assertUsable(connection);
    if (connection.protocol !== 'OIDC' || !connection.oidcIssuer || !connection.oidcClientId) {
      throw new SsoError('That connection is not an OIDC connection.', 'CONFIG');
    }
    if (!request.pkceVerifierEnc) {
      throw new SsoError('That sign-in is missing its PKCE verifier — try again.', 'AUTH');
    }

    const verifier = vaultOpen(
      request.pkceVerifierEnc,
      request.keyVersion ?? 1,
      connection.orgId,
      `sso:${request.id}:pkce`,
    );

    const endpoints = await endpointsFor(connection.oidcIssuer);
    const { idToken, accessToken } = await exchangeCode(connection, endpoints, code, verifier);

    const parts = decodeJwt(idToken);
    // One forced JWKS refetch when the kid is unknown — providers rotate keys —
    // and the cooldown inside jwksFor() stops that being a lever on the IdP.
    let keys = await jwksFor(endpoints, false);
    let jwk: Jwk;
    try {
      jwk = selectJwk(keys, parts.header);
    } catch {
      keys = await jwksFor(endpoints, true);
      jwk = selectJwk(keys, parts.header);
    }

    if (!verifyJwtSignature(parts, jwk)) {
      throw new SsoError('That ID token’s signature is not valid.', 'AUTH');
    }

    // The nonce is stored hashed, so the comparison happens on hashes.
    const claimedNonce = typeof parts.payload.nonce === 'string' ? parts.payload.nonce : '';
    if (
      !claimedNonce ||
      !request.nonceHash ||
      !constantTimeEqual(hashToken(claimedNonce), request.nonceHash)
    ) {
      throw new SsoError('That sign-in could not be matched to this browser — try again.', 'AUTH');
    }

    const identity = validateIdTokenClaims(parts.payload, {
      issuer: connection.oidcIssuer,
      clientId: connection.oidcClientId,
      // Already compared against the stored hash above; passing the token's own
      // value here keeps validateIdTokenClaims's own check non-vacuous without
      // storing a second plaintext copy of the nonce.
      nonce: claimedNonce,
      now: new Date(),
    });

    let email = identity.email;
    let name = identity.name;
    if (!email && endpoints.userinfoEndpoint && accessToken) {
      // Some Okta and Ping configurations omit `email` from the ID token.
      const doc = await providerFetch(
        endpoints.userinfoEndpoint,
        { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } },
        'userinfo endpoint',
      );
      const fromUserinfo = identityFromUserinfo(doc, identity.subject);
      email = fromUserinfo.email;
      name = name ?? fromUserinfo.name;
    }

    const session = await provisionAndSignIn(
      connection,
      { email, name, subject: identity.subject },
      req,
    );

    res
      .setHeader('Set-Cookie', sessionCookie(session.raw, session.maxAge))
      .redirect(302, webUrl(safeRelativePath(request.redirectTo)));
  } catch (err) {
    failToLogin(res, err);
  }
});

// ─── SAML ────────────────────────────────────────────────────────────────────

/** SP metadata, for pasting into the IdP. Safe to serve without a verifier. */
ssoRouter.get('/saml/:connectionId/metadata', async (req, res) => {
  const connectionId = String(req.params.connectionId);
  const connection = await loadConnection(connectionId);
  if (!connection || connection.protocol !== 'SAML') throw notFound('Connection');

  res
    .setHeader('content-type', 'application/samlmetadata+xml; charset=utf-8')
    .send(spMetadataXml(spEntityId(env.API_PUBLIC_URL), spAcsUrl(env.API_PUBLIC_URL, connectionId)));
});

/**
 * The assertion consumer service.
 *
 * Reached two ways, and the difference matters for exactly one check. An
 * SP-initiated login arrives with the RelayState `startSamlLogin` minted, and
 * the assertion must answer the AuthnRequest that went with it. An
 * IdP-initiated login (the tile in someone's Okta dashboard) arrives with no
 * RelayState at all, and the assertion must then carry no `InResponseTo`
 * whatsoever — `checkSamlAssertion` enforces both directions.
 *
 * The trust decisions are elsewhere and stay elsewhere: the XML signature in
 * lib/saml-verifier.ts, every condition on the assertion in
 * `checkSamlAssertion`, replay in a unique index. This handler's own job is to
 * refuse before any of them when the connection is not configured to be
 * checkable, and to never turn a refusal into a page that echoes the
 * attacker's XML back at the user.
 */
ssoRouter.post('/saml/:connectionId/acs', async (req, res) => {
  try {
    const connection = await loadConnection(String(req.params.connectionId));
    if (!connection || connection.protocol !== 'SAML') throw notFound('Connection');
    await assertUsable(connection);

    const verifier = samlVerifier();
    if (!verifier) {
      /*
       * Fails CLOSED, and this branch stays here even though index.ts registers
       * a verifier at the composition root. It is the guarantee that signature
       * checking has no opt-out: there is no configuration, no environment
       * variable and no request parameter that reaches the code below without a
       * verifier having run. Deleting the registration turns SAML off; it does
       * not turn signature checking off.
       */
      throw new SsoError(
        'SAML sign-in is not available on this deployment. Use OIDC or password sign-in.',
        'CONFIG',
      );
    }

    /*
     * The trust anchors, checked here as well as in `startSamlLogin` because an
     * IdP-initiated login never passes through /sso/start at all — this is the
     * only gate it crosses. `verify()` would refuse an empty certificate list
     * too, but as an unverifiable-assertion error, which is the wrong sentence
     * for an administrator who simply has not pasted the certificate in yet.
     */
    if (!connection.samlIdpEntityId || connection.samlIdpCertsPem.length === 0) {
      throw new SsoError(
        'This SAML connection is not finished: it still needs the identity provider’s entity id and signing certificate before an assertion can be accepted.',
        'CONFIG',
      );
    }

    const encoded = typeof req.body?.SAMLResponse === 'string' ? req.body.SAMLResponse : '';
    if (!encoded) throw new SsoError('That sign-in response was empty — try again.', 'AUTH');
    // Bounded before decoding: an unauthenticated endpoint that base64-decodes
    // whatever it is handed is a memory-exhaustion target.
    if (encoded.length > 1_000_000) throw new SsoError('That sign-in response is too large.', 'AUTH');
    const xml = Buffer.from(encoded, 'base64').toString('utf8');

    const relayState = typeof req.body?.RelayState === 'string' ? req.body.RelayState : null;
    const claimed = relayState ? await consumeState(relayState) : null;
    /*
     * A RelayState is only in-flight for the connection that created it.
     *
     * Without this, a login started at one org's connection could have its
     * RelayState posted to another org's ACS, and `requestId` would then be a
     * value the attacker did not choose but also did not have to match against
     * anything of ours. Treating a foreign one as absent (rather than as an
     * error) is the conservative branch: it drops the flow into the
     * IdP-initiated rules, which REQUIRE the assertion to carry no InResponseTo
     * at all.
     */
    const pending = claimed && claimed.connectionId === connection.id ? claimed : null;

    // Throws unless the signature verified; the facts come back from inside the
    // signed subtree only (see the SamlAssertionFacts contract).
    let facts: SamlAssertionFacts;
    try {
      facts = verifier.verify(xml, connection.samlIdpCertsPem);
    } catch (err) {
      /*
       * Caught rather than left to `failToLogin`, for two reasons.
       *
       * The verifier's own messages interpolate values read out of the
       * attacker's XML — a transform URI, an element id — and this handler ends
       * in a redirect that puts its message into a query string on the login
       * page. Echoing it would be a reflection primitive on an unauthenticated
       * endpoint.
       *
       * And an unverifiable assertion is not a bug in QAAI, so it must not take
       * the `logger.error` branch that exists to surface ones that are. Warn,
       * audit, and say one sentence.
       */
      logger.warn(
        { err, connectionId: connection.id },
        'saml assertion failed signature verification',
      );
      await audit({
        actor: {
          userId: ANONYMOUS_ACTOR,
          orgId: connection.orgId,
          ip: clientIp(req),
          impersonatedBy: null,
        },
        action: 'sso.login_refused',
        targetType: 'SsoConnection',
        targetId: connection.id,
        metadata: { reason: 'the assertion signature did not verify' },
      });
      throw new SsoError(
        'That sign-in response could not be verified against this connection’s signing certificate.',
        'AUTH',
      );
    }

    const verdict = checkSamlAssertion(facts, {
      spEntityId: spEntityId(env.API_PUBLIC_URL),
      acsUrl: spAcsUrl(env.API_PUBLIC_URL, connection.id),
      idpEntityId: connection.samlIdpEntityId,
      /*
       * The AuthnRequest ID we generated — NOT the login request's row id.
       *
       * They are different values on purpose: the row id is a database key the
       * IdP has never seen, so requiring it as `InResponseTo` refused every
       * real SP-initiated assertion. `samlRequestId` is the value that actually
       * went out in the `<AuthnRequest>`.
       *
       * A `pending` row with no `samlRequestId` falls through to null, which
       * drops into the IdP-initiated rules — the strictly stricter branch,
       * because those require the assertion to carry no `InResponseTo` at all.
       */
      requestId: pending?.samlRequestId ?? null,
      now: new Date(),
    });
    if (!verdict.ok) {
      await audit({
        actor: { userId: ANONYMOUS_ACTOR, orgId: connection.orgId, ip: clientIp(req), impersonatedBy: null },
        action: 'sso.login_refused',
        targetType: 'SsoConnection',
        targetId: connection.id,
        metadata: { reason: verdict.reason },
      });
      throw new SsoError(`That sign-in was refused: ${verdict.reason}.`, 'AUTH');
    }

    /*
     * Replay guard. The UNIQUE index on (connectionId, assertionId) is the
     * enforcement — not this insert succeeding, but a second one failing. A
     * read-then-write would let two copies of the same assertion race.
     */
    try {
      await unscoped(() =>
        prisma.ssoAssertionSeen.create({
          data: {
            orgId: connection.orgId,
            connectionId: connection.id,
            assertionId: facts.id,
            expiresAt: facts.conditionsNotOnOrAfter ?? new Date(Date.now() + SSO_REQUEST_TTL_MS),
          },
        }),
      );
    } catch {
      throw new SsoError('That sign-in response has already been used.', 'AUTH');
    }

    const session = await provisionAndSignIn(
      connection,
      { email: samlEmail(facts), name: samlDisplayName(facts), subject: facts.nameId },
      req,
    );

    res
      .setHeader('Set-Cookie', sessionCookie(session.raw, session.maxAge))
      .redirect(302, webUrl(safeRelativePath(pending?.redirectTo)));
  } catch (err) {
    failToLogin(res, err);
  }
});

// ─── Admin: connections ──────────────────────────────────────────────────────

const adminRouter: Router = Router();
adminRouter.use(requireAuth, requireRole('ADMIN'));

/*
 * ── NO `requireScope` HERE, AND THAT IS A GAP RATHER THAN A DECISION ────────
 *
 * The six mutating routes below (connections ×3, domains ×3) check a ROLE and
 * no SCOPE, so an API key created for CI — which inherits its creator's role —
 * can point this org's single sign-on at an identity provider of its choosing,
 * or verify a domain. That is a full account-takeover primitive reached by a
 * key the customer believes is narrower than it is.
 *
 * It is not closed here because no member of `API_KEY_SCOPES` honestly names
 * it. The six members are `tests:read|write`, `runs:read|write`,
 * `secrets:write` and `git:push`, enumerated from the routes that already gate
 * on them; `secrets:write` is the only one that is even adjacent, and reaching
 * for it would mean a key labelled "may write my test credentials" could
 * reconfigure who may sign in to the organisation. The vocabulary exists
 * precisely to stop that kind of mislabelling, so the honest move is to leave
 * the routes role-gated and name the missing scope rather than to pick the
 * nearest word.
 *
 * THE EDIT THAT CLOSES IT is one member added to `API_KEY_SCOPES` in
 * packages/shared/src/constants.ts — a file this round's ownership puts
 * elsewhere — after which `requireScope('org:admin')` belongs on every route
 * below and on the eight org-administration routes in `routes/settings.ts`.
 * Written down here so the next reader knows the check is owed rather than
 * concluding it was considered and found unnecessary.
 */

/** The plan gate on the configuration surface. */
adminRouter.use(async (req, _res, next) => {
  const actor = actorOf(req);
  if (!(await hasFeature(actor.orgId, 'sso'))) {
    next(
      new ApiError(
        402,
        'PLAN_LIMIT',
        'Single sign-on is included with the Business and Enterprise plans.',
        { limit: 'sso', plan: 'BUSINESS' },
      ),
    );
    return;
  }
  next();
});

const connectionInput = z.object({
  name: z.string().min(1).max(80),
  // From @qaai/shared rather than repeated here, so `npm run check:enums` can
  // see it drift from `enum SsoProtocol` in schema.prisma.
  protocol: z.enum(SSO_PROTOCOLS),
  enabled: z.boolean().optional(),
  // OWNER is absent from this enum on purpose; clampJitRole enforces it again
  // at provisioning time, because one check on the write path is one check too
  // few for something that grants org control.
  defaultRole: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
  oidcIssuer: z.string().optional(),
  oidcClientId: z.string().max(255).optional(),
  oidcClientSecret: z.string().min(1).max(1024).optional(),
  oidcScopes: z.array(z.string().max(64)).max(10).optional(),
  samlIdpEntityId: z.string().max(1024).optional(),
  samlSsoUrl: z.string().optional(),
  samlIdpCertsPem: z.array(z.string().max(16_384)).max(5).optional(),
});

/** Never returns a secret — only whether one is stored. */
function present(row: {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  defaultRole: string;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecretEnc: string | null;
  oidcScopes: string[];
  samlIdpEntityId: string | null;
  samlSsoUrl: string | null;
  samlIdpCertsPem: string[];
  updatedAt: Date;
  domains?: Array<{ id: string; domain: string; verifiedAt: Date | null; verificationToken: string }>;
}) {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    enabled: row.enabled,
    defaultRole: row.defaultRole,
    oidcIssuer: row.oidcIssuer,
    oidcClientId: row.oidcClientId,
    hasClientSecret: row.oidcClientSecretEnc !== null,
    oidcScopes: row.oidcScopes,
    samlIdpEntityId: row.samlIdpEntityId,
    samlSsoUrl: row.samlSsoUrl,
    samlCertificateCount: row.samlIdpCertsPem.length,
    acsUrl: spAcsUrl(env.API_PUBLIC_URL, row.id),
    spEntityId: spEntityId(env.API_PUBLIC_URL),
    metadataUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/sso/saml/${row.id}/metadata`,
    redirectUri: redirectUri(),
    updatedAt: row.updatedAt,
    domains: (row.domains ?? []).map((d) => ({
      id: d.id,
      domain: d.domain,
      verified: d.verifiedAt !== null,
      recordHost: domainVerificationHost(d.domain),
      recordValue: domainVerificationRecord(d.verificationToken),
    })),
  };
}

const CONNECTION_SELECT = {
  id: true,
  name: true,
  protocol: true,
  enabled: true,
  defaultRole: true,
  oidcIssuer: true,
  oidcClientId: true,
  oidcClientSecretEnc: true,
  oidcScopes: true,
  samlIdpEntityId: true,
  samlSsoUrl: true,
  samlIdpCertsPem: true,
  updatedAt: true,
  domains: {
    select: { id: true, domain: true, verifiedAt: true, verificationToken: true },
    orderBy: { domain: 'asc' },
  },
} as const;

adminRouter.get('/connections', async (_req, res) => {
  const rows = await prisma.ssoConnection.findMany({
    orderBy: { createdAt: 'asc' },
    select: CONNECTION_SELECT,
  });
  res.json({ connections: rows.map(present), samlAvailable: samlVerifier() !== null });
});

/** Validates the protocol-specific half and returns the columns to write. */
function connectionFields(
  input: Partial<z.infer<typeof connectionInput>> & { protocol: 'OIDC' | 'SAML' },
) {
  const data: Record<string, unknown> = {};
  if (input.protocol === 'OIDC') {
    if (input.oidcIssuer !== undefined) data.oidcIssuer = normalizeIssuer(input.oidcIssuer);
    if (input.oidcClientId !== undefined) data.oidcClientId = input.oidcClientId.trim();
    if (input.oidcScopes !== undefined) data.oidcScopes = input.oidcScopes;
  } else {
    if (input.samlIdpEntityId !== undefined) data.samlIdpEntityId = input.samlIdpEntityId.trim();
    if (input.samlSsoUrl !== undefined) data.samlSsoUrl = safeOutboundUrl(input.samlSsoUrl, 'SSO URL').href;
    if (input.samlIdpCertsPem !== undefined) {
      // Shape-checked only. Whether a certificate is TRUSTED is decided by the
      // verifier, which does not exist yet — storing one grants nothing.
      for (const pem of input.samlIdpCertsPem) {
        if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
          throw badRequest('Each IdP certificate must be PEM, starting with -----BEGIN CERTIFICATE-----');
        }
      }
      data.samlIdpCertsPem = input.samlIdpCertsPem;
    }
  }
  return data;
}

adminRouter.post('/connections', async (req, res) => {
  const actor = actorOf(req);
  const input = connectionInput.parse(req.body);

  const created = await prisma.ssoConnection.create({
    data: {
      // Stamped by the tenancy extension too, but written explicitly for the
      // same reason every other route does: the types require it, and a create
      // whose orgId is invisible in the source is one nobody can review.
      orgId: actor.orgId,
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled ?? true,
      defaultRole: clampJitRole(input.defaultRole ?? 'MEMBER'),
      ...connectionFields(input),
    },
    select: CONNECTION_SELECT,
  });

  if (input.oidcClientSecret) {
    const sealed = seal(input.oidcClientSecret, actor.orgId, `sso:${created.id}:client_secret`);
    await prisma.ssoConnection.update({
      where: { id: created.id },
      data: { oidcClientSecretEnc: sealed.ciphertext, oidcKeyVersion: sealed.keyVersion },
    });
  }

  await audit({
    actor,
    action: 'sso.connection.create',
    targetType: 'SsoConnection',
    targetId: created.id,
    // The secret is never in the metadata; audit() masks too, but not relying
    // on that is the habit that keeps it out of logs.
    metadata: { name: input.name, protocol: input.protocol },
  });

  const row = await prisma.ssoConnection.findUniqueOrThrow({
    where: { id: created.id },
    select: CONNECTION_SELECT,
  });
  res.status(201).json(present(row));
});

adminRouter.patch('/connections/:id', async (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.id);
  const input = connectionInput.partial({ name: true, protocol: true }).parse(req.body);

  const current = await prisma.ssoConnection.findUnique({ where: { id }, select: { protocol: true } });
  if (!current) throw notFound('Connection');

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.defaultRole !== undefined) data.defaultRole = clampJitRole(input.defaultRole);
  // The stored protocol wins over anything in the body: a connection cannot be
  // flipped from SAML to OIDC by a PATCH, because that would leave the fields
  // of the old protocol in place and half-configured.
  Object.assign(data, connectionFields({ ...input, protocol: current.protocol }));

  if (input.oidcClientSecret) {
    const sealed = seal(input.oidcClientSecret, actor.orgId, `sso:${id}:client_secret`);
    data.oidcClientSecretEnc = sealed.ciphertext;
    data.oidcKeyVersion = sealed.keyVersion;
  }

  await prisma.ssoConnection.update({ where: { id }, data });
  // Config changed: drop the cached discovery so a corrected issuer takes
  // effect on the next login instead of an hour later.
  discoveryCache.clear();

  await audit({
    actor,
    action: 'sso.connection.update',
    targetType: 'SsoConnection',
    targetId: id,
    metadata: { fields: Object.keys(data).filter((k) => k !== 'oidcClientSecretEnc') },
  });

  const row = await prisma.ssoConnection.findUniqueOrThrow({ where: { id }, select: CONNECTION_SELECT });
  res.json(present(row));
});

adminRouter.delete('/connections/:id', async (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.id);
  const existing = await prisma.ssoConnection.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Connection');

  await prisma.ssoConnection.delete({ where: { id } });
  await audit({ actor, action: 'sso.connection.delete', targetType: 'SsoConnection', targetId: id });
  res.json({ ok: true });
});

// ─── Admin: domains ──────────────────────────────────────────────────────────

adminRouter.post('/connections/:id/domains', async (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.id);
  const input = z.object({ domain: z.string().min(3).max(253) }).parse(req.body);
  const domain = normalizeDomain(input.domain);

  const connection = await prisma.ssoConnection.findUnique({ where: { id }, select: { id: true } });
  if (!connection) throw notFound('Connection');

  /*
   * The UNIQUE index on `domain` is global, and the conflict below is the
   * user-facing half of it. Two orgs cannot both claim acme.com, because the
   * second claim is what would let one of them assert the other's people.
   *
   * The message deliberately does not say WHICH org holds it — that would turn
   * this into a directory of who uses QAAI.
   */
  const taken = await unscoped(() =>
    prisma.ssoDomain.findUnique({ where: { domain }, select: { orgId: true } }),
  );
  if (taken) {
    throw conflict(
      taken.orgId === actor.orgId
        ? 'That domain is already on this organization.'
        : 'That domain is already claimed. Contact support if it belongs to you.',
    );
  }

  const created = await prisma.ssoDomain.create({
    data: { orgId: actor.orgId, connectionId: id, domain, verificationToken: generateToken(16) },
    select: { id: true, domain: true, verificationToken: true, verifiedAt: true },
  });

  await audit({
    actor,
    action: 'sso.domain.add',
    targetType: 'SsoDomain',
    targetId: created.id,
    metadata: { domain },
  });

  res.status(201).json({
    id: created.id,
    domain: created.domain,
    verified: false,
    recordHost: domainVerificationHost(created.domain),
    recordValue: domainVerificationRecord(created.verificationToken),
  });
});

/**
 * Prove ownership of a domain by DNS TXT record.
 *
 * This is the gate everything else rests on, so it is a real DNS lookup and not
 * an admin toggle: the API server asks the public resolver for
 * `_qaai-verify.<domain>` and requires the exact token back. An org that cannot
 * publish that record does not control the domain.
 */
adminRouter.post('/domains/:id/verify', async (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.id);

  const row = await prisma.ssoDomain.findUnique({
    where: { id },
    select: { id: true, domain: true, verificationToken: true, verifiedAt: true },
  });
  if (!row) throw notFound('Domain');
  if (row.verifiedAt) {
    res.json({ id: row.id, domain: row.domain, verified: true });
    return;
  }

  const host = domainVerificationHost(row.domain);
  let records: string[];
  try {
    // resolveTxt returns chunks per record; a long value is split at 255 bytes
    // and must be rejoined before comparing.
    const chunks = await Promise.race([
      dns.resolveTxt(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS).unref(),
      ),
    ]);
    records = chunks.map((parts) => parts.join(''));
  } catch {
    // A missing record and a broken resolver are the same message on purpose:
    // both mean "not proved", and the fix starts in the same place.
    throw badRequest(
      `No TXT record found at ${host}. Publish "${domainVerificationRecord(row.verificationToken)}" there, then try again — DNS can take a few minutes to propagate.`,
    );
  }

  if (!txtRecordsProveOwnership(records, row.verificationToken)) {
    throw badRequest(
      `The TXT record at ${host} does not match. It must be exactly "${domainVerificationRecord(row.verificationToken)}".`,
    );
  }

  await prisma.ssoDomain.update({ where: { id }, data: { verifiedAt: new Date() } });
  await audit({
    actor,
    action: 'sso.domain.verify',
    targetType: 'SsoDomain',
    targetId: id,
    metadata: { domain: row.domain },
  });

  res.json({ id: row.id, domain: row.domain, verified: true });
});

adminRouter.delete('/domains/:id', async (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.id);
  const row = await prisma.ssoDomain.findUnique({ where: { id }, select: { domain: true } });
  if (!row) throw notFound('Domain');

  await prisma.ssoDomain.delete({ where: { id } });
  await audit({
    actor,
    action: 'sso.domain.remove',
    targetType: 'SsoDomain',
    targetId: id,
    metadata: { domain: row.domain },
  });
  res.json({ ok: true });
});

ssoRouter.use(adminRouter);

/**
 * Sweeps expired login requests and replay rows.
 *
 * Exported rather than scheduled here: the worker owns cron in this codebase.
 * Neither table is load-bearing once expired — a stale login request is already
 * refused on `expiresAt`, and a stale assertion row guards an assertion that
 * would fail its own NotOnOrAfter — so this is hygiene, not correctness.
 */
export async function sweepSsoState(): Promise<{ requests: number; assertions: number }> {
  const now = new Date();
  const [requests, assertions] = await Promise.all([
    unscoped(() => prisma.ssoLoginRequest.deleteMany({ where: { expiresAt: { lt: now } } })),
    unscoped(() => prisma.ssoAssertionSeen.deleteMany({ where: { expiresAt: { lt: now } } })),
  ]);
  return { requests: requests.count, assertions: assertions.count };
}
