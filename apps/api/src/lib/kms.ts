/**
 * WHERE A VAULT KEY'S MATERIAL COMES FROM. The provider seam.
 *
 * ─── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
 *
 * `apps/api/src/lib/vault.ts` read `env.VAULT_MASTER_KEY` INLINE, inside
 * `keyForVersion`, with `if (version === 1)` around it and a throw for
 * everything else. So there was exactly one place material could come from,
 * exactly one version that could have any, and no way to NAME a second — which
 * is why "rotate the master key" and "make every sealed secret in the install
 * permanently unreadable" were the same operation.
 *
 * This file is the answer to "which key is this, and who holds it". It is
 * deliberately separate from the cipher: `vault.ts` decides WHICH key may open
 * a value and performs the AES, and this file decides WHERE that key's bytes
 * come from. Two concerns, two files, because the cloud providers change the
 * second one and must not be able to reach the first.
 *
 * ─── WRAP AND UNWRAP A DATA KEY. NEVER SEND A SECRET TO A KMS ───────────────
 *
 * {@link ConfiguredKeyProvider} wraps and unwraps A DATA KEY and nothing else.
 * A customer's vault plaintext — a database password, a Stripe test key, a
 * session cookie — never crosses this interface and never leaves this process.
 * The envelope pattern is not a performance choice: an interface that took a
 * plaintext would put every customer secret in a third party's request log the
 * first time somebody enabled debug logging, and an interface that cannot do
 * that cannot have that accident.
 *
 * ─── AN UNIMPLEMENTED PROVIDER REFUSES AT CONFIGURATION TIME ────────────────
 *
 * {@link configureKeyProvider} is called when the keyring is BUILT, not when a
 * value is opened. `KMS` is a declared seam with `implemented: false`, so a
 * deployment that registers a KMS key is told so while it is registering it —
 * rather than discovering months later, in a decrypt error, that nothing could
 * ever have opened those rows. A stub that silently returned the local master
 * key would be worse than either: it would make `provider = KMS` a lie that
 * worked.
 *
 * ─── THERE IS NO KEY-CHECK VALUE HERE, AND THAT IS A DECISION ───────────────
 *
 * A key-check value — an HMAC of the material, truncated, printed so an
 * operator can confirm the deployment holds the key they think it does — is a
 * genuinely useful thing and this file does not have one. A fingerprint of key
 * material is a hash of key material, and a hash of key material is one of the
 * things that may never be logged: not truncated, not hashed, not in an error
 * path. So material identity is established by the PROVIDER and the KEY ID
 * (both labels), never by anything derived from the bytes.
 *
 * ─── AND IT NEVER PRINTS WHAT IT HOLDS ──────────────────────────────────────
 *
 * {@link KeyMaterial} keeps its bytes in a module-private WeakMap for the
 * reason `OpenedSecret` does: the bytes are not a property of the object, so
 * `console.log`, `JSON.stringify`, `util.inspect`, a template literal and a
 * spread all find the mask instead of the key. The bytes come out of exactly
 * one function, {@link useKeyMaterial}, so "where does this key go" is a grep
 * for one name.
 */

import { SECRET_MASK } from '@qaai/shared';
/*
 * Reached by relative path, and that is a defect with a one-line fix rather
 * than a preference. `packages/shared/src/sealed.ts` is NOT in
 * `packages/shared/src/index.ts` — the barrel's own header records what this
 * bypass costs — so `@qaai/shared` does not publish these names and
 * `@qaai/shared/sealed` is not in that package's `exports` map either. The fix
 * is `export * from './sealed';` in that barrel, which is in this round's
 * needsFromOtherFiles; until it lands, the alternative is restating the
 * provider vocabulary here, which is the second-vocabulary defect and worse.
 */
import { VAULT_KEY_PROVIDERS, type VaultKeyProvider } from '../../../../packages/shared/src/sealed.js';
import { env } from '../env.js';

/** AES-256 takes a 256-bit key. Anything else is a misconfiguration, not a short key. */
export const KEY_MATERIAL_BYTES = 32;

// ─── The material ───────────────────────────────────────────────────────────

/**
 * The key bytes, held OUTSIDE the objects that represent them.
 *
 * Same mechanism as `OpenedSecret` in packages/shared/src/sealed.ts and for the
 * same reason: a `#private` field stops a spread and not `util.inspect`, and a
 * masked getter stops neither. Because the bytes are not a property, there is
 * nothing for a structured-log serialiser to reach.
 */
const MATERIAL = new WeakMap<KeyMaterial, Buffer>();

/**
 * ONE VAULT KEY'S BYTES. A key that resists being written down.
 *
 * It carries `provider`, `keyId` and `byteLength` in the clear, deliberately:
 * those three make every failure in this file and in `vault.ts` reportable
 * without quoting a byte of the key, which is the property rule 11 asks for and
 * the thing that is missing wherever an error path ends up printing one.
 */
export class KeyMaterial {
  /** Who holds it. A label. */
  readonly provider: VaultKeyProvider;
  /** Which key it is. A label, written into every envelope sealed under it. */
  readonly keyId: string;
  /** How many bytes. Not the bytes. Lets a caller say "that key is the wrong size". */
  readonly byteLength: number;

  constructor(bytes: Buffer, provider: VaultKeyProvider, keyId: string) {
    this.provider = provider;
    this.keyId = keyId;
    this.byteLength = bytes.length;
    MATERIAL.set(this, bytes);
  }

  /** `${material}` and string concatenation. */
  toString(): string {
    return SECRET_MASK;
  }

  /** `+material`, and anything that prefers a primitive. */
  valueOf(): string {
    return SECRET_MASK;
  }

  /** `JSON.stringify`, which is what most structured loggers are. */
  toJSON(): { provider: VaultKeyProvider; keyId: string; byteLength: number; material: string } {
    return {
      provider: this.provider,
      keyId: this.keyId,
      byteLength: this.byteLength,
      material: SECRET_MASK,
    };
  }

  /**
   * `console.log` and `util.inspect`, which do NOT go through `toJSON` and
   * would otherwise print the object's shape. `Symbol.for` rather than an
   * import of `node:util`, so the hook costs this file no dependency.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `KeyMaterial(${this.provider} ${this.keyId} ${SECRET_MASK})`;
  }

  get [Symbol.toStringTag](): string {
    return 'KeyMaterial';
  }
}

/**
 * Use the key bytes inside a callback, and let them go.
 *
 * THE ONLY WAY OUT. There is no `revealKeyMaterial` counterpart to
 * `revealSecret`: every API that needs a key here is `createCipheriv` /
 * `createDecipheriv`, both of which take it as an argument and neither of which
 * needs it to outlive the call. So the bytes never become a variable in a
 * caller's scope, cannot be captured by a closure that outlives the cipher, and
 * cannot still be in a local when something later serialises the frame.
 *
 * It does not catch: an exception from `fn` propagates unchanged, because
 * swallowing a cipher failure here would make "the ciphertext did not
 * authenticate" look like "the key was not available", and those are different
 * incidents.
 */
export function useKeyMaterial<T>(material: KeyMaterial, fn: (bytes: Buffer) => T): T {
  const bytes = MATERIAL.get(material);
  if (bytes === undefined) {
    // Reachable only if a KeyMaterial crossed a structured-clone boundary,
    // which strips the WeakMap entry. Fail closed, and say what happened
    // without quoting anything.
    throw new Error(
      `KeyMaterial for ${material.provider} key "${material.keyId}" carries no bytes — it has ` +
        'been serialised and must be unwrapped again from its provider.',
    );
  }
  return fn(bytes);
}

// ─── The refusals ───────────────────────────────────────────────────────────

/**
 * Every way obtaining key material can fail. Closed, because each one is a
 * case a caller must handle and `catch {}` is not handling.
 *
 * These are NOT members of `SEAL_REFUSALS` in packages/shared/src/sealed.ts and
 * could not be: that file has no cryptography and no I/O by design, so it
 * cannot name a failure that only exists where the material does.
 * `VaultRefusal` in vault.ts is the union of the two lists, which is the one
 * place a caller has to look.
 */
export const KMS_REFUSALS = [
  /** The provider is a declared seam with no implementation. Refused at CONFIGURATION time. */
  'PROVIDER_NOT_IMPLEMENTED',
  /** The provider is implemented and this deployment has not given it what it needs. */
  'MATERIAL_UNAVAILABLE',
  /** Material was found and is not a 256-bit key. A misconfiguration, never a short key. */
  'MATERIAL_WRONG_LENGTH',
  /** The key row and the provider disagree about whether there is a reference to follow. */
  'PROVIDER_REF_MISMATCH',
  /** The provider cannot wrap a new data key — see the LOCAL adapter's note. */
  'WRAPPING_NOT_AVAILABLE',
] as const;
export type KmsRefusal = (typeof KMS_REFUSALS)[number];

/**
 * A refusal, with a detail an operator can act on.
 *
 * `detail` NEVER CONTAINS KEY MATERIAL, a plaintext, a nonce or a ciphertext —
 * not truncated and not hashed. It names the refusal, the provider and the key
 * id, all three of which are labels. `kms.test.ts` asserts that for every
 * member of {@link KMS_REFUSALS}.
 */
export interface KmsFailure {
  readonly ok: false;
  readonly refusal: KmsRefusal;
  readonly detail: string;
}

export type KmsResult<T> = { readonly ok: true; readonly value: T } | KmsFailure;

function fail(refusal: KmsRefusal, detail: string): KmsFailure {
  return { ok: false, refusal, detail };
}

// ─── The seam ───────────────────────────────────────────────────────────────

/** What a key row tells a provider. A reference, never material. */
export interface KeyProviderRequest {
  /** The `VaultKey.keyId` label. */
  readonly keyId: string;
  /**
   * The `VaultKey.providerRef` column: an identifier the provider understands.
   * Null for LOCAL — `registerVaultKeySchema` refuses a LOCAL key that has one,
   * because that column must never become a place to put key material.
   */
  readonly providerRef: string | null;
}

/**
 * A provider that has been CONFIGURED and may therefore be asked for material.
 *
 * Obtaining this value is the configuration-time check. A caller that holds one
 * knows the provider is implemented and that this deployment has what it needs;
 * a caller that does not hold one has a named refusal instead, and never a
 * half-working provider.
 */
export interface ConfiguredKeyProvider {
  readonly provider: VaultKeyProvider;
  /**
   * The data key for one registered vault key.
   *
   * "Unwrap" rather than "get" because that is what the cloud implementations
   * will do: the wrapped data key goes to the KMS and comes back unwrapped, and
   * the customer's secret never goes anywhere. For LOCAL there is nothing
   * wrapped and the master key IS the data key, which is the degenerate case of
   * the same shape rather than a different one.
   */
  unwrapDataKey(request: KeyProviderRequest): KmsResult<KeyMaterial>;
  /**
   * Wrap a NEW data key, returning the reference to store in
   * `VaultKey.providerRef`.
   *
   * Returns a refusal for LOCAL; see {@link LOCAL_KEY_PROVIDER}. A provider that
   * cannot wrap cannot mint a key, which is the honest answer rather than a
   * generated key nothing can unwrap later.
   */
  wrapDataKey(keyId: string): KmsResult<string>;
}

/**
 * One declared provider: what it is, whether it exists, and how to configure it.
 *
 * `implemented` is a field rather than a thrown error so that a cockpit can
 * LIST the providers and say which are available without attempting to
 * configure each one — and so that "KMS is a seam" is a fact in a table rather
 * than a sentence in a commit message.
 */
export interface VaultKeyProviderAdapter {
  readonly provider: VaultKeyProvider;
  readonly implemented: boolean;
  /** One sentence for an operator choosing a provider. */
  readonly what: string;
  /** Called at configuration time. Returns a refusal rather than throwing. */
  configure(io: KeyProviderIo): KmsResult<ConfiguredKeyProvider>;
}

/**
 * Everything a provider reads from outside this process, as one narrow
 * interface — so every test in `kms.test.ts` runs with a fake and none of them
 * needs a key, a network or an environment variable.
 */
export interface KeyProviderIo {
  /**
   * The deployment's master key, base64, exactly as `VAULT_MASTER_KEY` holds
   * it. A string and not a Buffer because that is what the env var is, and
   * because the length check belongs in one place rather than at each caller.
   */
  localMasterKeyBase64(): string;
}

/**
 * The default IO: the environment variable this deployment already has.
 *
 * NO NEW ENVIRONMENT VARIABLE. `VAULT_MASTER_KEY` stays exactly as it is and
 * keeps opening everything it opened before. A customer's key identifier
 * belongs on the `VaultKey` row they own — `providerRef` — and not in
 * `process.env`, which is why the KMS seam below adds no variable either.
 */
export const DEFAULT_KEY_PROVIDER_IO: KeyProviderIo = {
  localMasterKeyBase64: () => env.VAULT_MASTER_KEY,
};

// ─── LOCAL: the provider that exists today ──────────────────────────────────

/**
 * THE LOCAL PROVIDER. The deployment's own master key.
 *
 * ── Every LOCAL key has the SAME material, and that is not a shortcut ───────
 *
 * `registerVaultKeySchema` refuses a LOCAL key with a `providerRef`, and
 * `VaultKey` has no column for wrapped material — both on purpose, so that this
 * table can never become somewhere key bytes live. The consequence is worth
 * stating plainly because the next reader will otherwise assume more than is
 * true: TWO LOCAL KEY VERSIONS IN ONE DEPLOYMENT ARE BACKED BY THE SAME BYTES.
 *
 * So what does a LOCAL-to-LOCAL rotation actually achieve? It re-seals rows
 * under a new binding or a new algorithm, and it moves rows off a version an
 * operator intends to RETIRE. Those are real, and the sweep that does them is
 * the mechanism every other rotation needs.
 *
 * What it does NOT achieve, and no comment in this file will claim otherwise:
 * IT DOES NOT REMEDIATE A LEAKED `VAULT_MASTER_KEY`. Re-sealing under a second
 * key derived from the same leaked bytes is security theatre. The available
 * response to a leaked master key is the one `vault.ts` implements: mark the key
 * COMPROMISED, enumerate every value it sealed, replace `VAULT_MASTER_KEY`, and
 * RE-ENTER those values — because a ciphertext a leaked key protected must be
 * considered disclosed, and a disclosed secret is not fixed by re-encrypting it.
 * A rotation that keeps the material and changes the version is for the
 * superseded case, and the compromised case has its own path.
 */
export const LOCAL_KEY_PROVIDER: VaultKeyProviderAdapter = {
  provider: 'LOCAL',
  implemented: true,
  what:
    "The deployment's own VAULT_MASTER_KEY. Every LOCAL key version is backed by the same bytes, " +
    'so a LOCAL-to-LOCAL rotation re-seals under a new binding and does NOT remediate a leaked ' +
    'master key.',
  configure(io: KeyProviderIo): KmsResult<ConfiguredKeyProvider> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(io.localMasterKeyBase64(), 'base64');
    } catch {
      // Buffer.from does not normally throw on bad base64 — it drops the
      // unparseable tail — so this arm exists for an IO that throws rather than
      // for a malformed string. The length check below is what catches the
      // malformed string, which is why it is not an `else`.
      return fail(
        'MATERIAL_UNAVAILABLE',
        'The LOCAL provider could not read this deployment\'s master key. Set VAULT_MASTER_KEY.',
      );
    }
    if (bytes.length !== KEY_MATERIAL_BYTES) {
      /*
       * Refused at CONFIGURATION time, which is the whole point of this
       * function. A 31-byte master key used to surface as a throw from
       * `keyForVersion` the first time somebody opened a secret — an hour after
       * boot, in a request, as a 500.
       */
      return fail(
        'MATERIAL_WRONG_LENGTH',
        `The LOCAL master key decodes to ${bytes.length} bytes and AES-256 needs ` +
          `${KEY_MATERIAL_BYTES}. Generate one with: openssl rand -base64 ${KEY_MATERIAL_BYTES}`,
      );
    }
    return {
      ok: true,
      value: {
        provider: 'LOCAL',
        unwrapDataKey(request: KeyProviderRequest): KmsResult<KeyMaterial> {
          if (request.providerRef !== null) {
            /*
             * Refused rather than ignored. A LOCAL row with a reference is a row
             * somebody edited by hand or a row written by a build that treated
             * that column as material storage; either way the row does not mean
             * what the schema says it means, and opening it anyway would make
             * the inconsistency permanent and invisible.
             */
            return fail(
              'PROVIDER_REF_MISMATCH',
              `LOCAL key "${request.keyId}" carries a provider reference. A LOCAL key's material ` +
                'is the deployment master key and that column must never hold key material.',
            );
          }
          return { ok: true, value: new KeyMaterial(bytes, 'LOCAL', request.keyId) };
        },
        wrapDataKey(keyId: string): KmsResult<string> {
          /*
           * A NAMED REFUSAL AND NOT A GENERATED KEY. The LOCAL provider has
           * nowhere to put a wrapped data key: `VaultKey` has no column for one
           * and `registerVaultKeySchema` refuses a LOCAL `providerRef`. Minting
           * bytes here and returning them as a "reference" would put key
           * material in the database, which is the one thing that table is
           * documented never to hold.
           */
          return fail(
            'WRAPPING_NOT_AVAILABLE',
            `The LOCAL provider cannot wrap a data key for "${keyId}": a LOCAL key's material is ` +
              'the deployment master key, there is nothing to wrap, and VaultKey holds no key ' +
              'material. Registering a second LOCAL version re-seals under a new binding; it does ' +
              'not give those rows different bytes.',
          );
        },
      },
    };
  },
};

// ─── KMS: the declared seam ─────────────────────────────────────────────────

/**
 * THE KMS PROVIDER. Declared, unimplemented, and refused BY NAME.
 *
 * ── Why a declared seam rather than a stub ─────────────────────────────────
 *
 * A stub that returned the local master key would make `provider = KMS` a lie
 * that worked: the rows would open, the cockpit would say the key lives in a
 * KMS, and the material would be in the environment file the whole time. A
 * stub that returned a zero key would make every row sealed under it
 * unopenable, and the failure would arrive months later as a decrypt error.
 *
 * So this adapter refuses, at the moment a keyring containing a KMS row is
 * CONFIGURED, and the refusal names what is missing. `vault.ts` treats that
 * refusal as fatal for the whole keyring rather than for one key, because a
 * keyring that is quietly missing one version is a keyring whose sweep will
 * report those rows `unopenable` and whose operator will retire a key that is
 * still the only thing that can read them.
 *
 * ── What implementing it needs ─────────────────────────────────────────────
 *
 * A `configure` that returns a provider whose `unwrapDataKey` sends
 * `request.providerRef` — which the row already carries, and which is a key
 * NAME and not material — to the cloud provider, and whose `wrapDataKey` asks
 * that provider to generate and wrap a new data key. No plaintext secret
 * crosses either call, and no environment variable is added: the reference is
 * on the row the customer owns.
 */
export const KMS_KEY_PROVIDER: VaultKeyProviderAdapter = {
  provider: 'KMS',
  implemented: false,
  what:
    'A key whose material never enters this process; the row carries a reference the provider ' +
    'understands. DECLARED AND NOT IMPLEMENTED — registering a KMS key is refused by name.',
  configure(): KmsResult<ConfiguredKeyProvider> {
    return fail(
      'PROVIDER_NOT_IMPLEMENTED',
      'The KMS key provider is a declared seam with no implementation in this build. Register the ' +
        'key as LOCAL, or do not register it: a KMS key in this deployment would seal values ' +
        'nothing could open.',
    );
  },
};

/**
 * The compiler-enforced presence record. A `Record<VaultKeyProvider, …>` cannot
 * be written without naming every member, so a third provider is a type error
 * here rather than a provider with no `configure` — and `undefined.configure`
 * is a crash at keyring load, which is a worse version of the refusal this
 * table exists to produce.
 *
 * Both halves, because one without the other passes while the two disagree:
 * this is the compile-time half and `vaultKeyProviderSchema.options` in
 * packages/shared/src/schemas.ts is the run-time half. `kms.test.ts` asserts
 * the keys of this table and `VAULT_KEY_PROVIDERS` are the same set.
 */
export const VAULT_KEY_PROVIDER_ADAPTERS = {
  LOCAL: LOCAL_KEY_PROVIDER,
  KMS: KMS_KEY_PROVIDER,
} as const satisfies Record<VaultKeyProvider, VaultKeyProviderAdapter>;

/** Every declared provider, for a cockpit list. Derived, so it cannot drift. */
export const DECLARED_KEY_PROVIDERS: readonly VaultKeyProviderAdapter[] = VAULT_KEY_PROVIDERS.map(
  (provider) => VAULT_KEY_PROVIDER_ADAPTERS[provider],
);

/**
 * CONFIGURE ONE PROVIDER. The configuration-time check, and the only door.
 *
 * Returns a refusal and never throws, because its caller is a keyring load that
 * must be able to report "this deployment cannot open version 3, and here is
 * why" rather than failing to boot. FAILS CLOSED: there is no arm that returns
 * a provider when `implemented` is false, and no arm that falls through to
 * LOCAL for an unknown provider — an exception handler that ends in "use the
 * master key" is the defect pattern this whole file is arranged against.
 */
export function configureKeyProvider(
  provider: VaultKeyProvider,
  io: KeyProviderIo = DEFAULT_KEY_PROVIDER_IO,
): KmsResult<ConfiguredKeyProvider> {
  const adapter = VAULT_KEY_PROVIDER_ADAPTERS[provider];
  return adapter.configure(io);
}
