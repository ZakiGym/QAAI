/**
 * The SAML attack suite.
 *
 * This endpoint is unauthenticated, accepts attacker-controlled XML, and issues
 * a session on success — so these are not edge cases, they are the threat
 * model. Each one is a named, documented break of a real SAML deployment.
 *
 * The CONTROL matters as much as the attacks: a verifier that refuses
 * everything passes an attack suite and is also completely broken, which is the
 * state this file was written to move the product out of.
 */

import { generateKeyPairSync } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { xmlCryptoSamlVerifier } from './saml-verifier.js';

let dir: string;
let key: string;
let cert: string;

beforeAll(() => {
  // A real self-signed certificate: the verification under test is genuine RSA,
  // not a stub that could pass while the real path fails.
  dir = mkdtempSync(join(tmpdir(), 'qaai-saml-'));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout ${dir}/k.pem -out ${dir}/c.pem ` +
      `-days 2 -nodes -subj "/CN=idp.test" 2>/dev/null`,
  );
  key = readFileSync(`${dir}/k.pem`, 'utf8');
  cert = readFileSync(`${dir}/c.pem`, 'utf8');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const assertion = (id: string, nameId = 'admin@acme.com'): string =>
  `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" IssueInstant="2026-08-01T00:00:00Z" Version="2.0">` +
  `<saml:Issuer>https://idp.test</saml:Issuer>` +
  `<saml:Subject><saml:NameID>${nameId}</saml:NameID><saml:SubjectConfirmation>` +
  `<saml:SubjectConfirmationData Recipient="https://qaai.test/acs" NotOnOrAfter="2030-01-01T00:00:00Z"/>` +
  `</saml:SubjectConfirmation></saml:Subject>` +
  `<saml:Conditions NotOnOrAfter="2030-01-01T00:00:00Z"><saml:AudienceRestriction>` +
  `<saml:Audience>https://qaai.test</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
  `</saml:Assertion>`;

const wrap = (inner: string): string =>
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" Destination="https://qaai.test/acs" ID="_r1">${inner}</samlp:Response>`;

function signWith(privateKey: string, xml: string, refId: string): string {
  const sx = new SignedXml({ privateKey });
  sx.addReference({
    xpath: `//*[@ID='${refId}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sx.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sx.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sx.computeSignature(xml, { location: { reference: `//*[@ID='${refId}']`, action: 'append' } });
  return sx.getSignedXml();
}

const sign = (xml: string, id: string): string => signWith(key, xml, id);
const verify = (xml: string) => xmlCryptoSamlVerifier.verify(xml, [cert]);

describe('a legitimate assertion is accepted', () => {
  it('reads the identity out of the verified subtree', () => {
    const facts = verify(wrap(sign(assertion('_a1'), '_a1')));
    expect(facts.nameId).toBe('admin@acme.com');
    expect(facts.signedSubtree).toBe('ASSERTION');
    expect(facts.id).toBe('_a1');
    expect(facts.audiences).toContain('https://qaai.test');
  });
});

describe('every known SAML break is refused', () => {
  it('refuses an unsigned assertion', () => {
    expect(() => verify(wrap(assertion('_a1')))).toThrow(/not signed/i);
  });

  it('refuses signature wrapping — a valid signature over a decoy', () => {
    // The classic break: the signature verifies, but over an element the
    // attacker chose, with the real payload sitting elsewhere in the document.
    const payload = wrap(
      sign(assertion('_decoy', 'decoy@acme.com'), '_decoy') +
        assertion('_evil', 'attacker@evil.test'),
    );
    expect(() => verify(payload)).toThrow(/more than one assertion/i);
  });

  it('refuses a document where two elements share the signed id', () => {
    const payload = wrap(sign(assertion('_a1'), '_a1') + assertion('_a1', 'attacker@evil.test'));
    expect(() => verify(payload)).toThrow(/more than one/i);
  });

  it.each([
    ['a file-read entity', 'file:///etc/passwd'],
    ['a cloud-metadata SSRF entity', 'http://169.254.169.254/'],
  ])('refuses XXE via %s', (_label, uri) => {
    const payload = `<!DOCTYPE x [<!ENTITY e SYSTEM "${uri}">]>` + wrap(sign(assertion('_a1'), '_a1'));
    expect(() => verify(payload)).toThrow(/DTD or entity/i);
  });

  it('refuses comment splitting inside NameID', () => {
    // `admin@acme.com<!--x-->.evil.test` canonicalises one way for the
    // signature and reads back another way for the application.
    const payload = wrap(sign(assertion('_a1', 'admin@acme.com<!--x-->.evil.test'), '_a1'));
    expect(() => verify(payload)).toThrow(/comment/i);
  });

  it('refuses a signature from an untrusted key', () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    expect(() => verify(wrap(signWith(other, assertion('_a1'), '_a1')))).toThrow(/could not be verified/i);
  });

  it('refuses an assertion tampered with after signing', () => {
    const tampered = sign(assertion('_a1'), '_a1').replace('admin@acme.com', 'attacker@evil.test');
    expect(() => verify(wrap(tampered))).toThrow(/could not be verified/i);
  });

  it('refuses when no trusted certificate is configured', () => {
    expect(() => xmlCryptoSamlVerifier.verify(wrap(sign(assertion('_a1'), '_a1')), [])).toThrow(
      /no IdP certificate/i,
    );
  });
});
