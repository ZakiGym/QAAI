/**
 * Tests for the SSO trust decisions.
 *
 * Every case here is an attack, not a feature. The module's failure mode is not
 * "sign-in is broken" — a broken sign-in is loud and gets fixed in an hour. It
 * is "sign-in works, and it also works for someone who is not you", which is
 * silent forever. So the assertions are written the pessimistic way round:
 * almost all of them assert a REFUSAL, and the handful of happy paths exist
 * only to prove the refusals are not vacuous.
 */

import { describe, expect, it } from 'vitest';
import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  constants as cryptoConstants,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  assertedEmailIsInScope,
  checkSamlAssertion,
  clampJitRole,
  constantTimeEqual,
  createPkce,
  decodeJwt,
  discoveryUrl,
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
  spMetadataXml,
  SsoError,
  txtRecordsProveOwnership,
  validateIdTokenClaims,
  verifyJwtSignature,
  type Jwk,
  type SamlAssertionFacts,
  type SamlExpectation,
} from './sso.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk: Jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1', alg: 'RS256', use: 'sig' };

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk: Jwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'ec-1', alg: 'ES256', use: 'sig' };

const b64u = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signRs256(header: object, payload: object): string {
  const input = `${b64u(header)}.${b64u(payload)}`;
  const sig = cryptoSign('sha256', Buffer.from(input, 'ascii'), {
    key: rsa.privateKey,
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  });
  return `${input}.${sig.toString('base64url')}`;
}

function signEs256(header: object, payload: object, dsaEncoding: 'ieee-p1363' | 'der'): string {
  const input = `${b64u(header)}.${b64u(payload)}`;
  const sig = cryptoSign('sha256', Buffer.from(input, 'ascii'), { key: ec.privateKey, dsaEncoding });
  return `${input}.${sig.toString('base64url')}`;
}

const ISSUER = 'https://idp.acme-corp.test';
const CLIENT_ID = 'qaai-client';
const NONCE = 'nonce-abcdefghijklmnop';
const NOW = new Date('2026-08-01T12:00:00.000Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

const goodClaims = () => ({
  iss: ISSUER,
  aud: CLIENT_ID,
  sub: 'idp-user-1',
  exp: nowSec + 300,
  iat: nowSec - 5,
  nonce: NONCE,
  email: 'Dana@acme-corp.test',
  email_verified: true,
  name: 'Dana Scully',
});

const expectation = { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE, now: NOW };

// ─── Domain scope: the cross-tenant boundary ─────────────────────────────────

describe('domain scope', () => {
  it('accepts an address in a verified domain', () => {
    expect(assertedEmailIsInScope('dana@acme-corp.test', ['acme-corp.test'])).toBe(true);
  });

  it('refuses an address outside every verified domain', () => {
    // The whole feature: an IdP that could assert any address would be handed a
    // session for that human, and /auth/switch-org would carry it into every
    // org they belong to.
    expect(assertedEmailIsInScope('victim@other-co.test', ['acme-corp.test'])).toBe(false);
  });

  it('does not treat a subdomain as covered by its parent', () => {
    // Proving acme-corp.test must not confer a subdomain that may be delegated
    // to a third party.
    expect(assertedEmailIsInScope('a@mail.acme-corp.test', ['acme-corp.test'])).toBe(false);
  });

  it('does not treat a parent as covered by a proven subdomain', () => {
    expect(assertedEmailIsInScope('a@acme-corp.test', ['mail.acme-corp.test'])).toBe(false);
  });

  it('refuses an address with two @ signs rather than guessing which domain wins', () => {
    // Parsers disagree on `a@b@evil.test` — some read `b`, some read
    // `evil.test`. A disagreement between the checker and the reader is a bypass.
    expect(assertedEmailIsInScope('a@b@acme-corp.test', ['acme-corp.test'])).toBe(false);
    expect(() => emailDomain('a@b@acme-corp.test')).toThrow(SsoError);
  });

  it('normalises case and the trailing dot before comparing', () => {
    expect(assertedEmailIsInScope('Dana@ACME-corp.test.', ['acme-corp.test'])).toBe(true);
  });

  it('refuses an empty verified-domain list', () => {
    // A connection with no verified domain can speak for nobody.
    expect(assertedEmailIsInScope('dana@acme-corp.test', [])).toBe(false);
  });

  it('rejects single-label and malformed domains at configuration time', () => {
    expect(() => normalizeDomain('localhost')).toThrow(SsoError);
    expect(() => normalizeDomain('acme corp.test')).toThrow(SsoError);
    expect(() => normalizeDomain('https://acme.test')).toThrow(SsoError);
    expect(normalizeDomain('@Acme-Corp.test.')).toBe('acme-corp.test');
  });
});

describe('domain verification', () => {
  it('accepts only the exact published token', () => {
    const token = 'tok_abc123';
    expect(txtRecordsProveOwnership([domainVerificationRecord(token)], token)).toBe(true);
    expect(txtRecordsProveOwnership([domainVerificationRecord('tok_other')], token)).toBe(false);
    expect(txtRecordsProveOwnership(['qaai-domain-verification='], token)).toBe(false);
    expect(txtRecordsProveOwnership([], token)).toBe(false);
  });

  it('tolerates the whitespace DNS providers add', () => {
    expect(txtRecordsProveOwnership([`  ${domainVerificationRecord('t1')}  `], 't1')).toBe(true);
  });
});

// ─── Redirect targets ────────────────────────────────────────────────────────

describe('safeRelativePath', () => {
  it('keeps a same-origin path', () => {
    expect(safeRelativePath('/runs/abc')).toBe('/runs/abc');
  });

  it('refuses protocol-relative and absolute URLs', () => {
    // `//evil.test` is absolute to a browser; the callback would become an open
    // redirect that carries a freshly-minted session cookie.
    expect(safeRelativePath('//evil.test')).toBe('/runs');
    expect(safeRelativePath('/\\evil.test')).toBe('/runs');
    expect(safeRelativePath('https://evil.test')).toBe('/runs');
    expect(safeRelativePath('javascript:alert(1)')).toBe('/runs');
  });

  it('refuses control characters that would truncate a Location header', () => {
    expect(safeRelativePath('/runs\r\nSet-Cookie: x=y')).toBe('/runs');
  });

  it('falls back rather than failing the login', () => {
    expect(safeRelativePath(undefined)).toBe('/runs');
    expect(safeRelativePath('x'.repeat(600))).toBe('/runs');
  });
});

// ─── Outbound host pinning ───────────────────────────────────────────────────

describe('safeOutboundUrl', () => {
  it('accepts a public https URL', () => {
    expect(safeOutboundUrl('https://idp.acme-corp.test/token', 'token endpoint').href).toBe(
      'https://idp.acme-corp.test/token',
    );
  });

  it('refuses http, embedded credentials and non-default ports', () => {
    expect(() => safeOutboundUrl('http://idp.acme-corp.test/t', 'x')).toThrow(SsoError);
    expect(() => safeOutboundUrl('https://u:p@idp.acme-corp.test/t', 'x')).toThrow(SsoError);
    expect(() => safeOutboundUrl('https://idp.acme-corp.test:8443/t', 'x')).toThrow(SsoError);
  });

  it('refuses IP literals and internal names', () => {
    expect(() => safeOutboundUrl('https://169.254.169.254/latest', 'x')).toThrow(SsoError);
    expect(() => safeOutboundUrl('https://kubernetes.default.svc/x', 'x')).toThrow(SsoError);
    expect(() => safeOutboundUrl('https://redis', 'x')).toThrow(SsoError);
  });

  it('strips the trailing dot before checking, not after', () => {
    // The exact SSRF that got through lib/issues.ts once: `localhost.` resolves
    // like `localhost` but failed every anchored pattern.
    expect(() => safeOutboundUrl('https://localhost./x', 'x')).toThrow(SsoError);
    expect(() => safeOutboundUrl('https://metadata.google.internal./x', 'x')).toThrow(SsoError);
    // And a legitimate FQDN keeps working, normalised.
    expect(safeOutboundUrl('https://idp.acme-corp.test./t', 'x').hostname).toBe(
      'idp.acme-corp.test',
    );
  });

  it('refuses traversal in the path', () => {
    expect(() => safeOutboundUrl('https://idp.acme-corp.test/../x', 'x')).not.toThrow();
    expect(() => safeOutboundUrl('https://idp.acme-corp.test/a/..%2f..', 'x')).toThrow(SsoError);
  });
});

describe('discovery', () => {
  it('derives the discovery URL from the issuer alone', () => {
    expect(discoveryUrl(ISSUER)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(discoveryUrl('https://login.microsoftonline.com/tid/v2.0/')).toBe(
      'https://login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration',
    );
  });

  it('normalises only the trailing slash', () => {
    expect(normalizeIssuer(`${ISSUER}/`)).toBe(ISSUER);
    expect(() => normalizeIssuer(`${ISSUER}?x=1`)).toThrow(SsoError);
  });

  const doc = (over: Record<string, unknown> = {}) => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    ...over,
  });

  it('reads a well-formed document', () => {
    const endpoints = parseDiscovery(ISSUER, doc());
    expect(endpoints.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(endpoints.userinfoEndpoint).toBe(`${ISSUER}/userinfo`);
  });

  it('refuses a document that names a different issuer', () => {
    // OIDC Discovery §4.3. A mismatch is a mix-up attack in progress.
    expect(() => parseDiscovery(ISSUER, doc({ issuer: 'https://evil.test' }))).toThrow(SsoError);
  });

  it('refuses an endpoint on a host the issuer is not pinned to', () => {
    // The client secret goes to token_endpoint. A document that can relocate it
    // is a credential-exfiltration primitive.
    expect(() => parseDiscovery(ISSUER, doc({ token_endpoint: 'https://evil.test/token' }))).toThrow(
      SsoError,
    );
    expect(() => parseDiscovery(ISSUER, doc({ jwks_uri: 'https://evil.test/jwks' }))).toThrow(
      SsoError,
    );
  });

  it('refuses an internal endpoint even on a plausible-looking document', () => {
    expect(() =>
      parseDiscovery(ISSUER, doc({ token_endpoint: 'https://169.254.169.254/token' })),
    ).toThrow(SsoError);
  });

  it('allows exactly the extra hosts Google is pinned to, and nothing more', () => {
    const google = 'https://accounts.google.com';
    const gdoc = {
      issuer: google,
      authorization_endpoint: `${google}/o/oauth2/v2/auth`,
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    };
    expect(parseDiscovery(google, gdoc).tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
    // The allowlist is per-issuer: another issuer may not borrow Google's hosts.
    expect(() =>
      parseDiscovery(ISSUER, doc({ token_endpoint: 'https://oauth2.googleapis.com/token' })),
    ).toThrow(SsoError);
  });

  it('requires the endpoints it cannot work without', () => {
    expect(() => parseDiscovery(ISSUER, doc({ token_endpoint: undefined }))).toThrow(SsoError);
    expect(() => parseDiscovery(ISSUER, doc({ jwks_uri: undefined }))).toThrow(SsoError);
    // userinfo is genuinely optional.
    expect(parseDiscovery(ISSUER, doc({ userinfo_endpoint: undefined })).userinfoEndpoint).toBeNull();
  });
});

// ─── PKCE ────────────────────────────────────────────────────────────────────

describe('PKCE', () => {
  it('produces an S256 challenge that matches its verifier', () => {
    const pkce = createPkce();
    expect(pkce.method).toBe('S256');
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash('sha256').update(pkce.verifier).digest('base64url')).toBe(pkce.challenge);
    // Never plain: the challenge must not be the verifier.
    expect(pkce.challenge).not.toBe(pkce.verifier);
  });

  it('does not repeat', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

// ─── JWT decoding ────────────────────────────────────────────────────────────

describe('decodeJwt', () => {
  it('refuses anything that is not exactly three segments', () => {
    expect(() => decodeJwt('a.b')).toThrow(SsoError);
    // Five segments is a JWE. Treating one as an unsigned JWT would accept a
    // token whose contents we never actually read.
    expect(() => decodeJwt('a.b.c.d.e')).toThrow(SsoError);
  });

  it('refuses non-canonical base64url', () => {
    // Buffer's base64url decode is lenient, so two different strings can decode
    // to identical bytes: the signature covers the string, the claims come from
    // the bytes, and that gap is a bypass.
    const token = signRs256({ alg: 'RS256', kid: 'rsa-1' }, goodClaims());
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(() => decodeJwt(`${h}.${p}==.${s}`)).toThrow(SsoError);
    expect(() => decodeJwt(`${h}.${p}\n.${s}`)).toThrow(SsoError);
  });

  it('keeps the signing input exactly as received', () => {
    const token = signRs256({ alg: 'RS256', kid: 'rsa-1' }, goodClaims());
    const parts = decodeJwt(token);
    expect(parts.signingInput).toBe(token.split('.').slice(0, 2).join('.'));
  });
});

// ─── Algorithm confusion ─────────────────────────────────────────────────────

describe('algorithm handling', () => {
  it('refuses alg: none', () => {
    const header = { alg: 'none' };
    const token = `${b64u(header)}.${b64u(goodClaims())}.`;
    expect(() => decodeJwt(token)).toThrow(SsoError); // empty signature segment
    expect(() => selectJwk([rsaJwk], header)).toThrow(SsoError);
  });

  it('refuses every HS* variant', () => {
    // The key-confusion attack: with a JWKS, HS256 lets an attacker sign a
    // token using the PUBLIC key as the HMAC secret.
    for (const alg of ['HS256', 'HS384', 'HS512']) {
      expect(() => selectJwk([rsaJwk], { alg })).toThrow(SsoError);
      expect(verifyJwtSignature(decodeJwt(signRs256({ alg }, goodClaims())), rsaJwk)).toBe(false);
    }
  });

  it('refuses an unknown alg', () => {
    expect(() => selectJwk([rsaJwk], { alg: 'RS256x' })).toThrow(SsoError);
    expect(() => selectJwk([rsaJwk], { alg: 5 })).toThrow(SsoError);
  });
});

describe('selectJwk', () => {
  it('picks by kid', () => {
    expect(selectJwk([ecJwk, rsaJwk], { alg: 'RS256', kid: 'rsa-1' }).kid).toBe('rsa-1');
  });

  it('refuses a kid the provider does not publish', () => {
    expect(() => selectJwk([rsaJwk], { alg: 'RS256', kid: 'rsa-9' })).toThrow(SsoError);
  });

  it('skips keys published for encryption', () => {
    const encKey = { ...rsaJwk, use: 'enc', kid: 'rsa-enc' };
    expect(() => selectJwk([encKey], { alg: 'RS256', kid: 'rsa-enc' })).toThrow(SsoError);
  });

  it('skips a key whose own alg disagrees with the header', () => {
    expect(() => selectJwk([{ ...rsaJwk, alg: 'RS512' }], { alg: 'RS256', kid: 'rsa-1' })).toThrow(
      SsoError,
    );
  });

  it('refuses to guess when there is no kid and several candidates', () => {
    const a = { ...rsaJwk, kid: 'a' };
    const b = { ...rsaJwk, kid: 'b' };
    expect(() => selectJwk([a, b], { alg: 'RS256' })).toThrow(SsoError);
    expect(selectJwk([a], { alg: 'RS256' }).kid).toBe('a');
  });

  it('will not use an RSA key for an EC algorithm', () => {
    expect(() => selectJwk([rsaJwk], { alg: 'ES256', kid: 'rsa-1' })).toThrow(SsoError);
    expect(() => selectJwk([ecJwk], { alg: 'ES384', kid: 'ec-1' })).toThrow(SsoError);
  });
});

// ─── Signature verification ──────────────────────────────────────────────────

describe('verifyJwtSignature', () => {
  it('accepts a genuine RS256 signature and rejects a tampered payload', () => {
    const token = signRs256({ alg: 'RS256', kid: 'rsa-1' }, goodClaims());
    expect(verifyJwtSignature(decodeJwt(token), rsaJwk)).toBe(true);

    const [h, , s] = token.split('.') as [string, string, string];
    const forged = `${h}.${b64u({ ...goodClaims(), email: 'attacker@acme-corp.test' })}.${s}`;
    expect(verifyJwtSignature(decodeJwt(forged), rsaJwk)).toBe(false);
  });

  it('accepts a genuine ES256 signature in JWS form', () => {
    // JWS ECDSA is raw r‖s; Node's default is DER. Without
    // dsaEncoding: 'ieee-p1363' every real token fails, and whoever "fixes"
    // that in a hurry reaches for a catch-all that returns true.
    const token = signEs256({ alg: 'ES256', kid: 'ec-1' }, goodClaims(), 'ieee-p1363');
    expect(verifyJwtSignature(decodeJwt(token), ecJwk)).toBe(true);
  });

  it('rejects a DER-encoded ECDSA signature presented as JWS', () => {
    const token = signEs256({ alg: 'ES256', kid: 'ec-1' }, goodClaims(), 'der');
    expect(verifyJwtSignature(decodeJwt(token), ecJwk)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherJwk = { ...(other.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1' };
    const token = signRs256({ alg: 'RS256', kid: 'rsa-1' }, goodClaims());
    expect(verifyJwtSignature(decodeJwt(token), otherJwk)).toBe(false);
  });

  it('refuses an undersized RSA key outright', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const weakJwk = { ...(weak.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1' };
    const input = `${b64u({ alg: 'RS256', kid: 'rsa-1' })}.${b64u(goodClaims())}`;
    const sig = cryptoSign('sha256', Buffer.from(input, 'ascii'), {
      key: weak.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    });
    const parts = decodeJwt(`${input}.${sig.toString('base64url')}`);
    // The signature is arithmetically valid; the key is not acceptable.
    expect(createPublicKey({ key: weakJwk, format: 'jwk' })).toBeTruthy();
    expect(() => verifyJwtSignature(parts, weakJwk)).toThrow(SsoError);
  });
});

// ─── ID token claims ─────────────────────────────────────────────────────────

describe('validateIdTokenClaims', () => {
  it('accepts a well-formed token', () => {
    const identity = validateIdTokenClaims(goodClaims(), expectation);
    expect(identity).toEqual({
      subject: 'idp-user-1',
      email: 'dana@acme-corp.test',
      name: 'Dana Scully',
    });
  });

  it('refuses another issuer, including a prefix lookalike', () => {
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), iss: 'https://evil.test' }, expectation),
    ).toThrow(SsoError);
    // A prefix or startsWith comparison would let this through.
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), iss: `${ISSUER}.evil.test` }, expectation),
    ).toThrow(SsoError);
  });

  it('refuses a token minted for another application', () => {
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), aud: 'someone-else' }, expectation),
    ).toThrow(SsoError);
  });

  it('requires azp to name us when there are several audiences', () => {
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), aud: [CLIENT_ID, 'other'] }, expectation),
    ).toThrow(SsoError);
    expect(
      validateIdTokenClaims(
        { ...goodClaims(), aud: [CLIENT_ID, 'other'], azp: CLIENT_ID },
        expectation,
      ).subject,
    ).toBe('idp-user-1');
  });

  it('requires an expiry and enforces it', () => {
    expect(() => validateIdTokenClaims({ ...goodClaims(), exp: undefined }, expectation)).toThrow(
      SsoError,
    );
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), exp: nowSec - 3600 }, expectation),
    ).toThrow(SsoError);
    // Inside the skew window it still passes.
    expect(
      validateIdTokenClaims({ ...goodClaims(), exp: nowSec - 30 }, expectation).subject,
    ).toBeTruthy();
  });

  it('requires a sane issued-at', () => {
    expect(() => validateIdTokenClaims({ ...goodClaims(), iat: undefined }, expectation)).toThrow(
      SsoError,
    );
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), iat: nowSec + 3600 }, expectation),
    ).toThrow(SsoError);
    // Bounds replay of a captured token whose exp is generous.
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), iat: nowSec - 86_400, exp: nowSec + 86_400 }, expectation),
    ).toThrow(SsoError);
  });

  it('requires the nonce we generated', () => {
    // Without this, a token obtained elsewhere can be injected into this
    // browser's callback.
    expect(() => validateIdTokenClaims({ ...goodClaims(), nonce: undefined }, expectation)).toThrow(
      SsoError,
    );
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), nonce: 'nonce-abcdefghijklmnoP' }, expectation),
    ).toThrow(SsoError);
  });

  it('refuses a subject-less token', () => {
    expect(() => validateIdTokenClaims({ ...goodClaims(), sub: '' }, expectation)).toThrow(SsoError);
  });

  it('refuses an address the IdP itself calls unverified', () => {
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), email_verified: false }, expectation),
    ).toThrow(SsoError);
  });

  it('honours nbf when present', () => {
    expect(() =>
      validateIdTokenClaims({ ...goodClaims(), nbf: nowSec + 3600 }, expectation),
    ).toThrow(SsoError);
  });
});

describe('identityFromUserinfo', () => {
  it('requires the subject to match the ID token', () => {
    // OIDC Core §5.3.2 — otherwise the two responses describe different people.
    expect(() => identityFromUserinfo({ sub: 'someone-else', email: 'x@y.test' }, 'me')).toThrow(
      SsoError,
    );
    expect(identityFromUserinfo({ sub: 'me', email: 'A@Y.test' }, 'me').email).toBe('a@y.test');
  });
});

// ─── SAML conditions ─────────────────────────────────────────────────────────

const ACS = 'https://api.qaai.test/sso/saml/conn1/acs';
const SP = 'https://api.qaai.test/sso/saml';
const IDP = 'https://idp.acme-corp.test/entity';

const samlExpect: SamlExpectation = {
  spEntityId: SP,
  acsUrl: ACS,
  idpEntityId: IDP,
  requestId: 'req-1',
  now: NOW,
};

const facts = (over: Partial<SamlAssertionFacts> = {}): SamlAssertionFacts => ({
  signedSubtree: 'ASSERTION',
  id: '_assertion-1',
  issuer: IDP,
  audiences: [SP],
  destination: ACS,
  recipient: ACS,
  inResponseTo: 'req-1',
  conditionsNotBefore: new Date(NOW.getTime() - 60_000),
  conditionsNotOnOrAfter: new Date(NOW.getTime() + 300_000),
  subjectNotOnOrAfter: new Date(NOW.getTime() + 300_000),
  nameId: 'dana@acme-corp.test',
  attributes: {},
  ...over,
});

const reason = (over: Partial<SamlAssertionFacts>) => {
  const result = checkSamlAssertion(facts(over), samlExpect);
  return result.ok ? null : result.reason;
};

describe('checkSamlAssertion', () => {
  it('accepts a well-formed assertion', () => {
    expect(checkSamlAssertion(facts(), samlExpect)).toEqual({ ok: true });
  });

  it('refuses an unsigned assertion', () => {
    expect(reason({ signedSubtree: 'NONE' })).toBe('the assertion was not signed');
  });

  it('refuses an assertion from another identity provider', () => {
    expect(reason({ issuer: 'https://evil.test/entity' })).toMatch(/different identity provider/);
  });

  it('refuses a missing or foreign audience', () => {
    // An assertion minted for another SP is otherwise replayable into ours.
    expect(reason({ audiences: [] })).toBe('the assertion has no audience restriction');
    expect(reason({ audiences: ['https://other-sp.test'] })).toMatch(/different service provider/);
  });

  it('refuses a Destination that is not this endpoint', () => {
    expect(reason({ destination: 'https://api.qaai.test/sso/saml/other/acs' })).toMatch(
      /different endpoint/,
    );
  });

  it('requires Destination when the Response element is what was signed', () => {
    // SAML core §3.2.2. Its absence is what lets a signed Response be forwarded.
    expect(reason({ signedSubtree: 'RESPONSE', destination: null })).toBe(
      'the signed response has no Destination',
    );
    expect(checkSamlAssertion(facts({ destination: null }), samlExpect)).toEqual({ ok: true });
  });

  it('requires a Recipient and requires it to be us', () => {
    expect(reason({ recipient: null })).toBe('the assertion has no Recipient');
    expect(reason({ recipient: 'https://other-sp.test/acs' })).toMatch(/different recipient/);
  });

  it('binds the assertion to the request this browser made', () => {
    expect(reason({ inResponseTo: null })).toMatch(/does not answer the request/);
    expect(reason({ inResponseTo: 'req-2' })).toMatch(/does not answer the request/);
  });

  it('refuses an unsolicited assertion that claims to answer a request', () => {
    const idpInitiated = { ...samlExpect, requestId: null };
    expect(checkSamlAssertion(facts({ inResponseTo: null }), idpInitiated)).toEqual({ ok: true });
    const result = checkSamlAssertion(facts({ inResponseTo: 'req-1' }), idpInitiated);
    expect(result.ok).toBe(false);
  });

  it('refuses an assertion that never expires', () => {
    // No NotOnOrAfter is a bearer token with no end date.
    expect(reason({ conditionsNotOnOrAfter: null })).toBe('the assertion never expires');
  });

  it('refuses an expired assertion on either clock', () => {
    expect(reason({ conditionsNotOnOrAfter: new Date(NOW.getTime() - 300_000) })).toBe(
      'the assertion has expired',
    );
    // The subject clock is checked separately: IdPs put the tight bound in
    // either place, and only checking one leaves the other free.
    expect(reason({ subjectNotOnOrAfter: new Date(NOW.getTime() - 300_000) })).toBe(
      'the assertion has expired',
    );
  });

  it('refuses an assertion that is not valid yet', () => {
    expect(reason({ conditionsNotBefore: new Date(NOW.getTime() + 300_000) })).toBe(
      'the assertion is not valid yet',
    );
  });

  it('refuses an assertion with no id to replay-check', () => {
    expect(reason({ id: '' })).toBe('the assertion has no ID to replay-check');
  });

  it('refuses an assertion with no subject', () => {
    expect(reason({ nameId: '' })).toBe('the assertion carries no subject');
  });
});

describe('SAML availability', () => {
  it('has no registered signature verifier in this build', () => {
    // The deliberate state: no vetted XML-DSIG implementation is available to
    // this workspace, so the ACS route refuses everything. A hand-rolled
    // canonicaliser would look like validation and would not be validation.
    expect(samlVerifier()).toBeNull();
  });
});

describe('SAML attribute reading', () => {
  it('prefers an explicit email attribute over the NameID', () => {
    expect(
      samlEmail(
        facts({
          nameId: 'not-an-email',
          attributes: { email: ['Dana@ACME-corp.test'] },
        }),
      ),
    ).toBe('dana@acme-corp.test');
  });

  it('falls back to a NameID that looks like an address', () => {
    expect(samlEmail(facts())).toBe('dana@acme-corp.test');
  });

  it('returns empty rather than guessing when there is no address', () => {
    // An empty string fails assertedEmailIsInScope, which is the right outcome.
    expect(samlEmail(facts({ nameId: 'not-an-email' }))).toBe('');
    expect(assertedEmailIsInScope('', ['acme-corp.test'])).toBe(false);
  });

  it('reads a display name when the IdP sends one', () => {
    expect(samlDisplayName(facts({ attributes: { displayName: ['Dana Scully'] } }))).toBe(
      'Dana Scully',
    );
    expect(samlDisplayName(facts())).toBeNull();
  });
});

describe('SP metadata', () => {
  it('escapes interpolated values', () => {
    const xml = spMetadataXml('https://api.qaai.test/sso/saml', 'https://api.qaai.test/a?b=1&c="x"');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).not.toContain('c="x""');
  });
});

// ─── Roles ───────────────────────────────────────────────────────────────────

describe('clampJitRole', () => {
  it('never yields OWNER', () => {
    // An IdP assertion must not be able to mint someone who can change billing
    // or delete the organisation.
    expect(clampJitRole('OWNER')).toBe('MEMBER');
    expect(clampJitRole('owner')).toBe('MEMBER');
    expect(clampJitRole('SUPERUSER')).toBe('MEMBER');
    expect(clampJitRole('')).toBe('MEMBER');
  });

  it('passes the roles it is allowed to grant', () => {
    expect(clampJitRole('ADMIN')).toBe('ADMIN');
    expect(clampJitRole('VIEWER')).toBe('VIEWER');
    expect(clampJitRole('MEMBER')).toBe('MEMBER');
  });
});

describe('constantTimeEqual', () => {
  it('compares without a length shortcut', () => {
    const token = randomBytes(16).toString('hex');
    expect(constantTimeEqual(token, token)).toBe(true);
    expect(constantTimeEqual(token, `${token}x`)).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a', 'b')).toBe(false);
  });
});
