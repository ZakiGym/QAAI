/**
 * Tests for the plugin manifest — the security boundary for third-party code.
 *
 * The crypto here is REAL: `generateKeyPairSync('ed25519')` and `sign()` from
 * node:crypto, the same primitives the verifier uses. A stubbed signer would
 * make every test in this file tautological — "the fake said yes, and we
 * believed it" — which is precisely the assertion shape that has bitten this
 * repository before. With real keys, the negative cases are the ones that carry
 * the weight: a signature made with a DIFFERENT key must fail, and a manifest
 * altered after signing must fail, and neither of those can pass by accident.
 *
 * What is actually being proven, worst-bug-first:
 *
 *   1. EVERY field of the manifest is inside the signature. The test mutates
 *      each field in turn and expects verification to fail. Signing a subset —
 *      name and version, say, and not `capabilities` or `code.sha256` — leaves
 *      a publisher's signature reusable on a manifest that asks for secrets
 *      and points at different bytes. Nothing else in this file would notice.
 *   2. Key ORDER does not change the signed bytes. Manifests round-trip through
 *      Postgres jsonb, which does not preserve object order, so a signature
 *      that only verifies against the original insertion order is a signature
 *      that stops verifying the first time we re-read our own row.
 *   3. Refusal ORDER. An unsigned manifest asking for `secrets` must be refused
 *      for the signature, not for the plan — otherwise the product quotes an
 *      unverified document back to the user in a sentence that reads like the
 *      product describing it.
 *   4. Each refusal is reachable and specific, including the two that only
 *      exist because a first-party plugin already owns the ground: the reserved
 *      name, and the protocol version this build cannot honour.
 */

import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEST_TYPES } from './constants';
import {
  GOVERNED_CAPABILITIES,
  MIN_PLUGIN_PROTOCOL_VERSION,
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_COPY,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  bundleDigest,
  canonicalJson,
  evaluateInstall,
  isReservedPluginName,
  manifestSigningInput,
  normalizePublisherKey,
  publisherKeyFingerprint,
  verifyManifestSignature,
  type InstallCandidate,
  type PluginManifest,
  type PluginSignature,
  type TrustedPublisher,
} from './plugin-manifest';

// ─── Real keys ───────────────────────────────────────────────────────────────

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, spki, raw };
}

const acme = keypair();
const impostor = keypair();

function sign(manifest: PluginManifest, key = acme.privateKey): PluginSignature {
  return {
    algorithm: 'ed25519',
    value: signBytes(null, manifestSigningInput(manifest), key).toString('base64'),
  };
}

const BUNDLE = Buffer.from('export const plugin = {};\n', 'utf8');

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schema: PLUGIN_MANIFEST_SCHEMA,
    name: 'acme-lighthouse',
    version: '1.4.2',
    publisher: 'acme',
    displayName: 'Acme Lighthouse',
    description: 'Runs Lighthouse against every page the suite visits.',
    homepage: 'https://plugins.acme.test/lighthouse',
    protocol: PLUGIN_PROTOCOL_VERSION,
    capabilities: ['http', 'fixtures'],
    code: { sha256: bundleDigest(BUNDLE), bytes: BUNDLE.length, entry: 'dist/index.js' },
    ...overrides,
  };
}

const trusted = (over: Partial<TrustedPublisher> = {}): TrustedPublisher => ({
  publisherId: 'acme',
  publicKey: acme.raw,
  revokedAt: null,
  ...over,
});

function candidate(over: Partial<InstallCandidate> = {}): InstallCandidate {
  const m = (over.manifest as PluginManifest | undefined) ?? manifest();
  return {
    manifest: m,
    signature: over.signature ?? sign(m),
    bundleSha256: over.bundleSha256 ?? bundleDigest(BUNDLE),
    publisher: over.publisher === undefined ? trusted() : over.publisher,
    plan: over.plan ?? { label: 'Business', allowsGovernedCapabilities: true },
  };
}

// ─── Canonicalisation ────────────────────────────────────────────────────────

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    // The jsonb round-trip in one line: same document, different order.
    const a = { b: 1, a: { d: [3, 2, 1], c: 'x' } };
    const b = { a: { c: 'x', d: [3, 2, 1] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}');
  });

  it('keeps array order, because an array’s order is part of its meaning', () => {
    expect(canonicalJson(['fixtures', 'http'])).toBe('["fixtures","http"]');
    expect(canonicalJson(['http', 'fixtures'])).not.toBe(canonicalJson(['fixtures', 'http']));
  });

  it('treats an undefined property as absent, the way every JSON reader does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('throws rather than coercing what it cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/cannot canonicalise/);
  });
});

// ─── Signature coverage ──────────────────────────────────────────────────────

describe('verifyManifestSignature', () => {
  it('accepts a real signature over the manifest', () => {
    const m = manifest();
    expect(verifyManifestSignature(m, sign(m), acme.raw)).toBe(true);
  });

  it('still verifies when the manifest comes back with its keys reordered', () => {
    const m = manifest();
    const signature = sign(m);
    // What `SELECT manifest FROM "Plugin"` hands back: same fields, no order.
    const reordered = Object.fromEntries(
      Object.entries(m).sort(([a], [b]) => b.localeCompare(a)),
    ) as PluginManifest;
    expect(verifyManifestSignature(reordered, signature, acme.raw)).toBe(true);
  });

  /*
   * The assertion this file exists for. Each mutation is a manifest a publisher
   * never signed; if any of them verifies, that field is outside the signature
   * and a legitimate signature can be replayed onto it.
   */
  it.each([
    ['name', { name: 'acme-lighthouse-pro' }],
    ['version', { version: '9.9.9' }],
    ['publisher', { publisher: 'acme-labs' }],
    ['displayName', { displayName: 'QAAI Official Lighthouse' }],
    ['description', { description: 'Totally safe.' }],
    ['homepage', { homepage: 'https://evil.test/' }],
    ['protocol', { protocol: 0 }],
    ['capabilities', { capabilities: ['http', 'fixtures', 'secrets'] }],
    ['code.sha256', { code: { sha256: bundleDigest(Buffer.from('other')), bytes: 5, entry: 'i.js' } }],
  ] as Array<[string, Partial<PluginManifest>]>)(
    'rejects a signature replayed onto a manifest with a different %s',
    (_field, override) => {
      const original = manifest();
      const signature = sign(original);
      expect(verifyManifestSignature(manifest(override), signature, acme.raw)).toBe(false);
    },
  );

  it('rejects a signature made with a different key', () => {
    const m = manifest();
    expect(verifyManifestSignature(m, sign(m, impostor.privateKey), acme.raw)).toBe(false);
  });

  it('returns false, never throws, on malformed input', () => {
    const m = manifest();
    expect(verifyManifestSignature(m, { algorithm: 'ed25519', value: 'not base64 !!' }, acme.raw)).toBe(
      false,
    );
    // Truncated to 32 bytes: an Ed25519 signature is fixed at 64.
    const short = Buffer.from(sign(m).value, 'base64').subarray(0, 32).toString('base64');
    expect(verifyManifestSignature(m, { algorithm: 'ed25519', value: short }, acme.raw)).toBe(false);
    expect(verifyManifestSignature(m, sign(m), Buffer.alloc(31))).toBe(false);
  });
});

// ─── Publisher keys ──────────────────────────────────────────────────────────

describe('normalizePublisherKey', () => {
  it('accepts the raw 32 bytes and the SPKI DER, and lands on the same key', () => {
    expect(normalizePublisherKey(acme.raw.toString('base64'))?.equals(acme.raw)).toBe(true);
    expect(normalizePublisherKey(acme.spki.toString('base64'))?.equals(acme.raw)).toBe(true);
  });

  it('refuses anything that is not an Ed25519 public key', () => {
    expect(normalizePublisherKey(Buffer.alloc(31).toString('base64'))).toBeNull();
    expect(normalizePublisherKey(Buffer.alloc(33).toString('base64'))).toBeNull();
    // 44 bytes, but an RSA-shaped prefix rather than the Ed25519 OID.
    const wrongOid = Buffer.concat([Buffer.alloc(12, 0x30), acme.raw]);
    expect(normalizePublisherKey(wrongOid.toString('base64'))).toBeNull();
    expect(normalizePublisherKey('')).toBeNull();
  });

  it('fingerprints a key stably, and two keys differently', () => {
    expect(publisherKeyFingerprint(acme.raw)).toBe(publisherKeyFingerprint(acme.raw));
    expect(publisherKeyFingerprint(acme.raw)).not.toBe(publisherKeyFingerprint(impostor.raw));
    // Grouped for reading aloud: eight groups of four hex characters.
    expect(publisherKeyFingerprint(acme.raw)).toMatch(/^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
  });
});

// ─── Reserved names ──────────────────────────────────────────────────────────

describe('isReservedPluginName', () => {
  it('reserves the name of every first-party test type', () => {
    for (const type of TEST_TYPES) {
      expect(isReservedPluginName(type.toLowerCase().replace(/_/g, '-'))).toBe(true);
    }
    // The two plugin modules that back more than one type and so have no name
    // of their own in TEST_TYPES.
    expect(isReservedPluginName('external')).toBe(true);
    expect(isReservedPluginName('matrix')).toBe(true);
  });

  it('reserves anything claiming to be ours', () => {
    expect(isReservedPluginName('qaai')).toBe(true);
    expect(isReservedPluginName('qaai-visual-pro')).toBe(true);
  });

  it('leaves ordinary third-party names alone', () => {
    expect(isReservedPluginName('acme-lighthouse')).toBe(false);
    expect(isReservedPluginName('lighthouse')).toBe(false);
  });
});

// ─── The verdict ─────────────────────────────────────────────────────────────

describe('evaluateInstall', () => {
  it('approves a signed manifest from a trusted publisher', () => {
    const verdict = evaluateInstall(candidate());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.manifest.name).toBe('acme-lighthouse');
    // network + page are ungoverned, so nothing had to be permitted by plan.
    expect(verdict.governed).toEqual([]);
  });

  it('refuses a manifest that is not one', () => {
    const verdict = evaluateInstall(candidate({ manifest: { name: 'x' } }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('MANIFEST_MALFORMED');
  });

  it('names the publisher it has never heard of', () => {
    const verdict = evaluateInstall(candidate({ publisher: null }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('UNKNOWN_PUBLISHER');
    expect(verdict.message).toContain('"acme"');
    expect(verdict.message).toMatch(/signing key/i);
  });

  it('refuses a revoked key and says when it was revoked', () => {
    const verdict = evaluateInstall(
      candidate({ publisher: trusted({ revokedAt: new Date('2026-07-04T00:00:00.000Z') }) }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('PUBLISHER_REVOKED');
    expect(verdict.message).toContain('2026-07-04');
  });

  it('refuses a signature from the wrong key and shows the fingerprint that was expected', () => {
    const m = manifest();
    const verdict = evaluateInstall(
      candidate({ manifest: m, signature: sign(m, impostor.privateKey) }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('SIGNATURE_INVALID');
    expect(verdict.message).toContain(publisherKeyFingerprint(acme.raw));
  });

  /*
   * Order, not just presence. This manifest is wrong three times over — bad
   * signature, reserved name, ungranted capability — and the refusal must be
   * the signature. Reporting the capability first would mean the sentence
   * "Acme Lighthouse asks for project secrets" was assembled entirely from a
   * document nobody verified.
   */
  it('checks the signature before it repeats anything the manifest claims', () => {
    const m = manifest({ name: 'e2e', capabilities: ['secrets'] });
    const verdict = evaluateInstall(
      candidate({
        manifest: m,
        signature: sign(m, impostor.privateKey),
        plan: { label: 'Free', allowsGovernedCapabilities: false },
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('SIGNATURE_INVALID');
  });

  it('refuses a protocol this build does not speak, in both directions', () => {
    const tooNew = manifest({ protocol: PLUGIN_PROTOCOL_VERSION + 1 });
    const newer = evaluateInstall(candidate({ manifest: tooNew, signature: sign(tooNew) }));
    expect(newer.ok).toBe(false);
    if (newer.ok) return;
    expect(newer.code).toBe('PROTOCOL_TOO_NEW');
    expect(newer.message).toContain(String(PLUGIN_PROTOCOL_VERSION));

    const tooOld = manifest({ protocol: MIN_PLUGIN_PROTOCOL_VERSION - 1 });
    const older = evaluateInstall(candidate({ manifest: tooOld, signature: sign(tooOld) }));
    expect(older.ok).toBe(false);
    if (older.ok) return;
    expect(older.code).toBe('PROTOCOL_TOO_OLD');
  });

  it('refuses a name a first-party plugin already owns', () => {
    const m = manifest({ name: 'accessibility' });
    const verdict = evaluateInstall(candidate({ manifest: m, signature: sign(m) }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('RESERVED_NAME');
    expect(verdict.message).toContain('accessibility');
  });

  it('refuses a bundle whose bytes are not the bytes that were signed', () => {
    const other = bundleDigest(Buffer.from('something else entirely'));
    const verdict = evaluateInstall(candidate({ bundleSha256: other }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('HASH_MISMATCH');
    expect(verdict.detail).toMatchObject({ actual: other });
  });

  it('refuses a governed capability the plan cannot grant, and names both', () => {
    const m = manifest({ capabilities: ['fixtures', 'secrets'] });
    const verdict = evaluateInstall(
      candidate({
        manifest: m,
        signature: sign(m),
        plan: { label: 'Free', allowsGovernedCapabilities: false },
      }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('CAPABILITY_NOT_IN_PLAN');
    expect(verdict.message).toContain('Free');
    expect(verdict.message).toContain(PLUGIN_CAPABILITY_COPY.secrets.label.toLowerCase());
    expect(verdict.detail).toMatchObject({ capabilities: ['secrets'] });
  });

  it('lets the ungoverned pair through on a plan with no audit log', () => {
    // If this ever fails, the free tier can install nothing at all and the
    // capability gate has become a ban rather than a control.
    const verdict = evaluateInstall(
      candidate({ plan: { label: 'Free', allowsGovernedCapabilities: false } }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('records which capabilities the plan had to permit', () => {
    const m = manifest({ capabilities: ['http', 'secrets', 'log'] });
    const verdict = evaluateInstall(candidate({ manifest: m, signature: sign(m) }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.governed).toEqual(['secrets']);
  });
});

describe('the capability vocabulary', () => {
  it('has copy for every capability, so no install row can render blank', () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      const copy = PLUGIN_CAPABILITY_COPY[capability];
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.grants.length).toBeGreaterThan(0);
      expect(copy.bounded.length).toBeGreaterThan(0);
    }
  });

  it('governs only capabilities that exist', () => {
    for (const capability of GOVERNED_CAPABILITIES) {
      expect(PLUGIN_CAPABILITIES).toContain(capability);
    }
    // network and page are deliberately ungoverned — see the note on the list.
    expect(GOVERNED_CAPABILITIES).not.toContain('http');
    expect(GOVERNED_CAPABILITIES).not.toContain('fixtures');
  });
});
