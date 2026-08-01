/**
 * SSO — SAML 2.0 and OIDC. The pure half: everything that decides whether an
 * assertion is trustworthy, with no database and no Express in it, so all of it
 * is reachable from `sso.test.ts`.
 *
 * ─── Threat model ────────────────────────────────────────────────────────────
 *
 * This is an authentication boundary, and it has a sharper edge than most
 * because of two facts about the rest of this codebase:
 *
 *   1. `User` is GLOBAL (see GLOBAL_MODELS in lib/prisma.ts). One row per email
 *      address, shared by every org that person belongs to.
 *   2. `POST /auth/switch-org` lets a session move into any org the user is a
 *      member of, without re-authenticating.
 *
 * Put those together and an IdP that can name an arbitrary email address does
 * not merely get into its own org — it gets a session for that human, and can
 * then switch into every other org they belong to. So the question this module
 * has to answer is never "did the IdP sign this?" alone. It is "is this IdP
 * entitled to speak for this email address?", and the only acceptable answer is
 * a domain whose DNS ownership was proved (SsoDomain.verifiedAt) and which is
 * unique across the whole table. `assertedEmailIsInScope()` is that check, and
 * it runs on both protocols.
 *
 * The other rules, each of which is a real published attack:
 *
 *   - `alg` is chosen by US, from an allowlist, never by the token. `none` and
 *     every HS* variant are refused: HS256 against a JWKS is the key-confusion
 *     attack where the attacker signs with the public key as the HMAC secret.
 *   - ECDSA JWS signatures are raw r‖s, not DER. Verified with
 *     `dsaEncoding: 'ieee-p1363'`; without it Node reads the concatenation as
 *     DER, and the practical effect is a verifier that rejects real tokens and
 *     whoever fixes it in a hurry reaches for `try { } catch { return true }`.
 *   - Every outbound host is pinned to the configured issuer (see
 *     ISSUER_ALLOWED_HOSTS), because the client secret travels to the token
 *     endpoint and the discovery document is the thing naming that endpoint.
 *     lib/issues.ts is the reference implementation and the rules are the same:
 *     https only, no embedded credentials, no IP literal, no internal name,
 *     trailing dot stripped BEFORE any check, and never follow a redirect.
 *   - Nonce, state and PKCE are all single-use and compared in constant time.
 *
 * ─── SAML, honestly ──────────────────────────────────────────────────────────
 *
 * The condition checks are all here and all tested (`checkSamlAssertion`). The
 * XML signature check is NOT, and cannot be: verifying one correctly needs
 * exclusive canonicalisation (exc-c14n) and an XXE-hardened parser, which is a
 * dependency this workspace does not have and which this change is not allowed
 * to add. Rather than ship a hand-rolled parser that looks like it validates,
 * the signature step is a port (`SamlSignatureVerifier`) with no registered
 * implementation, and the ACS route refuses every assertion with an actionable
 * sentence until one is registered. See SAML_UNAVAILABLE.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
  constants as cryptoConstants,
  type KeyObject,
} from 'node:crypto';

export const SSO_PROTOCOLS = ['SAML', 'OIDC'] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

/**
 * Carries a message that is already safe to put in front of a user or a
 * redirect query string: written here, never interpolated from a provider
 * response, and never containing a secret.
 */
export class SsoError extends Error {
  constructor(
    message: string,
    /** CONFIG = the org's connection is wrong. AUTH = the assertion is not acceptable. */
    readonly kind: 'CONFIG' | 'AUTH' = 'AUTH',
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

/** An in-flight login is worth ten minutes. Long enough for an MFA prompt. */
export const SSO_REQUEST_TTL_MS = 10 * 60_000;

/** Tolerance for a badly-synchronised IdP clock, both directions. */
export const CLOCK_SKEW_SECONDS = 60;

/** Neither provider needs longer than this to answer a back-channel call. */
export const REQUEST_TIMEOUT_MS = 10_000;

// ─── Constant-time comparison ────────────────────────────────────────────────

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Hashing first is not decoration: `timingSafeEqual` throws on a length
 * mismatch, and a naive length pre-check leaks the length of the expected
 * value. Both sides become 32 bytes, so the comparison is always performed.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * Normalise a domain for storage and lookup.
 *
 * The trailing dot is stripped first, for the same reason it is stripped in
 * lib/issues.ts: `acme.com.` and `acme.com` resolve identically, so leaving one
 * in would let the same domain be claimed twice under a UNIQUE index that is
 * supposed to make that impossible.
 */
export function normalizeDomain(input: string): string {
  const raw = input.trim().toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
  if (!raw) throw new SsoError('A domain is required.', 'CONFIG');
  if (raw.includes('/') || raw.includes(':') || raw.includes('@')) {
    throw new SsoError(`"${input}" is not a domain — use just the part after the @.`, 'CONFIG');
  }
  // A single label ("localhost", "intranet") is never a real email domain and
  // is exactly the shape an operator typo takes.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(raw)) {
    throw new SsoError(`"${input}" is not a valid email domain.`, 'CONFIG');
  }
  if (raw.length > 253) throw new SsoError('That domain is too long.', 'CONFIG');
  return raw;
}

/**
 * The domain half of an email address, normalised.
 *
 * Deliberately strict about a single `@`: an address like `a@b@evil.com` is
 * accepted by some parsers as domain `b` and by others as `evil.com`, and a
 * disagreement between the two is how a domain check gets bypassed.
 */
export function emailDomain(email: string): string {
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new SsoError('That is not an email address.', 'AUTH');
  }
  return normalizeDomain(parts[1]);
}

/**
 * Is this connection entitled to speak for this address?
 *
 * The whole cross-tenant story hangs off this function — see the threat model
 * at the top. `verifiedDomains` must contain ONLY rows whose `verifiedAt` is
 * set; the caller filters, and the test asserts the caller's query does.
 */
export function assertedEmailIsInScope(email: string, verifiedDomains: string[]): boolean {
  let domain: string;
  try {
    domain = emailDomain(email);
  } catch {
    return false;
  }
  // Exact match only. Subdomain matching looks helpful and is not: proving
  // `acme.com` would silently confer `anything.acme.com`, including a subdomain
  // delegated to a third party.
  return verifiedDomains.some((d) => d === domain);
}

/** The TXT record we look for, and where. */
export const DOMAIN_VERIFICATION_PREFIX = 'qaai-domain-verification=';
export const domainVerificationHost = (domain: string) => `_qaai-verify.${domain}`;
export const domainVerificationRecord = (token: string) =>
  `${DOMAIN_VERIFICATION_PREFIX}${token}`;

/** Matches a published TXT record against the expected token, in constant time. */
export function txtRecordsProveOwnership(records: string[], token: string): boolean {
  const expected = domainVerificationRecord(token);
  // `some` short-circuits, but each individual comparison is still constant
  // time; the observable variation is the number of records, which is public.
  return records.some((r) => constantTimeEqual(r.trim(), expected));
}

// ─── Roles ───────────────────────────────────────────────────────────────────

export type JitRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

/**
 * The roles JIT provisioning is allowed to grant.
 *
 * OWNER is absent on purpose and is enforced twice — when the connection is
 * configured and again when a member is created. An org's IdP administrator is
 * not necessarily its billing owner, and an assertion must never be able to
 * produce someone who can delete the organisation.
 */
export function clampJitRole(role: string): JitRole {
  return role === 'ADMIN' || role === 'VIEWER' ? role : 'MEMBER';
}

// ─── Redirect targets ────────────────────────────────────────────────────────

/**
 * Where the callback is allowed to send the browser.
 *
 * Only a path on our own origin, and the checks are ordered so the cheap
 * lookalikes die first: `//evil.com` is a protocol-relative URL that a browser
 * treats as absolute, and `/\evil.com` is the same trick with the slash that
 * several parsers normalise. Anything unrecognised becomes the default rather
 * than an error — a bad `next` is not a reason to fail a login.
 */
export function safeRelativePath(next: unknown, fallback = '/runs'): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  // A control character can truncate a Location header.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}

// ─── Outbound URL safety ─────────────────────────────────────────────────────

/**
 * Names that resolve inside a private network. Copied from lib/issues.ts rather
 * than imported, because that module's copy is documented as the reference for
 * a token-carrying request and the two lists must be allowed to diverge only
 * deliberately. If you add an entry here, add it there too.
 */
const INTERNAL_HOST =
  /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.intranet|.+\.lan|.+\.corp|.+\.private|.+\.svc|.+\.cluster\.local|.+\.home\.arpa)$/i;

/**
 * Hosts an issuer is permitted to name in its discovery document, beyond its
 * own host.
 *
 * The default rule is strict equality with the issuer's host — that is what
 * "pin every outbound host per provider" means here, and Okta, Auth0, Entra ID,
 * Ping and every self-hosted Keycloak satisfy it. Google is the one large
 * provider that does not: it serves tokens from oauth2.googleapis.com and keys
 * from www.googleapis.com while calling itself accounts.google.com. Adding an
 * entry is therefore a deliberate, reviewed act and not a config knob — a
 * customer cannot widen this by editing their connection.
 */
const ISSUER_ALLOWED_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'https://accounts.google.com': ['oauth2.googleapis.com', 'www.googleapis.com', 'openidconnect.googleapis.com'],
};

/**
 * Validate a URL we are about to send a request to, and return it normalised.
 *
 * Same rules as `jiraSite()` in lib/issues.ts, for the same reason: the token
 * endpoint call carries the org's client secret. The trailing dot is removed
 * before every check and the NORMALISED host is what comes back, so a dot
 * cannot survive validation and be re-attached to the request.
 */
export function safeOutboundUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Never echoes `raw`: an unparseable value is where a pasted
    // `https://user:secret@host/x` ends up.
    throw new SsoError(`That ${what} could not be parsed as a URL.`, 'CONFIG');
  }

  if (url.protocol !== 'https:') {
    throw new SsoError(`A ${what} must be https — a client secret travels to it.`, 'CONFIG');
  }
  if (url.username || url.password) {
    throw new SsoError(
      `Remove the credentials from the ${what} — the client secret is stored separately.`,
      'CONFIG',
    );
  }
  if (url.port && url.port !== '443') {
    throw new SsoError(`A ${what} must use the default https port.`, 'CONFIG');
  }

  const host = url.hostname.replace(/\.+$/, '');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral || INTERNAL_HOST.test(host) || !host.includes('.')) {
    throw new SsoError(`Refusing to send a request to ${host}: use a public hostname.`, 'CONFIG');
  }
  if (url.pathname.includes('..')) {
    throw new SsoError(`That ${what} is not valid.`, 'CONFIG');
  }

  const normalised = new URL(url.href);
  normalised.hostname = host;
  return normalised;
}

/**
 * Normalise an issuer for storage. Kept as the exact string an ID token's `iss`
 * must equal, so the only normalisation is the trailing slash — which providers
 * are inconsistent about and which is not part of the identity.
 */
export function normalizeIssuer(raw: string): string {
  const url = safeOutboundUrl(raw, 'issuer URL');
  if (url.search || url.hash) {
    throw new SsoError('An issuer URL must not have a query string or fragment.', 'CONFIG');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `https://${url.hostname}${path}`;
}

/**
 * The discovery document URL, derived from the issuer and nothing else.
 *
 * This is the pin the brief asks for: there is no configurable discovery URL,
 * because a configurable one is a hole through every other host check below —
 * point it at a server you control and it will name whatever endpoints it likes.
 */
export function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/** True when `url` is a host this issuer is allowed to name. */
export function hostIsPinnedToIssuer(issuer: string, url: URL): boolean {
  const issuerHost = new URL(normalizeIssuer(issuer)).hostname;
  if (url.hostname === issuerHost) return true;
  return (ISSUER_ALLOWED_HOSTS[normalizeIssuer(issuer)] ?? []).includes(url.hostname);
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  /** From `token_endpoint_auth_methods_supported`; empty means "unstated". */
  tokenAuthMethods: string[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read a discovery document into the four URLs we use, refusing anything that
 * is not on a pinned host.
 *
 * The `issuer` equality check is required by OIDC Discovery §4.3 and is the
 * reason it is safe to treat the rest of the document as authoritative: a
 * document that claims to be someone else's is a mix-up attack in progress.
 */
export function parseDiscovery(configuredIssuer: string, doc: unknown): OidcEndpoints {
  const issuer = normalizeIssuer(configuredIssuer);
  const d = (doc ?? {}) as Record<string, unknown>;

  const advertised = str(d.issuer);
  if (!advertised) {
    throw new SsoError('That provider’s discovery document has no `issuer`.', 'CONFIG');
  }
  // Compared after the same trailing-slash normalisation applied to the stored
  // value, and by exact string match on everything else.
  if (advertised.replace(/\/+$/, '') !== issuer) {
    throw new SsoError(
      `That provider’s discovery document is issued by a different issuer than the one configured. Set the issuer to exactly what the provider publishes.`,
      'CONFIG',
    );
  }

  const endpoint = (key: string, label: string, required: boolean): string | null => {
    const value = str(d[key]);
    if (!value) {
      if (!required) return null;
      throw new SsoError(`That provider’s discovery document has no \`${key}\`.`, 'CONFIG');
    }
    const url = safeOutboundUrl(value, label);
    if (!hostIsPinnedToIssuer(issuer, url)) {
      throw new SsoError(
        `That provider’s ${label} is on ${url.hostname}, which is not the issuer’s host. QAAI will not send a request there.`,
        'CONFIG',
      );
    }
    return url.href;
  };

  return {
    issuer,
    authorizationEndpoint: endpoint('authorization_endpoint', 'authorization endpoint', true)!,
    tokenEndpoint: endpoint('token_endpoint', 'token endpoint', true)!,
    jwksUri: endpoint('jwks_uri', 'JWKS URL', true)!,
    userinfoEndpoint: endpoint('userinfo_endpoint', 'userinfo endpoint', false),
    tokenAuthMethods: Array.isArray(d.token_endpoint_auth_methods_supported)
      ? d.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
      : [],
  };
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * PKCE, S256 only.
 *
 * `plain` is deliberately not implemented. It is still in RFC 7636 and it is
 * worthless — the "challenge" is the verifier, so anyone who can see the
 * authorization request can complete the exchange.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars, RFC 7636 §4.1
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    method: 'S256',
  };
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

/** The signature algorithms we accept, and how each maps onto node:crypto. */
const JWS_ALGORITHMS = {
  RS256: { hash: 'sha256', kty: 'RSA', padding: 'pkcs1' },
  RS384: { hash: 'sha384', kty: 'RSA', padding: 'pkcs1' },
  RS512: { hash: 'sha512', kty: 'RSA', padding: 'pkcs1' },
  PS256: { hash: 'sha256', kty: 'RSA', padding: 'pss', saltLength: 32 },
  PS384: { hash: 'sha384', kty: 'RSA', padding: 'pss', saltLength: 48 },
  PS512: { hash: 'sha512', kty: 'RSA', padding: 'pss', saltLength: 64 },
  ES256: { hash: 'sha256', kty: 'EC', crv: 'P-256' },
  ES384: { hash: 'sha384', kty: 'EC', crv: 'P-384' },
  ES512: { hash: 'sha512', kty: 'EC', crv: 'P-521' },
} as const;

export type JwsAlgorithm = keyof typeof JWS_ALGORITHMS;

export function isSupportedAlgorithm(alg: unknown): alg is JwsAlgorithm {
  return typeof alg === 'string' && alg in JWS_ALGORITHMS;
}

/** RSA below this is not a key, it is a formality. */
const MIN_RSA_MODULUS_BITS = 2048;

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** The exact `header.payload` bytes as received — what the signature covers. */
  signingInput: string;
  signature: Buffer;
}

/**
 * Strict base64url decode.
 *
 * `Buffer.from(s, 'base64url')` is lenient: it ignores characters outside the
 * alphabet and tolerates padding, so two different token strings can decode to
 * the same bytes. That is a signature-bypass primitive — the signature covers
 * the string, the claims come from the bytes — so the charset is checked first
 * and the decode is required to round-trip.
 */
function decodeSegment(segment: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new SsoError(`The ID token’s ${what} is not valid base64url.`, 'AUTH');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) {
    throw new SsoError(`The ID token’s ${what} is not canonically encoded.`, 'AUTH');
  }
  return bytes;
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(segment, what).toString('utf8'));
  } catch {
    throw new SsoError(`The ID token’s ${what} is not JSON.`, 'AUTH');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SsoError(`The ID token’s ${what} is not a JSON object.`, 'AUTH');
  }
  return parsed as Record<string, unknown>;
}

/** Splits a compact JWS. Rejects anything that is not exactly three segments. */
export function decodeJwt(token: string): JwtParts {
  const segments = token.split('.');
  // Five segments is a JWE, which we do not accept: an encrypted ID token that
  // we cannot decrypt must not be silently treated as an unsigned one.
  if (segments.length !== 3) {
    throw new SsoError('That ID token is not a signed JWT.', 'AUTH');
  }
  const [h, p, s] = segments as [string, string, string];
  return {
    header: decodeJson(h, 'header'),
    payload: decodeJson(p, 'payload'),
    signingInput: `${h}.${p}`,
    signature: decodeSegment(s, 'signature'),
  };
}

export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  crv?: string;
  key_ops?: string[];
  [key: string]: unknown;
}

/**
 * Pick the key that signed this token.
 *
 * Selection is by `kid` when the token has one. Without a `kid`, exactly one
 * candidate must remain after filtering by algorithm family — "try them all"
 * is how a verifier ends up accepting a signature from a key the IdP publishes
 * for encryption.
 */
export function selectJwk(keys: Jwk[], header: Record<string, unknown>): Jwk {
  const alg = header.alg;
  if (!isSupportedAlgorithm(alg)) {
    throw new SsoError(
      `That ID token is signed with "${String(alg).slice(0, 20)}", which QAAI does not accept.`,
      'AUTH',
    );
  }
  const spec = JWS_ALGORITHMS[alg];

  const usable = keys.filter((k) => {
    if (k.kty !== spec.kty) return false;
    if (k.use && k.use !== 'sig') return false;
    if (k.key_ops && !k.key_ops.includes('verify')) return false;
    // A key that names its own algorithm must agree with the header.
    if (k.alg && k.alg !== alg) return false;
    if ('crv' in spec && k.crv !== spec.crv) return false;
    return true;
  });

  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (kid) {
    const match = usable.find((k) => k.kid === kid);
    if (!match) {
      throw new SsoError('That ID token was signed with a key the provider does not publish.', 'AUTH');
    }
    return match;
  }

  if (usable.length !== 1) {
    throw new SsoError(
      'That ID token has no key id, and the provider publishes more than one usable key.',
      'AUTH',
    );
  }
  return usable[0]!;
}

function publicKeyFromJwk(jwk: Jwk): KeyObject {
  let key: KeyObject;
  try {
    // `jwk` is an index-signature bag by design — the JWKS is provider JSON and
    // is not trusted to have any particular shape. Node validates the members
    // it needs and throws on anything it cannot read, which is the check here.
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new SsoError('That provider published a key QAAI could not read.', 'CONFIG');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType === 'rsa' && typeof bits === 'number' && bits < MIN_RSA_MODULUS_BITS) {
    throw new SsoError(
      `That provider’s signing key is ${bits}-bit RSA. QAAI requires at least ${MIN_RSA_MODULUS_BITS}.`,
      'CONFIG',
    );
  }
  return key;
}

/**
 * Verify the signature over `header.payload`.
 *
 * The two details that matter, both of which are silent when wrong:
 *   - the `alg` comes from OUR allowlist keyed by the header value, and the
 *     header value has already been rejected if it is not in it. `none` and
 *     HS* never reach here.
 *   - `dsaEncoding: 'ieee-p1363'` for ES*, because a JWS ECDSA signature is
 *     r‖s and Node's default is DER.
 */
export function verifyJwtSignature(parts: JwtParts, jwk: Jwk): boolean {
  const alg = parts.header.alg;
  if (!isSupportedAlgorithm(alg)) return false;
  const spec = JWS_ALGORITHMS[alg];
  const key = publicKeyFromJwk(jwk);

  const data = Buffer.from(parts.signingInput, 'ascii');

  if (spec.kty === 'EC') {
    return cryptoVerify(spec.hash, data, { key, dsaEncoding: 'ieee-p1363' }, parts.signature);
  }

  if ('padding' in spec && spec.padding === 'pss') {
    return cryptoVerify(
      spec.hash,
      data,
      {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: spec.saltLength,
      },
      parts.signature,
    );
  }

  return cryptoVerify(
    spec.hash,
    data,
    { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
    parts.signature,
  );
}

// ─── ID token claims ─────────────────────────────────────────────────────────

export interface IdTokenExpectation {
  issuer: string;
  clientId: string;
  /** The raw nonce we generated for this login. */
  nonce: string;
  now: Date;
}

export interface SsoIdentity {
  /** The IdP's stable identifier for this user. */
  subject: string;
  email: string;
  name: string | null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Every claim check OIDC Core §3.1.3.7 requires, in one place.
 *
 * `email` is deliberately NOT trusted on its own — the caller still has to run
 * `assertedEmailIsInScope()` against the connection's verified domains. This
 * function only guarantees the token is a genuine, fresh, correctly-addressed
 * token from the configured issuer.
 */
export function validateIdTokenClaims(
  payload: Record<string, unknown>,
  expect: IdTokenExpectation,
): SsoIdentity {
  const nowSeconds = Math.floor(expect.now.getTime() / 1000);
  const skew = CLOCK_SKEW_SECONDS;

  // iss — exact match against the configured issuer, not a prefix or a host
  // comparison. A prefix match lets `https://idp.example.com.evil.test` pass.
  if (str(payload.iss).replace(/\/+$/, '') !== normalizeIssuer(expect.issuer)) {
    throw new SsoError('That ID token was issued by a different provider.', 'AUTH');
  }

  // aud — must contain our client id. With more than one audience, `azp` must
  // name us, or the token is one issued for a different relying party that
  // happens to list us.
  const aud = payload.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a) => typeof a === 'string') : [];
  if (!audiences.includes(expect.clientId)) {
    throw new SsoError('That ID token was issued for a different application.', 'AUTH');
  }
  if (audiences.length > 1 && str(payload.azp) !== expect.clientId) {
    throw new SsoError('That ID token names a different authorized party.', 'AUTH');
  }

  // exp — required. A token with no expiry is a permanent credential.
  const exp = num(payload.exp);
  if (exp === null) throw new SsoError('That ID token has no expiry.', 'AUTH');
  if (exp + skew <= nowSeconds) throw new SsoError('That sign-in has expired — try again.', 'AUTH');

  // iat — required, and must not be in the future beyond skew. Also bounds how
  // old a token may be, so a captured one cannot be replayed days later even if
  // its exp is generous.
  const iat = num(payload.iat);
  if (iat === null) throw new SsoError('That ID token has no issued-at time.', 'AUTH');
  if (iat - skew > nowSeconds) throw new SsoError('That ID token is dated in the future.', 'AUTH');
  if (nowSeconds - iat > SSO_REQUEST_TTL_MS / 1000 + skew) {
    throw new SsoError('That sign-in took too long — try again.', 'AUTH');
  }

  const nbf = num(payload.nbf);
  if (nbf !== null && nbf - skew > nowSeconds) {
    throw new SsoError('That ID token is not valid yet.', 'AUTH');
  }

  // nonce — binds the token to the authorization request this browser started.
  // Without it a token obtained elsewhere can be injected into someone else's
  // callback.
  const nonce = str(payload.nonce);
  if (!nonce || !constantTimeEqual(nonce, expect.nonce)) {
    throw new SsoError('That sign-in could not be matched to this browser — try again.', 'AUTH');
  }

  const subject = str(payload.sub);
  if (!subject || subject.length > 255) {
    throw new SsoError('That ID token has no usable subject.', 'AUTH');
  }

  // `email_verified: false` is an explicit statement by the IdP that it does
  // not vouch for the address. The domain check is the real defence, but an
  // IdP contradicting itself is not something to paper over.
  if (payload.email_verified === false) {
    throw new SsoError('Your identity provider reports that email address as unverified.', 'AUTH');
  }

  const email = str(payload.email).toLowerCase();
  const name = str(payload.name) || str(payload.given_name) || null;

  return { subject, email, name };
}

/** Reads the same three fields out of a userinfo response. */
export function identityFromUserinfo(
  doc: unknown,
  subject: string,
): { email: string; name: string | null } {
  const d = (doc ?? {}) as Record<string, unknown>;
  // The userinfo `sub` MUST match the ID token's, or the two responses are
  // about different people (OIDC Core §5.3.2).
  if (str(d.sub) !== subject) {
    throw new SsoError('Your identity provider returned a mismatched profile.', 'AUTH');
  }
  if (d.email_verified === false) {
    throw new SsoError('Your identity provider reports that email address as unverified.', 'AUTH');
  }
  return { email: str(d.email).toLowerCase(), name: str(d.name) || null };
}

// ─── SAML ────────────────────────────────────────────────────────────────────

/**
 * The facts a signature verifier is required to hand back.
 *
 * CONTRACT, and the whole point of the type: every field here MUST be read from
 * inside the subtree the signature actually covered, by re-parsing that subtree
 * — not from the original document. That is the defence against signature
 * wrapping, where a valid signature over element A is presented alongside an
 * attacker-authored element B, and a verifier that checks A but reads B accepts
 * a forgery. A verifier that extracts from the whole document and sets
 * `signedSubtree` afterwards has NOT satisfied this contract and must not be
 * registered.
 */
export interface SamlAssertionFacts {
  /** Which element the signature covered. NONE means nothing was signed. */
  signedSubtree: 'ASSERTION' | 'RESPONSE' | 'NONE';
  /** Assertion ID — the replay key. */
  id: string;
  /** The assertion's Issuer, matched against the connection's IdP entity id. */
  issuer: string;
  /** AudienceRestriction values. */
  audiences: string[];
  /** Response/@Destination. */
  destination: string | null;
  /** SubjectConfirmationData/@Recipient. */
  recipient: string | null;
  /** SubjectConfirmationData/@InResponseTo (or the Response's). */
  inResponseTo: string | null;
  conditionsNotBefore: Date | null;
  conditionsNotOnOrAfter: Date | null;
  subjectNotOnOrAfter: Date | null;
  /** NameID, and the attribute bag, both already whitespace-trimmed. */
  nameId: string;
  attributes: Record<string, string[]>;
}

export interface SamlExpectation {
  /** Our entity id — must appear in AudienceRestriction. */
  spEntityId: string;
  /** Our ACS URL — must equal Destination and Recipient. */
  acsUrl: string;
  /** The connection's configured IdP entity id. */
  idpEntityId: string;
  /** The AuthnRequest id we generated, or null for IdP-initiated (see below). */
  requestId: string | null;
  now: Date;
}

/**
 * Every condition check on a SAML assertion, with the classic break each one
 * closes named. The signature itself is checked before this runs; this is what
 * turns "correctly signed" into "acceptable".
 *
 * Returns a reason string rather than throwing so the caller can audit the
 * refusal without a stack trace, and so the tests can enumerate them.
 */
export function checkSamlAssertion(
  facts: SamlAssertionFacts,
  expect: SamlExpectation,
): { ok: true } | { ok: false; reason: string } {
  const skewMs = CLOCK_SKEW_SECONDS * 1000;
  const now = expect.now.getTime();

  // Unsigned assertions accepted. The single most common SAML break: a
  // Response arrives with no Signature at all, or with one only over a sibling
  // element, and the consumer reads it anyway.
  if (facts.signedSubtree === 'NONE') {
    return { ok: false, reason: 'the assertion was not signed' };
  }

  if (!facts.id) return { ok: false, reason: 'the assertion has no ID to replay-check' };

  // Issuer — the assertion must come from the IdP this connection names, or a
  // signature from any IdP we have ever trusted would do.
  if (facts.issuer !== expect.idpEntityId) {
    return { ok: false, reason: 'the assertion was issued by a different identity provider' };
  }

  // Audience. Missing AudienceRestriction is a fail, not a pass: an assertion
  // minted for another service provider is otherwise replayable into ours.
  if (facts.audiences.length === 0) {
    return { ok: false, reason: 'the assertion has no audience restriction' };
  }
  if (!facts.audiences.includes(expect.spEntityId)) {
    return { ok: false, reason: 'the assertion was issued for a different service provider' };
  }

  // Destination. Required whenever the Response element is what was signed
  // (SAML core §3.2.2) — that is precisely the case where its absence lets a
  // signed Response be forwarded to a different endpoint.
  if (facts.destination !== null && facts.destination !== expect.acsUrl) {
    return { ok: false, reason: 'the assertion was addressed to a different endpoint' };
  }
  if (facts.destination === null && facts.signedSubtree === 'RESPONSE') {
    return { ok: false, reason: 'the signed response has no Destination' };
  }

  // Recipient. Same idea one level down, and required unconditionally: this is
  // the field that stops an assertion captured at another SP being posted here.
  if (!facts.recipient) {
    return { ok: false, reason: 'the assertion has no Recipient' };
  }
  if (facts.recipient !== expect.acsUrl) {
    return { ok: false, reason: 'the assertion was issued for a different recipient' };
  }

  // InResponseTo. SP-initiated login only: it binds the assertion to the
  // request this browser started. IdP-initiated flows have no request, and the
  // assertion must then carry no InResponseTo at all — an unsolicited response
  // that claims to answer some request is a stolen one.
  if (expect.requestId === null) {
    if (facts.inResponseTo) {
      return { ok: false, reason: 'the assertion answers a request this browser did not make' };
    }
  } else if (!facts.inResponseTo || !constantTimeEqual(facts.inResponseTo, expect.requestId)) {
    return { ok: false, reason: 'the assertion does not answer the request this browser made' };
  }

  // NotOnOrAfter. Required — an assertion with no expiry is a bearer token
  // that never dies. Checked on both the Conditions and the subject
  // confirmation, because IdPs put it in either place and only one is enough
  // for an attacker if we only look at the other.
  if (facts.conditionsNotOnOrAfter === null) {
    return { ok: false, reason: 'the assertion never expires' };
  }
  if (facts.conditionsNotOnOrAfter.getTime() + skewMs <= now) {
    return { ok: false, reason: 'the assertion has expired' };
  }
  if (
    facts.subjectNotOnOrAfter !== null &&
    facts.subjectNotOnOrAfter.getTime() + skewMs <= now
  ) {
    return { ok: false, reason: 'the assertion has expired' };
  }
  if (
    facts.conditionsNotBefore !== null &&
    facts.conditionsNotBefore.getTime() - skewMs > now
  ) {
    return { ok: false, reason: 'the assertion is not valid yet' };
  }

  if (!facts.nameId) return { ok: false, reason: 'the assertion carries no subject' };

  return { ok: true };
}

/** Pulls the email out of a SAML assertion, preferring an explicit attribute. */
export function samlEmail(facts: SamlAssertionFacts): string {
  const candidates = [
    facts.attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']?.[0],
    facts.attributes.email?.[0],
    facts.attributes.mail?.[0],
    facts.attributes['urn:oid:0.9.2342.19200300.100.1.3']?.[0],
    facts.nameId.includes('@') ? facts.nameId : undefined,
  ];
  return (candidates.find((c) => c && c.includes('@')) ?? '').trim().toLowerCase();
}

/** Pulls a display name out of a SAML assertion, if the IdP sent one. */
export function samlDisplayName(facts: SamlAssertionFacts): string | null {
  const first =
    facts.attributes['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']?.[0] ??
    facts.attributes.displayName?.[0] ??
    facts.attributes.name?.[0];
  return first?.trim() || null;
}

/**
 * The signature-verification port.
 *
 * `verify` receives the raw POSTed XML and the connection's trusted IdP
 * certificates, and must either throw or return facts read from the verified
 * subtree — see the contract on `SamlAssertionFacts`. An implementation MUST
 * additionally:
 *
 *   - parse with entity expansion and external entity resolution DISABLED
 *     (XXE: a SAML Response is attacker-controlled XML posted to an
 *     unauthenticated endpoint, so `<!ENTITY xxe SYSTEM "file:///etc/passwd">`
 *     is a file-read primitive and an SSRF primitive in one);
 *   - reject DTDs outright rather than trying to sanitise them;
 *   - resolve the signature's Reference URI and confirm it names the element
 *     being consumed, rejecting a document with more than one element carrying
 *     that ID;
 *   - reject signatures whose Transforms include anything other than
 *     enveloped-signature and exclusive c14n;
 *   - reject XML comments inside NameID and attribute values, or normalise
 *     with the comment-preserving canonicaliser — comment splitting turns
 *     `admin@acme.com` into `admin@acme.com<!--x-->.evil.test` for the
 *     signature and back for the reader.
 */
export interface SamlSignatureVerifier {
  verify(xml: string, idpCertificatesPem: string[]): SamlAssertionFacts;
}

let registeredVerifier: SamlSignatureVerifier | null = null;

/**
 * Install a verifier. Deliberately not called anywhere in this repository:
 * there is no vetted XML-signature implementation available to this workspace,
 * and a hand-rolled one is worse than none. See SAML_UNAVAILABLE.
 */
export function registerSamlVerifier(verifier: SamlSignatureVerifier): void {
  registeredVerifier = verifier;
}

export function samlVerifier(): SamlSignatureVerifier | null {
  return registeredVerifier;
}

/**
 * What the ACS endpoint says when no verifier is registered.
 *
 * Fails CLOSED, and that direction is the deliberate one. The house rule that a
 * missing dependency is skipped rather than failed is about test signals: there
 * the safe direction is to keep going and say so. Here the "signal" is whether
 * a stranger is who they claim to be, and the only safe answer to "I cannot
 * check" is no.
 */
export const SAML_UNAVAILABLE =
  'SAML sign-in is not available on this deployment: the XML signature verifier is not installed, ' +
  'and QAAI will not accept an assertion it cannot verify. Install an XML-DSIG implementation ' +
  '(xml-crypto + @xmldom/xmldom) in apps/api, implement SamlSignatureVerifier against the contract ' +
  'in src/lib/sso.ts, and call registerSamlVerifier() at boot. Until then, use OIDC or password sign-in.';

/** Escapes text for interpolation into the SP metadata document. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Our SP metadata, for pasting into the IdP.
 *
 * Safe to generate without a signature library — it is a description of us, not
 * a security decision, and it carries no key because this SP does not sign its
 * AuthnRequests.
 */
export function spMetadataXml(entityId: string, acsUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
    `  entityID="${xmlEscape(entityId)}">`,
    '  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"',
    '    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>',
    '    <md:AssertionConsumerService index="0" isDefault="true"',
    '      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
    `      Location="${xmlEscape(acsUrl)}"/>`,
    '  </md:SPSSODescriptor>',
    '</md:EntityDescriptor>',
    '',
  ].join('\n');
}

/** SP entity id and ACS URL, both derived from the API origin. */
export const spEntityId = (apiPublicUrl: string) => `${apiPublicUrl.replace(/\/+$/, '')}/sso/saml`;
export const spAcsUrl = (apiPublicUrl: string, connectionId: string) =>
  `${apiPublicUrl.replace(/\/+$/, '')}/sso/saml/${encodeURIComponent(connectionId)}/acs`;
