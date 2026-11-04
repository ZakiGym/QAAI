/**
 * Secrets vault (§1) — AES-256-GCM, and the keyring that makes a compromise
 * remediable.
 *
 * ─── WHAT THIS FILE USED TO SAY, AND WHY THAT WAS THE DEFECT ────────────────
 *
 * Its own header described rotation as "re-encrypting lazily instead of in one
 * migration" and `keyForVersion` read `if (version === 1)` with a throw for
 * everything else. `needsRotation` existed and HAD NO CALLER. There was no
 * sweeper, lazy or otherwise. So the file documented a capability it did not
 * have, and the practical consequence was the sentence nobody wants in an
 * incident review: A COMPROMISE OF THE MASTER KEY COULD NOT BE REMEDIATED —
 * rotating it made every sealed secret in the install permanently unreadable,
 * so the only available response to a leaked key was to keep using it.
 *
 * That paragraph is rewritten rather than appended to, because a doc comment
 * that contradicts the code under it is the worst kind of defect in a security
 * file: the comment is what the next reviewer trusts instead of reading.
 *
 * ─── WHAT IT DOES NOW ───────────────────────────────────────────────────────
 *
 * MANY KEYS READABLE, EXACTLY ONE WRITABLE. A value is opened with the key its
 * stored version names; a new value is sealed with the single ACTIVE key. The
 * vocabulary and the state rules live in `packages/shared/src/sealed.ts`
 * (`selectSealingKey`, `selectOpeningKey`, `resealVerdict`,
 * `VAULT_KEY_STATE_RULES`) and are not restated here; where the key's BYTES
 * come from lives in `./kms.ts`. This file is the cipher, the keyring, the
 * brake and the count.
 *
 * AN UNKNOWN VERSION IS A NAMED REFUSAL AND NEVER A DECRYPT ATTEMPT. It was a
 * throw from inside the decrypt path; it is now `UNKNOWN_KEY_VERSION` decided
 * before any cipher is constructed.
 *
 * `needsRotation` HAS A CALLER AND A REAL ANSWER. It used to compare against a
 * module constant — `keyVersion < CURRENT_KEY_VERSION` — which returned FALSE
 * for a version from a newer build, so a row this deployment could not open was
 * reported as not needing anything. It now asks `resealVerdict` against the
 * deployment's own keys, and `apps/api/src/scripts/rotate-vault-key.ts` is the
 * caller.
 *
 * ─── THE BACKWARD-COMPATIBLE STATE, WHICH IS EVERY INSTALL TODAY ────────────
 *
 * `VaultKey` IS EMPTY IN EVERY EXISTING DEPLOYMENT. The sealing migration
 * deliberately seeds no row, not even version 1, because a seeded row would be
 * a migration asserting — about a database it cannot read — that this
 * deployment's master key is the one that sealed its existing secrets.
 *
 * So the default keyring is {@link implicitKeyring}: ONE key, version 1, state
 * ACTIVE, provider LOCAL, backed by `VAULT_MASTER_KEY`. That is exactly the
 * behaviour this file had before, expressed in the new vocabulary, and it is
 * why nothing has to be registered for the product to keep working. A
 * deployment that registers keys gets {@link loadVaultKeyring} instead, and
 * `installVaultKeyring` is the one door between the two.
 *
 * ─── THE BRAKE, AND THE TWO REFUSALS THAT DO NOT HAVE ONE ───────────────────
 *
 * `SECURITY_CONTROL_BRAKES.VAULT_KEY_ROTATION` defaults to ENFORCE and
 * `controlMode` resolves it. The control is GLOBAL rather than per-org because
 * `VaultKey` is a global table, so the mode is resolved ONCE when the keyring
 * is loaded rather than per request; reading one tenant's setting to decide a
 * deployment-wide question would be a brake that means different things
 * depending on who asked.
 *
 * What OBSERVE actually relaxes is ONE refusal: `KEY_NOT_READABLE`, a RETIRED
 * key. Retiring a key while rows are still sealed under it is an operator
 * mistake, the data is not disclosed, and an install should not go down for it
 * — so OBSERVE counts it as WOULD_REFUSE and opens the value.
 *
 * TWO REFUSALS HAVE NO BRAKE, DELIBERATELY:
 *   UNKNOWN_KEY_VERSION — there is no key to open it with. "Allow" is not an
 *                         available behaviour, so a mode cannot offer it.
 *   KEY_COMPROMISED     — opening data under a key known to have leaked is the
 *                         exact thing the state exists to stop. A brake here
 *                         would be an off switch on the only control that
 *                         matters during an incident.
 * Both are still COUNTED, because a refusal applied without being counted is
 * one of the lies this product cannot afford.
 *
 * ─── AND IT NEVER PRINTS WHAT IT PROTECTS ───────────────────────────────────
 *
 * No plaintext, ciphertext, nonce or key byte reaches a message, a detail
 * string, a tally label or an error. {@link VAULT_REFUSAL_SENTENCE} is the one
 * sentence a caller may surface — identical for every refusal, because a
 * refusal that varies tells an attacker whether a key exists, whether a secret
 * is set, or whether a ciphertext authenticated. The operator-facing `detail`
 * carries the refusal name, the field and the key VERSION, which is an integer.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SECURITY_CONTROL_BRAKES, controlMode } from '@qaai/shared';
import type { ControlMode } from '@qaai/shared';
/*
 * Reached by relative path for the reason ./kms.ts records above its own
 * import: `packages/shared/src/sealed.ts` is not in
 * `packages/shared/src/index.ts`, so `@qaai/shared` does not publish these
 * names and `@qaai/shared/sealed` is not in that package's `exports` map. The
 * fix is one barrel line and it is in this round's needsFromOtherFiles. The
 * alternative — restating the key-state rules here — is the second-vocabulary
 * defect, and for a table that decides which keys may open a secret it is the
 * worst possible place to have two copies.
 */
import {
  SEAL_REFUSALS,
  SEAL_WRITE_ALGORITHM,
  OpenedSecret,
  aadFor,
  isSealedFieldKey,
  parseEnvelope,
  resealVerdict,
  selectOpeningKey,
  selectSealingKey,
  serialiseEnvelope,
  useSecret,
} from '../../../../packages/shared/src/sealed.js';
import type {
  SealAad,
  SealRefusal,
  VaultKeyRef,
  VaultKeyState,
} from '../../../../packages/shared/src/sealed.js';
import { KMS_REFUSALS, configureKeyProvider, useKeyMaterial } from './kms.js';
import type {
  ConfiguredKeyProvider,
  KeyMaterial,
  KeyProviderIo,
  KmsRefusal,
  KmsResult,
} from './kms.js';
import type { VaultKeyProvider } from '../../../../packages/shared/src/sealed.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM standard
const TAG_LENGTH = 16;

/**
 * The version the implicit keyring uses, and the version every value already in
 * every customer's database is sealed under.
 *
 * NOT "the current version". The current version is whatever the deployment's
 * single ACTIVE key says it is, which is the whole point of the keyring; this
 * constant is only the version the IMPLICIT keyring claims when `VaultKey` is
 * empty. The old `CURRENT_KEY_VERSION` meant both things at once, which is how
 * `needsRotation` came to compare a stored version against a compile-time
 * constant and answer FALSE for a version from the future.
 */
export const IMPLICIT_KEY_VERSION = 1;

/**
 * The key id the implicit keyring reports.
 *
 * A label and never material. It appears in `detail` strings and in the
 * rotation script's output so an operator can tell "this deployment has
 * registered nothing and is on its master key" from "this deployment has a
 * registered version 1", which are different situations with the same version
 * number.
 */
export const IMPLICIT_KEY_ID = 'local-master';

// ─── The refusals ───────────────────────────────────────────────────────────

/**
 * The failures that exist only where the cipher and the key material do.
 *
 * `SEAL_REFUSALS` cannot name these: `sealed.ts` has no cryptography and no I/O
 * by design, so it has no vocabulary for "the ciphertext did not authenticate"
 * or "two rows claim one version".
 *
 * CIPHER_REJECTED IS ONE MEMBER AND NOT THREE, and that is the no-oracle rule
 * rather than laziness. "Wrong key", "tampered ciphertext" and "additional data
 * does not match" are indistinguishable to a caller on purpose: telling them
 * apart tells an attacker which of their guesses was closer, and the previous
 * version of this file already carried that reasoning in a comment.
 */
export const VAULT_ONLY_REFUSALS = [
  /** GCM rejected it. Wrong key, tampered bytes or mismatched AAD — deliberately indistinguishable. */
  'CIPHER_REJECTED',
  /** Two key rows claim one version. The database forbids it; a keyring built by hand may not. */
  'DUPLICATE_KEY_VERSION',
] as const;
export type VaultOnlyRefusal = (typeof VAULT_ONLY_REFUSALS)[number];

/** Every way a vault operation can fail: the shared list, the provider list, and these two. */
export type VaultRefusal = SealRefusal | KmsRefusal | VaultOnlyRefusal;

/**
 * The three lists concatenated, so a test can walk every refusal and assert
 * that none of them can be reported in a way that quotes a secret.
 *
 * DERIVED from the three sources rather than written out, and this comment says
 * so rather than implying the list guards anything: adding a member to
 * `SEAL_REFUSALS` adds it here automatically, which is correct — the thing that
 * must not drift is {@link VAULT_REFUSAL_REPORTS}, and that one is a
 * `Record<VaultRefusal, …>` the compiler checks.
 */
export const VAULT_REFUSALS: readonly VaultRefusal[] = [
  ...SEAL_REFUSALS,
  ...KMS_REFUSALS,
  ...VAULT_ONLY_REFUSALS,
];

/**
 * THE ONE SENTENCE A CALLER MAY SURFACE. Identical for every refusal.
 *
 * Rule 12: no control may be an oracle. A message that said "no key for version
 * 3" would say how many keys this deployment has; one that said "the tag did
 * not verify" would say the key was right and the bytes were not; one that
 * named the secret would say which secrets are set. So there is one sentence,
 * and the operator-facing distinctions live in `VaultDecision.detail`, which
 * goes to an operator surface and never to a response body.
 */
export const VAULT_REFUSAL_SENTENCE =
  'That value could not be opened with a key this deployment holds. An operator can see which ' +
  'key version it needs, and whether that key has been rotated out, retired or compromised, in ' +
  'the vault key list.';

/**
 * What one refusal means to an OPERATOR, and whether re-entry is the remedy.
 *
 * `reEntryRequired` is the fact item 4 of this round turns on. A value sealed
 * under a COMPROMISED key must be considered DISCLOSED: its ciphertext was
 * protected by bytes that leaked, so re-sealing it under a new key changes
 * nothing about who has read it. The remedy is for the customer to enter a NEW
 * value, and reporting anything else would be security theatre.
 *
 * A compiler-enforced `Record<VaultRefusal, …>`: a new refusal in any of the
 * three source lists is a type error here rather than a refusal with no
 * operator meaning and an undefined remedy — and `undefined.reEntryRequired`
 * read as falsy would quietly tell an operator a compromised secret is fine.
 */
export interface VaultRefusalReport {
  /** One line for the operator. Never a secret, a nonce or a byte of a key. */
  readonly why: string;
  /**
   * True when the only honest remedy is a NEW value from the customer, because
   * the old one must be considered disclosed or is unrecoverable.
   */
  readonly reEntryRequired: boolean;
}

export const VAULT_REFUSAL_REPORTS = {
  MALFORMED_ENVELOPE: {
    why: 'The stored value is not an envelope this build can read.',
    reEntryRequired: true,
  },
  UNKNOWN_ENVELOPE_VERSION: {
    why: 'The stored value was written by a newer build. This is a rollback; deploy forward again.',
    reEntryRequired: false,
  },
  UNKNOWN_ALGORITHM: {
    why: 'The envelope names a cipher this build does not have. Nothing was attempted.',
    reEntryRequired: false,
  },
  UNKNOWN_KEY_VERSION: {
    why: 'No key in this deployment has that version, so the value cannot be opened or re-sealed.',
    reEntryRequired: true,
  },
  KEY_NOT_READABLE: {
    why: 'The key is RETIRED. A key is only retired once a sweep has proved nothing is sealed under it; this value is evidence that was not true.',
    reEntryRequired: false,
  },
  KEY_COMPROMISED: {
    why: 'The key is COMPROMISED, so this value must be considered disclosed. Re-sealing it under a new key would change nothing about who has read it.',
    reEntryRequired: true,
  },
  NO_WRITABLE_KEY: {
    why: 'No key is ACTIVE, so nothing may be sealed. Exactly one key must be ACTIVE.',
    reEntryRequired: false,
  },
  MORE_THAN_ONE_WRITABLE_KEY: {
    why: 'More than one key is ACTIVE. Which key sealed a value written now would be unknowable, so nothing is sealed.',
    reEntryRequired: false,
  },
  AAD_MISMATCH: {
    why: 'The stored value is bound to a different model, row or field than the caller asked for.',
    reEntryRequired: false,
  },
  NOT_A_SEALED_FIELD: {
    why: 'The caller named a model and field that is not a sealed field.',
    reEntryRequired: false,
  },
  PROVIDER_NOT_IMPLEMENTED: {
    why: 'That key names a provider this build does not implement, so nothing it sealed can be opened.',
    reEntryRequired: false,
  },
  MATERIAL_UNAVAILABLE: {
    why: "The key's provider is implemented and this deployment has not given it what it needs.",
    reEntryRequired: false,
  },
  MATERIAL_WRONG_LENGTH: {
    why: 'The key material is not a 256-bit key. This is a misconfiguration, not a short key.',
    reEntryRequired: false,
  },
  PROVIDER_REF_MISMATCH: {
    why: 'The key row and its provider disagree about whether there is a reference to follow.',
    reEntryRequired: false,
  },
  WRAPPING_NOT_AVAILABLE: {
    why: 'That provider cannot wrap a new data key, so it cannot mint one.',
    reEntryRequired: false,
  },
  CIPHER_REJECTED: {
    why: 'The cipher rejected the stored value. Wrong key, altered bytes or a different binding — deliberately indistinguishable.',
    reEntryRequired: true,
  },
  DUPLICATE_KEY_VERSION: {
    why: 'Two keys claim one version, so which of them sealed a value is unknowable.',
    reEntryRequired: false,
  },
} as const satisfies Record<VaultRefusal, VaultRefusalReport>;

/** A refusal with an operator-facing detail. Never material, plaintext or nonce. */
export interface VaultFailure {
  readonly ok: false;
  readonly refusal: VaultRefusal;
  readonly detail: string;
}

export type VaultResult<T> = { readonly ok: true; readonly value: T } | VaultFailure;

function fail(refusal: VaultRefusal, detail: string): VaultFailure {
  return { ok: false, refusal, detail };
}

/**
 * The error `open` and `seal` throw, for the call sites that already catch.
 *
 * A typed error and not a bare `Error`, so `apps/worker/src/vault.ts` can log
 * `err.refusal` — an enum member — instead of `err.message`, which is how a
 * cipher failure's text ends up in a log line. `message` is
 * {@link VAULT_REFUSAL_SENTENCE} and nothing else; `detail` is the operator
 * half and the caller decides where it goes.
 *
 * It carries no plaintext, no ciphertext, no nonce and no key. There is a test
 * for that, because "an error about a secret must be reportable without quoting
 * any part of it" is only true if somebody checks.
 */
export class VaultRefusalError extends Error {
  readonly refusal: VaultRefusal;
  readonly detail: string;
  readonly keyVersion: number | null;

  constructor(failure: VaultFailure, keyVersion: number | null) {
    super(VAULT_REFUSAL_SENTENCE);
    this.name = 'VaultRefusalError';
    this.refusal = failure.refusal;
    this.detail = failure.detail;
    this.keyVersion = keyVersion;
  }
}

// ─── The keyring ────────────────────────────────────────────────────────────

/**
 * One `VaultKey` row, as this module needs it.
 *
 * A STRUCTURAL SUPERSET of `VaultKeyRef` and not the Prisma type, so this file
 * does not depend on a generated client and a caller may hand in a projection.
 * NOTE for that caller, because this round has already paid for the mistake
 * once: every field here is REQUIRED. A `select` that dropped `state` would
 * make every key look ACTIVE to `selectSealingKey`, and a `select` that dropped
 * `providerRef` would make a LOCAL row with a stray reference open as if the
 * row were clean. A hand-copied projection inside a function is the same hazard
 * as a select-blind fake.
 */
export interface VaultKeyRow extends VaultKeyRef {
  readonly provider: VaultKeyProvider;
  readonly providerRef: string | null;
}

/** Where a keyring came from. The two are not interchangeable to an operator. */
export const KEYRING_SOURCES = ['IMPLICIT', 'REGISTERED'] as const;
export type KeyringSource = (typeof KEYRING_SOURCES)[number];

/**
 * THE KEYS THIS DEPLOYMENT HOLDS, plus the mode and the configured providers.
 *
 * `providers` holds a RESULT per provider rather than a provider, so a
 * configuration failure is carried to the point of use as a named refusal
 * instead of being thrown at load. That matters for the KMS seam: a keyring with
 * one unimplemented key must still be able to say WHICH key it cannot open,
 * and a throw at load would only be able to say that the deployment is broken.
 */
export interface VaultKeyring {
  readonly source: KeyringSource;
  readonly mode: ControlMode;
  readonly keys: readonly VaultKeyRow[];
  readonly providers: ReadonlyMap<VaultKeyProvider, KmsResult<ConfiguredKeyProvider>>;
}

/** The mode when nothing is stored. ENFORCE; stated here so it is discoverable. */
export const VAULT_ROTATION_DEFAULT_MODE: ControlMode =
  SECURITY_CONTROL_BRAKES.VAULT_KEY_ROTATION.fallback;

/**
 * THE KEYRING OF A DEPLOYMENT THAT HAS REGISTERED NOTHING, which is all of them.
 *
 * One LOCAL key, version {@link IMPLICIT_KEY_VERSION}, state ACTIVE. Opening a
 * version-1 value and sealing a new one both behave exactly as they did before
 * this file grew a keyring, which is the condition the whole change is held to:
 * `VaultKey` is empty in every existing install and no migration seeds it.
 *
 * It is a function and not a constant because `configureKeyProvider` reads the
 * environment, and a module-level constant would do that at import time — which
 * is how a 31-byte `VAULT_MASTER_KEY` becomes an unimportable module rather
 * than a named refusal.
 */
export function implicitKeyring(
  options: { readonly mode?: ControlMode; readonly keyProviderIo?: KeyProviderIo } = {},
): VaultKeyring {
  const local = configureKeyProvider('LOCAL', options.keyProviderIo);
  return {
    source: 'IMPLICIT',
    mode: options.mode ?? VAULT_ROTATION_DEFAULT_MODE,
    keys: [
      { keyId: IMPLICIT_KEY_ID, version: IMPLICIT_KEY_VERSION, state: 'ACTIVE', provider: 'LOCAL', providerRef: null },
    ],
    providers: new Map([['LOCAL', local]] as const),
  };
}

/**
 * Everything a keyring load reads from outside this process. One narrow
 * interface, so every test runs against a fake and none needs a database.
 */
export interface VaultKeyringIo {
  /**
   * The registered keys. MUST return every field of {@link VaultKeyRow} — see
   * that type's note on select-blind projections.
   */
  listVaultKeys(): Promise<readonly VaultKeyRow[]>;
  /** Overridden in tests so no test needs a 32-byte key in its environment. */
  readonly keyProviderIo?: KeyProviderIo;
}

/**
 * BUILD THE KEYRING FROM THE REGISTERED KEYS, refusing at CONFIGURATION TIME.
 *
 * ── What is refused here, and what is deliberately left to the operation ────
 *
 * REFUSED HERE: a duplicate version, because two rows claiming one version
 * makes "which key sealed this" unanswerable for every value in the install,
 * and `selectOpeningKey` would silently take whichever came first.
 *
 * NOT REFUSED HERE: zero ACTIVE keys, and more than one. Both make SEALING
 * ambiguous or impossible and neither affects OPENING, so the keyring loads and
 * `seal` refuses by name. Refusing the load would take every read down for a
 * problem that only concerns writes, in the middle of the rotation that caused
 * it — which is the opposite of what a brake is for.
 *
 * NOT REFUSED HERE EITHER: a key whose provider is unimplemented. The refusal
 * is carried in `providers` and surfaces as `PROVIDER_NOT_IMPLEMENTED` against
 * THAT key, so the operator learns which version they cannot open. That is the
 * configuration-time refusal item 3 asks for: it happens when the keyring is
 * built, not when a value is decrypted, and `rotate-vault-key.ts` prints it in
 * its plan before it does anything.
 *
 * ── Zero rows is not an error ───────────────────────────────────────────────
 *
 * It is every install today. It returns {@link implicitKeyring} with
 * `source: 'IMPLICIT'`, and that field is how a caller tells "this deployment
 * is on its master key with nothing registered" from "this deployment has
 * registered exactly one key that happens to be version 1".
 */
export async function loadVaultKeyring(
  io: VaultKeyringIo,
  options: { readonly storedModes?: unknown } = {},
): Promise<VaultResult<VaultKeyring>> {
  const mode = controlMode('VAULT_KEY_ROTATION', options.storedModes);
  const rows = await io.listVaultKeys();

  if (rows.length === 0) {
    const keyring = implicitKeyring({ mode, keyProviderIo: io.keyProviderIo });
    return { ok: true, value: keyring };
  }

  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.version)) {
      return fail(
        'DUPLICATE_KEY_VERSION',
        `Two vault keys claim version ${row.version}. Every value sealed under that version would ` +
          'be openable by one of them and there is no way to say which, so the keyring was NOT ' +
          'loaded. The database forbids this; a keyring assembled by hand does not.',
      );
    }
    seen.add(row.version);
  }

  /*
   * One configuration per PROVIDER and not per key: the LOCAL provider's
   * material is the same for every LOCAL key (see ./kms.ts, which states that
   * plainly and states what it therefore does not achieve), and configuring it
   * once means a wrong-length master key is reported once rather than per row.
   */
  const providers = new Map<VaultKeyProvider, KmsResult<ConfiguredKeyProvider>>();
  for (const row of rows) {
    if (!providers.has(row.provider)) {
      providers.set(row.provider, configureKeyProvider(row.provider, io.keyProviderIo));
    }
  }

  return { ok: true, value: { source: 'REGISTERED', mode, keys: rows, providers } };
}

/*
 * THE INSTALLED KEYRING.
 *
 * `null` until something installs one, and `currentKeyring()` builds the
 * implicit keyring on first use rather than at import. Lazy on purpose: this
 * module is imported by five routes and three processors, and a module that
 * reads and validates the master key at import time cannot be imported by a
 * process that does not have one — which is every test that mocks the vault.
 */
let installed: VaultKeyring | null = null;

/**
 * INSTALL THE KEYRING THE SYNCHRONOUS DOORS WILL USE.
 *
 * `seal` and `open` are synchronous and are called from five routes and three
 * worker processors that this round does not own, so the keyring cannot be
 * fetched inside them. It is installed once, by a caller that has a database —
 * `apps/api/src/scripts/rotate-vault-key.ts` does it, and the API and worker
 * boot paths are the two edits in needsFromOtherFiles.
 *
 * Until something installs one, the implicit keyring is in force and the
 * product behaves exactly as it did before. That is the fail-SAFE direction
 * here rather than the fail-closed one, and the distinction is worth stating: a
 * cold keyring that refused every open would take down every install that has
 * registered nothing, which is all of them. The fail-closed rules apply to what
 * the keyring DECIDES, not to whether one exists.
 */
export function installVaultKeyring(keyring: VaultKeyring): void {
  installed = keyring;
}

/** The keyring in force. Builds the implicit one on first use. */
export function currentKeyring(): VaultKeyring {
  installed ??= implicitKeyring();
  return installed;
}

/**
 * Drop the installed keyring, so the next read builds the implicit one.
 *
 * For tests and for the rotation script, which installs a keyring, prints a
 * plan, and must not leave a stale one behind if it is imported twice in one
 * process.
 */
export function resetVaultKeyring(): void {
  installed = null;
}

// ─── The decision, and the count ────────────────────────────────────────────

export const VAULT_OPERATIONS = ['OPEN', 'SEAL'] as const;
export type VaultOperation = (typeof VAULT_OPERATIONS)[number];

/**
 * WOULD_REFUSE is the member a two-member version would have got wrong: it is
 * an OBSERVE-mode refusal, meaning the value WAS opened and enforcement would
 * have stopped it. Recording that as ALLOWED would be a refusal applied-or-not
 * without being counted.
 */
export const VAULT_OUTCOMES = ['ALLOWED', 'REFUSED', 'WOULD_REFUSE'] as const;
export type VaultOutcome = (typeof VAULT_OUTCOMES)[number];

/** One decision about one value. `detail` is operator-facing; nothing here is secret. */
export interface VaultDecision {
  readonly operation: VaultOperation;
  readonly outcome: VaultOutcome;
  readonly mode: ControlMode;
  readonly refusal: VaultRefusal | null;
  /** The version the decision was about, or null when there was none to name. */
  readonly keyVersion: number | null;
  /** Never material, plaintext, a nonce or a ciphertext. */
  readonly detail: string;
}

/**
 * ONE BUCKET OF COUNTED DECISIONS. Rule 13's other half: a mode that does not
 * count is an off switch with a reassuring name.
 *
 * Keyed on (operation, outcome, refusal, keyVersion) and nothing finer. No org,
 * no secret name and no row id: a bucket per secret would be an inventory of
 * which secrets exist and which of them fail to open, which is the list an
 * attacker would most like to read. The key VERSION is in the key because
 * "1,204 opens against a version we cannot name" is the operator's whole
 * question, and a version is an integer out of a handful.
 */
export interface VaultTally {
  readonly operation: VaultOperation;
  readonly outcome: VaultOutcome;
  readonly refusal: VaultRefusal | null;
  readonly keyVersion: number | null;
  readonly count: number;
}

/** The identity of a tally bucket. One definition, so two writers cannot disagree. */
export function vaultTallyKey(decision: VaultDecision): string {
  return [
    decision.operation,
    decision.outcome,
    decision.refusal ?? 'none',
    decision.keyVersion === null ? 'none' : String(decision.keyVersion),
  ].join('\u001f');
}

/**
 * Add one decision to a tally map.
 *
 * EVERY decision, not only the refusals. "We refused 1,204 opens" is only
 * interesting beside how many there were, and a count of refusals with no
 * denominator is the kind of number that gets quoted at a customer and cannot
 * be defended.
 */
export function countVaultDecision(
  into: Map<string, VaultTally>,
  decision: VaultDecision,
): Map<string, VaultTally> {
  const key = vaultTallyKey(decision);
  const existing = into.get(key);
  into.set(key, {
    operation: decision.operation,
    outcome: decision.outcome,
    refusal: decision.refusal,
    keyVersion: decision.keyVersion,
    count: (existing?.count ?? 0) + 1,
  });
  return into;
}

/** How many opens enforcement would have stopped, out of how many there were. */
export function wouldHaveRefusedVault(tallies: Iterable<VaultTally>): {
  readonly wouldRefuse: number;
  readonly refused: number;
  readonly allowed: number;
  readonly total: number;
} {
  let wouldRefuse = 0;
  let refused = 0;
  let allowed = 0;
  for (const tally of tallies) {
    if (tally.outcome === 'WOULD_REFUSE') wouldRefuse += tally.count;
    else if (tally.outcome === 'REFUSED') refused += tally.count;
    else allowed += tally.count;
  }
  return { wouldRefuse, refused, allowed, total: wouldRefuse + refused + allowed };
}

/*
 * The process-wide tally. In memory and not a table, deliberately: the
 * persisted counter for this round's controls is `EgressDecisionTally`, which
 * belongs to the egress control, and minting a second table for the vault would
 * be a column with a writer and no reader. The rotation script reads this one
 * in-process after it has walked a field, which is where the number is wanted.
 */
const tallies = new Map<string, VaultTally>();

/** Every bucket counted since the last reset. */
export function vaultTallies(): readonly VaultTally[] {
  return [...tallies.values()];
}

/** Clear the tally. For tests, and for a script that reports one sweep at a time. */
export function resetVaultTallies(): void {
  tallies.clear();
}

function record(decision: VaultDecision): VaultDecision {
  countVaultDecision(tallies, decision);
  return decision;
}

// ─── Choosing the key, with the brake applied ───────────────────────────────

/**
 * A `SealedEnvelope` carrying nothing but the version, for the key rules.
 *
 * `selectOpeningKey` and `resealVerdict` in sealed.ts take an envelope because
 * that is what a sealed field stores. `Secret.valueEnc` does NOT store one —
 * its version lives in its own integer column and its payload is raw base64 —
 * so this adapts the one to the other rather than duplicating the key rules for
 * the legacy format.
 *
 * The payload is a single character and the key id is empty because NEITHER IS
 * READ: both of those functions select on `keyVersion` alone. Written as one
 * named function rather than inline at three call sites so that a future
 * `selectOpeningKey` which does read the key id fails here, visibly, instead of
 * in whichever caller was updated last.
 */
function versionOnlyEnvelope(keyVersion: number): {
  keyId: string;
  keyVersion: number;
  alg: typeof SEAL_WRITE_ALGORITHM;
  payload: string;
} {
  return { keyId: '', keyVersion, alg: SEAL_WRITE_ALGORITHM, payload: 'x' };
}

/** A key chosen for an operation, and the decision that chose it. */
export interface ChosenKey {
  readonly key: VaultKeyRow;
  readonly decision: VaultDecision;
}

/**
 * Which key may open a value sealed under `keyVersion`, with the mode applied.
 *
 * The RULE comes from `selectOpeningKey` in sealed.ts and is not restated. What
 * happens here is the brake, and only `KEY_NOT_READABLE` has one — see this
 * file's header for why the other two refusals do not.
 */
export function decideOpen(keyring: VaultKeyring, keyVersion: number): VaultResult<ChosenKey> {
  const chosen = selectOpeningKey(versionOnlyEnvelope(keyVersion), keyring.keys);

  if (chosen.ok) {
    const key = keyring.keys.find((candidate) => candidate.version === keyVersion);
    /*
     * `selectOpeningKey` returned a `VaultKeyRef`, which is the structural
     * subset; the row with the provider on it is what the cipher needs. The
     * lookup cannot miss — `selectOpeningKey` found it in the same array — and
     * the guard is here because an unchecked index would be the one place a
     * refactor could turn a found key into `undefined` and a crash.
     */
    if (!key) {
      return fail(
        'UNKNOWN_KEY_VERSION',
        `No vault key row for version ${keyVersion}, although the key rules selected one. ` +
          'Nothing was attempted.',
      );
    }
    return {
      ok: true,
      value: {
        key,
        decision: record({
          operation: 'OPEN',
          outcome: 'ALLOWED',
          mode: keyring.mode,
          refusal: null,
          keyVersion,
          detail: `Opened with key version ${keyVersion} (${key.state}).`,
        }),
      },
    };
  }

  const brakeable = chosen.refusal === 'KEY_NOT_READABLE';
  if (brakeable && keyring.mode === 'OBSERVE') {
    const key = keyring.keys.find((candidate) => candidate.version === keyVersion);
    if (key) {
      record({
        operation: 'OPEN',
        outcome: 'WOULD_REFUSE',
        mode: keyring.mode,
        refusal: chosen.refusal,
        keyVersion,
        detail:
          `ENFORCE would have refused this open: ${chosen.detail} It was allowed because ` +
          'VAULT_KEY_ROTATION is in OBSERVE mode, and this count is the worklist.',
      });
      return {
        ok: true,
        value: {
          key,
          decision: {
            operation: 'OPEN',
            outcome: 'WOULD_REFUSE',
            mode: keyring.mode,
            refusal: chosen.refusal,
            keyVersion,
            detail: chosen.detail,
          },
        },
      };
    }
  }

  record({
    operation: 'OPEN',
    outcome: 'REFUSED',
    mode: keyring.mode,
    refusal: chosen.refusal,
    keyVersion,
    detail: chosen.detail,
  });
  return fail(chosen.refusal, chosen.detail);
}

/**
 * The key a NEW value is sealed under: the single ACTIVE one.
 *
 * NO BRAKE AND NO FALLBACK, in either mode. Sealing under a READABLE key "just
 * this once" is how a rotation ends with values under a key that is about to be
 * retired, and sealing under an ambiguous ACTIVE pair is a value nobody can say
 * which key wrote. Both are refused and both are counted.
 */
export function decideSeal(keyring: VaultKeyring): VaultResult<ChosenKey> {
  const chosen = selectSealingKey(keyring.keys);
  if (!chosen.ok) {
    record({
      operation: 'SEAL',
      outcome: 'REFUSED',
      mode: keyring.mode,
      refusal: chosen.refusal,
      keyVersion: null,
      detail: chosen.detail,
    });
    return fail(chosen.refusal, chosen.detail);
  }
  const key = keyring.keys.find((candidate) => candidate.version === chosen.value.version);
  if (!key) {
    return fail(
      'NO_WRITABLE_KEY',
      `No vault key row for version ${chosen.value.version}, although the key rules selected it.`,
    );
  }
  return {
    ok: true,
    value: {
      key,
      decision: record({
        operation: 'SEAL',
        outcome: 'ALLOWED',
        mode: keyring.mode,
        refusal: null,
        keyVersion: key.version,
        detail: `Sealed with key version ${key.version}.`,
      }),
    },
  };
}

/** The material for one chosen key, or the provider's named refusal. */
export function materialFor(keyring: VaultKeyring, key: VaultKeyRow): VaultResult<KeyMaterial> {
  const configured = keyring.providers.get(key.provider);
  if (configured === undefined) {
    /*
     * A key whose provider was never configured. Reachable only from a keyring
     * assembled by hand, and refused rather than configured on the spot: a
     * keyring that grows providers at decrypt time is a keyring whose
     * configuration-time refusal never happens.
     */
    return fail(
      'MATERIAL_UNAVAILABLE',
      `The keyring has no configured ${key.provider} provider, so key version ${key.version} ` +
        'cannot be opened. Nothing was attempted.',
    );
  }
  if (!configured.ok) return fail(configured.refusal, configured.detail);

  const unwrapped = configured.value.unwrapDataKey({
    keyId: key.keyId,
    providerRef: key.providerRef,
  });
  if (!unwrapped.ok) return fail(unwrapped.refusal, unwrapped.detail);
  return { ok: true, value: unwrapped.value };
}

// ─── The cipher ─────────────────────────────────────────────────────────────

/**
 * The AAD for a `Secret.valueEnc` row, EXACTLY as it has always been composed.
 *
 * `${orgId}:${name}` and not `aadFor()`. This is load-bearing for every secret
 * already in every customer's database, so it cannot be changed without
 * re-sealing all of them — which is what `sealed.ts` says above `aadFor`, and
 * this is the other end of that note. `aadFor` is used for fields sealed from
 * now on; `Secret.valueEnc` moves to it only as part of a rotation sweep that
 * re-seals under the new binding, and until then this function is its binding.
 */
function legacySecretAad(orgId: string, name: string): Buffer {
  return Buffer.from(`${orgId}:${name}`, 'utf8');
}

/** `iv | tag | ciphertext`, base64. Self-contained, so no side table is needed. */
function encrypt(material: KeyMaterial, plaintext: string, aad: Buffer): string {
  return useKeyMaterial(material, (bytes) => {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, bytes, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  });
}

/**
 * Decrypt, returning ONE refusal for every way the cipher can say no.
 *
 * `CIPHER_REJECTED` for a wrong key, altered bytes and a mismatched binding
 * alike. Distinguishing them tells an attacker which of their guesses was
 * closer, and the previous version of this file already carried that reasoning;
 * it is kept because it is right and not because it was there.
 *
 * The `catch` is empty on purpose and the arm RETURNS A REFUSAL rather than
 * falling through: an exception handler that ends in "allow" is the defect
 * pattern this round exists to hunt, and a decrypt handler that returned an
 * empty string would be exactly that.
 */
function decrypt(material: KeyMaterial, payload: string, aad: Buffer): VaultResult<string> {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
    return fail(
      'MALFORMED_ENVELOPE',
      `A sealed payload is at least ${IV_LENGTH + TAG_LENGTH + 1} bytes and this one is shorter.`,
    );
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = raw.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    return useKeyMaterial(material, (bytes) => {
      const decipher = createDecipheriv(ALGORITHM, bytes, iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      return { ok: true as const, value: plaintext };
    });
  } catch {
    return fail(
      'CIPHER_REJECTED',
      'The cipher rejected the stored value. Wrong key, altered bytes or a different binding — ' +
        'this build does not say which, because saying which tells an attacker whether the key ' +
        'was right.',
    );
  }
}

// ─── Secret.valueEnc: the existing doors, unchanged in shape ────────────────

export interface SealedSecret {
  ciphertext: string;
  keyVersion: number;
  /** Last 4 plaintext characters, so the UI can confirm a value without decrypting. */
  hint: string;
}

/**
 * Seal an environment secret.
 *
 * SAME SIGNATURE AND SAME STORED FORMAT as before, because five routes and
 * three processors call this and none of them is in this round's file list. The
 * one behavioural change: `keyVersion` is the version of the keyring's ACTIVE
 * key rather than a module constant, so a rotated deployment writes new values
 * under the new key without any of those call sites changing. With the implicit
 * keyring that is version 1, which is what they all wrote before.
 *
 * Throws {@link VaultRefusalError} when there is no single ACTIVE key. It used
 * to be unable to fail; a deployment that has registered keys and left none
 * ACTIVE must not have new secrets written under a key that is being retired.
 */
export function seal(plaintext: string, orgId: string, name: string): SealedSecret {
  const keyring = currentKeyring();
  const chosen = decideSeal(keyring);
  if (!chosen.ok) throw new VaultRefusalError(chosen, null);

  const material = materialFor(keyring, chosen.value.key);
  if (!material.ok) throw new VaultRefusalError(material, chosen.value.key.version);

  return {
    ciphertext: encrypt(material.value, plaintext, legacySecretAad(orgId, name)),
    keyVersion: chosen.value.key.version,
    hint: plaintext.length <= 4 ? '' : plaintext.slice(-4),
  };
}

/**
 * Open an environment secret, deciding the key BEFORE constructing a cipher.
 *
 * SAME SIGNATURE and same stored format. The change is that an unknown version
 * is `UNKNOWN_KEY_VERSION` — a named refusal reached without touching the
 * cipher — where it used to be a throw from inside the decrypt path, and that a
 * RETIRED or COMPROMISED key now stops opening values. Those are the refusals
 * the brake and the two no-brake exceptions in this file's header are about.
 *
 * Throws {@link VaultRefusalError}, whose `message` is one constant sentence.
 * Callers that already catch keep working; `err.refusal` is what they should
 * log, and `err.message` carries nothing worth redacting.
 */
export function open(sealed: string, keyVersion: number, orgId: string, name: string): string {
  const result = openWithKeyring(currentKeyring(), sealed, keyVersion, orgId, name);
  if (!result.ok) throw new VaultRefusalError(result, keyVersion);
  return result.value;
}

/**
 * The injected form of {@link open}, for the sweeper and for tests.
 *
 * Takes the keyring as an argument so a test can hand it a RETIRED key, a
 * COMPROMISED key or an unimplemented provider without installing anything
 * process-wide — which is what rule 8 asks for and what makes every refusal in
 * this file provable with a fake.
 */
export function openWithKeyring(
  keyring: VaultKeyring,
  sealed: string,
  keyVersion: number,
  orgId: string,
  name: string,
): VaultResult<string> {
  const chosen = decideOpen(keyring, keyVersion);
  if (!chosen.ok) return chosen;
  const material = materialFor(keyring, chosen.value.key);
  if (!material.ok) return material;
  return decrypt(material.value, sealed, legacySecretAad(orgId, name));
}

/**
 * Seal an environment secret under an EXPLICIT keyring. The sweeper's writer.
 *
 * Separate from {@link seal} rather than an optional parameter, because a
 * sweeper must seal under the keyring it planned with and not under whatever is
 * installed when the batch runs — a rotation that re-seals half its rows under
 * a key the operator changed mid-sweep is the half-rotated database this round
 * is designed against.
 */
export function sealWithKeyring(
  keyring: VaultKeyring,
  plaintext: string,
  orgId: string,
  name: string,
): VaultResult<SealedSecret> {
  const chosen = decideSeal(keyring);
  if (!chosen.ok) return chosen;
  const material = materialFor(keyring, chosen.value.key);
  if (!material.ok) return material;
  return {
    ok: true,
    value: {
      ciphertext: encrypt(material.value, plaintext, legacySecretAad(orgId, name)),
      keyVersion: chosen.value.key.version,
      hint: plaintext.length <= 4 ? '' : plaintext.slice(-4),
    },
  };
}

/**
 * RE-SEAL ONE `Secret.valueEnc` UNDER THE ACTIVE KEY, VERIFYING BEFORE RETURNING.
 *
 * ── The verification is the point, not a flourish ──────────────────────────
 *
 * The sweeper's caller is about to overwrite a ciphertext that is currently
 * readable. If the new one does not open, the row becomes readable by NO key
 * and the value is gone — and SQL cannot get it back. So this function opens
 * the value it just sealed, with the key it just sealed it under, and refuses
 * if that fails. The old ciphertext is only discarded by a caller that got an
 * `ok` from here.
 *
 * It returns the SEALED result and never the plaintext: the plaintext exists
 * inside this function and in nothing it hands back, which is why the sweeper
 * can log its progress without a masking rule.
 */
export function resealSecret(
  keyring: VaultKeyring,
  sealed: string,
  fromKeyVersion: number,
  orgId: string,
  name: string,
): VaultResult<SealedSecret> {
  const opened = openWithKeyring(keyring, sealed, fromKeyVersion, orgId, name);
  if (!opened.ok) return opened;

  const resealed = sealWithKeyring(keyring, opened.value, orgId, name);
  if (!resealed.ok) return resealed;

  const verified = openWithKeyring(
    keyring,
    resealed.value.ciphertext,
    resealed.value.keyVersion,
    orgId,
    name,
  );
  if (!verified.ok) {
    return fail(
      verified.refusal,
      `The re-sealed value for key version ${resealed.value.keyVersion} did not open again, so ` +
        'the old ciphertext was NOT replaced. The row is unchanged and still readable.',
    );
  }
  if (verified.value !== opened.value) {
    /*
     * Cannot happen with AES-GCM, which authenticates. Checked anyway because
     * the cost of being wrong is a silently corrupted secret, and because the
     * alternative is a sweeper whose only evidence is that no exception was
     * thrown.
     */
    return fail(
      'CIPHER_REJECTED',
      `The re-sealed value for key version ${resealed.value.keyVersion} opened to different ` +
        'bytes, so the old ciphertext was NOT replaced.',
    );
  }
  return { ok: true, value: resealed.value };
}

// ─── The envelope fields: storageState and anything sealed from now on ──────

/**
 * One sealed value as it is stored in a single TEXT column, plus the integer
 * version column beside it.
 *
 * Two fields because the schema has two columns, and `envelopeMatchesVersionColumn`
 * in sealed.ts is what stops them disagreeing — a row whose column says 2 while
 * its envelope says 1 is a row a sweep skips and a compromised key keeps
 * opening.
 */
export interface SealedEnvelopeWrite {
  readonly stored: string;
  readonly keyVersion: number;
}

/**
 * SEAL A VALUE FOR A SEALED FIELD, in the `qs1` envelope.
 *
 * This is the door `AuthProfile.storageState` goes through, and the binding is
 * `aadFor` — model, row AND field — so a session lifted from one AuthProfile
 * and pasted onto another fails to open rather than opening as somebody else's
 * session. `Secret.valueEnc` deliberately does NOT use this path; see
 * {@link legacySecretAad}.
 */
export function sealEnvelope(
  keyring: VaultKeyring,
  plaintext: string,
  aad: SealAad,
): VaultResult<SealedEnvelopeWrite> {
  if (!isSealedFieldKey(aad.fieldKey)) {
    return fail('NOT_A_SEALED_FIELD', 'That model and field pair is not a sealed field.');
  }
  const chosen = decideSeal(keyring);
  if (!chosen.ok) return chosen;
  const material = materialFor(keyring, chosen.value.key);
  if (!material.ok) return material;

  const payload = encrypt(material.value, plaintext, Buffer.from(aadFor(aad), 'utf8'));
  return {
    ok: true,
    value: {
      stored: serialiseEnvelope({
        keyId: chosen.value.key.keyId,
        keyVersion: chosen.value.key.version,
        alg: SEAL_WRITE_ALGORITHM,
        payload,
      }),
      keyVersion: chosen.value.key.version,
    },
  };
}

/**
 * OPEN A SEALED FIELD, returning an {@link OpenedSecret} and not a string.
 *
 * The plaintext comes back inside a type whose value is not one of its own
 * properties, so a caller that logs the result logs the mask. That is the
 * difference between this door and {@link open}: `open` keeps a bare string
 * because eight call sites outside this round expect one, and a NEW door has no
 * such debt and should not acquire one.
 *
 * `keyVersionColumn` is checked against the envelope rather than trusted,
 * because the integer column exists so that "which rows are still under key 1"
 * is an indexed query — and a denormalisation that can drift is one that will.
 */
export function openEnvelope(
  keyring: VaultKeyring,
  stored: unknown,
  aad: SealAad,
  keyVersionColumn: number | null,
): VaultResult<OpenedSecret> {
  if (!isSealedFieldKey(aad.fieldKey)) {
    return fail('NOT_A_SEALED_FIELD', 'That model and field pair is not a sealed field.');
  }
  const envelope = parseEnvelope(stored);
  if (!envelope.ok) return fail(envelope.refusal, envelope.detail);

  if (keyVersionColumn !== null && keyVersionColumn !== envelope.value.keyVersion) {
    /*
     * A refusal and not a preference for one of the two numbers. The dangerous
     * direction is a column that says 2 while the envelope says 1: the sweep
     * skips the row and the old key keeps opening it, so a key could be retired
     * while that row still needs it.
     */
    return fail(
      'MALFORMED_ENVELOPE',
      `The ${aad.fieldKey} row's key version column says ${keyVersionColumn} and its envelope ` +
        `says ${envelope.value.keyVersion}. Nothing was attempted.`,
    );
  }

  const chosen = decideOpen(keyring, envelope.value.keyVersion);
  if (!chosen.ok) return chosen;
  const material = materialFor(keyring, chosen.value.key);
  if (!material.ok) return material;

  const plaintext = decrypt(
    material.value,
    envelope.value.payload,
    Buffer.from(aadFor(aad), 'utf8'),
  );
  if (!plaintext.ok) return plaintext;
  return { ok: true, value: new OpenedSecret(plaintext.value, aad) };
}

/**
 * RE-SEAL ONE SEALED FIELD UNDER THE ACTIVE KEY, VERIFYING BEFORE RETURNING.
 *
 * The envelope counterpart of {@link resealSecret}, and the verification is
 * there for the same reason: the caller is about to overwrite a value that is
 * currently readable, and a row readable by no key is a value SQL cannot get
 * back.
 *
 * The plaintext never leaves this function. `useSecret` is what reads it, so it
 * does not become a variable in the caller's scope and cannot be attached to
 * the error of a failed batch.
 */
export function resealEnvelope(
  keyring: VaultKeyring,
  stored: unknown,
  aad: SealAad,
  keyVersionColumn: number | null,
): VaultResult<SealedEnvelopeWrite> {
  const opened = openEnvelope(keyring, stored, aad, keyVersionColumn);
  if (!opened.ok) return opened;

  const written = useSecret(opened.value, (plaintext) => {
    const resealed = sealEnvelope(keyring, plaintext, aad);
    if (!resealed.ok) return resealed;
    const verified = openEnvelope(keyring, resealed.value.stored, aad, resealed.value.keyVersion);
    if (!verified.ok) {
      return fail(
        verified.refusal,
        `The re-sealed ${aad.fieldKey} value did not open again, so the old ciphertext was NOT ` +
          'replaced. The row is unchanged.',
      );
    }
    const same = useSecret(verified.value, (check) => check === plaintext);
    if (!same) {
      return fail(
        'CIPHER_REJECTED',
        `The re-sealed ${aad.fieldKey} value opened to different bytes, so the old ciphertext ` +
          'was NOT replaced.',
      );
    }
    return resealed;
  });
  return written;
}

// ─── Does this row need re-sealing? ─────────────────────────────────────────

/**
 * TWO FACTS ABOUT ONE ROW: whether it needs re-sealing, and whether that is an
 * incident.
 *
 * `urgent` is not a second opinion on `needed`. A value under a COMPROMISED key
 * needs re-entry on a different clock from one under a merely superseded key,
 * and one boolean for both would make a sweep unable to put the incident first —
 * the lesson `verified` taught when it was true for a heal that left the test
 * red.
 *
 * `reEntryRequired` is the third fact and the one item 4 of this round turns
 * on: for a COMPROMISED key the answer is NOT "re-seal it", because the
 * ciphertext that key protected must be considered disclosed. The sweeper reads
 * this field to decide whether it is re-sealing rows or enumerating them.
 */
export interface ResealVerdict {
  readonly needed: boolean;
  readonly urgent: boolean;
  readonly reEntryRequired: boolean;
  readonly why: string;
}

/** The verdict for one stored version against an explicit keyring. */
export function resealVerdictFor(keyring: VaultKeyring, keyVersion: number): ResealVerdict {
  const verdict = resealVerdict(
    { keyId: '', keyVersion, alg: SEAL_WRITE_ALGORITHM, payload: 'x' },
    keyring.keys,
  );
  const key = keyring.keys.find((candidate) => candidate.version === keyVersion);
  const state: VaultKeyState | 'ABSENT' = key?.state ?? 'ABSENT';
  const reEntryRequired = state === 'COMPROMISED' || state === 'ABSENT';
  return { ...verdict, reEntryRequired };
}

/**
 * True when a row should be re-sealed under the ACTIVE key.
 *
 * ── What this used to be, and why the change matters ───────────────────────
 *
 * It was `keyVersion < CURRENT_KEY_VERSION` against a module constant, and it
 * HAD NO CALLER. Two things were wrong with it beyond that. It took no account
 * of key STATE, so a row under a COMPROMISED key was reported as needing
 * nothing as long as the version numbers lined up. And it answered FALSE for a
 * version GREATER than the constant — a row written by a newer build, which
 * this deployment cannot open at all — which is the most dangerous possible
 * answer to give about a row that needs attention.
 *
 * Its caller is `apps/api/src/scripts/rotate-vault-key.ts`, which uses it to
 * decide whether a field has anything to sweep before it starts one.
 */
export function needsRotation(keyVersion: number): boolean {
  return resealVerdictFor(currentKeyring(), keyVersion).needed;
}

// ─── Boot ────────────────────────────────────────────────────────────────────

/**
 * INSTALL THE DEPLOYMENT'S KEYRING AT BOOT. Called by the API and the worker.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
 *
 * {@link installVaultKeyring} and {@link loadVaultKeyring} shipped with exactly
 * ONE production caller between them — `apps/api/src/scripts/rotate-vault-key.ts`,
 * the rotation CLI itself. So in the API and the worker the IMPLICIT keyring was
 * always in force and the whole `VaultKey` state machine was inert. MEASURED in
 * one process, with v1 READABLE and v2 ACTIVE in the table:
 *
 *   · `seal()` wrote `keyVersion: 1` although the registered ACTIVE key was v2;
 *   · `open()` of a value the sweep had moved to v2 threw UNKNOWN_KEY_VERSION,
 *     i.e. every swept secret was unreadable to the running API;
 *   · after `compromise --version 1`, the API still sealed NEW secrets under v1
 *     and still opened them.
 *
 * `docs/key-rotation.md` and the remediation sequence in `lib/kms.ts` both
 * assume these rows are in force. They were not, which made the documented
 * remediation a no-op — the exact shape of "correct code connected to nothing",
 * on the control whose entire purpose is recovering from a compromise.
 *
 * ── WHAT IT DOES WHEN IT CANNOT ──────────────────────────────────────────────
 *
 * ZERO ROWS IS NOT AN ERROR — it is every install today, and it yields the
 * implicit keyring, silently, so behaviour is byte-identical to before this
 * existed. That is the fail-SAFE direction and `installVaultKeyring`'s own doc
 * explains why a cold keyring that refused every open would take down every
 * deployment that has registered nothing, which is all of them.
 *
 * ROWS THAT ARE MALFORMED LOG AN ERROR AND LEAVE THE IMPLICIT KEYRING IN FORCE.
 * It does NOT throw, and that is a decision worth stating because the first
 * version of this function did.
 *
 * The dangerous case is a load that SUCCEEDS and is not installed — that is the
 * original defect, and it is what produces new secrets sealed under a version
 * the operator believes is retired. A load that FAILS registered nothing, so
 * there is no second keyring to disagree with: the implicit one is v1 and the
 * product behaves as it did before any rows existed. Refusing to start would
 * trade a recoverable, logged misconfiguration for an outage, which is the
 * trade `installVaultKeyring`'s own doc argues against.
 *
 * It also cannot be made to throw usefully from here: both boot paths run this
 * at module load, so a throw becomes an unhandled rejection in every process
 * that merely IMPORTS them — including the test runner, where the first
 * version's `process.exit(1)` killed the suite from inside
 * `apps/worker/src/index.ts`.
 *
 * It cannot fire on any install that exists in any case: nothing in the product
 * writes a `VaultKey` row yet (`registerVaultKeySchema` has no production
 * caller), so reaching this branch means an operator wrote rows by hand and one
 * of them is wrong — which is exactly when a loud log beats a silent fallback.
 */
export async function installKeyringAtBoot(
  io: VaultKeyringIo,
  log: (level: 'info' | 'error', fields: Record<string, unknown>, message: string) => void,
  options: { readonly storedModes?: unknown } = {},
): Promise<VaultKeyring> {
  const result = await loadVaultKeyring(io, options);
  if (!result.ok) {
    /*
     * The refusal and its detail, never a key: `VaultResult`'s detail names the
     * version and the reason and is built from the row's own columns, which hold
     * a provider reference and never key material.
     */
    log(
      'error',
      { refusal: result.refusal, detail: result.detail },
      'the registered vault keyring cannot be read — running on the implicit keyring, so a rotation will NOT take effect until the VaultKey rows are fixed or removed',
    );
    return currentKeyring();
  }

  installVaultKeyring(result.value);
  /*
   * Logged at INFO and only when something IS registered. An install with no
   * rows is the normal case and a line on every boot saying so is a line nobody
   * reads. The versions and their states are operator-facing facts, not secrets.
   */
  if (result.value.source === 'REGISTERED') {
    log(
      'info',
      {
        source: result.value.source,
        keys: result.value.keys.map((key) => `v${key.version}:${key.state}`),
      },
      'vault keyring installed',
    );
  }
  return result.value;
}
