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
 */

import { Router } from 'express';
// NOT `Response`: Express's Response type would shadow the global fetch
// Response used in providerFetch, and the shadowing error is confusing enough
// that it is worth naming here.
import type { Request } from 'express';
import { promises as dns } from 'node:dns';
import { z } from 'zod';
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
  REQUEST_TIMEOUT_MS,
  txtRecordsProveOwnership,
  validateIdTokenClaims,
  verifyJwtSignature,
  type Jwk,
  type OidcEndpoints,
} from '../lib/sso.js';

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
 * One request to a provider, with the two rules lib/issues.ts exists to state:
 * a 3xx is an error rather than a hop (following one re-sends the client secret
 * to whatever Location names), and a provider that has not answered in
 * REQUEST_TIMEOUT_MS is not going to.
 *
 * The URL is re-validated here even though the caller already validated it —
 * this is the last point before bytes leave the process, and a second check
 * costs nothing.
 */
async function providerFetch(
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  what: string,
): Promise<unknown> {
  safeOutboundUrl(url, what);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { accept: 'application/json', 'user-agent': 'qaai', ...(init.headers ?? {}) },
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'was unreachable';
    throw new SsoError(`Your identity provider ${reason}. Try signing in again.`, 'CONFIG');
  }

  if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
    throw new SsoError(
      'Your identity provider answered with a redirect, and QAAI will not follow one while holding a client secret. Check the issuer URL on the connection.',
      'CONFIG',
    );
  }

  // Read as text and parse defensively: an error page is usually HTML, and the
  // body is never logged or echoed — it can contain the token we just asked for.
  let json: unknown = null;
  try {
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (response.status >= 400) {
    throw new SsoError(
      `Your identity provider refused the request (${response.status}). Check the client id and secret on the connection.`,
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
      select: { id: true, name: true },
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
        // The IdP asserted it and we proved the domain, so it is verified in
        // the only sense this column means.
        emailVerified: new Date(),
      },
      select: { id: true, name: true },
    });
  });

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

  res.json({
    available: true,
    connectionId: row.connection.id,
    protocol: row.connection.protocol,
    startUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/sso/start/${row.connection.id}`,
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

ssoRouter.get('/start/:connectionId', async (req, res) => {
  try {
    const connection = await loadConnection(String(req.params.connectionId));
    if (!connection) throw new SsoError('That single sign-on link is not valid.', 'CONFIG');
    await assertUsable(connection);

    if (connection.protocol === 'SAML') {
      // Everything up to here works; the assertion coming back is what we
      // cannot check. Refusing at the start is kinder than sending someone to
      // their IdP and rejecting them on the way home.
      throw new SsoError(
        'SAML sign-in is not available on this deployment. Use OIDC or password sign-in.',
        'CONFIG',
      );
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
 * Every check this endpoint would run is written and tested in lib/sso.ts —
 * `checkSamlAssertion` covers signature wrapping (via the verifier contract),
 * unsigned assertions, Destination, Recipient, Audience, InResponseTo,
 * NotBefore/NotOnOrAfter, and the replay table below is ready for the assertion
 * id. What is missing is the one thing that cannot be written safely here: the
 * XML signature check itself.
 *
 * So this refuses, loudly, with an actionable sentence — and the code path that
 * would run afterwards is left in place, unreachable but reviewable, so whoever
 * installs the dependency can see exactly what they are wiring into.
 */
ssoRouter.post('/saml/:connectionId/acs', async (req, res) => {
  try {
    const connection = await loadConnection(String(req.params.connectionId));
    if (!connection || connection.protocol !== 'SAML') throw notFound('Connection');
    await assertUsable(connection);

    const verifier = samlVerifier();
    if (!verifier) {
      // Fails CLOSED. See the file header for why this is the one place the
      // "skip, never fail" rule does not apply.
      throw new SsoError(
        'SAML sign-in is not available on this deployment. Use OIDC or password sign-in.',
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
    const facts = verifier.verify(xml, connection.samlIdpCertsPem);

    const verdict = checkSamlAssertion(facts, {
      spEntityId: spEntityId(env.API_PUBLIC_URL),
      acsUrl: spAcsUrl(env.API_PUBLIC_URL, connection.id),
      idpEntityId: connection.samlIdpEntityId ?? '',
      requestId: pending?.id ?? null,
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
