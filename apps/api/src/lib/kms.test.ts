import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DECLARED_KEY_PROVIDERS,
  KEY_MATERIAL_BYTES,
  KMS_REFUSALS,
  KeyMaterial,
  VAULT_KEY_PROVIDER_ADAPTERS,
  configureKeyProvider,
  useKeyMaterial,
} from './kms.js';
import type { KeyProviderIo } from './kms.js';
import { SECRET_MASK } from '@qaai/shared';
import { VAULT_KEY_PROVIDERS } from '../../../../packages/shared/src/sealed.js';

/**
 * NO KEY-SHAPED LITERAL ANYWHERE IN THIS FILE. Every byte of key material a
 * test needs is generated at run time, so there is nothing here for a secret
 * scanner to match and nothing a reader could mistake for a real key. A
 * finished commit was once rejected by push protection for a literal inside a
 * comment explaining why a literal had been removed.
 */
function materialIo(bytes = KEY_MATERIAL_BYTES): KeyProviderIo {
  const base64 = randomBytes(bytes).toString('base64');
  return { localMasterKeyBase64: () => base64 };
}

describe('the provider table', () => {
  it('has an adapter for every declared provider, in both halves', () => {
    /*
     * The compile-time half is the `satisfies Record<VaultKeyProvider, …>` on
     * VAULT_KEY_PROVIDER_ADAPTERS. This is the run-time half, and one without
     * the other passes while the two disagree: a provider added to the Prisma
     * enum and the shared list but not to the table would be
     * `undefined.configure` at keyring load — a crash instead of the refusal
     * the table exists to produce.
     */
    expect(Object.keys(VAULT_KEY_PROVIDER_ADAPTERS).sort()).toEqual([...VAULT_KEY_PROVIDERS].sort());
    for (const provider of VAULT_KEY_PROVIDERS) {
      expect(VAULT_KEY_PROVIDER_ADAPTERS[provider].provider).toBe(provider);
    }
  });

  it('lists every provider for a cockpit, derived rather than restated', () => {
    expect(DECLARED_KEY_PROVIDERS.map((adapter) => adapter.provider)).toEqual([
      ...VAULT_KEY_PROVIDERS,
    ]);
  });

  it('says which providers exist and which are a seam', () => {
    expect(VAULT_KEY_PROVIDER_ADAPTERS.LOCAL.implemented).toBe(true);
    expect(VAULT_KEY_PROVIDER_ADAPTERS.KMS.implemented).toBe(false);
  });
});

describe('an unimplemented provider refuses at CONFIGURATION time', () => {
  it('REFUSES KMS BY NAME, and never hands back a provider', () => {
    /*
     * THE TEST THAT STOPS A SILENT STUB COMING BACK. A stub returning the local
     * master key would make `provider = KMS` a lie that worked; a stub
     * returning zeroes would make every row sealed under it unopenable and
     * surface months later as a decrypt error. Neither is reachable while this
     * is red for anything but a refusal.
     */
    const result = configureKeyProvider('KMS', materialIo());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('PROVIDER_NOT_IMPLEMENTED');
      expect(result.detail).toContain('declared seam');
    }
  });

  it('refuses a wrong-length master key when the keyring is BUILT, not at decrypt', () => {
    // A 31-byte master key used to surface as a throw from `keyForVersion` the
    // first time somebody opened a secret — an hour after boot, as a 500.
    const result = configureKeyProvider('LOCAL', materialIo(KEY_MATERIAL_BYTES - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('MATERIAL_WRONG_LENGTH');
      expect(result.detail).toContain(String(KEY_MATERIAL_BYTES));
    }
  });

  it('refuses when the deployment cannot produce a master key at all', () => {
    const throwing: KeyProviderIo = {
      localMasterKeyBase64: () => {
        throw new Error('not set');
      },
    };
    const result = configureKeyProvider('LOCAL', throwing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('MATERIAL_UNAVAILABLE');
  });
});

describe('the LOCAL provider', () => {
  it('unwraps a data key for a LOCAL row and labels it', () => {
    const configured = configureKeyProvider('LOCAL', materialIo());
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;

    const unwrapped = configured.value.unwrapDataKey({ keyId: 'k1', providerRef: null });
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.value.provider).toBe('LOCAL');
    expect(unwrapped.value.keyId).toBe('k1');
    expect(unwrapped.value.byteLength).toBe(KEY_MATERIAL_BYTES);
  });

  it('REFUSES a LOCAL row that carries a provider reference', () => {
    /*
     * `registerVaultKeySchema` refuses a LOCAL key with a reference, so a row
     * that has one was edited by hand or written by a build that treated the
     * column as material storage. Opening it anyway would make the
     * inconsistency permanent and invisible.
     */
    const configured = configureKeyProvider('LOCAL', materialIo());
    if (!configured.ok) throw new Error('fixture');
    const unwrapped = configured.value.unwrapDataKey({ keyId: 'k1', providerRef: 'arn:fake' });
    expect(unwrapped.ok).toBe(false);
    if (!unwrapped.ok) expect(unwrapped.refusal).toBe('PROVIDER_REF_MISMATCH');
  });

  it('refuses to WRAP, rather than minting bytes and calling them a reference', () => {
    /*
     * The honest answer. `VaultKey` has no column for a wrapped data key and
     * documents that it never holds key material, so a LOCAL `wrapDataKey` that
     * returned anything usable would be putting key bytes in the database.
     */
    const configured = configureKeyProvider('LOCAL', materialIo());
    if (!configured.ok) throw new Error('fixture');
    const wrapped = configured.value.wrapDataKey('k2');
    expect(wrapped.ok).toBe(false);
    if (!wrapped.ok) {
      expect(wrapped.refusal).toBe('WRAPPING_NOT_AVAILABLE');
      // And it says what a second LOCAL version does and does not achieve,
      // because that is the thing a reader will otherwise assume.
      expect(wrapped.detail).toContain('does not give those rows different bytes');
    }
  });

  it('gives every LOCAL key the same bytes, which is stated and therefore testable', () => {
    /*
     * This is the asymmetry ./kms.ts states plainly: two LOCAL versions share
     * their material, so a LOCAL-to-LOCAL rotation re-seals under a new binding
     * and does NOT remediate a leaked master key. Asserted rather than left to
     * the comment, because a comment that contradicts the code is the worst
     * kind of defect in a security file — and if a future change gives LOCAL
     * keys distinct material, this test is where the comment gets corrected.
     */
    const configured = configureKeyProvider('LOCAL', materialIo());
    if (!configured.ok) throw new Error('fixture');
    const one = configured.value.unwrapDataKey({ keyId: 'k1', providerRef: null });
    const two = configured.value.unwrapDataKey({ keyId: 'k2', providerRef: null });
    if (!one.ok || !two.ok) throw new Error('fixture');
    const same = useKeyMaterial(one.value, (a) => useKeyMaterial(two.value, (b) => a.equals(b)));
    expect(same).toBe(true);
  });
});

describe('KeyMaterial cannot be written down', () => {
  function material(): KeyMaterial {
    const configured = configureKeyProvider('LOCAL', materialIo());
    if (!configured.ok) throw new Error('fixture');
    const unwrapped = configured.value.unwrapDataKey({ keyId: 'k1', providerRef: null });
    if (!unwrapped.ok) throw new Error('fixture');
    return unwrapped.value;
  }

  it('masks a spread, Object.keys and Object.values, so a log line cannot pick it up', () => {
    const key = material();
    const bytes = useKeyMaterial(key, (buffer) => buffer.toString('base64'));

    expect(JSON.stringify({ ...key })).not.toContain(bytes);
    expect(Object.values({ ...key }).join('|')).not.toContain(bytes);
    expect(Object.keys(key).sort()).toEqual(['byteLength', 'keyId', 'provider']);
  });

  it('masks every coercion a logger or a serialiser reaches for', () => {
    const key = material();
    const bytes = useKeyMaterial(key, (buffer) => buffer.toString('base64'));

    expect(`${key}`).toBe(SECRET_MASK);
    expect(String(key)).toBe(SECRET_MASK);
    expect(key.valueOf()).toBe(SECRET_MASK);
    expect(JSON.stringify(key)).toContain(SECRET_MASK);
    expect(JSON.stringify(key)).not.toContain(bytes);
    // console.log / util.inspect do NOT go through toJSON and would otherwise
    // print the object's shape.
    expect(inspect(key)).toContain(SECRET_MASK);
    expect(inspect(key)).not.toContain(bytes);
    expect(inspect({ nested: key })).not.toContain(bytes);
  });

  it('hands the bytes out of exactly one function', () => {
    const key = material();
    expect(useKeyMaterial(key, (buffer) => buffer.length)).toBe(KEY_MATERIAL_BYTES);
  });

  it('fails closed when the bytes did not survive a serialisation boundary', () => {
    /*
     * A structured clone strips the WeakMap entry. The alternative to throwing
     * is returning an empty buffer, which would encrypt every secret in the
     * install under a key of zero length and report success.
     */
    const detached = Object.create(KeyMaterial.prototype) as KeyMaterial;
    expect(() => useKeyMaterial(detached, (buffer) => buffer.length)).toThrow(/carries no bytes/);
  });
});

describe('no refusal quotes what it protects', () => {
  it('reports every KMS refusal without a byte of key material in it', () => {
    /*
     * Rule 11, checked rather than claimed: an error about a secret must be
     * reportable without quoting any part of it. Each arm below produces one
     * member of KMS_REFUSALS, and the assertion is against the actual material
     * the fake was built with, not against a pattern.
     */
    const base64 = randomBytes(KEY_MATERIAL_BYTES).toString('base64');
    const io: KeyProviderIo = { localMasterKeyBase64: () => base64 };
    const hex = Buffer.from(base64, 'base64').toString('hex');

    const shortIo: KeyProviderIo = {
      localMasterKeyBase64: () => randomBytes(KEY_MATERIAL_BYTES - 1).toString('base64'),
    };
    const throwingIo: KeyProviderIo = {
      localMasterKeyBase64: () => {
        throw new Error('nope');
      },
    };
    const configured = configureKeyProvider('LOCAL', io);
    if (!configured.ok) throw new Error('fixture');

    const details = new Map<string, string>();
    for (const result of [
      configureKeyProvider('KMS', io),
      configureKeyProvider('LOCAL', shortIo),
      configureKeyProvider('LOCAL', throwingIo),
      configured.value.unwrapDataKey({ keyId: 'k1', providerRef: 'arn:fake' }),
      configured.value.wrapDataKey('k2'),
    ]) {
      if (result.ok) continue;
      details.set(result.refusal, result.detail);
    }

    // Every declared refusal is actually reachable. A refusal nothing can
    // produce is a member with no behaviour behind it.
    expect([...details.keys()].sort()).toEqual([...KMS_REFUSALS].sort());

    for (const [refusal, detail] of details) {
      expect(detail, refusal).not.toContain(base64);
      expect(detail, refusal).not.toContain(hex);
      // Not truncated either: a prefix of a key is key material.
      expect(detail, refusal).not.toContain(base64.slice(0, 8));
      expect(detail.length, refusal).toBeGreaterThan(0);
    }
  });
});
