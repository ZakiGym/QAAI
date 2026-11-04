import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMPLICIT_KEY_ID,
  IMPLICIT_KEY_VERSION,
  VAULT_REFUSALS,
  VAULT_REFUSAL_REPORTS,
  VAULT_REFUSAL_SENTENCE,
  VaultRefusalError,
  countVaultDecision,
  currentKeyring,
  decideOpen,
  decideSeal,
  implicitKeyring,
  installVaultKeyring,
  loadVaultKeyring,
  needsRotation,
  open,
  openEnvelope,
  openWithKeyring,
  resealEnvelope,
  resealSecret,
  resealVerdictFor,
  resetVaultKeyring,
  resetVaultTallies,
  seal,
  sealEnvelope,
  sealWithKeyring,
  vaultTallies,
  vaultTallyKey,
  wouldHaveRefusedVault,
  installKeyringAtBoot,
} from './vault.js';
import type { VaultKeyRow, VaultKeyring, VaultTally } from './vault.js';
import { KeyMaterial, configureKeyProvider } from './kms.js';
import type { ConfiguredKeyProvider, KeyProviderIo, KmsResult } from './kms.js';
import { SECRET_MASK } from '@qaai/shared';
import { useSecret } from '../../../../packages/shared/src/sealed.js';
import type { VaultKeyState } from '../../../../packages/shared/src/sealed.js';

/**
 * NO KEY-SHAPED LITERAL IN THIS FILE. Every byte of key material is generated
 * at run time, so there is nothing a secret scanner can match and nothing a
 * reader could mistake for a real key.
 */
const MASTER = randomBytes(32).toString('base64');
const io: KeyProviderIo = { localMasterKeyBase64: () => MASTER };

afterEach(() => {
  resetVaultKeyring();
  resetVaultTallies();
  vi.restoreAllMocks();
});

/** A keyring built from (version, state) pairs, all LOCAL, sharing one material. */
function keyring(
  pairs: readonly [number, VaultKeyState][],
  options: { readonly mode?: 'OBSERVE' | 'ENFORCE' } = {},
): VaultKeyring {
  const configured = configureKeyProvider('LOCAL', io);
  if (!configured.ok) throw new Error('fixture: the LOCAL provider would not configure');
  return {
    source: 'REGISTERED',
    mode: options.mode ?? 'ENFORCE',
    keys: pairs.map(([version, state]) => ({
      keyId: `k${version}`,
      version,
      state,
      provider: 'LOCAL' as const,
      providerRef: null,
    })),
    providers: new Map([['LOCAL', configured]]),
  };
}

const ORG = 'org_fixture';
const NAME = 'DATABASE_PASSWORD';
/** Not a credential-shaped value: the point is that it round-trips, not what it is. */
const PLAINTEXT = 'the-value-under-test-0000';

describe('the behaviour every existing install already has', () => {
  it('seals and opens with nothing registered, under version 1', () => {
    /*
     * `VaultKey` is EMPTY in every deployment today — the sealing migration
     * deliberately seeds no row, not even version 1 — so the implicit keyring
     * is the one in force and it must behave exactly as this file did before it
     * grew a keyring. If this goes red, the change is not backward compatible
     * and every customer's secrets are unreadable.
     */
    const sealed = seal(PLAINTEXT, ORG, NAME);
    expect(sealed.keyVersion).toBe(IMPLICIT_KEY_VERSION);
    expect(sealed.hint).toBe(PLAINTEXT.slice(-4));
    expect(open(sealed.ciphertext, sealed.keyVersion, ORG, NAME)).toBe(PLAINTEXT);
  });

  it('reads a ciphertext written by the OLD code, byte layout and binding unchanged', () => {
    /*
     * The stored format is `iv | tag | ciphertext` base64 with the AAD composed
     * as `${orgId}:${name}`, and this test composes it by hand rather than
     * through `seal` — so it fails if the layout or the binding moves, which is
     * the one change that would silently orphan every secret already stored.
     */
    const key = Buffer.from(MASTER, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${ORG}:${NAME}`, 'utf8'));
    const body = Buffer.concat([cipher.update(PLAINTEXT, 'utf8'), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');

    installVaultKeyring(implicitKeyring({ keyProviderIo: io }));
    expect(open(legacy, 1, ORG, NAME)).toBe(PLAINTEXT);
  });

  it('names the implicit keyring, so an operator can tell it from a registered one', () => {
    const current = currentKeyring();
    expect(current.source).toBe('IMPLICIT');
    expect(current.keys).toHaveLength(1);
    expect(current.keys[0]?.keyId).toBe(IMPLICIT_KEY_ID);
    expect(current.keys[0]?.state).toBe('ACTIVE');
    expect(current.keys[0]?.provider).toBe('LOCAL');
  });
});

describe('an unknown key version is a named refusal and NEVER a decrypt attempt', () => {
  it('refuses before the provider is even asked for material', () => {
    /*
     * THE FAIL-CLOSED HEART. It used to be a throw from INSIDE the decrypt
     * path: `keyForVersion(7)` ran while a cipher was being constructed. The
     * spy is the assertion — if `unwrapDataKey` is reached, something tried to
     * open a value with a key it had not selected.
     */
    const base = keyring([[1, 'ACTIVE']]);
    const configured = base.providers.get('LOCAL');
    if (configured === undefined || !configured.ok) throw new Error('fixture');
    const spy = vi.spyOn(configured.value, 'unwrapDataKey');

    const result = openWithKeyring(base, 'irrelevant', 7, ORG, NAME);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('UNKNOWN_KEY_VERSION');
      expect(result.detail).toContain('NOT');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws a typed error whose message is the one sentence', () => {
    installVaultKeyring(keyring([[1, 'ACTIVE']]));
    let thrown: unknown;
    try {
      open('irrelevant', 9, ORG, NAME);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultRefusalError);
    if (thrown instanceof VaultRefusalError) {
      expect(thrown.refusal).toBe('UNKNOWN_KEY_VERSION');
      expect(thrown.keyVersion).toBe(9);
      expect(thrown.message).toBe(VAULT_REFUSAL_SENTENCE);
    }
  });
});

describe('the key states decide, and only one refusal has a brake', () => {
  it('refuses a RETIRED key under ENFORCE', () => {
    const result = openWithKeyring(keyring([[1, 'RETIRED']]), 'x', 1, ORG, NAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('KEY_NOT_READABLE');
  });

  it('OPENS a RETIRED key under OBSERVE and counts it as WOULD_REFUSE', () => {
    /*
     * The brake, and the only one. Retiring a key while rows are still sealed
     * under it is an operator mistake and the data is not disclosed, so an
     * install should not go down for it — but the count is what makes OBSERVE a
     * brake rather than an off switch with a reassuring name.
     */
    const observing = keyring([[1, 'RETIRED']], { mode: 'OBSERVE' });
    const sealed = sealWithKeyring(keyring([[1, 'ACTIVE']]), PLAINTEXT, ORG, NAME);
    if (!sealed.ok) throw new Error('fixture');

    resetVaultTallies();
    const result = openWithKeyring(observing, sealed.value.ciphertext, 1, ORG, NAME);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(PLAINTEXT);

    const counted = wouldHaveRefusedVault(vaultTallies());
    expect(counted.wouldRefuse).toBe(1);
    expect(counted.refused).toBe(0);
  });

  it('REFUSES A COMPROMISED KEY IN BOTH MODES, because that state has no brake', () => {
    /*
     * The one refusal a mode may not relax. Opening data under a key known to
     * have leaked is the exact thing the state exists to stop, so OBSERVE here
     * would be an off switch on the only control that matters during an
     * incident. Both modes are asserted, because "it refuses under ENFORCE" is
     * the half of this that a brake could quietly take away.
     */
    for (const mode of ['ENFORCE', 'OBSERVE'] as const) {
      const result = openWithKeyring(keyring([[1, 'COMPROMISED']], { mode }), 'x', 1, ORG, NAME);
      expect(result.ok, mode).toBe(false);
      if (!result.ok) expect(result.refusal, mode).toBe('KEY_COMPROMISED');
    }
  });

  it('counts a refusal in both modes, so no refusal is applied unreported', () => {
    resetVaultTallies();
    openWithKeyring(keyring([[1, 'COMPROMISED']]), 'x', 1, ORG, NAME);
    expect(wouldHaveRefusedVault(vaultTallies()).refused).toBe(1);
  });

  it('refuses to seal when nothing is ACTIVE, and does not fall back to a READABLE key', () => {
    /*
     * Sealing under a READABLE key "just this once" is how a rotation ends with
     * values under a key that is about to be retired. No brake, in either mode.
     */
    const result = sealWithKeyring(keyring([[1, 'READABLE']]), PLAINTEXT, ORG, NAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('NO_WRITABLE_KEY');
  });

  it('refuses to seal when TWO keys are ACTIVE, rather than picking one', () => {
    const result = decideSeal(
      keyring([
        [1, 'ACTIVE'],
        [2, 'ACTIVE'],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('MORE_THAN_ONE_WRITABLE_KEY');
  });
});

describe('loading the keyring', () => {
  it('falls back to the implicit keyring when nothing is registered', async () => {
    const result = await loadVaultKeyring({
      listVaultKeys: async () => [],
      keyProviderIo: io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('IMPLICIT');
    expect(result.value.keys.map((key) => key.version)).toEqual([IMPLICIT_KEY_VERSION]);
  });

  it('REFUSES a keyring in which two rows claim one version', async () => {
    /*
     * `selectOpeningKey` would take whichever came first, which makes "which
     * key sealed this value" unanswerable for every row in the install. The
     * database's unique index forbids it; a keyring assembled by hand does not.
     */
    const rows: VaultKeyRow[] = [
      { keyId: 'a', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      { keyId: 'b', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
    ];
    const result = await loadVaultKeyring({ listVaultKeys: async () => rows, keyProviderIo: io });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('DUPLICATE_KEY_VERSION');
      expect(result.detail).toContain('NOT');
    }
  });

  it('carries an unimplemented provider as a refusal against THAT key version', async () => {
    /*
     * The configuration-time refusal. A KMS row does not stop the keyring
     * loading — the operator must still be able to see WHICH version they
     * cannot open — but every attempt against it is PROVIDER_NOT_IMPLEMENTED
     * and nothing is decrypted.
     */
    const rows: VaultKeyRow[] = [
      { keyId: 'k1', version: 1, state: 'READABLE', provider: 'LOCAL', providerRef: null },
      { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'KMS', providerRef: 'arn:fake' },
    ];
    const result = await loadVaultKeyring({ listVaultKeys: async () => rows, keyProviderIo: io });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opened = openWithKeyring(result.value, 'x', 2, ORG, NAME);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal).toBe('PROVIDER_NOT_IMPLEMENTED');

    // And sealing is refused too, rather than falling back to the LOCAL key —
    // which would make `provider = KMS` a lie that worked.
    const sealedResult = sealWithKeyring(result.value, PLAINTEXT, ORG, NAME);
    expect(sealedResult.ok).toBe(false);
  });

  it('LOADS with two ACTIVE keys, because refusing would stop reads over a write problem', async () => {
    const rows: VaultKeyRow[] = [
      { keyId: 'k1', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
      { keyId: 'k2', version: 2, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
    ];
    const result = await loadVaultKeyring({ listVaultKeys: async () => rows, keyProviderIo: io });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reads work; the write is what is ambiguous, and it refuses by name.
    expect(decideOpen(result.value, 1).ok).toBe(true);
    expect(decideSeal(result.value).ok).toBe(false);
  });

  it('resolves the mode from the store, and falls back to ENFORCE for anything it cannot read', async () => {
    const rows: VaultKeyRow[] = [
      { keyId: 'k1', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
    ];
    const load = (storedModes: unknown): Promise<unknown> =>
      loadVaultKeyring({ listVaultKeys: async () => rows, keyProviderIo: io }, { storedModes });

    for (const [stored, expected] of [
      [{ VAULT_KEY_ROTATION: 'OBSERVE' }, 'OBSERVE'],
      [{ VAULT_KEY_ROTATION: 'ENFORCE' }, 'ENFORCE'],
      // Absent, malformed and unknown all resolve to the brake table's own
      // default, which for this control is ENFORCE.
      [undefined, 'ENFORCE'],
      [{ VAULT_KEY_ROTATION: 'off' }, 'ENFORCE'],
      ['not an object', 'ENFORCE'],
      [[], 'ENFORCE'],
    ] as const) {
      const result = (await load(stored)) as { ok: boolean; value?: VaultKeyring };
      expect(result.ok).toBe(true);
      expect(result.value?.mode, JSON.stringify(stored)).toBe(expected);
    }
  });
});

describe('a keyring with no configured provider refuses rather than configuring one', () => {
  it('REFUSES a key whose provider was never configured, and attempts nothing', () => {
    /*
     * Reachable only from a keyring assembled by hand — `loadVaultKeyring`
     * configures a provider for every row it sees. Refused rather than
     * configured on the spot, because a keyring that grows providers at decrypt
     * time is a keyring whose configuration-time refusal never happens, which
     * is the whole point of doing it at load.
     */
    const empty: VaultKeyring = {
      source: 'REGISTERED',
      mode: 'ENFORCE',
      keys: [{ keyId: 'k1', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null }],
      providers: new Map(),
    };
    const result = openWithKeyring(empty, 'x', 1, ORG, NAME);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('MATERIAL_UNAVAILABLE');
      expect(result.detail).toContain('Nothing was attempted');
    }
    expect(sealWithKeyring(empty, PLAINTEXT, ORG, NAME).ok).toBe(false);
  });
});

describe('needsRotation finally has a caller, and a right answer', () => {
  it('says TRUE for a version this deployment cannot name — it used to say false', () => {
    /*
     * THE OLD BUG, pinned. `needsRotation` was `keyVersion < CURRENT_KEY_VERSION`
     * against a module constant, so a row written by a NEWER build — a version
     * this deployment cannot open at all — answered FALSE. That is the most
     * dangerous possible answer about a row that needs attention.
     */
    installVaultKeyring(keyring([[1, 'ACTIVE']]));
    expect(needsRotation(2)).toBe(true);
    expect(needsRotation(1)).toBe(false);
  });

  it('separates needing a re-seal from needing RE-ENTRY, which are different remedies', () => {
    const rotated = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const superseded = resealVerdictFor(rotated, 1);
    expect(superseded).toMatchObject({ needed: true, urgent: false, reEntryRequired: false });

    const compromised = resealVerdictFor(
      keyring([
        [1, 'COMPROMISED'],
        [2, 'ACTIVE'],
      ]),
      1,
    );
    /*
     * THREE FACTS AND NOT ONE. A value under a compromised key must be
     * considered disclosed, so the remedy is a NEW value and not a re-seal —
     * one boolean for all of this would make a sweep unable to tell the two
     * apart, and would let it report a compromise as handled.
     */
    expect(compromised).toMatchObject({ needed: true, urgent: true, reEntryRequired: true });

    const absent = resealVerdictFor(keyring([[2, 'ACTIVE']]), 1);
    expect(absent).toMatchObject({ needed: true, urgent: true, reEntryRequired: true });

    expect(resealVerdictFor(rotated, 2).needed).toBe(false);
  });
});

describe('re-sealing verifies before the old ciphertext may be discarded', () => {
  it('moves a value from version 1 to version 2 and opens it under the new key', () => {
    const before = keyring([[1, 'ACTIVE']]);
    const sealed = sealWithKeyring(before, PLAINTEXT, ORG, NAME);
    if (!sealed.ok) throw new Error('fixture');

    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const resealed = resealSecret(after, sealed.value.ciphertext, 1, ORG, NAME);
    expect(resealed.ok).toBe(true);
    if (!resealed.ok) return;
    expect(resealed.value.keyVersion).toBe(2);
    expect(resealed.value.ciphertext).not.toBe(sealed.value.ciphertext);
    const opened = openWithKeyring(after, resealed.value.ciphertext, 2, ORG, NAME);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value).toBe(PLAINTEXT);
  });

  it('REFUSES rather than returning a ciphertext that does not open again', async () => {
    /*
     * The caller is about to overwrite a ciphertext that is currently readable.
     * If the new one does not open, the row is readable by NO key and SQL
     * cannot get the value back.
     *
     * ── Why the fake counts its calls ──────────────────────────────────────
     *
     * `resealSecret` asks for material three times: to OPEN the old value, to
     * SEAL the new one, and to open the new one again to VERIFY it. A fake that
     * simply returned fresh bytes every time would fail at the FIRST step, and
     * the test would pass while proving only that an unopenable value is
     * refused — which another test already covers. So the first two calls share
     * material and the THIRD does not: the open succeeds, the seal succeeds,
     * and the verification is the only thing that can refuse.
     */
    const stable = randomBytes(32);
    let calls = 0;
    const shifting: ConfiguredKeyProvider = {
      provider: 'LOCAL',
      unwrapDataKey: ({ keyId }) => {
        calls += 1;
        return {
          ok: true,
          value: new KeyMaterial(calls <= 2 ? stable : randomBytes(32), 'LOCAL', keyId),
        };
      },
      wrapDataKey: () => ({ ok: false, refusal: 'WRAPPING_NOT_AVAILABLE', detail: 'fixture' }),
    };
    const unstable: VaultKeyring = {
      source: 'REGISTERED',
      mode: 'ENFORCE',
      keys: [{ keyId: 'k1', version: 1, state: 'ACTIVE', provider: 'LOCAL', providerRef: null }],
      providers: new Map<'LOCAL' | 'KMS', KmsResult<ConfiguredKeyProvider>>([
        ['LOCAL', { ok: true, value: shifting }],
      ]),
    };

    // Sealed with the stable material, outside the counted window.
    const sealed = sealWithKeyring(
      {
        ...unstable,
        providers: new Map<'LOCAL' | 'KMS', KmsResult<ConfiguredKeyProvider>>([
          [
            'LOCAL',
            {
              ok: true,
              value: {
                provider: 'LOCAL',
                unwrapDataKey: ({ keyId }) => ({
                  ok: true,
                  value: new KeyMaterial(stable, 'LOCAL', keyId),
                }),
                wrapDataKey: () => ({
                  ok: false,
                  refusal: 'WRAPPING_NOT_AVAILABLE',
                  detail: 'fixture',
                }),
              },
            },
          ],
        ]),
      },
      PLAINTEXT,
      ORG,
      NAME,
    );
    if (!sealed.ok) throw new Error('fixture');

    calls = 0;
    const resealed = resealSecret(unstable, sealed.value.ciphertext, 1, ORG, NAME);
    // Three calls: open, seal, verify. The third is the one that disagrees.
    expect(calls).toBe(3);
    expect(resealed.ok).toBe(false);
    if (!resealed.ok) {
      expect(resealed.refusal).toBe('CIPHER_REJECTED');
      expect(resealed.detail).toContain('was NOT replaced');
    }
  });

  it('refuses a value it cannot open, instead of sealing an empty string over it', () => {
    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const resealed = resealSecret(after, randomBytes(64).toString('base64'), 1, ORG, NAME);
    expect(resealed.ok).toBe(false);
    if (!resealed.ok) expect(resealed.refusal).toBe('CIPHER_REJECTED');
  });
});

describe('the envelope fields', () => {
  const AAD = { fieldKey: 'AuthProfile.storageState', rowId: 'prof_a' } as const;

  it('round-trips through the qs1 envelope and records the version twice, agreeing', () => {
    const ring = keyring([[3, 'ACTIVE']]);
    const written = sealEnvelope(ring, PLAINTEXT, AAD);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value.stored.startsWith('qs1.k3.3.AES_256_GCM.')).toBe(true);
    expect(written.value.keyVersion).toBe(3);

    const opened = openEnvelope(ring, written.value.stored, AAD, written.value.keyVersion);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(useSecret(opened.value, (value) => value)).toBe(PLAINTEXT);
  });

  it('BINDS A SESSION TO ITS OWN ROW, so a lifted storageState does not open', () => {
    /*
     * The move this binding exists to prevent: one AuthProfile's cached session
     * pasted onto another, which would open as somebody else's live session.
     * The refusal is the uniform CIPHER_REJECTED and not a distinct
     * "wrong row" — telling them apart tells an attacker that the row was the
     * only thing wrong.
     */
    const ring = keyring([[1, 'ACTIVE']]);
    const written = sealEnvelope(ring, PLAINTEXT, AAD);
    if (!written.ok) throw new Error('fixture');

    const stolen = openEnvelope(
      ring,
      written.value.stored,
      { fieldKey: 'AuthProfile.storageState', rowId: 'prof_b' },
      written.value.keyVersion,
    );
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.refusal).toBe('CIPHER_REJECTED');

    // And to a different FIELD of the same row, which binding to (model, row)
    // alone would have allowed.
    const crossField = openEnvelope(
      ring,
      written.value.stored,
      { fieldKey: 'User.totpSecretEnc', rowId: 'prof_a' },
      written.value.keyVersion,
    );
    expect(crossField.ok).toBe(false);
  });

  it('refuses when the version COLUMN and the envelope disagree', () => {
    /*
     * The dangerous direction is a column that says 2 while the envelope says
     * 1: a sweep filters on the column, skips the row, and the old key keeps
     * opening it — so the key could be retired while that row still needs it.
     */
    const ring = keyring([[1, 'ACTIVE']]);
    const written = sealEnvelope(ring, PLAINTEXT, AAD);
    if (!written.ok) throw new Error('fixture');
    const result = openEnvelope(ring, written.value.stored, AAD, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe('MALFORMED_ENVELOPE');
      expect(result.detail).toContain('Nothing was attempted');
    }
  });

  it('refuses a value from a future build by name, rather than feeding it to a cipher', () => {
    const result = openEnvelope(keyring([[1, 'ACTIVE']]), 'qs2.k1.1.AES_256_GCM.AAAA', AAD, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('UNKNOWN_ENVELOPE_VERSION');
  });

  it('hands back an OpenedSecret, so a caller that logs the result logs the mask', () => {
    const ring = keyring([[1, 'ACTIVE']]);
    const written = sealEnvelope(ring, PLAINTEXT, AAD);
    if (!written.ok) throw new Error('fixture');
    const opened = openEnvelope(ring, written.value.stored, AAD, 1);
    if (!opened.ok) throw new Error('fixture');

    expect(`${opened.value}`).toBe(SECRET_MASK);
    expect(JSON.stringify(opened.value)).not.toContain(PLAINTEXT);
    expect(inspect(opened.value)).not.toContain(PLAINTEXT);
    expect(JSON.stringify({ ...opened.value })).not.toContain(PLAINTEXT);
  });

  it('re-seals an envelope field and verifies it, without the plaintext escaping', () => {
    const before = keyring([[1, 'ACTIVE']]);
    const written = sealEnvelope(before, PLAINTEXT, AAD);
    if (!written.ok) throw new Error('fixture');

    const after = keyring([
      [1, 'READABLE'],
      [2, 'ACTIVE'],
    ]);
    const resealed = resealEnvelope(after, written.value.stored, AAD, 1);
    expect(resealed.ok).toBe(true);
    if (!resealed.ok) return;
    expect(resealed.value.keyVersion).toBe(2);
    // The result carries a ciphertext and a version, and no plaintext at all.
    expect(JSON.stringify(resealed.value)).not.toContain(PLAINTEXT);

    const opened = openEnvelope(after, resealed.value.stored, AAD, 2);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(useSecret(opened.value, (value) => value)).toBe(PLAINTEXT);
  });
});

describe('no refusal is an oracle, and none of them quotes what it protects', () => {
  it('shows ONE sentence for every refusal, whatever the reason', () => {
    /*
     * A message that said "no key for version 3" would say how many keys this
     * deployment has; one that said "the tag did not verify" would say the key
     * was right and the bytes were not. So there is one sentence, and the
     * operator-facing distinctions live in the decision's detail.
     */
    const messages = new Set(
      VAULT_REFUSALS.map(
        (refusal) => new VaultRefusalError({ ok: false, refusal, detail: 'x' }, 1).message,
      ),
    );
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe(VAULT_REFUSAL_SENTENCE);
  });

  it('gives every refusal an operator meaning and a re-entry answer', () => {
    /*
     * The run-time half of the `satisfies Record<VaultRefusal, …>`. One half
     * without the other passes while the two disagree, and
     * `undefined.reEntryRequired` read as falsy would tell an operator a
     * compromised secret is fine.
     */
    expect(Object.keys(VAULT_REFUSAL_REPORTS).sort()).toEqual([...VAULT_REFUSALS].sort());
    for (const refusal of VAULT_REFUSALS) {
      expect(VAULT_REFUSAL_REPORTS[refusal].why.length, refusal).toBeGreaterThan(10);
    }
    // The two where the only honest remedy is a NEW value from the customer.
    expect(VAULT_REFUSAL_REPORTS.KEY_COMPROMISED.reEntryRequired).toBe(true);
    expect(VAULT_REFUSAL_REPORTS.UNKNOWN_KEY_VERSION.reEntryRequired).toBe(true);
    // And one where it is emphatically not: a rollback is fixed by deploying
    // forward, and telling an operator to re-enter every secret would be wrong.
    expect(VAULT_REFUSAL_REPORTS.UNKNOWN_ENVELOPE_VERSION.reEntryRequired).toBe(false);
  });

  it('reports every reachable refusal without the plaintext, the ciphertext or the key', () => {
    /*
     * Rule 11, checked rather than claimed. Each arm produces a real refusal
     * from a real call, and the assertion is against the actual values in play
     * — the plaintext, the stored ciphertext and this fixture's master key.
     */
    const ring = keyring([[1, 'ACTIVE']]);
    const sealed = sealWithKeyring(ring, PLAINTEXT, ORG, NAME);
    if (!sealed.ok) throw new Error('fixture');
    const cipher = sealed.value.ciphertext;
    const keyHex = Buffer.from(MASTER, 'base64').toString('hex');

    const details: string[] = [];
    const push = (result: { ok: boolean } & Partial<{ detail: string }>): void => {
      if (!result.ok && typeof result.detail === 'string') details.push(result.detail);
    };

    push(openWithKeyring(ring, cipher, 7, ORG, NAME));
    push(openWithKeyring(keyring([[1, 'RETIRED']]), cipher, 1, ORG, NAME));
    push(openWithKeyring(keyring([[1, 'COMPROMISED']]), cipher, 1, ORG, NAME));
    push(openWithKeyring(ring, cipher, 1, 'another-org', NAME));
    push(sealWithKeyring(keyring([[1, 'READABLE']]), PLAINTEXT, ORG, NAME));
    push(decideSeal(keyring([[1, 'ACTIVE'], [2, 'ACTIVE']])));
    push(openEnvelope(ring, 'not-an-envelope', { fieldKey: 'Secret.valueEnc', rowId: 'r' }, null));
    push(resealSecret(keyring([[1, 'READABLE'], [2, 'ACTIVE']]), 'AAAA', 1, ORG, NAME));

    expect(details.length).toBeGreaterThan(7);
    for (const detail of details) {
      expect(detail).not.toContain(PLAINTEXT);
      expect(detail).not.toContain(cipher);
      expect(detail).not.toContain(MASTER);
      expect(detail).not.toContain(keyHex);
      // Not truncated, not a prefix: part of a secret is a secret.
      expect(detail).not.toContain(cipher.slice(0, 12));
      expect(detail).not.toContain(MASTER.slice(0, 8));
    }
  });

  it('keeps the secret NAME and the org out of the tally key', () => {
    /*
     * A bucket per secret would be an inventory of which secrets exist and
     * which of them fail to open, which is the list an attacker would most like
     * to read. The key carries the operation, the outcome, the refusal and the
     * key version — four labels and an integer.
     */
    const decision = decideOpen(keyring([[1, 'COMPROMISED']]), 1);
    expect(decision.ok).toBe(false);
    for (const tally of vaultTallies()) {
      const key = vaultTallyKey({
        operation: tally.operation,
        outcome: tally.outcome,
        mode: 'ENFORCE',
        refusal: tally.refusal,
        keyVersion: tally.keyVersion,
        detail: '',
      });
      expect(key).not.toContain(ORG);
      expect(key).not.toContain(NAME);
    }
  });
});

describe('the count', () => {
  it('counts every decision, not only the refusals', () => {
    const ring = keyring([[1, 'ACTIVE']]);
    resetVaultTallies();
    const sealed = sealWithKeyring(ring, PLAINTEXT, ORG, NAME);
    if (!sealed.ok) throw new Error('fixture');
    openWithKeyring(ring, sealed.value.ciphertext, 1, ORG, NAME);
    openWithKeyring(ring, sealed.value.ciphertext, 7, ORG, NAME);

    const counted = wouldHaveRefusedVault(vaultTallies());
    /*
     * A count of refusals with no denominator is the kind of number that gets
     * quoted at a customer and cannot be defended.
     */
    expect(counted.allowed).toBe(2);
    expect(counted.refused).toBe(1);
    expect(counted.total).toBe(3);
  });

  it('merges identical decisions into one bucket with a count', () => {
    const into = new Map<string, VaultTally>();
    const decision = {
      operation: 'OPEN' as const,
      outcome: 'REFUSED' as const,
      mode: 'ENFORCE' as const,
      refusal: 'UNKNOWN_KEY_VERSION' as const,
      keyVersion: 4,
      detail: '',
    };
    countVaultDecision(into, decision);
    countVaultDecision(into, decision);
    expect([...into.values()]).toEqual([
      {
        operation: 'OPEN',
        outcome: 'REFUSED',
        refusal: 'UNKNOWN_KEY_VERSION',
        keyVersion: 4,
        count: 2,
      },
    ]);
  });
});

describe('installKeyringAtBoot — the keyring the API and the worker actually get', () => {
  /*
   * ── THE DEFECT ────────────────────────────────────────────────────────────
   *
   * `installVaultKeyring` and `loadVaultKeyring` shipped with exactly ONE
   * production caller between them: the rotation CLI. So in the API and the
   * worker the IMPLICIT keyring was always in force and the `VaultKey` state
   * machine was inert — `seal()` wrote keyVersion 1 while the registered ACTIVE
   * key was v2, `open()` of a swept secret threw UNKNOWN_KEY_VERSION, and a key
   * marked COMPROMISED was still used to seal new secrets. The documented
   * remediation in docs/key-rotation.md was a no-op.
   */
  const row = (version: number, state: string) =>
    ({ keyId: `key_${version}`, version, state, provider: 'LOCAL', providerRef: null }) as never;

  const silent = () => {
    const lines: Array<{ level: string; message: string }> = [];
    return {
      lines,
      log: (level: 'info' | 'error', _fields: Record<string, unknown>, message: string) =>
        lines.push({ level, message }),
    };
  };

  afterEach(() => {
    resetVaultKeyring();
  });

  it('installs the REGISTERED keyring, so the ACTIVE key is the one that seals', async () => {
    const io = silent();
    const keyring = await installKeyringAtBoot(
      { listVaultKeys: () => Promise.resolve([row(1, 'READABLE'), row(2, 'ACTIVE')]) },
      io.log,
    );

    expect(keyring.source).toBe('REGISTERED');
    // And it is the one in force for the synchronous doors, which is the half
    // that was missing: a keyring loaded and not installed changes nothing.
    expect(currentKeyring().source).toBe('REGISTERED');
    expect(currentKeyring().keys.map((k) => `v${k.version}:${k.state}`)).toEqual([
      'v1:READABLE',
      'v2:ACTIVE',
    ]);
    expect(io.lines).toEqual([{ level: 'info', message: 'vault keyring installed' }]);
  });

  it('is SILENT and implicit for zero rows, which is every install today', async () => {
    const io = silent();
    const keyring = await installKeyringAtBoot({ listVaultKeys: () => Promise.resolve([]) }, io.log);

    expect(keyring.source).toBe('IMPLICIT');
    // No line on every boot saying "nothing is registered" — a log nobody reads
    // is a log that hides the one that matters.
    expect(io.lines).toEqual([]);
  });

  it('LOGS AN ERROR and stays implicit on malformed rows, rather than throwing at module load', async () => {
    /*
     * ── WHERE THE FAIL-SAFE / FAIL-CLOSED LINE IS, AND WHY IT MOVED ──────────
     *
     * The first version of this threw, and `apps/worker/src/index.ts` turned
     * that into `process.exit(1)` — which killed the TEST RUNNER, because both
     * boot paths install at module load and merely importing the worker ran it.
     *
     * The reasoning behind the change, not just the mechanics: the dangerous
     * case is a load that SUCCEEDS and is not installed, which is the original
     * defect and seals new secrets under a version the operator believes is
     * retired. A load that FAILED registered nothing, so there is no second
     * keyring to disagree with — the implicit one is v1 and the product behaves
     * as it did before any rows existed. A loud log beats an outage there.
     */
    const io = silent();
    const keyring = await installKeyringAtBoot(
      { listVaultKeys: () => Promise.resolve([row(1, 'ACTIVE'), row(1, 'READABLE')]) },
      io.log,
    );

    expect(keyring.source).toBe('IMPLICIT');
    expect(currentKeyring().source).toBe('IMPLICIT');
    expect(io.lines[0]?.level).toBe('error');
    // The operator has to be told a ROTATION will not take effect, not merely
    // that something was wrong: that is the consequence they can act on.
    expect(io.lines[0]?.message).toMatch(/rotation will NOT take effect/);
  });

  it('never puts key material in a log line', async () => {
    const fields: Array<Record<string, unknown>> = [];
    await installKeyringAtBoot(
      { listVaultKeys: () => Promise.resolve([row(1, 'ACTIVE')]) },
      (_level, f) => fields.push(f),
    );

    // The versions and their states are operator-facing facts. A key, a
    // providerRef's contents, or anything resembling material is not.
    const serialised = JSON.stringify(fields);
    expect(serialised).not.toContain('key_1');
    expect(serialised).toContain('v1:ACTIVE');
  });
});
