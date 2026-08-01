/**
 * The XML-signature implementation behind `SamlSignatureVerifier`.
 *
 * `sso.ts` deliberately shipped this as an unimplemented port, and refused
 * every assertion until one was registered. That was the right call — a
 * hand-rolled XML-signature check is worse than none, because it looks like it
 * validates — but it also meant SAML sign-in did not work at all.
 *
 * This registers a real one, built on `xml-crypto` (the implementation the Node
 * SAML ecosystem has actually reviewed) and `@xmldom/xmldom`. Everything below
 * that is not a straight call into those libraries exists because of a
 * documented, named attack on SAML SSO. Each one is commented with the attack
 * it stops, because in six months the checks will look redundant and they are
 * not.
 *
 * The threat model is worth stating plainly: `POST /sso/saml/:id/acs` is an
 * UNAUTHENTICATED endpoint that accepts attacker-controlled XML and, on
 * success, issues a session as somebody. Every parse and every comparison here
 * happens before we know anything is trustworthy.
 */

import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import type { SamlAssertionFacts, SamlSignatureVerifier } from './sso.js';

const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

/**
 * The only transforms an assertion may declare.
 *
 * xml-crypto will happily apply whatever the document asks for, and the
 * document is written by the attacker. Anything outside this pair — an XSLT
 * transform in particular, which is arbitrary computation — is refused before
 * verification runs.
 *
 * Note which canonicaliser is absent: the `#WithComments` variants. Those are
 * how the SAML comment-splitting attack works — `admin@acme.com<!--x-->.evil.test`
 * canonicalises with the comment for the signature and reads back without it,
 * so the signature covers one string and the application consumes another.
 */
const ALLOWED_TRANSFORMS = new Set([
  'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
]);

/** Digest and signature algorithms weak enough to be worth refusing outright. */
const BANNED_ALGORITHMS = [/sha1/i, /md5/i, /hmac/i];

class SamlVerificationError extends Error {}

function fail(message: string): never {
  throw new SamlVerificationError(message);
}

/**
 * Parse with DTDs refused outright.
 *
 * A SAML Response is attacker-controlled XML posted to an unauthenticated
 * endpoint, so `<!ENTITY xxe SYSTEM "file:///etc/passwd">` is a file-read
 * primitive and `SYSTEM "http://169.254.169.254/..."` is an SSRF primitive
 * against the cloud metadata service. @xmldom/xmldom does not resolve external
 * entities, but "the parser we happen to use is safe today" is not a control —
 * the string is rejected before it reaches a parser at all.
 *
 * Refusing rather than stripping is deliberate: a sanitiser is a thing to be
 * outwitted, and no legitimate IdP sends a DOCTYPE.
 */
function parseXml(xml: string): Document {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    fail('The assertion declares a DTD or entity, which is never legitimate in SAML.');
  }

  let doc: Document;
  try {
    doc = new DOMParser({
      // Any parse error is fatal here. A document the parser had to guess about
      // is one where our reading and the signer's can diverge.
      onError: (level, message) => {
        if (level === 'fatalError' || level === 'error') fail(`Malformed XML: ${message}`);
      },
    }).parseFromString(xml, 'text/xml') as unknown as Document;
  } catch (err) {
    if (err instanceof SamlVerificationError) throw err;
    fail('The assertion could not be parsed as XML.');
  }

  if (!doc?.documentElement) fail('The assertion has no root element.');
  return doc;
}

function elements(scope: Document | Element, ns: string, name: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(ns, name)) as unknown as Element[];
}

function textOf(node: Element | null | undefined): string {
  return (node?.textContent ?? '').trim();
}

/**
 * Reject comments anywhere inside the subtree we are about to read.
 *
 * The second half of the comment-splitting defence. Even with a
 * non-comment-preserving canonicaliser, a comment inside a NameID means the
 * bytes the IdP signed and the string we hand to the login path are not the
 * same string. No IdP puts comments inside an assertion; an attacker does.
 */
function rejectComments(node: Node): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 8 /* COMMENT_NODE */) {
      fail('The assertion contains an XML comment, which is not legitimate and can split a value.');
    }
    rejectComments(child);
  }
}

/**
 * Find the element the signature actually covers, and prove it is the one we
 * are about to read.
 *
 * THIS IS THE SIGNATURE-WRAPPING DEFENCE and it is the single most important
 * function in the file. The classic break is not a forged signature: it is a
 * VALID signature over a decoy element, with the attacker's assertion placed
 * elsewhere in the same document. Verification passes, and a naive reader then
 * consumes the unsigned assertion. So the Reference URI is resolved to a
 * specific element, and the caller reads facts out of THAT element only —
 * never out of "the first Assertion in the document".
 *
 * The duplicate-ID check closes the same attack from the other side: if two
 * elements carry the same ID, "the element with this ID" is ambiguous and the
 * verifier and the reader can legitimately disagree about which one it is.
 */
function referencedElement(doc: Document, signature: Element): Element {
  const references = elements(signature, DSIG_NS, 'Reference');
  if (references.length !== 1) {
    fail(`The signature covers ${references.length} references; exactly one is required.`);
  }

  const uri = references[0]!.getAttribute('URI') ?? '';
  // An empty URI signs the whole document, which SAML IdPs do not do and which
  // makes the wrapping check meaningless.
  if (!uri.startsWith('#') || uri.length < 2) {
    fail('The signature reference must name an element by id.');
  }
  const id = uri.slice(1);

  for (const transform of elements(references[0]!, DSIG_NS, 'Transform')) {
    const algorithm = transform.getAttribute('Algorithm') ?? '';
    if (!ALLOWED_TRANSFORMS.has(algorithm)) {
      fail(`The signature declares an unsupported transform: ${algorithm}`);
    }
  }

  // ID, Id and id are all in the wild across IdPs.
  const matches = (['ID', 'Id', 'id'] as const).flatMap((attr) =>
    (Array.from(doc.getElementsByTagName('*')) as unknown as Element[]).filter(
      (el) => el.getAttribute(attr) === id,
    ),
  );
  const unique = [...new Set(matches)];

  if (unique.length === 0) fail('The signature references an element that is not in the document.');
  if (unique.length > 1) {
    fail(`More than one element carries the id "${id}", so the signed element is ambiguous.`);
  }
  return unique[0]!;
}

function attributesOf(assertion: Element): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const attribute of elements(assertion, SAML_NS, 'Attribute')) {
    const name = attribute.getAttribute('Name') ?? attribute.getAttribute('FriendlyName');
    if (!name) continue;
    const values = elements(attribute, SAML_NS, 'AttributeValue').map(textOf).filter(Boolean);
    if (values.length > 0) out[name] = values;
  }
  return out;
}

function dateOrNull(raw: string | null): Date | null {
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

export const xmlCryptoSamlVerifier: SamlSignatureVerifier = {
  verify(xml: string, idpCertificatesPem: string[]): SamlAssertionFacts {
    if (idpCertificatesPem.length === 0) {
      fail('The connection has no IdP certificate, so nothing can be verified against.');
    }

    const doc = parseXml(xml);

    /*
     * Only signatures at the Response or Assertion level count.
     *
     * `getElementsByTagNameNS` would also return a Signature nested somewhere
     * an attacker chose — inside an AttributeValue, say — and verifying that
     * one proves nothing about the assertion.
     */
    const signatures = elements(doc, DSIG_NS, 'Signature').filter((sig) => {
      const parent = sig.parentNode as Element | null;
      const name = parent?.localName;
      return name === 'Assertion' || name === 'Response';
    });

    if (signatures.length === 0) fail('The assertion is not signed.');
    if (signatures.length > 2) fail('The document carries an implausible number of signatures.');

    let verifiedSubtree: Element | null = null;
    let signedKind: 'ASSERTION' | 'RESPONSE' = 'ASSERTION';
    const problems: string[] = [];

    for (const signature of signatures) {
      const method = elements(signature, DSIG_NS, 'SignatureMethod')[0]?.getAttribute('Algorithm') ?? '';
      const digest = elements(signature, DSIG_NS, 'DigestMethod')[0]?.getAttribute('Algorithm') ?? '';
      if (BANNED_ALGORITHMS.some((weak) => weak.test(method) || weak.test(digest))) {
        problems.push(`refused a weak algorithm (${method || 'unknown'} / ${digest || 'unknown'})`);
        continue;
      }

      const target = referencedElement(doc, signature);

      // Try every trusted certificate: rotation means an IdP legitimately has
      // more than one, and which one signed is not knowable in advance.
      const accepted = idpCertificatesPem.some((pem) => {
        try {
          const verifier = new SignedXml();
          verifier.publicCert = pem;
          verifier.loadSignature(signature as unknown as Node);
          return verifier.checkSignature(xml);
        } catch {
          return false;
        }
      });

      if (!accepted) {
        problems.push('a signature did not verify against any trusted certificate');
        continue;
      }

      verifiedSubtree = target;
      signedKind = target.localName === 'Response' ? 'RESPONSE' : 'ASSERTION';
      break;
    }

    if (!verifiedSubtree) {
      fail(`The signature could not be verified: ${problems.join('; ') || 'no valid signature'}.`);
    }

    /*
     * Read ONLY from inside the verified subtree.
     *
     * If the Response was signed, the assertion must be a descendant of it —
     * an assertion sitting outside the signed element is exactly the wrapping
     * payload, and it must not be readable from here.
     */
    const assertion =
      verifiedSubtree.localName === 'Assertion'
        ? verifiedSubtree
        : (elements(verifiedSubtree, SAML_NS, 'Assertion')[0] ?? null);

    if (!assertion) fail('The signed element contains no assertion.');

    // Belt and braces: the whole document must not contain an assertion the
    // signature did not cover. A legitimate IdP never sends two.
    const allAssertions = elements(doc, SAML_NS, 'Assertion');
    if (allAssertions.length > 1) {
      fail('The document carries more than one assertion; only one may be present.');
    }
    if (!allAssertions.includes(assertion)) {
      fail('The verified element is not the assertion being consumed.');
    }

    rejectComments(assertion);

    const subjectConfirmationData = elements(assertion, SAML_NS, 'SubjectConfirmationData')[0] ?? null;
    const conditions = elements(assertion, SAML_NS, 'Conditions')[0] ?? null;
    const response = elements(doc, PROTOCOL_NS, 'Response')[0] ?? null;

    const id = assertion.getAttribute('ID') ?? assertion.getAttribute('Id') ?? '';
    if (!id) fail('The assertion has no ID, so replay cannot be prevented.');

    return {
      signedSubtree: signedKind,
      id,
      issuer: textOf(elements(assertion, SAML_NS, 'Issuer')[0]),
      audiences: elements(assertion, SAML_NS, 'Audience').map(textOf).filter(Boolean),
      destination: response?.getAttribute('Destination') ?? null,
      recipient: subjectConfirmationData?.getAttribute('Recipient') ?? null,
      inResponseTo:
        subjectConfirmationData?.getAttribute('InResponseTo') ??
        response?.getAttribute('InResponseTo') ??
        null,
      conditionsNotBefore: dateOrNull(conditions?.getAttribute('NotBefore') ?? null),
      conditionsNotOnOrAfter: dateOrNull(conditions?.getAttribute('NotOnOrAfter') ?? null),
      subjectNotOnOrAfter: dateOrNull(subjectConfirmationData?.getAttribute('NotOnOrAfter') ?? null),
      nameId: textOf(elements(assertion, SAML_NS, 'NameID')[0]),
      attributes: attributesOf(assertion),
    };
  },
};
